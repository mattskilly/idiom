import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { spacingTargetCheck } from "../src/checks/spacing-target.js";
import type {
  CheckTuple,
  ObservationArtifactV2,
  SpacingTargetObservation,
} from "../src/checks/types.js";
import { spacingTargetSchema } from "../src/schemas/targets.js";
import { reviewStates } from "./benchmark-support.js";

function tuple(evidence?: SpacingTargetObservation[]): CheckTuple {
  const observation: ObservationArtifactV2 = {
    version: 2,
    viewport: { width: 400, height: 400 },
    document: {
      scrollWidth: 400,
      scrollHeight: 400,
      clientWidth: 400,
      clientHeight: 400,
    },
    elements: [],
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
    ...(evidence === undefined ? {} : { spacingTargets: evidence }),
  };
  return {
    flow: "test",
    state: "open",
    viewport: "desktop",
    width: 400,
    height: 400,
    metadataPath: "metadata.json",
    artifactPaths: [],
    commit: "abc",
    createdAt: "2026-11-06T00:00:00.000Z",
    observations: observation,
    console: [],
    mismatches: [],
  };
}

function compare(
  gap: number,
  axis: "vertical" | "horizontal",
  tolerance?: unknown,
  targetGap = 8,
) {
  const target = spacingTargetSchema.parse({
    between: ["#a", "#b"],
    gap: targetGap,
    axis,
    ...(tolerance === undefined ? {} : { tolerance }),
  });
  const first = { selector: "#a", x: 0, y: 0, width: 20, height: 20 };
  const second = {
    selector: "#b",
    x: 20 + gap,
    y: 20 + gap,
    width: 20,
    height: 20,
  };
  return spacingTargetCheck.run({
    tuple: tuple([
      { target, pairs: [{ first, second }], status: "measured", reasons: [] },
    ]),
    config: checksConfigFrom(),
    narrowViewport: false,
  });
}

describe.each(["vertical", "horizontal"] as const)(
  "%s target comparisons",
  (axis) => {
    test.each([
      { gap: 6, tolerance: { px: 2 }, fails: false },
      { gap: 10, tolerance: { px: 2 }, fails: false },
      { gap: 5.999, tolerance: { px: 2 }, fails: true },
      { gap: 10.001, tolerance: { px: 2 }, fails: true },
      { gap: 6, tolerance: { ratio: 0.25 }, fails: false },
      { gap: 10, tolerance: { ratio: 0.25 }, fails: false },
      { gap: 5.999, tolerance: { ratio: 0.25 }, fails: true },
      { gap: 10.001, tolerance: { ratio: 0.25 }, fails: true },
      { gap: 8, tolerance: { px: 0 }, fails: false },
      { gap: 8.001, tolerance: { px: 0 }, fails: true },
      { gap: 8.5, tolerance: { px: 0.5 }, fails: false },
      { gap: 7, fails: false },
      { gap: 9, fails: false },
      { gap: 9.001, fails: true },
      { gap: -2, fails: true },
      { gap: 10, tolerance: { ratio: 0.25, px: 1 }, fails: false },
      {
        gap: 10,
        tolerance: { ratio: 0.25, px: 1, mode: "tighter" },
        fails: true,
      },
    ])("inclusive raw tolerance %j", ({ gap, tolerance, fails }) => {
      const result = compare(gap, axis, tolerance);
      expect(result.candidates).toHaveLength(fails ? 1 : 0);
      if (fails)
        expect(result.candidates[0]).toMatchObject({
          rule: "idiom:spacing-target",
          severity: "major",
          selectorHint: "#b",
          verification: { params: { axis, target: 8 } },
        });
    });
    test("zero-gap ratio tolerance remains zero", () => {
      expect(compare(0, axis, { ratio: 0.5 }, 0).candidates).toEqual([]);
      expect(compare(0.01, axis, { ratio: 0.5 }, 0).candidates).toHaveLength(1);
    });
    test("identity is independent of measurements", () => {
      expect(compare(20, axis).candidates[0]?.fingerprintHint).toBe(
        compare(25, axis).candidates[0]?.fingerprintHint,
      );
    });
  },
);

