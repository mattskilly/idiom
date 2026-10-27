import { isVisuallyHidden, ran, unavailable, verify } from "./shared.js";
import type {
  ChecksConfig,
  CheckTuple,
  DeterministicCheck,
  ObservationArtifact,
  ObservedElement,
  Rect,
} from "./types.js";

export const defaultTargetSize = { fine: 24, coarse: 44, narrowBelow: 768 };

export function inputClass(
  tuple: Pick<CheckTuple, "width">,
  observation: ObservationArtifact,
  settings: NonNullable<ChecksConfig["targetSize"]>,
): { kind: "fine" | "narrow" | "touch"; minimum: number } {
  if (tuple.width < settings.narrowBelow)
    return { kind: "narrow", minimum: settings.coarse };
  const input = observation.version === 2 ? observation.input : undefined;
  if (
    input !== undefined &&
    (input.maxTouchPoints > 0 ||
      input.pointer === "coarse" ||
      input.hover === "none")
  )
    return { kind: "touch", minimum: settings.coarse };
  return { kind: "fine", minimum: settings.fine };
}

type Target = {
  element: ObservedElement;
  regions: Rect[];
  x: number;
  y: number;
  sized: boolean;
};

function target(element: ObservedElement, minimum: number): Target {
  const regions = [
    element.rect,
    ...(element.targetSizeLabels ?? []).flatMap((label) => label.rects),
  ];
  const left = Math.min(...regions.map((rect) => rect.x));
  const right = Math.max(...regions.map((rect) => rect.x + rect.width));
  const top = Math.min(...regions.map((rect) => rect.y));
  const bottom = Math.max(...regions.map((rect) => rect.y + rect.height));
  return {
    element,
    regions,
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    sized: regions.some(
      (rect) => rect.width >= minimum && rect.height >= minimum,
    ),
  };
}

// Strict overlap: tangency (including 20px buttons with 4px gaps) passes.
function sufficientlySpaced(candidate: Target, targets: Target[]): boolean {
  return targets.every((other) => {
    if (other === candidate) return true;
    if (
      !other.sized &&
      Math.hypot(candidate.x - other.x, candidate.y - other.y) < 24 - 1e-9
    )
      return false;
    return other.regions.every((rect) => {
      const dx = Math.max(
        rect.x - candidate.x,
        0,
        candidate.x - rect.x - rect.width,
      );
      const dy = Math.max(
        rect.y - candidate.y,
        0,
        candidate.y - rect.y - rect.height,
      );
      return Math.hypot(dx, dy) >= 12 - 1e-9;
    });
  });
}

export const targetSizeCheck: DeterministicCheck = {
  id: "target-size",
  run({ tuple, config }) {
    const settings = config.targetSize ?? defaultTargetSize;
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    const applied = inputClass(tuple, observation, settings);
    const minimum = applied.minimum;
    const label =
      applied.kind === "narrow"
        ? `narrower than ${settings.narrowBelow}px, minimum ${minimum}`
        : applied.kind === "touch"
          ? `touch, minimum ${minimum}`
          : `fine pointer, minimum ${minimum}`;
    const spacing = applied.kind === "fine" && minimum === 24;
    const eligible = observation.elements.filter(
      (element) =>
        element.visible &&
        !isVisuallyHidden(element) &&
        element.painted?.value !== false &&
        element.interactive &&
        element.enabled &&
        element.rect.x + element.rect.width > 0 &&
        element.rect.x < observation.viewport.width,
    );
    const ownedLabels = new Set(
      eligible.flatMap((element) =>
        (element.targetSizeLabels ?? []).map((label) => label.selector),
      ),
    );
    const targets = eligible
      .filter((element) => !ownedLabels.has(element.selector))
      .map((element) => target(element, minimum));
    return ran(
      this.id,
      targets
        .filter(
          (candidate) =>
            !candidate.element.inlineTextTarget &&
            !candidate.sized &&
            !(spacing && sufficientlySpaced(candidate, targets)),
        )
        .map(({ element }) => ({
          category: this.id,
          severity: "minor" as const,
          rule: "idiom:minimum-target-size",
          selectorHint: element.selector,
          explanation: `${element.selector} is ${Math.round(element.rect.width)}×${Math.round(element.rect.height)} at ${tuple.viewport} (${label}); ${element.targetSizeLabels?.some((label) => label.rects.length > 0) ? "neither its input nor any recorded clickable label fragment contains" : "its hit area does not contain"} a ${minimum}×${minimum} CSS pixel square${spacing ? " and its 24px circle overlaps another target or undersized target circle" : ""}.`,
          acceptance: [
            `${element.selector} has a clickable region containing a ${minimum}×${minimum} CSS pixel square${spacing ? " or sufficient spacing for its 24px circle to avoid other targets and undersized target circles" : ""} at ${tuple.viewport}.`,
          ],
          verification: verify(this.id, {
            selector: element.selector,
            minimum,
            inputClass: applied.kind,
          }),
        })),
    );
  },
};
