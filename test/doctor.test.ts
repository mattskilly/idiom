import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { isPortOpen } from "../src/capture/process.js";
import { serversDirectory } from "../src/capture/server-registry.js";
import { run } from "../src/cli.js";
import { renderDoctorReport, runDoctor } from "../src/commands/doctor.js";
import type { DoctorReport } from "../src/doctor/run.js";
import { RUN_FAILURE_EXIT_CODE } from "../src/errors.js";
import { neverReadyProject, passingProject } from "./doctor-support.js";
import { mcpClient, toolData } from "./mcp-support.js";

// Doctor boots a real fixture server once. Each test proves the port is
// released afterwards, so doctor never leaks a process.

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const passing = () => passingProject(directories);
const neverReady = () => neverReadyProject(directories);

test("the fixture app passes every server step and releases its port", async () => {
  const { directory, port } = await passing();
  const report = await runDoctor({ flow: "home", cwd: directory });
  expect(report.ok).toBe(true);
  expect(report.failure).toBeUndefined();
  const status = Object.fromEntries(
    report.steps.map((step) => [step.id, step.status]),
  );
  expect(status).toMatchObject({
    config: "pass",
    registry: "pass",
    port: "pass",
    setup: "skip",
    build: "pass",
    start: "pass",
    ready: "pass",
    shutdown: "pass",
  });
  // Not a Git worktree: a warning, never a failure.
  expect(status.tree).toBe("warn");
  for (const step of report.steps) expect(step.ms).toBeTypeOf("number");
  expect(await isPortOpen(port)).toBe(false);
  expect(renderDoctorReport(report).split("\n")[0]).toBe(
    "idiom doctor home: ok",
  );
});

test("a server that never becomes ready fails the start step with the readiness hint", async () => {
  const { directory, port } = await neverReady();
  const report = await runDoctor({ flow: "home", cwd: directory });
  expect(report.ok).toBe(false);
  const start = report.steps.find((step) => step.id === "start");
  expect(start?.status).toBe("fail");
  expect(start?.detail).toMatch(/^server failed to start: timeout/);
  expect(start?.hint).toContain("server.readyUrl");
  expect(report.steps.find((step) => step.id === "ready")?.status).toBe("skip");
  expect(report.failure).toMatchObject({
    stage: "server",
    cause: "server-timeout",
  });
  expect(await isPortOpen(port)).toBe(false);
  expect(renderDoctorReport(report)).toContain("fix: make server.readyUrl");
});

test("an invalid project fails config and skips the rest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-doctor-empty-"));
  directories.push(directory);
  const report = await runDoctor({ cwd: directory });
  expect(report.ok).toBe(false);
  expect(report.failure).toMatchObject({
    stage: "preflight",
    cause: "no-project",
  });
  expect(report.failure?.hint).toContain("idiom init");
  expect(
    report.steps.filter((step) => step.status === "skip").map((s) => s.id),
  ).toEqual([
    "registry",
    "tree",
    "port",
    "setup",
    "build",
    "start",
    "ready",
    "shutdown",
  ]);
});

test("the CLI exits 0 on a passing app and 2 on a failing one; --json parses", async () => {
  const good = await passing();
  const stdout: string[] = [];
  expect(
    await run(["node", "idiom", "doctor", "home", "--json"], {
      cwd: good.directory,
      stdout: (message) => stdout.push(message),
      stderr: () => undefined,
    }),
  ).toBe(0);
  expect((JSON.parse(stdout.join("")) as DoctorReport).ok).toBe(true);

  const bad = await neverReady();
  const stderr: string[] = [];
  expect(
    await run(["node", "idiom", "doctor", "home"], {
      cwd: bad.directory,
      stdout: () => undefined,
      stderr: (message) => stderr.push(message),
    }),
  ).toBe(RUN_FAILURE_EXIT_CODE);
  expect(stderr.join("").split("\n")[0]).toMatch(
    /^server failed to start: timeout after 1500ms/,
  );
});

test("MCP idiom_doctor returns the structured report", async () => {
  const { directory } = await passing();
  const session = await mcpClient({ project: directory });
  cleanups.push(session.close);
  const report = toolData<DoctorReport>(
    await session.client.callTool({
      name: "idiom_doctor",
      arguments: { flow: "home" },
    }),
  );
  expect(report.ok).toBe(true);
  expect(report.steps.map((step) => step.id)).toContain("shutdown");
});

test("doctor stops a leftover server first and reports it in JSON, text and stderr", async () => {
  const { directory } = await passing();
  const fresh = await runDoctor({ flow: "home", cwd: directory });
  expect(fresh).not.toHaveProperty("leftovers");
  const identity = { start: "Mon Nov  3 10:00:00 2026", args: "node x" };
  const leftover = async () => {
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
    return {
      inspect: async (pid: number) => table.get(pid),
      kill: (pid: number) => {
        table.delete(Math.abs(pid));
      },
      isPortOpen: async () => false,
      sleep: async () => undefined,
    };
  };
  const message =
    "Stopped a leftover application server (pid 4321, port 3107) from an earlier run.";

  const messages: string[] = [];
  const report = await runDoctor({
    flow: "home",
    cwd: directory,
    dependencies: {
      process: { serverRegistry: await leftover() },
      onLeftoverServer: (line) => messages.push(line),
    },
  });
  expect(report.ok).toBe(true);
  expect(report.leftovers).toEqual([
    { pid: 4321, port: 3107, command: "node x", outcome: "stopped" },
  ]);
  expect(messages).toEqual([message]);
  expect(renderDoctorReport(report).split("\n")[1]).toBe(message);

  // --json keeps stdout to the payload; the line goes to stderr.
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await run(["node", "idiom", "doctor", "home", "--json"], {
      cwd: directory,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      capture: { process: { serverRegistry: await leftover() } },
    }),
  ).toBe(0);
  expect(JSON.parse(stdout.join("")).leftovers).toHaveLength(1);
  expect(stdout.join("")).not.toContain("Stopped a leftover");
  expect(stderr.join("")).toContain(message);
});
