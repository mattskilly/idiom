import { describe, expect, test } from "vitest";
import {
  motionArtifactSchema,
  observationArtifactSchema,
} from "../src/checks/artifact-schema.js";
import {
  contentSnaps,
  motionCheck,
  snapDuration,
} from "../src/checks/motion.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ActionTimeline,
  ActionTimelineArtifact,
  MotionArtifact,
  MotionChange,
  MotionEffect,
  VisibleChange,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import {
  emptyObservation,
  fade,
  required,
  swap,
  tupleFor,
} from "./motion-support.js";

const effect: MotionEffect = {
  kind: "transition",
  property: "opacity",
  name: "",
  durationMs: 400,
  timing: "finite",
  delayMs: 0,
  started: true,
  canceled: false,
};
const change: MotionChange = {
  selector: "#layers",
  ownerSelector: "#layers",
  ownerName: "Layers panel",
  name: "Layers panel",
  role: "region",
  tag: "aside",
  surface: true,
  tooltip: false,
  before: null,
  after: null,
  changed: ["presence"],
  toggled: true,
  direction: "collapse",
  animated: false,
  effects: [],
};
const artifact = (changes: MotionChange[] = [change]): MotionArtifact => ({
  version: 1,
  status: "ran",
  reducedMotion: false,
  actions: [
    {
      source: "probe-click",
      selector: "#toggle",
      name: "Toggle Layers",
      status: "ran",
      changes,
    },
  ],
});
function check(motion: MotionArtifact | undefined, policy: unknown = {}) {
  return motionCheck.run({
    tuple: tupleFor({ ...emptyObservation, ...(motion ? { motion } : {}) }),
    config: checksConfigFrom(checksConfigSchema.parse({ motion: policy })),
    narrowViewport: false,
  });
}

