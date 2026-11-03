import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { RunRecord } from "../src/capture/run-record.js";
import {
  costModel,
  estimateGate,
  GATE_DEFAULTS,
  loadFlowHistory,
} from "../src/gate/estimate.js";
import { reflectsBase } from "../src/gate/region.js";
import type { GateStatePlan } from "../src/gate/types.js";

const measured = (ms: number) => ({ status: "measured" as const, ms });

async function seedRun(
  project: string,
  runId: string,
  options: {
    tupleMs: number;
    probeMs: number;
    startMs: number;
    probed: number;
  },
) {
  const directory = join(project, ".idiom", "reports", runId);
  await mkdir(join(directory, "s0", "wide"), { recursive: true });
  const coordinate = { state: "s0", viewport: "wide", colorScheme: "light" };
  await writeFile(
    join(directory, "run.json"),
    JSON.stringify({
      version: 1,
      flow: "site",
      source: { commit: "abc", dirty: false },
      declared: [coordinate],
      selected: [coordinate],
      viewports: [{ name: "wide", width: 800, height: 600 }],
      probe: {
        policy: "once-per-state",
        fallback: false,
        intended: [coordinate],
        executed: [coordinate],
      },
      timings: {
        build: measured(0),
        start: measured(options.startMs),
        tuples: [
          {
            ...coordinate,
            total: measured(options.tupleMs + options.probeMs),
            probe: measured(options.probeMs),
          },
        ],
        probe: measured(options.probeMs),
        checks: { status: "skipped", ms: 0 },
      },
    }),
  );
  await writeFile(
    join(directory, "checks-timings.json"),
    JSON.stringify({ version: 1, checks: measured(2000) }),
  );
  await writeFile(
    join(directory, "s0", "wide", "observations.json"),
    JSON.stringify({
      version: 2,
      probe: {
        status: "ran",
        results: Array.from({ length: options.probed }, () => ({
          elapsedMs: 10,
        })),
        fingerprints: { "button|Go": "f1" },
      },
    }),
  );
}

const state = (overrides: Partial<GateStatePlan> = {}): GateStatePlan => ({
  flow: "site",
  state: "s0",
  rank: "route",
  order: 0,
  viewports: ["wide"],
  schemes: ["light"],
  expandedViewports: [],
  expandedSchemes: [],
  probe: true,
  probeControls: 10,
  ...overrides,
});

test("medians come from stored runs; reference fingerprints load per tuple", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-estimate-"));
  try {
    await seedRun(project, "2026-10-01T00-00-00Z", {
      tupleMs: 4000,
      probeMs: 10_000,
      startMs: 3000,
      probed: 10,
    });
    await seedRun(project, "2026-10-02T00-00-00Z", {
      tupleMs: 6000,
      probeMs: 20_000,
      startMs: 5000,
      probed: 10,
    });
    await seedRun(project, "2026-10-03T00-00-00Z", {
      tupleMs: 8000,
      probeMs: 30_000,
      startMs: 7000,
      probed: 10,
    });
    const history = await loadFlowHistory(project, "site");
    expect(history.map((run) => run.runId)).toEqual([
      "2026-10-03T00-00-00Z",
      "2026-10-02T00-00-00Z",
      "2026-10-01T00-00-00Z",
    ]);
    expect(
      history[0]?.fingerprints.get("s0\0wide\0light")?.get("button|Go"),
    ).toBe("f1");
    const model = costModel(history);
    expect(model.tupleCaptureMs("s0", "wide", "light")).toBe(6000);
    expect(model.controlProbeMs).toBe(2000);
    expect(model.startMs).toBe(5000);
    expect(model.checksMs).toBe(2000);
    expect(model.noHistory).toBe(false);
    const estimate = estimateGate({
      states: [state()],
      model,
      server: { mode: "fresh", reason: "" },
      concurrency: 4,
      probeTargetMs: 400_000,
    });
    expect(estimate).toMatchObject({
      captureMs: 6000,
      probeMs: 20_000,
      startMs: 5000,
      checksMs: 2000,
      totalMs: 33_000,
    });
    const reused = estimateGate({
      states: [state()],
      model,
      server: { mode: "reused", verified: false, reason: "" },
      concurrency: 4,
      probeTargetMs: 400_000,
    });
    expect(reused.startMs).toBe(0);
    expect(reused.buildMs).toBe(0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("no history uses the documented defaults and lanes divide parallel work", () => {
  const model = costModel([]);
  expect(model.noHistory).toBe(true);
  expect(model.tupleCaptureMs("x", "y", "light")).toBe(
    GATE_DEFAULTS.tupleCaptureMs,
  );
  const states = [
    state({ state: "a", viewports: ["wide", "narrow"], probe: false }),
    state({ state: "b", viewports: ["wide", "narrow"], probe: false }),
  ];
  // Two lanes (wide, narrow), each running a then b.
  const estimate = estimateGate({
    states,
    model,
    server: { mode: "fresh", reason: "" },
    concurrency: 4,
    probeTargetMs: 400_000,
  });
  expect(estimate.captureMs).toBe(2 * GATE_DEFAULTS.tupleCaptureMs);
  expect(estimate.noHistory).toBe(true);
  const serial = estimateGate({
    states,
    model,
    server: { mode: "fresh", reason: "" },
    concurrency: 1,
    probeTargetMs: 400_000,
  });
  expect(serial.captureMs).toBe(4 * GATE_DEFAULTS.tupleCaptureMs);
});

test("only clean runs at the base or an ancestor of it can be a region reference", async () => {
  const asked: string[][] = [];
  const accept = reflectsBase(
    async (_cwd, args) => {
      asked.push(args);
      if (args[2] === "later") throw new Error("not an ancestor");
      return "";
    },
    "/repo",
    "base",
  );
  const record = (commit: string, dirty: boolean) =>
    ({ source: { commit, dirty } }) as RunRecord;
  expect(await accept(record("base", true))).toBe(false);
  expect(asked).toEqual([]);
  expect(await accept(record("older", false))).toBe(true);
  expect(await accept(record("later", false))).toBe(false);
  expect(await accept(record("older", false))).toBe(true);
  expect(asked).toEqual([
    ["merge-base", "--is-ancestor", "older", "base"],
    ["merge-base", "--is-ancestor", "later", "base"],
  ]);
});
