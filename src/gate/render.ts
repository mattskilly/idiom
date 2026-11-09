import { formatDuration } from "../capture/timings.js";
import type { GateComparisonPlan, GatePlan, GateSkip } from "./types.js";

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

export function describeSkip(skip: GateSkip): string {
  const what =
    skip.kind === "probe-controls"
      ? `${skip.flow} ordinary probe controls`
      : skip.kind === "viewport"
        ? `${skip.flow} @ ${skip.viewport}`
        : skip.kind === "scheme"
          ? `${skip.flow} @ ${skip.scheme}`
          : `${skip.flow}/${skip.state}`;
  return `skipped: ${skip.kind} ${what} — ${skip.reason} (~${formatDuration(skip.estimatedMs)})`;
}

/** The headline the gate prints before any server starts. */
export function gatePlanLine(plan: GatePlan): string {
  const viewports = new Set(plan.tuples.map((tuple) => tuple.viewport)).size;
  const schemes = new Set(plan.tuples.map((tuple) => tuple.scheme)).size;
  const probed = plan.states.filter((state) => state.probe);
  const controls = probed.reduce((sum, state) => sum + state.probeControls, 0);
  const scoped = probed.filter((state) => state.region !== undefined).length;
  const probe = !probed.length
    ? "probe off"
    : `probe on ${scoped === probed.length ? "≤" : ""}${plural(controls, "control")}${scoped === 0 ? " (unscoped: no reference run)" : scoped < probed.length ? ` (${probed.length - scoped} state(s) unscoped: no reference run)` : " (changed region)"}`;
  const server =
    plan.server.mode === "reused"
      ? `server reused (${plan.server.verified ? "verified" : `unverified: ${plan.server.reason}`})`
      : plan.server.mode === "production-reuse"
        ? "production build reused when inputs are unchanged"
        : "server started fresh";
  const estimate = `est. ${plan.estimate.noHistory ? "~" : ""}${formatDuration(plan.estimate.totalMs)}${plan.estimate.noHistory ? " (no history)" : ""} of ${formatDuration(plan.budgetMs)} budget`;
  return [
    `idiom check --gate: ${plural(plan.states.length, "state")} × ${plural(viewports, "viewport")}${schemes > 1 ? ` × ${plural(schemes, "scheme")}` : ""}, ${probe}, ${server}, ${estimate}`,
    ...(plan.graph.complete
      ? []
      : [
          `; non-UI detection off: ${plan.graph.reasons[0] ?? "import graph incomplete"}`,
        ]),
  ].join("");
}

/** One flow's comparison: what its new findings are judged against. */
export function describeComparison(
  flow: string,
  comparison: GateComparisonPlan,
): string {
  const base = comparison.base.slice(0, 12);
  const tuples = plural(comparison.missingTuples, "tuple");
  const stored =
    comparison.baselineCommit === undefined
      ? undefined
      : `${comparison.baselineCommit.slice(0, 12)}, ${comparison.behindBase ?? 0} commit(s) behind with no UI changes since`;
  switch (comparison.mode) {
    case "base-capture":
      return `${flow}: judged against base ${base} (base capture, ${tuples}${comparison.estimateMs === undefined ? "" : `, est. ~${formatDuration(comparison.estimateMs)} incl. worktree preparation`}${comparison.baseCaptureMs === undefined ? "" : `, took ${formatDuration(comparison.baseCaptureMs)}`})`;
    case "base-cache":
      return `${flow}: judged against base ${base} (cached base capture${stored === undefined ? "" : ` at ${stored}`})`;
    case "baseline":
      return `${flow}: judged against base ${base} (baseline ${stored ?? "recorded at the base"})`;
    case "fallback":
      return `${flow}: judged against baseline ${comparison.baselineCommit?.slice(0, 12)}, ${comparison.behindBase ?? "?"} commit(s) behind base ${base} (base capture skipped)`;
    case "none":
      return `${flow}: no baseline reachable from base ${base}; gating open findings`;
  }
}

/** Every stderr line of the plan: headline, widening, skips, notes. */
export function renderGatePlan(plan: GatePlan): string[] {
  const states = plan.states.map(
    (state) =>
      `  ${state.flow}/${state.state} (${state.rank}): ${state.viewports.join(", ")} × ${state.schemes.join(", ")}${state.probe ? `; probe ${state.region ? `scoped to changes since ${state.region.runId}` : "unscoped"}` : ""}`,
  );
  return [
    gatePlanLine(plan),
    `Base: ${plan.base} (${plan.baseReason})`,
    ...states,
    ...Object.entries(plan.comparisons ?? {}).map(([flow, comparison]) =>
      describeComparison(flow, comparison),
    ),
    ...(plan.styleScope.responsive.length
      ? [
          `widened viewports: responsive styles in ${plan.styleScope.responsive.join(", ")}`,
        ]
      : []),
    ...(plan.styleScope.theme.length
      ? [`widened schemes: theme styles in ${plan.styleScope.theme.join(", ")}`]
      : []),
    ...plan.skippedWork.map(describeSkip),
    ...(plan.minimumExceedsBudget
      ? ["estimate exceeds budget at minimum coverage; running anyway"]
      : []),
    ...plan.notes,
  ];
}
