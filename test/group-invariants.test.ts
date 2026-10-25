import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { groupInvariantsCheck } from "../src/checks/group-invariants.js";
import { layoutInvariantsCheck } from "../src/checks/layout-invariants.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { CheckTuple, InvariantObservation } from "../src/checks/types.js";
import {
  groupValue,
  type InvariantInput,
  invariantSchema,
} from "../src/schemas/invariant.js";
import {
  groupEvidence,
  invariantObservations,
  invariantTuple,
} from "./invariant-support.js";

const run = (tuple: CheckTuple) =>
  groupInvariantsCheck.run({
    tuple,
    narrowViewport: false,
    config: checksConfigFrom(),
  });
const evaluate = (...evidence: InvariantObservation[]) =>
  run(invariantTuple(invariantObservations(evidence)));

const switcher: InvariantInput = {
  name: "page switcher",
  group: ".page-switcher",
  items: ".page-link",
  attribute: "data-project-id",
};
const ridgeline: Array<[string, string | null]> = [
  ["Home", "ridgeline"],
  ["Menu", "ridgeline"],
  ["Locations", "ridgeline"],
];

test("a clean list passes and an empty list passes", () => {
  expect(
    evaluate(
      groupEvidence(switcher, [{ owner: "ridgeline", items: ridgeline }]),
    ),
  ).toEqual({
    coverage: { check: "group-invariants", status: "ran" },
    candidates: [],
  });
  expect(
    evaluate(groupEvidence(switcher, [{ owner: "ridgeline", items: [] }]))
      .candidates,
  ).toEqual([]);
});

test("strays are named with their values; a missing attribute is a stray", () => {
  const { candidates } = evaluate(
    groupEvidence(switcher, [
      {
        owner: "ridgeline",
        items: [
          ...ridgeline,
          ["HVAC tune-up", "hvac"],
          ["Apex Financial overview", "apex"],
          ["Dental tests", null],
        ],
      },
    ]),
  );
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.explanation).toBe(
    'page switcher: 3 items in .page-switcher:nth-of-type(1) do not share data-project-id "ridgeline": "HVAC tune-up" (hvac), "Apex Financial overview" (apex), "Dental tests" (no value)',
  );
  expect(candidates[0]?.selectorHint).toBe(".page-switcher:nth-of-type(1)");
  expect(candidates[0]?.severity).toBe("major");
  expect(candidates[0]?.acceptance[0]).toContain(
    'move or remove: "HVAC tune-up", "Apex Financial overview", "Dental tests"',
  );
});

test("long stray lists are capped at ten labels", () => {
  const items = Array.from({ length: 12 }, (_, index): [string, string] => [
    `Page ${index}`,
    "other",
  ]);
  const { candidates } = evaluate(
    groupEvidence(switcher, [{ owner: "ridgeline", items }]),
  );
  expect(candidates[0]?.explanation).toContain("12 items");
  expect(candidates[0]?.explanation).toContain("and 2 more");
  expect(candidates[0]?.explanation).not.toContain("Page 10");
});

test("text mode compares capture group 1, or the whole match without groups", () => {
  const grouped: InvariantInput = {
    group: ".page-switcher",
    items: "a",
    owner: ".project-title",
    text: "^(\\S+)",
  };
  expect(
    evaluate(
      groupEvidence(grouped, [
        {
          owner: "Ridgeline Coffee",
          items: [
            ["Ridgeline home", "Ridgeline home"],
            ["HVAC tune-up", "HVAC tune-up"],
            ["(untitled)", "   "],
          ],
        },
      ]),
    ).candidates[0]?.explanation,
  ).toBe(
    'group .page-switcher › a by text /^(\\S+)/ (flow studio #1): 2 items in .page-switcher:nth-of-type(1) do not share text /^(\\S+)/ "Ridgeline": "HVAC tune-up" (HVAC), "(untitled)" (no value)',
  );
  const whole = invariantSchema.parse({
    group: ".g",
    items: "a",
    text: "ridge\\w+",
  });
  if (!("group" in whole)) throw new Error("expected group");
  expect(groupValue(whole, "the ridgeline shop")).toBe("ridgeline");
  expect(groupValue(whole, "hvac")).toBeNull();
  expect(groupValue(whole, null)).toBeNull();
});

