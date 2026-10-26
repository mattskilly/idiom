import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IdiomError } from "../../errors.js";
import {
  type FigmaDependencies,
  FigmaHttpError,
  figmaDownload,
  figmaGet,
} from "./client.js";
import {
  type FigmaMeta,
  type FigmaNode,
  type FigmaVariables,
  figmaFileSchema,
  figmaImagesSchema,
  figmaMetaSchema,
  figmaNodeSchema,
  figmaNodesSchema,
  figmaVariablesSchema,
} from "./types.js";
import { type FigmaRef, figmaNodeLink } from "./url.js";

/** Matches the browser capture's device scale factor so crops land on CSS pixels. */
export const FIGMA_RENDER_SCALE = 2;

export type FigmaFrame = {
  meta: FigmaMeta;
  document: FigmaNode;
  png: Buffer;
  variables?: FigmaVariables | undefined;
  /** Absolute path of the version directory in use. */
  cacheDirectory: string;
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "-");

export function figmaCacheRoot(projectDirectory: string, fileKey: string) {
  return join(projectDirectory, ".idiom", "designs", "figma", safe(fileKey));
}
function frameRoot(
  projectDirectory: string,
  ref: FigmaRef & { nodeId: string },
) {
  return join(figmaCacheRoot(projectDirectory, ref.fileKey), safe(ref.nodeId));
}

async function readCached(directory: string): Promise<FigmaFrame | undefined> {
  try {
    const meta = figmaMetaSchema.parse(
      JSON.parse(await readFile(join(directory, "meta.json"), "utf8")),
    );
    const document = figmaNodeSchema.parse(
      JSON.parse(await readFile(join(directory, "nodes.json"), "utf8")),
    );
    const png = await readFile(join(directory, "frame.png"));
    let variables: FigmaVariables | undefined;
    if (meta.variables === "resolved")
      variables = figmaVariablesSchema.parse(
        JSON.parse(await readFile(join(directory, "variables.json"), "utf8")),
      );
    return { meta, document, png, variables, cacheDirectory: directory };
  } catch {
    return undefined;
  }
}

/**
 * The cache is pinned: once a frame is cached it is reused with no network
 * and no token until `refresh` is passed, so verify and CI are deterministic.
 */
