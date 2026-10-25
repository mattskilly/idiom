import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  bindProjectToPort,
  replaceOrigin,
  requestedPort,
  reservePort,
} from "../src/capture/port.js";
import {
  expandDataDirectory,
  expandEnvironment,
  isPortOpen,
  prepareProduction,
  replacePort,
  runServerBuild,
  runSetupSteps,
  startServer,
} from "../src/capture/process.js";
import { canonicalizeOrigin } from "../src/capture/run.js";
import type { TupleResult } from "../src/capture/types.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

import { productionFixture } from "./production-support.js";

const temporaryDirectories: string[] = [];
const fixture = join(import.meta.dirname, "fixtures", "capture");
const dataDirectoryPlaceholder = "$" + "{dataDir}";
const unknownPlaceholder = "$" + "{unknown}";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function shellPath(file: string): string {
  return JSON.stringify(file);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error === undefined ? accept() : reject(error))),
  );
  return address.port;
}

test("setup steps wait for full close, run in order, and capture selected stdout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-process-"));
  temporaryDirectories.push(directory);
  const marker = join(directory, "order.txt");
  const script = shellPath(join(fixture, "step.mjs"));
  const flow = flowSchema.parse({
    id: "process",
    title: "Process",
    intent: [],
    setup: [
      {
        run: `node ${script} first 40`,
        env: { MARKER: marker, DATA_VALUE: dataDirectoryPlaceholder },
        captureStdout: true,
      },
      {
        run: `node ${script} second`,
        env: { MARKER: marker, DATA_VALUE: "done" },
      },
    ],
    states: [],
  });
  const result = await runSetupSteps({
    projectDirectory: directory,
    flow,
    dataDirectory: join(directory, "data"),
    inheritedEnvironment: { PATH: process.env.PATH },
  });
  expect(await readFile(marker, "utf8")).toBe(
    `first:${join(directory, "data")}\nsecond:done\n`,
  );
  expect(result.capturedStdout).toEqual(["stdout:first\n"]);
});

test("setup errors are actionable and redact inherited secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-process-"));
  temporaryDirectories.push(directory);
  const script = shellPath(join(fixture, "step.mjs"));
  const flow = flowSchema.parse({
    id: "failure",
    title: "Failure",
    intent: [],
    setup: [{ run: `node ${script} bad`, captureStdout: true }],
    states: [],
  });
  await expect(
    runSetupSteps({
      projectDirectory: directory,
      flow,
      dataDirectory: directory,
      inheritedEnvironment: {
        PATH: process.env.PATH,
        FAIL_STEP: "bad",
        TEST_SECRET_KEY: "do-not-print-me",
      },
    }),
  ).rejects.toThrow(
    /setup step 1 failed.*exit 7.*\[redacted TEST_SECRET_KEY\]/s,
  );
});

test("environment expansion rejects unknown placeholders", () => {
  expect(() =>
    expandEnvironment({ VALUE: unknownPlaceholder }, "/data"),
  ).toThrow(`unsupported placeholder ${unknownPlaceholder}`);
});

test("data-directory expansion handles args, cwd, and repeated placeholders", () => {
  expect(
    expandDataDirectory(
      `${dataDirectoryPlaceholder}/one:${dataDirectoryPlaceholder}/two`,
      "/capture-data",
      "Electron launch args[0]",
    ),
  ).toBe("/capture-data/one:/capture-data/two");
  expect(() =>
    expandDataDirectory(
      unknownPlaceholder,
      "/capture-data",
      "Electron launch cwd",
    ),
  ).toThrow(
    `Electron launch cwd contains unsupported placeholder ${unknownPlaceholder}`,
  );
});

test("owned server reaches readiness and releases its port after SIGTERM", async () => {
  const port = await freePort();
  const project = projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "node -e 0",
      start: `node ${shellPath(join(fixture, "server.mjs"))}`,
      readyUrl: `http://127.0.0.1:${port}/`,
      port,
      env: {},
      startupTimeoutMs: 5_000,
    },
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const server = await startServer({
    projectDirectory: fixture,
    project,
    environment: { ...process.env, PORT: String(port) },
  });
  expect(await isPortOpen(port)).toBe(true);
  await server.stop();
  expect(await isPortOpen(port)).toBe(false);
});