test("owner selector: one is used, none is missing, many is ambiguous", () => {
  const owned: InvariantInput = { ...switcher, owner: ".project" };
  expect(
    evaluate(groupEvidence(owned, [{ owner: "ridgeline", items: ridgeline }]))
      .candidates,
  ).toEqual([]);
  const missing = evaluate(
    groupEvidence(owned, [{ owner: null, items: [] }], 0),
  ).candidates;
  expect(missing.map(({ rule }) => rule.split(":")[2])).toEqual([
    "missing-selector",
  ]);
  expect(missing[0]?.explanation).toContain(
    "required selector matched no elements: .project",
  );
  expect(
    evaluate(
      groupEvidence(
        { ...owned, optional: true },
        [{ owner: null, items: [] }],
        0,
      ),
    ).candidates,
  ).toEqual([]);
  const ambiguous = evaluate(
    groupEvidence(owned, [{ owner: null, items: ridgeline }], 2),
  ).candidates;
  expect(ambiguous.map(({ explanation }) => explanation)).toEqual([
    "page switcher: owner .project matched 2 elements (expected exactly one)",
  ]);
});

test("missing lists are reported unless optional", () => {
  expect(evaluate(groupEvidence(switcher, [])).candidates[0]?.explanation).toBe(
    "page switcher: required selector matched no elements: .page-switcher",
  );
  expect(
    evaluate(groupEvidence({ ...switcher, optional: true }, [])).candidates,
  ).toEqual([]);
});

test("an owner without a value is its own finding, not a pass", () => {
  const { candidates } = evaluate(
    groupEvidence(switcher, [{ owner: { value: null }, items: ridgeline }]),
  );
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.rule).toMatch(/^idiom:group-invariants:owner-value:/);
  expect(candidates[0]?.explanation).toBe(
    "page switcher: owner .page-switcher:nth-of-type(1) has no data-project-id, so membership of .page-switcher:nth-of-type(1) cannot be judged",
  );
});

test("each list is judged independently under one rule", () => {
  const { candidates } = evaluate(
    groupEvidence(switcher, [
      { owner: "ridgeline", items: [...ridgeline, ["HVAC", "hvac"]] },
      {
        owner: "hvac",
        items: [
          ["HVAC", "hvac"],
          ["Menu", "ridgeline"],
        ],
      },
      { owner: "apex", items: [["Apex", "apex"]] },
    ]),
  );
  expect(candidates).toHaveLength(2);
  expect(new Set(candidates.map(({ selectorHint }) => selectorHint)).size).toBe(
    2,
  );
  expect(new Set(candidates.map(({ rule }) => rule)).size).toBe(1);
});

test("identity is stable when item order changes", () => {
  const items: Array<[string, string]> = [
    ["HVAC", "hvac"],
    ["Home", "ridgeline"],
    ["Apex", "apex"],
  ];
  const first = evaluate(
    groupEvidence(switcher, [{ owner: "ridgeline", items }]),
  );
  const second = evaluate(
    groupEvidence(switcher, [
      { owner: "ridgeline", items: [...items].reverse() },
    ]),
  );
  expect(second.candidates[0]?.rule).toBe(first.candidates[0]?.rule);
});

test("legacy observations are unavailable and layout invariants ignore groups", () => {
  const legacy = run(invariantTuple());
  expect(legacy.coverage.status).toBe("unavailable");
  expect(legacy.coverage.reason).toContain("recapture");
  const tuple = invariantTuple(
    invariantObservations([
      groupEvidence(switcher, [
        { owner: "ridgeline", items: [["HVAC", "hvac"]] },
      ]),
    ]),
  );
  expect(
    layoutInvariantsCheck.run({
      tuple,
      narrowViewport: false,
      config: checksConfigFrom(),
    }).candidates,
  ).toEqual([]);
});

test("artifact schema requires group evidence exactly on group declarations", () => {
  const group = groupEvidence(switcher, [
    { owner: "ridgeline", items: ridgeline },
  ]);
  const parsed = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(invariantObservations([group]))),
  );
  expect(parsed.version === 2 && parsed.invariants?.[0]?.groups).toEqual(
    group.groups,
  );
  const { groups: _omitted, ...withoutGroups } = group;
  expect(
    observationArtifactSchema.safeParse(invariantObservations([withoutGroups]))
      .success,
  ).toBe(false);
  const [layout] = invariantObservations([group]).invariants ?? [];
  if (layout === undefined) throw new Error("expected evidence");
  const sized = {
    declaration: invariantSchema.parse({ selector: ".x", height: 10 }),
    origin: layout.origin,
    selectors: [{ selector: ".x", matches: [] }],
    groups: [],
  };
  expect(
    observationArtifactSchema.safeParse(invariantObservations([sized])).success,
  ).toBe(false);
});
