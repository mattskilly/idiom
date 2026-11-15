import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const RULE = "idiom:negative-spacing";

/** Interface text squeezed with a negative letter-spacing or word-spacing. */
export const negativeSpacingCheck: DeterministicCheck = {
  id: "negative-spacing",
  run({ tuple, config }) {
    const settings =
      config.negativeSpacing ?? defaultChecksSettings.negativeSpacing;
    if (!settings.enabled) return skipped(this.id, "negativeSpacing");
    const scan = v2Observations(tuple)?.negativeSpacings;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the negative-spacing scan (recapture)",
      );
    const candidates: FindingCandidate[] = scan.records.map((record) => ({
      category: this.id,
      severity: "minor",
      rule: RULE,
      selectorHint: record.selector,
      fingerprintHint: `negative-spacing:${record.selector}:${record.property}`,
      explanation: `${record.selector} sets ${record.property}: ${record.value}px (${record.em}em), squeezing ${settings.scope === "all" ? "its text" : "interface text"} tighter than the typeface was drawn to sit.`,
      acceptance: [`${record.selector} has no negative ${record.property}.`],
      verification: verify(this.id, {
        selector: record.selector,
        property: record.property,
        value: record.value,
        em: record.em,
      }),
    }));
    return scanResult(this.id, candidates, scan);
  },
};
