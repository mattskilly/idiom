import { type UiCategory, uiCategories } from "../schemas/learned.js";

/**
 * Deterministic, lexical classification of a director's written words: does
 * a sentence correct the UI or UX, and in which ways? No model, so it runs
 * offline and the same words always classify the same way.
 */

/** Words that say something should change. */
export const CORRECTION_SIGNALS = [
  "should",
  "shouldn't",
  "should not",
  "must",
  "mustn't",
  "must not",
  "need",
  "needs",
  "needs to",
  "too",
  "instead",
  "don't",
  "do not",
  "doesn't",
  "does not",
  "isn't",
  "aren't",
  "can't",
  "cannot",
  "make",
  "move",
  "remove",
  "add",
  "drop",
  "feel",
  "feels",
  "look",
  "looks",
  "wrong",
  "missing",
  "prefer",
  "rather",
  "avoid",
  "use",
  "align",
  "reduce",
  "increase",
  "tighten",
  "loosen",
  "change",
  "swap",
  "replace",
  "rename",
  "never",
  "always",
  "hard to",
  "ugly",
  "broken",
  "confusing",
  "cramped",
  "misaligned",
  "cut off",
  "clipped",
  "please",
] as const;

/** Words that place a correction in one UI category. */
export const CATEGORY_WORDS: Record<UiCategory, readonly string[]> = {
  layout: [
    "layout",
    "align",
    "aligned",
    "alignment",
    "misaligned",
    "center",
    "centre",
    "centered",
    "centred",
    "left",
    "right",
    "top",
    "bottom",
    "stack",
    "stacked",
    "column",
    "row",
    "grid",
    "wrap",
    "wraps",
    "overlap",
    "overlaps",
    "order",
    "above",
    "below",
    "beside",
    "next to",
    "width",
    "height",
    "wide",
    "tall",
    "full-width",
    "sticky",
    "overflow",
    "responsive",
    "mobile",
    "desktop",
    "viewport",
    "position",
    "placement",
    "fold",
    "cut off",
    "clipped",
  ],
  spacing: [
    "spacing",
    "space",
    "spaced",
    "gap",
    "padding",
    "margin",
    "cramped",
    "crowded",
    "tight",
    "tighter",
    "breathing room",
    "whitespace",
    "white space",
    "airy",
    "dense",
    "gutter",
    "inset",
  ],
  copy: [
    "copy",
    "text",
    "wording",
    "word",
    "label",
    "say",
    "says",
    "read",
    "reads",
    "title",
    "heading",
    "headline",
    "message",
    "tone",
    "phrase",
    "phrasing",
    "capitalize",
    "capitalise",
    "uppercase",
    "lowercase",
    "sentence case",
    "title case",
    "typo",
    "microcopy",
    "placeholder",
    "jargon",
    "rename",
  ],
  interaction: [
    "click",
    "clicks",
    "tap",
    "taps",
    "hover",
    "focus",
    "keyboard",
    "close",
    "closes",
    "open",
    "opens",
    "dismiss",
    "scroll",
    "scrolls",
    "drag",
    "select",
    "selected",
    "toggle",
    "submit",
    "disabled",
    "enabled",
    "loading",
    "spinner",
    "animation",
    "animate",
    "transition",
    "navigate",
    "navigation",
    "go back",
    "interaction",
    "cursor",
    "shortcut",
    "escape",
    "outside",
    "press",
    "feedback",
    "undo",
    "confirm",
  ],
  visual: [
    "color",
    "colour",
    "contrast",
    "font",
    "typography",
    "weight",
    "bold",
    "bigger",
    "smaller",
    "larger",
    "light",
    "lighter",
    "dark",
    "darker",
    "shadow",
    "border",
    "radius",
    "rounded",
    "icon",
    "image",
    "background",
    "visual",
    "visually",
    "style",
    "styling",
    "theme",
    "opacity",
    "muted",
    "faint",
    "ugly",
    "polish",
    "polished",
    "blurry",
    "hierarchy",
    "emphasis",
    "prominent",
    "subtle",
    "loud",
    "busy",
    "cluttered",
    "clutter",
  ],
};

/** UI nouns: they count toward the UI side but name no category. */
export const UI_NOUNS = [
  "button",
  "card",
  "modal",
  "dialog",
  "header",
  "footer",
  "field",
  "input",
  "form",
  "chip",
  "page",
  "screen",
  "menu",
  "tab",
  "toast",
  "banner",
  "sidebar",
  "nav",
  "navbar",
  "link",
  "list",
  "table",
  "dropdown",
  "tooltip",
  "badge",
  "avatar",
  "checkbox",
  "radio",
  "slider",
  "panel",
  "drawer",
  "popover",
  "picker",
  "calendar",
  "hero",
  "logo",
  "ui",
  "ux",
  "user",
  "users",
] as const;

