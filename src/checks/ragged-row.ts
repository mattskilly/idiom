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

const RULE = "idiom:ragged-row";

/** Cards side by side in one row of a repeated collection, ending at different heights. */
export const raggedRowCheck: DeterministicCheck = {
  id: "ragged-row",
  run({ tuple, config }) {
    const settings = config.raggedRow ?? defaultChecksSettings.raggedRow;
    if (!settings.enabled) return skipped(this.id, "raggedRow");
    const scan = v2Observations(tuple)?.raggedRows;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the ragged-row scan (recapture)",
      );
    const candidates: FindingCandidate[] = scan.records.map((record) => {
      const low = Math.round(Math.min(...record.heights));
      const high = Math.round(Math.max(...record.heights));
      return {
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: record.collection,
        fingerprintHint: `ragged-row:${record.collection}:${record.row}`,
        explanation: `The ${record.items} cards in row ${record.row + 1} of ${record.collection} end up to ${round(record.spread)}px apart at ${tuple.width}px (heights ${low}–${high}px; tallest ${record.tallest}, shortest ${record.shortest}).`,
        acceptance: [
          `At ${tuple.width}px, the cards in each row of ${record.collection} end within ${legibilityLimits.raggedSpread}px of each other (for example, stretch them to the row's height).`,
        ],
        verification: verify(this.id, {
          selector: record.collection,
          row: record.row,
          viewportWidth: tuple.width,
          spread: round(record.spread),
          max: legibilityLimits.raggedSpread,
        }),
      };
    });
    return scanResult(this.id, candidates, scan);
  },
};
