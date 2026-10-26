import { expect, test } from "vitest";
import {
  categoryCounts,
  collapseIssues,
  siblingPattern,
} from "../src/review/issues.js";

type Group = Parameters<typeof collapseIssues>[0][number];
const group = (id: string, overrides: Partial<Group> = {}): Group => ({
  id,
  category: "target-size",
  rule: "minimum",
  severity: "minor",
  selector: `#${id}`,
  coordinates: ["editor/desktop"],
  members: [id],
  ...overrides,
});
const rows = () =>
  Array.from({ length: 40 }, (_, index) =>
    group(`row-${index}`, {
      selector: `ul > li:nth-of-type(${index + 1}) > button`,
      coordinates: [
        "editor/desktop/light",
        "editor/mobile/light",
        "editor/desktop/dark",
        "editor/mobile/dark",
      ],
      members: ["light", "dark"],
    }),
  );

test("sibling patterns erase positions and token digits while preserving tags and classes", () => {
  expect(
    siblingPattern('li:nth-of-type(12) > button#row-42[data-testid="row-3"]'),
  ).toBe('li:nth-of-type(#) > button#row-#[data-testid="row-#"]');
  expect(siblingPattern("li:nth-child(23)[data-id='row-42']")).toBe(
    "li:nth-child(#)[data-id='row-#']",
  );
  expect(siblingPattern("h1.size-12.b.a")).toBe("h1.a.b.size-12");
  expect(siblingPattern("h1")).not.toBe(siblingPattern("h2"));
  expect(siblingPattern("button.css-abcdef12")).toBe("button");
  expect(siblingPattern('[data-v2=123][href="#a2"]')).toBe(
    '[data-v2=123][href="#a#"]',
  );
});

test("40 siblings collapse by rule with unioned places and summed members", () => {
  const groups = rows();
  const [issue] = collapseIssues(groups, new Set([groups[39]?.selector ?? ""]));
  expect(issue).toMatchObject({
    id: "row-0",
    elements: 40,
    places: 4,
    findings: 80,
    primaryAction: true,
    groups: groups.map((g) => g.id),
  });
  expect(
    collapseIssues(
      [
        ...groups,
        group("different-rule", {
          selector: groups[0]?.selector,
          rule: "other",
        }),
      ],
      new Set(),
    ),
  ).toHaveLength(2);
});

test("score precedes severity, severity breaks score ties, then original bucket order", () => {
  const groups = [
    group("hygiene", {
      severity: "blocker",
      coordinates: Array.from({ length: 100 }, (_, i) => `state${i}/desktop`),
    }),
    group("broken", { category: "dead-control" }),
    group("equal-first", { category: "error-text" }),
    group("equal-major", { category: "clipped-text", severity: "major" }),
  ];
  expect(collapseIssues(groups, new Set()).map((issue) => issue.id)).toEqual([
    "equal-major",
    "broken",
    "equal-first",
    "hygiene",
  ]);
});

test("unrelated selectors share an exact rule family; categories and rules stay separate", () => {
  const groups = [
    group("one", { selector: ".a1" }),
    group("two", { selector: ".a2" }),
    group("other", { rule: "other" }),
    group("category", { category: "control-anatomy" }),
  ];
  const issues = collapseIssues(groups, new Set());
  expect(issues.map((issue) => issue.groups)).toEqual([
    ["one", "two"],
    ["other"],
    ["category"],
  ]);
  expect(issues.flatMap((issue) => issue.groups).sort()).toEqual(
    groups.map((g) => g.id).sort(),
  );
});

test("two explicit cross-rule families aggregate without claiming one exact rule", () => {
  const groups = [
    group("touch", {
      category: "adjacent-gap",
      rule: "idiom:adjacent-elements-touch",
    }),
    group("focus", {
      category: "adjacent-gap",
      rule: "idiom:focus-ring-collision",
    }),
    group("input", {
      category: "overflow-clip",
      rule: "idiom:input-value-truncated",
    }),
    group("content", {
      category: "overflow-clip",
      rule: "idiom:element-content-clipped",
    }),
    group("document", {
      category: "overflow-clip",
      rule: "idiom:document-overflow",
    }),
  ];
  const issues = collapseIssues(groups, new Set());
  expect(issues.map((issue) => issue.groups)).toEqual([
    ["input", "content"],
    ["touch", "focus"],
    ["document"],
  ]);
  expect(issues[0]?.rule).toBeUndefined();
  expect(issues[0]?.rules).toEqual([
    "idiom:input-value-truncated",
    "idiom:element-content-clipped",
  ]);
});

