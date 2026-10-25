import { round, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, ObservedElementV2 } from "./types.js";

/** Visible width of a rect once clipped to the viewport. */
function visibleWidth(element: ObservedElementV2, viewport: number): number {
  const left = Math.max(0, element.rect.x);
  const right = Math.min(viewport, element.rect.x + element.rect.width);
  return Math.max(0, right - left);
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * The declared primary region (checks.primaryRegion.selector) spans at least
 * minShare of the viewport width. Every run reports the measured share in
 * coverage; below the minimum is a finding.
 */
export const primaryRegionCheck: DeterministicCheck = {
  id: "primary-region",
  run({ tuple, config }) {
    const region = config.primaryRegion;
    if (region === undefined)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "no primary region configured (checks.primaryRegion)",
        },
        candidates: [],
      };
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2)
      return unavailable(
        this.id,
        "observations predate selector marks (recapture)",
      );
    const mark = (observation.selectorMarks ?? []).find(
      (entry) =>
        entry.purpose === "primary-region" &&
        entry.selector === region.selector,
    );
    if (mark === undefined)
      return unavailable(
        this.id,
        `${region.selector} was not resolved at capture (recapture after adding checks.primaryRegion)`,
      );
    const ranWith = (reason: string) => ({
      coverage: { check: this.id, status: "ran" as const, reason },
      candidates: [],
    });
    const bySelector = new Map(
      observation.elements.map((element) => [element.selector, element]),
    );
    const viewportWidth = tuple.width;
    const matched = mark.matches.flatMap((selector) => {
      const element = bySelector.get(selector);
      return element === undefined ? [] : [element];
    });
    const widest = matched
      .map((element) => ({
        element,
        width: visibleWidth(element, viewportWidth),
      }))
      .sort((a, b) => b.width - a.width)[0];
    if (widest === undefined || viewportWidth <= 0)
      return ranWith(`${region.selector} matches nothing`);
    const share = widest.width / viewportWidth;
    const minShare =
      typeof region.minShare === "number"
        ? region.minShare
        : region.minShare[tuple.viewport];
    const selector = widest.element.selector;
    const measured = `${selector} is ${percent(share)} of ${viewportWidth}px${
      matched.length > 1
        ? ` (widest of ${matched.length} matches for ${region.selector})`
        : ""
    }`;
    if (minShare === undefined)
      return ranWith(`${measured} (no minimum for viewport ${tuple.viewport})`);
    const reason = `${measured} (minimum ${percent(minShare)})`;
    if (share >= minShare - 0.005) return ranWith(reason);
    return {
      coverage: { check: this.id, status: "ran", reason },
      candidates: [
        {
          category: this.id,
          severity: "major",
          rule: "idiom:primary-region-share",
          selectorHint: selector,
          explanation: `The primary region (${selector}) spans ${Math.round(widest.width)}px — ${percent(share)} of the ${viewportWidth}px viewport, below the ${percent(minShare)} minimum.`,
          acceptance: [
            `The primary region spans at least ${percent(minShare)} of the viewport width at ${tuple.viewport}.`,
          ],
          verification: verify(this.id, {
            selector,
            share: round(share, 3),
            minShare,
            viewportWidth,
          }),
        },
      ],
    };
  },
};
