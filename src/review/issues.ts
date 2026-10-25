import type { Finding } from "../schemas/finding.js";
import { normalizeSelectorHint } from "./fingerprint.js";

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
};

type IssueGroup = {
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
): CheckIssue[] {
  const buckets = new Map<string, G[]>();
  for (const group of groups) {
    const key = JSON.stringify([
      group.category,
      group.rule,
      group.selector === undefined
        ? ["group", group.id]
        : ["selector", siblingPattern(group.selector)],
    ]);
    const bucket = buckets.get(key) ?? [];
    bucket.push(group);
    buckets.set(key, bucket);
  }
  return (
    [...buckets.values()]
      .map((bucket): CheckIssue => {
        const example = bucket[0] as G;
        return {
          id: example.id,
          severity: bucket.reduce(
            (worst, group) =>
              severityOrder[group.severity] < severityOrder[worst]
                ? group.severity
                : worst,
            example.severity,
          ),
          category: example.category,
          ...(example.rule === undefined ? {} : { rule: example.rule }),
          groups: bucket.map((group) => group.id),
          elements: bucket.length,
          places: new Set(bucket.flatMap((group) => group.coordinates)).size,
          findings: bucket.reduce(
            (sum, group) => sum + group.members.length,
            0,
          ),
          primaryAction: bucket.some(
            (group) =>
              group.selector !== undefined && primary.has(group.selector),
          ),
          ...(bucket.every((group) => group.deferred === true)
            ? { deferred: true }
            : {}),
        };
      })
      // Stable sort preserves input order for ties, and group order within issues.
      .sort(
        (left, right) =>
          severityOrder[left.severity] - severityOrder[right.severity] ||
          right.places - left.places ||
          Number(right.primaryAction) - Number(left.primaryAction),
      )
  );
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
