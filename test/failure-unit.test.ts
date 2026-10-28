import { expect, test } from "vitest";
import { failureEligibility } from "../src/capture/failure.js";
import { TIMELINE_LIMITS, withTimelineIds } from "../src/capture/timeline.js";
import {
  actionTimelineSchema,
  failureReplaySchema,
} from "../src/checks/artifact-schema.js";
import {
  errorStateMissingCheck,
  judgeFailure,
  retryBlockedCheck,
} from "../src/checks/failure-state.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import {
  actionIdentity,
  sameAction,
  temporalCandidates,
} from "../src/checks/temporal-evidence.js";
import type { ActionTimeline, FailureReplay } from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { emptyObservation, required, tupleFor } from "./motion-support.js";

function failure(changes: Partial<FailureReplay> = {}): FailureReplay {
  return {
    of: "probe-click",
    sourceAction: "probe-click:#load",
    mode: "status",
    status: 500,
    feedbackWithinMs: 2000,
    eligibility: {
      basis: "release",
      responseAt: 1500,
      changeAt: 1510,
      selector: "#result",
    },
    dispatched: true,
    navigated: false,
    requests: [
      {
        method: "GET",
        path: "/items",
        resourceType: "fetch",
        startTime: 10,
        injectedAt: 20,
        delivered: true,
      },
    ],
    observationStart: 20,
    observationEnd: 2020,
    feedback: [],
    changes: [],
    trigger: {
      initiallyEnabled: true,
      disabled: false,
      busy: false,
      hidden: false,
      inert: false,
    },
    pending: [],
    main: { selector: "main", initiallyEmpty: false, empty: false },
    retry: [],
    complete: true,
    truncated: false,
    notes: [],
    ...changes,
  };
}
function action(
  facts = failure(),
): ActionTimeline & { failure: FailureReplay } {
  return {
    source: "failure-replay",
    kind: "click",
    selector: "#load",
    name: "Load",
    url: "/",
    startedAt: 1,
    durationMs: 2300,
    settled: true,
    status: "ran",
    truncated: [],
    shifts: [],
    frames: [],
    mutations: [],
    animations: [],
    requests: [],
    viewTransition: { used: false },
    effectRegion: { controls: [] },
    failure: facts,
  };
}
function tuple(facts = failure()) {
  return {
    ...tupleFor(emptyObservation),
    timelines: withTimelineIds({
      version: 1,
      status: "ran",
      limits: { ...TIMELINE_LIMITS },
      truncated: { actions: 0 },
      actions: [action(facts)],
    }),
  };
}
test("default failure settings, strict validation and independent copy", () => {
  expect(checksConfigSchema.parse({}).failure).toEqual({
    mode: "status",
    status: 500,
    feedbackWithinMs: 2000,
  });
  for (const failure of [
    { mode: "offline" },
    { status: 399 },
    { status: 600 },
    { status: 500.5 },
    { feedbackWithinMs: 0 },
    { unknown: true },
  ])
    expect(checksConfigSchema.safeParse({ failure }).success).toBe(false);
  const settings = checksConfigSchema.parse({
    failure: { mode: "network", status: 503 },
  });
  expect(checksConfigFrom(settings).failure).toEqual(settings.failure);
  expect(checksConfigFrom(settings).failure).not.toBe(settings.failure);
});
test("failure facts are strict and belong only to their replay source", () => {
  expect(failureReplaySchema.safeParse(failure()).success).toBe(true);
  expect(actionTimelineSchema.safeParse(action()).success).toBe(true);
  expect(
    actionTimelineSchema.safeParse({ ...action(), source: "probe-click" })
      .success,
  ).toBe(false);
  expect(
    actionTimelineSchema.safeParse({ ...action(), failure: undefined }).success,
  ).toBe(false);
  expect(
    failureReplaySchema.safeParse({
      ...failure(),
      requests: Array(61).fill(failure().requests[0]),
    }).success,
  ).toBe(false);
});
for (const elapsed of [2019, 2020, 2021])
  test(`absence boundary at ${elapsed}ms`, () => {
    const verdict = judgeFailure(action(failure({ observationEnd: elapsed })));
    expect(verdict.missing).toBe(elapsed >= 2020);
  });
