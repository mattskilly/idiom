import type { Precedent } from "./precedent.js";

/**
 * Deterministic precedent matching: IDF-weighted term overlap between a
 * question and each precedent, scored by cosine. No model, so the same
 * store always gives the same answer.
 */

/** A precedent below this score is not a match at all. */
export const MATCH_FLOOR = 0.15;
/** The top match must reach this to settle a question by itself. */
export const DECISIVE_THRESHOLD = 0.35;
/** Any other match at or above this is conflicting precedent. */
export const CONFLICT_THRESHOLD = 0.25;
/** A match shares at least this many terms with the question. */
export const MIN_SHARED_TERMS = 2;
/** How many shared terms a match lists as its reason. */
const SHOWN_TERMS = 6;

/** English function words and question scaffolding: never evidence. */
const STOP_WORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "both",
  "build",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "each",
  "either",
  "for",
  "from",
  "get",
  "had",
  "has",
  "have",
  "having",
  "here",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "let",
  "may",
  "me",
  "might",
  "more",
  "most",
  "must",
  "my",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "on",
  "one",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "per",
  "please",
  "same",
  "should",
  "so",
  "some",
  "spec",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "ticket",
  "to",
  "too",
  "use",
  "uses",
  "used",
  "using",
  "very",
  "via",
  "want",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "yes",
  "you",
  "your",
]);

/** One term per word: lowercase, stop words dropped, plurals folded. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !STOP_WORDS.has(word))
    .map((word) => {
      if (word.length <= 3) return word;
      if (/(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
      if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
      return word;
    })
    .filter((word) => !STOP_WORDS.has(word));
}

export type Match = Precedent & {
  /** Cosine of the IDF-weighted term sets, 0 to 1. */
  score: number;
  /** The heaviest terms question and precedent share: why it matched. */
  sharedTerms: string[];
  /** How many identical precedents this one stands for. */
  copies: number;
};

const normalise = (text: string) => tokenize(text).join(" ");

/**
 * Identical precedents (a batch of rejections sharing one reason) are one
 * precedent, so two copies of the same answer never read as a conflict. The
 * newest copy stands for the rest.
 */
export function mergeIdentical(
  corpus: readonly Precedent[],
): Array<Precedent & { copies: number }> {
  const merged = new Map<string, Precedent & { copies: number }>();
  for (const precedent of corpus) {
    const key = `${precedent.stance ?? ""}\0${normalise(precedent.matchText)}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...precedent, copies: 1 });
      continue;
    }
    const copies = existing.copies + 1;
    merged.set(
      key,
      newer(precedent, existing)
        ? { ...precedent, copies }
        : { ...existing, copies },
    );
  }
  return [...merged.values()];
}

const time = (precedent: Precedent) =>
  precedent.at === undefined ? 0 : Date.parse(precedent.at) || 0;
const newer = (a: Precedent, b: Precedent) => time(a) > time(b);

/** Every precedent scoring at or above the floor, best first. */
export function rankMatches(
  question: string,
  corpus: readonly Precedent[],
): Match[] {
  const precedents = mergeIdentical(corpus).map((precedent) => ({
    precedent,
    terms: new Set(tokenize(precedent.matchText)),
  }));
  const documents = precedents.length;
  const frequency = new Map<string, number>();
  for (const { terms } of precedents)
    for (const term of terms)
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
  // A term no precedent uses still weighs on the question's side.
  const weight = (term: string) =>
    Math.log(1 + documents / Math.max(1, frequency.get(term) ?? 0));
  const norm = (terms: Set<string>) =>
    Math.sqrt([...terms].reduce((sum, term) => sum + weight(term) ** 2, 0));

  const asked = new Set(tokenize(question));
  const askedNorm = norm(asked);
  const matches: Match[] = [];
  for (const { precedent, terms } of precedents) {
    const shared = [...terms].filter((term) => asked.has(term));
    if (shared.length < MIN_SHARED_TERMS) continue;
    const dot = shared.reduce((sum, term) => sum + weight(term) ** 2, 0);
    const denominator = askedNorm * norm(terms);
    const score = denominator === 0 ? 0 : dot / denominator;
    if (score < MATCH_FLOOR) continue;
    matches.push({
      ...precedent,
      score: Math.round(score * 1000) / 1000,
      sharedTerms: shared
        .sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))
        .slice(0, SHOWN_TERMS),
    });
  }
  return matches.sort(
    (a, b) =>
      b.score - a.score || time(b) - time(a) || a.id.localeCompare(b.id),
  );
}

export type Verdict =
  | { decisive: Match }
  | { open: string; closest?: Match | undefined };

/**
 * Decisive when one clear match settles the question: the top match reaches
 * the decisive threshold and no other reaches the conflict threshold.
 */
export function verdictFor(matches: readonly Match[]): Verdict {
  const [top, ...rest] = matches;
  if (top === undefined) return { open: "no precedent" };
  if (top.score < DECISIVE_THRESHOLD)
    return { open: "below threshold", closest: top };
  const rival = rest.find((match) => match.score >= CONFLICT_THRESHOLD);
  if (rival !== undefined)
    return {
      open: `conflicting precedent: ${rival.id}`,
      closest: top,
    };
  return { decisive: top };
}
