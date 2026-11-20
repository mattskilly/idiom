import { unfenced } from "./gate.js";

/**
 * `idiom brief lint`: acceptance criteria that cap a size, time, count or
 * length with no floor or observable outcome. A build agent meets the number
 * and nothing else, so "at most 64px" alone invites negative word-spacing and
 * touching controls. Deterministic and model-free; docs/brief.md states the
 * rule these constants encode.
 */

export type LintCapKind = "size" | "time" | "count" | "length";

export type LintSuggestion = { text: string; source: string };

export type CriterionWarning = {
  criterion: string;
  /** 1-based: the item's line in a file, or the criterion's index in a brief. */
  line: number;
  cap: { kind: LintCapKind; text: string };
  suggestions: LintSuggestion[];
};

export type LintFile = {
  path: string;
  section: boolean;
  criteria: number;
  warnings: CriterionWarning[];
};

export type LintResult = {
  strict: boolean;
  warnings: number;
  files: LintFile[];
};

export type LintContext = {
  controlGapMin: number;
  targetSize: { fine: number; coarse: number; narrowBelow: number };
  rowWidth: number;
  /** Where rowWidth came from: `viewports` or `default`. */
  rowWidthSource: string;
  rulings: { id: string; wording: string }[];
};

export const DEFAULT_LINT_CONTEXT: LintContext = {
  controlGapMin: 4,
  targetSize: { fine: 24, coarse: 44, narrowBelow: 768 },
  rowWidth: 1024,
  rowWidthSource: "default",
  rulings: [],
};

/** At most this many ruling suggestions per warning. */
export const MAX_RULING_SUGGESTIONS = 3;

export type Criterion = {
  text: string;
  line: number;
  /** Sub-bullets (such as `Checked by Idiom:` lines); used for pairing only. */
  detail?: string | undefined;
};

/** Phrases that cap a number; each must govern a number in the same clause. */
export const CAP_PHRASES = [
  "at most",
  "no more than",
  "not more than",
  "up to",
  "max",
  "maximum",
  "max-width:",
  "≤",
  "<=",
  "under",
  "less than",
  "fewer than",
  "no wider/taller/longer/bigger/larger/higher than",
  "not exceed / never exceeds",
  "caps at",
  "capped at",
  "N … or fewer / or less",
  "within (time only)",
] as const;

/** Subjects that make a cap a fact about tooling, not UI. */
export const NON_UI_SUBJECTS = [
  "test",
  "suite",
  "spec run",
  "timeout",
  "times out",
  "CI",
  "build",
  "gate",
  "verify",
  "file",
  "commit",
  "PR",
  "lines of code",
  "LOC",
  "bytes",
  "KB",
  "MB",
  "GB",
  "token",
  "retry",
  "request",
  "call",
  "API",
  "endpoint",
  "process",
  "memory",
  "CPU",
  "query",
  "cache",
  "budget",
  "log",
  "dependency",
] as const;

/** Nouns that make a time, count or length cap a cap on UI. */
export const UI_NOUNS = [
  "toolbar",
  "chip",
  "button",
  "label",
  "text",
  "title",
  "heading",
  "menu",
  "row",
  "column",
  "card",
  "field",
  "input",
  "panel",
  "dialog",
  "modal",
  "sheet",
  "page",
  "screen",
  "viewport",
  "item",
  "icon",
  "tab",
  "list",
  "nav",
  "sidebar",
  "header",
  "footer",
  "layout",
  "gap",
  "padding",
  "margin",
  "font",
  "toast",
  "tooltip",
  "banner",
  "badge",
  "animation",
  "transition",
  "fade",
  "slide",
  "motion",
  "spinner",
  "skeleton",
  "loading",
  "render",
  "visible",
  "appear",
  "display",
] as const;

/** UI nouns too generic to tie a sibling criterion to a cap's subject. */
export const GENERIC_UI_NOUNS = [
  "item",
  "text",
  "page",
  "screen",
  "visible",
  "display",
] as const;

