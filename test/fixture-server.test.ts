import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { freePort } from "./doctor-support.js";
import {
  fixtureCommand,
  fixtureSpawnSpec,
  spawnFixtureServer,
} from "./support/fixture-server.js";

// A fixture started through the helper dies with the process that started
// it, even when that process is SIGKILLed before it can stop the fixture.

const SERVER = join(import.meta.dirname, "fixtures", "capture", "server.mjs");
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function kill(target: number) {
  // Never 0 or ±1: those signal this process group or every process.
  if (!Number.isInteger(target) || Math.abs(target) <= 1) return;
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function running(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function gone(target: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (running(target)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

/** A worker-like parent: runs `script`, prints the fixture's pid, then idles. */
function parent(script: string, args: string[] = []): ChildProcess {
  const child = spawn(process.execPath, ["-e", script, ...args], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  cleanups.push(() => kill(child.pid as number));
  return child;
}

async function firstLine(child: ChildProcess): Promise<number> {
  let text = "";
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    text += chunk.toString();
    if (text.includes("\n")) break;
  }
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 1)
    throw new Error(`expected a pid, got ${JSON.stringify(text)}`);
  return pid;
}

async function serving(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error("fixture never served");
}

test("a directly spawned fixture exits within 2s of its parent being SIGKILLed", async () => {
  const port = await freePort();
  // The owner pid is this (living) process, so only the closed stdin pipe
  // can end the fixture: the parent's death alone must be enough.
  const spec = fixtureSpawnSpec(SERVER, { env: { PORT: String(port) } });
  const worker = parent(
    [
      'const { spawn } = require("node:child_process");',
      "const spec = JSON.parse(process.argv[1]);",
      "const child = spawn(spec.command, spec.args, spec.options);",
      'process.stdout.write(child.pid + "\\n");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    [JSON.stringify(spec)],
  );
  const fixture = await firstLine(worker);
  cleanups.push(() => kill(fixture));
  await serving(port);
  expect(running(fixture)).toBe(true);
  worker.kill("SIGKILL");
  expect(await gone(fixture, 2_000)).toBe(true);
});

test("a server.start fixture exits within 2s of its owner being SIGKILLed", async () => {
  const port = await freePort();
  // The owner spawns the command the way Idiom does: a detached shell.
  const owner = parent(
    [
      'const { spawn } = require("node:child_process");',
      'let command = "";',
      'process.stdin.on("data", (chunk) => { command += chunk; });',
      'process.stdin.on("end", () => {',
      '  const child = spawn(command, { shell: true, detached: true, stdio: "ignore",',
      `    env: { ...process.env, PORT: "${port}" } });`,
      '  process.stdout.write(child.pid + "\\n");',
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const ownerPid = owner.pid as number;
  owner.stdin?.end(fixtureCommand(SERVER, [], { ownerPid }));
  const group = await firstLine(owner);
  cleanups.push(() => kill(-group));
  await serving(port);
  expect(running(-group)).toBe(true);
  owner.kill("SIGKILL");
  expect(await gone(-group, 2_000)).toBe(true);
});

test("spawnFixtureServer waits for readiness and stop() releases the port", async () => {
  const port = await freePort();
  const server = await spawnFixtureServer(SERVER, {
    env: { PORT: String(port) },
    readyUrl: `http://127.0.0.1:${port}/`,
  });
  cleanups.push(() => kill(server.pid));
  expect(running(server.pid)).toBe(true);
  await server.stop();
  expect(await gone(server.pid, 2_000)).toBe(true);
});
