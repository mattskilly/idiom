import { numericAllowance } from "../design/measure.js";
import { notApplicable, ran, round, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

/** Authored gaps are compared against frozen, ordered border boxes. */
export const spacingTargetCheck: DeterministicCheck = {
  id: "spacing-target",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation?.version !== 2 || observation.spacingTargets === undefined)
      return unavailable(
        this.id,
        "recapture to record spacing target evidence",
      );
    if (observation.spacingTargets.length === 0)
      return notApplicable(this.id, "no spacing targets declared at capture");
    const candidates: FindingCandidate[] = [];
    const reasons: string[] = [];
    for (const {
      target,
      pairs,
      reasons: unmeasurable,
    } of observation.spacingTargets) {
      reasons.push(...unmeasurable);
      const allowance = numericAllowance(target.gap, target.tolerance);
      for (const { first, second, container } of pairs) {
        const gap =
          target.axis === "vertical"
            ? second.y - (first.y + first.height)
            : second.x - (first.x + first.width);
        if (Math.abs(gap - target.gap) <= allowance) continue;
        candidates.push({
          category: this.id,
          rule: "idiom:spacing-target",
          severity: "major",
          selectorHint: second.selector,
          targetSelectors: [first.selector, second.selector],
          fingerprintHint: JSON.stringify([
            "between" in target ? target.between : target.within,
            target.axis,
            container ?? null,
            first.selector,
            second.selector,
          ]),
          explanation: `${first.selector} → ${second.selector} has a ${target.axis} border-box gap of ${round(gap)}px; the target is ${target.gap}px (±${round(allowance)}px).`,
          acceptance: [
            `The ${target.axis} gap between ${first.selector} and ${second.selector} is ${target.gap}px ±${round(allowance)}px.`,
          ],
          verification: verify(this.id, {
            first: first.selector,
            second: second.selector,
            axis: target.axis,
            measured: gap,
            target: target.gap,
            tolerance: allowance,
          }),
        });
      }
    }
    const result = ran(this.id, candidates);
    if (reasons.length > 0)
      result.coverage = {
        check: this.id,
        status: "unavailable",
        reason: reasons.join("; "),
      };
    return result;
  },
};
