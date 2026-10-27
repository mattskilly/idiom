import { paintedGate } from "./painted.js";
import {
  illustrationFrames,
  interactiveAncestry,
  isPainted,
  isVisuallyHidden,
  parseColor,
  ran,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const strongPhrase =
  /^(?:view|see|learn|read|open|show|browse|explore|visit|go to|manage|edit)\s+[\p{L}][\p{L}\s'’-]{0,40}$|^(?:terms(?: (?:of (?:service|use)|and conditions))?|privacy(?: policy)?|learn more|read more|see all|view all|more info)$/iu;
const weakPhrase =
  /^(?:help(?: cent(?:er|re))?|support|docs|documentation|contact(?: us)?|faq|details)$/i;

const excludedTags = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "label",
  "th",
  "legend",
  "option",
  "title",
  "caption",
  "dt",
  "code",
  "pre",
  "kbd",
]);

/**
 * Copy that reads as an action ("View terms", "Learn more", "Help") but is
 * neither a link nor a button. Matt's preference is a visible placeholder
 * link over dead text, so `href="#"` is reported separately as countable
 * placeholder debt rather than as a defect. Text inside a non-interactive
 * illustration of product UI (see `illustrationFrames`) is a picture of a
 * control, not dead copy, so it is not reported as dead link text.
 */
export const deadAffordanceCheck: DeterministicCheck = {
  id: "dead-affordance",
  run({ tuple }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const insideInteractive = interactiveAncestry(observed.elements);
    // signalledElements already confirmed a version-2 capture.
    const insideIllustration = illustrationFrames(
      tuple.observations?.version === 2 ? tuple.observations.elements : [],
    );
    const byselector = new Map(
      observed.elements.map((element) => [element.selector, element]),
    );
    const gate = paintedGate(tuple, ["idiom:dead-link-text"]);
    const candidates: FindingCandidate[] = [];
    for (const element of observed.elements) {
      if (isVisuallyHidden(element)) continue;
      // Captures without explanation signals predate painted-text evidence;
      // they keep the older behaviour rather than reading text as "".
      if (
        element.signals.explanation !== undefined &&
        (!element.enabled ||
          element.signals.explanation?.nativeDisabled === true) &&
        element.signals.explanation?.inViewport !== false &&
        (element.tag === "button" || element.signals.role === "button")
      ) {
        const text = element.signals.explanation?.visibleText.trim() ?? "";
        if (strongPhrase.test(text) || weakPhrase.test(text))
          candidates.push({
            category: this.id,
            severity: "minor",
            rule: "idiom:disabled-link-button",
            selectorHint: element.selector,
            explanation: `"${text}" (${element.selector}) reads like navigation but is a disabled button, so the destination is unreachable.`,
            acceptance: [
              `"${text}" links to its real destination, or is a visible placeholder anchor (href="#") until that destination exists.`,
            ],
            verification: verify(this.id, { selector: element.selector }),
          });
        continue;
      }
      const href = element.signals.href;
      if (element.tag === "a" && href !== undefined) {
        const trimmed = href.trim();
        if (
          trimmed === "#" ||
          trimmed === "" ||
          /^javascript:/i.test(trimmed)
        ) {
          candidates.push({
            category: this.id,
            severity: "minor",
            rule: "idiom:placeholder-link",
            selectorHint: element.selector,
            explanation: `"${element.text.trim() || element.signals.name}" (${element.selector}) is a placeholder link (href=${JSON.stringify(href)}); it is visible and clickable but goes nowhere yet.`,
            acceptance: [`${element.selector} links to its real destination.`],
            verification: verify(this.id, { selector: element.selector }),
          });
        }
        continue;
      }
      if (insideInteractive(element) || excludedTags.has(element.tag)) continue;
      if (insideIllustration(element) !== undefined) continue;
      const text = element.directText.trim();
      if (text === "" || text.split(/\s+/).length > 6) continue;
      if (element.text.trim() !== text) continue;
      const strong = strongPhrase.test(text);
      const weak = !strong && weakPhrase.test(text);
      if (!strong && !weak) continue;
      const parent = byselector.get(element.ancestorSelectors[0] ?? "");
      if (!gate.allows("idiom:dead-link-text", element, parent)) continue;
      const linkStyled =
        element.styles.textDecorationLine.includes("underline") ||
        element.signals.cursor === "pointer" ||
        (parent !== undefined &&
          isPainted(element.styles.color) &&
          (() => {
            const own = parseColor(element.styles.color);
            const theirs = parseColor(parent.styles.color);
            if (own === undefined || theirs === undefined) return false;
            return (
              Math.abs(own.r - theirs.r) +
                Math.abs(own.g - theirs.g) +
                Math.abs(own.b - theirs.b) >
              90
            );
          })());
      if (weak && !linkStyled) continue;
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:dead-link-text",
        selectorHint: element.selector,
        explanation: `"${text}" (${element.selector}) reads like a link or action${linkStyled ? " and is styled like one" : ""}, but it is plain text: clicking it does nothing.`,
        acceptance: [
          `"${text}" is a real link or button, or a visible placeholder link (href="#") until its destination exists.`,
        ],
        verification: verify(this.id, { selector: element.selector }),
      });
    }
    return gate.result(ran(this.id, candidates));
  },
};
