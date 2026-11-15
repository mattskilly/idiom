import { defaultChecksSettings } from "../schemas/project.js";
import {
  round,
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  EdgeTextObservation,
  FindingCandidate,
} from "./types.js";

const RULE = "idiom:edge-text";

/** Body text set closer to the viewport's left or right edge than the minimum. */
export const edgeTextCheck: DeterministicCheck = {
  id: "edge-text",
  run({ tuple, config }) {
    const settings = config.edgeText ?? defaultChecksSettings.edgeText;
    if (!settings.enabled) return skipped(this.id, "edgeText");
    const scan = v2Observations(tuple)?.edgeTexts;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the edge-text scan (recapture)",
      );
    const bySelector = new Map<string, EdgeTextObservation[]>();
    for (const record of scan.records)
      bySelector.set(record.selector, [
        ...(bySelector.get(record.selector) ?? []),
        record,
      ]);
    const candidates: FindingCandidate[] = [...bySelector].map(
      ([selector, records]) => {
        const threshold = records[0]?.threshold ?? 16;
        const sides = records
          .map(
            (record) =>
              `${round(record.distance)}px from the ${record.side} edge`,
          )
          .join(" and ");
        return {
          category: this.id,
          severity: "minor",
          rule: RULE,
          selectorHint: selector,
          fingerprintHint: `edge-text:${selector}`,
          explanation: `Body text in ${selector} sits ${sides} of the ${tuple.width}px viewport; text needs at least ${threshold}px from the screen's edge at this width.`,
          acceptance: [
            `At ${tuple.width}px, the text in ${selector} is at least ${threshold}px from the viewport's left and right edges.`,
          ],
          verification: verify(this.id, {
            selector,
            viewportWidth: tuple.width,
            threshold,
            distances: Object.fromEntries(
              records.map((record) => [record.side, round(record.distance)]),
            ),
          }),
        };
      },
    );
    return scanResult(this.id, candidates, scan);
  },
};
