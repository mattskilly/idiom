import { describe, expect, test } from "vitest";
import {
  mergeTimelines,
  TIMELINE_LIMITS,
  withTimelineIds,
} from "../src/capture/timeline.js";
import { actionTimelineArtifactSchema } from "../src/checks/artifact-schema.js";
import { timelineEvidence } from "../src/checks/shared.js";
import { elementMovements, scrollDuring } from "../src/checks/timeline.js";
import type {
  ActionTimeline,
  ActionTimelineArtifact,
  CheckTuple,
} from "../src/checks/types.js";

const rect = (x: number, y: number, width = 100, height = 20) => ({
  x,
  y,
  width,
  height,
});

function action(overrides: Partial<ActionTimeline> = {}): ActionTimeline {
  return {
    source: "probe-click",
    kind: "click",
    selector: "#go",
    name: "Go",
    url: "/",
    startedAt: 1_000,
    durationMs: 300,
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
    ...overrides,
  };
}

function artifact(
  actions: ActionTimeline[],
  overrides: Partial<ActionTimelineArtifact> = {},
): ActionTimelineArtifact {
  return {
    version: 1,
    status: "ran",
    limits: { ...TIMELINE_LIMITS },
    truncated: { actions: 0 },
    actions,
    ...overrides,
  };
}

describe("withTimelineIds", () => {
  test("orders load, steps, then probe clicks and is idempotent", () => {
    const input = artifact([
      action({ startedAt: 30 }),
      action({ source: "web-step", kind: "fill", stepIndex: 2, startedAt: 5 }),
      action({ startedAt: 20 }),
      action({ source: "load", kind: "navigation", startedAt: 1 }),
      action({ source: "web-step", kind: "click", stepIndex: 1, startedAt: 4 }),
    ]);
    const once = withTimelineIds(input);
    expect(once?.actions.map((a) => [a.id, a.startedAt])).toEqual([
      ["load", 1],
      ["step-1", 4],
      ["step-2", 5],
      ["probe-1", 20],
      ["probe-2", 30],
    ]);
    expect(withTimelineIds(once)).toEqual(once);
    expect(actionTimelineArtifactSchema.parse(once)).toEqual(once);
  });

  test("a later probe round appends ids without renumbering earlier ones", () => {
    const first = withTimelineIds(
      artifact([action({ startedAt: 10 }), action({ startedAt: 20 })]),
    );
    const merged = withTimelineIds(
      mergeTimelines(first, artifact([action({ startedAt: 50 })])),
    );
    expect(merged?.actions.map((a) => [a.id, a.startedAt])).toEqual([
      ["probe-1", 10],
      ["probe-2", 20],
      ["probe-3", 50],
    ]);
  });
});

const heldFacts = (of: "web-step" | "probe-click") => ({
  of,
  delayMs: 1500,
  withinMs: 1000,
  dispatched: true,
  requests: [
    {
      method: "POST",
      path: "/api/save",
      resourceType: "fetch",
      startTime: 12,
      releasedAt: 1502,
      forwarded: false,
      navigation: false,
    },
  ],
  releasedAt: 1502,
  indicator: { kind: "trigger-disabled" as const, selector: "#save", time: 3 },
  indicators: [
    {
      kind: "trigger-disabled" as const,
      selector: "#save",
      time: 3,
      inMain: true,
      progressText: false,
    },
  ],
  firstChange: { time: 3, selector: "#save" },
  firstMainChange: null,
  changedAfterRelease: true,
  changeAfterReleaseAt: 1504,
  mainChangedAfterRelease: true,
  mainChangeAfterReleaseAt: 1504,
  mainSelector: "main",
  mainEmpty: null,
  routeChange: null,
  trigger: { checkedAt: 1005, enabled: false },
  secondActivation: {
    attempted: false,
    reason: "trigger not enabled while the request was pending",
    duplicates: [],
  },
  notes: [],
});

describe("slow-replay actions", () => {
  test("round-trip with held facts; held belongs exactly to slow replays", () => {
    const slow = action({
      source: "slow-replay",
      stepIndex: 2,
      held: heldFacts("web-step"),
    });
    const input = withTimelineIds(artifact([slow]));
    expect(
      actionTimelineArtifactSchema.parse(JSON.parse(JSON.stringify(input))),
    ).toEqual(input);
    expect(
      actionTimelineArtifactSchema.safeParse(
        artifact([action({ held: heldFacts("probe-click") })]),
      ).success,
    ).toBe(false);
    expect(
      actionTimelineArtifactSchema.safeParse(
        artifact([action({ source: "slow-replay" })]),
      ).success,
    ).toBe(false);
  });

  test("ids: slow-step-<n> and slow-probe-<k> after everything else, stable", () => {
    const input = artifact([
      action({
        source: "slow-replay",
        startedAt: 90,
        held: heldFacts("probe-click"),
      }),
      action({ startedAt: 20 }),
      action({
        source: "slow-replay",
        startedAt: 70,
        held: heldFacts("probe-click"),
      }),
      action({
        source: "slow-replay",
        stepIndex: 3,
        startedAt: 80,
        held: heldFacts("web-step"),
      }),
      action({ source: "web-step", stepIndex: 3, startedAt: 5 }),
    ]);
    const once = withTimelineIds(input);
    expect(once?.actions.map((a) => [a.id, a.startedAt])).toEqual([
      ["step-3", 5],
      ["probe-1", 20],
      ["slow-step-3", 80],
      ["slow-probe-1", 70],
      ["slow-probe-2", 90],
    ]);
    expect(withTimelineIds(once)).toEqual(once);
    const merged = withTimelineIds(
      mergeTimelines(
        once,
        artifact([
          action({
            source: "slow-replay",
            startedAt: 200,
            held: heldFacts("probe-click"),
          }),
        ]),
      ),
    );
    expect(merged?.actions.map((a) => a.id)).toEqual([
      "step-3",
      "probe-1",
      "slow-step-3",
      "slow-probe-1",
      "slow-probe-2",
      "slow-probe-3",
    ]);
  });
});

