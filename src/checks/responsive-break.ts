import { ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, ObservedElement } from "./types.js";

/**
 * The pairs this check reports: at the narrowest viewport, two visible
 * interactive in-flow elements the capture-time hit test confirmed, neither
 * containing the other. Exported so element-overlap does not report them twice.
 */
export function reportsInteractiveOverlap(
  element: ObservedElement,
  other: ObservedElement,
  narrowViewport: boolean,
): boolean {
  return (
    narrowViewport &&
    element.visible &&
    element.interactive &&
    !element.outOfFlow &&
    !other.outOfFlow &&
    element.hitTestWith.includes(other.selector) &&
    !element.ancestorSelectors.includes(other.selector) &&
    !other.ancestorSelectors.includes(element.selector)
  );
}

export const responsiveBreakCheck: DeterministicCheck = {
  id: "responsive-break",
  run({ tuple, narrowViewport }) {
    if (!narrowViewport) return ran(this.id, []);
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
    return ran(this.id, candidates);
  },
};
