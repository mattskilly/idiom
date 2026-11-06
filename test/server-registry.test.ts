import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  inspectProcess,
  leftoverServerMessage,
  type ProcessIdentity,
  reapLeftoverServers,
  registerServer,
  type ServerRecord,
  type ServerRegistryDependencies,
  serversDirectory,
} from "../src/capture/server-registry.js";

const directories: string[] = [];
const pids: number[] = [];

afterEach(async () => {
  for (const pid of pids.splice(0))
    try {
      if (pid <= 1) continue;
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-server-registry-"));
  directories.push(directory);
  return directory;
}

const SERVER = { start: "Mon Nov  3 10:00:00 2026", args: "node app.mjs" };
const OWNER = { start: "Mon Nov  3 09:59:00 2026", args: "node idiom" };

function record(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    version: 1,
    pid: 4321,
    pgid: 4321,
    port: 3107,
    host: "127.0.0.1",
    command: "node app.mjs",
    project: "/project",
    startedAt: "2026-11-03T10:00:00.000Z",
    process: SERVER,
    owner: { pid: 999, start: OWNER.start },
    ...overrides,
  };
}

async function write(directory: string, value: ServerRecord | string) {
  await mkdir(serversDirectory(directory), { recursive: true });
  const pid = typeof value === "string" ? 4321 : value.pid;
  await writeFile(
    join(serversDirectory(directory), `${pid}.json`),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

/** A fake process table: the server dies after the signals listed in `dies`. */
function world(
  table: Map<number, ProcessIdentity>,
  options: { dies?: NodeJS.Signals[] } = {},
) {
  const signals: Array<[number, NodeJS.Signals]> = [];
  const dependencies: ServerRegistryDependencies = {
    inspect: async (pid) => table.get(pid),
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if ((options.dies ?? ["SIGTERM"]).includes(signal))
        table.delete(Math.abs(pid));
    },
    isPortOpen: async () => false,
    sleep: async () => undefined,
  };
  return { dependencies, signals };
}

async function records(directory: string): Promise<string[]> {
  try {
    return await readdir(serversDirectory(directory));
  } catch {
    return [];
  }
}

test("a record whose owning run is still alive is kept and never signalled", async () => {
  const directory = await project();
  await write(directory, record());
  const { dependencies, signals } = world(
    new Map([
      [4321, SERVER],
      [999, OWNER],
    ]),
  );
  expect(await reapLeftoverServers(directory, dependencies)).toEqual([]);
  expect(signals).toEqual([]);
  expect(await records(directory)).toEqual(["4321.json"]);
});

test("a leftover whose owner is gone is stopped by group and its record removed", async () => {
  const directory = await project();
  await write(directory, record());
  const { dependencies, signals } = world(new Map([[4321, SERVER]]));
  const leftovers = await reapLeftoverServers(directory, dependencies);
  expect(leftovers).toEqual([
    { pid: 4321, port: 3107, command: "node app.mjs", outcome: "stopped" },
  ]);
  expect(signals).toEqual([[-4321, "SIGTERM"]]);
  expect(await records(directory)).toEqual([]);
  expect(leftoverServerMessage(leftovers[0] as never)).toBe(
    "Stopped a leftover application server (pid 4321, port 3107) from an earlier run.",
  );
});

test("an owner pid reused by another process counts as gone", async () => {
  const directory = await project();
  await write(directory, record());
  const { dependencies, signals } = world(
    new Map([
      [4321, SERVER],
      [999, { ...OWNER, start: "Tue Nov  4 08:00:00 2026" }],
    ]),
  );
  expect(await reapLeftoverServers(directory, dependencies)).toHaveLength(1);
  expect(signals).toEqual([[-4321, "SIGTERM"]]);
});

test("a server that survives SIGTERM gets SIGKILL", async () => {
  const directory = await project();
  await write(directory, record());
  const { dependencies, signals } = world(new Map([[4321, SERVER]]), {
    dies: ["SIGKILL"],
  });
  const [leftover] = await reapLeftoverServers(directory, dependencies);
  expect(leftover?.outcome).toBe("stopped");
  expect(signals).toEqual([
    [-4321, "SIGTERM"],
    [-4321, "SIGKILL"],
  ]);
});

test("a server that survives SIGKILL is reported as failed and its record kept", async () => {
  const directory = await project();
  await write(directory, record());
  const { dependencies } = world(new Map([[4321, SERVER]]), { dies: [] });
  const leftovers = await reapLeftoverServers(directory, dependencies);
  expect(leftovers).toEqual([
    { pid: 4321, port: 3107, command: "node app.mjs", outcome: "failed" },
  ]);
  expect(await records(directory)).toEqual(["4321.json"]);
  expect(leftoverServerMessage(leftovers[0] as never)).toBe(
    "Could not stop a leftover application server (pid 4321, port 3107) from an earlier run; stop it by hand.",
  );
});

test("a port still held after the pid is gone waits for release", async () => {
  const directory = await project();
  await write(directory, record());
  let held = 3;
  const { dependencies } = world(new Map([[4321, SERVER]]));
  dependencies.isPortOpen = async () => held-- > 0;
  const [leftover] = await reapLeftoverServers(directory, dependencies);
  expect(leftover?.outcome).toBe("stopped");
  expect(held).toBeLessThan(0);
});

test("a reused server pid (another start time) is never signalled", async () => {
  const directory = await project();
  await write(directory, record());
  const { dependencies, signals } = world(
    new Map([[4321, { ...SERVER, start: "Wed Nov  5 12:00:00 2026" }]]),
  );
  expect(await reapLeftoverServers(directory, dependencies)).toEqual([]);
  expect(signals).toEqual([]);
  expect(await records(directory)).toEqual([]);
});

test("a pid running another command is never signalled", async () => {
  const directory = await project();
  await write(directory, record());
  const { dependencies, signals } = world(
    new Map([[4321, { ...SERVER, args: "/usr/bin/vim notes.txt" }]]),
  );
  expect(await reapLeftoverServers(directory, dependencies)).toEqual([]);
  expect(signals).toEqual([]);
});

test("the shell that wraps the recorded command matches", async () => {
  const directory = await project();
  await write(directory, record());
  const { dependencies, signals } = world(
    new Map([[4321, { ...SERVER, args: "/bin/sh -c node app.mjs" }]]),
  );
  expect(await reapLeftoverServers(directory, dependencies)).toHaveLength(1);
  expect(signals).toEqual([[-4321, "SIGTERM"]]);
});

test.each([
  ['node "/app/main.mjs"', "node /app/main.mjs"],
  ["PORT=3107 node app.mjs", "node app.mjs"],
])(
  "a record taken before the shell exec'd %s matches the exec'd process",
  async (command, execd) => {
    const directory = await project();
    await write(
      directory,
      record({
        command,
        process: { ...SERVER, args: `/bin/sh -c ${command}` },
      }),
    );
    const { dependencies, signals } = world(
      new Map([[4321, { ...SERVER, args: execd }]]),
    );
    expect(await reapLeftoverServers(directory, dependencies)).toHaveLength(1);
    expect(signals).toEqual([[-4321, "SIGTERM"]]);
  },
);

test("a pre-exec record never matches another process at that pid", async () => {
  const directory = await project();
  await write(
    directory,
    record({
      command: 'node "/app/main.mjs"',
      process: { ...SERVER, args: '/bin/sh -c node "/app/main.mjs"' },
    }),
  );
  const { dependencies, signals } = world(
    new Map([
      [4321, { start: "Wed Nov  5 12:00:00 2026", args: "node /app/main.mjs" }],
    ]),
  );
  expect(await reapLeftoverServers(directory, dependencies)).toEqual([]);
  expect(signals).toEqual([]);
});

test("a server already gone leaves only a stale record, removed silently", async () => {
  const directory = await project();
  await write(directory, record());
  const { dependencies, signals } = world(new Map());
  expect(await reapLeftoverServers(directory, dependencies)).toEqual([]);
  expect(signals).toEqual([]);
  expect(await records(directory)).toEqual([]);
});

test("a malformed record is removed without throwing", async () => {
  const directory = await project();
  await write(directory, "{ not json");
  const { dependencies, signals } = world(new Map([[4321, SERVER]]));
  expect(await reapLeftoverServers(directory, dependencies)).toEqual([]);
  expect(signals).toEqual([]);
  expect(await records(directory)).toEqual([]);
});

test("a missing or unreadable servers directory reaps nothing", async () => {
  const directory = await project();
  const { dependencies } = world(new Map());
  expect(await reapLeftoverServers(directory, dependencies)).toEqual([]);
  await write(directory, record());
  await chmod(serversDirectory(directory), 0o000);
  try {
    expect(await reapLeftoverServers(directory, dependencies)).toEqual([]);
  } finally {
    await chmod(serversDirectory(directory), 0o755);
  }
});

test("on Windows the registry does nothing", async () => {
  const directory = await project();
  await write(directory, record());
  const { dependencies, signals } = world(new Map([[4321, SERVER]]));
  dependencies.platform = "win32";
  expect(await reapLeftoverServers(directory, dependencies)).toEqual([]);
  expect(signals).toEqual([]);
  expect(
    await registerServer({
      projectDirectory: directory,
      pid: 4321,
      port: 3107,
      command: "node app.mjs",
      dependencies,
    }),
  ).toBeUndefined();
});

test("registration writes the identity record and removal deletes it", async () => {
  const directory = await project();
  const table = new Map([
    [4321, SERVER],
    [999, OWNER],
  ]);
  const registration = await registerServer({
    projectDirectory: directory,
    pid: 4321,
    port: 3107,
    command: "node app.mjs",
    dependencies: {
      inspect: async (pid) => table.get(pid),
      ownerPid: 999,
      now: () => new Date("2026-11-03T10:00:00.000Z"),
    },
  });
  expect(registration).toBeDefined();
  const path = join(serversDirectory(directory), "4321.json");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
    record({ project: directory }),
  );
  table.set(4321, { ...SERVER, args: "node /abs/app.mjs" });
  await registration?.refresh();
  expect(JSON.parse(await readFile(path, "utf8")).process.args).toBe(
    "node /abs/app.mjs",
  );
  await registration?.remove();
  expect(await records(directory)).toEqual([]);
});

test("without a readable identity nothing is recorded", async () => {
  const directory = await project();
  expect(
    await registerServer({
      projectDirectory: directory,
      pid: 4321,
      port: 3107,
      command: "node app.mjs",
      dependencies: { inspect: async () => undefined },
    }),
  ).toBeUndefined();
  expect(await records(directory)).toEqual([]);
});

test("a real detached process left by a dead owner is stopped", async () => {
  const directory = await project();
  const owner = spawn(process.execPath, ["-e", "0"]);
  await new Promise((accept) => owner.once("close", accept));
  const code = "setInterval(() => {}, 1000)";
  const child = spawn(process.execPath, ["-e", code], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid as number;
  pids.push(pid);
  // `ps` reports the forked parent's command line until exec completes.
  await new Promise((accept) => child.once("spawn", accept));
  const registration = await registerServer({
    projectDirectory: directory,
    pid,
    port: 1,
    command: code,
    dependencies: { ownerPid: owner.pid as number },
  });
  // The dead owner has no identity to record.
  expect(registration).toBeUndefined();
  const identity = await inspectProcess(pid);
  expect(identity).toBeDefined();
  await write(
    directory,
    record({
      pid,
      pgid: pid,
      port: 1,
      command: code,
      process: identity as ProcessIdentity,
      owner: { pid: owner.pid as number, start: OWNER.start },
    }),
  );
  const exited = new Promise((accept) => child.once("exit", accept));
  const leftovers = await reapLeftoverServers(directory);
  expect(leftovers).toEqual([
    { pid, port: 1, command: code, outcome: "stopped" },
  ]);
  await exited;
  expect(() => process.kill(pid, 0)).toThrow();
});
