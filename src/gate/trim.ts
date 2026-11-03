import { formatDuration } from "../capture/timings.js";
import { type CostModel, estimateGate } from "./estimate.js";
import type {
  GateEstimate,
  GateRank,
  GateServer,
  GateSkip,
  GateStatePlan,
} from "./types.js";

/** Controls per probed state the trimmed probe still budgets for (its check candidates). */
export const CHECK_CANDIDATE_FLOOR = 5;
const rankValue: Record<GateRank, number> = {
  route: 2,
  import: 1,
  fallback: 0,
};

/** Lowest priority first: fallback before import before route, later states first. */
export function lowestFirst(states: GateStatePlan[]): GateStatePlan[] {
  return [...states].sort(
    (a, b) => rankValue[a.rank] - rankValue[b.rank] || b.order - a.order,
  );
}

export type TrimResult = {
  states: GateStatePlan[];
  skippedWork: GateSkip[];
  probeBudgetMs?: number | undefined;
  probeDisabled: boolean;
  estimate: GateEstimate;
  minimumExceedsBudget: boolean;
};

/**
 * Fit the plan to the budget, cheapest coverage first: ordinary probe
 * controls, widened viewports, widened schemes, the probe, then whole states.
 * Never below one tuple of the highest-ranked state; every cut is a skip.
 */
export function trimToBudget(options: {
  states: GateStatePlan[];
  model: CostModel;
  server: GateServer;
  concurrency: number;
  budgetMs: number;
  probeTargetMs: number;
  probeBudgetMs?: number | undefined;
}): TrimResult {
  let states = options.states.map((state) => ({
    ...state,
    viewports: [...state.viewports],
    schemes: [...state.schemes],
  }));
  let probeBudgetMs = options.probeBudgetMs;
  const skippedWork: GateSkip[] = [];
  const estimate = () =>
    estimateGate({
      states,
      model: options.model,
      server: options.server,
      concurrency: options.concurrency,
      probeBudgetMs,
      probeTargetMs: options.probeTargetMs,
    });
  let current = estimate();
  const over = () => current.totalMs > options.budgetMs;
  // 1. Ordinary controls of the changed region: shrink the probe allotment.
  if (over() && current.probeMs > 0) {
    const floor = estimateGate({
      states: states.map((state) => ({
        ...state,
        probeControls: Math.min(state.probeControls, CHECK_CANDIDATE_FLOOR),
      })),
      model: options.model,
      server: options.server,
      concurrency: options.concurrency,
      probeTargetMs: options.probeTargetMs,
    }).probeMs;
    const room = options.budgetMs - (current.totalMs - current.probeMs);
    const allotment = Math.max(floor, room, 1000);
    if (allotment < current.probeMs) {
      const saved = current.probeMs - allotment;
      probeBudgetMs = Math.round(allotment);
      for (const flow of new Set(
        states.filter((state) => state.probe).map((state) => state.flow),
      ))
        skippedWork.push({
          kind: "probe-controls",
          flow,
          reason: `probe allotment cut to ${formatDuration(allotment)}; ordinary controls past it go unprobed (check candidates run first)`,
          estimatedMs: Math.round(saved),
        });
      current = estimate();
    }
  }
  // 2. Viewports, then schemes, that responsive or theme styles added. A
  // flow captures one viewport × scheme grid, so an axis value goes for the
  // flow's every state at once; later flows first.
  const flows = [...new Set(states.map((state) => state.flow))].reverse();
  for (const axis of ["viewport", "scheme"] as const)
    for (const flow of flows) {
      const members = states.filter((state) => state.flow === flow);
      const values = (state: GateStatePlan): string[] =>
        axis === "viewport" ? state.viewports : state.schemes;
      while (over() && members.some((state) => values(state).length > 1)) {
        const value = values(
          members.find((state) => values(state).length > 1) as GateStatePlan,
        ).at(-1) as string;
        const before = current.totalMs;
        for (const state of members) {
          const list = values(state);
          if (list.length > 1 && list.at(-1) === value) list.pop();
        }
        current = estimate();
        skippedWork.push({
          kind: axis,
          flow,
          ...(axis === "viewport"
            ? { viewport: value }
            : { scheme: value as "light" | "dark" }),
          reason: `over budget: ${axis === "viewport" ? "responsive" : "theme"} styles widened ${flow}; kept ${values(members[0] as GateStatePlan)[0]}`,
          estimatedMs: Math.max(0, before - current.totalMs),
        });
      }
    }
  // 3. The probe itself (check candidates included): off for the run.
  let probeDisabled = false;
  if (over() && states.some((state) => state.probe)) {
    const before = current;
    const probed = states.filter((state) => state.probe);
    states = states.map((state) => ({ ...state, probe: false }));
    probeDisabled = true;
    current = estimate();
    for (const state of probed)
      skippedWork.push({
        kind: "probe",
        flow: state.flow,
        state: state.state,
        reason: "over budget: interaction probe off for this run",
        estimatedMs: Math.round(
          (before.probeMs * state.probeControls) /
            Math.max(
              1,
              probed.reduce((sum, item) => sum + item.probeControls, 0),
            ),
        ),
      });
  }
  // 4. Whole states, lowest rank first; the highest-ranked one always stays.
  for (const state of lowestFirst(states)) {
    if (!over() || states.length <= 1) break;
    const before = current.totalMs;
    states = states.filter((candidate) => candidate !== state);
    current = estimate();
    skippedWork.push({
      kind: "state",
      flow: state.flow,
      state: state.state,
      reason: `over budget: lowest-ranked (${state.rank}) state`,
      estimatedMs: Math.max(0, before - current.totalMs),
    });
  }
  return {
    states,
    skippedWork,
    ...(probeBudgetMs === undefined ? {} : { probeBudgetMs }),
    probeDisabled,
    estimate: current,
    minimumExceedsBudget: over(),
  };
}