test("owned server escalates to a hard kill when SIGTERM is ignored", async () => {
  const port = await freePort();
  const project = projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "node -e 0",
      start: `node ${shellPath(join(fixture, "server.mjs"))}`,
      readyUrl: `http://127.0.0.1:${port}/`,
      port,
      env: {},
      startupTimeoutMs: 5_000,
    },
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const server = await startServer({
    projectDirectory: fixture,
    project,
    environment: {
      ...process.env,
      PORT: String(port),
      IGNORE_TERM: "1",
    },
    dependencies: { teardownTimeoutMs: 100 },
  });
  await server.stop();
  expect(await isPortOpen(port)).toBe(false);
});

test("a start command that pins its port fails fast with the fix", async () => {
  const reserved = await freePort();
  const configured = await freePort();
  const project = projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "node -e 0",
      start: `node ${shellPath(join(fixture, "server.mjs"))}`,
      readyUrl: `http://127.0.0.1:${reserved}/`,
      port: reserved,
      env: {},
      startupTimeoutMs: 30_000,
    },
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const started = Date.now();
  await expect(
    startServer({
      projectDirectory: fixture,
      project,
      // The child ignores the reserved port and binds the configured one.
      environment: { ...process.env, PORT: String(configured) },
      configuredPort: configured,
    }),
  ).rejects.toThrow(
    `started on its configured port ${configured}, not the reserved port ${reserved}`,
  );
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(await isPortOpen(configured)).toBe(false);
});

test("a pre-existing port conflict is explicit", async () => {
  const port = await freePort();
  const blocker = createServer();
  await new Promise<void>((accept) =>
    blocker.listen(port, "127.0.0.1", accept),
  );
  const project = projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "node -e 0",
      start: "node -e 0",
      readyUrl: `http://127.0.0.1:${port}/`,
      port,
      env: {},
    },
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  await expect(
    startServer({
      projectDirectory: fixture,
      project,
      environment: process.env,
    }),
  ).rejects.toThrow(`port ${port} in use by another process`);
  await new Promise<void>((accept, reject) =>
    blocker.close((error) => (error === undefined ? accept() : reject(error))),
  );
});

test("production reserves one free port, builds once, shares expanded env, and restores output", async () => {
  const f = await productionFixture();
  temporaryDirectories.push(f.directory);
  f.project.server.env.IDIOM_LEGACY_ONLY = "ignored";
  const config = f.project.server.production;
  if (config === undefined) throw new Error("missing production config");
  config.build += ` --port=${f.project.server.port}`;
  config.start += ` --port=${f.project.server.port}`;
  await mkdir(join(f.directory, "production-output"));
  await writeFile(join(f.directory, "production-output", "old"), "preserved");
  const runtime = await prepareProduction({
    projectDirectory: f.directory,
    project: f.project,
    dataDirectory: f.dataDirectory,
    commit: "abc",
    inheritedEnvironment: { PATH: process.env.PATH, INHERITED_MARKER: "kept" },
  });
  try {
    expect(runtime.project.server.port).not.toBe(f.project.server.port);
    expect(await isPortOpen(runtime.project.server.port)).toBe(true);
    expect(runtime.environment.INHERITED_MARKER).toBe("kept");
    expect(runtime.environment.PORT).toBe(String(runtime.project.server.port));
    expect(runtime.environment.IDIOM_LEGACY_ONLY).toBeUndefined();
    expect(runtime.project.server.build).toContain(
      `--port=${runtime.project.server.port}`,
    );
    expect(runtime.project.server.start).toContain(
      `--port=${runtime.project.server.port}`,
    );
    expect(runtime.project.server.readyUrl).toBe(
      `http://127.0.0.1:${runtime.project.server.port}/`,
    );
    expect(runtime.environment.DATA_DIR).toBe(f.dataDirectory);
    expect(runtime.environment.NEXT_PUBLIC_API_BASE).toBe(
      `http://127.0.0.1:${runtime.project.server.port}`,
    );
    expect(await runtime.execute()).toEqual({
      kind: "production",
      id: "fixture-production-id",
    });
    expect(await runtime.execute()).toEqual({
      kind: "production",
      id: "fixture-production-id",
    });
    expect((await f.audit()).map((entry) => entry.phase)).toEqual([
      "build",
      "start",
    ]);
    expect(
      await readFile(
        join(f.directory, "production-output", "client.js"),
        "utf8",
      ),
    ).toContain(`:${runtime.project.server.port}/api`);
  } finally {
    await runtime.close();
  }
  await runtime.close();
  expect(await isPortOpen(runtime.project.server.port)).toBe(false);
  expect(
    await readFile(join(f.directory, "production-output", "old"), "utf8"),
  ).toBe("preserved");
  expect(await readdir(join(f.directory, "production-output"))).toEqual([
    "old",
  ]);
});

