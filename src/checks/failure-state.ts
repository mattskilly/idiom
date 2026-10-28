import { observed } from "../findings/observation.js";
import {
  timelineEvidence,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import {
  actionIdentity,
  linkRecording,
  recordingKey,
} from "./temporal-evidence.js";
import type {
  ActionTimeline,
  DeterministicCheck,
  FailureReplay,
  FindingCandidate,
} from "./types.js";

type FailureAction = ActionTimeline & { failure: FailureReplay };
export type FailureVerdict = {
  judged: boolean;
  missing: boolean;
  blocked: boolean;
  note: string;
};
/** Absence requires a complete, positively attributed, locally injected window. */
export function judgeFailure(action: FailureAction): FailureVerdict {
  const f = action.failure;
  const no = (note: string, judged = false): FailureVerdict => ({
    judged,
    missing: false,
    blocked: false,
    note,
  });
  if (f.navigated) return no("full-page navigation excluded", true);
  if (
    !f.complete ||
    f.truncated ||
    action.status === "unavailable" ||
    !f.dispatched ||
    !f.requests.length ||
    f.observationEnd === null ||
    !f.requests.every(
      (r) =>
        r.delivered &&
        r.injectedAt !== null &&
        (f.observationEnd ?? 0) - r.injectedAt >= f.feedbackWithinMs,
    )
  )
    return no("incomplete recovery evidence; recapture with more probe budget");
  if (
    f.eligibility.changeAt < f.eligibility.responseAt ||
    f.eligibility.changeAt - f.eligibility.responseAt > 400
  )
    return no("visible result was not response gated");
  const boundary = Math.min(...f.requests.map((r) => r.injectedAt ?? Infinity));
  const deadline =
    Math.max(...f.requests.map((r) => r.injectedAt ?? 0)) + f.feedbackWithinMs;
  const feedback = f.feedback.filter(
    (hit) => hit.time >= boundary && hit.time <= deadline,
  );
  if (feedback.length)
    return no("the page handled the failure with feedback", true);
  if (f.retry === null || f.pending === null)
    return no("recovery controls were not observed");
  if (f.retry.length)
    return no("a usable action-related retry control is visible", true);
  const trigger = f.trigger;
  const blocked =
    (trigger.initiallyEnabled === true &&
      (trigger.disabled === true ||
        trigger.busy === true ||
        trigger.hidden === true ||
        trigger.inert === true)) ||
    f.pending.length > 0 ||
    (f.main.initiallyEmpty === false && f.main.empty === true);
  return {
    judged: true,
    missing:
      f.changes.filter((c) => c.time >= boundary && c.time <= deadline)
        .length === 0,
    blocked,
    note: blocked
      ? "the action remains stuck without recovery"
      : "the action returned without failure feedback",
  };
}
function checkFor(
  id: "error-state-missing" | "retry-blocked",
): DeterministicCheck {
  return {
    id,
    run({ tuple }) {
      const evidence = timelineEvidence(tuple);
      if (evidence.status === "unavailable")
        return unavailable(id, evidence.reason);
      const all = evidence.timelines.actions.filter(
        (a): a is FailureAction =>
          a.source === "failure-replay" && a.failure !== undefined,
      );
      const probe = v2Observations(tuple)?.probe;
      const summary = probe?.failureReplay;
      if (!all.length) {
        if (!probe)
          return {
            coverage: {
              check: id,
              status: "skipped",
              reason: "interaction probe did not run",
            },
            candidates: [],
          };
        if (!summary)
          return unavailable(
            id,
            probe.status === "timed-out"
              ? "the probe budget ran out before the failure replay"
              : "unavailable: recapture (no failure replay evidence in this capture)",
          );
        if (
          summary.queued === 0 &&
          !summary.notes.some((note) =>
            /not reached|budget|interrupted|timed.out/i.test(note),
          )
        )
          return {
            coverage: {
              check: id,
              status: "skipped",
              reason:
                "no action had eligible response-gated fetch/XHR requests",
            },
            candidates: [],
          };
        return unavailable(
          id,
          summary.notes.join("; ") ||
            "failure replays were not reached within the probe budget",
        );
      }
      const seen = new Set<string>();
      const candidates: FindingCandidate[] = [];
      const notes = [...(summary?.notes ?? [])];
      let judged = 0;
      for (const action of [...all].sort(
        (a, b) =>
          Number(a.failure.of === "probe-click") -
          Number(b.failure.of === "probe-click"),
      )) {
        const f = action.failure;
        const trigger = action.selector ?? action.name;
        const requests = [
          ...new Set(f.requests.map((r) => `${r.method} ${r.path}`)),
        ].sort();
        const signature = `${trigger}:${requests.join("|")}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        const verdict = judgeFailure(action);
        notes.push(`${trigger}: ${verdict.note}`);
        if (verdict.judged) judged++;
        if (!(id === "error-state-missing" ? verdict.missing : verdict.blocked))
          continue;
        const stuck = [
          ...(f.trigger.disabled ? ["disabled"] : []),
          ...(f.trigger.busy ? ["busy"] : []),
          ...(f.trigger.hidden ? ["hidden or disconnected"] : []),
          ...(f.trigger.inert ? ["inert"] : []),
        ].join(", ");
        const state = [
          stuck
            ? `${trigger} remained ${stuck}`
            : `${trigger} returned to rest`,
          ...(f.pending?.length
            ? [
                `pending indicators remained at ${f.pending.map((p) => p.selector).join(", ")}`,
              ]
            : []),
          ...(f.main.empty && !f.main.initiallyEmpty
            ? [`${f.main.selector} was left empty`]
            : []),
        ].join("; ");
        const delivery =
          f.mode === "status" ? `HTTP ${f.status}` : "a network error";
        candidates.push(
          linkRecording(
            {
              observation: observed(
                actionIdentity(action),
                {
                  durationMs: action.durationMs,
                  ...(action.held ? { held: action.held } : {}),
                  ...(action.failure ? { failure: action.failure } : {}),
                },
                { elapsedMs: action.durationMs },
              ),
              category: id,
              rule: `idiom:${id}`,
              severity: "major",
              selectorHint: trigger,
              fingerprintHint: `failure:${id}:${signature}`,
              ...(action.id ? { timeline: action.id } : {}),
              explanation: `Activating ${trigger} failed ${requests.join(", ")} locally with ${delivery}. After ${f.feedbackWithinMs}ms, ${state}; no failure message or usable retry appeared.`,
              acceptance: [
                `Within ${f.feedbackWithinMs}ms of ${delivery} for ${requests.join(", ")}, show failure feedback at ${trigger} or in a live region, restore the action, and offer retry.`,
              ],
              fix: `Show an error message near ${trigger} in ${f.main.selector}, or announce it in an alert/live region. ${stuck || f.pending?.length ? `Restore ${trigger} to an enabled, visible resting state and clear pending indicators. ` : ""}Offer a usable retry control for ${requests.join(", ")}.`,
              verification: verify(id, {
                selector: trigger,
                requests,
                mode: f.mode,
                status: f.status,
                feedbackWithinMs: f.feedbackWithinMs,
                source: "failure-replay",
              }),
            },
            recordingKey(action),
          ),
        );
      }
      return {
        coverage: {
          check: id,
          status: judged ? "ran" : "unavailable",
          ...(notes.length ? { reason: [...new Set(notes)].join("; ") } : {}),
        },
        candidates,
      };
    },
  };
}
export const errorStateMissingCheck = checkFor("error-state-missing");
export const retryBlockedCheck = checkFor("retry-blocked");
