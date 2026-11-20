import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { commonStateDirectory } from "../baseline/base-cache.js";
import { type GitRead, readGit } from "../changed/git.js";
import { IdiomError } from "../errors.js";

export const WATCH_RECENT_LIMIT = 50;

const outcomeSchema = z
  .object({
    commit: z.string(),
    parent: z.string(),
    subject: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    ms: z.number(),
    gate: z
      .object({
        status: z.enum(["clean", "findings", "skipped", "deferred", "failed"]),
        newFindings: z.number(),
        eligible: z.number(),
        reason: z.string().optional(),
      })
      .strict(),
    tickets: z.array(
      z
        .object({
          kind: z.string(),
          ticket: z.string().optional(),
          findingIds: z.array(z.string()),
        })
        .strict(),
    ),
    baseline: z
      .object({
        status: z.enum([
          "advanced",
          "current",
          "superseded",
          "not-advanced",
          "failed",
          "absent",
        ]),
        flows: z.array(z.string()).optional(),
        reason: z.string().optional(),
      })
      .strict(),
    harvest: z
      .object({
        status: z.enum(["recorded", "unavailable", "error", "off"]),
        recorded: z.number().optional(),
        reason: z.string().optional(),
      })
      .strict(),
    error: z.string().optional(),
  })
  .strict();
export type WatchOutcome = z.infer<typeof outcomeSchema>;

const stateSchema = z
  .object({
    version: z.literal(1),
    target: z.string().min(1),
    /** The last merge whose steps finished. */
    cursor: z.string().min(1),
    startedAt: z.string(),
    /** The merge being processed; redone after an interrupted run. */
    inFlight: z
      .object({
        commit: z.string(),
        attempts: z.number().int().nonnegative(),
        startedAt: z.string(),
      })
      .strict()
      .optional(),
    recent: z.array(outcomeSchema),
  })
  .strict();
export type WatchState = z.infer<typeof stateSchema>;

/** `<git common dir>/idiom/watch/<project key>`: shared by every worktree. */
export async function watchDirectory(
  projectDirectory: string,
  git: GitRead = readGit,
): Promise<string> {
  return commonStateDirectory(projectDirectory, "watch", git);
}

/**
 * The repository's top level and the project's path inside it ("" at the
 * root, `/`-separated): where the project sits inside the watch tree.
 */
export async function repositoryProjectPath(
  projectDirectory: string,
  git: GitRead = readGit,
): Promise<{ repository: string; projectRelative: string }> {
  const repository = (
    await git(projectDirectory, ["rev-parse", "--show-toplevel"])
  ).trim();
  const projectRelative = relative(
    await realpath(repository),
    await realpath(projectDirectory),
  )
    .split(sep)
    .join("/");
  return { repository, projectRelative };
}

/** Where `idiom watch` gates write their runs: the project inside the tree. */
export function watchTreeReports(
  watchDir: string,
  projectRelative: string,
): string {
  return join(watchDir, "tree", projectRelative, ".idiom", "reports");
}

export const watchStatePath = (directory: string) =>
  join(directory, "state.json");

export async function readWatchState(
  path: string,
): Promise<WatchState | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return stateSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new IdiomError(
      `malformed ${path}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}; delete it to restart watching from the branch tip`,
    );
  }
}

/** Atomic: a crash mid-write leaves the previous state. */
export async function writeWatchState(
  path: string,
  state: WatchState,
): Promise<void> {
  const value = stateSchema.parse({
    ...state,
    recent: state.recent.slice(-WATCH_RECENT_LIMIT),
  });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
