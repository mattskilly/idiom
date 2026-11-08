import type { CheckTuple, ProbeArtifact } from "../checks/types.js";

export type ProbeStateCoverage = {
  state: string;
  viewport: string;
  colorScheme?: CheckTuple["colorScheme"];
  status: ProbeArtifact["status"];
  completed: number;
  stateTimedOut?: boolean | undefined;
  /** Deliberately not probed: destructive names, probe.skip, intent. */
  skipped: number;
  timedOut: number;
  notReached: number;
  topNotReached?: { reason: string; count: number } | undefined;
  /** Opened overlays whose dismissal was tested; absent when none recorded. */
  dismissal?:
    | {
        tested: number;
        notReached: number;
        topNotReached?: { reason: string; count: number } | undefined;
      }
    | undefined;
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
    /** Overlays whose dismissal was tested (absent in older coverage). */
    dismissalTested?: number | undefined;
    /** Overlays, or tests of them, the probe budget never reached. */
    dismissalNotReached?: number | undefined;
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
    Pick<
      CheckTuple,
      "state" | "viewport" | "colorScheme" | "observations" | "failure"
    >
  >;
  flowBudgetMs?: number | undefined;
  intended?:
    | Array<{ state: string; viewport: string; colorScheme: "light" | "dark" }>
    | undefined;
}): ProbeCoverage | undefined {
  const states: ProbeStateCoverage[] = [];
  for (const tuple of options.tuples) {
    const intended = options.intended?.some(
      (value) =>
        value.state === tuple.state &&
        value.viewport === tuple.viewport &&
        value.colorScheme === (tuple.colorScheme ?? "light"),
    );
    const probe =
      (tuple.observations?.version === 2
        ? tuple.observations.probe
        : undefined) ??
      (intended && tuple.failure?.timeout
        ? { status: "timed-out" as const, results: [] }
        : undefined);
    if (probe === undefined) continue;
    const entry: ProbeStateCoverage = {
      state: tuple.state,
      viewport: tuple.viewport,
      colorScheme: tuple.colorScheme,
      status: probe.status,
      ...(probe.status === "timed-out" ||
      probe.stateReachTimeout !== undefined ||
      tuple.failure?.timeout !== undefined
        ? { stateTimedOut: true }
        : {}),
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
    // A dismissal is counted once, on the row of the state that tested it.
    const dismissalReasons = new Map<string, number>();
    let dismissalTested = 0;
    let dismissalNotReached = 0;
    for (const result of probe.results) {
      const dismissal = result.dismissal;
      if (dismissal === undefined || result.reusedFrom !== undefined) continue;
      if (dismissal.status === "not-applicable") continue;
      if (dismissal.status !== "not-reached") dismissalTested += 1;
      if (dismissal.status === "tested") continue;
      dismissalNotReached += 1;
      const reason =
        normalizeReason(
          dismissal.reason ??
            dismissal.tests.find((test) => test.outcome === "not-reached")
              ?.reason ??
            "",
        ) || "unknown";
      dismissalReasons.set(reason, (dismissalReasons.get(reason) ?? 0) + 1);
    }
    if (dismissalTested + dismissalNotReached > 0) {
      const topDismissal = topReason(dismissalReasons);
      entry.dismissal = {
        tested: dismissalTested,
        notReached: dismissalNotReached,
        ...(topDismissal === undefined ? {} : { topNotReached: topDismissal }),
      };
    }
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
  let dismissalTested = 0;
  let dismissalNotReached = 0;
  for (const entry of states) {
    dismissalTested += entry.dismissal?.tested ?? 0;
    dismissalNotReached += entry.dismissal?.notReached ?? 0;
    totals.completed += entry.completed;
    totals.skipped += entry.skipped;
    totals.timedOut += entry.timedOut;
    totals.notReached += entry.notReached;
  }
  totals.candidates =
    totals.completed + totals.skipped + totals.timedOut + totals.notReached;
  const withDismissal: ProbeCoverage["totals"] = states.some(
    (entry) => entry.dismissal !== undefined,
  )
    ? { ...totals, dismissalTested, dismissalNotReached }
    : totals;
  const notReachedShare =
    totals.candidates === 0 ? 0 : totals.notReached / totals.candidates;
  const coverage: ProbeCoverage = {
    flowBudgetMs: options.flowBudgetMs,
    states,
    totals: withDismissal,
    notReachedShare,
  };
  const budgetStates = states.filter((entry) => !noStateEvidence(entry));
  const budgetNotReached = budgetStates.reduce(
    (sum, entry) => sum + entry.notReached,
    0,
  );
  const budgetCandidates = budgetStates.reduce(
    (sum, entry) =>
      sum + entry.completed + entry.skipped + entry.timedOut + entry.notReached,
    0,
  );
  if (
    budgetCandidates > 0 &&
    budgetNotReached / budgetCandidates > WARNING_SHARE
  ) {
    const lead = `${budgetNotReached} of ${budgetCandidates} probe candidates (${Math.round((budgetNotReached / budgetCandidates) * 100)}%) were not reached`;
    coverage.warning =
      options.flowBudgetMs === 0
        ? `${lead} with no flow target applied; the not-reached reasons name the limit that stopped them.`
        : `${lead}${options.flowBudgetMs === undefined ? "" : ` within the ${options.flowBudgetMs / 1000}s probe target`}. Raise checks.probe.flowBudgetMs or pass --probe-budget <ms> (0 = no target).`;
  }
  return coverage;
}

function dismissalPhrase(
  tested: number,
  notReached: number,
  top?: { reason: string; count: number } | undefined,
): string {
  return `; dismissal: ${tested} tested, ${notReached} not reached${top === undefined ? "" : ` ("${top.reason}" ×${top.count})`}`;
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
    header: `Probe coverage (${targetPhrase(coverage.flowBudgetMs)}): ${totals.completed} completed, ${totals.timedOut} timed out, ${totals.notReached} not reached of ${totals.candidates} candidates${totals.dismissalTested === undefined ? "" : dismissalPhrase(totals.dismissalTested, totals.dismissalNotReached ?? 0)}`,
    states: coverage.states.map((entry) => {
      const name = stateLabels?.[entry.state] ?? entry.state;
      const label =
        (seen.get(entry.state) ?? 0) > 1
          ? `${name} (${entry.viewport}${entry.colorScheme === undefined ? "" : `, ${entry.colorScheme}`})`
          : name;
      if (noStateEvidence(entry))
        return `Probe produced no evidence for ${label}: the state timed out. Re-run on an idle host.`;
      const top = entry.topNotReached;
      return `${label}: ${entry.completed} completed, ${entry.timedOut} timed out, ${entry.notReached} not reached${entry.skipped > 0 ? `, ${entry.skipped} skipped` : ""}${top === undefined ? "" : ` — top not-reached reason: "${top.reason}" (×${top.count})`}${entry.dismissal === undefined ? "" : dismissalPhrase(entry.dismissal.tested, entry.dismissal.notReached, entry.dismissal.topNotReached)}`;
    }),
    warning: coverage.warning,
  };
}

function noStateEvidence(entry: ProbeStateCoverage): boolean {
  return (
    entry.completed === 0 &&
    entry.stateTimedOut === true &&
    !(entry.skipped > 0 && entry.timedOut === 0 && entry.notReached === 0)
  );
}