test("port replacement respects whole numbers in commands and env", () => {
  expect(
    replacePort(
      "node start --port 3107 http://localhost:3107 13107 31070",
      3107,
      45678,
    ),
  ).toBe("node start --port 45678 http://localhost:45678 13107 31070");
});

function portedProject(server: Record<string, unknown> = {}) {
  return projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "build --port 3107",
      start: "next dev -p 3107",
      readyUrl: "http://localhost:3107/ready",
      port: 3107,
      env: { NEXT_PUBLIC_URL: "http://localhost:3107", OTHER: "31070" },
      ...server,
    },
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
}

test("requested port precedence: --port, then IDIOM_PORT, then fixedPort", () => {
  const project = portedProject();
  expect(requestedPort({ environment: {}, project })).toBeUndefined();
  expect(requestedPort({ environment: { IDIOM_PORT: "4100" }, project })).toBe(
    4100,
  );
  expect(
    requestedPort({ flag: 4200, environment: { IDIOM_PORT: "4100" }, project }),
  ).toBe(4200);
  expect(
    requestedPort({
      flag: 4200,
      environment: { IDIOM_PORT: "invalid" },
      project,
    }),
  ).toBe(4200);
  const fixed = portedProject({ fixedPort: true });
  expect(requestedPort({ environment: {}, project: fixed })).toBe(3107);
  expect(
    requestedPort({ environment: { IDIOM_PORT: "3107" }, project: fixed }),
  ).toBe(3107);
});

test("fixedPort rejects a different --port or IDIOM_PORT", () => {
  const fixed = portedProject({ fixedPort: true });
  for (const options of [
    { environment: { IDIOM_PORT: "4100" } },
    { flag: 4100, environment: {} },
  ])
    expect(() => requestedPort({ ...options, project: fixed })).toThrow(
      "server.fixedPort is true; remove --port/IDIOM_PORT or set fixedPort to false",
    );
});

test.each(["", " ", "0", "65536", "abc", "31.5", "-1"])(
  "an invalid port value %s is an explicit error naming its source",
  (value) => {
    const project = portedProject();
    expect(() =>
      requestedPort({ environment: { IDIOM_PORT: value }, project }),
    ).toThrow(`IDIOM_PORT must be an integer from 1 to 65535`);
    const flag = Number(value);
    if (Number.isFinite(flag))
      expect(() => requestedPort({ flag, environment: {}, project })).toThrow(
        "--port must be an integer from 1 to 65535",
      );
  },
);

test("binding a project rewrites whole port tokens in readyUrl, env and commands", () => {
  const bound = bindProjectToPort(portedProject(), 45678);
  expect(bound.server).toMatchObject({
    build: "build --port 45678",
    start: "next dev -p 45678",
    readyUrl: "http://localhost:45678/ready",
    port: 45678,
    env: { NEXT_PUBLIC_URL: "http://localhost:45678", OTHER: "31070" },
  });
  const fixed = portedProject({ fixedPort: true });
  expect(bindProjectToPort(fixed, 45678)).toBe(fixed);
});

