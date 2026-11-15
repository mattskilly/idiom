import { defaultChecksSettings } from "../schemas/project.js";
import { legibilityLimits } from "./legibility-dom.js";
import {
  round,
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const RULE = "idiom:cramped-padding";

/** Text pressed against the inner edge of the bordered or filled box around it. */
export const crampedPaddingCheck: DeterministicCheck = {
  id: "cramped-padding",
  run({ tuple, config }) {
    const settings =
      config.crampedPadding ?? defaultChecksSettings.crampedPadding;
    if (!settings.enabled) return skipped(this.id, "crampedPadding");
    const scan = v2Observations(tuple)?.crampedPaddings;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the cramped-padding scan (recapture)",
      );
    const min = legibilityLimits.paddingMin;
    const candidates: FindingCandidate[] = scan.records.map((record) => ({
      category: this.id,
      severity: "minor",
      rule: RULE,
      selectorHint: record.container,
      fingerprintHint: `cramped-padding:${record.container}`,
      explanation: `Text in ${record.container} (${record.selector}) sits ${round(record.distance)}px from the box's ${record.side} inner edge at ${tuple.width}px; text inside a bordered or filled box needs at least ${min}px of room.`,
      acceptance: [
        `At ${tuple.width}px, text inside ${record.container} is at least ${min}px from each drawn inner edge.`,
      ],
      verification: verify(this.id, {
        selector: record.container,
        text: record.selector,
        viewportWidth: tuple.width,
        side: record.side,
        distance: round(record.distance),
        min,
      }),
    }));
    return scanResult(this.id, candidates, scan);
  },
};
