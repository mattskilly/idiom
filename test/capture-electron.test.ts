import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { PNG } from "pngjs";
import { afterAll, expect, test } from "vitest";
import {
  createElectronLauncher,
  type ElectronRuntime,
  selectElectronWindow,
} from "../src/capture/electron.js";
import { expectedStatusByState } from "../src/capture/resolve.js";
import { runCapture } from "../src/capture/run.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { flowSchema, isElectronFlow } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const dataDirectoryPlaceholder = "$" + "{dataDir}";
const fixtureDirectory = join(
  import.meta.dirname,
  "fixtures",
  "electron-capture",
);
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("expands Electron launch values before calling Playwright", async () => {
  let received: Parameters<ElectronRuntime["launch"]>[0] | undefined;
  const launcher = createElectronLauncher({
    launch: async (options) => {
      received = options;
      throw new Error("launch sentinel");
    },
  });
  const flow = flowSchema.parse({
    id: "desktop",
    title: "Desktop",
    intent: [],
    setup: [],
    target: {
      kind: "electron",
      launch: {
        executablePath: "bin/electron",
        args: [
          "main.cjs",
          `--profile=${dataDirectoryPlaceholder}/profile`,
          `${dataDirectoryPlaceholder}:${dataDirectoryPlaceholder}`,
        ],
        cwd: `${dataDirectoryPlaceholder}/cwd`,
        env: {
          FIXTURE_PATH: `${dataDirectoryPlaceholder}/fixture.json`,
        },
      },
      window: { title: "Capture" },
    },
    states: [{ id: "ready", description: "Ready", expect: {} }],
  });
  if (!isElectronFlow(flow)) throw new Error("expected Electron flow");
  const dataDirectory = "/private/capture-data";
  const session = await launcher({
    projectDirectory: "/project",
    flow,
    dataDirectory,
    inheritedEnvironment: { DEFINED: "yes", UNDEFINED: undefined },
  });
  const project = projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "unused",
      start: "unused",
      readyUrl: "http://127.0.0.1:9/",
      port: 9,
      env: {},
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: {},
    design: {},
    model: { provider: "claude-code", model: "test" },
  });
  const captured = await session.capture({
    project,
    state: flow.states[0] as (typeof flow.states)[number],
    viewport: project.viewports[0] as (typeof project.viewports)[number],
  });
  expect(captured.result).toMatchObject({ ok: false, stage: "launch" });
  expect(received).toMatchObject({
    executablePath: "/project/bin/electron",
    cwd: "/private/capture-data/cwd",
    args: [
      "--force-device-scale-factor=2",
      "main.cjs",
      "--profile=/private/capture-data/profile",
      "/private/capture-data:/private/capture-data",
    ],
    env: {
      DEFINED: "yes",
      FIXTURE_PATH: "/private/capture-data/fixture.json",
    },
  });
  expect(received?.env).not.toHaveProperty("UNDEFINED");
  expect(session.effectiveEnvironment).toEqual(received?.env);
});

test("arms the Electron window waiter before inspecting loaded titles", async () => {
  let waiterArmed = false;
  let windowAnnounced = false;
  let announceWindow: ((page: Page) => void) | undefined;
  const captureWindow = {
    title: async () => "Capture",
  } as unknown as Page;
  const windows: Page[] = [];
  const auxiliaryWindow = {
    title: async () => {
      expect(waiterArmed).toBe(true);
      if (!windowAnnounced) {
        windowAnnounced = true;
        windows.push(captureWindow);
        announceWindow?.(captureWindow);
      }
      return "Auxiliary";
    },
  } as unknown as Page;
  windows.push(auxiliaryWindow);
  const application = {
    windows: () => [...windows],
    waitForEvent: (_event: "window", options: { signal?: AbortSignal }) =>
      new Promise<Page>((resolve, reject) => {
        waiterArmed = true;
        announceWindow = resolve;
        options.signal?.addEventListener("abort", () =>
          reject(new Error("window wait aborted")),
        );
      }),
  } as unknown as ElectronApplication;

  await expect(
    selectElectronWindow(application, "Capture", 1_000),
  ).resolves.toBe(captureWindow);
});