test("a reserved port is held on loopback and never the configured port", async () => {
  const reservation = await reservePort(3107);
  try {
    expect(reservation.port).not.toBe(3107);
    expect(await isPortOpen(reservation.port)).toBe(true);
  } finally {
    await reservation.release();
  }
  expect(await isPortOpen(reservation.port)).toBe(false);
});

test("a ready URL already answering on its own host is refused before spawn", async () => {
  const port = await freePort();
  const blocker = createServer();
  await new Promise<void>((accept) =>
    blocker.listen(port, "127.0.0.1", accept),
  );
  let spawned = false;
  try {
    await expect(
      startServer({
        projectDirectory: fixture,
        project: portedProject({
          build: "node -e 0",
          start: "node -e 0",
          readyUrl: `http://localhost:${port}/`,
          port,
          env: {},
        }),
        environment: process.env,
        dependencies: {
          spawn: (() => {
            spawned = true;
            throw new Error("must not spawn");
          }) as never,
        },
      }),
    ).rejects.toThrow(
      `http://localhost:${port}/ already answers — port ${port} in use by another process`,
    );
    expect(spawned).toBe(false);
  } finally {
    await new Promise<void>((accept) => blocker.close(() => accept()));
  }
});

test("an IPv6 ready host is refused even when IPv4 loopback is free", async (context) => {
  const blocker = createServer();
  try {
    await new Promise<void>((accept, reject) => {
      blocker.once("error", reject);
      blocker.listen({ port: 0, host: "::1", ipv6Only: true }, accept);
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL") {
      context.skip();
      return;
    }
    throw error;
  }
  const address = blocker.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  const port = address.port;
  let spawned = false;
  try {
    expect(await isPortOpen(port)).toBe(false);
    await expect(
      startServer({
        projectDirectory: fixture,
        project: portedProject({ readyUrl: `http://[::1]:${port}/`, port }),
        environment: process.env,
        dependencies: {
          spawn: (() => {
            spawned = true;
            throw new Error("must not spawn");
          }) as never,
        },
      }),
    ).rejects.toThrow(`port ${port} in use by another process`);
    expect(spawned).toBe(false);
  } finally {
    await new Promise<void>((accept) => blocker.close(() => accept()));
  }
});

test("origin canonicalization and review mapping apply the same transform", () => {
  const actual = "http://127.0.0.1:543";
  const configured = "http://127.0.0.1:3107";
  const text = `${actual}/a ${actual}21/b ${actual}`;
  const result: TupleResult = {
    ok: false,
    stage: "navigation",
    message: text,
    dom: text,
    console: [
      {
        type: "error",
        text,
        location: { url: `${actual}/a`, lineNumber: 1, columnNumber: 2 },
      },
    ],
    axe: { nested: [text] },
    mismatches: [],
    startedAt: "",
    endedAt: "",
  };
  const expected = replaceOrigin(text, actual, configured);
  expect(expected).toBe(`${configured}/a ${actual}21/b ${configured}`);
  const canonical = canonicalizeOrigin(result, actual, configured);
  expect(canonical).toMatchObject({
    message: expected,
    dom: expected,
    console: [{ text: expected, location: { url: `${configured}/a` } }],
    axe: { nested: [expected] },
  });
  expect(canonicalizeOrigin(result, configured, configured)).toBe(result);
});

test.each(["failure", "cancel", "readiness"])(
  "production cleanup releases reservation and removes output on %s",
  async (mode) => {
    const f = await productionFixture(
      mode === "failure"
        ? { FAIL_BUILD: "1" }
        : mode === "cancel"
          ? { HANG_BUILD: "1" }
          : {},
    );
    temporaryDirectories.push(f.directory);
    if (mode === "readiness" && f.project.server.production !== undefined)
      f.project.server.production.start = "node -e 0";
    await mkdir(join(f.directory, "production-output"));
    await writeFile(join(f.directory, "production-output", "old"), "preserved");
    const listen = vi.spyOn(Server.prototype, "listen");
    let runtime: Awaited<ReturnType<typeof prepareProduction>>;
    let reservation: unknown;
    try {
      runtime = await prepareProduction({
        projectDirectory: f.directory,
        project: f.project,
        dataDirectory: f.dataDirectory,
        commit: "abc",
        dependencies: { teardownTimeoutMs: 50 },
      });
      reservation = listen.mock.contexts[0];
    } finally {
      listen.mockRestore();
    }
    if (!(reservation instanceof Server))
      throw new Error("production did not create a port reservation");
    expect(reservation.address()).toMatchObject({
      port: runtime.project.server.port,
    });
    const execution = runtime.execute();
    const rejected = expect(execution).rejects.toThrow(
      mode === "failure"
        ? /production build failed.*exit 7/s
        : mode === "cancel"
          ? /interrupted/
          : /exited before readiness/,
    );
    if (mode === "cancel") {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await f.audit().catch(() => [])).length) break;
        await new Promise((accept) => setTimeout(accept, 10));
      }
      await runtime.close();
    }
    await rejected;
    await runtime.close();
    // The OS may reassign a released port before a TCP probe runs.
    // Check the owned reservation so another listener cannot mask cleanup.
    expect(reservation.listening).toBe(false);
    expect(reservation.address()).toBeNull();
    expect(
      await readFile(join(f.directory, "production-output", "old"), "utf8"),
    ).toBe("preserved");
    await expect(
      readFile(join(f.directory, "production-output", "BUILD_ID")),
    ).rejects.toThrow();
  },
);

