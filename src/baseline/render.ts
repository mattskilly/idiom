import type { AcknowledgementLapse } from "../decisions/acknowledgements.js";
import { basisDescription } from "../findings/presentation.js";
import type { BaselineComparisonSummary, SummaryFinding } from "./summary.js";

export function baselineStaleWarning(
  baseline: BaselineComparisonSummary["baseline"],
): string | undefined {
  return baseline.stale === undefined
    ? undefined
    : `Warning: baseline ${baseline.commit.slice(0, 12)} was recorded with a different checks configuration — possibly stale; re-record on main. ${baseline.stale.reason}`;
}
/**
 * Findings tracked elsewhere and acknowledgements that lapsed; empty when
 * there are neither, so output without acknowledgements is unchanged.
 */
export function acknowledgementLines(
  acknowledged: readonly SummaryFinding[],
  lapses: readonly AcknowledgementLapse[],
): string[] {
  return [
    ...(acknowledged.length === 0
      ? []
      : [
          `Acknowledged (not counted): ${acknowledged.length}`,
          ...acknowledged.map(
            (finding) =>
              `- ${finding.id} [${finding.severity}] ${finding.category} — ${finding.where}${finding.selector === undefined ? "" : ` — ${finding.selector}`} — acknowledged (${finding.acknowledged?.reference ?? "unknown"})${finding.acknowledged?.until === undefined ? "" : ` until ${finding.acknowledged.until}`}`,
          ),
        ]),
    ...lapses.map((lapse) => lapse.message),
  ];
}

export function renderFindingDetails(findings: SummaryFinding[]): string[] {
  return findings.flatMap((finding, index) => [
    `${index + 1}. [${finding.severity}] ${finding.category} — ${finding.where}${finding.selector === undefined ? "" : ` — ${finding.selector}`}`,
    `   Basis: ${basisDescription(finding)}`,
    `   Problem: ${finding.problem}`,
    ...finding.fix.map((line) => `   Done when: ${line}`),
    ...(finding.screenshot === undefined
      ? []
      : [`   Evidence: ${finding.screenshot}`]),
    ...(finding.deferred === true || finding.occurrenceOnly === true
      ? []
      : [
          `   Decide: idiom decide --finding ${finding.id} --accept|--reject --reason "…"`,
        ]),
    "",
  ]);
}
export function renderBaselineComparison(
  summary: BaselineComparisonSummary,
): string {
  const { baseline } = summary;
  const warning = baselineStaleWarning(baseline);
  const acknowledgements = acknowledgementLines(
    summary.acknowledgedFindings ?? [],
    summary.acknowledgementLapses ?? [],
  );
  const compact = (finding: {
    severity: string;
    category: string;
    where: string;
    selector?: string | undefined;
  }) =>
    `- [${finding.severity}] ${finding.category} — ${finding.where}${finding.selector === undefined ? "" : ` — ${finding.selector}`}`;
  return [
    `Baseline: ${baseline.commit.slice(0, 12)} (${baseline.distance} commit(s) behind HEAD, recorded ${baseline.recordedAt})`,
    ...(warning === undefined ? [] : [warning]),
    `${summary.findings.length} new, ${summary.fixed.length} fixed, ${summary.preExisting} pre-existing, ${summary.blocking} blocking`,
    "",
    `New (${summary.findings.length}):`,
    ...renderFindingDetails(summary.findings),
    `Fixed since baseline (${summary.fixed.length}):`,
    ...summary.fixed.map(compact),
    "",
    `Pre-existing (${summary.preExisting}):`,
    ...summary.preExistingFindings.map(compact),
    ...(baseline.uncoveredTuples.length === 0
      ? []
      : [
          "",
          `Uncovered tuples (no fixes inferred): ${baseline.uncoveredTuples.join(", ")}`,
        ]),
    ...(acknowledgements.length === 0 ? [] : ["", ...acknowledgements]),
  ].join("\n");
}
