import { expect, test } from "vitest";
import type { CheckTuple, ObservedElementV2 } from "../src/checks/types.js";
import {
  affectedCounts,
  buildIssueRankingContext,
  categorySalience,
  salienceFor,
  scoreGroup,
} from "../src/review/ranking.js";
import { findingCategories } from "../src/schemas/finding.js";

// Only the observation fields consumed by presentation scoring are relevant here.
const target = (
  overrides: Partial<ObservedElementV2> = {},
): ObservedElementV2 =>
  ({
    selector: "#target",
    tag: "button",
    visible: true,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    ancestorSelectors: [],
    ...overrides,
  }) as ObservedElementV2;
function captured(
  elements = [target()],
  overrides: Partial<CheckTuple> = {},
): CheckTuple {
  return {
    state: "editor",
    viewport: "desktop",
    observations: {
      version: 2,
      viewport: { width: 100, height: 100 },
      elements,
    },
    ...overrides,
  } as CheckTuple;
}
const group = {
  category: "dead-control",
  rule: "idiom:no-effect",
  selector: "#target",
  coordinates: ["editor/desktop"],
};
const counts = { states: 1, places: 1 };
const score = (tuple: CheckTuple) =>
  scoreGroup(group, counts, buildIssueRankingContext([tuple]));
const action = () =>
  target({
    signals: { paint: { primaryAction: true } } as ObservedElementV2["signals"],
  });

test("salience is exhaustive with explicit rule overrides and finite unknown fallbacks", () => {
  expect(Object.keys(categorySalience).sort()).toEqual(
    [...findingCategories].sort(),
  );
  for (const category of findingCategories)
    expect(salienceFor(category, "idiom:example")).toBe(
      categorySalience[category],
    );
  expect(salienceFor("dead-affordance", "idiom:placeholder-link")).toBe(4);
  for (const rule of [
    "idiom:input-value-truncated",
    "idiom:element-content-clipped",
  ])
    expect(salienceFor("overflow-clip", rule)).toBe(9);
  expect(salienceFor("disguised-control", "idiom:input-rejects-text")).toBe(9);
  expect(salienceFor("responsive-break", "idiom:interactive-overlap")).toBe(4);
  expect(salienceFor("unknown", "rule")).toBe(4);
  expect(salienceFor("dead-control")).toBe(4);
});

test("area, fold and primary-region/action inputs give the documented numeric example", () => {
  const ordinary = score(captured());
  expect(ordinary.prominence).toBeCloseTo(1.6);
  const primary = score(captured([action()]));
  expect(primary.prominence).toBeCloseTo(2.1);
  expect(primary.score).toBeCloseTo(18.9);
  expect(primary.explanation.areaRatio).toBeCloseTo(0.01);
  expect(primary.explanation).toMatchObject({
    aboveFold: true,
    primaryAction: true,
    geometryAvailable: true,
    coordinate: "editor/desktop",
  });
  expect(
    score(captured([target({ rect: { x: 0, y: 0, width: 20, height: 20 } })]))
      .prominence,
  ).toBeCloseTo(1.7);
  const clipped = score(
    captured([target({ rect: { x: -10, y: 0, width: 20, height: 10 } })]),
  );
  expect(clipped.explanation.areaRatio).toBeCloseTo(0.01);
  const scaled = captured([
    target({ rect: { x: 0, y: 0, width: 20, height: 20 } }),
  ]);
  if (scaled.observations)
    scaled.observations.viewport = { width: 200, height: 200 };
  expect(score(scaled).prominence).toBe(ordinary.prominence);
});

test("hidden, offscreen, zero-size and invalid geometry stays neutral and finite", () => {
  for (const element of [
    target({ visible: false }),
    target({ rect: { x: 0, y: 101, width: 10, height: 10 } }),
    target({ rect: { x: 0, y: 0, width: 0, height: 10 } }),
    target({ rect: { x: NaN, y: 0, width: 10, height: 10 } }),
  ]) {
    expect(score(captured([element])).prominence).toBe(1);
  }
  for (const width of [0, -1, NaN, Infinity]) {
    const tuple = captured([action()]);
    if (tuple.observations) tuple.observations.viewport.width = width;
    expect(score(tuple)).toMatchObject({
      prominence: 1,
      explanation: { geometryAvailable: false, primaryAction: false },
    });
  }
  const context = buildIssueRankingContext([captured()]);
  for (const selector of [
    undefined,
    "#missing",
    "#target, #other",
    "#target:nth-child(2)",
  ])
    expect(scoreGroup({ ...group, selector }, counts, context)).toMatchObject({
      prominence: 1,
      explanation: { geometryAvailable: false },
    });
  expect(scoreGroup(group, counts)).toMatchObject({ prominence: 1, score: 9 });
});

