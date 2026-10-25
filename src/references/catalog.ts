import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { IdiomError } from "../errors.js";
import {
  type ReferenceImageMediaType,
  type ReferenceMetadata,
  referenceMetadataSchema,
} from "../schemas/reference.js";

export type ReferencePolarity = "reference" | "anti-reference";

export type ManagedReference = {
  label: string;
  polarity: ReferencePolarity;
  directory: string;
  metadataPath: string;
  imagePath: string;
  metadata: ReferenceMetadata;
};

export type LegacyReference =
  | {
      label: string;
      polarity: ReferencePolarity;
      kind: "image";
      readPath: string;
      mediaType: ReferenceImageMediaType;
    }
  | {
      label: string;
      polarity: ReferencePolarity;
      kind: "text";
      content: string;
    };

const imageTypes = new Map<string, ReferenceImageMediaType>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);
const textExtensions = new Set([
  ".md",
  ".txt",
  ".json",
  ".html",
  ".css",
  ".yaml",
  ".yml",
]);

export function referenceRoot(
  projectDirectory: string,
  polarity: ReferencePolarity,
): string {
  return join(
    projectDirectory,
    ".idiom",
    polarity === "reference" ? "references" : "anti-references",
  );
}

export function mediaTypeForPath(
  path: string,
): ReferenceImageMediaType | undefined {
  return imageTypes.get(extname(path).toLowerCase());
}

function entryError(path: string, message: string): IdiomError {
  return new IdiomError(`${path}: ${message}`);
}

export async function loadManagedReference(
  directory: string,
  polarity: ReferencePolarity,
): Promise<ManagedReference> {
  const metadataPath = join(directory, "reference.json");
  let directoryStat: Stats;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw entryError(directory, "managed reference entry not found");
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw entryError(directory, "managed reference entry must be a directory");
  let metadataStat: Stats;
  try {
    metadataStat = await lstat(metadataPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw entryError(directory, "not a managed reference entry");
    throw error;
  }
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink())
    throw entryError(metadataPath, "metadata must be a regular file");
  const source = await readFile(metadataPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw entryError(
      metadataPath,
      `malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = referenceMetadataSchema.safeParse(value);
  if (!parsed.success)
    throw entryError(
      metadataPath,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    );
  const name = directory.split(sep).at(-1);
  if (name !== parsed.data.name)
    throw entryError(metadataPath, "name must match its entry directory");
  const imagePath = resolve(directory, parsed.data.image);
  if (
    relative(directory, imagePath).startsWith("..") ||
    imagePath === directory
  )
    throw entryError(
      metadataPath,
      "image must remain inside its entry directory",
    );
  if (mediaTypeForPath(imagePath) !== parsed.data.mediaType)
    throw entryError(
      metadataPath,
      "image extension and mediaType do not agree",
    );
  let imageStat: Stats;
  try {
    imageStat = await lstat(imagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw entryError(imagePath, "managed image file not found");
    throw error;
  }
  if (!imageStat.isFile() || imageStat.isSymbolicLink())
    throw entryError(imagePath, "managed image must be a regular file");
  return {
    label: `${polarity}:${parsed.data.name}`,
    polarity,
    directory,
    metadataPath,
    imagePath,
    metadata: parsed.data,
  };
}

async function directoryEntries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function listManagedReferences(
  projectDirectory: string,
): Promise<ManagedReference[]> {
  const output: ManagedReference[] = [];
  for (const polarity of ["reference", "anti-reference"] as const) {
    const root = referenceRoot(projectDirectory, polarity);
    const entries = (await directoryEntries(root)).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        continue;
      const directory = join(root, entry.name);
      try {
        await lstat(join(directory, "reference.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        output.push(await loadManagedReference(directory, polarity));
      } catch (error) {
        if (error instanceof IdiomError) continue;
        throw error;
      }
    }
  }
  return output;
}

async function legacyFiles(directory: string, root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await directoryEntries(directory)).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    // Hidden root children are managed-publication staging remnants, never
    // legacy references; listManagedReferences skips them for the same reason.
    if (directory === root && entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directory === root) {
        try {
          await lstat(join(path, "reference.json"));
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      files.push(...(await legacyFiles(path, root)));
    } else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function loadLegacyReferences(
  projectDirectory: string,
): Promise<LegacyReference[]> {
  const output: LegacyReference[] = [];
  for (const polarity of ["reference", "anti-reference"] as const) {
    const root = referenceRoot(projectDirectory, polarity);
    for (const path of await legacyFiles(root, root)) {
      const name = relative(root, path).split(sep).join("/");
      const label = `${polarity}:${name}`;
      const mediaType = mediaTypeForPath(path);
      if (mediaType !== undefined)
        output.push({
          label,
          polarity,
          kind: "image",
          readPath: path,
          mediaType,
        });
      else if (textExtensions.has(extname(path).toLowerCase()))
        output.push({
          label,
          polarity,
          kind: "text",
          content: await readFile(path, "utf8"),
        });
    }
  }
  return output;
}
