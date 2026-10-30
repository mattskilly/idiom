import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isPortOpen,
  type OwnedServer,
  runServerBuild,
  type SpawnProcess,
  startServer,
} from "../src/capture/process.js";
import { type CaptureDependencies, runCapture } from "../src/capture/run.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

// The startup failure branches of startServer and the server build failure
// that precedes it. Real children prove cleanup; fake children pin the exact
// diagnostic where real stdio flushing would race the exit.

const SECRET = "fixture-secret-value";
const REDACTED = "[redacted FIXTURE_TOKEN]";

const pids: number[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const pid of pids.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
    }
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freePort(host = "127.0.0.1"): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, host, accept);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error === undefined ? accept() : reject(error))),
  );
  return address.port;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-startup-"));
  directories.push(directory);
  return directory;
}

function project(
  server: { start?: string; build?: string; port?: number } & Record<
    string,
    unknown
  >,
) {
  const port = server.port ?? 3199;
  return projectSchema.parse({
    version: 1,
    app: { name: "startup", framework: "other" },
    server: {
      build: "unused",
      start: "unused",
      readyUrl: `http://127.0.0.1:${port}/`,
      port,
      env: {},
      ...server,
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
}

function environment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, FIXTURE_TOKEN: SECRET };
}

function node(script: string): string {
  return `node -e ${JSON.stringify(script)}`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function dead(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdout,
    stderr,
  });
  const finish = (
    code: number | null,
    signal: NodeJS.Signals | null = null,
  ) => {
    Object.assign(child, { exitCode: code, signalCode: signal });
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  return { child, stdout, stderr, finish };
}

function rejectingFetch() {
  return vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
}

const sleep10 = () => delay(10);

describe("startServer readiness timeout", () => {
  test("reports the bounded, redacted output and leaves no server running", async () => {
    const port = await freePort();
    const script =
      "console.log('booting pid=' + process.pid + ' ' + process.env.FIXTURE_TOKEN); setInterval(() => {}, 1000)";
    let owned: OwnedServer | undefined;
    const fetch = rejectingFetch();
    const pending = startServer({
      projectDirectory: process.cwd(),
      project: project({ start: node(script), port, startupTimeoutMs: 1_000 }),
      environment: environment(),
      onOwned: (server) => {
        owned = server;
        if (server.process.pid !== undefined) pids.push(server.process.pid);
      },
      dependencies: {
        fetch,
        sleep: sleep10,
        // The deadline passes only once the server's output is collected.
        now: () => (owned?.output().includes("booting pid=") ? 10_000 : 0),
        teardownTimeoutMs: 500,
      },
    });
    const error = await pending.then(
      () => undefined,
      (failure: unknown) => failure as Error,
    );
    expect(error?.message).toMatch(
      new RegExp(
        `^application server was not ready at http://127\\.0\\.0\\.1:${port}/ within 1000ms: booting pid=\\d+ `,
      ),
    );
    expect(error?.message).toContain(REDACTED);
    expect(error?.message).not.toContain(SECRET);
    expect(fetch).toHaveBeenCalled();

    if (owned === undefined) throw new Error("server was never owned");
    const shell = owned.process.pid;
    const server = Number(/pid=(\d+)/.exec(error?.message ?? "")?.[1]);
    expect(shell).toBeTypeOf("number");
    pids.push(server);
    expect(
      owned.process.exitCode !== null || owned.process.signalCode !== null,
    ).toBe(true);
    expect(await dead(shell as number)).toBe(true);
    expect(await dead(server)).toBe(true);
    expect(await isPortOpen(port)).toBe(false);
    await expect(owned.stop()).resolves.toBeUndefined();
  });
});

describe("startServer early exit", () => {
  test.each([
    { code: 3, signal: null, status: "exit 3" },
    { code: null, signal: "SIGSEGV" as const, status: "SIGSEGV" },
  ])(
    "reports $status with the redacted output and sends no signal",
    async ({ code, signal, status }) => {
      const fake = fakeChild();
      const kill = vi.spyOn(process, "kill");
      const fetch = vi.fn(async () => {
        fake.stderr.write(`crashed with ${SECRET}\n`);
        fake.finish(code, signal);
        throw new TypeError("fetch failed");
      });
      let owned: OwnedServer | undefined;
      await expect(
        startServer({
          projectDirectory: process.cwd(),
          project: project({ port: await freePort() }),
          environment: environment(),
          onOwned: (server) => {
            owned = server;
          },
          dependencies: {
            spawn: vi.fn(() => fake.child) as unknown as SpawnProcess,
            fetch,
            sleep: async () => {},
            teardownTimeoutMs: 100,
          },
        }),
      ).rejects.toThrow(
        `application server exited before readiness (${status}): crashed with ${REDACTED}`,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled();
      await expect(owned?.stop()).resolves.toBeUndefined();
    },
  );

  test("a real server that exits fails fast and leaves nothing running", async () => {
    const port = await freePort();
    let owned: OwnedServer | undefined;
    const started = Date.now();
    await expect(
      startServer({
        projectDirectory: process.cwd(),
        project: project({
          start: node("process.exit(3)"),
          port,
          startupTimeoutMs: 30_000,
        }),
        environment: environment(),
        onOwned: (server) => {
          owned = server;
          if (server.process.pid !== undefined) pids.push(server.process.pid);
        },
        dependencies: {
          fetch: rejectingFetch(),
          sleep: sleep10,
          teardownTimeoutMs: 500,
        },
      }),
    ).rejects.toThrow(/application server exited before readiness \(exit 3\)/);
    expect(Date.now() - started).toBeLessThan(5_000);
    if (owned === undefined) throw new Error("server was never owned");
    expect(owned.process.pid).toBeTypeOf("number");
    expect(await dead(owned.process.pid as number)).toBe(true);
    expect(await isPortOpen(port)).toBe(false);
  });
});

describe("startServer spawn error", () => {
  test("a missing working directory fails as could-not-start and stops cleanly", async () => {
    let owned: OwnedServer | undefined;
    await expect(
      startServer({
        projectDirectory: join(tmpdir(), `idiom-missing-${randomUUID()}`),
        project: project({ start: node("0"), port: await freePort() }),
        environment: environment(),
        onOwned: (server) => {
          owned = server;
        },
        dependencies: {
          fetch: rejectingFetch(),
          sleep: sleep10,
          teardownTimeoutMs: 100,
        },
      }),
    ).rejects.toThrow(/^application server could not start: .*ENOENT/);
    if (owned === undefined) throw new Error("server was never owned");
    expect(owned.process.pid).toBeUndefined();
    await expect(owned.stop()).resolves.toBeUndefined();
  });

  test("redacts the spawn error and sends no signal", async () => {
    const fake = fakeChild();
    const kill = vi.spyOn(process, "kill");
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        fake.child.emit("error", new Error(`spawn failed ${SECRET}`));
        fake.finish(-2);
      });
      return fake.child;
    });
    let owned: OwnedServer | undefined;
    await expect(
      startServer({
        projectDirectory: process.cwd(),
        project: project({ port: await freePort() }),
        environment: environment(),
        onOwned: (server) => {
          owned = server;
        },
        dependencies: {
          spawn: spawn as unknown as SpawnProcess,
          fetch: rejectingFetch(),
          sleep: async () => {},
          teardownTimeoutMs: 100,
        },
      }),
    ).rejects.toThrow(
      `application server could not start: spawn failed ${REDACTED}`,
    );
    expect(kill).not.toHaveBeenCalled();
    await expect(owned?.stop()).resolves.toBeUndefined();
  });
});