test("V1 geometry contributes without V2 signals", () => {
  const tuple = captured();
  if (tuple.observations)
    tuple.observations = { ...tuple.observations, version: 1 };
  expect(score(tuple)).toMatchObject({
    prominence: 1.6,
    explanation: {
      primaryAction: false,
      primaryRegion: false,
      geometryAvailable: true,
    },
  });
});

test("resolved region marks take precedence, then semantic main and exact ancestry", () => {
  const main = target({ selector: "main", tag: "main" });
  const region = target({ selector: "#region", tag: "section" });
  const child = target({ ancestorSelectors: ["main"] });
  const tuple = captured([main, region, child]);
  expect(score(tuple).explanation.primaryRegion).toBe(true);
  if (tuple.observations?.version !== 2) throw new Error("V2 required");
  tuple.observations.selectorMarks = [
    {
      purpose: "primary-region",
      selector: "#configured",
      matches: ["#region"],
    },
  ];
  expect(score(tuple).explanation.primaryRegion).toBe(false);
  child.ancestorSelectors = ["#region"];
  expect(score(tuple).explanation.primaryRegion).toBe(true);
  expect(
    scoreGroup(
      { ...group, selector: "#region" },
      counts,
      buildIssueRankingContext([tuple]),
    ).explanation.primaryRegion,
  ).toBe(true);
  tuple.observations.selectorMarks = [
    {
      purpose: "primary-region",
      selector: "#configured",
      matches: ["#unresolved"],
    },
  ];
  child.ancestorSelectors = ["main"];
  expect(score(tuple).explanation.primaryRegion).toBe(true);
  main.tag = "div";
  main.signals = { role: "main" } as ObservedElementV2["signals"];
  expect(score(tuple).explanation.primaryRegion).toBe(true);
  child.ancestorSelectors = ["main-other"];
  expect(score(tuple).explanation.primaryRegion).toBe(false);
});

test("coordinate-local primary actions cannot leak across states, schemes or combinations", () => {
  const context = buildIssueRankingContext([
    captured(),
    captured([action()], { state: "other" }),
    captured([action()], {
      colorSchemeAxis: true,
      colorScheme: "dark",
      combination: "variant",
    }),
  ]);
  expect(scoreGroup(group, counts, context)).toMatchObject({
    prominence: 1.6,
    primaryAction: false,
  });
  expect(
    scoreGroup({ ...group, coordinates: ["other/desktop"] }, counts, context)
      .prominence,
  ).toBeCloseTo(2.1);
  expect(
    scoreGroup(
      { ...group, coordinates: ["editor/desktop/dark#variant"] },
      counts,
      context,
    ).primaryAction,
  ).toBe(true);
  expect(
    scoreGroup(
      { ...group, coordinates: ["editor/desktop/light#variant"] },
      counts,
      context,
    ).prominence,
  ).toBe(1);
});

test("distinct states and places use bounded logarithms, never occurrence totals", () => {
  const coordinates = [
    "editor/desktop/light",
    "editor/desktop/dark",
    "editor/mobile/light",
    "editor/mobile/dark#variant",
  ];
  expect(affectedCounts([...coordinates, ...coordinates])).toEqual({
    states: 1,
    places: 4,
  });
  expect(scoreGroup(group, { states: 1, places: 4 }).prominence).toBeCloseTo(
    1 + 1 / 12,
  );
  expect(scoreGroup(group, { states: 2, places: 1 }).prominence).toBeCloseTo(
    1 + 1 / 12,
  );
  expect(scoreGroup(group, { states: 8, places: 64 }).prominence).toBe(1.5);
  const full = captured([action()]);
  const fullTarget = full.observations?.elements[0];
  if (!fullTarget) throw new Error("target required");
  fullTarget.rect = {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  };
  const hygiene = scoreGroup(
    { ...group, category: "target-size" },
    { states: 1024, places: 4096 },
    buildIssueRankingContext([full]),
  );
  expect(hygiene.prominence).toBe(3.5);
  expect(hygiene.score).toBeLessThan(scoreGroup(group, counts).score);
});
