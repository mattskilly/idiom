import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isPortOpen } from "./port-open.js";

/**
 * Every application server Idiom starts is recorded under the project's
 * cache until it stops. A run that was killed before it could stop its
 * server leaves the record behind; the next run in that project stops the
 * server — only when its owning run is gone and the pid still runs what was
 * recorded, so a reused pid is never signalled.
 */

/** What `ps` reports for a pid: its start time and its command line. */
export type ProcessIdentity = { start: string; args: string };

export type ServerRecord = {
  version: 1;
  pid: number;
  pgid: number;
  port: number;
  host: string;
  command: string;
  project: string;
  startedAt: string;
  process: ProcessIdentity;
  owner: { pid: number; start: string };
};

export type ServerRegistryDependencies = {
  inspect?: ((pid: number) => Promise<ProcessIdentity | undefined>) | undefined;
  kill?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  isPortOpen?: ((port: number, host?: string) => Promise<boolean>) | undefined;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  platform?: NodeJS.Platform | undefined;
  /** The owning run's pid; defaults to this process. */
  ownerPid?: number | undefined;
  now?: (() => Date) | undefined;
};

export type ServerRegistration = {
  /** Re-reads the server's command line once it has settled. */
  refresh: () => Promise<void>;
  remove: () => Promise<void>;
};

export type LeftoverServer = {
  pid: number;
  port: number;
  command: string;
  outcome: "stopped" | "failed";
};

const TERM_WAIT_MS = 3_000;
const KILL_WAIT_MS = 2_000;
const POLL_MS = 50;

export function serversDirectory(projectDirectory: string): string {
  return join(resolve(projectDirectory), ".idiom", "cache", "servers");
}

export function leftoverServerMessage(leftover: LeftoverServer): string {
  const which = `leftover application server (pid ${leftover.pid}, port ${leftover.port}) from an earlier run`;
  return leftover.outcome === "stopped"
    ? `Stopped a ${which}.`
    : `Could not stop a ${which}; stop it by hand.`;
}

/** `ps` with a pinned locale; undefined when the pid is not running. */
export async function inspectProcess(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  const read = (field: string) =>
    new Promise<string | undefined>((accept) => {
      execFile(
        "ps",
        ["-o", `${field}=`, "-p", String(pid)],
        { env: { ...process.env, LC_ALL: "C" }, timeout: 5_000 },
        (error, stdout) => {
          const value = String(stdout ?? "").trim();
          accept(error || value === "" ? undefined : value);
        },
      );
    });
  const [start, args] = await Promise.all([read("lstart"), read("args")]);
  return start === undefined || args === undefined
    ? undefined
    : { start, args };
}

const ownerStarts = new Map<number, Promise<string | undefined>>();

function ownerStart(
  pid: number,
  inspect: (pid: number) => Promise<ProcessIdentity | undefined>,
): Promise<string | undefined> {
  let start = ownerStarts.get(pid);
  if (start === undefined) {
    start = inspect(pid).then((identity) => identity?.start);
    // Only this process's own start time is stable enough to cache.
    if (pid === process.pid && inspect === inspectProcess)
      ownerStarts.set(pid, start);
  }
  return start;
}

async function writeRecord(path: string, record: ServerRecord): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Records a just-started server. Best-effort: without a readable identity
 * nothing is recorded, and nothing unrecorded is ever stopped.
 */
export async function registerServer(options: {
  projectDirectory: string;
  pid: number;
  port: number;
  host?: string | undefined;
  command: string;
  dependencies?: ServerRegistryDependencies | undefined;
}): Promise<ServerRegistration | undefined> {
  const dependencies = options.dependencies ?? {};
  if ((dependencies.platform ?? process.platform) === "win32") return undefined;
  const inspect = dependencies.inspect ?? inspectProcess;
  if (!Number.isInteger(options.pid) || options.pid <= 1) return undefined;
  try {
    const ownerPid = dependencies.ownerPid ?? process.pid;
    const [identity, owner] = await Promise.all([
      inspect(options.pid),
      ownerStart(ownerPid, inspect),
    ]);
    if (identity === undefined || owner === undefined) return undefined;
    const directory = serversDirectory(options.projectDirectory);
    const path = join(directory, `${options.pid}.json`);
    let record: ServerRecord = {
      version: 1,
      pid: options.pid,
      // Servers start detached, so each leads its own process group.
      pgid: options.pid,
      port: options.port,
      host: options.host ?? "127.0.0.1",
      command: options.command,
      project: resolve(options.projectDirectory),
      startedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      process: identity,
      owner: { pid: ownerPid, start: owner },
    };
    // A concurrent run may prune the empty directory between the two steps.
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(directory, { recursive: true });
        await writeRecord(path, record);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt > 0)
          throw error;
      }
    }
    let removed = false;
    return {
      refresh: async () => {
        try {
          const current = await inspect(options.pid);
          if (
            removed ||
            current === undefined ||
            current.start !== record.process.start ||
            current.args === record.process.args
          )
            return;
          record = { ...record, process: current };
          await writeRecord(path, record);
          if (removed) await rm(path, { force: true });
        } catch {
          // Best-effort: the registered identity still guards the pid.
        }
      },
      remove: async () => {
        removed = true;
        await rm(path, { force: true }).catch(() => undefined);
        await prune(options.projectDirectory);
      },
    };
  } catch {
    return undefined;
  }
}

