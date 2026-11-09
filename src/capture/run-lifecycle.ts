import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { IdiomError } from "../errors.js";
import { captureTupleKey } from "./resolve.js";
import {
  loadRunRecord,
  type RunRecord,
  runRecordSchema,
} from "./run-record.js";
import { inspectProcess } from "./server-registry.js";

export type DiagnosticSink = (message: string) => void;
const stderr: DiagnosticSink = (message) =>
  process.stderr.write(`${message}\n`);
export type RunOwner = NonNullable<RunRecord["owner"]>;
export async function currentRunOwner(): Promise<RunOwner> {
  const identity = await inspectProcess(process.pid);
  return { pid: process.pid, ...(identity ? { start: identity.start } : {}) };
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Install referenced bytes before manifests. The run's status remains the read barrier. */
export async function installArtifactTree(
  source: string,
  destination: string,
): Promise<void> {
  const files: string[] = [];
  const walk = async (root: string): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && relative(source, path) !== "run.json")
        files.push(path);
    }
  };
  await walk(source);
  files.sort(
    (a, b) =>
      Number(a.endsWith(".json")) - Number(b.endsWith(".json")) ||
      a.localeCompare(b),
  );
  for (const file of files) {
    const target = join(destination, relative(source, file));
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await copyFile(file, temporary);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Serializes filesystem commits; sealing never waits for abandoned browser work. */
export class RunLifecycle {
  private pending: Promise<unknown> = Promise.resolve();
  private sealed = false;
  constructor(
    readonly directory: string,
    private record: RunRecord,
  ) {}
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => undefined);
    return next;
  }
  checkpoint(
    coordinate: RunRecord["selected"][number],
    timing: RunRecord["timings"]["tuples"][number] | undefined,
    commit: () => Promise<void>,
  ): Promise<void> {
    if (this.sealed) return Promise.resolve();
    return this.enqueue(async () => {
      await commit();
      const key = captureTupleKey(coordinate);
      const completed = new Set(
        this.record.completedTuples?.map(captureTupleKey),
      );
      completed.add(key);
      this.record.completedTuples = this.record.selected.filter((tuple) =>
        completed.has(captureTupleKey(tuple)),
      );
      if (timing)
        this.record.timings.tuples = this.record.timings.tuples.map((tuple) =>
          captureTupleKey(tuple) === key ? timing : tuple,
        );
      this.record.updatedAt = new Date().toISOString();
      await atomicJson(
        join(this.directory, "run.json"),
        runRecordSchema.parse(this.record),
      );
    });
  }
  complete(
    record: RunRecord,
    install: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<RunRecord> {
    if (this.sealed)
      return Promise.reject(
        new IdiomError("capture is interrupted; evidence is unverified"),
      );
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      if (this.sealed)
        throw new IdiomError("capture is interrupted; evidence is unverified");
      await install();
      signal?.throwIfAborted();
      if (this.sealed)
        throw new IdiomError("capture is interrupted; evidence is unverified");
      const endedAt = new Date().toISOString();
      const complete = runRecordSchema.parse({
        ...record,
        runId: this.record.runId,
        owner: this.record.owner,
        startedAt: this.record.startedAt,
        updatedAt: endedAt,
        endedAt,
        status: "complete",
        completedTuples: record.selected,
      });
      await atomicJson(join(this.directory, "run.json"), complete);
      this.record = complete;
      this.sealed = true;
      return complete;
    });
  }
  interrupt(
    interruption: NonNullable<RunRecord["interruption"]>,
    diagnostic: DiagnosticSink = stderr,
  ): Promise<void> {
    this.sealed = true;
    return this.enqueue(async () => {
      if (this.record.status !== "running") return;
      const endedAt = new Date().toISOString();
      this.record = runRecordSchema.parse({
        ...this.record,
        status: "interrupted",
        updatedAt: endedAt,
        endedAt,
        interruption,
      });
      await atomicJson(join(this.directory, "run.json"), this.record);
      if (interruption.reason === "signal")
        diagnostic(
          `Interrupted: run ${this.record.runId} kept ${this.record.completedTuples?.length ?? 0} of ${this.record.selected.length} tuples (unverified).`,
        );
    });
  }
}

