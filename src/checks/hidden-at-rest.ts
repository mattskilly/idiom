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

const RULE = "idiom:hidden-at-rest";
const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * Content whose reveal never ran: after motion settles, more than a fifth of
 * the text in the viewport is still at opacity under 0.1 or visibility
 * hidden, so the page looks empty while every painted-text rule skips it.
 */
export const hiddenAtRestCheck: DeterministicCheck = {
  id: "hidden-at-rest",
  run({ tuple, config }) {
    const settings = config.hiddenAtRest ?? defaultChecksSettings.hiddenAtRest;
    if (!settings.enabled) return skipped(this.id, "hiddenAtRest");
    const scan = v2Observations(tuple)?.hiddenAtRest;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the hidden-at-rest scan (recapture)",
      );
    const countShare = scan.total === 0 ? 0 : scan.hidden / scan.total;
    const areaShare = scan.area === 0 ? 0 : scan.hiddenArea / scan.area;
    const limit = legibilityLimits.hiddenShare;
    const candidates: FindingCandidate[] = [];
    if (
      scan.total >= 1 &&
      scan.records.length > 0 &&
      (countShare > limit || areaShare > limit)
    ) {
      const roots = new Map<string, number>();
      for (const record of scan.records)
        roots.set(record.root, (roots.get(record.root) ?? 0) + 1);
      const root =
        [...roots.entries()].sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )[0]?.[0] ?? (scan.records[0]?.root as string);
      const rootRecord = scan.records.find((record) => record.root === root);
      const cause =
        rootRecord?.cause === "visibility"
          ? "visibility: hidden"
          : `opacity ${round(rootRecord?.opacity ?? 0, 2)}`;
      const examples = scan.records
        .slice(0, 3)
        .map((record) => record.selector)
        .join(", ");
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: root,
        fingerprintHint: `hidden-at-rest:${root}`,
        explanation: `${scan.hidden} of ${scan.total} text blocks in the viewport (${percent(countShare)} by count, ${percent(areaShare)} by area) are invisible at ${tuple.width}px after motion settled: their opacity is under ${legibilityLimits.hiddenOpacity} or they are visibility: hidden. Most sit under ${root} (${cause}), for example ${examples}. A reveal animation likely never ran, so the page looks empty to a person while checks of painted text skip it.`,
        acceptance: [
          `At ${tuple.width}px, after motion completes, at most ${percent(limit)} of the viewport's text (by count and by area) is at opacity under ${legibilityLimits.hiddenOpacity} or visibility: hidden; content hidden on purpose is declared in the state's intentionallyHidden selectors.`,
        ],
        verification: verify(this.id, {
          root,
          viewportWidth: tuple.width,
          total: scan.total,
          hidden: scan.hidden,
          countShare: round(countShare, 3),
          areaShare: round(areaShare, 3),
          limit,
          examples: scan.records.slice(0, 3).map((record) => record.selector),
        }),
      });
    }
    return scanResult(this.id, candidates, scan);
  },
};
