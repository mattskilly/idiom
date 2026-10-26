import { rm } from "node:fs/promises";
import { expect, test } from "vitest";
import { captureConcurrency, runCaptureLanes } from "../src/capture/lanes.js";
import { runCapture } from "../src/capture/run.js";
import type { BrowserTuple, TupleResult } from "../src/capture/types.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { productionFixture } from "./production-support.js";

const tuple = (state: string, viewport: string, colorScheme: string) => ({
  state: { id: state },
  viewport: { name: viewport },
  colorScheme,
});
const grid = ["a", "b"].flatMap((state) =>
  ["desktop", "mobile"].flatMap((viewport) =>
    ["light", "dark"].map((scheme) => tuple(state, viewport, scheme)),
  ),
);
const laneOf = (value: (typeof grid)[number]) =>
  `${value.viewport.name}/${value.colorScheme}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("lanes cap concurrency, keep flow order within a lane, and start the probed lane first", async () => {
  let inFlight = 0;
  let peak = 0;
  const starts: string[] = [];
  await runCaptureLanes({
    tuples: grid,
    lane: laneOf,
    first: (value) =>
      value.viewport.name === "mobile" && value.colorScheme === "dark",
    concurrency: 3,
    work: async (value) => {
      starts.push(`${value.state.id}@${laneOf(value)}`);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await wait(value.state.id === "a" ? 15 : 5);
      inFlight -= 1;
    },
  });
  expect(peak).toBe(3);
  expect(starts).toHaveLength(8);
  expect(starts[0]).toBe("a@mobile/dark");
  for (const lane of new Set(grid.map(laneOf)))
    expect(
      starts.filter((entry) => entry.endsWith(`@${lane}`)).map((e) => e[0]),
    ).toEqual(["a", "b"]);
});

test("a failure stops other lanes before their next tuple and rejects only after in-flight work settles", async () => {
  const started: string[] = [];
  const settled: string[] = [];
  const failing = runCaptureLanes({
    tuples: grid,
    lane: laneOf,
    concurrency: 4,
    work: async (value) => {
      const id = `${value.state.id}@${laneOf(value)}`;
      started.push(id);
      if (id === "a@desktop/light") {
        await wait(5);
        throw new Error("capture exploded");
      }
      await wait(30);
      settled.push(id);
    },
  });
  await expect(failing).rejects.toThrow("capture exploded");
  // The three other lanes' first tuples finished before the rejection.
  expect(settled.sort()).toEqual([
    "a@desktop/dark",
    "a@mobile/dark",
    "a@mobile/light",
  ]);
  expect(started.filter((id) => id.startsWith("b@"))).toEqual([]);
});

test("concurrency comes from capture.concurrency unless the diagnostic override is set", () => {
  const project = projectSchema.parse({
    version: 1,
    app: { name: "Fixture", framework: "other" },
    server: {
      port: 3000,
      readyUrl: "http://127.0.0.1:3000/",
      build: "unused",
      start: "unused",
      env: {},
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: { settleMs: 0 },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  expect(project.capture.concurrency).toBe(4);
  expect(captureConcurrency(project, {})).toBe(4);
  expect(captureConcurrency(project, { IDIOM_CAPTURE_CONCURRENCY: "1" })).toBe(
    1,
  );
  expect(
    captureConcurrency(project, { IDIOM_CAPTURE_CONCURRENCY: "nonsense" }),
  ).toBe(4);
});

test("a lane run reports tuples, timings and probe coordinates in sequential order", async () => {
  const f = await productionFixture();
  try {
    const flow = flowSchema.parse({
      ...f.flow,
      states: [
        { ...f.flow.states[0], id: "home", expect: {} },
        { ...f.flow.states[0], id: "next", expect: {} },
      ],
    });
    const run = async (concurrency: number) => {
      const project = projectSchema.parse({
        ...f.project,
        viewports: [
          { name: "desktop", width: 800, height: 600 },
          { name: "mobile", width: 390, height: 700 },
        ],
        colorSchemes: ["light", "dark"],
        capture: { ...f.project.capture, concurrency },
        checks: { probe: { enabled: true } },
      });
      let inFlight = 0;
      let peak = 0;
      const result = await runCapture({
        projectDirectory: f.directory,
        project,
        flow,
        dependencies: {
          browserLauncher: async () => ({
            version: "test",
            close: async () => {},
            capture: async (value: BrowserTuple): Promise<TupleResult> => {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              await wait(value.viewport.name === "desktop" ? 20 : 5);
              inFlight -= 1;
              return {
                ok: false,
                stage: "navigation",
                message: "fixture failure",
                ...(value.probe ? { probeMs: 1 } : {}),
                console: [],
                mismatches: [],
                startedAt: "2026-10-25T00:00:00Z",
                endedAt: "2026-10-25T00:00:00Z",
              };
            },
          }),
        },
      });
      const order = (
        list: Array<{
          state: string;
          viewport: string;
          colorScheme: string;
        }> = [],
      ) =>
        list.map(
          (entry) => `${entry.state}/${entry.viewport}/${entry.colorScheme}`,
        );
      return {
        peak,
        tuples: order(result.timings?.tuples),
        selected: order(result.scope?.selected),
        executed: order(result.scope?.probe.executed),
      };
    };
    const sequential = await run(1);
    const concurrent = await run(3);
    expect(sequential.peak).toBe(1);
    expect(concurrent.peak).toBe(3);
    expect(sequential.tuples).toHaveLength(8);
    expect(concurrent.tuples).toEqual(sequential.tuples);
    expect(concurrent.tuples).toEqual(sequential.selected);
    expect(concurrent.executed).toEqual(sequential.executed);
    expect(sequential.executed.length).toBeGreaterThan(0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);
