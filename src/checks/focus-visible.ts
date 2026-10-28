import { observed } from "../findings/observation.js";
import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const focusVisibleCheck: DeterministicCheck = {
  id: "focus-visible",
  run({ tuple, config }) {
    if (!(config.focusVisible ?? defaultChecksSettings.focusVisible).enabled)
      return skipped(this.id, "focusVisible");
    const scan = v2Observations(tuple)?.focusVisible;
    if (scan === undefined)
      return unavailable(this.id, "focus evidence requires the probe pass");
    const candidates: FindingCandidate[] = [];
    const seen = new Set<string>();
    for (const record of scan.records) {
      if (record.changed.length > 0) continue;
      const selector = record.proxy ?? record.selector;
      if (seen.has(selector)) continue;
      seen.add(selector);
      const name = record.name === "" ? selector : `“${record.name}”`;
      candidates.push({
        observation: observed(
          {
            source: "focus-trial",
            kind: "focus",
            selector: record.selector,
            name: record.name,
          },
          record,
          record.elapsedMs === undefined
            ? undefined
            : { elapsedMs: record.elapsedMs },
        ),
        category: this.id,
        severity: "major",
        rule: "idiom:focus-not-visible",
        selectorHint: selector,
        explanation: `Keyboard focus on ${name} (${record.selector}) changes nothing visible: no outline, ring, border, background or shadow.`,
        acceptance: [
          `Tabbing to ${record.selector} shows a visible focus indicator (for example a :focus-visible outline).`,
        ],
        verification: verify(this.id, { selector: record.selector }),
      });
    }
    return scanResult(this.id, candidates, scan);
  },
};
