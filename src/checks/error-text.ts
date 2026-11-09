import {
  codeContext,
  isVisuallyHidden,
  ran,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  ObservedElementV2,
} from "./types.js";

/**
 * Phrase signatures are words a sentence can be about ("failed to load");
 * leak signatures are shapes only a leak produces (a stack frame, `[object
 * Object]`). Only phrases can be exempted as explanatory prose.
 */
type SignatureKind = "phrase" | "leak";
type Signature = { pattern: RegExp; label: string; kind: SignatureKind };

const signatures: Signature[] = [
  {
    pattern: /\b(?:renderer|render|rendering) failed\b/i,
    label: "a render failure",
    kind: "phrase",
  },
  {
    pattern: /\bfailed to (?:load|render|fetch|compile|parse)\b/i,
    label: "a load failure",
    kind: "phrase",
  },
  {
    pattern:
      /\b(?:something went wrong|unexpected error|internal server error|application error)\b/i,
    label: "a generic error",
    kind: "phrase",
  },
  {
    pattern:
      /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Unhandled(?: Runtime)? Error)\b/,
    label: "a JavaScript exception",
    kind: "phrase",
  },
  {
    pattern:
      /\b(?:cannot read propert(?:y|ies) of|is not a function|is not defined|undefined is not)\b/i,
    label: "a JavaScript exception",
    kind: "phrase",
  },
  {
    pattern: /\b(?:ECONNREFUSED|EPIPE|ENOENT|ETIMEDOUT|EACCES)\b/,
    label: "a system error code",
    kind: "phrase",
  },
  {
    pattern: /\bat [\w.<>$]+ \((?:[\w/.:-]+):\d+:\d+\)/,
    label: "a stack trace",
    kind: "leak",
  },
  { pattern: /\[object Object\]/, label: "an unrendered object", kind: "leak" },
  {
    pattern: /^\s*(?:undefined|null|NaN)\s*$/,
    label: "an unrendered value",
    kind: "leak",
  },
  { pattern: /^\s*[{[]\s*"[\w-]+"\s*:/, label: "raw JSON", kind: "leak" },
];

/** A sentence this long that mentions a signature mid-sentence or in quotes describes it. */
export const proseSentenceWords = 8;
/** Running text this long discusses errors rather than showing one. */
export const longParagraphWords = 40;

const surfaceRoles = new Set(["alert", "alertdialog", "status", "log"]);
const surfaceClassSegments = new Set([
  "error",
  "errors",
  "alert",
  "toast",
  "toaster",
  "snackbar",
  "notification",
  "notice",
  "flash",
  "warning",
  "danger",
  "invalid",
  "failure",
  "failed",
  "fallback",
  "empty",
]);
const documentationRoles = new Set(["main", "article", "document"]);

function roles(element: ObservedElementV2): string[] {
  return (element.attributes.role ?? "").trim().toLowerCase().split(/\s+/);
}

function surface(element: ObservedElementV2): boolean {
  if (element.tag === "output") return true;
  if (roles(element).some((role) => surfaceRoles.has(role))) return true;
  const live = (element.attributes["aria-live"] ?? "").trim().toLowerCase();
  if (live === "polite" || live === "assertive") return true;
  return (element.attributes.class ?? "").split(/\s+/).some((token) =>
    token
      .toLowerCase()
      .split(/[-_]+/)
      .some((segment) => surfaceClassSegments.has(segment)),
  );
}

/**
 * The element or an ancestor is where failures are announced: an alert,
 * status or log role, a live region, an `<output>`, or an error-ish class
 * name (`error-banner`, `toast`, `form__error`, `empty-state`).
 */
export function isFailureSurface(
  element: ObservedElementV2,
  ancestry: readonly ObservedElementV2[],
): boolean {
  return surface(element) || ancestry.some(surface);
}

/** Inside `main` or `article`, by tag in the path or by landmark role. */
export function inDocumentation(
  element: ObservedElementV2,
  ancestry: readonly ObservedElementV2[],
): boolean {
  return (
    /(?:^|\/)(?:main|article)\[/.test(element.structuralPath) ||
    [element, ...ancestry].some((record) =>
      roles(record).some((role) => documentationRoles.has(role)),
    )
  );
}

const wordPattern = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const words = (text: string): number => text.match(wordPattern)?.length ?? 0;
const openingQuotes = new Set(['"', "“", "‘", "'", "«"]);

/**
 * The text explains the error the match names rather than showing it: the
 * whole text is a long paragraph, or the sentence holding the match has
 * {@link proseSentenceWords}+ words and the match follows a word in it or
 * opens a quotation.
 */
export function describesError(
  text: string,
  match: Pick<RegExpExecArray, "index"> & { 0: string },
): boolean {
  if (words(text) >= longParagraphWords) return true;
  let start = 0;
  for (const boundary of text.matchAll(/[.!?]\s+/g)) {
    const end = (boundary.index ?? 0) + boundary[0].length;
    if (end > match.index) break;
    start = end;
  }
  const rest = text.slice(start);
  const stop = rest.slice(match.index - start).search(/[.!?](?:\s|$)/);
  const sentence =
    stop === -1 ? rest : rest.slice(0, match.index - start + stop + 1);
  if (words(sentence) < proseSentenceWords) return false;
  const before = text.slice(start, match.index);
  return words(before) > 0 || openingQuotes.has(before.trimEnd().slice(-1));
}

/**
 * Explanatory prose: every signature found is a phrase, nothing places the
 * text on a failure surface, it sits in documentation, and every phrase is
 * described rather than shown. A leak-shaped or configured signature
 * anywhere in the text always reports, whatever else matches first.
 */
export function isExplanatoryProse(
  text: string,
  matches: ReadonlyArray<{
    kind: SignatureKind;
    match: Pick<RegExpExecArray, "index"> & { 0: string };
  }>,
  element: ObservedElementV2,
  ancestry: readonly ObservedElementV2[],
): boolean {
  return (
    matches.length > 0 &&
    matches.every((entry) => entry.kind === "phrase") &&
    !isFailureSurface(element, ancestry) &&
    inDocumentation(element, ancestry) &&
    matches.every((entry) => describesError(text, entry.match))
  );
}

/**
 * Error text that reached the screen: "Renderer failed" thumbnails, raw
 * exceptions, stack traces, JSON blobs and [object Object]. A flow's own
 * error states are expected to show messages; only engineering-shaped
 * failures are reported. Help text that explains an error in documentation
 * prose is not a failure on screen; leaks and failure surfaces always are.
 */
export const errorTextCheck: DeterministicCheck = {
  id: "error-text",
  run({ tuple, config }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const { ancestry, isCode } = codeContext(
      tuple.observations?.version === 2 ? tuple.observations.elements : [],
    );
    // Configured patterns count as leaks: the project declared them, so they
    // are never exempted as explanatory prose.
    const custom: Signature[] = config.errorPatterns.map((pattern) => ({
      pattern: new RegExp(pattern, "i"),
      label: "a configured error signature",
      kind: "leak",
    }));
    const all = [...signatures, ...custom];
    const groups = new Map<
      string,
      { selectors: string[]; text: string; label: string }
    >();
    for (const element of observed.elements) {
      if (
        isVisuallyHidden(element) ||
        isCode(element) ||
        ["script", "style", "noscript", "template"].includes(element.tag)
      )
        continue;
      const text = element.directText.replace(/\s+/g, " ").trim();
      if (text === "") continue;
      const matches = all.flatMap((entry) => {
        const found = entry.pattern.exec(text);
        return found === null ? [] : [{ ...entry, match: found }];
      });
      const match = matches[0];
      if (match === undefined) continue;
      if (
        isExplanatoryProse(
          text,
          matches,
          element,
          ancestry(element.structuralPath),
        )
      )
        continue;
      const key = `${match.label}\u0000${text.slice(0, 120)}`;
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, {
          selectors: [element.selector],
          text,
          label: match.label,
        });
      else group.selectors.push(element.selector);
    }
    const candidates: FindingCandidate[] = [];
    for (const group of groups.values()) {
      const first = group.selectors[0];
      if (first === undefined) continue;
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:visible-error-text",
        selectorHint: first,
        explanation: `${group.label[0]?.toUpperCase()}${group.label.slice(1)} is visible to people: "${group.text.slice(0, 160)}"${group.selectors.length > 1 ? ` in ${group.selectors.length} places (${group.selectors.slice(0, 3).join(", ")}${group.selectors.length > 3 ? ", …" : ""})` : ` (${first})`}.`,
        acceptance: [
          "No engineering error text is visible; failures render a designed fallback with a recovery action.",
        ],
        verification: verify(this.id, { selector: first }),
      });
    }
    return ran(this.id, candidates);
  },
};
