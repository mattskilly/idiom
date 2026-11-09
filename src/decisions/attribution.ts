import { createHash } from "node:crypto";
import { IdiomError } from "../errors.js";
import type {
  DecisionLogEntry,
  OrdinaryDecision,
} from "../schemas/decision.js";

export type DecisionSource = { line: number; sha256: string };
export type IdentifiedDecision<T = OrdinaryDecision> = {
  source: DecisionSource;
  record: T;
};
export function lineHash(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}
export const sourceKey = (source: DecisionSource) =>
  `${source.line}:${source.sha256}`;

/** Project metadata onto its original event, without changing judgment order. */
export function effectiveAttribution(
  raw: readonly IdentifiedDecision<DecisionLogEntry>[],
  path: string,
): IdentifiedDecision[] {
  const originals = new Map<number, IdentifiedDecision>();
  for (const entry of raw) {
    const correction = entry.record;
    if (correction.decision !== "reattribute") {
      originals.set(entry.source.line, {
        source: entry.source,
        record: correction,
      });
      continue;
    }
    const target = originals.get(correction.target.line);
    if (
      !target ||
      correction.target.line >= entry.source.line ||
      target.source.sha256 !== correction.target.sha256 ||
      target.record.commit !== correction.commit ||
      target.record.findingId !== correction.findingId ||
      target.record.fingerprint !== correction.fingerprint
    )
      throw new IdiomError(
        `invalid decision log ${path} at line ${entry.source.line}: reattribution target is missing or mismatched`,
      );
    const { agent: _agent, ...record } = target.record;
    target.record = {
      ...record,
      actor: correction.actor,
      ...(correction.actor === "agent" && correction.agent
        ? { agent: correction.agent }
        : {}),
    };
  }
  return [...originals.values()];
}
