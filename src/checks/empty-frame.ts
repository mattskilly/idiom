import { defaultChecksSettings } from "../schemas/project.js";
import {
  ran,
  round,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  EmptyFrameObservation,
  FindingCandidate,
} from "./types.js";

const RULE = "idiom:empty-frame";

function paintPhrase(frame: EmptyFrameObservation): string {
  const sides = frame.borderSides;
  const border =
    sides.length === 4
      ? "a border"
      : sides.length === 0
        ? ""
        : `a ${sides.join(" and ")} border`;
  if (frame.paint === "background") return "a filled background";
  if (frame.paint === "both") return `a filled background and ${border}`;
  return border;
}

/**
 * A box drawn as a frame (a border, or a fill that differs from what is
 * behind it) with nothing visible inside it: a header bar whose only child
 * is hidden at this width, a card whose content never rendered.
 */
export const emptyFrameCheck: DeterministicCheck = {
  id: "empty-frame",
  run({ tuple, config }) {
    const settings = config.emptyFrame ?? defaultChecksSettings.emptyFrame;
    if (!settings.enabled) return skipped(this.id, "emptyFrame");
    const frames = v2Observations(tuple)?.emptyFrames;
    if (frames === undefined)
      return unavailable(
        this.id,
        "observations predate the empty-frame scan (recapture)",
      );
    const candidates: FindingCandidate[] = frames.map((frame) => {
      const size = `${round(frame.rect.width, 0)}×${round(frame.rect.height, 0)}px`;
      const hidden =
        frame.hiddenChildren === 0
          ? ""
          : ` (${frame.hiddenChildren} child${frame.hiddenChildren === 1 ? " is" : "ren are"} hidden at this width)`;
      return {
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: frame.selector,
        fingerprintHint: `empty-frame:${frame.selector}`,
        explanation: `${frame.selector} is a ${size} box with ${paintPhrase(frame)} and nothing visible inside it at ${tuple.width}px${hidden}.`,
        acceptance: [
          `At ${tuple.width}px, ${frame.selector} shows content, or is not drawn as a bordered or filled box when it has none.`,
        ],
        verification: verify(this.id, {
          selector: frame.selector,
          viewportWidth: tuple.width,
          width: round(frame.rect.width),
          height: round(frame.rect.height),
          paint: frame.paint,
          borderSides: frame.borderSides,
          hiddenChildren: frame.hiddenChildren,
        }),
      };
    });
    return ran(this.id, candidates);
  },
};
