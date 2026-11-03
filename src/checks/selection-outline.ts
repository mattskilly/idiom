import {
  round,
  scanResult,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const RULE = "idiom:selection-outline-crosses-popover";

/**
 * A selection or focus frame drawn over an element that runs across an open
 * popover stacked above the element, so the frame line cuts through the
 * popover's content.
 */
export const selectionOutlineCheck: DeterministicCheck = {
  id: "selection-outline",
  run({ tuple }) {
    const scan = v2Observations(tuple)?.selectionOutlines;
    if (scan === undefined)
      return unavailable(
        this.id,
        "selection outline evidence requires a recapture",
      );
    const candidates: FindingCandidate[] = [];
    const seen = new Set<string>();
    for (const record of scan.records) {
      const key = `${record.painter}|${record.popover}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { x, y, width, height } = record.crossing;
      const at = `${round(width)}×${round(height)}px at (${round(x)}, ${round(y)})`;
      candidates.push({
        category: this.id,
        severity: "major",
        rule: RULE,
        selectorHint: record.owner,
        fingerprintHint: `${RULE}|${record.owner}|${record.popover}`,
        explanation: `The ${record.ownerState} outline of ${record.ownerName} (${record.owner}), drawn by ${record.painter} as ${record.kind}, runs across the open ${record.popoverRole} ${record.popover} for ${at} even though the ${record.popoverRole} is above it.`,
        acceptance: [
          `With ${record.popover} open, the selection outline of ${record.owner} is hidden beneath it or clipped around it; no outline line crosses the ${record.popoverRole}'s content.`,
        ],
        verification: verify(this.id, {
          selectors: [record.owner, record.painter, record.popover],
          crossing: record.crossing,
          viewportWidth: tuple.width,
        }),
      });
    }
    return scanResult(this.id, candidates, scan);
  },
};
