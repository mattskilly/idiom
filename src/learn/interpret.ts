/**
 * What a human observation maps onto. Sizes, wording and mirrored pairs map
 * onto existing deterministic checks; anything else becomes a design-law
 * ruling. Deterministic on purpose: the human confirms the exact diff, so the
 * same words must always produce the same draft.
 */
export type Interpretation =
  | { kind: "component"; subject: string; width: number; height: number }
  | {
      kind: "invariant";
      subject: string;
      width?: number | undefined;
      height?: number | undefined;
    }
  | { kind: "glossary"; term: string; preferred: string }
  | {
      kind: "mirrored";
      subjects: [string, string];
      axis: "vertical" | "horizontal";
    }
  | { kind: "ruling" };

const lead = String.raw`^(?:the\s+)?(.+?)\s+(?:should|must|needs?\s+to)\s+be\s+`;
const number = String.raw`(\d+(?:\.\d+)?)\s*(?:px)?`;
const componentPattern = new RegExp(
  `${lead}${number}(?:\\s*[x×]\\s*${number})?\\s*(?:square|wide and tall)?\\.?$`,
  "i",
);
const invariantPattern = new RegExp(
  `${lead}${number}\\s+(tall|high|wide)\\.?$`,
  "i",
);
const glossaryPatterns = [
  /(?:say|use|call it)\s+"([^"]+)"\s*,?\s+(?:not|instead of)\s+"([^"]+)"/i,
  /"([^"]+)"\s+should\s+(?:be|say|read)\s+"([^"]+)"/i,
];
const mirroredPattern =
  /^(?:the\s+)?(.+?)\s+and\s+(?:the\s+)?(.+?)\s+should\s+(?:mirror|match|be\s+mirrored)(?:\s+each\s+other)?(?:\s+(horizontally|vertically))?\.?$/i;

const stopWords = new Set(["the", "a", "an", "this", "that", "these", "those"]);

export function interpretObservation(text: string): Interpretation {
  const observation = text.trim().replace(/\s+/g, " ");
  const invariant = invariantPattern.exec(observation);
  if (invariant?.[1] !== undefined && invariant[2] !== undefined) {
    const value = Number(invariant[2]);
    return {
      kind: "invariant",
      subject: invariant[1].trim(),
      ...(/wide/i.test(invariant[3] ?? "")
        ? { width: value }
        : { height: value }),
    };
  }
  const component = componentPattern.exec(observation);
  if (component?.[1] !== undefined && component[2] !== undefined) {
    const width = Number(component[2]);
    return {
      kind: "component",
      subject: component[1].trim(),
      width,
      height: component[3] === undefined ? width : Number(component[3]),
    };
  }
  const [say, should] = glossaryPatterns.map((pattern) =>
    pattern.exec(observation),
  );
  if (say?.[1] !== undefined && say[2] !== undefined)
    return { kind: "glossary", term: say[2], preferred: say[1] };
  if (should?.[1] !== undefined && should[2] !== undefined)
    return { kind: "glossary", term: should[1], preferred: should[2] };
  const mirrored = mirroredPattern.exec(observation);
  if (mirrored?.[1] !== undefined && mirrored[2] !== undefined)
    return {
      kind: "mirrored",
      subjects: [mirrored[1].trim(), mirrored[2].trim()],
      axis:
        mirrored[3]?.toLowerCase() === "horizontally"
          ? "horizontal"
          : "vertical",
    };
  return { kind: "ruling" };
}

function singularWord(word: string): string {
  if (/ies$/i.test(word) && word.length > 3) return `${word.slice(0, -3)}y`;
  if (/sses$/i.test(word)) return word.slice(0, -2);
  if (/[^siu]s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** Singularise the last word of a noun phrase: "override dots" → "override dot". */
export function singularize(phrase: string): string {
  const words = phrase.trim().split(/\s+/);
  const last = words.pop();
  return last === undefined ? phrase : [...words, singularWord(last)].join(" ");
}

/** Lowercase, singular content words of a subject phrase. */
export function subjectTokens(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "" && !stopWords.has(word))
    .map(singularWord);
}