describe("mergeTimelines", () => {
  test("caps actions and counts the overflow", () => {
    const many = Array.from({ length: TIMELINE_LIMITS.actions + 5 }, (_, i) =>
      action({ startedAt: i }),
    );
    const merged = mergeTimelines(
      artifact(many.slice(0, 70)),
      artifact(many.slice(70)),
    );
    expect(merged?.actions).toHaveLength(TIMELINE_LIMITS.actions);
    expect(merged?.truncated.actions).toBe(5);
    expect(merged?.status).toBe("partial");
    expect(merged?.reason).toMatch(/actions beyond/);
    expect(() => actionTimelineArtifactSchema.parse(merged)).not.toThrow();
  });

  test("an empty collection never degrades the status", () => {
    const empty = artifact([], {
      status: "unavailable",
      reason: "no recorded actions",
    });
    expect(mergeTimelines(empty, artifact([action()]))?.status).toBe("ran");
    expect(mergeTimelines(empty)?.status).toBe("unavailable");
    expect(mergeTimelines(undefined, undefined)).toBeUndefined();
  });
});

describe("elementMovements", () => {
  test("compensates scroll and reports distance and timing", () => {
    const timeline = action({
      frames: [
        {
          time: 0,
          scroll: { x: 0, y: 0 },
          scrollers: [],
          elements: [
            { selector: "#a", rect: rect(0, 1000), offset: { x: 0, y: 0 } },
            { selector: "#b", rect: rect(0, 1100), offset: { x: 0, y: 0 } },
          ],
        },
        {
          // Scrolled 900px: #a's viewport rect moved, its page position did not.
          time: 16,
          scroll: { x: 0, y: 900 },
          scrollers: [],
          elements: [
            { selector: "#a", rect: rect(0, 100), offset: { x: 0, y: 900 } },
          ],
        },
        {
          time: 48,
          scroll: { x: 0, y: 900 },
          scrollers: [],
          elements: [
            { selector: "#b", rect: rect(0, 320), offset: { x: 0, y: 900 } },
          ],
        },
      ],
    });
    expect(elementMovements(timeline)).toEqual([
      {
        selector: "#b",
        dx: 0,
        dy: 120,
        distance: 120,
        firstMovedAt: 48,
        lastMovedAt: 48,
      },
    ]);
    expect(scrollDuring(timeline)).toEqual({ dx: 0, dy: 900 });
  });

  test("falls back to layout-shift sources for unsampled elements", () => {
    const timeline = action({
      shifts: [
        {
          time: 12,
          value: 0.1,
          hadRecentInput: true,
          sources: [
            {
              selector: "#late",
              previousRect: rect(0, 40),
              currentRect: rect(0, 100),
            },
          ],
        },
      ],
    });
    expect(elementMovements(timeline)).toEqual([
      {
        selector: "#late",
        dx: 0,
        dy: 60,
        distance: 60,
        firstMovedAt: 12,
        lastMovedAt: 12,
      },
    ]);
  });
});

describe("timelineEvidence", () => {
  const tuple = (timelines?: ActionTimelineArtifact) =>
    ({ timelines }) as unknown as CheckTuple;

  test("a capture without timelines asks for a recapture", () => {
    expect(timelineEvidence(tuple())).toEqual({
      status: "unavailable",
      reason: "unavailable: recapture (no action timelines in this capture)",
    });
  });

  test("an unavailable collection passes its reason through", () => {
    expect(
      timelineEvidence(
        tuple(
          artifact([], {
            status: "unavailable",
            reason: "no recorded actions",
          }),
        ),
      ),
    ).toEqual({ status: "unavailable", reason: "no recorded actions" });
  });

  test("truncation surfaces in the coverage reason", () => {
    const truncated = action({
      status: "partial",
      reason: "timeline truncated: mutations",
      truncated: ["mutations"],
    });
    const evidence = timelineEvidence(
      tuple(
        artifact([action(), truncated], {
          status: "partial",
          reason: "timeline truncated: mutations",
        }),
      ),
    );
    expect(evidence).toMatchObject({
      status: "ran",
      truncated: ["mutations"],
      reason: "timeline truncated: mutations",
    });
  });
});