test("silent resets and stuck states are distinct", () => {
  expect(judgeFailure(action())).toMatchObject({
    judged: true,
    missing: true,
    blocked: false,
  });
  const stuck = failure();
  stuck.trigger.disabled = true;
  expect(judgeFailure(action(stuck))).toMatchObject({
    missing: true,
    blocked: true,
  });
  expect(
    judgeFailure(
      action(failure({ changes: [{ time: 50, selector: "main" }] })),
    ),
  ).toMatchObject({ missing: false, blocked: false });
});
test("unknown, truncated, navigation and unsuccessful injection cannot prove absence", () => {
  for (const f of [
    failure({ complete: false }),
    failure({ truncated: true }),
    failure({ navigated: true }),
    failure({ dispatched: false }),
    failure({ observationEnd: null }),
    failure({ requests: [] }),
    failure({
      requests: [{ ...required(failure().requests[0]), delivered: false }],
    }),
    failure({ pending: null }),
  ])
    expect(judgeFailure(action(f)).missing).toBe(false);
});
test("generic messages, aria-invalid and a visible retry suppress both rules", () => {
  for (const kind of ["alert", "status", "live", "invalid", "error"] as const) {
    const f = failure({
      feedback: [
        { kind, time: 40, selector: "#error", text: "Something went wrong" },
      ],
    });
    f.trigger.disabled = true;
    expect(judgeFailure(action(f))).toMatchObject({
      judged: true,
      missing: false,
      blocked: false,
    });
  }
  expect(judgeFailure(action(failure({ retry: ["#retry"] })))).toMatchObject({
    missing: false,
    blocked: false,
  });
});
test("old messages and earlier changes do not suppress an absence finding", () => {
  expect(
    judgeFailure(
      action(
        failure({
          feedback: [
            { kind: "alert", time: 0, selector: "#old", text: "Old error" },
          ],
          changes: [{ time: 0, selector: "#old" }],
        }),
      ),
    ),
  ).toMatchObject({ missing: true });
});
test("deadline pending, hidden and emptied region each prevent recovery", () => {
  const hidden = failure();
  hidden.trigger.hidden = true;
  for (const f of [
    hidden,
    failure({ pending: [{ selector: "#spinner", text: "" }] }),
    failure({ main: { selector: "main", initiallyEmpty: false, empty: true } }),
  ])
    expect(judgeFailure(action(f)).blocked).toBe(true);
  expect(
    judgeFailure(
      action(
        failure({
          main: { selector: "main", initiallyEmpty: true, empty: true },
        }),
      ),
    ).blocked,
  ).toBe(false);
});
test("every injected request needs its own complete window", () => {
  const f = failure();
  f.requests.push({ ...required(f.requests[0]), injectedAt: 50 });
  expect(judgeFailure(action(f)).judged).toBe(false);
  f.observationEnd = 2050;
  expect(judgeFailure(action(f)).missing).toBe(true);
});
test("legacy captures need recapture; unprobed and marked zero-action captures skip", () => {
  const t = tuple();
  required(t.timelines).actions = [];
  for (const check of [errorStateMissingCheck, retryBlockedCheck]) {
    const run = () =>
      check.run({
        tuple: t,
        config: checksConfigFrom(),
        tuples: [t],
        narrowViewport: true,
      }).coverage;
    t.observations = emptyObservation;
    expect(run()).toMatchObject({
      status: "skipped",
      reason: "interaction probe did not run",
    });
    t.observations = {
      ...emptyObservation,
      probe: { status: "ran", results: [] },
    };
    expect(run()).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/recapture/),
    });
    t.observations = {
      ...emptyObservation,
      probe: {
        status: "ran",
        results: [],
        failureReplay: {
          mode: "status",
          status: 500,
          feedbackWithinMs: 2000,
          queued: 0,
          ran: 0,
          completed: [],
          notes: [],
        },
      },
    };
    expect(
      check.run({
        tuple: t,
        config: checksConfigFrom(),
        tuples: [t],
        narrowViewport: true,
      }).coverage.status,
    ).toBe("skipped");
    t.observations = emptyObservation;
  }
});
test("native filmstrip selection uses self-contained facts and failure identity", () => {
  const t = tuple();
  expect(
    temporalCandidates(t, checksConfigFrom()).some(
      (c) => c.category === "error-state-missing",
    ),
  ).toBe(true);
  const a = required(required(t.timelines).actions[0]);
  expect(a.id).toBe("failure-probe-1");
  expect(actionIdentity(a)).toMatchObject({
    source: "failure-replay",
    failureOf: "probe-click",
  });
  expect(
    sameAction(actionIdentity(a), {
      ...actionIdentity(a),
      failureOf: "web-step",
    }),
  ).toBe(false);
});
test("fingerprints ignore timestamps and probe ordinals", () => {
  const first = tuple();
  const second = tuple();
  required(required(second.timelines).actions[0]).id = "failure-probe-5";
  const run = (t: ReturnType<typeof tuple>) =>
    errorStateMissingCheck.run({
      tuple: t,
      config: checksConfigFrom(),
      tuples: [t],
      narrowViewport: true,
    }).candidates[0];
  expect(run(first)?.fingerprintHint).toBe(run(second)?.fingerprintHint);
  expect(run(first)?.fix).toContain("#load");
});
test("mere requests and optimistic results do not establish failure eligibility", () => {
  const a: ActionTimeline = {
    ...action(),
    source: "probe-click",
    failure: undefined,
    requests: [
      {
        method: "GET",
        resourceType: "fetch",
        path: "/items",
        startTime: 10,
        endTime: 100,
        status: 200,
        outcome: "ok",
      },
    ],
    mutations: [
      {
        type: "insert",
        selector: "#result",
        time: 20,
        rect: { x: 0, y: 0, width: 100, height: 50 },
      },
    ],
  };
  expect(failureEligibility(a)).toBeUndefined();
  required(a.mutations[0]).time = 110;
  expect(failureEligibility(a)?.basis).toBe("response");
});

