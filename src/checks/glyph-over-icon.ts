import { defaultChecksSettings } from "../schemas/project.js";
import {
  ran,
  round,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const RULE = "idiom:glyph-over-icon";

/**
 * A small decorative glyph or badge drawn over another icon inside one small
 * control (an external-link mark over a rail icon's corner): the two shapes
 * merge and neither reads cleanly. Count badges and status dots are exempt.
 */
export const glyphOverIconCheck: DeterministicCheck = {
  id: "glyph-over-icon",
  run({ tuple, config }) {
    const settings =
      config.glyphOverIcon ?? defaultChecksSettings.glyphOverIcon;
    if (!settings.enabled) return skipped(this.id, "glyphOverIcon");
    const overlaps = v2Observations(tuple)?.glyphOverlaps;
    if (overlaps === undefined)
      return unavailable(
        this.id,
        "observations predate the glyph-over-icon scan (recapture)",
      );
    const candidates: FindingCandidate[] = overlaps.map((overlap) => {
      const size = (rect: { width: number; height: number }) =>
        `${round(rect.width, 0)}×${round(rect.height, 0)}px`;
      const percent = Math.round(overlap.ratio * 100);
      return {
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: overlap.glyph,
        fingerprintHint: `glyph-over-icon:${overlap.control}|${overlap.glyph}`,
        explanation: `A ${size(overlap.glyphRect)} glyph (${overlap.glyph}) sits over the icon ${overlap.icon} inside the ${size(overlap.controlRect)} control ${overlap.control} at ${tuple.width}px, covering it with ${percent}% of its own box.`,
        acceptance: [
          `Inside ${overlap.control}, ${overlap.glyph} does not overlap ${overlap.icon} at ${tuple.width}px.`,
        ],
        verification: verify(this.id, {
          selectors: [overlap.control, overlap.glyph, overlap.icon],
          viewportWidth: tuple.width,
          glyphSize: {
            width: round(overlap.glyphRect.width),
            height: round(overlap.glyphRect.height),
          },
          overlap: overlap.overlap,
          ratio: overlap.ratio,
        }),
      };
    });
    return ran(this.id, candidates);
  },
};
