import { ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const touchReachabilityCheck: DeterministicCheck = {
  id: "touch-reachability",
  run({ tuple, config }) {
    const declaration = config.touchReachability;
    if (!declaration)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "touch reachability not enabled",
        },
        candidates: [],
      };
    const observation = tuple.observations;
    if (observation?.version !== 2 || !observation.input)
      return unavailable(this.id, "input evidence unavailable (recapture)");
    const input = observation.input;
    if (
      input.hover !== "none" ||
      (input.pointer !== "coarse" && input.maxTouchPoints === 0)
    )
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "captured input is not a no-hover touch profile",
        },
        candidates: [],
      };
    const evidence = observation.touchReachability;
    if (!evidence)
      return unavailable(
        this.id,
        "touch reachability evidence unavailable (recapture)",
      );
    if (JSON.stringify(evidence.declaration) !== JSON.stringify(declaration))
      return unavailable(
        this.id,
        "touch capture declarations changed (recapture)",
      );
    if (evidence.status === "unavailable" || !evidence.restored)
      return unavailable(
        this.id,
        evidence.diagnostics.join("; ") ||
          "touch diagnostic unavailable (recapture)",
      );
    const reasons = [...evidence.diagnostics];
    const candidates: FindingCandidate[] = [];
    for (const entry of evidence.entries) {
      if (
        entry.hover.status === "unavailable" ||
        entry.focus.status === "unavailable"
      ) {
        reasons.push(
          `${entry.selector}: ${entry.hover.reason ?? entry.focus.reason ?? "measurement unavailable"}`,
        );
        continue;
      }
      if (
        entry.hover.status !== "revealed" ||
        entry.focus.status === "revealed"
      )
        continue;
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:touch-hover-only",
        selectorHint: entry.owner,
        fingerprintHint: `touch:${entry.identity}`,
        explanation: `${entry.name || entry.selector} (${entry.selector}) is hidden by ${entry.cause} under pointer:${input.pointer}, hover:${input.hover}, touch points:${input.maxTouchPoints}. Hovering painted owner ${entry.owner} reveals it; no painted, enabled focus target revealed it through CSS.`,
        acceptance: [
          "Expose this action in the no-hover touch profile, or provide a painted tap-focusable CSS reveal target.",
        ],
        verification: verify(this.id, {
          control: entry.selector,
          owner: entry.owner,
          cause: entry.cause,
          hover: entry.hover,
          focus: entry.focus,
          input,
        }),
      });
    }
    return reasons.length
      ? {
          coverage: {
            check: this.id,
            status: "unavailable",
            reason: [...new Set(reasons)].join("; "),
          },
          candidates,
        }
      : ran(this.id, candidates);
  },
};