test("release request selection keeps private origins distinct even for identical paths", async () => {
  const { eligibleFailureRequests } = await import("../src/capture/failure.js");
  const { rememberRequest } = await import(
    "../src/capture/failure-identity.js"
  );
  const own = {
    method: "GET",
    url: "https://app.example/items?private=one",
    resourceType: "fetch" as const,
  };
  const other = { ...own, url: "https://analytics.example/items?private=two" };
  const original: ActionTimeline = {
    ...action(),
    source: "probe-click",
    failure: undefined,
    requests: [
      {
        method: "GET",
        path: "/items",
        resourceType: "fetch",
        startTime: 0,
        endTime: 100,
        status: 200,
        outcome: "ok",
      },
      {
        method: "GET",
        path: "/items",
        resourceType: "fetch",
        startTime: 0,
        endTime: 100,
        status: 200,
        outcome: "ok",
      },
    ],
  };
  rememberRequest(required(original.requests[0]), own);
  rememberRequest(required(original.requests[1]), other);
  const held = {
    method: "GET",
    path: "/items",
    resourceType: "fetch",
    startTime: 0,
    releasedAt: 100,
    forwarded: true,
    navigation: false,
  };
  rememberRequest(held, own);
  const slow = { held: { requests: [held] } } as ActionTimeline;
  const result = eligibleFailureRequests(
    original,
    slow,
    { basis: "release", responseAt: 100, changeAt: 110, selector: "main" },
    [own, other],
  );
  expect(result).toEqual([own]);
  expect(JSON.stringify(original)).not.toContain("private=");
});
