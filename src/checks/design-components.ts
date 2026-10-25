import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChecksSettings, Project } from "../schemas/project.js";

/**
 * A component size stated in prose ("override dots … about 8px", "chips 24px
 * high"). The selector is resolved at capture from class or aria-label words.
 */
export type InferredComponent = {
  name: string;
  words: string[];
  width?: number;
  height?: number;
  /** Where it was stated, e.g. "DESIGN.md:12". */
  source: string;
};

/** The explicit schema's default tolerance, used for inferred specs too. */
export const inferredTolerance = {
  ratio: 0.15,
  px: 1,
  mode: "tighter",
} as const;

/** Observe input for one inferred component (see `observePage`). */
export type InferredComponentInput = {
  name: string;
  words: string[];
  width: number | undefined;
  height: number | undefined;
  source: string;
  tolerance: { ratio: number; px: number; mode: "tighter" | "looser" };
};

const maxInferred = 20;

const plural = (word: string) =>
  word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word);

/** Singularise one lowercase word ("dots" → "dot", "entries" → "entry"). */
export function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  return plural(word) ? word.slice(0, -1) : word;
}

/** Lowercased, singular words of a component name ("Override dots"). */
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word !== "")
    .map(singular);
}

const fillers = new Set([
  "are",
  "is",
  "be",
  "should",
  "must",
  "about",
  "around",
  "roughly",
  "approximately",
  "approx",
  "at",
  "measure",
  "measures",
  "render",
  "renders",
  "always",
  "exactly",
  "just",
  "only",
  "~",
  "…",
  "—",
  "–",
  "-",
  ":",
]);
const stopwords = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "with",
  "in",
  "on",
  "for",
  "to",
  "by",
  "least",
  "most",
  "than",
  "under",
  "over",
  "up",
  "minimum",
  "maximum",
  "min",
  "max",
]);
const pronouns = new Set(["they", "these", "those"]);
/** Design vocabulary: names made only of these are token tables, not components. */
const vocabulary = new Set(
  "spacing gap padding margin radius font text size sizing dimension line height width border grid base step scale unit type body letter weight shadow hit area target".split(
    " ",
  ),
);
/** Head nouns where a bare "8px" plausibly means both axes. */
const roundHeads = new Set([
  "dot",
  "circle",
  "avatar",
  "swatch",
  "indicator",
  "icon",
]);

const sizePattern =
  /(?<![\w.-])(\d+(?:\.\d+)?)(?:\s*px)?(?:\s*[×x]\s*(\d+(?:\.\d+)?))?\s*px\b(?:\s+(high|tall|wide))?/gi;

const tokens = (text: string) =>
  text
    .replace(/\.\.\./g, " … ")
    .replace(/[*_`"'“”‘’]/g, " ")
    .replace(/([,:~…—–])/g, " $1 ")
    .split(/\s+/)
    .filter((token) => token !== "");

const letterWord = /^[a-z]+(?:-[a-z]+)*$/i;

/** "Override dots mark …" → ["override", "dots"]: up to the first plural. */
function antecedent(before: string): string[] {
  const sentence = before.split(/[.!?]/).at(-1) ?? "";
  const words: string[] = [];
  for (const token of tokens(
    sentence.replace(/^\s*(?:[#>*+-]+|\d+\.)\s*/, ""),
  )) {
    const word = token.toLowerCase();
    if (!letterWord.test(word) || stopwords.has(word) || words.length === 3)
      return [];
    words.push(...word.split("-"));
    if (plural(word)) return words;
  }
  return [];
}

/** The 1–3 words naming the thing a size phrase is about. */
function nameBefore(before: string): string[] {
  const clause = before.split(/[.;!?|()[\]{}]/).at(-1) ?? "";
  const list = tokens(clause);
  const words: string[] = [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const token = list[index] ?? "";
    const word = token.toLowerCase();
    if (words.length === 0 && fillers.has(word)) continue;
    if (words.length === 0 && pronouns.has(word))
      return antecedent(
        before.slice(0, before.toLowerCase().lastIndexOf(word)),
      );
    if (!letterWord.test(word) || stopwords.has(word) || fillers.has(word))
      break;
    words.unshift(...word.split("-"));
    if (words.length >= 3) break;
  }
  return words.slice(-3);
}

/**
 * Size statements next to a name in a design document, with their line.
 * Fenced blocks (including idiom-ruling blocks) are skipped; token tables and
 * type scales are rejected by the design-vocabulary stoplist.
 */
export function inferDesignComponents(
  markdown: string,
  file: string,
): InferredComponent[] {
  const found = new Map<string, InferredComponent>();
  let fenced = false;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(sizePattern)) {
      const [, first, second, axis] = match;
      const words = nameBefore(line.slice(0, match.index)).map((word) =>
        singular(word.toLowerCase()),
      );
      if (
        words.length === 0 ||
        words.some((word) => word.length < 3) ||
        words.every((word) => vocabulary.has(word))
      )
        continue;
      const value = Number(first);
      let size: { width?: number; height?: number };
      if (second !== undefined) size = { width: value, height: Number(second) };
      else if (axis === "wide") size = { width: value };
      else if (axis !== undefined) size = { height: value };
      else if (roundHeads.has(words.at(-1) ?? ""))
        size = { width: value, height: value };
      else continue;
      if (!(value > 0) || (size.height !== undefined && !(size.height > 0)))
        continue;
      const name = words.join(" ");
      if (found.has(name)) continue;
      found.set(name, { name, words, ...size, source: `${file}:${index + 1}` });
      if (found.size === maxInferred) return [...found.values()];
    }
  }
  return [...found.values()];
}

/** Explicit checks.components win over an inferred spec with the same name. */
export function mergeInferredComponents(
  explicit: ChecksSettings["components"],
  inferred: InferredComponent[],
): InferredComponent[] {
  const names = new Set(
    explicit.map((component) => nameWords(component.name).join(" ")),
  );
  return inferred.filter((component) => !names.has(component.words.join(" ")));
}

/** Read the project's design file and infer its stated component sizes. */
export async function loadDesignComponents(
  projectDirectory: string,
  project: Pick<Project, "design" | "checks">,
): Promise<InferredComponent[]> {
  const file = project.design.designFile;
  let markdown: string;
  try {
    markdown = await readFile(join(projectDirectory, file), "utf8");
  } catch {
    return [];
  }
  return mergeInferredComponents(
    project.checks.components,
    inferDesignComponents(markdown, file),
  );
}

/** Observe input for inferred components, with the default tolerance. */
export function inferredComponentInputs(
  inferred: InferredComponent[] | undefined,
): InferredComponentInput[] {
  return (inferred ?? []).map((component) => ({
    name: component.name,
    words: component.words,
    width: component.width,
    height: component.height,
    source: component.source,
    tolerance: { ...inferredTolerance },
  }));
}
