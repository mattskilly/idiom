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

const RULE = "idiom:native-scrollbar";

/**
 * A scroller inside a rounded or filled box that shows the browser's own
 * space-taking scrollbar track: nothing styles it to match the box.
 */
export const nativeScrollbarCheck: DeterministicCheck = {
  id: "native-scrollbar",
  run({ tuple, config }) {
    const settings =
      config.nativeScrollbar ?? defaultChecksSettings.nativeScrollbar;
    if (!settings.enabled) return skipped(this.id, "nativeScrollbar");
    const scan = v2Observations(tuple)?.nativeScrollbars;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the scrollbar scan (recapture)",
      );
    const candidates: FindingCandidate[] =
      scan.status !== "ran"
        ? []
        : scan.records.map((record) => {
            const gutter = round(record.gutter, 0);
            const own = record.box === record.selector;
            const where =
              record.boxReason === "radius"
                ? `a rounded box (${own ? "" : `${record.box}, `}${round(record.radius, 0)}px radius)`
                : `a filled box${own ? "" : ` (${record.box})`}`;
            const overflow =
              record.kind === "textarea" ? " once its text overflows" : "";
            return {
              category: this.id,
              severity: "minor" as const,
              rule: RULE,
              selectorHint: record.selector,
              fingerprintHint: `native-scrollbar:${record.selector}`,
              explanation: `${record.selector} shows the browser's own ${gutter}px scrollbar track${overflow} inside ${where}; no scrollbar-color, scrollbar-width or ::-webkit-scrollbar styling applies to it.`,
              acceptance: [
                `${record.selector} styles its scrollbar (scrollbar-color, scrollbar-width or ::-webkit-scrollbar) to match ${record.box}, or shows no space-taking scrollbar track.`,
              ],
              verification: verify(this.id, {
                selector: record.selector,
                kind: record.kind,
                axes: record.axes,
                gutter: record.gutter,
                box: record.box,
                boxReason: record.boxReason,
                radius: record.radius,
                viewportWidth: tuple.width,
              }),
            };
          });
    return scanResult(this.id, candidates, scan);
  },
};
