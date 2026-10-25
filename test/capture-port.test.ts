import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { runCapture } from "../src/capture/run.js";
import { runDeterministicChecks } from "../src/checks/registry.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const serverScript = join(
  import.meta.dirname,
  "fixtures",
  "port-capture",
  "server.mjs",
);

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

async function squat(port: number): Promise<HttpServer> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>x</title><p>FOREIGN</p>");
  });
  await new Promise<void>((accept) => server.listen(port, "127.0.0.1", accept));
  return server;
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((accept) => server.close(() => accept()));
}

function portProject(port: number, marker: string, fixedPort = false) {
  return projectSchema.parse({
    version: 1,
    app: { name: "port", framework: "other" },
    server: {
      build: "node -e 0",
      start: `node ${JSON.stringify(serverScript)}`,
      readyUrl: `http://127.0.0.1:${port}/`,
      port,
      ...(fixedPort ? { fixedPort: true } : {}),
      env: { MARKER: marker },
      startupTimeoutMs: 10_000,
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: { settleMs: 0 },
    checks: { probe: { enabled: false } },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
}

function portFlow(marker: string) {
  return flowSchema.parse({
    id: "port",
    title: "Port",
    intent: [],
    setup: [],
    states: [
      {
        id: "home",
        description: "Home",
        url: "/",
        expect: { status: 200, textPresent: [`${marker} on`] },
      },
      {
        id: "missing",
        description: "Missing",
        url: "/missing",
        expect: { status: 404, textPresent: [`${marker} missing`] },
      },
    ],
  });
}

async function capture(options: {
  directory: string;
  project: ReturnType<typeof portProject>;
  marker: string;
  port?: number;
  environment?: NodeJS.ProcessEnv;
}) {
  return await runCapture({
    projectDirectory: options.directory,
    project: options.project,
    flow: portFlow(options.marker),
    out: join(options.directory, "run"),
    ...(options.port === undefined ? {} : { port: options.port }),
    dependencies: {
      browserLauncher: createBrowserLauncher({
        launch: () => chromium.launch({ headless: true }),
        createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
      }),
      inheritedEnvironment: { PATH: process.env.PATH, ...options.environment },
      snapshotSource: async () => ({ commit: "abc123", dirty: false }),
    },
  });
}

async function tupleFiles(runDirectory: string, state: string) {
  const path = join(runDirectory, state, "desktop");
  return {
    metadata: JSON.parse(await readFile(join(path, "metadata.json"), "utf8")),
    dom: await readFile(join(path, "dom.html"), "utf8"),
    console: await readFile(join(path, "console.jsonl"), "utf8"),
  };
}

async function withDirectories<T>(
  count: number,
  run: (directories: string[]) => Promise<T>,
): Promise<T> {
  const directories = await Promise.all(
    Array.from({ length: count }, () =>
      mkdtemp(join(tmpdir(), "idiom-port-capture-")),
    ),
  );
  try {
    return await run(directories);
  } finally {
    await Promise.all(
      directories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  }
}

test("two concurrent worktree captures each serve and capture their own server", async () => {
  const configured = await freePort();
  const configuredOrigin = `http://127.0.0.1:${configured}`;
  await withDirectories(2, async ([first, second]) => {
    if (first === undefined || second === undefined) throw new Error("dirs");
    const results = await Promise.all([
      capture({
        directory: first,
        project: portProject(configured, "WORKTREE-A"),
        marker: "WORKTREE-A",
      }),
      capture({
        directory: second,
        project: portProject(configured, "WORKTREE-B"),
        marker: "WORKTREE-B",
      }),
    ]);
    for (const result of results)
      expect(result.counts).toEqual({ passed: 2, failed: 0, total: 2 });
    const a = await tupleFiles(join(first, "run"), "home");
    const b = await tupleFiles(join(second, "run"), "home");
    const portA = new URL(a.metadata.url.origin).port;
    const portB = new URL(b.metadata.url.origin).port;
    expect(portA).not.toBe(portB);
    expect([portA, portB]).not.toContain(String(configured));
    expect(a.metadata.url.canonicalOrigin).toBe(configuredOrigin);
    expect(b.metadata.url.canonicalOrigin).toBe(configuredOrigin);
    // Each run captured its own server: the page printed its own marker and
    // the port it bound.
    expect(a.dom).toContain(`WORKTREE-A on ${portA}`);
    expect(a.dom).not.toContain("WORKTREE-B");
    expect(b.dom).toContain(`WORKTREE-B on ${portB}`);
    expect(b.dom).not.toContain("WORKTREE-A");
    // Console evidence is stated in the configured origin so finding
    // identity does not change with the per-run port.
    for (const [files, port] of [
      [a, portA],
      [b, portB],
    ] as const) {
      const records = files.console
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const failure = records.find(
        (record: { text: string }) =>
          typeof record.text === "string" &&
          record.text.startsWith("failure at"),
      );
      expect(failure?.text).toBe(`failure at ${configuredOrigin}/`);
      expect(failure?.location?.url).toBe(`${configuredOrigin}/`);
      expect(files.console).not.toContain(`127.0.0.1:${port}`);
    }
  });
});

test("an expected 404 on a dynamic port still suppresses its own document-load error", async () => {
  const configured = await freePort();
  const configuredOrigin = `http://127.0.0.1:${configured}`;
  await withDirectories(1, async ([directory]) => {
    if (directory === undefined) throw new Error("dir");
    const result = await capture({
      directory,
      project: portProject(configured, "SOLO"),
      marker: "SOLO",
    });
    expect(result.counts.failed).toBe(0);
    const missing = await tupleFiles(result.runDirectory, "missing");
    expect(missing.metadata.url.origin).not.toBe(configuredOrigin);
    expect(missing.metadata.url.canonicalOrigin).toBe(configuredOrigin);
    expect(missing.console).toContain(
      "the server responded with a status of 404",
    );
    expect(missing.console).toContain(`${configuredOrigin}/missing`);
    const loaded = await loadCaptureRun({
      runDirectory: result.runDirectory,
      expectedFlow: "port",
      expectedStatusByState: new Map([["missing", 404]]),
    });
    const consoleErrors = runDeterministicChecks(loaded.tuples)
      .candidates.filter(
        ({ candidate }) => candidate.category === "console-error",
      )
      .map(({ tuple, candidate }) => ({
        state: tuple.state,
        hint: candidate.selectorHint,
      }));
    // Only the fixture's own console.error remains, on each state; the
    // browser's expected 404 resource error is suppressed.
    expect(consoleErrors).toHaveLength(2);
    for (const error of consoleErrors) {
      expect(error.hint).toContain("failure at");
      expect(error.hint).not.toContain("status of 404");
    }
  });
});

test("a foreign server on the configured port is never captured", async () => {
  const configured = await freePort();
  const foreign = await squat(configured);
  try {
    await withDirectories(1, async ([directory]) => {
      if (directory === undefined) throw new Error("dir");
      const result = await capture({
        directory,
        project: portProject(configured, "OWN"),
        marker: "OWN",
      });
      expect(result.counts).toEqual({ passed: 2, failed: 0, total: 2 });
      const home = await tupleFiles(result.runDirectory, "home");
      expect(home.dom).toContain("OWN on");
      expect(home.dom).not.toContain("FOREIGN");
    });
  } finally {
    await closeServer(foreign);
  }
});

test.each([
  { name: "fixedPort", fixedPort: true, idiomPort: false },
  { name: "IDIOM_PORT", fixedPort: false, idiomPort: true },
])(
  "a pinned port that already answers is refused ($name)",
  async ({ fixedPort, idiomPort }) => {
    const configured = await freePort();
    const squatted = idiomPort ? await freePort() : configured;
    const foreign = await squat(squatted);
    try {
      await withDirectories(1, async ([directory]) => {
        if (directory === undefined) throw new Error("dir");
        await expect(
          capture({
            directory,
            project: portProject(configured, "OWN", fixedPort),
            marker: "OWN",
            ...(idiomPort
              ? { environment: { IDIOM_PORT: String(squatted) } }
              : {}),
          }),
        ).rejects.toThrow(
          `http://127.0.0.1:${squatted}/ already answers — port ${squatted} in use by another process`,
        );
        // Nothing was captured or published.
        await expect(
          readFile(join(directory, "run", "baseline.md")),
        ).rejects.toThrow();
      });
    } finally {
      await closeServer(foreign);
    }
  },
);

test("--port is honoured", async () => {
  const configured = await freePort();
  const requested = await freePort();
  await withDirectories(1, async ([directory]) => {
    if (directory === undefined) throw new Error("dir");
    const result = await capture({
      directory,
      project: portProject(configured, "PINNED"),
      marker: "PINNED",
      port: requested,
    });
    expect(result.counts.failed).toBe(0);
    const home = await tupleFiles(result.runDirectory, "home");
    expect(home.metadata.url.origin).toBe(`http://127.0.0.1:${requested}`);
    expect(home.dom).toContain(`PINNED on ${requested}`);
  });
});