/** Removes the servers directory, and the empty ones it was created in. */
async function prune(projectDirectory: string): Promise<void> {
  const directory = serversDirectory(projectDirectory);
  const cache = dirname(directory);
  for (const path of [directory, cache, dirname(cache)]) {
    try {
      await rmdir(path);
    } catch {
      return;
    }
  }
}

function matches(
  record: ServerRecord,
  identity: ProcessIdentity | undefined,
): boolean {
  if (identity === undefined || identity.start !== record.process.start)
    return false;
  return (
    identity.args === record.process.args ||
    identity.args.includes(record.command) ||
    wrapsCommand(record.process.args, record.command)
  );
}

/**
 * A record read before the shell exec'd the start command holds the
 * wrapper's command line. The same pid and start time then run the command
 * itself, whose `ps` args drop the shell's quoting and any env prefix.
 */
function wrapsCommand(args: string, command: string): boolean {
  return /^(\S*\/)?sh -c /.test(args) && args.endsWith(command);
}

function parseRecord(text: string): ServerRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<ServerRecord>;
    // Never 0 or 1: signalling either group would reach far beyond one server.
    const positive = (n: unknown) =>
      typeof n === "number" && Number.isInteger(n) && n > 1;
    if (
      value.version !== 1 ||
      !positive(value.pid) ||
      !positive(value.pgid) ||
      !(Number.isInteger(value.port) && (value.port as number) > 0) ||
      typeof value.command !== "string" ||
      typeof value.host !== "string" ||
      typeof value.process?.start !== "string" ||
      typeof value.process?.args !== "string" ||
      !positive(value.owner?.pid) ||
      typeof value.owner?.start !== "string"
    )
      return undefined;
    return value as ServerRecord;
  } catch {
    return undefined;
  }
}

/**
 * Stops servers recorded by runs that are gone, and returns one entry per
 * server it signalled. Never throws.
 */
export async function reapLeftoverServers(
  projectDirectory: string,
  dependencies: ServerRegistryDependencies = {},
): Promise<LeftoverServer[]> {
  if ((dependencies.platform ?? process.platform) === "win32") return [];
  const inspect = dependencies.inspect ?? inspectProcess;
  const kill =
    dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));
  const portOpen = dependencies.isPortOpen ?? isPortOpen;
  const sleep = dependencies.sleep ?? ((ms: number) => delay(ms));
  const directory = serversDirectory(projectDirectory);
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) =>
      /^\d+\.json$/.test(name),
    );
  } catch {
    return [];
  }
  const results: LeftoverServer[] = [];
  for (const name of names.sort()) {
    const path = join(directory, name);
    try {
      const record = parseRecord(await readFile(path, "utf8"));
      if (record === undefined) {
        await rm(path, { force: true });
        continue;
      }
      const owner = await inspect(record.owner.pid);
      if (owner !== undefined && owner.start === record.owner.start) continue;
      if (!matches(record, await inspect(record.pid))) {
        // Gone, or the pid now belongs to something else.
        await rm(path, { force: true });
        continue;
      }
      const signal = (value: NodeJS.Signals) => {
        try {
          kill(-record.pgid, value);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ESRCH") return;
          // Darwin reports EPERM for a group whose other members are zombies.
          if (code === "EPERM") {
            try {
              kill(record.pid, value);
            } catch {
              // Already gone, or not ours to signal.
            }
            return;
          }
          throw error;
        }
      };
      const stopped = async (timeoutMs: number) => {
        for (let waited = 0; ; waited += POLL_MS) {
          const running = matches(record, await inspect(record.pid));
          if (!running && !(await portOpen(record.port, record.host)))
            return true;
          if (waited >= timeoutMs) return false;
          await sleep(POLL_MS);
        }
      };
      signal("SIGTERM");
      let done = await stopped(TERM_WAIT_MS);
      if (!done) {
        signal("SIGKILL");
        done = await stopped(KILL_WAIT_MS);
      }
      if (done) await rm(path, { force: true });
      results.push({
        pid: record.pid,
        port: record.port,
        command: record.command,
        outcome: done ? "stopped" : "failed",
      });
    } catch {
      // Best-effort: one unreadable record never blocks a run.
    }
  }
  await prune(projectDirectory);
  return results;
}