test("records init-script target closure as a typed window failure", async () => {
  let launches = 0;
  let closes = 0;
  let selectedWindow = false;
  const page = {
    title: async () => {
      selectedWindow = true;
      return "Capture";
    },
  } as unknown as Page;
  const launcher = createElectronLauncher({
    launch: async () => {
      launches += 1;
      return {
        evaluate: async () => ({ electron: "test", chromium: "test" }),
        windows: () => [page],
        waitForEvent: (_event: "window", options: { signal?: AbortSignal }) =>
          new Promise<Page>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () =>
              reject(new Error("window wait aborted")),
            );
          }),
        context: () => ({
          addInitScript: async () => {
            expect(selectedWindow).toBe(true);
            throw new Error("Target page, context or browser has been closed");
          },
        }),
        close: async () => {
          closes += 1;
        },
      } as unknown as ElectronApplication;
    },
  });
  const flow = flowSchema.parse({
    id: "desktop",
    title: "Desktop",
    intent: [],
    setup: [],
    target: {
      kind: "electron",
      launch: { executablePath: "electron" },
      window: { title: "Capture" },
    },
    states: [{ id: "ready", description: "Ready", expect: {} }],
  });
  if (!isElectronFlow(flow)) throw new Error("expected Electron flow");
  const project = projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "unused",
      start: "unused",
      readyUrl: "http://127.0.0.1:9/",
      port: 9,
      env: {},
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: { colorSchemeAttribute: "data-theme" },
    design: {},
    model: { provider: "claude-code", model: "test" },
  });
  const session = await launcher({
    projectDirectory: "/project",
    flow,
    dataDirectory: "/private/capture-data",
    inheritedEnvironment: {},
  });
  const tuple = {
    project,
    state: flow.states[0] as (typeof flow.states)[number],
    viewport: project.viewports[0] as (typeof project.viewports)[number],
  };

  for (let index = 0; index < 2; index += 1) {
    const captured = await session.capture(tuple);
    expect(captured.result).toMatchObject({
      ok: false,
      stage: "window",
      message: "Target page, context or browser has been closed",
    });
  }
  expect(launches).toBe(2);
  expect(closes).toBe(2);
});

async function artifactTree(
  directory: string,
): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const key = relative(directory, path);
        const contents = await readFile(path);
        if (entry.name === "run.json") {
          const artifact = JSON.parse(contents.toString("utf8"));
          artifact.timings.build.ms = 0;
          artifact.timings.start.ms = 0;
          artifact.timings.probe.ms = 0;
          for (const tuple of artifact.timings.tuples) {
            tuple.total.ms = 0;
            tuple.probe.ms = 0;
          }
          tree[key] = JSON.stringify(artifact);
        } else if (entry.name === "observations.json") {
          // Elapsed evidence is recorded, but does not change semantic capture parity.
          const withoutElapsed = (value: unknown): unknown =>
            Array.isArray(value)
              ? value.map(withoutElapsed)
              : value && typeof value === "object"
                ? Object.fromEntries(
                    Object.entries(value).map(([key, value]) => [
                      key,
                      key === "elapsedMs" && typeof value === "number"
                        ? 0
                        : withoutElapsed(value),
                    ]),
                  )
                : value;
          tree[key] = JSON.stringify(
            withoutElapsed(JSON.parse(contents.toString("utf8"))),
          );
        } else if (
          entry.name === "metadata.json" ||
          entry.name === "axe.json"
        ) {
          const artifact = JSON.parse(contents.toString("utf8"));
          if (entry.name === "metadata.json") {
            artifact.timestamps = {
              startedAt: "<time>",
              endedAt: "<time>",
            };
          } else artifact.timestamp = "<time>";
          tree[key] = JSON.stringify(artifact);
        } else tree[key] = contents.toString("base64");
      }
    }
  };
  await visit(directory);
  return tree;
}

