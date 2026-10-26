import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const lineLengthCheck: DeterministicCheck = {
  id: "line-length",
  run({ tuple, config }) {
    const settings = config.lineLength ?? defaultChecksSettings.lineLength;
    if (!settings.enabled) return skipped(this.id, "lineLength");
    const scan = v2Observations(tuple)?.lineLengths;
    if (scan === undefined)
      return unavailable(
        this.id,
        "line length evidence is unavailable (recapture with this version)",
      );
    const candidates: FindingCandidate[] = scan.records
      .filter((record) => record.chars > settings.max)
      .map((record) => ({
        category: this.id,
        severity: "minor",
        rule: "idiom:line-too-long",
        selectorHint: record.selector,
        explanation: `${record.selector} runs about ${Math.round(record.chars)} characters per line (${Math.round(record.width)}px wide) at ${tuple.width}px; keep body text at or under ${settings.max}.`,
        acceptance: [
          `Lines in ${record.selector} hold at most about ${settings.max} characters at ${tuple.width}px (for example max-width: 65ch).`,
        ],
        verification: verify(this.id, {
          selector: record.selector,
          max: settings.max,
          viewportWidth: tuple.width,
        }),
      }));
    return scanResult(this.id, candidates, scan);
  },
};