test("sibling count cannot inflate area or counts and unknown/missing-rule fallback stays separate", () => {
  const singleton = group("singleton", {
    coordinates: rows()[0]?.coordinates ?? [],
    rule: "other",
  });
  const issues = collapseIssues([singleton, ...rows()], new Set());
  expect(issues.map((issue) => issue.id)).toEqual(["singleton", "row-0"]);
  expect(issues[0]?.score).toBe(issues[1]?.score);
  for (const overrides of [{ category: "unknown" }, { rule: undefined }]) {
    expect(
      collapseIssues(
        [
          group("one", { selector: ".a1", ...overrides }),
          group("two", { selector: ".a2", ...overrides }),
        ],
        new Set(),
      ),
    ).toHaveLength(2);
    expect(
      collapseIssues(
        [
          group("one", { selector: "#a1", ...overrides }),
          group("two", { selector: "#a2", ...overrides }),
        ],
        new Set(),
      ),
    ).toHaveLength(1);
  }
});

test("selectorless groups stay independent and deferred means every group is deferred", () => {
  const groups = [
    group("one", { selector: undefined, deferred: true }),
    group("two", { selector: undefined }),
  ];
  expect(collapseIssues(groups, new Set())).toHaveLength(2);
  const deferred = rows().map((g) => ({ ...g, deferred: true as const }));
  expect(collapseIssues(deferred, new Set())[0]?.deferred).toBe(true);
  expect(
    collapseIssues(
      [
        ...deferred,
        group("live", { selector: "ul > li:nth-of-type(99) > button" }),
      ],
      new Set(),
    )[0]?.deferred,
  ).toBeUndefined();
});

test("category counts sum every member and sort by finding count then category", () => {
  const groups = [
    ...rows(),
    group("a", { category: "alpha" }),
    group("b", { category: "beta" }),
  ];
  expect(
    categoryCounts(
      collapseIssues(groups, new Set()),
      new Map(groups.map((g) => [g.id, g])),
    ),
  ).toEqual([
    { category: "target-size", issues: 1, findings: 80 },
    { category: "alpha", issues: 1, findings: 1 },
    { category: "beta", issues: 1, findings: 1 },
  ]);
});

test("most prominent group becomes the example without losing metadata or leaking a primary signal", () => {
  const groups = [
    group("small", { deferred: true }),
    group("large", { deferred: true }),
    group("middle"),
  ];
  const elements = groups.map((g, i) => ({
    selector: g.selector ?? "",
    tag: "button",
    visible: true,
    rect: { x: 0, y: 0, width: [10, 100, 50][i] ?? 0, height: 100 },
    ancestorSelectors: [],
  }));
  const context = new Map([
    [
      "editor/desktop",
      {
        state: "editor",
        viewport: { width: 100, height: 100 },
        elements: new Map(elements.map((e) => [e.selector, e])),
        primaryRegions: new Set<string>(),
      },
    ],
  ]);
  const [issue] = collapseIssues(groups, new Set(["#small"]), context);
  expect(issue).toMatchObject({
    id: "large",
    groups: ["large", "small", "middle"],
    prominence: 2.5,
    salience: 1,
    score: 2.5,
    primaryAction: false,
  });
  expect(issue?.deferred).toBeUndefined();
  expect(groups[0]?.deferred).toBe(true);
});

test("different saliences never borrow each other's geometry or combine rule families", () => {
  const groups = [
    group("broken", {
      category: "dead-affordance",
      rule: "idiom:disabled-link-button",
    }),
    group("placeholder", {
      category: "dead-affordance",
      rule: "idiom:placeholder-link",
    }),
  ];
  const element = {
    selector: "#placeholder",
    tag: "button",
    visible: true,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    ancestorSelectors: [],
  };
  const context = new Map([
    [
      "editor/desktop",
      {
        state: "editor",
        viewport: { width: 100, height: 100 },
        elements: new Map([[element.selector, element]]),
        primaryRegions: new Set<string>(),
      },
    ],
  ]);
  const issues = collapseIssues(groups, new Set(), context);
  expect(
    issues.map((issue) => [
      issue.id,
      issue.salience,
      issue.prominence,
      issue.score,
    ]),
  ).toEqual([
    ["placeholder", 4, 2.5, 10],
    ["broken", 9, 1, 9],
  ]);
});
