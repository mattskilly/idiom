import { paintedGate } from "./painted.js";
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
 * never compared with the page beneath them. Overlaps no hit-test point
 * could sample (below the fold, geometry only) are reported as minor.
 *
 * The deliberate exception is `idiom:popover-covers-control`: an open,
 * non-modal overlay whose box covers a visible, enabled field outside it, or
 * the control that opened it beyond its anchor edge. A field the overlay
 * hides is major when the hit test confirms it; the trigger, or a cover
 * below the fold, is minor.
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
    const gate = paintedGate(tuple, [
      "idiom:elements-overlap",
      ...(observation.popoverCovers === undefined
        ? []
        : ["idiom:popover-covers-control"]),
    ]);
    const bySelector = new Map(
      observation.elements.map((element) => [element.selector, element]),
    );
    const candidates: FindingCandidate[] = [];
    const ambiguous = new Map<
      string,
      { cards: Set<string>; a: string; b: string }
    >();
    for (const overlap of observation.overlaps) {
      const a = bySelector.get(overlap.a);
      const b = bySelector.get(overlap.b);
      if (a === undefined || b === undefined) continue;
      if (!gate.allows("idiom:elements-overlap", a, b)) continue;
      if (overlap.cardAction?.status === "intentional") continue;
      if (overlap.cardAction?.status === "ambiguous") {
        const { group, card } = overlap.cardAction;
        const entry = ambiguous.get(group) ?? {
          cards: new Set<string>(),
          a: overlap.a,
          b: overlap.b,
        };
        entry.cards.add(card);
        ambiguous.set(group, entry);
        continue;
      }
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
      // No hit-test sample means no confirmation: geometry alone is minor.
      const geometryOnly = overlap.samples === 0;
      const evidence = geometryOnly
        ? " (below the fold, geometry only)"
        : ` (${overlap.hits}/${overlap.samples} hit-test points)`;
      const partial =
        overlap.partial.length === 0
          ? ""
          : `; ${overlap.partial.join(" and ")} ${overlap.partial.length === 1 ? "is" : "are"} only partly visible`;
      candidates.push({
        category: this.id,
        severity:
          !geometryOnly &&
          (interactive > 0 || (smaller > 0 && area / smaller >= 0.25))
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
    for (const [group, entry] of [...ambiguous].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      candidates.push({
        category: this.id,
        severity: "info",
        rule: "idiom:elements-overlap",
        selectorHint: entry.a,
        fingerprintHint: `card-action ${group}`,
        explanation: `${entry.cards.size} card(s) in ${group} have overlapping links and actions whose intent is ambiguous; review the card interaction.`,
        acceptance: [
          "Each card's primary link and subsidiary action remain independently reachable.",
        ],
        verification: verify(this.id, {
          group,
          affectedCards: entry.cards.size,
          selectors: [entry.a, entry.b],
        }),
      });
    }
    for (const cover of observation.popoverCovers ?? []) {
      if (
        !gate.allows(
          "idiom:popover-covers-control",
          cover.overlay,
          cover.target,
        )
      )
        continue;
      const geometryOnly = cover.samples === 0;
      const width = round(cover.rect.width);
      const height = round(cover.rect.height);
      const what =
        cover.targetRole === "field"
          ? `the field ${cover.target}`
          : `the control that opened it (${cover.target}) beyond its anchor edge`;
      candidates.push({
        category: this.id,
        severity:
          cover.targetRole === "field" && !geometryOnly ? "major" : "minor",
        rule: "idiom:popover-covers-control",
        selectorHint: cover.overlay,
        fingerprintHint: `${cover.overlay} | ${cover.target}`,
        explanation: `The open overlay ${cover.overlay} covers ${what} by ${width}×${height}px at ${tuple.width}px${
          geometryOnly
            ? " (below the fold, geometry only)"
            : ` (${cover.hits}/${cover.samples} hit-test points land on the overlay)`
        }.`,
        acceptance: [
          `While ${cover.overlay} is open, ${cover.target} stays visible and reachable: the overlay closes, or opens where it does not cover it, at ${tuple.width}px.`,
        ],
        verification: verify(this.id, {
          selectors: [cover.overlay, cover.target],
          targetRole: cover.targetRole,
          overlap: { width, height },
          viewportWidth: tuple.width,
        }),
      });
    }
    return gate.result(ran(this.id, candidates));
  },
};
