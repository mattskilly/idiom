import type { Finding } from "../schemas/finding.js";
import { normalizeSelectorHint } from "./fingerprint.js";
import {
  affectedCounts,
  comparePriority,
  type IssueRankingContext,
  type RankingExplanation,
  ruleFamily,
  scoreGroup,
} from "./ranking.js";
import type { RootCause } from "./root-causes.js";

/** Presentation heuristic only; never used for finding identity or decisions. */
export function siblingPattern(selector: string): string {
  return normalizeSelectorHint(selector).replace(
    /:nth-(?:of-type|child)\(\s*\d+\s*\)|\[(?:\\.|[^\]\\])*\]|#[A-Za-z0-9_-]+/g,
    (token) =>
      token.startsWith("[")
        ? token.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (value) =>
            value.replace(/\d+/g, "#"),
          )
        : token.replace(/\d+/g, "#"),
  );
}

export type CheckIssue = {
  basis?: Finding["basis"] | undefined;
  basisDetails?: Finding["basisDetails"] | undefined;
  acceptance?: Finding["acceptance"] | undefined;
  salience: number;
  prominence: number;
  score: number;
  explanation: RankingExplanation;
  rules: string[];
  family?: string | undefined;
  id: string;
  severity: Finding["severity"];
  category: string;
  rule?: string | undefined;
  groups: string[];
  elements: number;
  places: number;
  findings: number;
  primaryAction: boolean;
  deferred?: true | undefined;
  /** Set when the issue's groups share one source (root-causes.ts). */
  rootCause?: RootCause | undefined;
};

type IssueGroup = {
  basis?: Finding["basis"] | undefined;
  basisDetails?: Finding["basisDetails"] | undefined;
  acceptance?: Finding["acceptance"] | undefined;
  id: string;
  severity: Finding["severity"];
  category: string;
  rule?: string | undefined;
  selector?: string | undefined;
  coordinates: string[];
  members: unknown[];
  deferred?: true | undefined;
};

const severityOrder = { blocker: 0, major: 1, minor: 2 } as const;

export function collapseIssues<G extends IssueGroup>(
  groups: G[],
  primary: ReadonlySet<string>,
  context?: IssueRankingContext,
): CheckIssue[] {
  const buckets = new Map<string, G[]>();
  for (const group of groups) {
    const family =
      group.selector === undefined
        ? undefined
        : ruleFamily(group.category, group.rule);
    const key = JSON.stringify([
      group.category,
      family ?? group.rule,
      family !== undefined
        ? ["family", family]
        : group.selector === undefined
          ? ["group", group.id]
          : ["selector", siblingPattern(group.selector)],
    ]);
    const bucket = buckets.get(key) ?? [];
    bucket.push(group);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((bucket): CheckIssue => {
      const counts = affectedCounts(
        bucket.flatMap((group) => group.coordinates),
        context,
      );
      const ranked = bucket.map((group) => ({
        group,
        ranking: scoreGroup(group, counts, context),
      }));
      const winner = [...ranked].sort(
        (left, right) =>
          right.ranking.score - left.ranking.score ||
          severityOrder[left.group.severity] -
            severityOrder[right.group.severity],
      )[0] as (typeof ranked)[number];
      const example = winner.group;
      const rules = [
        ...new Set(
          bucket.flatMap((group) =>
            group.rule === undefined ? [] : [group.rule],
          ),
        ),
      ];
      return {
        id: example.id,
        ...(example.basis === undefined
          ? {}
          : {
              basis: example.basis,
              basisDetails: example.basisDetails,
              acceptance: example.acceptance,
            }),
        severity: bucket.reduce(
          (worst, group) =>
            severityOrder[group.severity] < severityOrder[worst]
              ? group.severity
              : worst,
          example.severity,
        ),
        category: example.category,
        ...(rules.length === 1 ? { rule: rules[0] } : {}),
        rules,
        family: ruleFamily(example.category, example.rule),
        salience: winner.ranking.salience,
        prominence: winner.ranking.prominence,
        score: winner.ranking.score,
        explanation: winner.ranking.explanation,
        groups: [
          example.id,
          ...bucket
            .filter((group) => group !== example)
            .map((group) => group.id),
        ],
        elements: bucket.length,
        places: counts.places,
        findings: bucket.reduce((sum, group) => sum + group.members.length, 0),
        primaryAction:
          context !== undefined
            ? ranked.some(({ ranking }) => ranking.primaryAction)
            : bucket.some(
                (group) =>
                  group.selector !== undefined && primary.has(group.selector),
              ),
        ...(bucket.every((group) => group.deferred === true)
          ? { deferred: true }
          : {}),
      };
    })
    .sort(comparePriority);
}

export function categoryCounts(
  issues: CheckIssue[],
  groupsById: ReadonlyMap<string, Pick<IssueGroup, "category" | "members">>,
): Array<{ category: string; issues: number; findings: number }> {
  const counts = new Map<
    string,
    { category: string; issues: number; findings: number }
  >();
  for (const issue of issues) {
    const count = counts.get(issue.category) ?? {
      category: issue.category,
      issues: 0,
      findings: 0,
    };
    count.issues += 1;
    count.findings += issue.groups.reduce(
      (sum, id) => sum + (groupsById.get(id)?.members.length ?? 0),
      0,
    );
    counts.set(issue.category, count);
  }
  return [...counts.values()].sort(
    (left, right) =>
      right.findings - left.findings ||
      left.category.localeCompare(right.category),
  );
}
