import { paintedGate } from "./painted.js";
import { ran, unavailable, verify } from "./shared.js";
import type {
  ClippedTextObservation,
  DeterministicCheck,
  FindingCandidate,
} from "./types.js";

function describeCut(clip: ClippedTextObservation): string {
  const tail = clip.visibleText.slice(-24);
  const shown =
    tail === ""
      ? ""
      : ` after "${clip.visibleText.length > 24 ? "…" : ""}${tail}"`;
  switch (clip.cut) {
    case "mid-word":
      return `cut mid-word${shown}`;
    case "sliced-line":
      return `a line is sliced through${shown}`;
    case "hidden-lines":
      return `whole lines are hidden${shown}`;
    default:
      return `cut between words${shown}`;
  }
}

/**
 * Text whose painted lines run past a box that hides them, with no ellipsis
 * or line clamp: a label that does not fit and gives no sign of it. Reported
 * once, at the element that owns the text, naming the clipping box.
 */
export const clippedTextCheck: DeterministicCheck = {
  id: "clipped-text",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.clippedText === undefined)
      return unavailable(
        this.id,
        "observations predate clipped-text signals (recapture)",
      );
    const gate = paintedGate(tuple, ["idiom:text-clipped"]);
    const candidates: FindingCandidate[] = observation.clippedText
      .filter((clip) =>
        gate.allows("idiom:text-clipped", clip.selector, clip.owner),
      )
      .map((clip) => {
        const owner = clip.owner === clip.selector ? "its own box" : clip.owner;
        const overflow = [
          clip.overflow.x > 0 ? `${clip.overflow.x}px horizontally` : "",
          clip.overflow.y > 0 ? `${clip.overflow.y}px vertically` : "",
        ]
          .filter(Boolean)
          .join(" and ");
        const lines =
          clip.lines > 1 || clip.visibleLines !== clip.lines
            ? ` ${clip.visibleLines} of ${clip.lines} lines are readable;`
            : "";
        return {
          category: this.id,
          severity: "major" as const,
          rule: "idiom:text-clipped",
          selectorHint: clip.selector,
          explanation: `The text of ${clip.selector} runs ${overflow} past ${owner}, which hides it;${lines} ${describeCut(clip)}, and no ellipsis is shown.`,
          acceptance: [
            `${clip.selector} fits its box, or truncates with an ellipsis and exposes the full text (title or tooltip).`,
          ],
          verification: verify(this.id, {
            selector: clip.selector,
            owner: clip.owner,
            axis: clip.axis,
            cut: clip.cut,
          }),
        };
      });
    return gate.result(ran(this.id, candidates));
  },
};
