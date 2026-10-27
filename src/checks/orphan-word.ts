import { defaultChecksSettings } from "../schemas/project.js";
import { paintedGate } from "./painted.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

// Anti-aliased glyphs fill far more than 2% of a word's box; a solid background fills ~0.
const minInkShare = 0.02;

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
    const gate = paintedGate(tuple, ["idiom:orphan-word"]);
    let inkSkipped = 0;
    const candidates: FindingCandidate[] = scan.records
      .filter((record) => gate.allows("idiom:orphan-word", record.selector))
      .filter((record) => {
        const blank =
          record.ink?.status === "measured" && record.ink.share < minInkShare;
        if (blank) inkSkipped += 1;
        return !blank;
      })
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
          ...(record.rect === undefined ? {} : { rect: record.rect }),
        }),
      }));
    const result = gate.result(scanResult(this.id, candidates, scan));
    return inkSkipped === 0
      ? result
      : {
          ...result,
          coverage: {
            ...result.coverage,
            inkSkipped: { "idiom:orphan-word": inkSkipped },
          },
        };
  },
};