type RecoveryDependencies = {
  inspect?: typeof inspectProcess;
  exists?: (pid: number) => boolean | undefined;
  diagnostic?: DiagnosticSink;
};
function pidExists(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? false
      : undefined;
  }
}
export async function runOwnerGone(
  owner: RunOwner,
  deps: RecoveryDependencies = {},
): Promise<boolean> {
  const exists = (deps.exists ?? pidExists)(owner.pid);
  if (exists === false) return true;
  if (exists !== true || !owner.start) return false;
  try {
    const identity = await (deps.inspect ?? inspectProcess)(owner.pid);
    return identity !== undefined && identity.start !== owner.start;
  } catch {
    return false;
  }
}
export async function recoverInterruptedRun(
  directory: string,
  deps: RecoveryDependencies = {},
): Promise<void> {
  const record = await loadRunRecord(directory);
  if (
    record?.status !== "running" ||
    !record.owner ||
    !(await runOwnerGone(record.owner, deps))
  )
    return;
  const lock = join(directory, ".recovery-lock");
  const owner = await currentRunOwner();
  try {
    await mkdir(lock);
    await atomicJson(join(lock, "owner.json"), owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Claim reclamation *inside* the current lock generation, then re-read
    // its owner. A contender that reaches a newly acquired lock sees it live.
    const claim = join(lock, "reclaim");
    try {
      await writeFile(claim, "", { flag: "wx" });
    } catch {
      return;
    }
    let stale: string | undefined;
    try {
      const held = JSON.parse(
        await readFile(join(lock, "owner.json"), "utf8"),
      ) as RunOwner;
      if (
        !Number.isInteger(held.pid) ||
        held.pid <= 0 ||
        !(await runOwnerGone(held, deps))
      )
        return;
      stale = `${lock}.${randomUUID()}.stale`;
      await rename(lock, stale);
    } catch {
      return;
    } finally {
      // Never unlink through the original path after renaming a generation.
      if (stale) await rm(stale, { recursive: true, force: true });
      else await rm(claim, { force: true });
    }
    return recoverInterruptedRun(directory, deps);
  }
  try {
    const latest = await loadRunRecord(directory);
    if (
      latest?.status !== "running" ||
      !latest.owner ||
      !(await runOwnerGone(latest.owner, deps))
    )
      return;
    const endedAt = new Date().toISOString();
    await atomicJson(
      join(directory, "run.json"),
      runRecordSchema.parse({
        ...latest,
        status: "interrupted",
        updatedAt: endedAt,
        endedAt,
        interruption: { reason: "process-gone" },
      }),
    );
    (deps.diagnostic ?? stderr)(
      `Run ${latest.runId ?? basename(directory)} was interrupted (process gone) after ${latest.completedTuples?.length ?? 0} of ${latest.selected.length} tuples.`,
    );
  } finally {
    await releaseLock(lock);
  }
}
/**
 * Release a held recovery lock by renaming its generation away, then removing
 * it. A plain recursive rm reads the directory, unlinks what it saw and calls
 * rmdir; a contender's `reclaim` claim landing in between fails that rmdir with
 * ENOTEMPTY and left an ownerless lock behind. After the rename a contender's
 * claim fails ENOENT, which is correct: the holder already recovered. Release
 * never turns a recovery into a failure; the record is already committed.
 */
async function releaseLock(lock: string): Promise<void> {
  const released = `${lock}.${randomUUID()}.released`;
  try {
    await rename(lock, released);
  } catch {
    return;
  }
  // A claim already in flight against the renamed inode may still land.
  await rm(released, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 10,
  }).catch(() => undefined);
}
/** The raw lifecycle status, so a record that fails validation still gates readers. */
async function recordedStatus(directory: string): Promise<unknown> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(directory, "run.json"), "utf8"),
    );
    return raw !== null && typeof raw === "object" && "status" in raw
      ? raw.status
      : undefined;
  } catch {
    // Absent (legacy or non-capture report) or unparseable: the reader that
    // owns the run reports an invalid record itself.
    return undefined;
  }
}
/**
 * Legacy runs without a status are complete. A malformed record without a
 * status reaches its reader, which reports it as invalid; any recorded status
 * other than `complete` is never consumed as evidence.
 */
export async function isCompleteRun(directory: string): Promise<boolean> {
  const status = await recordedStatus(directory);
  if (status === "running")
    await recoverInterruptedRun(directory).catch(() => undefined);
  return status === undefined || status === "complete";
}
export async function assertCompleteRun(directory: string): Promise<void> {
  await recoverInterruptedRun(directory);
  const record = await loadRunRecord(directory);
  if (record?.status && record.status !== "complete")
    throw new IdiomError(
      `Run ${record.runId ?? basename(directory)} is ${record.status}; retained evidence is unverified. Rerun capture for a complete run.`,
    );
}
export async function completeRunNames(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries)
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      (await isCompleteRun(join(root, entry.name)))
    )
      names.push(entry.name);
  return names.sort().reverse();
}
