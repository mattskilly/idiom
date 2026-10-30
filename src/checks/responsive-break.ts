import { isElementPainted, paintedGate } from "./painted.js";
import {
  notApplicable,
  parseColor,
  px,
  ran,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck, ObservedElement } from "./types.js";

/**
 * Input groups pull the trailing control back by one border so the two
 * borders collapse into one line.
 */
const joinedOverlapAllowance = 1;

function visibleBorder(width: string, color: string): boolean {
  return px(width) > 0 && (parseColor(color)?.a ?? 1) > 0;
}

function radius(value: string): number {
  return px(value.split(" ")[0]);
}

/**
 * Joined controls (an input group's field and button, a segmented control)
 * overlap by their shared border: at most 1px thick, edge to edge rather than
 * a corner clip, both facing sides painting a border, facing corners squared.
 */
function joinedControls(a: ObservedElement, b: ObservedElement): boolean {
  const x1 = Math.max(a.rect.x, b.rect.x);
  const x2 = Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width);
  const y1 = Math.max(a.rect.y, b.rect.y);
  const y2 = Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) return false;
  const horizontal = width <= height;
  const [leading, trailing] = (
    horizontal
      ? a.rect.x <= b.rect.x
      : a.rect.y <= b.rect.y
  )
    ? [a, b]
    : [b, a];
  const thickness = horizontal ? width : height;
  const span = horizontal ? height : width;
  const shorter = horizontal
    ? Math.min(a.rect.height, b.rect.height)
    : Math.min(a.rect.width, b.rect.width);
  if (thickness > joinedOverlapAllowance + 0.05 || span < shorter / 2)
    return false;
  const lead = leading.styles;
  const trail = trailing.styles;
  const shared = horizontal
    ? visibleBorder(lead.borderRightWidth, lead.borderRightColor) &&
      visibleBorder(trail.borderLeftWidth, trail.borderLeftColor)
    : visibleBorder(lead.borderBottomWidth, lead.borderBottomColor) &&
      visibleBorder(trail.borderTopWidth, trail.borderTopColor);
  const corners = horizontal
    ? [
        lead.borderTopRightRadius,
        lead.borderBottomRightRadius,
        trail.borderTopLeftRadius,
        trail.borderBottomLeftRadius,
      ]
    : [
        lead.borderBottomLeftRadius,
        lead.borderBottomRightRadius,
        trail.borderTopLeftRadius,
        trail.borderTopRightRadius,
      ];
  return shared && corners.every((corner) => radius(corner) < 2);
}

/**
 * The pairs this check reports: at the narrowest viewport, two visible
 * interactive in-flow elements the capture-time hit test confirmed, neither
 * containing the other, and not a joined control group whose shared border
 * overlaps by 1px or less. Exported so element-overlap does not report them
 * twice.
 */
export function reportsInteractiveOverlap(
  element: ObservedElement,
  other: ObservedElement,
  narrowViewport: boolean,
): boolean {
  return (
    isElementPainted(element) &&
    isElementPainted(other) &&
    narrowViewport &&
    element.visible &&
    element.interactive &&
    !element.outOfFlow &&
    !other.outOfFlow &&
    element.hitTestWith.includes(other.selector) &&
    !element.ancestorSelectors.includes(other.selector) &&
    !other.ancestorSelectors.includes(element.selector) &&
    !joinedControls(element, other)
  );
}

export const responsiveBreakCheck: DeterministicCheck = {
  id: "responsive-break",
  run({ tuple, narrowViewport }) {
    if (!narrowViewport)
      return notApplicable(
        this.id,
        "evaluated only at the minimum captured CSS width",
      );
    const gate = paintedGate(tuple, ["idiom:interactive-overlap"]);
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    const candidates = [];
    const bySelector = new Map(
      observation.elements.map((element) => [element.selector, element]),
    );
    const emitted = new Set<string>();
    for (const element of observation.elements) {
      if (!element.visible || !element.interactive || element.outOfFlow)
        continue;
      for (const selector of element.hitTestWith) {
        const other = bySelector.get(selector);
        if (
          other !== undefined &&
          !gate.allows("idiom:interactive-overlap", element, other)
        )
          continue;
        if (
          other === undefined ||
          !reportsInteractiveOverlap(element, other, narrowViewport)
        )
          continue;
        const pair = [element.selector, selector].sort().join(" | ");
        if (emitted.has(pair)) continue;
        emitted.add(pair);
        candidates.push({
          category: this.id,
          severity: "major" as const,
          rule: "idiom:interactive-overlap",
          selectorHint: pair,
          explanation: `${element.selector} overlaps ${selector} in normal flow and both were confirmed by the capture-time hit test.`,
          acceptance: [
            `${element.selector} and ${selector} have no positive-area overlap at ${tuple.width}px.`,
          ],
          verification: verify(this.id, {
            selectors: [element.selector, selector],
            viewportWidth: tuple.width,
          }),
        });
      }
    }
    return gate.result(ran(this.id, candidates));
  },
};