/** A floor or an observable outcome; either pairs a cap. */
export const PAIRING_PHRASES = {
  floor: [
    "at least",
    "minimum",
    "min",
    "≥",
    ">=",
    "no less than",
    "not less than",
    "no fewer than",
    "no narrower/shorter/smaller than",
  ],
  outcome: [
    "overlap",
    "touch",
    "one line",
    "single line",
    "one row",
    "single row",
    "stays on one",
    "wrap",
    "no wrap",
    "truncate",
    "clip",
    "fully visible",
    "legible",
    "readable",
    "word-spacing",
    "letter-spacing",
    "negative spacing",
    "gap between",
    "between items",
    "reachable",
    "complete",
    "end state",
  ],
} as const;

const SIZE_UNITS = "px|rem|em|%|vw|vh|pt";
const TIME_UNITS = "ms|seconds?|secs?|s|minutes?";
const LENGTH_UNITS = "characters?|chars?|words?";
const COUNT_NOUNS =
  "items?|rows?|lines?|buttons?|chips?|columns?|options?|actions?|tabs?|clicks?|steps?|entries|entry|results?";

const SIZE_UNIT = new RegExp(`^\\s*(?:${SIZE_UNITS})(?![\\w%])`, "i");
const TIME_UNIT = new RegExp(`^\\s*(?:${TIME_UNITS})(?![\\w%])`, "i");
const LENGTH_UNIT = new RegExp(`^\\s*(?:${LENGTH_UNITS})\\b`, "i");
const COUNT_UNIT = new RegExp(
  `^\\s+(?:[a-z-]+\\s+){0,2}?(?:${COUNT_NOUNS})\\b`,
  "i",
);
const DIMENSION_WORD =
  /\b(?:wide|wider|width|tall|taller|height|size)\b|\bmax-(?:width|height)\b/i;

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const APPROX = String.raw`(?:~\s*|about\s+|approx(?:imately|\.)?\s+|roughly\s+)?`;
const WORD_CAP = [
  String.raw`at\s+most`,
  String.raw`no\s+more\s+than`,
  String.raw`not\s+more\s+than`,
  String.raw`up\s+to`,
  String.raw`max-(?:width|height|inline-size|block-size)\s*:`,
  String.raw`max(?:imum)?(?:\s+of)?`,
  "under",
  String.raw`(?<!\b(?:no|not)\s+)less\s+than`,
  String.raw`(?<!\b(?:no|not)\s+)fewer\s+than`,
  String.raw`no\s+(?:wider|taller|longer|bigger|larger|higher)\s+than`,
  String.raw`(?:not|never)\s+exceeds?`,
  String.raw`exceeds?\s+no`,
  String.raw`caps?\s+at`,
  String.raw`capped\s+at`,
  "within",
].join("|");
const PHRASE_CAP = new RegExp(
  String.raw`(?:(?<![\w-])(?:${WORD_CAP})(?![\w-])|≤|<=)\s*${APPROX}${NUMBER}`,
  "gi",
);
const OR_FEWER_CAP = new RegExp(
  String.raw`(?<![\w.])${NUMBER}((?:\s*[a-z%]+){0,3}?)\s+or\s+(?:fewer|less)\b`,
  "gi",
);

function wordsPattern(words: readonly string[], plural: boolean): RegExp {
  const alternatives = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .map((word) => word.replace(/ /g, "\\s+"));
  return new RegExp(
    `(?<![\\w-])(?:${alternatives.join("|")})${plural ? "(?:s|es)?" : ""}(?![\\w])`,
    "i",
  );
}

const NON_UI =
  /(?<![\w-])(?:tests?|testing|suites?|spec\s+runs?|timeouts?|times?\s+out|timed\s+out|ci|builds?|gates?|verify|files?|commits?|prs?|lines\s+of\s+code|loc|bytes|kb|mb|gb|tokens?|retry|retries|requests?|calls?|apis?|endpoints?|process(?:es)?|memory|cpu|quer(?:y|ies)|cache[sd]?|budgets?|logs?|dependenc(?:y|ies))(?![\w])/i;
const UI_NOUN = wordsPattern(UI_NOUNS, true);
const FLOOR =
  /(?<![\w-])(?:at\s+least|minimum|min(?:-(?:width|height))?|no\s+less\s+than|not\s+less\s+than|no\s+fewer\s+than|no\s+(?:narrower|shorter|smaller)\s+than)(?![\w-])|≥|>=/i;
