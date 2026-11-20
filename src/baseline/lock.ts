import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { formatCritiqueTimeout } from "../duration.js";
import { IdiomError } from "../errors.js";

export type LockOptions = {
  /** How long to wait for a live holder before failing loudly. */
  waitMs: number;
  /** A holder older than this is taken over, alive or not. */
  staleMs: number;
  pollMs?: number | undefined;
  /** What the holder is doing, recorded for whoever waits on it. */
  describe?: string | undefined;
  now?: (() => number) | undefined;
  /** Whether a PID on this host is still running. */
  isAlive?: ((pid: number) => boolean) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Who a waiter is told holds the lock (default: another Idiom process). */
  holderLabel?: string | undefined;
};

type Holder = {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
  description?: string | undefined;
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readHolder(path: string): Promise<Holder | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<Holder>;
    if (
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      typeof value.hostname === "string" &&
      typeof value.startedAt === "string"
    )
      return value as Holder;
  } catch {
    /* Unreadable or mid-write: treated as malformed. */
  }
  return undefined;
}

function describeHolder(holder: Holder | undefined): string {
  if (holder === undefined) return "an unreadable holder";
  return `pid ${holder.pid} on ${holder.hostname}${holder.description ? `, ${holder.description}` : ""}, since ${holder.startedAt}`;
}

/**
 * Run `work` while holding an exclusive lock file. A holder whose process is
 * gone (same host) or that is older than `staleMs` is taken over; a live one
 * is waited on for `waitMs`, then the wait fails loudly naming it. Release
 * removes the file only while it still carries this holder's token.
 */
export async function withFileLock<T>(
  path: string,
  options: LockOptions,
  work: () => Promise<T>,
): Promise<T> {
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processAlive;
  const pollMs = options.pollMs ?? 1000;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const host = hostname();
  const token = randomUUID();
  const started = now();
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    const holder: Holder = {
      token,
      pid: process.pid,
      hostname: host,
      startedAt: new Date(now()).toISOString(),
      ...(options.describe === undefined
        ? {}
        : { description: options.describe }),
    };
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(holder)}\n`);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = await readHolder(path);
    let stale: boolean;
    if (current === undefined) {
      // Malformed (or being written): stale only once it is old by mtime.
      const modified = await stat(path)
        .then((entry) => entry.mtimeMs)
        .catch(() => undefined);
      if (modified === undefined) continue; // Released meanwhile: retry.
      stale = now() - modified > options.staleMs;
    } else {
      const age = now() - Date.parse(current.startedAt);
      stale =
        !(age <= options.staleMs) ||
        (current.hostname === host && !isAlive(current.pid));
    }
    if (stale) {
      // Only remove what was read; a fresh holder that raced in stays.
      const again = await readHolder(path);
      if (again?.token === current?.token)
        await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    if (now() - started >= options.waitMs)
      throw new IdiomError(
        `${options.holderLabel ?? "another Idiom process"} holds ${path} (${describeHolder(current)}); waited ${formatCritiqueTimeout(options.waitMs)}`,
      );
    await sleep(Math.max(1, Math.min(pollMs, options.waitMs)));
  }
  try {
    return await work();
  } finally {
    const current = await readHolder(path);
    if (current?.token === token) await rm(path, { force: true });
  }
}
