import { tupleCoordinateKey } from "../baseline/coordinate.js";
import type { Finding } from "../schemas/finding.js";
import {
  affectedCounts,
  comparePriority,
  type ImpactReason,
  type IssueRankingContext,
  scoreGroup,
} from "./ranking.js";

/** Score the original target, with neutral geometry when that exact tuple is unavailable. */
export function findingScore(
  finding: Finding,
  context?: IssueRankingContext,
  counts = affectedCounts([tupleCoordinateKey(finding)], context),
): number {
  return findingRank(finding, context, counts).score;
}

/** Score and impact tier of one finding's original target. */
export function findingRank(
  finding: Finding,
  context?: IssueRankingContext,
  counts: {
    states: number;
    places: number;
    viewports?: number | undefined;
  } = affectedCounts([tupleCoordinateKey(finding)], context),
): { score: number; impact: 0 | 1; impactReasons: ImpactReason[] } {
  const selector = finding.verification.params?.selector;
  const { score, impact, impactReasons } = scoreGroup(
    {
      category: finding.category,
      rule: finding.rule,
      selector:
        typeof selector === "string"
          ? selector
          : finding.verification.locus?.target.selector,
      coordinates: [tupleCoordinateKey(finding)],
    },
    counts,
    context,
  );
  return { score, impact, impactReasons };
}

/** Stable on a complete tie; does not mutate the stored finding order. */
export function orderFindings(
  findings: readonly Finding[],
  context: IssueRankingContext,
): Finding[] {
  return findings
    .map((finding) => ({
      finding,
      severity: finding.severity,
      ...findingRank(finding, context),
    }))
    .sort(comparePriority)
    .map((item) => item.finding);
}
