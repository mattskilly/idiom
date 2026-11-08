import { ran, round, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate, Rect } from "./types.js";

const valid = (rect: Rect) =>
  [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
  rect.width > 0 &&
  rect.height > 0;

/** The nearest visible panel edge should remain within 24px of its opener. */
export const detachedFlyoutCheck: DeterministicCheck = {
  id: "detached-flyout",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation?.version !== 2 || !observation.probe)
      return unavailable(
        this.id,
        "disclosure probe geometry is unavailable (recapture)",
      );
    const candidates: FindingCandidate[] = [];
    const seen = new Set<string>();
    let measured = false;
    for (const result of observation.probe.results) {
      const opened = result.openedDisclosure;
      if (
        !opened ||
        result.skipped !== undefined ||
        (result.status !== undefined && result.status !== "completed") ||
        !valid(opened.trigger) ||
        !valid(opened.panel)
      )
        continue;
      measured = true;
      const { trigger, panel, root } = opened;
      const dx = Math.max(
        trigger.x - panel.x - panel.width,
        panel.x - trigger.x - trigger.width,
        0,
      );
      const dy = Math.max(
        trigger.y - panel.y - panel.height,
        panel.y - trigger.y - trigger.height,
        0,
      );
      const distance = Math.hypot(dx, dy);
      const key = `${result.selector} | ${root}`;
      if (distance <= 24 || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:detached-flyout",
        selectorHint: result.selector,
        fingerprintHint: key,
        explanation: `"${result.name}" opens ${root} ${round(distance)}px from its trigger (nearest edges; maximum 24px).`,
        acceptance: [
          `The panel opened by "${result.name}" is within 24px of its trigger.`,
        ],
        verification: verify(this.id, {
          trigger: result.selector,
          root,
          distance,
          maximum: 24,
          name: result.name,
        }),
      });
    }
    return measured
      ? ran(this.id, candidates)
      : unavailable(
          this.id,
          "no successful opened-panel geometry is available (recapture)",
        );
  },
};
