import { loadingPersists } from "../capture/loading-stuck.js";
import { defaultChecksSettings } from "../schemas/project.js";
import {
  notApplicable,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const loadingStuckCheck: DeterministicCheck = {
  id: "loading-stuck",
  run({ tuple, config }) {
    if (!(config.loadingStuck ?? defaultChecksSettings.loadingStuck).enabled)
      return skipped(this.id, "loadingStuck");
    const evidence = v2Observations(tuple)?.loadingStuck;
    if (evidence?.intentional)
      return notApplicable(this.id, "state explicitly declares loading:true");
    if (
      !evidence ||
      evidence.status === "unavailable" ||
      evidence.status === "skipped" ||
      evidence.observedMs < evidence.windowMs
    )
      return unavailable(
        this.id,
        evidence?.reason ??
          "continuous loading evidence is unavailable or incomplete (recapture)",
      );
    const candidates: FindingCandidate[] = evidence.records
      .filter((r) => loadingPersists(r, evidence.windowMs))
      .map((record) => ({
        category: this.id,
        severity: "minor",
        rule: "idiom:loading-stuck",
        selectorHint: record.selector,
        targetSelectors: [record.selector],
        // Removal is acceptance only when the observer recorded this specific
        // target's interval ending; an absent/unknown target still cannot pass.
        allowRemoval: true,
        explanation: `${record.kind} ${record.selector} remains active after ${(record.ageMs / 1000).toFixed(2)} seconds of uninterrupted visible loading (window ${(evidence.windowMs / 1000).toFixed(2)} seconds after readiness).`,
        acceptance: [
          `Loading in ${record.selector} resolves within the declared ${(evidence.windowMs / 1000).toFixed(2)} second window after readiness.`,
        ],
        verification: verify(this.id, {
          selector: record.selector,
          kind: record.kind,
          observedMs: record.ageMs,
          windowMs: evidence.windowMs,
          intentional: evidence.intentional,
        }),
      }));
    return {
      coverage: {
        check: this.id,
        status: "ran",
        reason: `${evidence.records.length} loading intervals observed with a ${evidence.windowMs} ms window${evidence.status === "partial" ? `; partial: ${evidence.reason}` : ""}`,
      },
      candidates,
    };
  },
};
