import { expect, test } from "vitest";
import { costModel } from "../src/gate/estimate.js";
import { trimToBudget } from "../src/gate/trim.js";
import type { GateStatePlan } from "../src/gate/types.js";

const model = costModel([]);
const server = { mode: "reused" as const, verified: true, reason: "" };
const state = (overrides: Partial<GateStatePlan>): GateStatePlan => ({
  flow: "site",
  state: "s0",
  rank: "route",
  order: 0,
  viewports: ["wide", "narrow"],
  schemes: ["light", "dark"],
  expandedViewports: ["narrow"],
  expandedSchemes: ["dark"],
  probe: true,
  probeControls: 40,
  ...overrides,
});
const states = [
  state({ state: "s0", rank: "route", order: 0 }),
  state({ state: "s1", rank: "import", order: 1 }),
  state({ state: "s2", rank: "fallback", order: 2 }),
];

test("under budget: nothing trimmed", () => {
  const result = trimToBudget({
    states,
    model,
    server,
    concurrency: 4,
    budgetMs: 60 * 60_000,
    probeTargetMs: 400_000,
  });
  expect(result.skippedWork).toEqual([]);
  expect(result.states).toHaveLength(3);
  expect(result.minimumExceedsBudget).toBe(false);
});

test("over budget trims in order and never below one tuple of the best state", () => {
  const result = trimToBudget({
    states,
    model,
    server,
    concurrency: 4,
    budgetMs: 10_000,
    probeTargetMs: 400_000,
  });
  expect(result.skippedWork.map((skip) => skip.kind)).toEqual([
    "probe-controls",
    "viewport",
    "scheme",
    "probe",
    "probe",
    "probe",
    "state",
    "state",
  ]);
  expect(
    result.skippedWork
      .filter((skip) => skip.kind === "state")
      .map((skip) => skip.state),
  ).toEqual(["s2", "s1"]);
  for (const skip of result.skippedWork) expect(skip.reason).not.toBe("");
  expect(result.states).toEqual([
    expect.objectContaining({
      state: "s0",
      viewports: ["wide"],
      schemes: ["light"],
      probe: false,
    }),
  ]);
  expect(result.probeDisabled).toBe(true);
  // One 20s default tuple cannot fit 10s: it runs anyway and says so.
  expect(result.minimumExceedsBudget).toBe(true);
});

test("a modest overrun only shrinks the probe allotment", () => {
  const result = trimToBudget({
    states: [state({ viewports: ["wide"], schemes: ["light"] })],
    model,
    server,
    concurrency: 4,
    budgetMs: 60_000,
    probeTargetMs: 400_000,
  });
  expect(result.skippedWork.map((skip) => skip.kind)).toEqual([
    "probe-controls",
  ]);
  expect(result.probeBudgetMs).toBeGreaterThan(0);
  expect(result.estimate.totalMs).toBeLessThanOrEqual(60_000);
});
