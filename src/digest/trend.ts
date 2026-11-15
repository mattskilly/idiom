import { join } from "node:path";
import {
  type DecisionViews,
  decisionViews,
  isFingerprintSuppressed,
  readDecisionLog,
} from "../decisions/log.js";
import { loadFlowRecords } from "./build.js";
import type { DigestCoverageProblem, DigestRecord } from "./record.js";

/** How many complete full-scope runs a trend line spans. */
export const TREND_RUNS = 5;

export type TrendCoverageGap = {
  /** Distinct tuples the run's coverage problems name. */
  missing: number;
  selected: number;
  kinds: Array<DigestCoverageProblem["kind"]>;
};

export type TrendPoint = {
  runId: string;
  completedAt: string;
  commit: string;
  dirty: boolean;
  blocker: number;
  major: number;
  minor: number;
  /** Present when the run had coverage problems: its counts are not comparable. */
  coverageGap?: TrendCoverageGap;
};

export type FlowTrend = { flow: string; runs: TrendPoint[] };

const emptyViews = (): DecisionViews => decisionViews([]);

function rejectedNow(
  occurrence: DigestRecord["occurrences"][number],
  views: DecisionViews,
): boolean {
  if (isFingerprintSuppressed(occurrence.fingerprint, views)) return true;
  return views.byFindingId.get(occurrence.id)?.decision === "reject";
}

function coverageGap(record: DigestRecord): TrendCoverageGap | undefined {
  const problems = record.coverage.problems;
  if (problems.length === 0) return undefined;
  const keys = new Set<string>();
  problems.forEach((problem, index) => {
    if (problem.where !== undefined) keys.add(problem.where);
    else if (problem.tuples !== undefined && problem.tuples.length > 0)
      for (const tuple of problem.tuples) keys.add(tuple);
    else keys.add(`#problem-${index}`);
  });
  const kinds = [...new Set(problems.map((problem) => problem.kind))];
  return { missing: keys.size, selected: record.coverage.selected, kinds };
}

/**
 * One run's open design counts. Acknowledged and rejected occurrences are
 * excluded, and so is anything the current decision log rejects (a later
 * rejection applies to older runs too). Tuple failures and info never count.
 */
export function trendPoint(
  record: DigestRecord,
  views: DecisionViews,
): TrendPoint {
  const counts = { blocker: 0, major: 0, minor: 0 };
  for (const occurrence of record.occurrences) {
    if (occurrence.disposition !== "open") continue;
    if (occurrence.coverageOnly === true) continue;
    if (occurrence.severity === "info") continue;
    if (rejectedNow(occurrence, views)) continue;
    counts[occurrence.severity] += 1;
  }
  const gap = coverageGap(record);
  return {
    runId: record.runId,
    completedAt: record.completedAt,
    commit: record.commit,
    dirty: record.dirty,
    ...counts,
    ...(gap === undefined ? {} : { coverageGap: gap }),
  };
}

const newestFirst = (left: DigestRecord, right: DigestRecord) =>
  right.completedAt.localeCompare(left.completedAt) ||
  right.runId.localeCompare(left.runId);

/** The newest `limit` full-scope runs of `flow`, oldest first. */
export function flowTrend(
  flow: string,
  records: readonly DigestRecord[],
  views: DecisionViews,
  limit: number = TREND_RUNS,
): FlowTrend {
  const window = records
    .filter((record) => record.flow === flow && record.scope === "full")
    .sort(newestFirst)
    .slice(0, limit)
    .reverse();
  return { flow, runs: window.map((record) => trendPoint(record, views)) };
}

/**
 * Trends from stored digest records: one per requested flow, or one per flow
 * with records (sorted by id). Flows with no full-scope run are skipped.
 * Never reads anything but digest records and the decision log.
 */
export async function loadTrends(options: {
  projectDirectory: string;
  /** Defaults to `<projectDirectory>/.idiom/reports`. */
  reports?: string | undefined;
  flows?: readonly string[] | undefined;
}): Promise<FlowTrend[]> {
  const records = await loadFlowRecords(
    options.reports ?? join(options.projectDirectory, ".idiom", "reports"),
  );
  const views = await readDecisionLog(options.projectDirectory)
    .then(decisionViews)
    .catch(emptyViews);
  const flows = options.flows ?? [...records.keys()].sort();
  return flows
    .map((flow) => flowTrend(flow, records.get(flow) ?? [], views))
    .filter((trend) => trend.runs.length > 0);
}

function gapText(gap: TrendCoverageGap): string {
  return gap.kinds.length === 1 && gap.kinds[0] === "busy-host"
    ? `coverage gap: ${gap.missing} of ${gap.selected} tuples deferred (busy host) — not comparable`
    : `coverage gap: ${gap.missing} of ${gap.selected} tuples missing — not comparable`;
}

/** Text lines for a trend; none for fewer than two runs (a point is not a line). */
export function renderTrend(trend: FlowTrend | undefined): string[] {
  if (trend === undefined || trend.runs.length < 2) return [];
  return [
    `Trend for ${trend.flow} (last ${trend.runs.length} runs, oldest first; open blocker/major/minor, acknowledged and rejected excluded):`,
    ...trend.runs.map((run) => {
      const commit = `${run.commit.slice(0, 7)}${run.dirty ? " (dirty)" : ""}`;
      const counts = `${run.blocker}/${run.major}/${run.minor}`;
      const gap =
        run.coverageGap === undefined ? "" : `  ${gapText(run.coverageGap)}`;
      return `  ${run.completedAt.slice(0, 10)} ${commit}  ${counts}${gap}`;
    }),
  ];
}
