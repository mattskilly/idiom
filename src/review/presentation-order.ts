import { tupleCoordinateKey } from "../baseline/coordinate.js";
import type { Finding } from "../schemas/finding.js";
import {
  affectedCounts,
  comparePriority,
  type IssueRankingContext,
  scoreGroup,
} from "./ranking.js";

/** Score the original target, with neutral geometry when that exact tuple is unavailable. */
export function findingScore(
  finding: Finding,
  context?: IssueRankingContext,
  counts = affectedCounts([tupleCoordinateKey(finding)], context),
): number {
  const selector = finding.verification.params?.selector;
  return scoreGroup(
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
  ).score;
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
      score: findingScore(finding, context),
    }))
    .sort(comparePriority)
    .map((item) => item.finding);
}
