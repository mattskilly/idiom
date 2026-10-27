import type { ReviewRunResult } from "../review/run.js";

/** Count actual attempts separately from reused ledger entries and never infer missing evidence as a pass. */
export function sweepProbeCoverage(review: ReviewRunResult) {
  const controls = {
    completed: 0,
    skipped: 0,
    notReached: 0,
    timedOut: 0,
    reused: 0,
  };
  const reasons: Record<string, number> = Object.create(null);
  for (const { probe } of review.probes ?? [])
    for (const result of probe?.results ?? []) {
      if (result.reusedFrom !== undefined) {
        controls.reused++;
        continue;
      }
      if (result.skipped !== undefined) {
        controls.skipped++;
        reasons[result.skipped] = (reasons[result.skipped] ?? 0) + 1;
      } else if (result.status === "not-reached") controls.notReached++;
      else if (result.status === "timed-out") controls.timedOut++;
      else controls.completed++;
    }
  return {
    policy: review.scope?.probe.policy ?? "unavailable",
    intended: review.scope?.probe.intended ?? [],
    executed: review.scope?.probe.executed ?? [],
    observations: (review.probes ?? []).map((p) => ({
      coordinate: p.coordinate,
      status:
        p.probe?.status ??
        (review.scope?.probe.policy === "unsupported"
          ? "unsupported"
          : "unavailable"),
      reason: p.probe?.reason,
    })),
    controls,
    reasons,
  };
}
