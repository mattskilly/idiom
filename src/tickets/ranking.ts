import { tupleCoordinateKey } from "../baseline/coordinate.js";
import type { CatalogFinding } from "../review/catalog.js";
import { findingRank } from "../review/presentation-order.js";
import { affectedCounts, comparePriority } from "../review/ranking.js";
import type { FindingCluster } from "./cluster.js";

/** Ephemeral scores from the complete current-run issue projection, keyed by member ID. */
export type TicketScores = ReadonlyMap<string, number>;

export function rankClusters(
  clusters: FindingCluster[],
  scores?: TicketScores,
): FindingCluster[] {
  return clusters
    .map((cluster) => {
      const counts = affectedCounts(
        cluster.members.map((member) =>
          tupleCoordinateKey(member.record.finding),
        ),
      );
      const ranks = cluster.members.map((member) => {
        const rank = findingRank(member.record.finding, undefined, counts);
        return {
          severity: member.record.finding.severity,
          impact: rank.impact,
          score: scores?.get(member.id) ?? rank.score,
        };
      });
      const severity = [...ranks].sort(comparePriority)[0]?.severity ?? "minor";
      return {
        cluster,
        severity,
        impact: Math.max(...ranks.map((rank) => rank.impact)),
        score: Math.max(...ranks.map((rank) => rank.score)),
      };
    })
    .sort(
      (a, b) =>
        comparePriority(a, b) || a.cluster.key.localeCompare(b.cluster.key),
    )
    .map((item) => item.cluster);
}

/** Deduplicated legacy records keep selected-record order on a complete tie. */
export function rankTicketRecords(records: CatalogFinding[]): CatalogFinding[] {
  return records
    .map((record) => ({
      record,
      severity: record.finding.severity,
      ...findingRank(record.finding),
    }))
    .sort(comparePriority)
    .map((item) => item.record);
}