describe("server build failure", () => {
  test("runServerBuild reports the command, status and redacted stderr", async () => {
    const directory = await temporaryDirectory();
    const error = await runServerBuild({
      projectDirectory: directory,
      dataDirectory: directory,
      project: project({
        build: node(
          "console.error('build broke ' + process.env.FIXTURE_TOKEN); process.exit(2)",
        ),
      }),
      inheritedEnvironment: environment(),
    }).then(
      () => undefined,
      (failure: unknown) => failure as Error,
    );
    expect(error?.message).toMatch(
      /^server build failed \(.*cwd .*exit 2\): build broke \[redacted FIXTURE_TOKEN\]$/,
    );
    expect(error?.message).not.toContain(SECRET);
  });

  test("runCapture stops before server startup and leaves no artifacts", async () => {
    const root = await temporaryDirectory();
    const stagingDirectory = join(root, "staging");
    const dataDirectory = join(root, "data");
    const finalDirectory = join(root, "final");
    await mkdir(stagingDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    const spawn = vi.fn((command: string) => {
      if (command !== "build-cmd") throw new Error(`unexpected ${command}`);
      const fake = fakeChild();
      queueMicrotask(() => {
        fake.stderr.write("compile error\n");
        fake.finish(1);
      });
      return fake.child;
    });
    const fetch = rejectingFetch();
    const browserLauncher = vi.fn(async () => {
      throw new Error("browser must not launch");
    });
    const dependencies: CaptureDependencies = {
      browserLauncher,
      inheritedEnvironment: environment(),
      snapshotSource: async () => ({ commit: "fixture", dirty: false }),
      createArtifactWorkspace: async () => ({
        finalDirectory,
        stagingDirectory,
        dataDirectory,
      }),
      process: {
        spawn: spawn as unknown as SpawnProcess,
        fetch,
        teardownTimeoutMs: 100,
      },
    };
    await expect(
      runCapture({
        projectDirectory: root,
        project: project({
          build: "build-cmd",
          start: "start-cmd",
          port: await freePort(),
          fixedPort: true,
        }),
        flow: flowSchema.parse({
          id: "build-failure",
          title: "Build failure",
          intent: [],
          setup: [],
          states: [{ id: "state", description: "State", url: "/", expect: {} }],
        }),
        out: finalDirectory,
        dependencies,
      }),
    ).rejects.toThrow(
      /server build failed \(build-cmd, .*exit 1\): compile error/,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("build-cmd", expect.anything());
    expect(spawn).not.toHaveBeenCalledWith("start-cmd", expect.anything());
    expect(fetch).not.toHaveBeenCalled();
    expect(browserLauncher).not.toHaveBeenCalled();
    for (const directory of [finalDirectory, stagingDirectory, dataDirectory]) {
      await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
