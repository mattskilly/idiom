import type { CheckTuple, FindingCandidate, RevealedState } from "./types.js";

export type RevealedTuple = {
  /** The tuple the probe opened the disclosure on. */
  parent: CheckTuple;
  revealed: RevealedState;
  /** The revealed observation as a tuple of its own, for the checks. */
  tuple: CheckTuple;
};

type RevealedKind = RevealedState["kind"];

/** What an unnamed disclosure is called, by what it opened. */
const unnamed: Record<RevealedKind, string> = {
  details: "unnamed details",
  popup: "unnamed popup",
  expanded: "unnamed panel",
  // The menu a mode-switch item sat in, when its own kind is not recorded.
  mode: "unnamed menu",
};

/**
 * A revealed state's name a person can read. A disclosure with no
 * accessible name was recorded as `""` by earlier versions; each blank
 * `›` segment becomes a fallback named for what it opened: the last
 * segment of a mode switch is the item, the rest are the disclosure
 * (`parentKind` when the caller knows it). Named segments are untouched.
 */
export function revealedLabel(
  name: string,
  kind: RevealedKind,
  parentKind?: Exclude<RevealedKind, "mode">,
): string {
  const segments = name.split(" › ");
  const last = segments.length - 1;
  return segments
    .map((segment, index) => {
      if (segment.trim() !== "") return segment;
      if (kind !== "mode") return unnamed[kind];
      if (index === last && last > 0) return "unnamed item";
      return unnamed[parentKind ?? "mode"];
    })
    .join(" › ");
}

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
      revealed: {
        ...revealed,
        name: revealedLabel(revealed.name, revealed.kind),
      },
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