/** Build-process and code vocabulary: talk about the work, not the UI. */
export const PROCESS_WORDS = [
  "test",
  "tests",
  "testing",
  "typecheck",
  "lint",
  "build",
  "builds",
  "commit",
  "committed",
  "merge",
  "merged",
  "branch",
  "rebase",
  "rerun",
  "re-run",
  "retry",
  "ci",
  "phase",
  "spec",
  "ticket",
  "escalation",
  "escalate",
  "fixture",
  "scope",
  "follow-up",
  "followup",
  "pr",
  "pull request",
  "function",
  "schema",
  "implement",
  "implementation",
  "measurement",
  "measurements",
  "deploy",
  "verify",
  "round",
  "session",
  "config",
  "code",
  "refactor",
  "file",
  "files",
  "docs",
  "changelog",
  "check",
  "checks",
  "finding",
  "findings",
  "rule",
  "rules",
  "plan",
  "review",
  "reviewer",
  "dependency",
  "release",
  "version",
] as const;

/** Code-shaped tokens: file paths, commit SHAs, ids, issue refs. */
const PROCESS_PATTERNS = [
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|css|scss|html|toml|ya?ml|sh)\b/gi,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
  /\b[a-z]+_[0-9a-z]{6,}\b/gi,
  /(?:^|\s)#\d+\b/g,
];

/** A size in pixels counts as visual. */
const PIXEL_PATTERN = /\b\d+(?:\.\d+)?\s?px\b/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One case-insensitive matcher per term: word bounded, plurals folded. */
function matcher(terms: readonly string[]): RegExp {
  const alternatives = [...terms]
    .sort((a, b) => b.length - a.length)
    .map((term) => escapeRegExp(term).replace(/\\-|\s+/g, "[\\s-]+"));
  return new RegExp(
    `(?<![\\w'-])(?:${alternatives.join("|")})(?:s|es)?(?![\\w'-])`,
    "gi",
  );
}

const signalMatcher = matcher(CORRECTION_SIGNALS);
const nounMatcher = matcher(UI_NOUNS);
const processMatcher = matcher(PROCESS_WORDS);
const categoryMatchers = uiCategories.map(
  (category) => [category, matcher(CATEGORY_WORDS[category])] as const,
);

function count(pattern: RegExp, text: string): number {
  return [...text.matchAll(pattern)].length;
}

export type SentenceClass = {
  ui: boolean;
  categories: UiCategory[];
  signals: number;
  uiHits: number;
  processHits: number;
};

/** Classify one sentence. */
export function classifySentence(text: string): SentenceClass {
  const normal = text.replace(/[‘’]/g, "'").toLowerCase();
  const categories: UiCategory[] = [];
  let uiHits = 0;
  for (const [category, pattern] of categoryMatchers) {
    const hits =
      count(pattern, normal) +
      (category === "visual" ? count(PIXEL_PATTERN, normal) : 0);
    if (hits > 0) categories.push(category);
    uiHits += hits;
  }
  uiHits += count(nounMatcher, normal);
  const processHits =
    count(processMatcher, normal) +
    PROCESS_PATTERNS.reduce((sum, pattern) => sum + count(pattern, text), 0);
  const signals = count(signalMatcher, normal);
  return {
    ui: signals > 0 && categories.length > 0 && processHits < uiHits,
    categories,
    signals,
    uiHits,
    processHits,
  };
}

/** Blank out a span, keeping offsets and line breaks. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * The text with fenced code, quoted lines and inline code blanked out, at
 * the same offsets, so sentences can be cut from the original verbatim.
 */
function masked(text: string): string {
  return text
    .replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g, blank)
    .replace(/(^|\n)[ \t]*>[^\n]*/g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (match) => " ".repeat(match.length));
}

const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;

/**
 * The sentences of a text, each an exact substring of it (less a leading
 * list marker), with the masked form the classifier reads.
 */
export function sentences(text: string): Array<{ text: string; read: string }> {
  const mask = masked(text);
  const result: Array<{ text: string; read: string }> = [];
  // A stop before whitespace ends a sentence, except a numbered list marker.
  const boundary = /(?<!(?:^|\n)[ \t]*\d+)[.!?]+(?=\s)|\n/g;
  let start = 0;
  const push = (end: number) => {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(mask[from] ?? "")) from += 1;
    while (to > from && /\s/.test(mask[to - 1] ?? "")) to -= 1;
    const marker = LIST_MARKER.exec(mask.slice(from, to));
    if (marker !== null) from += marker[0].length;
    if (to > from && mask.slice(from, to).trim() !== "")
      result.push({ text: text.slice(from, to), read: mask.slice(from, to) });
  };
  for (const match of mask.matchAll(boundary)) {
    const end = match.index + (match[0] === "\n" ? 0 : match[0].length);
    push(end);
    start = match.index + match[0].length;
  }
  push(mask.length);
  return result;
}

export type Classification = {
  /** True when at least one sentence corrects the UI or UX. */
  ui: boolean;
  categories: UiCategory[];
  /** The qualifying sentences, verbatim. */
  sentences: string[];
};

/** Classify a whole comment or answer, keeping its qualifying sentences. */
export function classifyCorrection(text: string): Classification {
  const qualifying = sentences(text)
    .map((sentence) => ({ sentence, class: classifySentence(sentence.read) }))
    .filter((item) => item.class.ui);
  const found = new Set(qualifying.flatMap((item) => item.class.categories));
  return {
    ui: qualifying.length > 0,
    categories: uiCategories.filter((category) => found.has(category)),
    sentences: qualifying.map((item) => item.sentence.text),
  };
}
