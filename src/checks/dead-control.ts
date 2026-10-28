import { observed } from "../findings/observation.js";
import { unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

/** An enabled control that, when clicked, changes nothing observable. */
export const deadControlCheck: DeterministicCheck = {
  id: "dead-control",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.probe === undefined)
      return unavailable(
        this.id,
        "the interaction probe did not run (enable checks.probe or state.probe)",
      );
    const toggles = new Set(
      observation.elements
        .filter((element) => element.attributes["aria-pressed"] !== undefined)
        .map((element) => element.selector),
    );
    const candidates: FindingCandidate[] = [];
    for (const result of observation.probe.results) {
      if (result.skipped !== undefined || result.effects.length > 0) continue;
      const label = result.name === "" ? result.selector : `"${result.name}"`;
      const toggle = toggles.has(result.selector);
      candidates.push({
        observation: observed(
          {
            source: "probe-click",
            kind: "click",
            selector: result.selector,
            name: result.name,
          },
          result,
          result.elapsedMs === undefined
            ? undefined
            : {
                elapsedMs: result.elapsedMs,
                ...(result.timings
                  ? { windowMs: result.timings.effectWindowMs }
                  : {}),
              },
        ),
        allowRemoval: true,
        category: this.id,
        severity: "major",
        rule: toggle
          ? "idiom:toggle-without-state"
          : "idiom:control-does-nothing",
        selectorHint: result.selector,
        explanation: toggle
          ? `Toggle ${label} was clicked and its pressed state did not change, and nothing else did either.`
          : `${label} (${result.selector}) is enabled, but clicking it changed nothing observable: no DOM change, focus move, navigation, dialog, network request or clipboard write within the probe window.`,
        acceptance: [
          `Clicking ${label} produces a visible result, or the control is disabled with a stated reason, or it is removed.`,
        ],
        verification: verify(this.id, { selector: result.selector }),
      });
    }
    return {
      coverage:
        observation.probe.status !== "ran"
          ? {
              check: this.id,
              status: "ran",
              reason: observation.probe.reason,
            }
          : { check: this.id, status: "ran" },
      candidates,
    };
  },
};
