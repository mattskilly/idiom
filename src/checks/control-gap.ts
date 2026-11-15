import { defaultChecksSettings } from "../schemas/project.js";
import {
  round,
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const RULE = "idiom:control-gap";

/** Text runs, icons and buttons crammed together inside one inline control. */
export const controlGapCheck: DeterministicCheck = {
  id: "control-gap",
  run({ tuple, config }) {
    const settings = config.controlGap ?? defaultChecksSettings.controlGap;
    if (!settings.enabled) return skipped(this.id, "controlGap");
    const scan = v2Observations(tuple)?.controlGaps;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the control-gap scan (recapture)",
      );
    const scopes = settings.scopes ?? [];
    // The strictest learned law whose surface holds the control, else the global minimum.
    const lawFor = (record: { scopes?: string[] | undefined }) =>
      scopes
        .filter((scope) => record.scopes?.includes(scope.selector) === true)
        .reduce<(typeof scopes)[number] | undefined>(
          (strictest, scope) =>
            strictest === undefined || scope.min > strictest.min
              ? scope
              : strictest,
          undefined,
        );
    const candidates: FindingCandidate[] = scan.records.flatMap((record) => {
      const law = lawFor(record);
      const min = law?.min ?? settings.min;
      if (record.gap >= min) return [];
      const cited =
        law === undefined ? "" : ` (law: "${law.name}", in ${law.selector})`;
      return [
        {
          category: this.id,
          severity: "minor",
          rule: RULE,
          selectorHint: record.control,
          fingerprintHint: `control-gap:${record.control}:${record.first}:${record.second}`,
          explanation: `In ${record.control}, ${record.first} and ${record.second} (${record.firstKind} and ${record.secondKind}) sit ${round(record.gap)}px apart at ${tuple.width}px; parts inside one control need at least ${min}px between them${cited}.`,
          acceptance: [
            `At ${tuple.width}px, ${record.first} and ${record.second} inside ${record.control} are at least ${min}px apart.`,
          ],
          verification: verify(this.id, {
            selector: record.control,
            first: record.first,
            second: record.second,
            gap: round(record.gap),
            min,
            ...(law === undefined ? {} : { scope: law.selector }),
            viewportWidth: tuple.width,
          }),
        } satisfies FindingCandidate,
      ];
    });
    return scanResult(this.id, candidates, scan);
  },
};