test("historical missing evidence differs from a captured empty list", () => {
  const old = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(tuple().observations)),
  );
  expect(old).not.toHaveProperty("spacingTargets");
  expect(
    spacingTargetCheck.run({
      tuple: { ...tuple(), observations: old },
      config: checksConfigFrom(),
      narrowViewport: false,
    }).coverage,
  ).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("recapture"),
  });
  expect(
    spacingTargetCheck.run({
      tuple: tuple([]),
      config: checksConfigFrom(),
      narrowViewport: false,
    }).coverage.status,
  ).toBe("not-applicable");
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

test("capture records ordered boxes, partial coverage, visible direct children and offline intent", async () => {
  const html = await readFile(
    join(import.meta.dirname, "fixtures/spacing-target/targets.html"),
    "utf8",
  );
  const { tuples, findings } = await reviewStates(
    browser,
    [{ state: "opened", html }],
    {
      checks: {
        spacingTargets: [
          { between: ["#a", "#b"], gap: 8, tolerance: { px: 0 } },
          {
            between: ["#a", "#b"],
            gap: 8,
            axis: "horizontal",
            tolerance: { px: 0 },
          },
          { between: ["#a", "#subpixel"], gap: 8, tolerance: { px: 0.5 } },
          {
            between: ["#a", "#subpixel"],
            gap: 8,
            axis: "horizontal",
            tolerance: { px: 0 },
          },
          { between: ["#b", "#a"], gap: 0, tolerance: { px: 0 } },
          { within: ".group", gap: 8, tolerance: { px: 0 } },
          { between: ["#missing", "#a"], gap: 8 },
          { between: ["[", "#a"], gap: 8 },
          { between: [".box", "#b"], gap: 8 },
          { between: ["#hidden-child", "#a"], gap: 8 },
          { between: ["#b", "#offscreen"], gap: 1952, tolerance: { px: 0 } },
        ],
      },
    },
  );
  const captured = tuples[0];
  if (captured?.observations?.version !== 2) throw new Error("expected V2");
  const evidence = captured.observations.spacingTargets;
  expect(evidence?.slice(0, 3).map(({ status }) => status)).toEqual([
    "measured",
    "measured",
    "measured",
  ]);
  expect(evidence?.[2]?.pairs[0]?.second.y).toBe(28.5);
  expect(
    evidence?.[5]?.pairs.map(({ first, second }) => [
      first.selector,
      second.selector,
    ]),
  ).toEqual([
    ["#one", "#two"],
    ["#two", "#three"],
    ["#four", "#five"],
  ]);
  expect(evidence?.[5]?.reasons.join()).toContain(
    "fewer than two visible direct children",
  );
  expect(evidence?.[6]?.reasons.join()).toContain("0 visible matches");
  expect(evidence?.[7]?.reasons.join()).toContain("invalid CSS");
  expect(evidence?.[8]?.reasons.join()).toContain("ambiguous");
  expect(evidence?.[9]?.reasons.join()).toContain(
    "0 visible matches (1 total)",
  );
  expect(evidence?.[10]?.status).toBe("measured");
  const reported = findings.filter(
    ({ candidate }) => candidate.category === "spacing-target",
  );
  expect(reported).toHaveLength(5);
  expect(
    new Set(reported.map(({ candidate }) => candidate.fingerprintHint)).size,
  ).toBe(5);
  expect(
    reported.some(({ candidate }) => candidate.explanation.includes("-48px")),
  ).toBe(true);
  const persisted = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(captured.observations)),
  );
  expect(persisted).toEqual(captured.observations);
  const offline = runDeterministicChecks(
    [{ ...captured, observations: persisted }],
    undefined,
    checksConfigFrom({ spacingTargets: [] }),
  );
  expect(
    offline.candidates
      .filter(({ candidate }) => candidate.category === "spacing-target")
      .map(({ candidate }) => candidate),
  ).toEqual(reported.map(({ candidate }) => candidate));
  expect(
    spacingTargetCheck.run({
      tuple: { ...captured, observations: persisted },
      config: checksConfigFrom(),
      narrowViewport: false,
    }).coverage,
  ).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("ambiguous"),
  });
});
