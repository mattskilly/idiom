import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const brokenImageCheck: DeterministicCheck = {
  id: "broken-image",
  run({ tuple, config }) {
    if (!(config.images ?? defaultChecksSettings.images).enabled)
      return skipped(this.id, "images");
    const scan = v2Observations(tuple)?.imageRenders;
    if (scan === undefined)
      return unavailable(
        this.id,
        "image render evidence is unavailable (recapture with this version)",
      );
    const seen = new Set<string>();
    const candidates: FindingCandidate[] = scan.records
      .filter(
        (record) =>
          record.broken &&
          !seen.has(record.selector) &&
          seen.add(record.selector) !== undefined,
      )
      .map((record) => ({
        category: this.id,
        severity: "major",
        rule: "idiom:image-broken",
        selectorHint: record.selector,
        explanation: `${record.selector} did not load${record.src === "" ? "" : record.src.startsWith("data:") ? " from its inline data URI" : ` from ${record.src}`} and renders as a broken image.`,
        acceptance: [`${record.selector} loads and shows its image.`],
        verification: verify(this.id, { selector: record.selector }),
      }));
    return scanResult(this.id, candidates, scan);
  },
};
