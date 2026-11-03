import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { isPortOpen } from "../src/capture/process.js";
import { run } from "../src/cli.js";
import { renderDoctorReport, runDoctor } from "../src/commands/doctor.js";
import type { DoctorReport } from "../src/doctor/run.js";
import { RUN_FAILURE_EXIT_CODE } from "../src/errors.js";
import { mcpClient, toolData } from "./mcp-support.js";

// Doctor boots a real fixture server once. Each test proves the port is
// released afterwards, so doctor never leaks a process.

const SERVER = resolve("test/fixtures/capture/server.mjs");
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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  await new Promise<void>((accept) => server.close(() => accept()));
  return address.port;
}

async function doctorProject(
  server: { start: string; startupTimeoutMs?: number },
  port: number,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-doctor-test-"));
  directories.push(directory);
  await mkdir(join(directory, ".idiom", "flows"), { recursive: true });
  await writeFile(
    join(directory, ".idiom", "project.json"),
    JSON.stringify({
      version: 1,
      app: { name: "doctor", framework: "other" },
      server: {
        build: "node -e 0",
        readyUrl: `http://127.0.0.1:${port}/`,
        port,
        env: {},
        ...server,
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: {},
      design: {},
      model: { provider: "anthropic", model: "unused" },
    }),
  );
  await writeFile(
    join(directory, ".idiom", "flows", "home.json"),
    JSON.stringify({
      id: "home",
      title: "Home",
      intent: [],
      setup: [],
      states: [{ id: "home", description: "Home", url: "/", expect: {} }],
    }),
  );
  return directory;
}

const passing = async () => {
  const port = await freePort();
  return {
    port,
    directory: await doctorProject({ start: `node ${SERVER}` }, port),
  };
};

const neverReady = async () => {
  const port = await freePort();
  return {
    port,
    directory: await doctorProject(
      {
        start: `node -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
        startupTimeoutMs: 1_500,
      },
      port,
    ),
  };
};

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
