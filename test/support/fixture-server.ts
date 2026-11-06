import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import { join } from "node:path";

/**
 * The one way tests start fixture servers. Every fixture runs with the
 * lifeline preloaded, so it exits when the test process that owns it is
 * gone — even when that process was killed before its afterAll ran.
 */
export const LIFELINE = join(import.meta.dirname, "fixture-lifeline.cjs");

type FixtureOptions = {
  args?: string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
  ownerPid?: number | undefined;
};

export type FixtureSpawnSpec = {
  command: string;
  args: string[];
  options: SpawnOptions;
};

/** Plain data, so a process other than this one can spawn the fixture. */
export function fixtureSpawnSpec(
  script: string,
  options: FixtureOptions = {},
): FixtureSpawnSpec {
  return {
    command: process.execPath,
    args: ["--require", LIFELINE, script, ...(options.args ?? [])],
    options: {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: {
        ...process.env,
        ...options.env,
        FIXTURE_OWNER_PID: String(options.ownerPid ?? process.pid),
        FIXTURE_STDIN_LIFELINE: "1",
      },
      stdio: ["pipe", "ignore", "pipe"],
    },
  };
}

export type FixtureServer = {
  child: ChildProcess;
  pid: number;
  stop: () => Promise<void>;
};

async function closed(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((accept) => {
    const timer = setTimeout(() => accept(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      accept(true);
    });
  });
}

/** Spawns a fixture server and, given `readyUrl`, waits until it answers. */
export async function spawnFixtureServer(
  script: string,
  options: FixtureOptions & { readyUrl?: string | undefined } = {},
): Promise<FixtureServer> {
  const spec = fixtureSpawnSpec(script, options);
  const child = spawn(spec.command, spec.args, spec.options);
  child.stderr?.resume();
  if (child.pid === undefined)
    throw new Error(`fixture server ${script} did not start`);
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      child.kill("SIGTERM");
      if (!(await closed(child, 3_000))) {
        child.kill("SIGKILL");
        await closed(child, 3_000);
      }
    })();
    return stopping;
  };
  if (options.readyUrl !== undefined) {
    for (let attempt = 0; ; attempt++) {
      try {
        await fetch(options.readyUrl);
        break;
      } catch {
        if (attempt > 200 || child.exitCode !== null) {
          await stop();
          throw new Error(`fixture server ${script} did not start`);
        }
        await new Promise((accept) => setTimeout(accept, 25));
      }
    }
  }
  return { child, pid: child.pid, stop };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * A `server.start` command for a fixture. `script` may be relative to the
 * project (`server.mjs`) for copied or inline fixtures.
 */
export function fixtureCommand(
  script: string,
  args: string[] = [],
  { ownerPid = process.pid }: { ownerPid?: number } = {},
): string {
  return [
    `FIXTURE_OWNER_PID=${ownerPid}`,
    "node",
    "--require",
    quote(LIFELINE),
    quote(script),
    ...args.map(quote),
  ].join(" ");
}

/** Launch environment for an Electron fixture (its main.cjs loads the lifeline). */
export function fixtureEnvironment(): Record<string, string> {
  return { FIXTURE_OWNER_PID: String(process.pid), FIXTURE_LIFELINE: LIFELINE };
}

/** A `server.start` command for an inline fixture (`node -e <code>`). */
export function fixtureEvalCommand(
  code: string,
  { ownerPid = process.pid }: { ownerPid?: number } = {},
): string {
  return [
    `FIXTURE_OWNER_PID=${ownerPid}`,
    "node",
    "--require",
    quote(LIFELINE),
    "-e",
    quote(code),
  ].join(" ");
}
