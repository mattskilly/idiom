import { tupleCoordinateKey } from "../baseline/coordinate.js";
import type { SummaryFinding } from "../baseline/summary.js";
import type { Finding } from "../schemas/finding.js";
import {
  type FindingGroup,
  groupRepeatedFindings,
  memberCoordinates,
} from "./groups.js";
import { collapseIssues } from "./issues.js";
import type { IssueRankingContext } from "./ranking.js";
import { rootCauseIssues } from "./root-causes.js";

/** One element failing one rule, wherever it repeats (#52). */
export type CheckGroup = {
  id: string;
  severity: Finding["severity"];
  category: Finding["category"];
  rule?: string | undefined;
  where: string;
  selector?: string | undefined;
  problem: string;
  fix: string[];
  screenshot?: string | undefined;
  /** Every member is past the review's attention cap. */
  deferred?: true | undefined;
  members: Array<{
    id: string;
    severity: Finding["severity"];
    where: string;
    deferred?: true | undefined;
    /** tupleCoordinateKey strings: state/viewport[/scheme][#combination]. */
    coordinates: string[];
  }>;
  coordinates: string[];
  states: string[];
  viewports: string[];
  colorSchemes: string[];
  combinations?: string[] | undefined;
};

export function projectIssueSummary(options: {
  findings: Finding[];
  groups: FindingGroup[];
  summaries: Map<string, SummaryFinding>;
  deferredIds?: Set<string>;
  primaryActionSelectors?: string[] | undefined;
  rankingContext?: IssueRankingContext | undefined;
}) {
  const {
    findings: live,
    groups: sourceGroups,
    summaries,
    deferredIds = new Set<string>(),
  } = options;
  const groups = groupRepeatedFindings(
    live,
    memberCoordinates(sourceGroups),
    deferredIds,
  ).map((group): CheckGroup => {
    const representative = summaries.get(
      group.representative,
    ) as SummaryFinding;
    return {
      id: group.id,
      severity: group.severity,
      category: representative.category,
      ...(group.rule === undefined ? {} : { rule: group.rule }),
      where: representative.where,
      ...(representative.selector === undefined
        ? {}
        : { selector: representative.selector }),
      problem: representative.problem,
      fix: representative.fix,
      ...(representative.screenshot === undefined
        ? {}
        : { screenshot: representative.screenshot }),
      ...(group.members.every((member) => member.deferred === true)
        ? { deferred: true }
        : {}),
      members: group.members.map((member) => ({
        id: member.id,
        severity: member.severity,
        where: summaries.get(member.id)?.where ?? member.state,
        ...(member.deferred === true ? { deferred: true } : {}),
        coordinates: member.coordinates.map(tupleCoordinateKey),
      })),
      coordinates: group.coordinates.map(tupleCoordinateKey),
      states: group.states,
      viewports: group.viewports,
      colorSchemes: group.colorSchemes,
      ...(group.combinations === undefined
        ? {}
        : { combinations: group.combinations }),
    };
  });
  const primary = new Set(options.primaryActionSelectors ?? []);
  return {
    groups,
    // Root causes need per-element evidence; without it, family issues.
    issues:
      options.rankingContext === undefined
        ? collapseIssues(groups, primary)
        : rootCauseIssues(
            groups,
            new Map(live.map((finding) => [finding.id, finding])),
            primary,
            options.rankingContext,
          ),
  };
}
