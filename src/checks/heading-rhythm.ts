import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const RULE = "idiom:heading-rhythm";

/** A heading no further from the block above it than from the content it introduces. */
export const headingRhythmCheck: DeterministicCheck = {
  id: "heading-rhythm",
  run({ tuple, config }) {
    const settings =
      config.headingRhythm ?? defaultChecksSettings.headingRhythm;
    if (!settings.enabled) return skipped(this.id, "headingRhythm");
    const scan = v2Observations(tuple)?.headingRhythms;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the heading-rhythm scan (recapture)",
      );
    const candidates: FindingCandidate[] = scan.records.map((record) => ({
      category: this.id,
      severity: "minor",
      rule: RULE,
      selectorHint: record.selector,
      fingerprintHint: `heading-rhythm:${record.selector}`,
      explanation: `The heading ${record.selector}${record.text === "" ? "" : ` ("${record.text}")`} sits ${record.gapAbove}px below ${record.above} and ${record.gapBelow}px above ${record.below} at ${tuple.width}px; a heading should be closer to the content it introduces than to the block before it.`,
      acceptance: [
        `At ${tuple.width}px, the gap above ${record.selector} is larger than the gap below it.`,
      ],
      verification: verify(this.id, {
        selector: record.selector,
        viewportWidth: tuple.width,
        gapAbove: record.gapAbove,
        gapBelow: record.gapBelow,
        above: record.above,
        below: record.below,
      }),
    }));
    return scanResult(this.id, candidates, scan);
  },
};