describe("motion policy over stored evidence", () => {
  test("legacy evidence is unavailable; an observed empty action set ran", () => {
    expect(check(undefined).coverage.status).toBe("unavailable");
    expect(check(artifact([]))).toMatchObject({
      coverage: { status: "ran" },
      candidates: [],
    });
    expect(observationArtifactSchema.parse(emptyObservation)).toEqual(
      emptyObservation,
    );
    const { maskMembership: _, ...v1 } = emptyObservation;
    expect(
      observationArtifactSchema.safeParse({ ...v1, version: 1 }).success,
    ).toBe(true);
  });
  test("snap is major only in a complete normal window, with stable identity", () => {
    const normal = check(artifact());
    expect(normal.candidates[0]).toMatchObject({
      rule: "idiom:motion-no-transition",
      severity: "major",
      explanation: expect.stringContaining(
        "Layers panel collapse: no transition",
      ),
    });
    const reduced = artifact();
    reduced.reducedMotion = true;
    expect(check(reduced).candidates).toEqual([]);
    const incomplete = artifact();
    required(incomplete.actions[0]).status = "partial";
    required(incomplete.actions[0]).reason = "action failed";
    expect(check(incomplete).candidates).toEqual([]);
    expect(check(incomplete).coverage.reason).toContain("action failed");
    const unknown = artifact([
      { ...change, animated: null, reason: "unknown mechanism" },
    ]);
    expect(check(unknown).candidates).toEqual([]);
  });
  test.each([
    [150, {}, 0],
    [150.05, {}, 0],
    [150.2, {}, 1],
    [120, { durations: [120, 150] }, 0],
    [130, { durations: [120, 150] }, 1],
    [400, { durations: [120, 150] }, 1],
    [0, { durations: [120] }, 0],
  ])(
    "duration %s with %j gives %s duration findings",
    (durationMs, policy, count) => {
      const result = check(
        artifact([
          { ...change, animated: true, effects: [{ ...effect, durationMs }] },
        ]),
        policy,
      );
      expect(result.candidates).toHaveLength(count);
      if (durationMs === 400)
        expect(result.candidates[0]?.explanation).toContain(
          "exceeds 150ms limit and is outside",
        );
    },
  );
  test("delay and unused declarations do not imply running motion", () => {
    const reduced = artifact([
      {
        ...change,
        animated: true,
        effects: [
          {
            ...effect,
            durationMs: 120,
            delayMs: 1000,
            started: false,
            canceled: true,
          },
        ],
      },
    ]);
    reduced.reducedMotion = true;
    expect(check(reduced).candidates).toEqual([]);
    required(
      required(required(reduced.actions[0]).changes[0]).effects[0],
    ).started = true;
    expect(check(reduced).candidates.map((c) => c.rule)).toEqual([
      "idiom:motion-reduced",
    ]);
  });
  test("infinite, unknown, and repeated effects remain JSON-safe and deduplicate", () => {
    const a = artifact([
      {
        ...change,
        animated: true,
        effects: [{ ...effect, timing: "infinite", durationMs: null }],
      },
    ]);
    a.actions.push({
      ...required(a.actions[0]),
      source: "web-step",
      stepIndex: 1,
    });
    expect(check(a).candidates).toHaveLength(1);
    expect(check(a).candidates[0]?.explanation).toContain("infinite");
    required(required(required(a.actions[0]).changes[0]).effects[0]).timing =
      "unsupported";
    expect(check(a).candidates).toEqual([]);
    expect(check(a).coverage.reason).toContain("duration unavailable");
    expect(motionArtifactSchema.parse(JSON.parse(JSON.stringify(a)))).toEqual(
      a,
    );
  });
  test("mixed and wholly unavailable windows expose coverage limits", () => {
    const mixed = artifact();
    mixed.status = "partial";
    mixed.reason = "one lost document";
    mixed.actions.push({
      source: "web-step",
      selector: "#nav",
      name: "click",
      status: "unavailable",
      reason: "navigation",
      changes: [],
    });
    expect(check(mixed)).toMatchObject({
      coverage: {
        status: "ran",
        reason: expect.stringContaining("navigation"),
      },
      candidates: [{ rule: "idiom:motion-no-transition" }],
    });
    mixed.actions.shift();
    expect(check(mixed).coverage.status).toBe("unavailable");
  });
  test("strict schemas reject malformed evidence and configuration", () => {
    for (const motion of [
      { maxMs: 0 },
      { maxMs: Infinity },
      { durations: [120, 120] },
      { durations: [-1] },
      { selectors: [" "] },
    ])
      expect(checksConfigSchema.safeParse({ motion }).success).toBe(false);
    for (const patch of [
      { version: 2 },
      { extra: 1 },
      { reducedMotion: "reduce" },
    ])
      expect(
        motionArtifactSchema.safeParse({ ...artifact(), ...patch }).success,
      ).toBe(false);
    expect(
      motionArtifactSchema.safeParse(
        artifact([
          { ...change, effects: [{ ...effect, durationMs: Infinity }] },
        ]),
      ).success,
    ).toBe(false);
    expect(
      motionArtifactSchema.safeParse(
        artifact([{ ...change, effects: [{ ...effect, timing: "infinite" }] }]),
      ).success,
    ).toBe(false);
  });
});

