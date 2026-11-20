import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { IdiomError } from "../errors.js";
import type { BriefReference } from "../schemas/project.js";

/**
 * `idiom brief research "<request>"`: the comparable products a request is
 * measured against, chosen deterministically from the project's list, and the
 * acceptance criteria their measurements propose. No model, no network here;
 * capture lives in comparable-research.ts and measure.ts.
 */

/** The PRODUCT.md heading whose bullets list comparable products. */
export const COMPARABLES_HEADING = "Comparable products";

export const MIN_COMPARABLES = 2;
export const MAX_COMPARABLES = 3;

const STOPWORDS = new Set([
  "a",
  "add",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "change",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "its",
  "make",
  "new",
  "of",
  "on",
  "or",
  "our",
  "should",
  "so",
  "that",
  "the",
  "their",
  "this",
  "to",
  "update",
  "use",
  "we",
  "when",
  "with",
]);

/** Naive singular: chips → chip, menus → menu, entries → entry; `ss` stays. */
export function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ches|shes|sses|xes)$/.test(word))
    return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(singular);
}

/** The request's content words, singular, deduplicated, in request order. */
export function requestTerms(request: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of tokens(request)) {
    if (STOPWORDS.has(token) || token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

export type ParsedComparables = {
  references: BriefReference[];
  warnings: string[];
};

function publicUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/**
 * The `## Comparable products` section of PRODUCT.md:
 *
 *   - [always] Name | https://example.com | why it sets the bar
 *     - surface words | https://example.com/equivalent-screen
 *
 * The tier tag is optional (default `bar`), as are the URL and the note.
 * HTML comments are ignored, so the template's commented example seeds nothing.
 */
export function parseProductComparables(markdown: string): ParsedComparables {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^##\s+comparable products\s*#*\s*$/i.test(line.trim()),
  );
  const references: BriefReference[] = [];
  const warnings: string[] = [];
  if (start === -1) return { references, warnings };
  let current: BriefReference | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const top = /^[-*+]\s+(.*)$/.exec(line);
    const sub = /^\s+[-*+]\s+(.*)$/.exec(line);
    if (top !== null) {
      let text = (top[1] ?? "").trim();
      let tier = "bar";
      const tag = /^\[([^\]]+)\]\s*(.*)$/.exec(text);
      if (tag !== null) {
        const candidate = (tag[1] ?? "").trim().toLowerCase();
        if (/^[a-z][a-z0-9-]*$/.test(candidate)) tier = candidate;
        else warnings.push(`ignored tier ${JSON.stringify(tag[1])}`);
        text = (tag[2] ?? "").trim();
      }
      const fields = text.split("|").map((field) => field.trim());
      const name = fields.shift() ?? "";
      if (name === "") {
        current = undefined;
        continue;
      }
      let url: string | undefined;
      if (fields[0] !== undefined && looksLikeUrl(fields[0])) {
        const raw = fields.shift() as string;
        url = publicUrl(raw);
        if (url === undefined)
          warnings.push(`${name}: skipped invalid URL ${JSON.stringify(raw)}`);
      }
      const note = fields.filter((field) => field !== "").join(" | ");
      current = {
        name,
        tier,
        note: note === "" ? "listed in PRODUCT.md" : note,
        ...(url === undefined ? {} : { url }),
      };
      references.push(current);
    } else if (sub !== null && current !== undefined) {
      const [surface = "", raw = ""] = (sub[1] ?? "")
        .split("|")
        .map((field) => field.trim());
      const url = publicUrl(raw);
      if (surface === "" || url === undefined) {
        warnings.push(
          `${current.name}: skipped page ${JSON.stringify((sub[1] ?? "").trim())} (needs "surface | https://url")`,
        );
        continue;
      }
      current.pages = [...(current.pages ?? []), { surface, url }];
    }
  }
  return { references, warnings };
}

