import { expect, test } from "vitest";
import { heldStepIndexes, replayKey } from "../src/capture/loading.js";
import { fillReplays } from "../src/capture/probe-merge.js";
import { createReplayLedger } from "../src/capture/replay-ledger.js";
import { TIMELINE_LIMITS, withTimelineIds } from "../src/capture/timeline.js";
import type { ActionTimeline, ProbeArtifact } from "../src/checks/types.js";

const P = "desktop\0light";
const timeline = (
  source: ActionTimeline["source"],
  stepIndex?: number,
  extra: Partial<ActionTimeline> = {},
): ActionTimeline => ({
  source,
  kind: "click",
  selector: "#save",
  name: "Save",
  ...(stepIndex === undefined ? {} : { stepIndex }),
  url: "/",
  startedAt: 1,
  durationMs: 10,
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
  ...extra,
});
const slowStep = (stepIndex: number) =>
  timeline("slow-replay", stepIndex, {
    held: {
      of: "web-step",
      delayMs: 1500,
      withinMs: 1000,
      dispatched: true,
      requests: [],
      releasedAt: 1500,
      indicator: null,
      indicators: [],
      firstChange: null,
      firstMainChange: null,
      changedAfterRelease: false,
      changeAfterReleaseAt: null,
      mainChangedAfterRelease: false,
      mainChangeAfterReleaseAt: null,
      mainSelector: "main",
      mainEmpty: null,
      routeChange: null,
      trigger: { checkedAt: 1000, enabled: true },
      secondActivation: { attempted: false, duplicates: [] },
      notes: [],
    },
  });

test("plan gives each key one owner, balanced across states in flow order", () => {
  const ledger = createReplayLedger();
  ledger.plan(P, [
    { state: "a", keys: ["k1", "k2"] },
    { state: "b", keys: ["k1", "k2"] },
    { state: "c", keys: ["k1", "k3"] },
  ]);
  expect(ledger.planned(P)).toBe(true);
  expect(ledger.planned("other")).toBe(false);
  expect(ledger.owner(P, "k1")).toBe("a");
  expect(ledger.owner(P, "k2")).toBe("b");
  expect(ledger.owner(P, "k3")).toBe("c");
  expect(ledger.owner(P, "unplanned")).toBeUndefined();
  expect(ledger.assignedCount(P, "a")).toBe(1);
  ledger.record(P, "k1", "a", [slowStep(1)], []);
  expect(ledger.assignedCount(P, "a")).toBe(0);
});

test("record is first-wins and skips empty results", () => {
  const ledger = createReplayLedger();
  ledger.record(P, "k", "a", [], []);
  expect(ledger.lookup(P, "k")).toBeUndefined();
  ledger.record(P, "k", "a", [{ ...slowStep(1), id: "slow-step-1" }], ["f"]);
  ledger.record(P, "k", "b", [slowStep(2)], []);
  expect(ledger.lookup(P, "k")).toMatchObject({
    state: "a",
    failureKeys: ["f"],
  });
  expect(ledger.lookup(P, "k")?.actions[0]).not.toHaveProperty("id");
});

test("steal hands an unrecorded key to an untried holder, never back, and finalizes", () => {
  const ledger = createReplayLedger();
  ledger.plan(P, [
    { state: "a", keys: ["k"] },
    { state: "b", keys: ["k"] },
  ]);
  const runnable = new Set(["a", "b"]);
  // An owner that did not run this round has not tried it.
  expect(ledger.steal(P, new Set(["b"]), runnable)).toBe(0);
  expect(ledger.owner(P, "k")).toBe("a");
  expect(ledger.steal(P, new Set(["a"]), runnable)).toBe(1);
  expect(ledger.owner(P, "k")).toBe("b");
  expect(ledger.assignedCount(P, "b")).toBe(1);
  expect(ledger.steal(P, new Set(["b"]), runnable)).toBe(0);
  expect(ledger.finalReason(P, "k")).toBe(
    "not completed in any state that shows it (tried a, b)",
  );
  expect(ledger.assignedCount(P, "b")).toBe(0);
});

test("steal returns 0 once recorded; exhaust gives the rest a final reason", () => {
  const ledger = createReplayLedger();
  ledger.plan(P, [
    { state: "a", keys: ["done", "open"] },
    { state: "b", keys: ["done", "open"] },
  ]);
  ledger.record(P, "done", ledger.owner(P, "done") ?? "", [slowStep(1)], []);
  ledger.exhaust(P, "flow probe time exhausted");
  expect(ledger.finalReason(P, "done")).toBeUndefined();
  expect(ledger.finalReason(P, "open")).toBe("flow probe time exhausted");
  expect(ledger.steal(P, new Set(["a", "b"]), new Set(["a", "b"]))).toBe(0);
});

