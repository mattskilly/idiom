import { summarizeFinding } from "../baseline/summary.js";
import { IdiomError } from "../errors.js";
import type { CatalogFinding } from "../review/catalog.js";
import {
  affectedCounts,
  comparePriority,
  type IssueRankingTuple,
  scoreGroup,
} from "../review/ranking.js";
import { rootCauseIssues } from "../review/root-causes.js";
import { type CheckGroup, projectIssueSummary } from "../review/summary.js";
import {
  componentFor,
  type FindingCluster,
  groupFindings,
  observationLoader,
} from "../tickets/cluster.js";
import type { SweepFlowResult, SweepProposal } from "./types.js";

export const qualified = (flow: string, local: string) =>
  JSON.stringify([flow, local]);

/** Keep public coordinates and canonical findings unchanged; qualify only the ranking view. */
export async function groupSweep(
  flows: SweepFlowResult[],
): Promise<SweepProposal[]> {
  const context = new Map<string, IssueRankingTuple>();
  const groups: CheckGroup[] = [];
  const groupFlows = new Map<string, string>();
  const records: CatalogFinding[] = [];
  for (const { flow, review, records: source } of flows) {
    records.push(...source);
    for (const [key, tuple] of review.issueRankingContext ?? [])
      context.set(qualified(flow, key), {
        ...tuple,
        state: qualified(flow, tuple.state),
      });
    const projected = projectIssueSummary({
      findings: source.map((r) => r.finding),
      groups: review.groups,
      summaries: new Map(
        source.map((r) => [
          r.finding.id,
          summarizeFinding(r.finding, review, review.runDirectory),
        ]),
      ),
    });
    for (const group of projected.groups) {
      const id = qualified(flow, group.id);
      groupFlows.set(id, flow);
      groups.push({
        ...group,
        id,
        coordinates: group.coordinates.map((c) => qualified(flow, c)),
        members: group.members.map((m) => ({
          ...m,
          coordinates: m.coordinates.map((c) => qualified(flow, c)),
        })),
      });
    }
  }
  const findings = new Map(records.map((r) => [r.finding.id, r.finding]));
  const issues = rootCauseIssues(groups, findings, new Set(), context, {
    groupFlows,
  });
  const causes = new Map(
    issues.flatMap((issue) => {
      const cause = issue.rootCause;
      if (cause === undefined) return [];
      return cause.symptoms.flatMap((symptom) =>
        symptom.findings.map(
          (f) => [f.id, { ...cause, symptoms: cause.counts.symptoms }] as const,
        ),
      );
    }),
  );
  const load = observationLoader();
  const members = await Promise.all(
    records.map(async (record) => ({
      id: record.finding.id,
      record,
      component: componentFor(record, record.finding.id, await load(record)),
      cause: causes.get(record.finding.id),
    })),
  );
  const severity = { blocker: 0, major: 1, minor: 2 };
  return groupFindings(members)
    .map((cluster: FindingCluster): SweepProposal => {
      const ids = new Set(cluster.members.map((m) => m.id));
      const matching = groups.filter((g) =>
        g.members.some((m) => ids.has(m.id)),
      );
      const causeIssue = issues.find(
        (i) =>
          i.rootCause?.id === cluster.cause?.id && cluster.cause !== undefined,
      );
      const counts = affectedCounts(
        matching.flatMap((g) => g.coordinates),
        context,
      );
      const ranked = matching
        .map((g) => ({
          ...scoreGroup(g, counts, context),
          severity: g.severity,
        }))
        .sort(
          (a, b) =>
            b.score - a.score || severity[a.severity] - severity[b.severity],
        );
      const winner = causeIssue ?? ranked[0];
      const first = cluster.members[0];
      if (winner === undefined || first === undefined)
        throw new IdiomError("cannot rank an empty sweep cluster");
      return {
        id: cluster.key,
        cluster,
        findingIds: [...ids],
        severity: cluster.members.reduce(
          (worst, m) =>
            severity[m.record.finding.severity] < severity[worst]
              ? m.record.finding.severity
              : worst,
          first.record.finding.severity,
        ),
        salience: winner.salience,
        prominence: winner.prominence,
        score: winner.score,
        explanation: winner.explanation,
      };
    })
    .sort((a, b) => comparePriority(a, b) || a.id.localeCompare(b.id));
}