test("captures a deterministic Electron fixture with full artifact parity", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "idiom-electron-test-"));
  temporaryDirectories.push(temporary);
  const project = projectSchema.parse({
    version: 1,
    app: { name: "Electron fixture", framework: "other" },
    server: {
      build: "must-not-run-build",
      start: "must-not-run-server",
      readyUrl: "http://127.0.0.1:9/ready",
      port: 9,
      env: {},
      startupTimeoutMs: 10,
    },
    viewports: [
      { name: "compact", width: 420, height: 520 },
      { name: "wide", width: 800, height: 600 },
    ],
    colorSchemes: ["dark"],
    capture: {
      timezoneId: "America/New_York",
      locale: "en-US",
      colorScheme: "dark",
      colorSchemeAttribute: "data-theme",
      reducedMotion: true,
      fullPage: false,
      settleMs: 60,
    },
    design: {},
    checks: {
      touchReachability: {},
      liveness: { selectors: ["#absent-live-target"], auto: false },
      collections: [{ selector: "#absent-collection" }],
      bandEdges: {},
      wordBreak: {},
    },
    model: { provider: "claude-code", model: "test", maxFindings: 5 },
  });
  const flow = flowSchema.parse({
    id: "desktop",
    shell: "body",
    invariants: [
      { name: "content", selector: "#content", width: { min: 100, max: 800 } },
    ],
    target: {
      kind: "electron",
      launch: {
        executablePath: electronPath,
        args: [
          "main.cjs",
          `--user-data-dir=${dataDirectoryPlaceholder}/profile`,
        ],
        cwd: ".",
        env: {
          FIXTURE_PATH: `${dataDirectoryPlaceholder}/fixture.json`,
        },
        timeoutMs: 20_000,
      },
      window: { title: "Electron Capture Fixture", timeoutMs: 10_000 },
    },
    title: "Desktop fixture",
    intent: ["Composer and settings remain usable."],
    setup: [
      {
        run: "node setup.mjs",
        env: {
          FIXTURE_PATH: `${dataDirectoryPlaceholder}/fixture.json`,
        },
      },
    ],
    states: [
      {
        id: "composer",
        description: "Composer",
        invariants: [{ selector: "#saved", height: { min: 1, max: 100 } }],
        steps: [
          { action: "fill", selector: "#message", value: "Hello" },
          { action: "press", selector: "#message", key: "Enter" },
        ],
        expect: {
          textPresent: [
            "New availability for Ada",
            "Saved Hello",
            "Boot theme\nnull",
            "Live theme\ndark",
            "Live reduced motion\ntrue",
          ],
          selectorPresent: ["#saved"],
        },
      },
      {
        id: "settings",
        description: "Settings",
        steps: [{ action: "click", selector: "#settings-tab" }],
        expect: {
          textPresent: ["Settings", "Account: Ada", "Live theme\ndark"],
          selectorPresent: ["#reminders"],
          selectorAbsent: ["#message"],
        },
      },
    ],
  });
  const common = {
    projectDirectory: fixtureDirectory,
    project,
    flow,
    dependencies: {
      snapshotSource: async () => ({ commit: "fixture", dirty: false }),
    },
  };
  const first = await runCapture({
    ...common,
    out: join(temporary, "first"),
  });
  const second = await runCapture({
    ...common,
    out: join(temporary, "second"),
  });
  const axeFailure = await runCapture({
    ...common,
    out: join(temporary, "axe-failure"),
    tuples: [{ state: "composer", viewport: "compact" }],
    dependencies: {
      ...common.dependencies,
      electronLauncher: createElectronLauncher({
        createAxe: () => ({
          analyze: async () => {
            throw new Error("axe sentinel");
          },
        }),
      }),
    },
  });

  const firstFailures = (
    await Promise.all(
      flow.states.flatMap((state) =>
        project.viewports.map(async (viewport) => {
          const metadata = JSON.parse(
            await readFile(
              join(
                first.runDirectory,
                state.id,
                viewport.name,
                "metadata.json",
              ),
              "utf8",
            ),
          );
          return {
            tuple: `${state.id}/${viewport.name}`,
            failure: metadata.failure,
            mismatches: metadata.expectations.mismatches,
          };
        }),
      ),
    )
  ).filter((tuple) => tuple.failure !== null || tuple.mismatches.length > 0);
  expect(first.counts, JSON.stringify(firstFailures)).toEqual({
    passed: 4,
    failed: 0,
    total: 4,
  });
  expect(second.counts).toEqual(first.counts);
  expect(axeFailure.counts).toEqual({ passed: 0, failed: 1, total: 1 });
  expect(
    JSON.parse(
      await readFile(
        join(axeFailure.runDirectory, "composer", "compact", "metadata.json"),
        "utf8",
      ),
    ).failure,
  ).toEqual({ stage: "axe", message: "axe sentinel" });
  const firstTree = await artifactTree(first.runDirectory);
  const secondTree = await artifactTree(second.runDirectory);
  expect(Object.keys(secondTree)).toEqual(Object.keys(firstTree));
  expect(
    Object.keys(secondTree).filter((key) => secondTree[key] !== firstTree[key]),
  ).toEqual([]);

  const loaded = await loadCaptureRun({
    runDirectory: first.runDirectory,
    expectedFlow: flow.id,
    expectedStatusByState: expectedStatusByState(flow),
    stateOrder: flow.states.map((state) => state.id),
    viewportOrder: project.viewports.map((viewport) => viewport.name),
    colorSchemeOrder: project.colorSchemes,
    legacyColorScheme: project.capture.colorScheme,
  });
  expect(loaded.tuples).toHaveLength(4);
  for (const tuple of loaded.tuples) {
    expect(tuple.failure).toBeUndefined();
    expect(tuple.documentResponse).toBeUndefined();
    expect(tuple.axe).toBeDefined();
    expect(tuple.observations).toBeDefined();
    if (tuple.observations?.version !== 2)
      throw new Error("expected v2 observations");
    expect(tuple.observations.bandEdges?.status).toBe("ran");
    expect(tuple.observations.wordBreaks?.status).toBe("ran");
    expect(tuple.observations.shellVisibility?.shell).toMatchObject({
      status: "measured",
      selector: "body",
    });
    // Opt-in diagnostics are forwarded; desktop input never diagnoses touch.
    expect(tuple.observations.touchReachability).toMatchObject({
      status: "ran",
      entries: [],
    });
    expect(tuple.observations.liveness?.diagnostics).toEqual([
      "declared #absent-live-target: no matches",
    ]);
    expect(tuple.observations.mediaFrames).toEqual([]);
    expect(tuple.observations.collections).toEqual([
      { selector: "#absent-collection", matched: 0, items: [] },
    ]);
    expect(tuple.observations.invariants?.[0]?.declaration.name).toBe(
      "content",
    );
    if (tuple.state === "composer") {
      expect(tuple.observations.invariants).toHaveLength(2);
      expect(
        tuple.observations.invariants?.[1]?.selectors[0]?.matches,
      ).toMatchObject([
        { selector: "#saved", rect: { height: expect.any(Number) } },
      ]);
      expect(
        tuple.observations.invariants?.[1]?.selectors[0]?.matches[0]?.rect
          .height,
      ).toBeGreaterThan(0);
    } else {
      expect(tuple.observations.invariants).toHaveLength(1);
    }
    expect(tuple.artifactPaths).toHaveLength(6);
    expect(
      tuple.console.filter(
        (record) => record.text === "selected duplicate diagnostic",
      ),
    ).toHaveLength(2);
    expect(
      tuple.console.filter((record) =>
        record.text.includes("selected duplicate exception"),
      ),
    ).toHaveLength(2);
    expect(
      tuple.console.some((record) => record.text.includes("auxiliary")),
    ).toBe(false);
    const metadata = JSON.parse(
      await readFile(join(first.runDirectory, tuple.metadataPath), "utf8"),
    );
    expect(metadata.status).toBeNull();
    expect(metadata.url).toBeUndefined();
    expect(metadata.accessibility).toEqual({
      engine: "axe",
      mode: "legacy",
      crossOriginFrames: false,
    });
    expect(metadata.browserVersion).toMatch(/^Electron \S+ \/ Chromium \S+$/);
    expect(JSON.stringify(metadata)).not.toContain("FIXTURE_PATH");
    expect(JSON.stringify(metadata)).not.toContain("idiom-capture-data-");
    const screenshot = PNG.sync.read(
      await readFile(join(first.runDirectory, tuple.screenshotPath as string)),
    );
    expect(screenshot.width).toBe(tuple.width * 2);
    expect(screenshot.height).toBe(tuple.height * 2);
  }
}, 120_000);