test("fill copies once per state, never to the recording state, clone-isolated", () => {
  const ledger = createReplayLedger();
  ledger.record(P, "k", "a", [slowStep(1)], ["fail-key"]);
  expect(ledger.fill(P, "a", ["k"]).reused).toBe(0);
  const first = ledger.fill(P, "b", ["k", "missing"]);
  expect(first).toMatchObject({ reused: 1, failureKeys: ["fail-key"] });
  const [copied] = first.actions;
  if (copied?.held) copied.held.notes.push("mutated");
  expect(ledger.lookup(P, "k")?.actions[0]?.held?.notes).toEqual([]);
  expect(ledger.fill(P, "b", ["k"]).reused).toBe(0);
});

test("held step indexes and replay keys", () => {
  const steps = [
    { action: "click", selector: "#a" },
    { action: "expectText", text: "x" },
    { action: "fill", selector: "#b", value: "v" },
  ];
  const fetch = [
    {
      method: "GET",
      resourceType: "fetch",
      path: "/api",
      startTime: 1,
      endTime: 2,
      status: 200,
      outcome: "ok" as const,
    },
  ];
  expect(
    heldStepIndexes(
      [
        timeline("web-step", 1, { requests: fetch }),
        timeline("web-step", 2, { requests: fetch }),
        timeline("web-step", 3),
        timeline("probe-click", undefined, { requests: fetch }),
      ],
      steps,
    ),
  ).toEqual([1]);
  const key = replayKey("http://x/", steps, 1);
  expect(replayKey("http://x/", [steps[0]], 1)).toBe(key);
  expect(replayKey("http://x/", steps, 3)).not.toBe(key);
  expect(replayKey("http://y/", steps, 1)).not.toBe(key);
  expect(
    replayKey("http://x/", [{ action: "click", selector: "#z" }], 1),
  ).not.toBe(key);
});

test("fillReplays normalizes only incoming actions and failure keys before merging", () => {
  const ledger = createReplayLedger();
  ledger.record(
    P,
    "k",
    "a",
    [
      slowStep(2),
      timeline("failure-replay", 2, {
        failure: {
          of: "web-step",
        } as unknown as ActionTimeline["failure"],
      }),
    ],
    ["fail-key"],
  );
  const probe = {
    status: "ran",
    results: [],
    failureReplay: {
      mode: "status",
      status: 503,
      feedbackWithinMs: 1000,
      queued: 0,
      ran: 0,
      completed: ["other"],
      notes: [],
    },
  } as ProbeArtifact;
  const timelines = fillReplays({
    ledger,
    partition: P,
    state: "b",
    keys: ["k"],
    timelines: withTimelineIds({
      version: 1,
      status: "ran",
      limits: { ...TIMELINE_LIMITS },
      truncated: { actions: 0 },
      actions: [timeline("web-step", 1), timeline("probe-click")],
    }),
    probe,
    delayMs: 1500,
    normalizeCopy: (copy) => ({
      ...copy,
      actions: copy.actions.map((action) => ({
        ...action,
        url: "/normalized",
      })),
      failureKeys: copy.failureKeys.map((key) => `normalized:${key}`),
    }),
  });
  expect(timelines?.actions.map((action) => action.id)).toEqual([
    "step-1",
    "probe-1",
    "slow-step-2",
    "failure-step-2",
  ]);
  expect(probe.heldReplay).toEqual({
    delayMs: 1500,
    queued: 0,
    ran: 0,
    reused: 1,
    notes: [],
  });
  expect(probe.failureReplay).toMatchObject({
    reused: 1,
    completed: ["other", "normalized:fail-key"],
  });
  const copied = timelines?.actions.filter((action) => action.stepIndex === 2);
  expect(copied?.map((action) => action.url)).toEqual([
    "/normalized",
    "/normalized",
  ]);
  expect(timelines?.actions[0]?.url).not.toBe("/normalized");
  expect(ledger.lookup(P, "k")?.failureKeys).toEqual(["fail-key"]);
  expect(ledger.lookup(P, "k")?.actions[0]?.url).not.toBe("/normalized");
});
