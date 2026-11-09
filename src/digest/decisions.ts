import { tupleCoordinateKey } from "../baseline/coordinate.js";
import { latestAcknowledgement } from "../decisions/acknowledgements.js";
import {
  type IdentifiedDecision,
  sourceKey,
} from "../decisions/attribution.js";
import { acknowledgements, judgments } from "../decisions/log.js";
import type { ReviewCatalog } from "../review/catalog.js";
import type { SuppressedFinding } from "../review/findings.js";
import { lineageDecision } from "../review/lifecycle.js";
import type { Finding } from "../schemas/finding.js";
import type { AppliedDecision } from "./record.js";

/** Snapshot only decisions that actually applied to these deterministic occurrences. */
export function appliedDecisions(options: {
  catalog: ReviewCatalog;
  identified: IdentifiedDecision[];
  occurrences: Finding[];
  suppressed: SuppressedFinding[];
}): AppliedDecision[] {
  const entries = options.identified.map((entry) => entry.record);
  const decisions = judgments(entries);
  const acks = acknowledgements(entries);
  const byRecord = new Map(
    options.identified.map((entry) => [entry.record, entry.source]),
  );
  const applied = new Map<string, AppliedDecision>();
  for (const finding of options.occurrences) {
    const lineage = options.catalog.lineages.find((candidate) =>
      candidate.fingerprints.includes(finding.fingerprint),
    );
    const target = lineage ?? {
      id: finding.id,
      ids: [finding.id],
      fingerprints: [finding.fingerprint],
    };
    const suppressed =
      finding.status === "rejected"
        ? options.suppressed.find(
            (item) =>
              item.finding.fingerprint === finding.fingerprint &&
              tupleCoordinateKey(item.finding) === tupleCoordinateKey(finding),
          )
        : undefined;
    const judgment = suppressed
      ? suppressed.source === "rule"
        ? undefined
        : suppressed.decision
      : finding.status === "rejected"
        ? undefined
        : lineageDecision(target, decisions, { finding });
    const ack = finding.acknowledgement
      ? latestAcknowledgement(target, acks)
      : undefined;
    for (const record of [judgment, ack]) {
      if (!record || record.decision === "unacknowledge") continue;
      const source = byRecord.get(record);
      if (!source) continue;
      const key = sourceKey(source);
      let snapshot = applied.get(key);
      if (!snapshot) {
        snapshot = {
          source,
          decision: record.decision,
          actor: record.actor,
          ...(record.agent === undefined ? {} : { agent: record.agent }),
          occurrences: [],
        };
        applied.set(key, snapshot);
      }
      const occurrence = {
        fingerprint: finding.fingerprint,
        where: tupleCoordinateKey(finding),
      };
      if (
        !snapshot.occurrences.some(
          (item) =>
            item.fingerprint === occurrence.fingerprint &&
            item.where === occurrence.where,
        )
      )
        snapshot.occurrences.push(occurrence);
    }
  }
  return [...applied.values()];
}

export type DecisionCounts = {
  available: boolean;
  human: { accept: number; reject: number; acknowledge: number };
  agent: { accept: number; reject: number; acknowledge: number };
  unattributed: { accept: number; reject: number; acknowledge: number };
};
export function countAppliedDecisions(
  snapshots: AppliedDecision[] | undefined,
  effective?: IdentifiedDecision[],
): DecisionCounts {
  const blank = () => ({ accept: 0, reject: 0, acknowledge: 0 });
  const counts = {
    available: snapshots !== undefined,
    human: blank(),
    agent: blank(),
    unattributed: blank(),
  };
  const current = new Map(
    effective?.map((entry) => [sourceKey(entry.source), entry.record]),
  );
  const seen = new Set<string>();
  for (const snapshot of snapshots ?? []) {
    const key = sourceKey(snapshot.source);
    if (seen.has(key)) continue;
    seen.add(key);
    const actor = current.get(key)?.actor ?? snapshot.actor;
    counts[actor === "human" || actor === "agent" ? actor : "unattributed"][
      snapshot.decision
    ] += 1;
  }
  return counts;
}
