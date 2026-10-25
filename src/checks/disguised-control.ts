import {
  contrastRatio,
  effectiveBackground,
  isBounded,
  isPainted,
  isVisuallyHidden,
  parseColor,
  px,
  ran,
  type SignalledElement,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  ObservedElementV2,
} from "./types.js";

const inputVerb =
  /^(?:search|find|filter|type|ask|describe|write|enter|message|reply|comment|say|add a (?:note|comment|message))\b/i;
const ellipsis = /(?:…|\.\.\.)$/;

/** Copy that only makes sense as an input's placeholder. */
const strongPlaceholders = [
  /^describe\b\s+\S/i,
  /^(?:start typing|type here|type (?:a|your)\b|ask (?:anything|me anything)\b|what(?:'s| is) on your mind)/i,
];

const busy = /^(?:loading|saving|sending|processing|please wait)\b/i;
const shortcutHint = /[⌘⌃⌥]|\b(?:ctrl|cmd|alt)\s*\+?\s*[a-z0-9]\b/i;

type TextCue = "strong" | "weak" | undefined;

function textCue(text: string, configured: readonly RegExp[]): TextCue {
  if (configured.some((pattern) => pattern.test(text))) return "strong";
  if (strongPlaceholders.some((pattern) => pattern.test(text))) return "strong";
  if (inputVerb.test(text) && ellipsis.test(text)) return "strong";
  if (ellipsis.test(text) || inputVerb.test(text)) return "weak";
  return undefined;
}

/** Wide, single-line and reading from the left edge, like a text field. */
function fieldShaped(element: SignalledElement): boolean {
  const { rect, styles, signals } = element;
  if (rect.width < 160 || rect.width < 3 * rect.height) return false;
  if (signals.lineCount > 1) return false;
  const text = signals.textRect;
  if (text !== undefined) {
    const contentLeft =
      rect.x + px(styles.borderLeftWidth) + px(styles.paddingLeft);
    const contentRight =
      rect.x +
      rect.width -
      px(styles.borderRightWidth) -
      px(styles.paddingRight);
    return (
      text.x <= contentLeft + 12 && text.x + text.width <= contentRight - 40
    );
  }
  const flexible = /flex|grid/.test(styles.display);
  return (
    ["start", "left", "-webkit-left"].includes(styles.textAlign) &&
    (!flexible ||
      ["normal", "flex-start", "start", "left"].includes(styles.justifyContent))
  );
}

function fieldBorder(element: ObservedElementV2): boolean {
  const styles = element.styles;
  const sides = [
    [styles.borderTopWidth, styles.borderTopColor],
    [styles.borderRightWidth, styles.borderRightColor],
    [styles.borderBottomWidth, styles.borderBottomColor],
    [styles.borderLeftWidth, styles.borderLeftColor],
  ] as const;
  const thin = ([width, color]: readonly [string, string]) =>
    px(width) >= 0.5 && px(width) <= 2.5 && isPainted(color);
  const none = ([width, color]: readonly [string, string]) =>
    px(width) === 0 || !isPainted(color);
  if (sides.every(thin)) return true;
  const [top, right, bottom, left] = sides;
  return thin(bottom) && none(top) && none(right) && none(left);
}

function neutralBackground(element: ObservedElementV2): boolean {
  const color = parseColor(element.styles.backgroundColor);
  if (color === undefined || color.a <= 0.05) return true;
  return (
    Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <=
    24
  );
}

function mutedText(
  element: ObservedElementV2,
  bySelector: ReadonlyMap<string, ObservedElementV2>,
  roots: readonly ObservedElementV2[],
): boolean {
  const color = parseColor(element.styles.color);
  if (color === undefined) return false;
  if (color.a < 0.85) return true;
  return (
    contrastRatio(color, effectiveBackground(element, bySelector, roots)) < 7
  );
}

function sameColor(left: string, right: string): boolean {
  const a = parseColor(left);
  const b = parseColor(right);
  if (a === undefined || b === undefined) return left === right;
  if (a.a <= 0.05 && b.a <= 0.05) return true;
  return (
    Math.abs(a.r - b.r) <= 10 &&
    Math.abs(a.g - b.g) <= 10 &&
    Math.abs(a.b - b.b) <= 10 &&
    Math.abs(a.a - b.a) <= 0.1
  );
}

const textEntry = (element: SignalledElement) =>
  element.tag === "textarea" ||
  (element.tag === "input" &&
    ["textbox", "searchbox"].includes(element.signals.role));

/**
 * Controls that misrepresent what they are. A button whose copy reads like a
 * placeholder ("Describe a change", "Search…") or that is drawn as a text
 * field invites typing and then only moves focus elsewhere; a readonly or
 * disabled field drawn exactly like the editable ones refuses typing with no
 * explanation.
 *
 * Text cues are tiered so dialog-opening buttons ("Save as…") and busy states
 * stay quiet: an input verb with an ellipsis, or copy that only makes sense as
 * a placeholder, is reported on its own; any other ellipsis or input verb only
 * on a field-shaped button; a button with no text cue only when it carries the
 * whole text-field look. Field-shaped triggers that are honest about being
 * triggers — comboboxes, popup buttons, command-palette launchers showing a
 * shortcut — are not reported.
 */
export const disguisedControlCheck: DeterministicCheck = {
  id: "disguised-control",
  run({ tuple, config }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const observation = tuple.observations;
    const all =
      observation?.version === 2 ? observation.elements : observed.elements;
    const bySelector = new Map(
      all.map((element) => [element.selector, element]),
    );
    const roots = all.filter((element) =>
      ["body", "html"].includes(element.tag),
    );
    const ignored = new Set(
      (observation?.version === 2 ? (observation.selectorMarks ?? []) : [])
        .filter((mark) => mark.purpose === "disguised-ignore")
        .flatMap((mark) => mark.matches),
    );
    const isIgnored = (element: ObservedElementV2) =>
      ignored.has(element.selector) ||
      element.ancestorSelectors.some((selector) => ignored.has(selector));
    const withShortcut = new Set(
      observed.elements
        .filter((element) => element.tag === "kbd")
        .flatMap((element) => element.ancestorSelectors),
    );
    const configured = config.disguisedControl.placeholderPatterns.map(
      (pattern) => new RegExp(pattern, "i"),
    );
    const candidates: FindingCandidate[] = [];

    for (const element of observed.elements) {
      if (element.signals.role !== "button") continue;
      if (!element.enabled || isVisuallyHidden(element) || isIgnored(element))
        continue;
      const text = element.text.replace(/\s+/g, " ").trim();
      if (text === "" || text.split(" ").length > 8) continue;
      const haspopup = element.signals.haspopup;
      if (
        element.attributes.role === "combobox" ||
        (haspopup !== undefined && haspopup !== "false") ||
        withShortcut.has(element.selector) ||
        shortcutHint.test(text) ||
        busy.test(text)
      )
        continue;
      const cue = textCue(text, configured);
      const shaped = fieldShaped(element);
      const styled =
        shaped &&
        element.rect.height >= 28 &&
        element.rect.height <= 64 &&
        isBounded(element) &&
        fieldBorder(element) &&
        neutralBackground(element) &&
        mutedText(element, bySelector, roots);
      if (!(cue === "strong" || (cue === "weak" && shaped) || styled)) continue;
      const cues = [
        ...(cue === undefined ? [] : ["placeholder-like text"]),
        ...(styled
          ? ["a field border and muted left-aligned text"]
          : shaped
            ? ["field-shaped, left-aligned text"]
            : []),
      ];
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:disguised-control",
        selectorHint: element.selector,
        explanation: `${JSON.stringify(text)} (${element.selector}) is a button that looks like a text field (${cues.join(" and ")}): people will try to type into it.`,
        acceptance: [
          `${element.selector} is either the real input or a clearly labelled button (verb + object, button styling) — not both.`,
        ],
        verification: verify(this.id, { selector: element.selector }),
      });
    }

    const editable = observed.elements.filter(
      (element) =>
        textEntry(element) &&
        element.enabled &&
        !("readonly" in element.attributes) &&
        !isVisuallyHidden(element),
    );
    for (const element of observed.elements) {
      if (
        !textEntry(element) ||
        isVisuallyHidden(element) ||
        isIgnored(element)
      )
        continue;
      const readonly = "readonly" in element.attributes;
      if (!readonly && element.enabled) continue;
      const { signals } = element;
      if (signals.title !== undefined || signals.described) continue;
      if (["pointer", "not-allowed"].includes(signals.cursor)) continue;
      if (signals.haspopup !== undefined && signals.haspopup !== "false")
        continue;
      const parent = element.ancestorSelectors[0];
      if (
        parent !== undefined &&
        observed.elements.some(
          (other) =>
            other !== element &&
            other.ancestorSelectors.includes(parent) &&
            ["button", "link"].includes(other.signals.role) &&
            /\bcopy\b/i.test(other.signals.name || other.text),
        )
      )
        continue;
      if (!isBounded(element) || px(element.styles.opacity) < 0.9) continue;
      const color = parseColor(element.styles.color);
      if (
        color === undefined ||
        color.a < 0.85 ||
        contrastRatio(color, effectiveBackground(element, bySelector, roots)) <
          4.5
      )
        continue;
      if (
        editable.length > 0 &&
        !editable.some(
          (other) =>
            sameColor(
              other.styles.backgroundColor,
              element.styles.backgroundColor,
            ) &&
            sameColor(
              other.styles.borderBottomColor,
              element.styles.borderBottomColor,
            ),
        )
      )
        continue;
      const state = readonly ? "read-only" : "disabled";
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:input-rejects-text",
        selectorHint: element.selector,
        explanation: `${element.selector} is a ${state} text field drawn like an editable one, and nothing says why it cannot be edited: people will try to type into it.`,
        acceptance: [
          `${element.selector} either accepts text, or looks read-only and says why (a tooltip, description, or visible copy).`,
        ],
        verification: verify(this.id, { selector: element.selector }),
      });
    }
    return ran(this.id, candidates);
  },
};