export async function fetchFigmaFrame(
  ref: FigmaRef,
  options: {
    projectDirectory: string;
    refresh?: boolean | undefined;
    deps?: FigmaDependencies | undefined;
    now?: (() => Date) | undefined;
  },
): Promise<FigmaFrame> {
  const { nodeId } = ref;
  if (!nodeId)
    throw new IdiomError(
      "Figma design URLs need ?node-id= (right-click the frame → Copy link to selection)",
    );
  const root = frameRoot(options.projectDirectory, { ...ref, nodeId });
  if (!options.refresh) {
    let version = ref.version;
    if (!version)
      try {
        version = (
          JSON.parse(await readFile(join(root, "current.json"), "utf8")) as {
            version?: string;
          }
        ).version;
      } catch {}
    const cached = version
      ? await readCached(join(root, safe(version)))
      : undefined;
    if (cached) return cached;
  }
  const deps = options.deps ?? {},
    key = encodeURIComponent(ref.fileKey);
  const file = figmaFileSchema.parse(
    await figmaGet(`/v1/files/${key}?depth=1`, deps),
  );
  const version = ref.version ?? file.version;
  const v = `&version=${encodeURIComponent(version)}`,
    ids = `ids=${encodeURIComponent(nodeId)}`;
  const nodes = figmaNodesSchema.parse(
    await figmaGet(`/v1/files/${key}/nodes?${ids}${v}`, deps, "Figma frame"),
  );
  const entry = nodes.nodes[nodeId];
  if (!entry)
    throw new IdiomError(
      `Figma node ${nodeId} was not found in file ${ref.fileKey}; copy the frame link again.`,
    );
  const images = figmaImagesSchema.parse(
    await figmaGet(
      `/v1/images/${key}?${ids}&format=png&scale=${FIGMA_RENDER_SCALE}${v}`,
      deps,
      "Figma frame",
    ),
  );
  const imageUrl = images.images[nodeId];
  if (!imageUrl)
    throw new IdiomError(
      `Figma could not render node ${nodeId}${images.err ? ` (${images.err})` : ""}; check the node is a visible frame.`,
    );
  const png = await figmaDownload(imageUrl, deps);
  let variables: FigmaVariables | undefined,
    status = "resolved";
  try {
    variables = figmaVariablesSchema.parse(
      await figmaGet(
        `/v1/files/${key}/variables/local`,
        deps,
        "Figma file's variables",
      ),
    );
  } catch (error) {
    if (!(error instanceof FigmaHttpError)) throw error;
    status = `unavailable: ${error.status === 403 ? "variables need an Enterprise plan and the file_variables:read scope" : error.message}`;
  }
  const meta: FigmaMeta = {
    fileKey: ref.fileKey,
    nodeId,
    version,
    ...(file.lastModified === undefined
      ? {}
      : { lastModified: file.lastModified }),
    ...(file.name === undefined ? {} : { name: file.name }),
    fetchedAt: (options.now?.() ?? new Date()).toISOString(),
    scale: FIGMA_RENDER_SCALE,
    variables: status,
    link: figmaNodeLink(ref.fileKey, nodeId),
  };
  const target = join(root, safe(version)),
    staging = join(root, `.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, "nodes.json"), json(entry.document));
    await writeFile(join(staging, "frame.png"), png);
    if (variables)
      await writeFile(join(staging, "variables.json"), json(variables));
    await writeFile(join(staging, "meta.json"), json(meta));
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (!ref.version)
    await writeFile(join(root, "current.json"), json({ version }));
  return {
    meta,
    document: figmaNodeSchema.parse(entry.document),
    png,
    variables,
    cacheDirectory: target,
  };
}

/** Cached `variables/local` for `system --learn`; a 403 fails with the Enterprise explanation. */
export async function fetchFigmaVariables(
  ref: FigmaRef,
  options: {
    projectDirectory: string;
    refresh?: boolean | undefined;
    deps?: FigmaDependencies | undefined;
  },
): Promise<{
  variables: FigmaVariables;
  version: string;
  name?: string | undefined;
  path: string;
}> {
  const directory = join(
    figmaCacheRoot(options.projectDirectory, ref.fileKey),
    "variables",
  );
  if (!options.refresh) {
    let version = ref.version;
    if (!version)
      try {
        version = (
          JSON.parse(
            await readFile(join(directory, "current.json"), "utf8"),
          ) as { version?: string }
        ).version;
      } catch {}
    if (version)
      try {
        const path = join(directory, `${safe(version)}.json`);
        const cached = JSON.parse(await readFile(path, "utf8")) as {
          name?: string;
          variables: unknown;
        };
        return {
          variables: figmaVariablesSchema.parse(cached.variables),
          version,
          ...(cached.name === undefined ? {} : { name: cached.name }),
          path,
        };
      } catch {}
  }
  const deps = options.deps ?? {},
    key = encodeURIComponent(ref.fileKey);
  const file = figmaFileSchema.parse(
    await figmaGet(`/v1/files/${key}?depth=1`, deps),
  );
  const version = ref.version ?? file.version;
  let variables: FigmaVariables;
  try {
    variables = figmaVariablesSchema.parse(
      await figmaGet(
        `/v1/files/${key}/variables/local`,
        deps,
        "Figma file's variables",
      ),
    );
  } catch (error) {
    if (error instanceof FigmaHttpError && error.status === 403)
      throw new IdiomError(
        "Figma refused the variables endpoint (403). Reading variables through the REST API needs a Figma Enterprise plan and a token with the file_variables:read scope; without them, declare tokens in code and run `idiom system --learn` on the code instead.",
      );
    throw error;
  }
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${safe(version)}.json`);
  await writeFile(path, json({ name: file.name, version, variables }));
  if (!ref.version)
    await writeFile(join(directory, "current.json"), json({ version }));
  return {
    variables,
    version,
    ...(file.name === undefined ? {} : { name: file.name }),
    path,
  };
}
