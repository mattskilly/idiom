import { singularize } from "../learn/interpret.js";
import { evidenceCatches } from "../learn/misses.js";
import type { LearnedEntry } from "../schemas/learned.js";

/** What one recorded occurrence of an Idiom problem says. */
export type ProblemOccurrence = {
  state: string;
  rule?: string | undefined;
  category: string;
  groupKey?: string | undefined;
  problem: string;
};

export type MatchableProblem = {
  flow: string;
  occurrences: readonly ProblemOccurrence[];
};

export type MatchVia = "rule" | "selector" | "words";
export type Match = { via: MatchVia; detail: string };

/** Minimum shared content words, and the share of the observation's. */
export const WORDS_MIN_SHARED = 2;
export const WORDS_MIN_SHARE = 0.6;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "these",
  "those",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "but",
  "not",
  "its",
  "it's",
  "from",
  "into",
  "onto",
  "than",
  "then",
  "too",
  "very",
  "should",
  "would",
  "could",
  "can",
  "does",
  "doe",
  "when",
  "there",
  "their",
  "they",
  "them",
  "our",
  "out",
  "all",
  "any",
  "use",
  "one",
]);

/** Lowercase, singular content words: three letters or more, no stop words. */
export function contentTokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
        .map((word) => singularize(word))
        .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
    ),
  ];
}

function ruleMatch(
  entry: LearnedEntry,
  occurrence: ProblemOccurrence,
): string | undefined {
  if (occurrence.state !== entry.state) return undefined;
  const caught = evidenceCatches(entry, {
    rule: occurrence.rule ?? "",
    category: occurrence.category,
  });
  if (caught !== undefined) return caught;
  const check = entry.target.check;
  return check !== undefined &&
    (check === occurrence.rule || check === occurrence.category)
    ? check
    : undefined;
}

function selectorMatch(
  entry: LearnedEntry,
  occurrence: ProblemOccurrence,
): string | undefined {
  for (const raw of [entry.target.selector, entry.target.scope]) {
    const selector = raw?.trim();
    if (selector === undefined || selector.length < 2) continue;
    if (
      occurrence.groupKey?.includes(selector) === true ||
      occurrence.problem.includes(selector)
    )
      return selector;
  }
  return undefined;
}

function wordsMatch(
  observation: readonly string[],
  occurrence: ProblemOccurrence,
  state: string,
): string | undefined {
  if (occurrence.state !== state || observation.length === 0) return undefined;
  const problem = new Set(contentTokens(occurrence.problem));
  const shared = observation.filter((word) => problem.has(word));
  return shared.length >= WORDS_MIN_SHARED &&
    shared.length / observation.length >= WORDS_MIN_SHARE
    ? shared.join(", ")
    : undefined;
}

/**
 * Whether a learned entry and an Idiom problem are the same UI problem: the
 * same flow, then the first of rule, selector, or words that holds.
 */
export function matchEntry(
  entry: LearnedEntry,
  problem: MatchableProblem,
): Match | undefined {
  if (entry.flow !== problem.flow) return undefined;
  for (const occurrence of problem.occurrences) {
    const detail = ruleMatch(entry, occurrence);
    if (detail !== undefined) return { via: "rule", detail };
  }
  for (const occurrence of problem.occurrences) {
    const detail = selectorMatch(entry, occurrence);
    if (detail !== undefined) return { via: "selector", detail };
  }
  const observation = contentTokens(entry.observation);
  for (const occurrence of problem.occurrences) {
    const detail = wordsMatch(observation, occurrence, entry.state);
    if (detail !== undefined) return { via: "words", detail };
  }
  return undefined;
}