test("production uses a stable full command/commit hash without BUILD_ID", async () => {
  const f = await productionFixture({ WRITE_BUILD_ID: "0" });
  temporaryDirectories.push(f.directory);
  const runtime = await prepareProduction({
    projectDirectory: f.directory,
    project: f.project,
    dataDirectory: f.dataDirectory,
    commit: "abc",
  });
  try {
    expect((await runtime.execute()).id).toBe(
      createHash("sha256")
        .update(`${f.project.server.production?.build}\0abc`)
        .digest("hex"),
    );
  } finally {
    await runtime.close();
  }
});

test("production rejects output symlinks and releases a prepared but unused port", async () => {
  const f = await productionFixture();
  temporaryDirectories.push(f.directory);
  await symlink(f.dataDirectory, join(f.directory, "production-output"));
  await expect(
    prepareProduction({
      projectDirectory: f.directory,
      project: f.project,
      dataDirectory: f.dataDirectory,
      commit: "abc",
    }),
  ).rejects.toThrow(/symlinks/);
  await rm(join(f.directory, "production-output"));
  const runtime = await prepareProduction({
    projectDirectory: f.directory,
    project: f.project,
    dataDirectory: f.dataDirectory,
    commit: "abc",
  });
  await runtime.close();
  expect(await isPortOpen(runtime.project.server.port)).toBe(false);
});

test("production stops a TERM-ignoring server before restoring output", async () => {
  const f = await productionFixture({ IGNORE_TERM: "1" });
  temporaryDirectories.push(f.directory);
  await mkdir(join(f.directory, "production-output"));
  await writeFile(join(f.directory, "production-output", "old"), "preserved");
  const runtime = await prepareProduction({
    projectDirectory: f.directory,
    project: f.project,
    dataDirectory: f.dataDirectory,
    commit: "abc",
    dependencies: { teardownTimeoutMs: 500 },
  });
  await runtime.execute();
  const started = (await f.audit()).find((entry) => entry.phase === "start");
  if (started === undefined) throw new Error("server did not start");
  await runtime.close();
  expect(() => process.kill(started.pid, 0)).toThrow();
  expect(await isPortOpen(runtime.project.server.port)).toBe(false);
  expect(
    await readFile(join(f.directory, "production-output", "old"), "utf8"),
  ).toBe("preserved");
});