let clock = 0;
function window(
  name: string,
  options: {
    reducedMotion?: boolean | undefined;
    confirmation?: boolean;
    changes?: VisibleChange[];
    animations?: ActionTimeline["animations"];
    source?: ActionTimeline["source"];
    viewTransition?: boolean;
  } = {},
): ActionTimeline {
  clock += 1;
  return {
    source: options.source ?? "probe-click",
    kind: "click",
    selector: `#${name}`,
    name,
    url: "/",
    startedAt: clock,
    durationMs: 200,
    settled: true,
    status: "ran",
    truncated: [],
    shifts: [],
    frames: [],
    mutations: [],
    animations: options.animations ?? [],
    requests: [],
    viewTransition: { used: options.viewTransition ?? false },
    effectRegion: { controls: [] },
    ...(options.reducedMotion === undefined
      ? {}
      : { reducedMotion: options.reducedMotion }),
    ...(options.confirmation ? { confirmation: true as const } : {}),
    visibleChanges: options.changes ?? [swap],
  };
}
function snaps(
  actions: ActionTimeline[],
  policy: unknown = {},
  motion?: MotionArtifact,
) {
  const timelines: ActionTimelineArtifact = {
    version: 1,
    status: "ran",
    limits: {
      frames: 60,
      elements: 250,
      changesPerFrame: 80,
      shifts: 50,
      mutations: 60,
      animations: 40,
      requests: 60,
      actions: 120,
      visibleChanges: 40,
    },
    truncated: { actions: 0 },
    actions: actions.map((action, index) => ({
      ...action,
      id: `probe-${index + 1}`,
    })),
  };
  return motionCheck.run({
    tuple: {
      ...tupleFor({ ...emptyObservation, ...(motion ? { motion } : {}) }),
      timelines,
    },
    config: checksConfigFrom(checksConfigSchema.parse({ motion: policy })),
    narrowViewport: false,
  });
}
const params = (result: ReturnType<typeof snaps>, index = 0) =>
  result.candidates[index]?.verification.params as {
    actions: Array<{ name: string; timeline?: string }>;
  };

