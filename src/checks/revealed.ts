import type { CheckTuple, FindingCandidate, RevealedState } from "./types.js";

export type RevealedTuple = {
  /** The tuple the probe opened the disclosure on. */
  parent: CheckTuple;
  revealed: RevealedState;
  /** The revealed observation as a tuple of its own, for the checks. */
  tuple: CheckTuple;
};

/**
 * Every observed revealed state on a tuple's probe results, as a synthetic
 * tuple carrying the revealed observation. Nested results already carry
 * `parent › item` names, so a flat walk covers mode switches too.
 */
export function revealedTuples(tuple: CheckTuple): RevealedTuple[] {
  const observation = tuple.observations;
  if (observation?.version !== 2) return [];
  const tuples: RevealedTuple[] = [];
  for (const result of observation.probe?.results ?? []) {
    const revealed = result.revealed;
    if (
      revealed?.status !== "observed" ||
      revealed.observations === undefined ||
      result.reusedFrom !== undefined
    )
      continue;
    tuples.push({
      parent: tuple,
      revealed,
      tuple: {
        ...tuple,
        observations: { ...revealed.observations, probe: undefined },
        screenshotPath: undefined,
        timelines: undefined,
        filmstrips: undefined,
        axe: undefined,
        design: undefined,
        designs: undefined,
        console: [],
      },
    });
  }
  return tuples;
}

/**
 * Rules that judge an artifact of how the probe opened the state rather
 * than the state itself: the pointer click leaves focus on the trigger,
 * where a pointer user sees no focus ring.
 */
export const revealedIgnoredRules = new Set(["idiom:focus-ring-collision"]);

/** Identity used to tell a revealed defect from one the page already had. */
export function revealedKey(candidate: FindingCandidate): string {
  return `${candidate.rule}\0${candidate.fingerprintHint ?? candidate.selectorHint}`;
}

/**
 * A revealed candidate attributed to the tuple that opened it: the
 * explanation names `<state> › <disclosure>`, the fingerprint is scoped by
 * the disclosure, and verification data carries the attribution.
 */
export function scopeRevealedCandidate(
  parent: CheckTuple,
  revealed: RevealedState,
  candidate: FindingCandidate,
): FindingCandidate {
  return {
    ...candidate,
    explanation: `${parent.state} › ${revealed.name}: ${candidate.explanation}`,
    fingerprintHint: `revealed ${revealed.name} | ${candidate.fingerprintHint ?? candidate.selectorHint}`,
    verification: {
      ...candidate.verification,
      params: {
        ...candidate.verification.params,
        revealed: {
          state: parent.state,
          disclosure: revealed.name,
          kind: revealed.kind,
        },
      },
    },
  };
}

/**
 * Whether `ancestor` is a revealed state this one was reached through:
 * "Attach" for "Attach › Link".
 */
export function revealedAncestor(ancestor: string, name: string): boolean {
  return ancestor !== name && name.startsWith(`${ancestor} › `);
}