test.each([
  "commit",
  "config",
  "environment",
  "dirty",
  "missing-output",
  "missing-id",
  "mismatched-id",
  "malformed",
  "occupied-port",
])(
  "production cache invalidates %s with a real source snapshot",
  async (reason) => {
    const { snapshotSource } = await import("../src/capture/resolve.js");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = promisify(execFile);
    const f = await productionFixture({}, true);
    temporaryDirectories.push(f.directory);
    let source = await snapshotSource(f.directory);
    expect(source.dirty).toBe(false);
    const execute = async (project = f.project) => {
      source = await snapshotSource(f.directory);
      const runtime = await prepareProduction({
        projectDirectory: f.directory,
        project,
        dataDirectory: f.dataDirectory,
        commit: source.commit,
        dirty: source.dirty,
      });
      try {
        await runtime.execute();
        return runtime.timings.build.status;
      } finally {
        await runtime.close();
      }
    };
    expect(await execute()).toBe("measured");
    const base = join(f.directory, ".idiom/cache/production");
    const key = (await readdir(base)).find(
      (name) => name !== ".gitignore",
    ) as string;
    const entry = join(base, key, "entry");
    let project = f.project;
    let occupied: ReturnType<typeof createServer> | undefined;
    try {
      if (reason === "commit")
        await git(
          "git",
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "next",
          ],
          { cwd: f.directory },
        );
      if (reason === "config")
        project = projectSchema.parse({
          ...project,
          server: {
            ...project.server,
            production: {
              ...project.server.production,
              build: `${project.server.production?.build} && node -e 0`,
            },
          },
        });
      if (reason === "environment")
        project = projectSchema.parse({
          ...project,
          server: {
            ...project.server,
            production: {
              ...project.server.production,
              env: {
                ...project.server.production?.env,
                CACHE_INPUT: "changed",
              },
            },
          },
        });
      if (reason === "dirty")
        await writeFile(join(f.directory, "application-change.txt"), "changed");
      if (reason === "missing-output")
        await rm(join(entry, "output"), { recursive: true });
      if (reason === "missing-id") await rm(join(entry, "output/BUILD_ID"));
      if (reason === "mismatched-id")
        await writeFile(join(entry, "output/BUILD_ID"), "other");
      if (reason === "malformed")
        await writeFile(join(entry, "metadata.json"), "{}");
      if (reason === "occupied-port") {
        const metadata = JSON.parse(
          await readFile(join(entry, "metadata.json"), "utf8"),
        );
        occupied = createServer();
        await new Promise<void>((accept) =>
          occupied?.listen(metadata.port, "127.0.0.1", accept),
        );
      }
      expect(await execute(project)).toBe("measured");
      expect(
        (await f.audit()).filter((row) => row.phase === "build"),
      ).toHaveLength(2);
    } finally {
      if (occupied)
        await new Promise<void>((accept) => occupied?.close(() => accept()));
    }
  },
  15_000,
);

test("production cache holds exclusive output ownership and releases on unused runtime cleanup", async () => {
  const f = await productionFixture({}, true);
  temporaryDirectories.push(f.directory);
  const options = {
    projectDirectory: f.directory,
    project: f.project,
    dataDirectory: f.dataDirectory,
    commit: "commit",
    dirty: false,
  };
  const first = await prepareProduction(options);
  try {
    await expect(prepareProduction(options)).rejects.toThrow(
      /owned by another capture; retry/,
    );
  } finally {
    await first.close();
  }
  const next = await prepareProduction(options);
  await next.close();
});

test.each(["FAIL_BUILD", "HANG_BUILD", "BAD_READY"])(
  "production cache never promotes failed or cancelled %s work",
  async (mode) => {
    const f = await productionFixture(
      mode === "BAD_READY" ? { FAIL_READY: "1" } : { [mode]: "1" },
      true,
    );
    temporaryDirectories.push(f.directory);
    if (mode === "BAD_READY") f.project.server.startupTimeoutMs = 100;
    const controller = new AbortController();
    const options = {
      projectDirectory: f.directory,
      project: f.project,
      dataDirectory: f.dataDirectory,
      commit: "commit",
      dirty: false,
      signal: controller.signal,
      dependencies: { teardownTimeoutMs: 50 },
    };
    const runtime = await prepareProduction(options);
    const timer =
      mode === "HANG_BUILD"
        ? setTimeout(() => controller.abort(), 200)
        : undefined;
    try {
      await expect(runtime.execute()).rejects.toThrow();
    } finally {
      clearTimeout(timer);
      await runtime.close();
    }
    const base = join(f.directory, ".idiom/cache/production");
    const key = (await readdir(base)).find(
      (name) => name !== ".gitignore",
    ) as string;
    expect(await readdir(join(base, key))).toEqual([]);
    const next = await prepareProduction(optionsWithoutSignal());
    await next.close();
    function optionsWithoutSignal() {
      return { ...options, signal: new AbortController().signal };
    }
  },
  15_000,
);