describe("content snaps over action timelines", () => {
  test("extent threshold is configurable; text-only, animated, view transitions and loads are not snaps", () => {
    const normal = { reducedMotion: false };
    const at = (extent: number, policy: unknown = {}) =>
      snaps(
        [window("tab", { ...normal, changes: [{ ...swap, extent }] })],
        policy,
      ).candidates.length;
    expect(at(23)).toBe(0);
    expect(at(24)).toBe(1);
    expect(at(24, { minExtentPx: 40 })).toBe(0);
    expect(
      snaps([
        window("tab", { ...normal, changes: [{ ...swap, textOnly: true }] }),
      ]).candidates,
    ).toEqual([]);
    expect(
      snaps([
        window("tab", {
          ...normal,
          changes: [{ ...swap, animations: [0] }],
          animations: [{ ...fade, target: "#panels" }],
        }),
      ]).candidates,
    ).toEqual([]);
    expect(
      snaps([
        window("tab", {
          ...normal,
          changes: [{ ...swap, animations: [0] }],
          animations: [{ ...fade, properties: ["background-color"] }],
        }),
      ]).candidates,
    ).toHaveLength(1);
    expect(
      snaps([
        window("tab", { ...normal, changes: [{ ...swap, progressive: true }] }),
      ]).candidates,
    ).toEqual([]);
    expect(
      snaps([window("tab", { ...normal, viewTransition: true })]).candidates,
    ).toEqual([]);
    expect(
      snaps([window("load", { ...normal, source: "load" })]).candidates,
    ).toEqual([]);
  });
  test("held-network replays neither establish snaps nor add action locations", () => {
    const held = {
      ...window("Activity", { reducedMotion: false }),
      source: "slow-replay" as const,
      held: {
        of: "probe-click" as const,
        delayMs: 1500,
        withinMs: 1000,
        dispatched: true,
        requests: [],
        releasedAt: 1500,
        indicator: null,
        indicators: [],
        firstChange: null,
        firstMainChange: null,
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
      },
    };
    expect(snaps([held]).candidates).toEqual([]);
    const result = snaps([
      window("Activity", { reducedMotion: true }),
      window("Activity", { reducedMotion: false, confirmation: true }),
      held,
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(params(result).actions).toHaveLength(1);
  });
  test("a reduce window alone is never judged and says so", () => {
    const result = snaps([window("tab", { reducedMotion: true })]);
    expect(result.candidates).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: "ran",
      reason: expect.stringContaining(
        "1 content change(s) seen only under prefers-reduced-motion: reduce were not judged",
      ),
    });
    // An unknown preference is treated as reduce.
    expect(snaps([window("tab")]).candidates).toEqual([]);
  });
  test("a normal-motion confirmation judges the reduce click and lists it once", () => {
    const result = snaps([
      window("Activity", { reducedMotion: true }),
      window("Activity", { reducedMotion: false, confirmation: true }),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      rule: "idiom:motion-snap",
      severity: "major",
      timeline: "probe-2",
      fingerprintHint: "motion-snap|content-swap|#panels",
      explanation:
        "Project panels content swaps with no transition under normal motion (1 action: Activity)",
    });
    expect(params(result).actions).toEqual([
      expect.objectContaining({ name: "Activity", timeline: "probe-1" }),
    ]);
    const cleared = snaps([
      window("Activity", { reducedMotion: true }),
      window("Activity", {
        reducedMotion: false,
        confirmation: true,
        changes: [{ ...swap, animations: [0] }],
        animations: [fade],
      }),
    ]);
    expect(cleared.candidates).toEqual([]);
    expect(cleared.coverage.reason ?? "").not.toContain("not judged");
  });
  test("twelve tabs and one confirmation make one finding with twelve locations", () => {
    const tabs = Array.from({ length: 12 }, (_, index) =>
      window(`Tab ${index + 1}`, { reducedMotion: true }),
    );
    tabs.splice(
      1,
      0,
      window("Tab 1", { reducedMotion: false, confirmation: true }),
    );
    const result = snaps(tabs);
    expect(result.candidates).toHaveLength(1);
    expect(params(result).actions).toHaveLength(12);
    expect(result.candidates[0]?.explanation).toContain(
      "(12 actions: Tab 1, Tab 2, Tab 3, …)",
    );
  });
  test("groups by kind and container across actions", () => {
    const expand: VisibleChange = {
      ...swap,
      kind: "expand-collapse",
      key: "expand-collapse|#panels",
    };
    const result = snaps([
      window("A", { reducedMotion: false, changes: [swap, expand] }),
      window("B", { reducedMotion: false, changes: [swap] }),
    ]);
    expect(result.candidates.map((c) => c.fingerprintHint)).toEqual([
      "motion-snap|content-swap|#panels",
      "motion-snap|expand-collapse|#panels",
    ]);
    expect(params(result).actions.map((a) => a.name)).toEqual(["A", "B"]);
    expect(result.candidates[1]?.fix).toContain("grid-template-rows");
    expect(result.candidates[0]?.fix).toContain("opacity");
  });
  test("a normal-motion capture judges every window directly", () => {
    const result = snaps(
      [window("A")],
      {},
      {
        version: 1,
        status: "ran",
        reducedMotion: false,
        actions: [],
      },
    );
    expect(result.candidates).toHaveLength(1);
  });
  test.each([
    [{}, 150],
    [{ maxMs: 400 }, 250],
    [{ durations: [120, 200] }, 120],
    [{ durations: [300] }, 300],
    [{ durations: [120, 200], maxMs: 250 }, 200],
  ])("fix duration for %j is %sms", (policy, ms) => {
    const config = checksConfigFrom(
      checksConfigSchema.parse({ motion: policy }),
    );
    expect(snapDuration(config.motion)).toBe(ms);
    const result = contentSnaps(
      tupleFor(emptyObservation),
      [window("A", { reducedMotion: false })],
      config,
    );
    expect(result.candidates[0]?.fix).toContain(`${ms}ms ease-out`);
  });
  test("unavailable only when neither motion nor timeline evidence exists", () => {
    expect(snaps([window("A", { reducedMotion: false })]).coverage.status).toBe(
      "ran",
    );
    expect(check(undefined).coverage.status).toBe("unavailable");
    const old = snaps([{ ...window("A"), visibleChanges: undefined }]);
    expect(old.coverage.status).toBe("unavailable");
  });
  test("overlay snaps are major while duration findings stay minor", () => {
    const slow = check(
      artifact([
        {
          ...change,
          animated: true,
          effects: [{ ...effect, durationMs: 400 }],
        },
      ]),
    );
    expect(slow.candidates.map((c) => [c.rule, c.severity])).toEqual([
      ["idiom:motion-duration", "minor"],
    ]);
  });
});
