import { describe, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { layoutInvariantsCheck } from "../src/checks/layout-invariants.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { CheckTuple, Rect } from "../src/checks/types.js";
import { findingFingerprint } from "../src/review/fingerprint.js";
import type { InvariantInput } from "../src/schemas/invariant.js";
import {
  invariantEvidence,
  invariantObservations,
  invariantTuple,
} from "./invariant-support.js";

const run = (tuple: CheckTuple) =>
  layoutInvariantsCheck.run({
    tuple,
    narrowViewport: false,
    config: checksConfigFrom(),
  });
const evaluate = (
  inputs: InvariantInput[],
  boxes: Record<string, Array<Partial<Rect>>>,
) =>
  run(invariantTuple(invariantObservations(invariantEvidence(inputs, boxes))));

test("exact controls message and both dimension constraints", () => {
  const input = { name: "controls", selector: ".controls", height: 64 };
  expect(
    evaluate([input], { ".controls": [{ height: 64 }] }).candidates,
  ).toEqual([]);
  expect(
    evaluate([input], { ".controls": [{ height: 85 }] }).candidates[0]
      ?.explanation,
  ).toBe("controls height 85, expected 64");
  const result = evaluate([{ ...input, width: 400 }], {
    ".controls": [{ height: 85, width: 320 }],
  });
  expect(result.candidates).toHaveLength(2);
  expect(
    new Set(result.candidates.map((candidate) => candidate.rule)).size,
  ).toBe(2);
  expect(result.candidates[0]?.severity).toBe("major");
});

test("inclusive ranges, fractional tolerance and every dimension match", () => {
  const input = {
    selector: ".panel",
    width: { min: 280, max: 480 },
    tolerance: 0.25,
  };
  for (const width of [280, 480, 279.75, 480.25])
    expect(evaluate([input], { ".panel": [{ width }] }).candidates).toEqual([]);
  const result = evaluate([input], {
    ".panel": [{ width: 320 }, { width: 480.251 }, { width: 279.749 }],
  });
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates[0]?.explanation).toContain("480.251");
});

describe.each(["top", "right", "bottom", "left"] as const)(
  "%s alignment",
  (align) => {
    test("measures every match and all edges with exact tolerance", () => {
      const input = { align, selectors: [".a", ".b"], tolerance: 0.5 };
      const coordinate = align === "top" || align === "bottom" ? "y" : "x";
      const boxes = {
        ".a": [{}],
        ".b": [{ [coordinate]: coordinate === "y" ? 48.5 : 0.5 }],
      };
      expect(evaluate([input], boxes).candidates).toEqual([]);
      boxes[".b"].push({ [coordinate]: coordinate === "y" ? 48.501 : 0.501 });
      const candidates = evaluate([input], boxes).candidates;
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.explanation).toContain(`${align} edges differ: .a`);
      expect(candidates[0]?.explanation.match(/\.b [\d.-]+/g)).toHaveLength(2);
      expect(candidates[0]?.verification.params?.neighbour).toBe(
        ".b:nth-of-type(2)",
      );
    });
  },
);

test("offsets support signed values, pseudo-classes, same-element edges and tolerances", () => {
  const positive = {
    edge: ".canvas:not(.hidden):top",
    equals: ".controls:bottom",
    offset: 16,
    tolerance: 0.25,
  };
  expect(
    evaluate([positive], {
      ".canvas:not(.hidden)": [{ y: 128.25 }],
      ".controls": [{}],
    }).candidates,
  ).toEqual([]);
  const off = evaluate([positive], {
    ".canvas:not(.hidden)": [{ y: 128.251 }],
    ".controls": [{}],
  }).candidates;
  expect(off[0]?.explanation).toContain("offset 16.251, expected 16");
  expect(off[0]?.verification.params?.neighbour).toBe(
    ".controls:nth-of-type(1)",
  );
  expect(
    evaluate([{ edge: ".a:left", equals: ".a:right", offset: -320 }], {
      ".a": [{}],
    }).candidates,
  ).toEqual([]);
  expect(
    evaluate([{ edge: ".a:top", equals: ".a:bottom", offset: -64 }], {
      ".a": [{}],
    }).candidates,
  ).toEqual([]);
});

test("required missing selectors differ from mismatches; optional only skips absence", () => {
  const assertions: InvariantInput[] = [
    { selector: ".gone", height: 64 },
    { align: "bottom", selectors: [".a", ".gone"], optional: true },
    { selector: ".a", height: 80, optional: true },
  ];
  const result = evaluate(assertions, { ".a": [{}] });
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates[0]?.rule).toContain("missing-selector");
  expect(result.candidates[0]?.explanation).toContain(
    "matched no elements: .gone",
  );
  expect(result.candidates[1]?.explanation).toContain("height 64, expected 80");
  const missingBoth = evaluate(
    [{ align: "top", selectors: [".gone", ".also-gone"] }],
    {},
  );
  expect(missingBoth.candidates[0]?.explanation).toContain(".gone, .also-gone");
});

