import { expect, test } from "vitest";
import { TIMELINE_LIMITS, withTimelineIds } from "../src/capture/timeline.js";
import {
  doubleSubmitCheck,
  loadingStateMissingCheck,
} from "../src/checks/loading-state.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ActionTimeline,
  CheckTuple,
  DeterministicCheck,
  HeldReplay,
  ObservationArtifact,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { emptyObservation, tupleFor } from "./motion-support.js";

type Indicator = HeldReplay["indicators"][number];
const request = (
  changes: Partial<HeldReplay["requests"][number]> = {},
): HeldReplay["requests"][number] => ({
  method: "GET",
  path: "/api/items",
  resourceType: "fetch",
  startTime: 10,
  releasedAt: 1500,
  forwarded: true,
  navigation: false,
  ...changes,
});
function held(changes: Partial<HeldReplay> = {}): HeldReplay {
  return {
    of: "probe-click",
    delayMs: 1500,
    withinMs: 1000,
    dispatched: true,
    requests: [request()],
    releasedAt: 1500,
    indicator: null,
    indicators: [],
    firstChange: { time: 1505, selector: "#list > li" },
    firstMainChange: { time: 1505, selector: "#list > li" },
    changedAfterRelease: true,
    changeAfterReleaseAt: 1505,
    mainChangedAfterRelease: true,
    mainChangeAfterReleaseAt: 1505,
    mainSelector: "main",
    mainEmpty: null,
    routeChange: null,
    trigger: { checkedAt: 1005, enabled: true },
    secondActivation: { attempted: false, duplicates: [] },
    notes: [],
    ...changes,
  };
}
function slow(
  facts: HeldReplay,
  changes: Partial<ActionTimeline> = {},
): ActionTimeline {
  return {
    source: "slow-replay",
    kind: "click",
    selector: "#load",
    name: "Load",
    url: "/",
    startedAt: 1,
    durationMs: 1700,
    settled: true,
    status: "ran",
    truncated: [],
    shifts: [],
    frames: [],
    mutations: [
      { time: 1505, type: "insert", selector: "#list > li", rect: null },
    ],
    animations: [],
    requests: [],
    viewTransition: { used: false },
    effectRegion: { control: "#load", controls: [], commonAncestor: "#list" },
    held: facts,
    ...changes,
  };
}
function tuple(
  actions: ActionTimeline[] | undefined,
  observations: ObservationArtifact = {
    ...emptyObservation,
    probe: {
      status: "ran",
      results: [],
      heldReplay: { delayMs: 1500, queued: 1, ran: 1, notes: [] },
    },
  },
): CheckTuple {
  return {
    ...tupleFor(emptyObservation),
    observations,
    ...(actions === undefined
      ? {}
      : {
          timelines: withTimelineIds({
            version: 1,
            status: "ran",
            limits: { ...TIMELINE_LIMITS },
            truncated: { actions: 0 },
            actions,
          }),
        }),
  };
}
function run(check: DeterministicCheck, subject: CheckTuple, settings = {}) {
  return check.run({
    tuple: subject,
    narrowViewport: false,
    tuples: [subject],
    config: checksConfigFrom(checksConfigSchema.parse(settings)),
  });
}
const loading = (actions: ActionTimeline[]) =>
  run(loadingStateMissingCheck, tuple(actions));
const indicator = (changes: Partial<Indicator>): Indicator => ({
  kind: "spinner",
  selector: ".spinner",
  time: 50,
  inMain: true,
  progressText: false,
  ...changes,
});

