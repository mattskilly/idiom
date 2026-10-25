import { rm } from "node:fs/promises";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { collectPageEvidence } from "../src/capture/page.js";
import { runCapture } from "../src/capture/run.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { productionFixture } from "./production-support.js";

const state = flowSchema.parse({
  id: "timing",
  title: "Timing",
  setup: [],
  intent: [],
  states: [{ id: "page", description: "Page", url: "/", expect: {} }],
}).states[0];

test.each([false, true])(
  "probe time survives partial or throwing execution (%s)",
  async (throwing) => {
    if (!state) throw new Error("missing state");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent("<html><body><h1>Timing</h1></body></html>");
      let monotonic = 100;
      const result = await collectPageEvidence({
        page,
        state,
        settleMs: 0,
        reachStage: "navigation",
        reach: async () => 200,
        createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
        collectConsole: async () => [],
        tokens: { status: "not-configured" },
        screenshotOptions: {},
        now: () => new Date("2026-10-24T00:00:00Z"),
        monotonicNow: () => monotonic,
        probe: async () => {
          monotonic += 37;
          if (throwing) throw new Error("partial probe");
          return { status: "partial", results: [], reason: "test" };
        },
      });
      expect(result.probeMs).toBe(37);
      expect(
        result.observations?.version === 2 && result.observations.probe?.status,
      ).toBe("partial");
      expect(result.startedAt).toBe(result.endedAt);
    } finally {
      await browser.close();
    }
  },
);

test("monotonic capture measurements retain failed designated probes without retrying sibling coordinates", async () => {
  const f = await productionFixture();
  try {
    const project = projectSchema.parse({
      ...f.project,
      colorSchemes: ["dark", "light"],
      checks: { probe: { enabled: true } },
    });
    const flow = flowSchema.parse({
      ...f.flow,
      states: [{ ...f.flow.states[0], expect: {} }],
    });
    const probes: string[] = [];
    let tick = 0;
    const result = await runCapture({
      projectDirectory: f.directory,
      project,
      flow,
      dependencies: {
        monotonicNow: () => {
          tick += 10;
          return tick;
        },
        browserLauncher: async () => ({
          version: "test",
          close: async () => {},
          capture: async (tuple) => {
            if (tuple.probe) probes.push(tuple.colorScheme ?? "light");
            return {
              ok: false,
              stage: "navigation",
              message: "fixture failure",
              console: [],
              mismatches: [],
              startedAt: "2026-10-24T00:00:00Z",
              endedAt: "2026-10-24T00:00:00Z",
            };
          },
        }),
      },
    });
    expect(result.timings?.build).toEqual({ status: "measured", ms: 10 });
    expect(result.timings?.start).toEqual({ status: "measured", ms: 10 });
    expect(result.timings?.tuples.map((tuple) => tuple.total)).toEqual([
      { status: "measured", ms: 10 },
      { status: "measured", ms: 10 },
    ]);
    expect(result.timings?.tuples.map((tuple) => tuple.probe.status)).toEqual([
      "skipped",
      "unavailable",
    ]);
    expect(result.scope?.probe.executed).toEqual([]);
    expect(probes).toEqual(["light"]);
    expect(result.timings?.checks.status).toBe("skipped");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("slowest controls use duration then stable identities, render outcomes, and preserve optional history", async () => {
  const { slowestControls, renderTimings, skipped } = await import(
    "../src/capture/timings.js"
  );
  const { runRecordSchema } = await import("../src/capture/run-record.js");
  const controls = Array.from({ length: 8 }, (_, index) => ({
    state: "editor",
    viewport: "desktop",
    colorScheme: "light" as const,
    selector: `#${index}`,
    name: `Control ${index}`,
    elapsedMs: index < 2 ? 900 : index * 100,
    outcome: index === 0 ? ("timed-out" as const) : ("completed" as const),
  }));
  const slow = slowestControls(controls.reverse());
  expect(slow.map((value) => value.selector)).toEqual([
    "#0",
    "#1",
    "#7",
    "#6",
    "#5",
  ]);
  const timings = {
    build: skipped(),
    start: skipped(),
    tuples: [],
    probe: skipped(),
    checks: skipped(),
    slowestControls: slow,
  };
  expect(renderTimings(timings)).toContain(
    "#0 Control 0: 900.0 ms (timed-out)",
  );
  const record = {
    version: 1,
    flow: "fixture",
    source: { commit: "abc", dirty: false },
    declared: [],
    selected: [],
    viewports: [],
    probe: {
      policy: "once-per-state",
      fallback: false,
      intended: [],
      executed: [],
    },
    timings,
  };
  expect(runRecordSchema.parse(record).timings.slowestControls).toEqual(slow);
  const { slowestControls: _, ...legacy } = timings;
  expect(
    runRecordSchema.parse({ ...record, timings: legacy }).timings
      .slowestControls,
  ).toBeUndefined();
});
