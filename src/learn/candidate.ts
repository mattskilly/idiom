import type { Checkable, LearnedCandidate } from "../schemas/learned.js";
import type { DraftInterpretation } from "./draft.js";
import { singularize } from "./interpret.js";

/** Words that say the human is comparing against a reference design. */
const REFERENCE_WORDS =
  /\b(?:figma|mock(?:-?up)?s?|design files?|references?|as designed|(?:like|match(?:es)?) the design|specs?)\b/i;

/** A sentence: whitespace collapsed, capitalised, ending in a stop. */
export function sentence(observation: string): string {
  const trimmed = observation.trim().replace(/\s+/g, " ");
  const capitalised = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

function size(width: number | undefined, height: number | undefined): string {
  if (width !== undefined && height !== undefined)
    return width === height ? `${width}×${width}px` : `${width}×${height}px`;
  if (width !== undefined) return `${width}px wide`;
  return `${height ?? 0}px tall`;
}

/** Ruling checkability: against a reference when the words name one. */
export function rulingCheckable(observation: string): Checkable {
  return REFERENCE_WORDS.test(observation) ? "reference" : "judged";
}

/**
 * The generalised rule an observation suggests, from fixed templates, and
 * how it could be checked: the measured kinds are deterministic, a ruling is
 * judged, or needs a reference when the words compare against one.
 */
export function candidateFor(
  interpretation: DraftInterpretation,
  observation: string,
  wording?: string | undefined,
): LearnedCandidate {
  switch (interpretation.kind) {
    case "component":
      return {
        rule: `Every ${singularize(interpretation.subject).toLowerCase()} is ${size(interpretation.width, interpretation.height)}.`,
        kind: "component",
        checkable: "deterministic",
      };
    case "invariant":
      return {
        rule: `The ${interpretation.subject} ${singularize(interpretation.subject) === interpretation.subject ? "is" : "are"} ${size(interpretation.width, interpretation.height)}.`,
        kind: "invariant",
        checkable: "deterministic",
      };
    case "brief-invariants":
      return {
        rule: interpretation.invariants
          .map((invariant) => invariant.name)
          .join("; "),
        kind: "invariant",
        checkable: "deterministic",
      };
    case "glossary":
      return {
        rule: `Say "${interpretation.preferred}", not "${interpretation.term}".`,
        kind: "glossary",
        checkable: "deterministic",
      };
    case "mirrored": {
      const [first, second] = interpretation.subjects;
      return {
        rule: `The ${first} and the ${second} mirror ${interpretation.axis === "horizontal" ? "horizontally" : "vertically"}.`,
        kind: "mirrored",
        checkable: "deterministic",
      };
    }
    case "law":
      return {
        rule: sentence(observation),
        kind: "law",
        checkable: "deterministic",
      };
    case "ruling":
      return {
        rule: wording?.trim() || sentence(observation),
        kind: "ruling",
        checkable: rulingCheckable(observation),
      };
  }
}