test("offset ambiguity never chooses an arbitrary element, even if optional", () => {
  const result = evaluate(
    [{ edge: ".a:top", equals: ".b:bottom", offset: 16, optional: true }],
    { ".a": [{}, {}], ".b": [{}] },
  );
  expect(result.candidates[0]?.rule).toContain("ambiguous-selector");
  expect(result.candidates[0]?.explanation).toContain(
    ".a matched 2 elements (expected exactly one)",
  );
});

test("coverage distinguishes legacy absence from explicit no assertions", () => {
  const tuple = invariantTuple();
  expect(run(tuple).coverage.status).toBe("unavailable");
  delete tuple.observations;
  expect(run(tuple).coverage.reason).toContain("recapture");
  const { maskMembership: _, ...legacy } = invariantObservations();
  tuple.observations = { ...legacy, version: 1 };
  expect(run(tuple).coverage.status).toBe("unavailable");
  expect(run(invariantTuple(invariantObservations([])))).toEqual({
    coverage: { check: "layout-invariants", status: "ran" },
    candidates: [],
  });
});

test("declaration identities distinguish expectations and survive reordering and new measurements", () => {
  const a = { selector: ".a", height: 64 };
  const b = { selector: ".a", height: 70 };
  const first = evaluate([a, b], { ".a": [{ height: 85 }] }).candidates.map(
    (candidate) => candidate.rule,
  );
  const second = evaluate([b, a], { ".a": [{ height: 90 }] }).candidates.map(
    (candidate) => candidate.rule,
  );
  expect(new Set(first).size).toBe(2);
  expect(first).toEqual(second.reverse());
  const align = (selectors: string[]) =>
    evaluate([{ align: "bottom", selectors }], {
      ".a": [{}],
      ".b": [{ height: 85 }],
    }).candidates[0]?.rule;
  expect(align([".a", ".b"])).toBe(align([".b", ".a"]));
  const evidence = invariantEvidence([a], { ".a": [{ height: 85 }] });
  const flowRule = run(invariantTuple(invariantObservations(evidence)))
    .candidates[0]?.rule;
  if (!evidence[0]) throw new Error("missing evidence");
  evidence[0].origin.scope = "state";
  expect(
    run(invariantTuple(invariantObservations(evidence))).candidates[0]?.rule,
  ).not.toBe(flowRule);
});

test("strict artifacts retain declarations and zero membership, rejecting corrupt geometry or membership", () => {
  const evidence = invariantEvidence([{ selector: ".a", height: 64 }]);
  const original = invariantObservations(evidence);
  expect(
    observationArtifactSchema.parse(JSON.parse(JSON.stringify(original))),
  ).toEqual(original);
  const legacy = observationArtifactSchema.parse(invariantObservations());
  expect(legacy.version === 2 && legacy.invariants === undefined).toBe(true);
  const wrong = structuredClone(original);
  if (!wrong.invariants?.[0]) throw new Error("missing evidence");
  wrong.invariants[0].selectors = [];
  expect(observationArtifactSchema.safeParse(wrong).success).toBe(false);
  for (const width of [NaN, Infinity, -1]) {
    const invalid = invariantObservations(
      invariantEvidence([{ selector: ".a", height: 64 }], {
        ".a": [{ width }],
      }),
    );
    expect(observationArtifactSchema.safeParse(invalid).success).toBe(false);
  }
});

test("optional relations still reject present mismatches", () => {
  expect(
    evaluate([{ align: "bottom", selectors: [".a", ".b"], optional: true }], {
      ".a": [{}],
      ".b": [{ height: 85 }],
    }).candidates,
  ).toHaveLength(1);
  expect(
    evaluate(
      [{ edge: ".a:top", equals: ".b:bottom", offset: 16, optional: true }],
      { ".a": [{}], ".b": [{}] },
    ).candidates,
  ).toHaveLength(1);
});

test("alignment fingerprints survive swapped extremes and selector declaration order", () => {
  const candidate = (selectors: string[], a: number, b: number) => {
    const result = evaluate([{ align: "bottom", selectors }], {
      ".a": [{ height: a }],
      ".b": [{ height: b }],
    }).candidates[0];
    if (!result) throw new Error("expected alignment finding");
    return findingFingerprint({
      category: result.category,
      rule: result.rule,
      selectorHint: result.selectorHint,
      flow: "studio",
      state: "editor",
    });
  };
  expect(candidate([".a", ".b"], 64, 85)).toBe(candidate([".b", ".a"], 85, 64));
});

test("missing alignment membership keeps its fingerprint when authored selectors reorder", () => {
  const candidate = (selectors: string[]) => {
    const result = evaluate([{ align: "bottom", selectors }], {}).candidates[0];
    if (!result) throw new Error("expected missing-selector finding");
    return findingFingerprint({
      category: result.category,
      rule: result.rule,
      selectorHint: result.selectorHint,
      flow: "studio",
      state: "editor",
    });
  };
  expect(candidate([".a", ".b"])).toBe(candidate([".b", ".a"]));
});
