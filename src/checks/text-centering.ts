import { paintedGate } from "./painted.js";
import {
  isBounded,
  isPainted,
  isVisuallyHidden,
  px,
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
 * A rule above or below an open label is decoration: the label belongs to
 * the content space between that rule and the opposite edge.
 */
function measuredBox(element: SignalledElement) {
  const { rect, styles } = element;
  const top = px(styles.borderTopWidth) > 0 && isPainted(styles.borderTopColor);
  const bottom =
    px(styles.borderBottomWidth) > 0 && isPainted(styles.borderBottomColor);
  if (!isPainted(styles.backgroundColor) && top !== bottom) {
    const insetTop = px(styles.borderTopWidth) + px(styles.paddingTop);
    const insetBottom = px(styles.borderBottomWidth) + px(styles.paddingBottom);
    return {
      top: rect.y + insetTop,
      height: rect.height - insetTop - insetBottom,
      basis: "content" as const,
      ruleSide: top ? "top" : "bottom",
    };
  }
  return {
    top: rect.y,
    height: rect.height,
    basis: "border" as const,
    ruleSide: undefined,
  };
}

/**
 * Single-line labels inside a filled or bordered shape (chips, buttons,
 * badges, specimen swatches) must sit on the shape's vertical centre. The
 * perceived centre of a label is the band between its ink top and its
 * baseline, so descenders do not count against it. Only painted text is
 * measured (screen-reader labels do not count), and a single glyph such as
 * + − × centres on its own ink box.
 * Open boxes with a single top or bottom rule use their content box.
 */
export const textCenteringCheck: DeterministicCheck = {
  id: "text-centering",
  run({ tuple, config }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const gate = paintedGate(tuple, ["idiom:label-off-centre"]);
    const elements = gate.filter(
      "idiom:label-off-centre",
      observed.elements.filter(isBounded),
    );
    const bounded = new Set(
      elements.filter(isBounded).map((element) => element.selector),
    );
    const groups = new Map<
      string,
      {
        offset: number;
        selectors: string[];
        text: string;
        height: number;
        basis: "border" | "content";
        ruleSide: string | undefined;
      }
    >();
    for (const element of elements) {
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
      const inner = elements.some(
        (other) =>
          other !== element &&
          bounded.has(other.selector) &&
          other.ancestorSelectors.includes(element.selector) &&
          labelOf(other).text === text,
      );
      if (inner) continue;
      const box = measuredBox(element);
      if (box.height <= 0) continue;
      const centre = box.top + box.height / 2;
      const offset = label.inkCenterY - centre;
      if (Math.abs(offset) <= config.centeringTolerance) continue;
      const key = [
        element.tag,
        element.styles.fontSize,
        element.styles.lineHeight,
        element.styles.paddingTop,
        element.styles.paddingBottom,
        Math.round(height),
        box.basis,
        Math.round(box.height),
        box.ruleSide,
        Math.round(offset * 2) / 2,
      ].join("|");
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, {
          offset,
          selectors: [element.selector],
          text,
          height: box.height,
          basis: box.basis,
          ruleSide: box.ruleSide,
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
      const boxDescription =
        group.basis === "content"
          ? `content box inside its ${group.ruleSide} rule`
          : "box";
      const acceptanceBox = group.basis === "content" ? "content box" : "box";
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:label-off-centre",
        selectorHint: first,
        explanation: `The label "${group.text}" in ${first} sits ${round(Math.abs(group.offset))}px ${direction} the vertical centre of its ${Math.round(group.height)}px ${boxDescription} (tolerance ${config.centeringTolerance}px)${more}.`,
        acceptance: [
          `The label's ink centre in ${first} is within ${config.centeringTolerance}px of the ${acceptanceBox}'s vertical centre (balance padding-top/bottom or line-height).`,
        ],
        verification: verify(this.id, {
          selector: first,
          tolerance: config.centeringTolerance,
        }),
      });
    }
    return gate.result(ran(this.id, candidates));
  },
};
