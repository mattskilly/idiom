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

const surface = (
  status: "shows" | "absent" | "unknown",
): GateStatePlan["surface"] => ({
  status,
  matched: status === "shows" ? [".Toolbar.button"] : [],
  runId: "seed-run",
});

test("absent states drop before any cut to a state that shows the change", () => {
  const result = trimToBudget({
    states: [
      state({ state: "a", order: 0, surface: surface("absent") }),
      state({ state: "b", order: 1, surface: surface("absent") }),
      state({ state: "t", order: 2, surface: surface("shows") }),
    ],
    model,
    server,
    concurrency: 1,
    budgetMs: 4 * 20_000 + 5_000 + 60_000,
    probeTargetMs: 400_000,
  });
  // Both absent states go first, before probe controls, viewports or schemes.
  expect(result.skippedWork.slice(0, 2)).toEqual([
    expect.objectContaining({
      kind: "state",
      state: "b",
      reason:
        "over budget: does not render the changed surface (last capture seed-run)",
    }),
    expect.objectContaining({ kind: "state", state: "a" }),
  ]);
  expect(result.states.map((entry) => entry.state)).toEqual(["t"]);
  expect(result.states[0]?.viewports).toEqual(["wide", "narrow"]);
});

test("shows outranks route rank; unknown drops after absent and before shows", () => {
  const result = trimToBudget({
    states: [
      state({
        state: "route-absent",
        rank: "route",
        order: 0,
        surface: surface("absent"),
      }),
      state({
        state: "route-unknown",
        rank: "route",
        order: 1,
        surface: surface("unknown"),
      }),
      state({
        state: "fallback-shows",
        rank: "fallback",
        order: 2,
        surface: surface("shows"),
      }),
    ],
    model,
    server,
    concurrency: 4,
    budgetMs: 1_000,
    probeTargetMs: 400_000,
  });
  const dropped = result.skippedWork
    .filter((skip) => skip.kind === "state")
    .map((skip) => skip.state);
  expect(dropped).toEqual(["route-absent", "route-unknown"]);
  expect(
    result.skippedWork.find(
      (skip) => skip.kind === "state" && skip.state === "route-unknown",
    )?.reason,
  ).toBe("over budget: lowest-ranked (route, surface unknown) state");
  // The single highest state always remains, at one tuple.
  expect(result.states).toEqual([
    expect.objectContaining({
      state: "fallback-shows",
      viewports: ["wide"],
      schemes: ["light"],
    }),
  ]);
});

test("axis trimming pops the least likely viewport first", () => {
  const result = trimToBudget({
    states: [
      state({
        state: "t",
        viewports: ["desktop", "mobile", "tablet"],
        schemes: ["light"],
        probe: false,
        surface: surface("shows"),
      }),
    ],
    model,
    server,
    concurrency: 1,
    budgetMs: 2 * 20_000 + 5_000,
    probeTargetMs: 400_000,
  });
  expect(result.skippedWork).toEqual([
    expect.objectContaining({ kind: "viewport", viewport: "tablet" }),
  ]);
  expect(result.states[0]?.viewports).toEqual(["desktop", "mobile"]);
});