const OUTCOME =
  /(?<![\w])(?:overlap\w*|touch(?:es|ing)?|(?:one|single)\s+(?:line|row)|stays\s+on\s+one|wrap\w*|no-?wrap|nowrap|truncat\w*|clip\w*|fully\s+visible|legib\w*|readable|(?:word|letter)-spacing|negative\s+spacing|gap\s+between|between\s+items|reachable|complete[sd]?|end\s+state)(?![\w])/i;
const AT_WIDTH = /\bat\s+(\d{3,4})\s*px\b/i;
const NAMES_CONTROL = /\b(?:buttons?|controls?|chips?|targets?)\b/i;

const RULING_KEYWORDS: Record<LintCapKind, RegExp> = {
  size: /gap|spacing|overlap|wrap|row|line|legib/i,
  length: /truncat|wrap|line|legib/i,
  count: /overflow|reachable/i,
  time: /motion|animation|duration/i,
};

/** Markdown emphasis and code ticks are formatting, not wording. */
function plain(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type Cap = { kind: LintCapKind; text: string };

/** The kind a number takes from what follows it, if any. */
function unitKind(after: string): LintCapKind | undefined {
  if (SIZE_UNIT.test(after)) return "size";
  if (TIME_UNIT.test(after)) return "time";
  if (LENGTH_UNIT.test(after)) return "length";
  if (COUNT_UNIT.test(after)) return "count";
  return undefined;
}

function isUiCap(kind: LintCapKind, text: string): boolean {
  if (NON_UI.test(text)) return false;
  if (kind === "size") return true;
  return UI_NOUN.test(text);
}

function capKind(
  text: string,
  after: string,
  timeOnly: boolean,
): LintCapKind | undefined {
  const unit = unitKind(after);
  if (timeOnly) return unit === "time" ? "time" : undefined;
  if (unit !== undefined) return unit;
  if (DIMENSION_WORD.test(text)) return "size";
  if (UI_NOUN.test(text)) return "count";
  return undefined;
}

/** The first cap on UI in a criterion, if any. */
export function findCap(criterion: string): Cap | undefined {
  const text = plain(criterion);
  const found: { index: number; cap: Cap }[] = [];
  for (const match of text.matchAll(PHRASE_CAP)) {
    const index = match.index ?? 0;
    const end = index + match[0].length;
    const after = text.slice(end);
    const timeOnly = /^within/i.test(match[0]);
    const kind = capKind(text, after, timeOnly);
    if (kind === undefined) continue;
    const unit = /^\s*[a-z%]+/i.exec(after)?.[0] ?? "";
    found.push({ index, cap: { kind, text: (match[0] + unit).trim() } });
  }
  for (const match of text.matchAll(OR_FEWER_CAP)) {
    const index = match.index ?? 0;
    const after = text.slice(index + (match[1] ?? "").length);
    const kind = capKind(text, after, false);
    if (kind === undefined) continue;
    found.push({ index, cap: { kind, text: match[0].trim() } });
  }
  found.sort((a, b) => a.index - b.index);
  return found.find(({ cap }) => isUiCap(cap.kind, text))?.cap;
}

/** Floors and outcomes in a criterion's text and its sub-bullets. */
function isPaired(text: string): boolean {
  const flat = plain(text);
  return FLOOR.test(flat) || OUTCOME.test(flat);
}

const UI_ROOTS = new Set<string>(UI_NOUNS);
const GENERIC = new Set<string>(GENERIC_UI_NOUNS);

function uiRoot(token: string): string | undefined {
  const lower = token.toLowerCase();
  if (UI_ROOTS.has(lower)) return lower;
  if (lower.endsWith("es") && UI_ROOTS.has(lower.slice(0, -2)))
    return lower.slice(0, -2);
  if (lower.endsWith("s") && UI_ROOTS.has(lower.slice(0, -1)))
    return lower.slice(0, -1);
  return undefined;
}

/**
 * The criterion's subject: the head of its first run of UI nouns ("Toolbar
 * buttons" → button), skipping generic nouns, for sibling pairing.
 */
export function capSubject(criterion: string): string | undefined {
  const tokens = plain(criterion).split(/[^A-Za-z]+/);
  const roots = tokens.map(uiRoot);
  const first = roots.findIndex((root) => root !== undefined);
  if (first === -1) return undefined;
  let end = first;
  while (roots[end + 1] !== undefined) end += 1;
  for (let index = end; index >= first; index -= 1) {
    const root = roots[index];
    if (root !== undefined && !GENERIC.has(root)) return root;
  }
  return roots
    .slice(end + 1)
    .find((root) => root !== undefined && !GENERIC.has(root));
}

function namesSubject(text: string, subject: string): boolean {
  return wordsPattern([subject], true).test(plain(text));
}

function rowWidth(criterion: string, context: LintContext) {
  const named = AT_WIDTH.exec(plain(criterion))?.[1];
  return named === undefined
    ? { width: context.rowWidth, source: context.rowWidthSource }
    : { width: Number(named), source: "criterion" };
}

function suggestions(
  kind: LintCapKind,
  criterion: string,
  context: LintContext,
): LintSuggestion[] {
  const row = rowWidth(criterion, context);
  const base: LintSuggestion[] = (() => {
    switch (kind) {
      case "size": {
        const { fine, coarse, narrowBelow } = context.targetSize;
        return [
          {
            text: `keep ≥${context.controlGapMin}px between items, glyph to glyph`,
            source: "control-gap",
          },
          {
            text: "no overlap with neighbouring controls or text",
            source: "element-overlap",
          },
          { text: `stays on one row at ${row.width}px`, source: row.source },
          {
            text: "text keeps its normal word- and letter-spacing (no negative spacing)",
            source: "negative-spacing",
          },
          ...(NAMES_CONTROL.test(criterion)
            ? [
                {
                  text: `each control stays ≥${fine}px (≥${coarse}px below ${narrowBelow}px)`,
                  source: "target-size",
                },
              ]
            : []),
        ];
      }
      case "length":
        return [
          {
            text: `the label stays on one line at ${row.width}px with no truncation`,
            source: row.source,
          },
          {
            text: "the full text stays legible: no clipping",
            source: "clipped-text",
          },
        ];
      case "count":
        return [
          {
            text: "every item beyond the cap stays reachable (overflow menu or scroll)",
            source: "outcome",
          },
          {
            text: "no item is clipped or overlapped",
            source: "element-overlap",
          },
        ];
      case "time":
        return [
          {
            text: "the end state is visible and complete when the time is up (not skipped or blank)",
            source: "outcome",
          },
        ];
    }
  })();
  const rulings = context.rulings
    .filter((ruling) => RULING_KEYWORDS[kind].test(ruling.wording))
    .slice(0, MAX_RULING_SUGGESTIONS)
    .map((ruling) => ({ text: ruling.wording, source: `ruling:${ruling.id}` }));
  return [...base, ...rulings];
}

/** Warnings for unpaired caps; siblings sharing the cap's subject can pair it. */
export function lintCriteria(
  criteria: Criterion[],
  context: LintContext = DEFAULT_LINT_CONTEXT,
): CriterionWarning[] {
  const full = criteria.map((criterion) =>
    [criterion.text, criterion.detail ?? ""].join(" "),
  );
  return criteria.flatMap((criterion, index) => {
    const cap = findCap(criterion.text);
    if (cap === undefined) return [];
    if (isPaired(full[index] ?? "")) return [];
    const subject = capSubject(criterion.text);
    if (
      subject !== undefined &&
      full.some(
        (sibling, other) =>
          other !== index &&
          namesSubject(sibling, subject) &&
          isPaired(sibling),
      )
    )
      return [];
    return [
      {
        criterion: plain(criterion.text),
        line: criterion.line,
        cap,
        suggestions: suggestions(cap.kind, criterion.text, context),
      },
    ];
  });
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const AC_TITLE = /^acceptance\s+criteria\b/i;
const AC_LABEL =
  /^\s*(?:\*\*acceptance\s+criteria:?\*\*:?|acceptance\s+criteria\s*:)\s*$/i;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

/**
 * Criteria under every "Acceptance criteria" heading, bold label or
 * `Acceptance criteria:` line. A section ends at the next heading of the same
 * or a higher level (any heading, for a label). Fenced lines are skipped.
 */
export function extractCriteria(markdown: string): {
  section: boolean;
  criteria: Criterion[];
} {
  const lines = markdown.split(/\r?\n/);
  const kept = unfenced(lines);
  const criteria: Criterion[] = [];
  let section = false;
  /** Heading level that ends the open section; 7 for a label. */
  let level: number | undefined;
  let current: (Criterion & { indent: number; detail: string }) | undefined;
  const close = () => {
    if (current !== undefined)
      criteria.push({
        text: current.text,
        line: current.line,
        ...(current.detail === "" ? {} : { detail: current.detail }),
      });
    current = undefined;
  };
  for (const index of kept) {
    const line = lines[index] ?? "";
    const heading = HEADING.exec(line);
    if (heading !== null) {
      close();
      const depth = heading[1]?.length ?? 1;
      if (level !== undefined && depth <= level) {
        close();
        level = undefined;
      }
      if (level === undefined && AC_TITLE.test(heading[2] ?? "")) {
        section = true;
        level = depth;
      }
      continue;
    }
    if (AC_LABEL.test(line)) {
      close();
      section = true;
      level = 7;
      continue;
    }
    if (level === undefined) continue;
    if (line.trim() === "") continue;
    const item = LIST_ITEM.exec(line);
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (item !== null) {
      if (current !== undefined && indent > current.indent) {
        current.detail = `${current.detail} ${item[2] ?? ""}`.trim();
        continue;
      }
      close();
      current = {
        text: (item[2] ?? "").trim(),
        line: index + 1,
        indent,
        detail: "",
      };
      continue;
    }
    if (current !== undefined && indent > current.indent) {
      if (current.detail === "")
        current.text = `${current.text} ${line.trim()}`;
      else current.detail = `${current.detail} ${line.trim()}`;
      continue;
    }
    // Unindented prose or a bold sub-label ends the item, not the section.
    close();
  }
  close();
  return { section, criteria };
}

export function lintMarkdown(
  path: string,
  text: string,
  context: LintContext = DEFAULT_LINT_CONTEXT,
): LintFile {
  const { section, criteria } = extractCriteria(text);
  return {
    path,
    section,
    criteria: criteria.length,
    warnings: lintCriteria(criteria, context),
  };
}

/** One warning; `where` names it, such as `ticket.md:9` or `criterion 2`. */
export function renderWarning(where: string, warning: CriterionWarning) {
  return [
    `Warning: ${where} caps ${warning.cap.kind} with no floor or outcome: "${warning.criterion}"`,
    ...warning.suggestions.map(
      (suggestion) => `  Pair it with: ${suggestion.text}`,
    ),
  ];
}

/**
 * Human output: one warning per unpaired cap and a summary, plus a note for
 * each file with no acceptance criteria section. Empty only when every file
 * has a section and no warning, so a hook stays silent on clean tickets.
 */
export function renderLint(result: LintResult): string {
  const notes = result.files
    .filter((file) => !file.section)
    .map((file) => `Note: ${file.path} has no acceptance criteria section.`);
  const warned = result.files.filter((file) => file.warnings.length > 0);
  const lines = [
    ...result.files.flatMap((file) =>
      file.warnings.flatMap((warning) =>
        renderWarning(`${file.path}:${warning.line}`, warning),
      ),
    ),
    ...(result.warnings === 0
      ? []
      : [
          `${result.warnings} criterion warning(s) in ${warned.length} file(s).`,
        ]),
    ...notes,
  ];
  return lines.join("\n");
}

export function lintJson(result: LintResult): LintResult {
  return {
    strict: result.strict,
    warnings: result.warnings,
    files: result.files.map((file) => ({
      path: file.path,
      section: file.section,
      criteria: file.criteria,
      warnings: file.warnings,
    })),
  };
}

export function lintResult(files: LintFile[], strict: boolean): LintResult {
  return {
    strict,
    warnings: files.reduce((sum, file) => sum + file.warnings.length, 0),
    files,
  };
}