test("a response-gated change with no feedback is reported with trigger, request, silent time and fix", () => {
  const result = loading([slow(held())]);
  expect(result.coverage.status).toBe("ran");
  const [finding] = result.candidates;
  expect(finding).toMatchObject({
    category: "loading-state-missing",
    severity: "major",
    rule: "idiom:loading-state-missing",
    selectorHint: "#load",
    timeline: "slow-probe-1",
    fingerprintHint: "loading:#load:GET /api/items",
  });
  expect(finding?.explanation).toBe(
    "Clicking #load showed nothing for 1500ms while GET /api/items was pending; the page changed only after the response. Idiom held the response for 1500ms to see what users on a slow network see.",
  );
  expect(finding?.fix).toBe(
    'Show a pending state on #load as soon as it is activated (aria-busy with a spinner or a "Saving…"/"Loading…" label). Disable it while the request is pending. Render a skeleton sized to the final content in #list until the response arrives.',
  );
  expect(finding?.verification.params).toEqual({
    selector: "#load",
    requests: ["GET /api/items"],
    silentMs: 1500,
    withinMs: 1000,
    delayMs: 1500,
  });
});

test("feedback within progressWithinMs clears it; late feedback sets the silent time", () => {
  expect(
    loading([slow(held({ indicators: [indicator({ time: 40 })] }))]).candidates,
  ).toEqual([]);
  expect(
    loading([slow(held({ firstChange: { time: 5, selector: "#hint" } }))])
      .candidates,
  ).toEqual([]);
  const late = loading([
    slow(held({ indicators: [indicator({ time: 1200 })] })),
  ]).candidates[0];
  expect(late?.explanation).toContain("showed nothing for 1200ms");
  expect(late?.explanation).toContain(
    "The first feedback appeared only after 1200ms.",
  );
});

test("exclusions: navigation, fire-and-forget, non-adjacent change, undispatched", () => {
  const navigation = loading([
    slow(
      held({
        requests: [
          request({
            resourceType: "document",
            navigation: true,
            path: "/next",
          }),
        ],
      }),
      { status: "partial", reason: "document navigated during the action" },
    ),
  ]);
  expect(navigation.candidates).toEqual([]);
  expect(navigation.coverage).toMatchObject({ status: "ran" });
  expect(navigation.coverage.reason).toContain(
    "main-frame document navigation",
  );
  const forget = loading([
    slow(
      held({
        changeAfterReleaseAt: null,
        changedAfterRelease: false,
        firstChange: null,
      }),
    ),
  ]);
  expect(forget.candidates).toEqual([]);
  expect(forget.coverage.reason).toContain("not gated on it");
  expect(
    loading([
      slow(
        held({
          changeAfterReleaseAt: 2400,
          firstChange: { time: 2400, selector: "#x" },
        }),
      ),
    ]).candidates,
  ).toEqual([]);
  const undispatched = loading([slow(held({ dispatched: false }))]);
  expect(undispatched.candidates).toEqual([]);
  expect(undispatched.coverage.status).toBe("unavailable");
});

test("a web step that submits by document navigation gets one short coverage note", () => {
  const step = slow(
    held({
      of: "web-step",
      requests: [
        request({ resourceType: "document", navigation: true, path: "/next" }),
      ],
      notes: ["main-frame document navigation"],
    }),
    {
      selector: "#submit",
      stepIndex: 1,
      status: "partial",
      reason:
        "document navigated during the action; in-page timeline unavailable",
    },
  );
  for (const check of [loadingStateMissingCheck, doubleSubmitCheck]) {
    const result = run(check, tuple([step]));
    expect(result.candidates).toEqual([]);
    expect(result.coverage.reason).toBe(
      "step 1 #submit: main-frame document navigation",
    );
  }
});

test("delayMs not above progressWithinMs is unjudgeable", () => {
  const result = loading([slow(held({ delayMs: 800 }))]);
  expect(result.candidates).toEqual([]);
  expect(result.coverage).toMatchObject({ status: "unavailable" });
  expect(result.coverage.reason).toContain(
    "checks.loading.delayMs must exceed progressWithinMs",
  );
});

