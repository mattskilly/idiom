import { isVisuallyHidden, ran, unavailable, verify } from "./shared.js";
import type {
  ChecksConfig,
  CheckTuple,
  DeterministicCheck,
  ObservationArtifact,
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
    return ran(
      this.id,
      observation.elements
        .filter(
          (element) =>
            element.visible &&
            !isVisuallyHidden(element) &&
            element.interactive &&
            element.enabled &&
            element.inlineTextTarget !== true &&
            element.rect.x + element.rect.width > 0 &&
            element.rect.x < observation.viewport.width &&
            (element.rect.width < minimum || element.rect.height < minimum),
        )
        .map((element) => ({
          category: this.id,
          severity: "minor" as const,
          rule: "idiom:minimum-target-size",
          selectorHint: element.selector,
          explanation: `${element.selector} is ${Math.round(element.rect.width)}×${Math.round(element.rect.height)} at ${tuple.viewport} (${label}); interactive targets here must be at least ${minimum}×${minimum} CSS pixels.`,
          acceptance: [
            `${element.selector} has a rendered hit area of at least ${minimum}×${minimum} CSS pixels at ${tuple.viewport}.`,
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
