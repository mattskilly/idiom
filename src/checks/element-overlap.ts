import { reportsInteractiveOverlap } from "./responsive-break.js";
import { ran, round, unavailable, verify } from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  ObservedElementV2,
} from "./types.js";

/** Small absolutely positioned text on a control: badges, counts, dots. */
function isBadge(element: ObservedElementV2): boolean {
  return (
    !element.interactive &&
    element.styles.position === "absolute" &&
    element.rect.width <= 24 &&
    element.rect.height <= 24
  );
}

/**
 * Interactive or text elements whose visible boxes intersect in one layer,
 * confirmed by sampling the intersection with the browser's hit test.
 * Overlays (dialogs, menus, popovers, fixed layers) are separate layers and
 * never compared with the page beneath them.
 */
export const elementOverlapCheck: DeterministicCheck = {
  id: "element-overlap",
  run({ tuple, narrowViewport }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.overlaps === undefined)
      return unavailable(
        this.id,
        "observations predate overlap signals (recapture)",
      );
    const bySelector = new Map(
      observation.elements.map((element) => [element.selector, element]),
    );
    const candidates: FindingCandidate[] = [];
    for (const overlap of observation.overlaps) {
      const a = bySelector.get(overlap.a);
      const b = bySelector.get(overlap.b);
      if (a === undefined || b === undefined) continue;
      if (
        reportsInteractiveOverlap(a, b, narrowViewport) ||
        reportsInteractiveOverlap(b, a, narrowViewport)
      )
        continue;
      const interactive = overlap.kinds.filter(
        (kind) => kind === "interactive",
      ).length;
      // Text content areas overhang their line boxes by a pixel or two.
      const minimum = interactive === 2 ? 2 : 3;
      if (overlap.rect.width < minimum || overlap.rect.height < minimum)
        continue;
      if (isBadge(a) || isBadge(b)) continue;
      const smaller = Math.min(
        a.rect.width * a.rect.height,
        b.rect.width * b.rect.height,
      );
      const area = overlap.rect.width * overlap.rect.height;
      const width = round(overlap.rect.width);
      const height = round(overlap.rect.height);
      const evidence =
        overlap.samples === 0
          ? " (below the fold, geometry only)"
          : ` (${overlap.hits}/${overlap.samples} hit-test points)`;
      const partial =
        overlap.partial.length === 0
          ? ""
          : `; ${overlap.partial.join(" and ")} ${overlap.partial.length === 1 ? "is" : "are"} only partly visible`;
      candidates.push({
        category: this.id,
        severity:
          interactive > 0 || (smaller > 0 && area / smaller >= 0.25)
            ? "major"
            : "minor",
        rule: "idiom:elements-overlap",
        selectorHint: overlap.a,
        fingerprintHint: `${overlap.a} | ${overlap.b}`,
        explanation: `${overlap.a} overlaps ${overlap.b} by ${width}×${height}px at ${tuple.width}px${evidence}${partial}.`,
        acceptance: [
          `${overlap.a} and ${overlap.b} do not overlap at ${tuple.width}px.`,
        ],
        verification: verify(this.id, {
          selectors: [overlap.a, overlap.b],
          overlap: { width, height },
          viewportWidth: tuple.width,
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
