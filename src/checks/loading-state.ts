import {
  timelineEvidence,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type {
  ActionTimeline,
  CheckResult,
  CheckTuple,
  DeterministicCheck,
  DeterministicCheckId,
  FindingCandidate,
  HeldReplay,
} from "./types.js";

type SlowAction = ActionTimeline & { held: HeldReplay };
type HeldRequest = HeldReplay["requests"][number];

/** A visible result must begin this soon after a response to be gated on it. */
export const RELEASE_ADJACENCY_MS = 400;
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
/** Route changes count only these indicators, anywhere on the page. */
const routeIndicators = new Set<HeldReplay["indicators"][number]["kind"]>([
  "progressbar",
  "busy",
  "spinner",
  "skeleton",
  "progress-text",
  "trigger-disabled",
  "trigger-busy",
]);

const describe = (request: Pick<HeldRequest, "method" | "path">) =>
  `${request.method} ${request.path}`;
const listed = (requests: HeldRequest[]) =>
  [...new Set(requests.map(describe))].join(", ");
const verb = (action: SlowAction) =>
  action.kind === "fill"
    ? "Filling"
    : action.kind === "select"
      ? "Choosing in"
      : action.kind === "press"
        ? "Pressing a key in"
        : "Clicking";
const round = (value: number) => Math.round(value);

/**
 * The slow-replay actions of a tuple, web steps first, deduplicated by
 * trigger and the set of held requests; or the coverage when there are none.
 */
function slowActions(
  check: DeterministicCheckId,
  tuple: CheckTuple,
): { actions: SlowAction[]; reason?: string | undefined } | CheckResult {
  const evidence = timelineEvidence(tuple);
  if (evidence.status === "unavailable")
    return unavailable(check, evidence.reason);
  const all = evidence.timelines.actions.filter(
    (action): action is SlowAction =>
      action.source === "slow-replay" && action.held !== undefined,
  );
  if (all.length === 0) {
    const probe = v2Observations(tuple)?.probe;
    if (!probe)
      return {
        coverage: {
          check,
          status: "skipped",
          reason: "interaction probe did not run",
        },
        candidates: [],
      };
    if (!probe.heldReplay)
      return unavailable(
        check,
        probe.status === "timed-out"
          ? "the probe budget ran out before the held replay"
          : "unavailable: recapture (no held replay in this capture)",
      );
    if (probe.heldReplay.queued === 0)
      return {
        coverage: {
          check,
          status: "skipped",
          reason: "no action sent fetch/XHR/document requests",
        },
        candidates: [],
      };
    return unavailable(
      check,
      probe.heldReplay.notes.join("; ") || "held replays did not run",
    );
  }
  const ordered = [...all].sort(
    (a, b) =>
      Number(a.held.of === "probe-click") - Number(b.held.of === "probe-click"),
  );
  const seen = new Set<string>();
  const actions: SlowAction[] = [];
  for (const action of ordered) {
    const key = `${action.selector ?? ""}|${signature(action.held.requests)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
  }
  const notes = v2Observations(tuple)?.probe?.heldReplay?.notes ?? [];
  return {
    actions,
    reason: [
      ...new Set([...notes, ...(evidence.reason ? [evidence.reason] : [])]),
    ].join("; "),
  };
}

function signature(requests: HeldRequest[]): string {
  return [...new Set(requests.map(describe))].sort().join("|");
}

/** A main-frame document navigation and nothing the page fetched itself. */
const navigationOnly = (action: SlowAction) =>
  action.held.requests.some((request) => request.navigation) &&
  !action.held.requests.some(
    (request) =>
      !request.navigation &&
      (request.resourceType === "fetch" || request.resourceType === "xhr"),
  );

const label = (action: SlowAction) =>
  `${action.held.of === "web-step" ? `step ${action.stepIndex}` : "probe"} ${action.selector ?? action.name}`;

/** Why an action cannot be judged at all, or undefined. */
function unjudgeable(action: SlowAction, withinMs: number): string | undefined {
  if (navigationOnly(action)) return undefined;
  if (action.status === "unavailable")
    return action.reason ?? "held replay unavailable";
  if (!action.held.dispatched) return "action dispatch was not observed";
  if (action.held.delayMs <= withinMs)
    return "unjudgeable: checks.loading.delayMs must exceed progressWithinMs";
  return undefined;
}

function coverageOf(
  check: DeterministicCheckId,
  judged: number,
  notes: Array<string | undefined>,
  candidates: FindingCandidate[],
): CheckResult {
  const reason = [...new Set(notes.filter(Boolean))].join("; ");
  return {
    coverage: {
      check,
      status: judged > 0 ? "ran" : "unavailable",
      ...(reason
        ? { reason }
        : judged > 0
          ? {}
          : { reason: "no held replay could be judged" }),
    },
    candidates,
  };
}

export type LoadingVerdict =
  | { fires: false; note: string; judged: boolean }
  | {
      fires: true;
      requests: HeldRequest[];
      silentMs: number;
      late: number | null;
      route: HeldReplay["routeChange"];
    };

/** The firing semantics of loading-state-missing for one held replay. */
export function judgeLoading(
  action: SlowAction,
  withinMs: number,
  progressRan: (stepIndex: number) => boolean,
): LoadingVerdict {
  const held = action.held;
  const why = unjudgeable(action, withinMs);
  if (why) return { fires: false, note: why, judged: false };
  const requests = held.requests.filter(
    (request) =>
      !request.navigation &&
      (request.resourceType === "fetch" || request.resourceType === "xhr"),
  );
  if (requests.length === 0)
    return {
      fires: false,
      judged: true,
      note: held.requests.some((request) => request.navigation)
        ? "main-frame document navigation (the browser shows its own progress)"
        : "no same-site fetch/XHR request was held",
    };
  if (
    held.of === "web-step" &&
    action.stepIndex !== undefined &&
    progressRan(action.stepIndex)
  )
    return {
      fires: false,
      judged: true,
      note: "declared longRunning; judged by progress-affordance",
    };
  const route = held.routeChange;
  const times = route
    ? [
        ...held.indicators
          .filter(
            (indicator) =>
              routeIndicators.has(indicator.kind) ||
              (indicator.kind === "status-text" && indicator.progressText),
          )
          .map((indicator) => indicator.time),
        ...(held.firstMainChange ? [held.firstMainChange.time] : []),
      ]
    : [
        ...held.indicators.map((indicator) => indicator.time),
        ...(held.firstChange ? [held.firstChange.time] : []),
      ];
  const first = times.length ? Math.min(...times) : null;
  if (first !== null && first <= withinMs)
    return {
      fires: false,
      judged: true,
      note: `feedback after ${round(first)}ms`,
    };
  const after = route
    ? held.mainChangeAfterReleaseAt
    : held.changeAfterReleaseAt;
  if (after === null)
    return {
      fires: false,
      judged: true,
      note: "no visible change after the response (not gated on it)",
    };
  const releases = requests.flatMap((request) =>
    request.releasedAt === null ? [] : [request.releasedAt],
  );
  if (
    !releases.some(
      (release) => after >= release && after - release <= RELEASE_ADJACENCY_MS,
    )
  )
    return {
      fires: false,
      judged: true,
      note: `visible change at ${round(after)}ms is not adjacent to a response`,
    };
  const released = held.releasedAt ?? Math.min(...releases);
  // Feedback that came late, but before the response, ends the silence.
  const late = first !== null && first < released ? first : null;
  return {
    fires: true,
    requests,
    silentMs: round(late ?? released),
    late,
    route,
  };
}

function fixFor(action: SlowAction, trigger: string): string {
  const held = action.held;
  const steps = [
    `Show a pending state on ${trigger} as soon as it is activated (aria-busy with a spinner or a "Saving…"/"Loading…" label).`,
  ];
  if (held.trigger.enabled === true || held.secondActivation.attempted)
    steps.push("Disable it while the request is pending.");
  const inserted = action.mutations.some(
    (mutation) => mutation.type === "insert",
  );
  const region =
    action.effectRegion.commonAncestor ??
    (held.routeChange ? held.mainSelector : held.firstChange?.selector);
  if (inserted && region)
    steps.push(
      `Render a skeleton sized to the final content in ${region} until the response arrives.`,
    );
  return steps.join(" ");
}

export const loadingStateMissingCheck: DeterministicCheck = {
  id: "loading-state-missing",
  run({ tuple, config }) {
    const found = slowActions(this.id, tuple);
    if ("coverage" in found) return found;
    const within = config.progressWithinMs;
    const progress = v2Observations(tuple)?.progress;
    const progressRan = (stepIndex: number) =>
      progress?.steps.some(
        (step) => step.stepIndex === stepIndex && step.status === "ran",
      ) === true;
    const notes: string[] = [];
    const candidates: FindingCandidate[] = [];
    let judged = 0;
    let bodyRoutes = false;
    for (const action of found.actions) {
      const verdict = judgeLoading(action, within, progressRan);
      if (!verdict.fires) {
        if (verdict.judged) judged++;
        notes.push(`${label(action)}: ${verdict.note}`);
        continue;
      }
      judged++;
      const held = action.held;
      const trigger = action.selector ?? action.name;
      if (verdict.route && held.mainSelector === "body") bodyRoutes = true;
      const requests = listed(verdict.requests);
      const late =
        verdict.late === null
          ? ""
          : ` The first feedback appeared only after ${round(verdict.late)}ms.`;
      const explanation = verdict.route
        ? `Navigating to ${verdict.route.to} left the main content ${held.mainEmpty ? "empty" : "unchanged"} for ${verdict.silentMs}ms with no pending indicator while ${requests} was pending; it changed only after the response.${late} Idiom held the response for ${held.delayMs}ms to see what users on a slow network see.`
        : `${verb(action)} ${trigger} showed nothing for ${verdict.silentMs}ms while ${requests} was pending; the page changed only after the response.${late} Idiom held the response for ${held.delayMs}ms to see what users on a slow network see.`;
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:loading-state-missing",
        selectorHint: trigger,
        fingerprintHint: `loading:${trigger}:${signature(verdict.requests)}`,
        ...(action.id ? { timeline: action.id } : {}),
        explanation,
        acceptance: [
          verdict.route
            ? `Within ${within}ms of navigating to ${verdict.route.to}, the main content shows a skeleton or a pending indicator appears, while ${requests} is still pending.`
            : `Within ${within}ms of activating ${trigger}, a pending indicator (spinner, progressbar, aria-busy, skeleton or "…" label) appears while ${requests} is still pending.`,
        ],
        fix: fixFor(action, trigger),
        verification: verify(this.id, {
          selector: trigger,
          requests: verdict.requests.map(describe),
          silentMs: verdict.silentMs,
          withinMs: within,
          delayMs: held.delayMs,
        }),
      });
    }
    if (bodyRoutes) notes.push("route change judged without a main landmark");
    return coverageOf(this.id, judged, [found.reason, ...notes], candidates);
  },
};

export type DoubleSubmitVerdict =
  | { fires: false; note: string; judged: boolean }
  | {
      fires: true;
      request: HeldRequest;
      duplicates: HeldReplay["secondActivation"]["duplicates"];
    };

/** The firing semantics of double-submit for one held replay. */
export function judgeDoubleSubmit(
  action: SlowAction,
  withinMs: number,
): DoubleSubmitVerdict {
  const held = action.held;
  const why = unjudgeable(action, withinMs);
  if (why) return { fires: false, note: why, judged: false };
  if (navigationOnly(action))
    return {
      fires: false,
      judged: true,
      note: "main-frame document navigation",
    };
  if (action.kind !== "click" && action.kind !== "press")
    return { fires: false, judged: true, note: `${action.kind} action` };
  const request = held.requests.find(
    (request) => !request.navigation && !safeMethods.has(request.method),
  );
  if (!request)
    return { fires: false, judged: true, note: "only safe methods held" };
  // A beacon whose response nothing waits on is not a submission.
  if (held.changeAfterReleaseAt === null)
    return {
      fires: false,
      judged: true,
      note: "no visible change after the response (not gated on it)",
    };
  if (held.trigger.enabled !== true)
    return {
      fires: false,
      judged: true,
      note: "trigger disabled while the request was pending",
    };
  if (!held.secondActivation.attempted)
    return {
      fires: false,
      judged: true,
      note: held.secondActivation.reason ?? "second activation not performed",
    };
  const duplicates = held.secondActivation.duplicates.filter(
    (duplicate) =>
      duplicate.method === request.method && duplicate.path === request.path,
  );
  if (duplicates.length === 0)
    return {
      fires: false,
      judged: true,
      note: "a second activation sent no duplicate request",
    };
  return { fires: true, request, duplicates };
}

export const doubleSubmitCheck: DeterministicCheck = {
  id: "double-submit",
  run({ tuple, config }) {
    const found = slowActions(this.id, tuple);
    if ("coverage" in found) return found;
    const within = config.progressWithinMs;
    const notes: string[] = [];
    const candidates: FindingCandidate[] = [];
    let judged = 0;
    for (const action of found.actions) {
      const verdict = judgeDoubleSubmit(action, within);
      if (!verdict.fires) {
        if (verdict.judged) judged++;
        notes.push(`${label(action)}: ${verdict.note}`);
        continue;
      }
      judged++;
      const trigger = action.selector ?? action.name;
      const request = describe(verdict.request);
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:double-submit",
        selectorHint: trigger,
        fingerprintHint: `double-submit:${trigger}:${request}`,
        ...(action.id ? { timeline: action.id } : {}),
        explanation: `${trigger} stayed enabled while ${request} was pending, and activating it again sent a second ${request}. A double click or an impatient user submits twice. Idiom held the response for ${action.held.delayMs}ms and blocked the duplicate before it was sent.`,
        acceptance: [
          `While ${request} from ${trigger} is pending, activating ${trigger} again sends no second request.`,
        ],
        fix: `Disable ${trigger} from activation until the response settles, or guard the handler with an in-flight flag.`,
        verification: verify(this.id, {
          selector: trigger,
          request,
          duplicates: verdict.duplicates.length,
          withinMs: within,
          delayMs: action.held.delayMs,
        }),
      });
    }
    return coverageOf(this.id, judged, [found.reason, ...notes], candidates);
  },
};
