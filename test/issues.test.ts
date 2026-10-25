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

test("ranking uses worst severity, places union, primary action and stable input order", () => {
  const groups = [
    ...rows(),
    group("broad", {
      coordinates: Array.from({ length: 12 }, (_, i) => `state${i}/desktop`),
    }),
    group("primary", { coordinates: ["a", "b", "c", "d"] }),
    group("major", { severity: "major" }),
  ];
  expect(
    collapseIssues(groups, new Set(["#primary"])).map((issue) => issue.id),
  ).toEqual(["major", "broad", "primary", "row-0"]);
  // Do not erase digits in classes: these two unrelated controls stay separate.
  const ties = [
    group("first", { selector: ".a1" }),
    group("second", { selector: ".a2" }),
  ];
  expect(collapseIssues(ties, new Set()).map((issue) => issue.id)).toEqual([
    "first",
    "second",
  ]);
  expect(
    collapseIssues(
      [
        group("worse", { selector: "li:nth-child(1)", severity: "major" }),
        group("other", { selector: "li:nth-child(2)" }),
      ],
      new Set(),
    )[0]?.severity,
  ).toBe("major");
});

test("equal severity, places and primary action preserve order regardless of sibling count", () => {
  const singleton = group("singleton", {
    coordinates: rows()[0]?.coordinates ?? [],
  });
  for (const groups of [
    [singleton, ...rows()],
    [...rows(), singleton],
  ]) {
    expect(collapseIssues(groups, new Set()).map((issue) => issue.id)).toEqual(
      groups[0]?.id === "singleton"
        ? ["singleton", "row-0"]
        : ["row-0", "singleton"],
    );
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
