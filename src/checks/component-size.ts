import { numericAllowance } from "../design/measure.js";
import { ran, round, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

/** Rendered size of a named component against its declared design size. */
export const componentSizeCheck: DeterministicCheck = {
  id: "component-size",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.components === undefined)
      return ran(this.id, []);
    const candidates: FindingCandidate[] = [];
    for (const component of observation.components) {
      if (component.unresolved === true || component.rects.length === 0)
        continue;
      const axis =
        component.inferred?.axis ??
        (component.width === undefined
          ? "height"
          : component.height === undefined
            ? "width"
            : undefined);
      // Mode-less historical captures keep their original larger allowance.
      const allowWidth = numericAllowance(
        component.width ?? 0,
        component.tolerance,
      );
      const allowHeight = numericAllowance(
        component.height ?? 0,
        component.tolerance,
      );
      const off = component.rects.filter(
        (rect) =>
          (component.width !== undefined &&
            axis !== "height" &&
            Math.abs(rect.width - component.width) > allowWidth) ||
          (component.height !== undefined &&
            axis !== "width" &&
            Math.abs(rect.height - component.height) > allowHeight),
      );
      const first = off[0];
      if (first === undefined) continue;
      const displayAxis =
        component.width === undefined
          ? "height"
          : component.height === undefined
            ? "width"
            : undefined;
      const sizes = [
        ...new Set(
          off.map((rect) =>
            displayAxis === "height"
              ? `${round(rect.height)}px high`
              : displayAxis === "width"
                ? `${round(rect.width)}px wide`
                : `${round(rect.width)}×${round(rect.height)}`,
          ),
        ),
      ];
      const specified =
        axis === "height"
          ? `${component.height}px high (±${round(allowHeight)}px)`
          : axis === "width"
            ? `${component.width}px wide (±${round(allowWidth)}px)`
            : `${component.width}×${component.height}px (±${round(allowWidth)}×${round(allowHeight)}px)`;
      const target =
        axis === "height"
          ? `${component.height}px high`
          : axis === "width"
            ? `${component.width}px wide`
            : `${component.width}×${component.height}px`;
      const source =
        component.inferred === undefined
          ? ""
          : ` (inferred from ${component.inferred.source})`;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:component-size-mismatch",
        selectorHint: first.selector,
        explanation: `${off.length} of ${component.rects.length} "${component.name}" elements render at ${sizes.join(", ")}${displayAxis === undefined ? "px" : ""}; the design specifies ${specified}${source}.`,
        acceptance: [
          `Every "${component.name}" (${component.selector}) renders within tolerance of ${target}.`,
        ],
        verification: verify(this.id, {
          component: component.name,
          selector: component.selector,
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
