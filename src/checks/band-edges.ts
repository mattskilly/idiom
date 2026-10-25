import { ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

/** Largest bounded-span membership, with no arbitrary reference band. */
function dominant(values: number[], tolerance: number): number | undefined {
  const sorted = [...values].sort((a, b) => a - b);
  let largest: number[] = [];
  let tied = false;
  for (let start = 0; start < sorted.length; start++) {
    const group = sorted
      .slice(start)
      .filter((v) => v - (sorted[start] as number) <= tolerance);
    if (group.length > largest.length) {
      largest = group;
      tied = false;
    } else if (group.length === largest.length) tied = true;
  }
  if (tied || largest.length < 2 || largest.length <= values.length / 2)
    return undefined;
  const middle = Math.floor(largest.length / 2);
  return largest.length % 2
    ? largest[middle]
    : ((largest[middle - 1] as number) + (largest[middle] as number)) / 2;
}

export const bandEdgesCheck: DeterministicCheck = {
  id: "band-edges",
  run({ tuple, config }) {
    if (!config.bandEdges?.enabled)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "checks.bandEdges is not enabled",
        },
        candidates: [],
      };
    const observation = tuple.observations;
    const scan = observation?.version === 2 ? observation.bandEdges : undefined;
    if (!scan)
      return unavailable(
        this.id,
        "band edge evidence is unavailable (enable checks.bandEdges and recapture)",
      );
    const bands = scan.records.filter(
      (b) => !b.fullBleedMedia && b.content !== null,
    );
    const tolerance = config.bandEdges.tolerance;
    const left = dominant(
      bands.map((b) => b.content?.left as number),
      tolerance,
    );
    const right = dominant(
      bands.map((b) => b.content?.right as number),
      tolerance,
    );
    const candidates: FindingCandidate[] = [];
    for (const band of bands) {
      const content = band.content;
      if (!content) continue;
      const deviations = {
        left: left === undefined ? null : content.left - left,
        right: right === undefined ? null : content.right - right,
      };
      const sides = (["left", "right"] as const).filter(
        (side) =>
          deviations[side] !== null &&
          Math.abs(deviations[side] as number) > tolerance,
      );
      if (!sides.length) continue;
      const detail = sides
        .map(
          (side) =>
            `${side} edge ${content[side]}px differs from dominant ${side === "left" ? left : right}px by ${Math.abs(deviations[side] as number)}px`,
        )
        .join("; ");
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:band-content-edge",
        selectorHint: band.selector,
        explanation: `${band.selector} at ${tuple.width}px: ${detail} (tolerance ${tolerance}px).`,
        acceptance: [
          `Align ${band.selector}'s content edges within ${tolerance}px of the dominant page gutters at ${tuple.width}px.`,
        ],
        verification: verify(this.id, {
          selector: band.selector,
          contentSelectors: content.selectors,
          actual: { left: content.left, right: content.right },
          dominant: { left: left ?? null, right: right ?? null },
          deviations,
          tolerance,
          viewportWidth: tuple.width,
        }),
      });
    }
    const result = ran(this.id, candidates);
    if (scan.status !== "ran")
      result.coverage = {
        check: this.id,
        status: "unavailable",
        reason: scan.reason,
      };
    else if (left === undefined || right === undefined)
      result.coverage.reason = `No dominant ${[left === undefined ? "left" : "", right === undefined ? "right" : ""].filter(Boolean).join("/")} edge: insufficient bands, tied groups, or no strict majority within ${tolerance}px.`;
    return result;
  },
};