test("a route change counts only indicators, progress text and main-region changes", () => {
  const route = {
    routeChange: { from: "/", to: "/orders", time: 1 },
    firstChange: { time: 5, selector: "nav a.active" },
    firstMainChange: { time: 1505, selector: "main > h1" },
    mainEmpty: { from: 2, to: 1505 },
    indicators: [
      indicator({
        kind: "status-text",
        selector: "#announcer",
        time: 10,
        text: "Orders",
        inMain: false,
      }),
      indicator({
        kind: "trigger-pressed",
        selector: "#orders",
        time: 3,
        inMain: false,
      }),
    ],
  };
  const fires = loading([slow(held(route))]).candidates[0];
  expect(fires?.explanation).toBe(
    "Navigating to /orders left the main content empty for 1500ms with no pending indicator while GET /api/items was pending; it changed only after the response. Idiom held the response for 1500ms to see what users on a slow network see.",
  );
  for (const extra of [
    {
      indicators: [
        ...route.indicators,
        indicator({ kind: "progressbar", time: 50, inMain: false }),
      ],
    },
    {
      indicators: [
        ...route.indicators,
        indicator({
          kind: "status-text",
          time: 50,
          text: "Loading…",
          progressText: true,
          inMain: false,
        }),
      ],
    },
    { firstMainChange: { time: 50, selector: "main > .skeleton" } },
  ])
    expect(loading([slow(held({ ...route, ...extra }))]).candidates).toEqual(
      [],
    );
  // The same outside-main change clears an ordinary action.
  expect(
    loading([
      slow(held({ firstChange: { time: 5, selector: "nav a.active" } })),
    ]).candidates,
  ).toEqual([]);
  // Without a main landmark the route is judged on the whole body.
  expect(
    loading([slow(held({ ...route, mainSelector: "body" }))]).coverage.reason,
  ).toContain("route change judged without a main landmark");
});

test("declared longRunning steps judged by progress-affordance are left to it", () => {
  const step = slow(held({ of: "web-step" }), {
    stepIndex: 2,
    selector: "#generate",
  });
  const observations = (
    status: "ran" | "unavailable",
  ): ObservationArtifact => ({
    ...emptyObservation,
    probe: {
      status: "ran",
      results: [],
      heldReplay: { delayMs: 1500, queued: 1, ran: 1, notes: [] },
    },
    progress: {
      version: 1,
      withinMs: 1000,
      steps: [
        {
          stepIndex: 2,
          action: "click",
          selector: "#generate",
          status,
          firstMs: null,
          observedMs: 1100,
        },
      ],
    },
  });
  expect(
    run(loadingStateMissingCheck, tuple([step], observations("ran")))
      .candidates,
  ).toEqual([]);
  expect(
    run(loadingStateMissingCheck, tuple([step], observations("unavailable")))
      .candidates,
  ).toHaveLength(1);
});

test("a web-step replay wins over a probe replay of the same control and requests", () => {
  const result = loading([
    slow(held()),
    slow(held({ of: "web-step" }), { stepIndex: 1 }),
  ]);
  expect(result.candidates.map((candidate) => candidate.timeline)).toEqual([
    "slow-step-1",
  ]);
});

test("coverage: old runs, probe absent, nothing queued, budget notes", () => {
  expect(
    run(loadingStateMissingCheck, tuple(undefined)).coverage,
  ).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("recapture"),
  });
  expect(
    run(loadingStateMissingCheck, tuple([], emptyObservation)).coverage,
  ).toEqual({
    check: "loading-state-missing",
    status: "skipped",
    reason: "interaction probe did not run",
  });
  const queued = (queuedCount: number, notes: string[]) =>
    tuple([], {
      ...emptyObservation,
      probe: {
        status: "ran",
        results: [],
        heldReplay: { delayMs: 1500, queued: queuedCount, ran: 0, notes },
      },
    });
  expect(run(doubleSubmitCheck, queued(0, [])).coverage).toEqual({
    check: "double-submit",
    status: "skipped",
    reason: "no action sent fetch/XHR/document requests",
  });
  expect(
    run(
      loadingStateMissingCheck,
      queued(2, ["not reached: probe budget (2 held replays)"]),
    ).coverage,
  ).toEqual({
    check: "loading-state-missing",
    status: "unavailable",
    reason: "not reached: probe budget (2 held replays)",
  });
});