test("production cache reuses fallback build IDs and measures build/start independently", async () => {
  const f = await productionFixture({ WRITE_BUILD_ID: "0" }, true);
  temporaryDirectories.push(f.directory);
  let tick = 0;
  const options = {
    projectDirectory: f.directory,
    project: f.project,
    dataDirectory: f.dataDirectory,
    commit: "commit",
    dirty: false,
    dependencies: {
      monotonicNow: () => {
        tick += 10;
        return tick;
      },
    },
  };
  const first = await prepareProduction(options);
  let identity: Awaited<ReturnType<typeof first.execute>>;
  try {
    identity = await first.execute();
    expect(first.timings).toEqual({
      build: { status: "measured", ms: 10 },
      start: { status: "measured", ms: 10 },
    });
  } finally {
    await first.close();
  }
  const second = await prepareProduction(options);
  try {
    expect(await second.execute()).toEqual(identity);
    expect(second.timings).toEqual({
      build: { status: "reused", ms: 0 },
      start: { status: "measured", ms: 10 },
    });
  } finally {
    await second.close();
  }
  expect((await f.audit()).filter((row) => row.phase === "build")).toHaveLength(
    1,
  );
});

test("production cache rejects a symlinked managed directory before touching output", async () => {
  const f = await productionFixture({}, true);
  temporaryDirectories.push(f.directory);
  await mkdir(join(f.directory, ".idiom/cache"), { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), "idiom-outside-cache-"));
  temporaryDirectories.push(outside);
  await symlink(outside, join(f.directory, ".idiom/cache/production"));
  await expect(
    prepareProduction({
      projectDirectory: f.directory,
      project: f.project,
      dataDirectory: f.dataDirectory,
      commit: "commit",
      dirty: false,
    }),
  ).rejects.toThrow(/symlinks/);
  expect(await readdir(outside)).toEqual([]);
});

test.each(["setup", "build"])(
  "development %s cancellation stops the owned process tree",
  async (phase) => {
    const f = await productionFixture();
    const controller = new AbortController();
    const command = `node '${join(import.meta.dirname, "fixtures", "probe-timeouts", "server.mjs")}'`;
    const environment = { ...process.env, PORT: String(f.project.server.port) };
    const pending =
      phase === "setup"
        ? runSetupSteps({
            projectDirectory: f.directory,
            flow: flowSchema.parse({ ...f.flow, setup: [{ run: command }] }),
            dataDirectory: f.dataDirectory,
            inheritedEnvironment: environment,
            signal: controller.signal,
            dependencies: { teardownTimeoutMs: 100 },
          })
        : runServerBuild({
            projectDirectory: f.directory,
            project: {
              ...f.project,
              server: { ...f.project.server, build: command },
            },
            port: f.project.server.port,
            dataDirectory: f.dataDirectory,
            inheritedEnvironment: environment,
            signal: controller.signal,
            dependencies: { teardownTimeoutMs: 100 },
          });
    const assertion = expect(pending).rejects.toThrow("capture test cancelled");
    try {
      await vi.waitFor(
        async () => expect(await isPortOpen(f.project.server.port)).toBe(true),
        { timeout: 3000 },
      );
      controller.abort(new Error("capture test cancelled"));
      await assertion;
      expect(await isPortOpen(f.project.server.port)).toBe(false);
    } finally {
      controller.abort(new Error("capture test cancelled"));
      await pending.catch(() => undefined);
      await rm(f.directory, { recursive: true, force: true });
    }
  },
  6000,
);
