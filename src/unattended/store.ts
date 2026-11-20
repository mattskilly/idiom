import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type GitTopology, primaryCheckout } from "../verify/baseline.js";
import {
  type ClearedScope,
  type Condition,
  type ConditionCause,
  conditionLine,
  type UnattendedMode,
} from "./condition.js";

const execFileAsync = promisify(execFile);

const STORE = join(".idiom", "reports", "conditions.json");
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

const entrySchema = z.looseObject({
  key: z.string().min(1),
  cause: z.enum(["app-start", "baseline", "expectation"]),
  flows: z.array(z.string()).default([]),
  state: z.string().optional(),
  line: z.string(),
  mode: z.enum(["nightly", "gate", "verify", "watch"]),
  firstSeen: z.string(),
  lastSeen: z.string(),
  runs: z.number().int().min(1),
  ticket: z.string().optional(),
  resolvedAt: z.string().optional(),
  resolvedBy: z.enum(["nightly", "gate", "verify", "watch"]).optional(),
  coordinates: z.array(z.string()).optional(),
});
const storeSchema = z.looseObject({
  version: z.literal(1),
  conditions: z.array(entrySchema),
});

export type ConditionEntry = {
  key: string;
  cause: ConditionCause;
  flows: string[];
  state?: string | undefined;
  line: string;
  mode: UnattendedMode;
  firstSeen: string;
  lastSeen: string;
  runs: number;
  ticket?: string | undefined;
  resolvedAt?: string | undefined;
  resolvedBy?: UnattendedMode | undefined;
  coordinates?: string[] | undefined;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where conditions live: the primary checkout's gitignored
 * `.idiom/reports/conditions.json`, so `idiom doctor` there sees what gate
 * and verify runs raised inside build worktrees; else this project's own.
 */
export async function conditionStorePath(options: {
  projectDirectory: string;
  gitTopology?: GitTopology | undefined;
}): Promise<string> {
  const local = resolve(options.projectDirectory, STORE);
  try {
    const primary = await (options.gitTopology ?? primaryCheckout)(
      options.projectDirectory,
    );
    if (primary === undefined) return local;
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: options.projectDirectory, encoding: "utf8" },
    );
    const top = resolve(stdout.trim());
    if (resolve(primary) === top) return local;
    const within = relative(
      top,
      await realpath(options.projectDirectory).catch(() =>
        resolve(options.projectDirectory),
      ),
    );
    if (within.startsWith("..")) return local;
    const project = resolve(primary, within);
    // Only a primary checkout that is an Idiom project too.
    if (!(await exists(join(project, ".idiom")))) return local;
    return resolve(project, STORE);
  } catch {
    return local;
  }
}

export async function readConditions(path: string): Promise<ConditionEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  try {
    return storeSchema.parse(JSON.parse(text)).conditions as ConditionEntry[];
  } catch {
    // A corrupt store is rebuilt from the next run; conditions recur.
    return [];
  }
}

/** Open (unresolved) conditions, newest first. */
export async function openConditions(path: string): Promise<ConditionEntry[]> {
  return (await readConditions(path))
    .filter((entry) => entry.resolvedAt === undefined)
    .sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
}

async function withLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(lock, "wx");
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`condition store is locked (${lock})`);
      await new Promise((done) => setTimeout(done, 25 + Math.random() * 25));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

async function writeStore(
  path: string,
  conditions: ConditionEntry[],
): Promise<void> {
  const sorted = [...conditions].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, conditions: sorted }, null, 2)}\n`,
    );
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export type RecordOutcome = {
  /** The stored entry of every observed condition. */
  observed: ConditionEntry[];
  /** Conditions this run cleared (they were open and the run covered them). */
  resolved: ConditionEntry[];
  /** Set when the store could not be written; the exit never depends on it. */
  warning?: string | undefined;
};

function upsert(
  entries: ConditionEntry[],
  observed: readonly Condition[],
  cleared: readonly ClearedScope[],
  mode: UnattendedMode,
  now: string,
): RecordOutcome {
  const seen: ConditionEntry[] = [];
  for (const condition of observed) {
    const index = entries.findIndex((entry) => entry.key === condition.key);
    const previous = index === -1 ? undefined : entries[index];
    const reopened = previous?.resolvedAt !== undefined;
    const entry: ConditionEntry = {
      key: condition.key,
      cause: condition.cause,
      flows: condition.flows,
      ...(condition.state === undefined ? {} : { state: condition.state }),
      line: conditionLine(condition),
      mode,
      firstSeen: previous === undefined || reopened ? now : previous.firstSeen,
      lastSeen: now,
      runs: previous === undefined || reopened ? 1 : previous.runs + 1,
      ...(previous?.ticket === undefined ? {} : { ticket: previous.ticket }),
      ...(condition.coordinates === undefined
        ? {}
        : { coordinates: condition.coordinates }),
    };
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
    seen.push(entry);
  }
  const observedKeys = new Set(observed.map((condition) => condition.key));
  const resolved: ConditionEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.resolvedAt !== undefined || observedKeys.has(entry.key)) continue;
    if (!cleared.some((scope) => covers(scope, entry))) continue;
    const done = { ...entry, resolvedAt: now, resolvedBy: mode };
    entries[index] = done;
    resolved.push(done);
  }
  return { observed: seen, resolved };
}

function covers(scope: ClearedScope, entry: ConditionEntry): boolean {
  if (scope.key !== entry.key) return false;
  if (entry.coordinates === undefined || scope.coordinates === undefined)
    return true;
  const ran = new Set(scope.coordinates);
  return entry.coordinates.every((coordinate) => ran.has(coordinate));
}

/**
 * Upsert what this run observed, and resolve only the open conditions whose
 * scope the run fully covered without observing them. A scope the run never
 * exercised (a skipped state, a flow not checked) clears nothing.
 */
export async function recordConditions(options: {
  path: string;
  mode: UnattendedMode;
  observed: readonly Condition[];
  /** The scopes this run fully exercised. */
  cleared: readonly ClearedScope[];
  now: Date;
}): Promise<RecordOutcome> {
  const now = options.now.toISOString();
  try {
    return await withLock(options.path, async () => {
      const entries = await readConditions(options.path);
      const outcome = upsert(
        entries,
        options.observed,
        options.cleared,
        options.mode,
        now,
      );
      if (options.observed.length > 0 || outcome.resolved.length > 0)
        await writeStore(options.path, entries);
      return outcome;
    });
  } catch (error) {
    const outcome = upsert(
      await readConditions(options.path),
      options.observed,
      options.cleared,
      options.mode,
      now,
    );
    return {
      ...outcome,
      warning: `could not record conditions in ${options.path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Remember which ticket carries each condition. */
export async function recordTickets(
  path: string,
  tickets: ReadonlyMap<string, string>,
): Promise<void> {
  if (tickets.size === 0) return;
  await withLock(path, async () => {
    const entries = await readConditions(path);
    let changed = false;
    for (const entry of entries) {
      const ticket = tickets.get(entry.key);
      if (ticket !== undefined && entry.ticket !== ticket) {
        entry.ticket = ticket;
        changed = true;
      }
    }
    if (changed) await writeStore(path, entries);
  });
}
