import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { captureReferenceUrl } from "../capture/browser.js";
import { IdiomError } from "../errors.js";
import type { Project } from "../schemas/project.js";
import {
  type ReferenceMetadata,
  referenceNameSchema,
} from "../schemas/reference.js";
import {
  listManagedReferences,
  loadManagedReference,
  type ManagedReference,
  mediaTypeForPath,
  type ReferencePolarity,
  referenceRoot,
} from "./catalog.js";
import { referenceImageLimitIssue } from "./limits.js";

export type ReferenceCapture = (options: {
  url: string;
  project: Project;
  viewport: Project["viewports"][number];
}) => Promise<Buffer>;

export type ReferenceDependencies = {
  now?: (() => Date) | undefined;
  captureUrl?: ReferenceCapture | undefined;
};

export type RemovedReference = {
  label: string;
  name: string;
  polarity: ReferencePolarity;
  valid: boolean;
};

export type AddReferenceOptions = {
  projectDirectory: string;
  project: Project;
  cwd: string;
  name: string;
  note: string;
  polarity: ReferencePolarity;
  url?: string | undefined;
  file?: string | undefined;
  viewport?: string | undefined;
  dependencies?: ReferenceDependencies | undefined;
};

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validateName(name: string): string {
  const parsed = referenceNameSchema.safeParse(name);
  if (!parsed.success)
    throw new IdiomError(
      `invalid reference name ${JSON.stringify(name)}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  return parsed.data;
}

function extensionForLocal(path: string): string {
  const extension = extname(path).toLowerCase();
  return extension === ".jpeg" ? ".jpg" : extension;
}

export async function addReference(
  options: AddReferenceOptions,
): Promise<ManagedReference> {
  const name = validateName(options.name);
  const note = options.note.trim();
  if (note === "") throw new IdiomError("reference note must not be blank");
  if ((options.url === undefined) === (options.file === undefined))
    throw new IdiomError("exactly one of --url or --file is required");
  if (options.file !== undefined && options.viewport !== undefined)
    throw new IdiomError("--viewport can only be used with --url");
  if (options.url !== undefined && options.viewport === undefined)
    throw new IdiomError("--viewport is required with --url");

  const root = referenceRoot(options.projectDirectory, options.polarity);
  await mkdir(root, { recursive: true });
  const destination = join(root, name);
  if (await exists(destination))
    throw new IdiomError(
      `reference ${JSON.stringify(name)} already exists as ${options.polarity}`,
    );

  let metadata: ReferenceMetadata;
  let localSource: string | undefined;
  let imageData: Buffer | undefined;
  if (options.file !== undefined) {
    localSource = resolve(options.cwd, options.file);
    const mediaType = mediaTypeForPath(localSource);
    if (mediaType === undefined)
      throw new IdiomError(
        "local reference must be a PNG, JPEG, WebP, or GIF image",
      );
    let sourceStat: Stats;
    try {
      sourceStat = await lstat(localSource);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new IdiomError(`local reference file not found: ${localSource}`);
      throw error;
    }
    if (!sourceStat.isFile())
      throw new IdiomError(
        `local reference is not a regular file: ${localSource}`,
      );
    imageData = await readFile(localSource);
    metadata = {
      version: 1,
      name,
      note,
      image: `image${extensionForLocal(localSource)}`,
      mediaType,
      sourceKind: "file",
      source: options.file,
    };
  } else {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(options.url as string);
    } catch {
      throw new IdiomError(
        `invalid reference URL: ${JSON.stringify(options.url)}`,
      );
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
      throw new IdiomError("reference URL must use http or https");
    const viewport = options.project.viewports.find(
      (candidate) => candidate.name === options.viewport,
    );
    if (viewport === undefined)
      throw new IdiomError(
        `unknown project viewport ${JSON.stringify(options.viewport)}`,
      );
    try {
      imageData = await (
        options.dependencies?.captureUrl ?? captureReferenceUrl
      )({
        url: options.url as string,
        project: options.project,
        viewport,
      });
    } catch (error) {
      throw new IdiomError(
        `reference URL capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    metadata = {
      version: 1,
      name,
      note,
      image: "image.png",
      mediaType: "image/png",
      sourceKind: "url",
      source: options.url as string,
      capturedAt: (
        options.dependencies?.now ?? (() => new Date())
      )().toISOString(),
      viewport: {
        name: viewport.name,
        width: viewport.width,
        height: viewport.height,
      },
    };
  }

  const limitIssue = referenceImageLimitIssue(
    imageData as Buffer,
    metadata.mediaType,
  );
  if (limitIssue !== undefined)
    throw new IdiomError(
      `reference image exceeds model transport limits: ${limitIssue}`,
    );

  const temporary = await mkdtemp(join(root, `.${name}-`));
  try {
    const imagePath = join(temporary, metadata.image);
    await writeFile(imagePath, imageData as Buffer, { flag: "wx" });
    await writeFile(
      join(temporary, "reference.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: "wx" },
    );
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new IdiomError(
        `reference ${JSON.stringify(name)} already exists as ${options.polarity}`,
      );
    throw error;
  }
  return await loadManagedReference(destination, options.polarity);
}

export async function removeReference(options: {
  projectDirectory: string;
  name: string;
  polarity: ReferencePolarity;
}): Promise<RemovedReference> {
  const name = validateName(options.name);
  const directory = join(
    referenceRoot(options.projectDirectory, options.polarity),
    name,
  );
  if (!(await exists(directory)))
    throw new IdiomError(
      `managed ${options.polarity} ${JSON.stringify(name)} not found`,
    );
  let reference: ManagedReference | undefined;
  try {
    reference = await loadManagedReference(directory, options.polarity);
  } catch (error) {
    if (!(error instanceof IdiomError)) throw error;
    let marker: Stats | undefined;
    try {
      marker = await lstat(join(directory, "reference.json"));
    } catch (markerError) {
      if ((markerError as NodeJS.ErrnoException).code !== "ENOENT")
        throw markerError;
    }
    if (marker === undefined || !marker.isFile() || marker.isSymbolicLink())
      throw new IdiomError(
        `${basename(directory)} exists but is not a removable managed reference`,
      );
  }
  await rm(directory, { recursive: true });
  return {
    label: reference?.label ?? `${options.polarity}:${name}`,
    name,
    polarity: options.polarity,
    valid: reference !== undefined,
  };
}

export { listManagedReferences };
