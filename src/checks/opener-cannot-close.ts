import { ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const RULE = "idiom:opener-cannot-close";

/**
 * A control opened a panel, a second click on it left the panel open, and
 * no close control sits within 24px of where it was: people cannot close
 * the panel the way they opened it. Measured by the probe's re-click.
 */
export const openerCannotCloseCheck: DeterministicCheck = {
  id: "opener-cannot-close",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.probe === undefined)
      return unavailable(
        this.id,
        "the interaction probe did not run (enable checks.probe or state.probe)",
      );
    if (observation.probe.reclick === undefined)
      return unavailable(
        this.id,
        "the probe did not re-click openers (recapture, or checks.probe.disclosures is off)",
      );
    const candidates: FindingCandidate[] = [];
    for (const result of observation.probe.results) {
      const reclick = result.reclick;
      if (
        reclick === undefined ||
        result.reusedFrom !== undefined ||
        result.skipped !== undefined ||
        reclick.outcome !== "stayed-open" ||
        reclick.closeNearby !== undefined
      )
        continue;
      const name = result.name || reclick.trigger;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: result.selector,
        fingerprintHint: `${RULE}|${result.selector}|${reclick.root}`,
        explanation: `Clicking "${name}" opens ${reclick.root}, but clicking it again leaves it open, and no close control sits where it was, so people cannot close it the way they opened it.`,
        acceptance: [
          `Clicking ${reclick.trigger} a second time closes ${reclick.root}, or a close control sits within 24px of where ${reclick.trigger} was.`,
        ],
        verification: verify(this.id, {
          trigger: reclick.trigger,
          root: reclick.root,
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