const posted = (changes: Partial<HeldReplay> = {}) =>
  held({
    requests: [
      request({ method: "POST", path: "/api/save", forwarded: false }),
    ],
    secondActivation: {
      attempted: true,
      at: 1010,
      duplicates: [{ method: "POST", path: "/api/save", time: 1030 }],
    },
    ...changes,
  });

test("double-submit: an enabled trigger whose second activation duplicates the POST", () => {
  const result = run(doubleSubmitCheck, tuple([slow(posted())]));
  expect(result.candidates).toEqual([
    expect.objectContaining({
      rule: "idiom:double-submit",
      severity: "major",
      selectorHint: "#load",
      timeline: "slow-probe-1",
      fingerprintHint: "double-submit:#load:POST /api/save",
      fix: "Disable #load from activation until the response settles, or guard the handler with an in-flight flag.",
    }),
  ]);
});

test("double-submit exclusions: disabled trigger, safe methods, no duplicate, beacon, fill", () => {
  const none = (facts: HeldReplay, changes: Partial<ActionTimeline> = {}) =>
    expect(
      run(doubleSubmitCheck, tuple([slow(facts, changes)])).candidates,
    ).toEqual([]);
  none(
    posted({
      trigger: { checkedAt: 1005, enabled: false },
      secondActivation: {
        attempted: false,
        reason: "trigger not enabled",
        duplicates: [],
      },
    }),
  );
  none(
    held({
      secondActivation: {
        attempted: true,
        duplicates: [{ method: "GET", path: "/api/items", time: 1030 }],
      },
    }),
  );
  none(
    posted({ secondActivation: { attempted: true, at: 1010, duplicates: [] } }),
  );
  none(posted({ changeAfterReleaseAt: null, changedAfterRelease: false }));
  none(posted(), { kind: "fill" });
});

test("acceptance requires feedback on the matching held replay and request", async () => {
  const { buildRuleContract } = await import("../src/findings/contract.js");
  const { evaluateRuleAcceptance } = await import(
    "../src/verify/acceptance.js"
  );
  const before = tuple([slow(held())]);
  const candidate = run(loadingStateMissingCheck, before).candidates[0];
  if (!candidate) throw new Error("missing fixture candidate");
  const contract = buildRuleContract(before, candidate).acceptance;
  expect(contract.target).toMatchObject({
    kind: "action",
    action: { source: "slow-replay", selector: "#load" },
  });
  expect(contract.condition.parameters).toMatchObject({
    withinMs: 1000,
    delayMs: 1500,
    requests: [{ method: "GET", path: "/api/items", resourceType: "fetch" }],
  });
  const evaluate = (current: CheckTuple) =>
    evaluateRuleAcceptance({
      contract,
      currentA: [current],
      currentB: [current],
    });
  expect(evaluate(before).status).toBe("failed");
  const after = slow(held({ indicators: [indicator({ time: 50 })] }));
  expect(evaluate(tuple([after])).status).toBe("passed");
  expect(
    evaluate(
      tuple([
        slow(held(), { selector: "#other" }),
        { ...after, selector: "#unrelated" },
      ]),
    ).status,
  ).toBe("not-recheckable");
  expect(
    evaluate(
      tuple([
        slow(
          held({
            indicators: [indicator({ time: 50 })],
            requests: [request({ path: "/api/elsewhere" })],
          }),
        ),
      ]),
    ).reason,
  ).toContain("request identity");
  expect(evaluate(tuple([])).status).toBe("not-recheckable");
});
