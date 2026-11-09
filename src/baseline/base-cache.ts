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

/** Check code differs between Idiom builds; a record never crosses them. */
export function engineIdentity(): string {
  return `${IDIOM_VERSION}+${IDIOM_BUILD_COMMIT}`;
}

export async function baseCachePath(
  projectDirectory: string,
  flow: string,
  git: GitRead = readGit,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flow))
    throw new IdiomError(`invalid baseline flow: ${flow}`);
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
  return join(common, "idiom", "base-cache", key, `${flow}.json`);
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
 * same base add to one record keyed by (commit, configHash, engine).
 */
export async function writeBaseCacheRecord(
  path: string,
  flow: string,
  record: BaselineRecord,
  engine: string = engineIdentity(),
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