test.each([0, 1000])(
  "Electron launcher threads animationSettleMs=%i to shared evidence",
  async (bound) => {
    const flow = flowSchema.parse({
      id: "f",
      title: "f",
      intent: [],
      setup: [],
      target: {
        kind: "electron",
        launch: {
          executablePath: electronPath,
          args: ["electron.cjs"],
          cwd: join(import.meta.dirname, "fixtures/painted-visibility"),
        },
        window: { title: "Painted entrance" },
      },
      states: [{ id: "entrance", description: "entrance", expect: {} }],
    });
    if (!isElectronFlow(flow)) throw new Error("missing electron flow");
    const project = projectSchema.parse({
      version: 1,
      app: { name: "test", framework: "other" },
      server: {
        build: "unused",
        start: "unused",
        readyUrl: "http://127.0.0.1:3000",
        port: 3000,
        env: {},
      },
      capture: { settleMs: 0, reducedMotion: false, animationSettleMs: bound },
      design: {},
      model: { provider: "claude-code", model: "test" },
    });
    const session = await createElectronLauncher({
      createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    })({
      projectDirectory: import.meta.dirname,
      flow,
      dataDirectory: import.meta.dirname,
      inheritedEnvironment: process.env,
    });
    const state = flow.states[0];
    const viewport = project.viewports[0];
    if (!state || !viewport) throw new Error("missing tuple");
    try {
      const { result } = await session.capture({ project, state, viewport });
      expect(result.ok).toBe(true);
      expect(
        result.observations?.elements.find((e) => e.selector === "#entrance")
          ?.painted?.value,
      ).toBe(bound > 0);
    } finally {
      await session.close();
    }
  },
);
