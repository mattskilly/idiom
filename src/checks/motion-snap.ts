import type { ActionTimeline, VisibleChange } from "./types.js";

/**
 * Properties whose animation makes a visible change read as motion rather
 * than a snap. Colour-only effects (background, border colour) do not.
 */
export const RELEVANT_MOTION_PROPERTIES: ReadonlySet<string> = new Set([
  "all",
  "opacity",
  "transform",
  "translate",
  "scale",
  "rotate",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "top",
  "left",
  "right",
  "bottom",
  "inset",
  "flex-basis",
  "grid-template-rows",
  "grid-template-columns",
  "margin",
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-block",
  "margin-inline",
  "padding",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-block",
  "padding-inline",
  "clip-path",
]);

/** A snapping change this many times smaller than an animated one rides along. */
const PERIPHERAL_RATIO = 4;

/** A covering animation on a relevant property that actually takes time. */
export function isAnimated(
  change: VisibleChange,
  action: Pick<ActionTimeline, "animations">,
): boolean {
  if (change.progressive) return true;
  return change.animations.some((index) => {
    const animation = action.animations[index];
    if (animation === undefined) return false;
    const runs =
      animation.iterations === "infinite" || (animation.durationMs ?? 0) > 0;
    return (
      runs &&
      animation.properties.some((property) =>
        RELEVANT_MOTION_PROPERTIES.has(property),
      )
    );
  });
}

/** A change the user sees snap: big enough, not text, nothing animating it. */
export function isSnapCandidate(
  change: VisibleChange,
  action: Pick<ActionTimeline, "animations" | "viewTransition">,
  minExtentPx: number,
): boolean {
  return (
    !change.textOnly &&
    change.extent >= minExtentPx &&
    !action.viewTransition.used &&
    !isAnimated(change, action)
  );
}

/**
 * Each change group's verdict in one action. A group is animated when any of
 * its visible changes animates (a tab panel fading in while the old one
 * hides is a transitioned swap); otherwise it snaps.
 */
export function keyVerdicts(
  action: Pick<
    ActionTimeline,
    "animations" | "viewTransition" | "visibleChanges"
  >,
  minExtentPx: number,
): Map<string, "snap" | "animated"> {
  const verdicts = new Map<string, "snap" | "animated">();
  const changes = (action.visibleChanges ?? []).filter(
    (change) => !change.textOnly && change.extent >= minExtentPx,
  );
  const animated = (change: VisibleChange) =>
    action.viewTransition.used || isAnimated(change, action);
  // When the action's main change animates, a far smaller change riding
  // along with it (a title swapping beside a fading page) is part of it.
  const leading = Math.max(
    0,
    ...changes.filter(animated).map((change) => change.extent),
  );
  for (const change of changes) {
    if (animated(change)) verdicts.set(change.key, "animated");
    else if (change.extent * PERIPHERAL_RATIO <= leading) continue;
    else if (!verdicts.has(change.key)) verdicts.set(change.key, "snap");
  }
  return verdicts;
}

/** Distinct grouping keys (`kind|container`) that snap in an action. */
export function snapCandidateKeys(
  action: Pick<
    ActionTimeline,
    "animations" | "viewTransition" | "visibleChanges"
  >,
  minExtentPx: number,
): string[] {
  return [...keyVerdicts(action, minExtentPx)].flatMap(([key, verdict]) =>
    verdict === "snap" ? [key] : [],
  );
}

/** Distinct grouping keys an action shows animated. */
export function animatedKeys(
  action: Pick<
    ActionTimeline,
    "animations" | "viewTransition" | "visibleChanges"
  >,
  minExtentPx: number,
): string[] {
  return [...keyVerdicts(action, minExtentPx)].flatMap(([key, verdict]) =>
    verdict === "animated" ? [key] : [],
  );
}
