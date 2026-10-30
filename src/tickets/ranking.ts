import { tupleCoordinateKey } from "../baseline/coordinate.js";
import type { CatalogFinding } from "../review/catalog.js";
import { findingScore } from "../review/presentation-order.js";
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
      const ranks = cluster.members.map((member) => ({
        severity: member.record.finding.severity,
        score:
          scores?.get(member.id) ??
          findingScore(member.record.finding, undefined, counts),
      }));
      const severity = [...ranks].sort(comparePriority)[0]?.severity ?? "minor";
      return {
        cluster,
        severity,
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
      score: findingScore(record.finding),
    }))
    .sort(comparePriority)
    .map((item) => item.record);
}
