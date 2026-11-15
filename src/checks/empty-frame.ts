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
  UnderfilledFrameObservation,
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

const percent = (share: number) => `${Math.round(share * 100)}%`;

const sideWord: Record<UnderfilledFrameObservation["side"], string> = {
  left: "to its left",
  right: "to its right",
  top: "above it",
  bottom: "below it",
};

/** One candidate per sibling group of underfilled frames (or per lone frame). */
function underfilledCandidates(
  check: "empty-frame",
  frames: UnderfilledFrameObservation[],
  viewportWidth: number,
): FindingCandidate[] {
  const groups = new Map<string, UnderfilledFrameObservation[]>();
  for (const frame of frames) {
    const key = frame.group ?? frame.selector;
    const list = groups.get(key);
    if (list) list.push(frame);
    else groups.set(key, [frame]);
  }
  return [...groups.entries()].map(([key, members]) => {
    const first = members[0] as UnderfilledFrameObservation;
    const width = round(first.rect.width, 0);
    const height = round(first.rect.height, 0);
    const mediaWidth = round(first.mediaRect.width, 0);
    const mediaHeight = round(first.mediaRect.height, 0);
    const grouped =
      first.group !== undefined && members.length >= 2
        ? ` (${members.length} sibling frames in ${first.group} do the same)`
        : "";
    return {
      category: check,
      severity: "minor",
      rule: RULE,
      selectorHint: first.selector,
      fingerprintHint: `empty-frame:underfilled:${key}`,
      explanation: `${first.selector} is a ${width}×${height}px frame whose ${mediaWidth}×${mediaHeight}px media (${first.media}) fills ${percent(1 - first.emptyShare)} of it, leaving ${percent(first.emptyShare)} empty ${sideWord[first.side]} at ${viewportWidth}px${grouped}.`,
      acceptance: [
        `At ${viewportWidth}px, the media in ${first.selector} fills its frame, or the frame shrinks to fit it, or the media is centred or labelled.`,
      ],
      verification: verify(check, {
        selector: first.selector,
        media: first.media,
        viewportWidth,
        width: round(first.rect.width),
        height: round(first.rect.height),
        mediaWidth: round(first.mediaRect.width),
        mediaHeight: round(first.mediaRect.height),
        emptyShare: first.emptyShare,
        side: first.side,
        count: members.length,
      }),
    };
  });
}

/**
 * A box drawn as a frame (a border, or a fill that differs from what is
 * behind it) with nothing visible inside it: a header bar whose only child
 * is hidden at this width, a card whose content never rendered. Also a
 * tile, card or option whose lone media is much smaller than its frame and
 * pinned off-centre, leaving most of the frame empty.
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
    const underfilled = v2Observations(tuple)?.underfilledFrames;
    if (underfilled === undefined)
      return {
        ...ran(this.id, candidates),
        coverage: {
          check: this.id,
          status: "ran",
          reason:
            "observations predate the underfilled-media scan (recapture to judge media in frames)",
        },
      };
    return ran(this.id, [
      ...candidates,
      ...underfilledCandidates("empty-frame", underfilled, tuple.width),
    ]);
  },
};
