import {
  isBounded,
  isVisuallyHidden,
  ran,
  round,
  type SignalledElement,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

/** Visible-only geometry when captured; older captures use the legacy signals. */
const labelOf = (element: SignalledElement) =>
  element.signals.labelInk ?? {
    text: element.text.trim(),
    lineCount: element.signals.lineCount,
    textRect: element.signals.textRect,
    inkCenterY: element.signals.inkCenterY,
  };

/**
 * Single-line labels inside a filled or bordered shape (chips, buttons,
 * badges, specimen swatches) must sit on the shape's vertical centre. The
 * perceived centre of a label is the band between its ink top and its
 * baseline, so descenders do not count against it. Only painted text is
 * measured (screen-reader labels do not count), and a single glyph such as
 * + − × centres on its own ink box.
 */
export const textCenteringCheck: DeterministicCheck = {
  id: "text-centering",
  run({ tuple, config }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const bounded = new Set(
      observed.elements.filter(isBounded).map((element) => element.selector),
    );
    const groups = new Map<
      string,
      { offset: number; selectors: string[]; text: string; height: number }
    >();
    for (const element of observed.elements) {
      if (isVisuallyHidden(element) || !isBounded(element)) continue;
      if (
        ["input", "select", "textarea", "html", "body", "img", "svg"].includes(
          element.tag,
        )
      )
        continue;
      if (
        element.styles.display.startsWith("inline") &&
        element.styles.display !== "inline-flex" &&
        element.styles.display !== "inline-block" &&
        element.styles.display !== "inline-grid"
      )
        continue;
      const label = labelOf(element);
      if (label.lineCount !== 1 || label.inkCenterY === undefined) continue;
      if (label.textRect === undefined) continue;
      const { text } = label;
      if (text === "" || text.length > 40 || text.includes("\n")) continue;
      const height = element.rect.height;
      if (height < 12 || height > 64 || height > label.textRect.height * 3.2)
        continue;
      // The innermost bounded box owns the label; outer cards are skipped.
      const inner = observed.elements.some(
        (other) =>
          other !== element &&
          bounded.has(other.selector) &&
          other.ancestorSelectors.includes(element.selector) &&
          labelOf(other).text === text,
      );
      if (inner) continue;
      const centre = element.rect.y + height / 2;
      const offset = label.inkCenterY - centre;
      if (Math.abs(offset) <= config.centeringTolerance) continue;
      const key = [
        element.tag,
        element.styles.fontSize,
        element.styles.lineHeight,
        element.styles.paddingTop,
        element.styles.paddingBottom,
        Math.round(height),
        Math.round(offset * 2) / 2,
      ].join("|");
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, {
          offset,
          selectors: [element.selector],
          text,
          height,
        });
      else group.selectors.push(element.selector);
    }
    const candidates: FindingCandidate[] = [];
    for (const group of groups.values()) {
      const [first] = group.selectors;
      if (first === undefined) continue;
      const direction = group.offset > 0 ? "below" : "above";
      const more =
        group.selectors.length > 1
          ? ` (${group.selectors.length} elements share this geometry: ${group.selectors.slice(0, 4).join(", ")}${group.selectors.length > 4 ? ", …" : ""})`
          : "";
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:label-off-centre",
        selectorHint: first,
        explanation: `The label "${group.text}" in ${first} sits ${round(Math.abs(group.offset))}px ${direction} the vertical centre of its ${Math.round(group.height)}px box (tolerance ${config.centeringTolerance}px)${more}.`,
        acceptance: [
          `The label's ink centre in ${first} is within ${config.centeringTolerance}px of the box's vertical centre (balance padding-top/bottom or line-height).`,
        ],
        verification: verify(this.id, {
          selector: first,
          tolerance: config.centeringTolerance,
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
