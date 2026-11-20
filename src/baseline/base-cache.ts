import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { type GitRead, readGit } from "../changed/git.js";
import { IdiomError } from "../errors.js";
import { IDIOM_BUILD_COMMIT, IDIOM_VERSION } from "../version.js";
import { tupleCoordinateKey } from "./coordinate.js";
import { withFileLock } from "./lock.js";
import { type BaselineRecord, baselineRecordSchema } from "./schema.js";
import { MAX_RECORDS } from "./store.js";

/**
 * Captures of a build's base commit, shared by every worktree of a checkout.
 * It lives in the Git common directory, so it is never tracked and never
 * dirties a tree; deleting it only costs a later recapture.
 */
const baseCacheRecordSchema = baselineRecordSchema.extend({
  engine: z.string().min(1),
});
const baseCacheFileSchema = z
  .object({
    version: z.literal(1),
    flow: z.string(),
    records: z.array(baseCacheRecordSchema),
  })
  .strict();
export type BaseCacheRecord = z.infer<typeof baseCacheRecordSchema>;
export type BaseCacheFile = z.infer<typeof baseCacheFileSchema>;

/**
 * Set at build time only by this repository's out-of-tree self-gate build
 * (scripts/idiom-local.mjs): a fingerprint of the capture and check source.
 * Release and development builds leave it empty.
 */
declare const __IDIOM_ENGINE_IDENTITY__: string | undefined;

/**
 * Check code differs between Idiom builds; a record never crosses them. An
 * installed CLI is keyed by version + build commit; the out-of-tree self-gate
 * build is keyed by a source fingerprint of the code that produces a record,
 * so builds with identical check and capture code share base records.
 */
export function engineIdentity(): string {
  const pinned =
    typeof __IDIOM_ENGINE_IDENTITY__ === "string"
      ? __IDIOM_ENGINE_IDENTITY__
      : "";
  return pinned || `${IDIOM_VERSION}+${IDIOM_BUILD_COMMIT}`;
}

export async function baseCachePath(
  projectDirectory: string,
  flow: string,
  git: GitRead = readGit,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flow))
    throw new IdiomError(`invalid baseline flow: ${flow}`);
  return join(await baseCacheDirectory(projectDirectory, git), `${flow}.json`);
}

/** The project's base-cache directory, shared by every worktree. */
export async function baseCacheDirectory(
  projectDirectory: string,
  git: GitRead = readGit,
): Promise<string> {
  return commonStateDirectory(projectDirectory, "base-cache", git);
}

/**
 * `<git common dir>/idiom/<area>/<key>`: per-project state shared by every
 * worktree of a checkout, never tracked and never dirtying a tree.
 */
export async function commonStateDirectory(
  projectDirectory: string,
  area: string,
  git: GitRead = readGit,
): Promise<string> {
  const common = resolve(
    projectDirectory,
    (await git(projectDirectory, ["rev-parse", "--git-common-dir"])).trim(),
  );
  const top = (
    await git(projectDirectory, ["rev-parse", "--show-toplevel"])
  ).trim();
  // Keyed by the project's place in the repository, not the checkout path:
  // every worktree of the repository shares the entry.
  const local = relative(await realpath(top), await realpath(projectDirectory))
    .split(sep)
    .join("/");
  const key = createHash("sha256").update(local).digest("hex").slice(0, 12);
  return join(common, "idiom", area, key);
}

/** Tolerant: an unreadable or invalid cache is empty, never a failure. */
export async function readBaseCache(
  path: string,
  flow: string,
): Promise<BaseCacheRecord[]> {
  try {
    const file = baseCacheFileSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
    return file.flow === flow ? file.records : [];
  } catch {
    return [];
  }
}

/**
 * Merge a record into the cache: builds that capture different tuples at the
 * same base add to one record keyed by (commit, configHash, engine). The
 * read-merge-write holds a short per-file lock, so a gate's base capture and
 * a baseline advance on one host never drop each other's record.
 */
export async function writeBaseCacheRecord(
  path: string,
  flow: string,
  record: BaselineRecord,
  engine: string = engineIdentity(),
): Promise<BaseCacheRecord> {
  await mkdir(dirname(path), { recursive: true });
  return withFileLock(
    `${path}.lock`,
    {
      waitMs: 15_000,
      staleMs: 60_000,
      pollMs: 50,
      describe: "base cache write",
    },
    () => mergeBaseCacheRecord(path, flow, record, engine),
  );
}

async function mergeBaseCacheRecord(
  path: string,
  flow: string,
  record: BaselineRecord,
  engine: string,
): Promise<BaseCacheRecord> {
  const existing = await readBaseCache(path, flow);
  const same = (item: BaseCacheRecord) =>
    item.commit === record.commit &&
    item.configHash === record.configHash &&
    item.engine === engine;
  const previous = existing.find(same);
  const tuples = new Map(
    (previous?.tuples ?? []).map((tuple) => [tupleCoordinateKey(tuple), tuple]),
  );
  for (const tuple of record.tuples)
    tuples.set(tupleCoordinateKey(tuple), tuple);
  const merged: BaseCacheRecord = {
    ...record,
    engine,
    tuples: [...tuples.values()].sort((a, b) =>
      tupleCoordinateKey(a).localeCompare(tupleCoordinateKey(b)),
    ),
  };
  const file = baseCacheFileSchema.parse({
    version: 1,
    flow,
    records: [merged, ...existing.filter((item) => !same(item))].slice(
      0,
      MAX_RECORDS,
    ),
  });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return merged;
}
