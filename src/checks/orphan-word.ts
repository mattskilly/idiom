import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const orphanWordCheck: DeterministicCheck = {
  id: "orphan-word",
  run({ tuple, config }) {
    const settings = config.orphanWord ?? defaultChecksSettings.orphanWord;
    if (!settings.enabled) return skipped(this.id, "orphanWord");
    const scan = v2Observations(tuple)?.orphanWords;
    if (scan === undefined)
      return unavailable(
        this.id,
        "orphan word evidence is unavailable (recapture with this version)",
      );
    const seen = new Set<string>();
    const candidates: FindingCandidate[] = scan.records
      .filter((record) => {
        if ([...record.word].length > settings.maxChars) return false;
        if (seen.has(record.selector)) return false;
        seen.add(record.selector);
        return true;
      })
      .map((record) => ({
        category: this.id,
        severity: "minor",
        rule: "idiom:orphan-word",
        selectorHint: record.selector,
        explanation: `${record.selector} leaves “${record.word}” alone on its last line (${record.lines} lines) at ${tuple.width}px.`,
        acceptance: [
          `The last line of ${record.selector} holds more than one word at ${tuple.width}px (for example text-wrap: balance or pretty, or a non-breaking space).`,
        ],
        verification: verify(this.id, {
          selector: record.selector,
          viewportWidth: tuple.width,
        }),
      }));
    return scanResult(this.id, candidates, scan);
  },
};
