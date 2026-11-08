import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCapture } from "../src/capture/run.js";
import { attemptTimeouts } from "../src/capture/timeouts.js";
import type { BrowserTuple, TupleResult } from "../src/capture/types.js";
import { missingStateCheck } from "../src/checks/missing-state.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { productionFixture } from "./production-support.js";

function result(
  tuple: BrowserTuple,
  kind: "pass" | "timeout" | "error",
): TupleResult {
  const common = {
    startedAt: "2026-11-06T00:00:00Z",
    endedAt: "2026-11-06T00:00:00Z",
    console: [],
    mismatches: [],
  };
  if (kind === "pass")
    return {
      ...common,
      ok: true,
      status: 200,
      dom: "<body>ready</body>",
      screenshot: Buffer.from(""),
      axe: { violations: [] },
    };
  return {
    ...common,
    ok: false,
    stage: "navigation",
    message: kind === "timeout" ? "navigation expired" : "plain timeout text",
    ...(kind === "timeout"
      ? {
          timeout: {
            kind: "navigation",
            timeoutMs: attemptTimeouts(tuple).navigation,
          } as const,
        }
      : {}),
  };
}
test.each([true, false])(
  "retry waits for the first-attempt barrier, replaces evidence, keeps ordering (planning %s)",
  async (planProbes) => {
    const f = await productionFixture();
    try {
      const calls: string[] = [];
      const run = await runCapture({
        projectDirectory: f.directory,
        project: projectSchema.parse({
          ...f.project,
          checks: { probe: { enabled: false } },
          viewports: [
            { name: "desktop", width: 800, height: 600 },
            { name: "mobile", width: 390, height: 700 },
          ],
        }),
        flow: flowSchema.parse({
          ...f.flow,
          states: ["a", "b"].map((id) => ({
            id,
            description: id,
            url: "/",
            expect: {},
          })),
        }),
        dependencies: {
          readHost: () => ({ load: [64, 0, 0], coreCount: 11 }),
          measureReadyUrl: async () => 1,
          browserLauncher: async () => ({
            version: "test",
            planProbes,
            close: async () => {},
            capture: async (tuple) => {
              const factor = tuple.timeoutFactor ?? 1;
              calls.push(`${tuple.state.id}/${tuple.viewport.name}/${factor}`);
              expect(attemptTimeouts(tuple)).toEqual({
                navigation: 30000 * factor,
                readiness: 10000 * factor,
                quiet: 5000 * factor,
              });
              return result(
                tuple,
                tuple.state.id === "a" && factor === 1 ? "timeout" : "pass",
              );
            },
          }),
        },
      });
      expect(calls.slice(0, 4).every((call) => call.endsWith("/1"))).toBe(true);
      expect(calls.slice(4).every((call) => call.endsWith("/2"))).toBe(true);
      expect(run.counts).toEqual({ total: 4, passed: 4, failed: 0 });
      expect(run.scope?.retries?.map((retry) => retry.outcome)).toEqual([
        "passed",
        "passed",
      ]);
      expect(run.scope?.deferredTuples).toEqual([]);
      expect(run.scope?.selected.map((tuple) => tuple.state)).toEqual([
        "a",
        "a",
        "b",
        "b",
      ]);
      expect(await readFile(run.reportPath, "utf8")).toContain("Retry a/");
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
test.each([
  [64, "timeout", true],
  [0, "timeout", false],
  [64, "error", false],
] as const)(
  "only exhausted typed timeouts defer (load %s, final %s)",
  async (load, final, deferred) => {
    const f = await productionFixture();
    try {
      let attempts = 0;
      const run = await runCapture({
        projectDirectory: f.directory,
        project: f.project,
        flow: flowSchema.parse({
          ...f.flow,
          states: [{ id: "home", description: "Home", url: "/", expect: {} }],
        }),
        dependencies: {
          readHost: () => ({ load: [load, 0, 0], coreCount: 11 }),
          measureReadyUrl: async () => 1,
          browserLauncher: async () => ({
            version: "test",
            close: async () => {},
            capture: async (tuple) => {
              attempts++;
              return result(tuple, attempts === 1 ? "timeout" : final);
            },
          }),
        },
      });
      expect(attempts).toBe(2);
      expect(run.scope?.deferredTuples).toHaveLength(deferred ? 1 : 0);
      const loaded = await loadCaptureRun({
        runDirectory: run.runDirectory,
        expectedFlow: f.flow.id,
      });
      expect(loaded.tuples[0]?.failure?.hostDeferred === true).toBe(deferred);
      const checked = await missingStateCheck.run({
        tuple: loaded.tuples[0],
      } as Parameters<typeof missingStateCheck.run>[0]);
      expect(checked.candidates).toHaveLength(deferred ? 0 : 1);
      expect(loaded.tuples[0]?.failure).toBeDefined();
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test("real navigation and readiness timeouts recover after other tuples, with double deadlines", async () => {
  const { createBrowserLauncher } = await import("../src/capture/browser.js");
  const { fixtureCommand } = await import("./support/fixture-server.js");
  const { join } = await import("node:path");
  const f = await productionFixture();
  try {
    const project = projectSchema.parse({
      ...f.project,
      capture: { ...f.project.capture, concurrency: 1 },
      server: {
        ...f.project.server,
        fixedPort: true,
        readyUrl: `http://127.0.0.1:${f.project.server.port}/ready`,
        start: fixtureCommand(
          join(import.meta.dirname, "fixtures/host-pressure/server.mjs"),
        ),
      },
      // Retry deadlines are measured apart from the independent loading window.
      checks: {
        probe: { enabled: false },
        links: { enabled: false },
        loadingStuck: { enabled: false },
      },
    });
    const calls: Array<{
      state: string;
      navigation: number;
      readiness: number;
    }> = [];
    const launcher = createBrowserLauncher({
      createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    });
    const run = await runCapture({
      projectDirectory: f.directory,
      project,
      flow: flowSchema.parse({
        ...f.flow,
        states: [
          { id: "stall", description: "Navigation", url: "/stall", expect: {} },
          {
            id: "wait",
            description: "Readiness",
            url: "/wait",
            steps: [{ action: "expectText", text: "Ready" }],
            expect: {},
          },
          { id: "other", description: "Other", url: "/other", expect: {} },
          {
            id: "tall",
            description: "Tall",
            url: "/tall",
            screenshotTimeoutMs: 30000,
            expect: {},
          },
        ],
      }),
      dependencies: {
        readHost: () => ({ load: [0, 0, 0], coreCount: 11 }),
        attemptTimeouts: { navigation: 500, readiness: 500 },
        browserLauncher: async (options) => {
          const browser = await launcher(options);
          return {
            ...browser,
            capture: async (tuple) => {
              calls.push({ state: tuple.state.id, ...attemptTimeouts(tuple) });
              return browser.capture(tuple);
            },
          };
        },
      },
    });
    expect(calls.map((call) => call.state)).toEqual([
      "stall",
      "wait",
      "other",
      "tall",
      "stall",
      "wait",
    ]);
    expect(calls[4]?.navigation).toBe(1000);
    expect(calls[5]?.readiness).toBe(1000);
    expect(run.counts.failed).toBe(0);
    expect(
      run.scope?.retries?.map((retry) => [
        retry.firstTimeout.kind,
        retry.outcome,
      ]),
    ).toEqual([
      ["navigation", "passed"],
      ["readiness", "passed"],
    ]);
    const loaded = await loadCaptureRun({
      runDirectory: run.runDirectory,
      expectedFlow: f.flow.id,
    });
    expect(loaded.tuples.every((tuple) => !tuple.failure)).toBe(true);
    const tall = loaded.tuples.find((tuple) => tuple.state === "tall");
    expect(tall?.screenshotGeometry).toMatchObject({
      height: 16000,
      croppedFromHeight: 40000,
      scale: 2,
    });
    const { PNG } = await import("pngjs");
    expect(
      PNG.sync.read(
        await readFile(
          join(run.runDirectory, tall?.screenshotPath ?? "missing"),
        ),
      ).height,
    ).toBe(32000);
    expect(await readFile(run.reportPath, "utf8")).toContain(
      "Screenshot cropped for tall/desktop/light: captured 16000 of 40000 CSS px",
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
}, 30000);

test.each([
  [true, false],
  [false, false],
  [false, true],
])(
  "probe reach retry preserves saved evidence and the run-wide retry (recovered %s, initial retry %s)",
  async (recovered, initialTimeout) => {
    const f = await productionFixture();
    try {
      const calls: string[] = [];
      const run = await runCapture({
        projectDirectory: f.directory,
        project: f.project,
        flow: flowSchema.parse({
          ...f.flow,
          states: ["a", "b"].map((id) => ({
            id,
            description: id,
            url: "/",
            expect: {},
          })),
        }),
        dependencies: {
          readHost: () => ({ load: [64, 0, 0], coreCount: 11 }),
          measureReadyUrl: async () => 1,
          browserLauncher: async () => ({
            version: "test",
            planProbes: true,
            close: async () => {},
            capture: async (tuple) => {
              const phase = tuple.enumerateProbe ? "enumerate" : "probe";
              calls.push(`${tuple.state.id}/${phase}/${tuple.timeoutFactor}`);
              if (
                initialTimeout &&
                tuple.enumerateProbe &&
                tuple.state.id === "a" &&
                tuple.timeoutFactor === 1
              )
                return result(tuple, "timeout");
              if (
                !tuple.enumerateProbe &&
                tuple.state.id === "a" &&
                (!recovered || tuple.timeoutFactor === 1)
              )
                return result(tuple, "timeout");
              const base = result(tuple, "pass");
              return {
                ...base,
                probeMs: tuple.enumerateProbe ? undefined : 10,
                screenshot: Buffer.from(
                  tuple.enumerateProbe
                    ? "saved screenshot"
                    : "disposable screenshot",
                ),
                observations: {
                  version: 2,
                  viewport: { width: 800, height: 600 },
                  document: {
                    scrollWidth: 800,
                    scrollHeight: 600,
                    clientWidth: 800,
                    clientHeight: 600,
                  },
                  elements: [],
                  headings: [],
                  tokens: { status: "not-configured" },
                  maskMembership: [],
                  probe: { status: "ran", results: [] },
                },
              } as TupleResult;
            },
          }),
        },
      });
      expect(calls).toEqual(
        initialTimeout
          ? [
              "a/enumerate/1",
              "b/enumerate/1",
              "a/enumerate/2",
              "a/probe/1",
              "b/probe/1",
            ]
          : [
              "a/enumerate/1",
              "b/enumerate/1",
              "a/probe/1",
              "b/probe/1",
              "a/probe/2",
            ],
      );
      expect(run.counts).toEqual({ total: 2, passed: 2, failed: 0 });
      expect(run.scope?.retryCount).toBe(1);
      expect(run.scope?.retries?.[0]).toMatchObject({
        phase: initialTimeout ? "capture" : "probe",
        outcome: recovered || initialTimeout ? "passed" : "timed-out",
      });
      expect(run.scope?.deferredTuples).toEqual([]);
      expect(
        await readFile(
          join(run.runDirectory, "a/desktop/screenshot.png"),
          "utf8",
        ),
      ).toBe("saved screenshot");
      const loaded = await loadCaptureRun({
        runDirectory: run.runDirectory,
        expectedFlow: f.flow.id,
      });
      const observation = loaded.tuples[0]?.observations;
      if (observation?.version !== 2) throw new Error("missing base evidence");
      expect(observation.probe?.stateReachTimeout !== undefined).toBe(
        !recovered,
      );
      const report = await readFile(run.reportPath, "utf8");
      expect(
        report.includes(
          "Probe produced no evidence for a: the state timed out",
        ),
      ).toBe(!recovered);
      expect(report).not.toContain("Raise checks.probe.flowBudgetMs");
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test.each(["navigation", "screenshot", "step", "launch"] as const)(
  "ordinary %s errors, including timeout text, do not consume a retry",
  async (stage) => {
    const f = await productionFixture();
    try {
      let attempts = 0;
      const run = await runCapture({
        projectDirectory: f.directory,
        project: f.project,
        flow: f.flow,
        dependencies: {
          readHost: () => ({ load: [64, 0, 0], coreCount: 11 }),
          measureReadyUrl: async () => 1,
          browserLauncher: async () => ({
            version: "test",
            close: async () => {},
            capture: async (tuple) => {
              attempts++;
              return { ...result(tuple, "error"), stage } as TupleResult;
            },
          }),
        },
      });
      expect(attempts).toBe(1);
      expect(run.scope?.retryCount).toBe(0);
      expect(run.scope?.deferredTuples).toEqual([]);
      expect(run.counts.failed).toBe(1);
      if (stage === "navigation") {
        const path = join(run.runDirectory, "home/desktop/metadata.json");
        const metadata = JSON.parse(await readFile(path, "utf8"));
        metadata.failure.hostDeferred = true;
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, JSON.stringify(metadata));
        const loaded = await loadCaptureRun({
          runDirectory: run.runDirectory,
          expectedFlow: f.flow.id,
        });
        expect(loaded.tuples[0]?.failure?.hostDeferred).toBeUndefined();
      }
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test("capture cancellation prevents queued retries and publication", async () => {
  const f = await productionFixture();
  const controller = new AbortController();
  try {
    let attempts = 0;
    await expect(
      runCapture({
        projectDirectory: f.directory,
        project: f.project,
        flow: f.flow,
        dependencies: {
          signal: controller.signal,
          readHost: () => ({ load: [64, 0, 0], coreCount: 11 }),
          measureReadyUrl: async () => 1,
          browserLauncher: async () => ({
            version: "test",
            close: async () => {},
            capture: async (tuple) => {
              attempts++;
              controller.abort(new Error("cancelled capture"));
              return result(tuple, "timeout");
            },
          }),
        },
      }),
    ).rejects.toThrow("cancelled capture");
    expect(attempts).toBe(1);
    const { readdir, readFile } = await import("node:fs/promises");
    // The run stays visible as interrupted; nothing was published complete.
    const runs = await readdir(join(f.directory, ".idiom/reports"));
    expect(runs).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(
          join(f.directory, ".idiom/reports", runs[0] as string, "run.json"),
          "utf8",
        ),
      ).status,
    ).toBe("interrupted");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("diagnostic screenshot geometry survives replacement and storage without observations", async () => {
  const f = await productionFixture();
  try {
    const run = await runCapture({
      projectDirectory: f.directory,
      project: f.project,
      flow: f.flow,
      dependencies: {
        readHost: () => ({ load: [0, 0, 0], coreCount: 11 }),
        measureReadyUrl: async () => 1,
        browserLauncher: async () => ({
          version: "test",
          close: async () => {},
          capture: async (tuple) =>
            ({
              ...result(tuple, "timeout"),
              screenshot: Buffer.from("diagnostic"),
              screenshotGeometry: {
                strategy: "full-page",
                width: 800,
                height: 16000,
                croppedFromHeight: tuple.timeoutFactor === 2 ? 40000 : 30000,
                scale: 2,
              },
            }) as TupleResult,
        }),
      },
    });
    const loaded = await loadCaptureRun({
      runDirectory: run.runDirectory,
      expectedFlow: f.flow.id,
    });
    expect(loaded.tuples[0]?.observations).toBeUndefined();
    expect(loaded.tuples[0]?.screenshotGeometry).toMatchObject({
      height: 16000,
      croppedFromHeight: 40000,
    });
    expect(await readFile(run.reportPath, "utf8")).toContain(
      "captured 16000 of 40000 CSS px",
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test.each([true, false])(
  "latency-only pressure defers; unavailable measurements never prevent publication (slowdown %s)",
  async (slowdown) => {
    const f = await productionFixture();
    try {
      let sample = 0;
      const run = await runCapture({
        projectDirectory: f.directory,
        project: f.project,
        flow: f.flow,
        dependencies: {
          readHost: () => ({ load: null, coreCount: 11 }),
          measureReadyUrl: async () => {
            if (!slowdown) throw new Error("measurement unavailable");
            return ++sample === 1 ? 1 : 11;
          },
          browserLauncher: async () => ({
            version: "test",
            close: async () => {},
            capture: async (tuple) => result(tuple, "timeout"),
          }),
        },
      });
      expect(run.scope?.host?.pressureReasons).toEqual(
        slowdown ? ["ready-url-slowdown"] : [],
      );
      expect(run.scope?.deferredTuples).toHaveLength(slowdown ? 1 : 0);
      const report = await readFile(run.reportPath, "utf8");
      if (slowdown)
        expect(report).toContain("ready URL 11 times slower than at start");
      else expect(run.scope?.host?.readyStartMs).toBeNull();
      expect(report).not.toContain("load 0");
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