/** PRODUCT.md's comparables; none when the file is missing. */
export async function readProductComparables(
  projectDirectory: string,
  productFile: string,
): Promise<ParsedComparables> {
  let markdown: string;
  try {
    markdown = await readFile(join(projectDirectory, productFile), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR")
      return { references: [], warnings: [] };
    throw error;
  }
  return parseProductComparables(markdown);
}

export type ComparablePage = { url: string; surface?: string | undefined };

export type ComparableSelection = {
  name: string;
  tier: string;
  reason: string;
  /** The equivalent public screen; absent when the entry names none. */
  page?: ComparablePage | undefined;
  score: number;
};

function matched(terms: string[], text: string): string[] {
  const words = new Set(tokens(text));
  return terms.filter((term) => words.has(term));
}

function list(words: string[]): string {
  return words.join(", ");
}

/**
 * Two or three comparables for a request: `always` entries first, then by
 * words matched (a page surface counts double over the name and note), then
 * `bar` before other tiers, then list order. Fewer than two matches are
 * filled from the list so the request is always compared twice.
 */
export function selectComparables(
  references: BriefReference[],
  request: string,
  options: { max?: number | undefined } = {},
): { selections: ComparableSelection[]; warnings: string[] } {
  if (references.length === 0)
    throw new IdiomError(
      `no comparable products are listed. Add two or three to brief.references in .idiom/project.json, or under "## ${COMPARABLES_HEADING}" in PRODUCT.md, then rerun idiom brief research.`,
    );
  const warnings =
    references.length < MIN_COMPARABLES
      ? [
          `only one comparable product is listed; list at least ${MIN_COMPARABLES} so the criteria have a floor and a cap from different products`,
        ]
      : [];
  const max = options.max ?? MAX_COMPARABLES;
  const terms = requestTerms(request);
  const scored = references.map((reference, index) => {
    let bestPage: { page: ComparablePage; words: string[] } | undefined;
    for (const page of reference.pages ?? []) {
      const words = matched(terms, page.surface);
      if (bestPage === undefined || words.length > bestPage.words.length)
        bestPage = {
          page: { url: page.url, surface: page.surface },
          words,
        };
    }
    const nameWords = matched(terms, `${reference.name} ${reference.note}`);
    const pageWords = bestPage?.words ?? [];
    const score = 2 * pageWords.length + nameWords.length;
    let page: ComparablePage | undefined;
    if (bestPage !== undefined && pageWords.length > 0) page = bestPage.page;
    else if (reference.url !== undefined) page = { url: reference.url };
    else if (bestPage !== undefined) page = bestPage.page;
    const because: string[] = [];
    if (pageWords.length > 0)
      because.push(
        `its page "${bestPage?.page.surface}" matches ${list(pageWords)}`,
      );
    if (nameWords.length > 0)
      because.push(`its name or note matches ${list(nameWords)}`);
    return { reference, index, score, page, because };
  });
  const always = scored.filter((entry) => entry.reference.tier === "always");
  const rest = scored
    .filter((entry) => entry.reference.tier !== "always")
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.reference.tier === "bar") -
          Number(left.reference.tier === "bar") ||
        left.index - right.index,
    );
  const chosen: { entry: (typeof scored)[number]; reason: string }[] = [];
  for (const entry of always) {
    if (chosen.length >= max) break;
    chosen.push({
      entry,
      reason: ["tier always: always compared", ...entry.because].join("; "),
    });
  }
  for (const entry of rest) {
    if (chosen.length >= max) break;
    if (entry.score > 0)
      chosen.push({
        entry,
        reason: [`tier ${entry.reference.tier}`, ...entry.because].join("; "),
      });
    else if (chosen.length < MIN_COMPARABLES)
      chosen.push({
        entry,
        reason: `tier ${entry.reference.tier}; no request words matched, filled to reach ${MIN_COMPARABLES} comparables`,
      });
  }
  return {
    warnings,
    selections: chosen.map(({ entry, reason }) => ({
      name: entry.reference.name,
      tier: entry.reference.tier,
      reason,
      score: entry.score,
      ...(entry.page === undefined ? {} : { page: entry.page }),
    })),
  };
}

export type MeasuredProperty =
  | "width"
  | "height"
  | "radius"
  | "font size"
  | "item gap"
  | "gap"
  | "duration";

export type Measurement = {
  /** "selection toolbar", or "offset chip to selection toolbar" for a gap. */
  subject: string;
  property: MeasuredProperty;
  value: number;
  unit: "px" | "ms";
  /** Where it was measured: a CSS selector (two, joined, for a gap). */
  selector: string;
  url: string;
  viewport: string;
};

export type CriterionSource = {
  comparable: string;
  reference: string;
  value: number;
};

export type ProposedCriterion = {
  text: string;
  subject: string;
  property: MeasuredProperty;
  floor: number;
  cap: number;
  unit: "px" | "ms";
  /** True when one value (or equal values) was widened by ±10%. */
  widened: boolean;
  sources: CriterionSource[];
};

const PROPERTY_ORDER: MeasuredProperty[] = [
  "gap",
  "width",
  "height",
  "radius",
  "font size",
  "item gap",
  "duration",
];

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A gap's grouping key: the pair, independent of which side came first. */
function subjectKey(measurement: Measurement): string {
  if (measurement.property !== "gap") return measurement.subject;
  return measurement.subject.split(" to ").sort().join(" to ");
}

/**
 * Criteria with both bounds from the captured comparables: the smallest
 * measured value is the floor and the largest the cap; a single value (or
 * equal values) is widened by ±10%, at least 1, and says so.
 */
export function proposeCriteria(
  captured: {
    comparable: string;
    reference: string;
    measurements: Measurement[];
  }[],
): ProposedCriterion[] {
  const groups = new Map<
    string,
    {
      subject: string;
      property: MeasuredProperty;
      unit: "px" | "ms";
      order: number;
      sources: CriterionSource[];
    }
  >();
  let order = 0;
  for (const entry of captured)
    for (const measurement of entry.measurements) {
      const key = `${subjectKey(measurement)}\u0000${measurement.property}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          subject: measurement.subject,
          property: measurement.property,
          unit: measurement.unit,
          order: order++,
          sources: [],
        };
        groups.set(key, group);
      }
      if (group.sources.some((source) => source.reference === entry.reference))
        continue;
      group.sources.push({
        comparable: entry.comparable,
        reference: entry.reference,
        value: measurement.value,
      });
    }
  return [...groups.values()]
    .sort(
      (left, right) =>
        PROPERTY_ORDER.indexOf(left.property) -
          PROPERTY_ORDER.indexOf(right.property) || left.order - right.order,
    )
    .map((group) => {
      const values = group.sources.map((source) => source.value);
      let floor = Math.min(...values);
      let cap = Math.max(...values);
      const widened = floor === cap;
      if (widened) {
        const delta = Math.max(1, Math.round(floor * 0.1));
        floor = Math.max(0, floor - delta);
        cap += delta;
      }
      const unit = group.unit;
      const cited = group.sources
        .map(
          (source) =>
            `${source.comparable} ${formatNumber(source.value)}${unit}, ${source.reference}`,
        )
        .join("; ");
      const note = widened
        ? group.sources.length === 1
          ? "; one reference, ±10%"
          : "; equal values, ±10%"
        : "";
      return {
        text: `${capitalized(group.subject)} ${group.property} is at least ${formatNumber(floor)}${unit} and at most ${formatNumber(cap)}${unit} (${cited}${note}).`,
        subject: group.subject,
        property: group.property,
        floor,
        cap,
        unit,
        widened,
        sources: group.sources,
      };
    });
}
