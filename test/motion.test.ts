import { describe, expect, test } from "vitest";
import {
  motionArtifactSchema,
  observationArtifactSchema,
} from "../src/checks/artifact-schema.js";
import { motionCheck } from "../src/checks/motion.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  MotionArtifact,
  MotionChange,
  MotionEffect,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

import { emptyObservation, required, tupleFor } from "./motion-support.js";

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
  test("snap is minor only in a complete normal window, with stable identity", () => {
    const normal = check(artifact());
    expect(normal.candidates[0]).toMatchObject({
      rule: "idiom:motion-no-transition",
      severity: "minor",
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
