import { ran, unavailable, verify } from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  WordBreakObservation,
} from "./types.js";

export const wordBreakCheck: DeterministicCheck = {
  id: "word-break",
  run({ tuple, config }) {
    if (!config.wordBreak?.enabled)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "checks.wordBreak is not enabled",
        },
        candidates: [],
      };
    const observation = tuple.observations;
    const scan =
      observation?.version === 2 ? observation.wordBreaks : undefined;
    if (!scan)
      return unavailable(
        this.id,
        "word break evidence is unavailable (enable checks.wordBreak and recapture)",
      );
    const owners = new Map<string, WordBreakObservation[]>();
    for (const record of scan.records) {
      const records = owners.get(record.selector) ?? [];
      if (!records.some((r) => JSON.stringify(r) === JSON.stringify(record)))
        records.push(record);
      owners.set(record.selector, records);
    }
    const candidates: FindingCandidate[] = [...owners].map(
      ([selector, splits]) => ({
        category: this.id,
        severity: "major",
        rule: "idiom:unhyphenated-word-break",
        selectorHint: selector,
        explanation: `${selector} breaks ${[...new Set(splits.map((s) => `“${s.word}”`))].join(", ")} inside a word without a hyphen at ${tuple.width}px.`,
        acceptance: [
          `Keep words in ${selector} intact or visibly hyphenated across lines at ${tuple.width}px.`,
        ],
        verification: verify(this.id, {
          selector,
          splits,
          viewportWidth: tuple.width,
        }),
      }),
    );
    const result = ran(this.id, candidates);
    if (scan.status !== "ran")
      result.coverage = {
        check: this.id,
        status: "unavailable",
        reason: scan.reason,
      };
    return result;
  },
};
