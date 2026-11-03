import type { CheckTuple, ProbeArtifact } from "../checks/types.js";

export type ProbeStateCoverage = {
  state: string;
  viewport: string;
  colorScheme?: CheckTuple["colorScheme"];
  status: ProbeArtifact["status"];
  completed: number;
  /** Deliberately not probed: destructive names, probe.skip, intent. */
  skipped: number;
  timedOut: number;
  notReached: number;
  topNotReached?: { reason: string; count: number } | undefined;
};

export type ProbeCoverage = {
  /** Effective run target in ms; 0 = no target; undefined = not recorded (older run). */
  flowBudgetMs?: number | undefined;
  states: ProbeStateCoverage[];
  totals: {
    candidates: number;
    completed: number;
    skipped: number;
    timedOut: number;
    notReached: number;
  };
  /** notReached / candidates, 0 when there are no candidates. */
  notReachedShare: number;
  /** Present when notReachedShare > 0.10. */
  warning?: string | undefined;
};

/** More than this share of not-reached candidates warns. */
const WARNING_SHARE = 0.1;

/** `not reached: flow budget share (tried a, b)` → `flow budget share`. */
function normalizeReason(reason: string): string {
  return reason
    .replace(/^not reached:\s*/i, "")
    .replace(/\s*\([^()]*\)\s*$/, "")
    .trim();
}

function topReason(
  reasons: Map<string, number>,
): ProbeStateCoverage["topNotReached"] {
  const [top] = [...reasons].sort(
    ([a, x], [b, y]) => y - x || a.localeCompare(b),
  );
  return top === undefined ? undefined : { reason: top[0], count: top[1] };
}

function targetPhrase(flowBudgetMs: number | undefined): string {
  if (flowBudgetMs === undefined) return "target not recorded";
  if (flowBudgetMs === 0) return "no target";
  return `target ${flowBudgetMs / 1000}s`;
}

/** How much of each probed state the interaction probe exercised. */
export function computeProbeCoverage(options: {
  tuples: Array<
    Pick<CheckTuple, "state" | "viewport" | "colorScheme" | "observations">
  >;
  flowBudgetMs?: number | undefined;
}): ProbeCoverage | undefined {
  const states: ProbeStateCoverage[] = [];
  for (const tuple of options.tuples) {
    if (tuple.observations?.version !== 2) continue;
    const probe = tuple.observations.probe;
    if (probe === undefined) continue;
    const entry: ProbeStateCoverage = {
      state: tuple.state,
      viewport: tuple.viewport,
      colorScheme: tuple.colorScheme,
      status: probe.status,
      completed: 0,
      skipped: 0,
      timedOut: 0,
      notReached: 0,
    };
    const reasons = new Map<string, number>();
    for (const result of probe.results) {
      if (result.status === "not-reached") {
        entry.notReached += 1;
        const reason = normalizeReason(result.skipped ?? "") || "unknown";
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      } else if (result.status === "timed-out") entry.timedOut += 1;
      else if ((result.skipped ?? "") !== "") entry.skipped += 1;
      else entry.completed += 1;
    }
    const top = topReason(reasons);
    if (top !== undefined) entry.topNotReached = top;
    states.push(entry);
  }
  if (states.length === 0) return undefined;
  const totals = {
    candidates: 0,
    completed: 0,
    skipped: 0,
    timedOut: 0,
    notReached: 0,
  };
  for (const entry of states) {
    totals.completed += entry.completed;
    totals.skipped += entry.skipped;
    totals.timedOut += entry.timedOut;
    totals.notReached += entry.notReached;
  }
  totals.candidates =
    totals.completed + totals.skipped + totals.timedOut + totals.notReached;
  const notReachedShare =
    totals.candidates === 0 ? 0 : totals.notReached / totals.candidates;
  const coverage: ProbeCoverage = {
    flowBudgetMs: options.flowBudgetMs,
    states,
    totals,
    notReachedShare,
  };
  if (notReachedShare > WARNING_SHARE) {
    const lead = `${totals.notReached} of ${totals.candidates} probe candidates (${Math.round(notReachedShare * 100)}%) were not reached`;
    coverage.warning =
      options.flowBudgetMs === 0
        ? `${lead} with no flow target applied; the not-reached reasons name the limit that stopped them.`
        : `${lead}${options.flowBudgetMs === undefined ? "" : ` within the ${options.flowBudgetMs / 1000}s probe target`}. Raise checks.probe.flowBudgetMs or pass --probe-budget <ms> (0 = no target).`;
  }
  return coverage;
}

/** The header, one line per probed state, then the warning when present. */
export function probeCoverageLines(
  coverage: ProbeCoverage,
  stateLabels?: Record<string, string> | undefined,
): { header: string; states: string[]; warning?: string | undefined } {
  const { totals } = coverage;
  const seen = new Map<string, number>();
  for (const entry of coverage.states)
    seen.set(entry.state, (seen.get(entry.state) ?? 0) + 1);
  return {
    header: `Probe coverage (${targetPhrase(coverage.flowBudgetMs)}): ${totals.completed} completed, ${totals.timedOut} timed out, ${totals.notReached} not reached of ${totals.candidates} candidates`,
    states: coverage.states.map((entry) => {
      const name = stateLabels?.[entry.state] ?? entry.state;
      const label =
        (seen.get(entry.state) ?? 0) > 1
          ? `${name} (${entry.viewport}${entry.colorScheme === undefined ? "" : `, ${entry.colorScheme}`})`
          : name;
      const top = entry.topNotReached;
      return `${label}: ${entry.completed} completed, ${entry.timedOut} timed out, ${entry.notReached} not reached${entry.skipped > 0 ? `, ${entry.skipped} skipped` : ""}${top === undefined ? "" : ` — top not-reached reason: "${top.reason}" (×${top.count})`}`;
    }),
    warning: coverage.warning,
  };
}
