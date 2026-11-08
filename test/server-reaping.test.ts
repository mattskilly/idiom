import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { isPortOpen } from "../src/capture/process.js";
import { runCapture } from "../src/capture/run.js";
import { serversDirectory } from "../src/capture/server-registry.js";
import { run } from "../src/cli.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { doctorProject, freePort, SERVER } from "./doctor-support.js";
import { fixtureCommand } from "./support/fixture-server.js";

// An Idiom run killed mid-capture cannot stop its server. The next run in
// the same project finds the record it left and stops that server.

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const directories: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function cli(directory: string, args: string[]): ChildProcess {
  const child = spawn(
    process.execPath,
    [CLI, "--project", directory, ...args],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  cleanups.push(() => child.kill("SIGKILL"));
  return child;
}

async function finished(child: ChildProcess) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((accept) =>
    child.once("close", accept),
  );
  return { code, stdout, stderr };
}

async function commit(directory: string) {
  const git = promisify(execFile);
  await git("git", ["init", "--quiet"], { cwd: directory });
  await git("git", ["add", "."], { cwd: directory });
  await git(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: directory },
  );
}

/** Reaping now follows run-record creation; a failing setup step ends the run just after it. */
async function stopAfterReaping(directory: string) {
  const path = join(directory, ".idiom", "flows", "home.json");
  const flow = JSON.parse(await readFile(path, "utf8"));
  flow.setup = [{ run: 'node -e "process.exit(7)"' }];
  await writeFile(path, JSON.stringify(flow));
}

async function records(directory: string): Promise<string[]> {
  try {
    return await readdir(serversDirectory(directory));
  } catch {
    return [];
  }
}

test("a server left by a SIGKILLed capture is stopped by the next run in the project", async () => {
  const port = await freePort();
  const directory = await doctorProject(
    { start: fixtureCommand(SERVER) },
    port,
    directories,
  );
  const config = join(directory, ".idiom", "project.json");
  const project = JSON.parse(await readFile(config, "utf8"));
  // A long settle holds the capture open after the server is ready.
  project.capture = { settleMs: 20_000 };
  await writeFile(config, JSON.stringify(project));
  await commit(directory);

  const capture = cli(directory, ["capture", "home", "--port", String(port)]);
  let pid: number | undefined;
  for (let attempt = 0; attempt < 400 && pid === undefined; attempt++) {
    const [name] = await records(directory);
    if (name !== undefined && (await isPortOpen(port)))
      pid = Number(name.replace(/\.json$/, ""));
    else await delay(50);
  }
  expect(pid, "the capture recorded its server").toBeTypeOf("number");
  const server = pid as number;
  cleanups.push(() => {
    try {
      process.kill(-server, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  capture.kill("SIGKILL");
  await new Promise((accept) => capture.once("close", accept));
  // The server leads its own group and outlives the killed run.
  await delay(300);
  expect(running(server)).toBe(true);
  expect(await isPortOpen(port)).toBe(true);

  const doctor = await finished(
    cli(directory, ["doctor", "home", "--port", String(port), "--json"]),
  );
  expect(doctor.stderr).toContain(
    `Stopped a leftover application server (pid ${server}, port ${port}) from an earlier run.`,
  );
  const report = JSON.parse(doctor.stdout);
  expect(report.leftovers).toEqual([
    {
      pid: server,
      port,
      command: fixtureCommand(SERVER),
      outcome: "stopped",
    },
  ]);
  expect(
    report.steps.find((step: { id: string }) => step.id === "port").status,
  ).toBe("pass");
  expect(report.ok, doctor.stdout).toBe(true);
  expect(doctor.code).toBe(0);
  expect(running(server)).toBe(false);
  expect(await isPortOpen(port)).toBe(false);
  expect(await records(directory)).toEqual([]);
}, 60_000);

test("capture reaps leftovers first and reports each through onLeftoverServer", async () => {
  const port = await freePort();
  const directory = await doctorProject(
    { start: fixtureCommand(SERVER) },
    port,
    directories,
  );
  const servers = serversDirectory(directory);
  await mkdir(servers, { recursive: true });
  const identity = { start: "Mon Nov  3 10:00:00 2026", args: "node x" };
  await writeFile(
    join(servers, "4321.json"),
    JSON.stringify({
      version: 1,
      pid: 4321,
      pgid: 4321,
      port: 3107,
      host: "127.0.0.1",
      command: "node x",
      project: directory,
      startedAt: "2026-11-03T10:00:00.000Z",
      process: identity,
      owner: { pid: 999, start: "gone" },
    }),
  );
  const table = new Map([[4321, identity]]);
  const messages: string[] = [];
  const signals: Array<[number, string]> = [];
  await stopAfterReaping(directory);
  await commit(directory);
  await expect(
    runCapture({
      projectDirectory: directory,
      project: projectSchema.parse(
        JSON.parse(
          await readFile(join(directory, ".idiom", "project.json"), "utf8"),
        ),
      ),
      flow: flowSchema.parse(
        JSON.parse(
          await readFile(
            join(directory, ".idiom", "flows", "home.json"),
            "utf8",
          ),
        ),
      ),
      dependencies: {
        onLeftoverServer: (message) => messages.push(message),
        process: {
          serverRegistry: {
            inspect: async (pid) => table.get(pid),
            kill: (pid, signal) => {
              signals.push([pid, signal]);
              table.delete(Math.abs(pid));
            },
            isPortOpen: async () => false,
            sleep: async () => undefined,
          },
        },
      },
    }),
  ).rejects.toThrow("setup");
  expect(signals).toEqual([[-4321, "SIGTERM"]]);
  expect(messages).toEqual([
    "Stopped a leftover application server (pid 4321, port 3107) from an earlier run.",
  ]);
  expect(await records(directory)).toEqual([]);
});

test("check --json reports a stopped leftover on stderr, never stdout", async () => {
  const port = await freePort();
  const directory = await doctorProject(
    { start: fixtureCommand(SERVER) },
    port,
    directories,
  );
  await stopAfterReaping(directory);
  await commit(directory);
  const identity = { start: "Mon Nov  3 10:00:00 2026", args: "node x" };
  await mkdir(serversDirectory(directory), { recursive: true });
  await writeFile(
    join(serversDirectory(directory), "4321.json"),
    JSON.stringify({
      version: 1,
      pid: 4321,
      pgid: 4321,
      port: 3107,
      host: "127.0.0.1",
      command: "node x",
      project: directory,
      startedAt: "2026-11-03T10:00:00.000Z",
      process: identity,
      owner: { pid: 999, start: "gone" },
    }),
  );
  const table = new Map([[4321, identity]]);
  const stdout: string[] = [];
  const stderr: string[] = [];
  await run(["node", "idiom", "check", "home", "--json"], {
    cwd: directory,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    capture: {
      process: {
        serverRegistry: {
          inspect: async (pid) => table.get(pid),
          kill: (pid) => {
            table.delete(Math.abs(pid));
          },
          isPortOpen: async () => false,
          sleep: async () => undefined,
        },
      },
    },
  }).catch(() => undefined);
  const message =
    "Stopped a leftover application server (pid 4321, port 3107) from an earlier run.";
  expect(stderr.join("")).toContain(message);
  expect(stdout.join("")).not.toContain(message);
});
