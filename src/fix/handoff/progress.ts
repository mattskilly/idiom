import { compareOccurrences } from "../compare.js";
import type {
  HandoffFinding,
  HandoffOutcome,
  HandoffProgress,
  HandoffRound,
} from "./types.js";

const occurrence = (finding: HandoffFinding) => ({
  key: finding.key,
  fingerprint: finding.fingerprint ?? `${finding.rule}\0${finding.selector}`,
  aliases: [] as string[],
  id: finding.id,
});

/**
 * What one round did to the previous round's targets: which cleared, which
 * remain, and which blocking findings are new. Findings are compared by
 * coordinate and fingerprint, never by bare id.
 */
export function roundProgress(
  previous: { targets: HandoffFinding[]; blocking: HandoffFinding[] },
  current: HandoffFinding[],
): HandoffProgress {
  const before = previous.targets.map(occurrence);
  const after = current.map(occurrence);
  const targets = compareOccurrences(before, after);
  const blocking = compareOccurrences(previous.blocking.map(occurrence), after);
  return {
    fixed: targets.fixed.map((item) => item.id),
    persisting: before
      .filter((item) => !targets.fixed.includes(item))
      .map((item) => item.id),
    introduced: blocking.introduced.map((item) => item.id),
  };
}

/**
 * A round whose findings describe HEAD after its outcome is applied: any
 * gate run except a skip and a re-verify whose edits were reverted.
 */
export const keptRound = (round: HandoffRound) =>
  round.next !== "skip" && round.outcome !== "revert";

/**
 * The step's commit rule, decided here so the loop and the summary agree
 * with it: keep a repair round's edits only when they fixed at least one
 * target and introduced no blocking finding. A round that leaves nothing
 * blocking is always kept.
 */
export function roundOutcome(
  progress: HandoffProgress,
  blocking: number,
): HandoffOutcome {
  if (blocking === 0) return "commit";
  return progress.fixed.length > 0 && progress.introduced.length === 0
    ? "commit"
    : "revert";
}
