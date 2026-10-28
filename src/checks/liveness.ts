import { observed } from "../findings/observation.js";
import { ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const livenessCheck: DeterministicCheck = {
  id: "liveness",
  run({ tuple, config }) {
    const declaration = config.liveness;
    if (!declaration || (!declaration.auto && !declaration.selectors.length))
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "liveness not enabled for any targets",
        },
        candidates: [],
      };
    const evidence =
      tuple.observations?.version === 2
        ? tuple.observations.liveness
        : undefined;
    if (!evidence)
      return unavailable(
        this.id,
        "liveness evidence unavailable (recapture with checks.liveness)",
      );
    if (JSON.stringify(evidence.declaration) !== JSON.stringify(declaration))
      return unavailable(
        this.id,
        "liveness capture declarations changed (recapture)",
      );
    if (evidence.status === "unavailable")
      return unavailable(
        this.id,
        evidence.diagnostics.join("; ") || "sampling unavailable (recapture)",
      );
    const candidates: FindingCandidate[] = [];
    const reasons = [...evidence.diagnostics];
    for (const entry of evidence.entries) {
      if (entry.status !== "measured") {
        reasons.push(`${entry.selector}: ${entry.reason}`);
        continue;
      }
      if (entry.before !== entry.after) continue;
      const numbers = entry.before.match(/\d+(?:\.\d+)?/g) ?? [];
      const zero = numbers.length > 0 && numbers.every((n) => Number(n) === 0);
      const rule = `idiom:liveness-${zero ? "all-zero" : "unchanged"}`;
      candidates.push({
        observation: observed(
          {
            source: "liveness",
            kind: "sample",
            selector: entry.selector,
            name: entry.identity,
          },
          entry,
          { elapsedMs: entry.elapsedMs },
        ),
        category: this.id,
        severity: "major",
        rule,
        selectorHint: entry.selector,
        fingerprintHint: `${entry.identity}:${rule}`,
        explanation: `${entry.selector} ${zero ? "remains all zero" : "did not change"}: ${JSON.stringify(entry.before)} → ${JSON.stringify(entry.after)} over ${Math.round(entry.elapsedMs)}ms.`,
        acceptance: [
          "The opted-in dynamic target updates within the sampling interval, or is explicitly ignored when intentionally static or finished.",
        ],
        verification: verify(this.id, { ...entry }),
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
