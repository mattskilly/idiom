import { observed } from "../findings/observation.js";
import { unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const progressAffordanceCheck: DeterministicCheck = {
  id: "progress-affordance",
  run({ tuple, config }) {
    const observation = tuple.observations;
    if (observation?.version !== 2)
      return unavailable(this.id, "v2 observations unavailable (recapture)");
    if (!observation.progress)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason:
            "no longRunning web steps captured (mark steps[].longRunning; recapture)",
        },
        candidates: [],
      };
    const within = config.progressWithinMs;
    const notes: string[] = [];
    const candidates: FindingCandidate[] = [];
    let judged = 0;
    for (const step of observation.progress.steps) {
      if (step.status === "unavailable") {
        notes.push(
          `step ${step.stepIndex}: ${step.reason ?? "progress evidence unavailable"}`,
        );
        continue;
      }
      if (step.firstMs !== null && step.firstMs <= within) {
        judged++;
        notes.push(
          `step ${step.stepIndex}: ${step.affordance?.kind ?? "progress"} after ${step.firstMs}ms`,
        );
        continue;
      }
      if (step.firstMs === null && step.observedMs < within) {
        notes.push(
          `step ${step.stepIndex}: observed only ${step.observedMs}ms; recapture to judge a ${within}ms window`,
        );
        continue;
      }
      judged++;
      const late =
        step.firstMs === null
          ? ""
          : `; the first appeared after ${step.firstMs}ms`;
      const settled =
        step.settledMs === undefined
          ? ""
          : `; the step settled after ${step.settledMs}ms`;
      candidates.push({
        observation: observed(
          {
            source: "progress",
            kind: step.action,
            selector: step.selector,
            name: "longRunning",
            stepIndex: step.stepIndex,
          },
          step,
          { windowMs: step.observedMs },
        ),
        category: this.id,
        severity: "major",
        rule: "idiom:progress-affordance",
        selectorHint: step.selector,
        fingerprintHint: `progress:${step.stepIndex}:${step.selector}`,
        explanation: `Step ${step.stepIndex} (${step.action} ${step.selector}) is marked longRunning, but no progress affordance (spinner, progressbar, aria-busy or status text change) appeared within ${within}ms${late}${settled}.`,
        acceptance: [
          `Within ${within}ms of ${step.action} on ${step.selector}, a spinner, progressbar, aria-busy region or status text change shows the work is under way.`,
        ],
        verification: verify(this.id, {
          stepIndex: step.stepIndex,
          selector: step.selector,
          firstMs: step.firstMs,
          withinMs: within,
        }),
      });
    }
    return {
      coverage: {
        check: this.id,
        status: judged > 0 ? "ran" : "unavailable",
        reason: notes.join("; ") || "no progress steps available (recapture)",
      },
      candidates,
    };
  },
};
