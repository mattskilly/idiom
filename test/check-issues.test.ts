import { expect, test } from "vitest";
import { run as runCli } from "../src/cli.js";
import {
  type CheckGroup,
  type CheckSummary,
  renderCheckSummary,
} from "../src/commands/check.js";
import { collapseIssues } from "../src/review/issues.js";

function summary(): CheckSummary {
  const groups: CheckGroup[] = Array.from({ length: 8 }, (_, index) => ({
    id: `group-${index}`,
    category: index < 6 ? "target-size" : "control-anatomy",
    rule: `size-${index}`,
    severity: "minor",
    selector: `.element-${index}`,
    where: "editor/mobile",
    problem: `Problem ${index}`,
    fix: ["Make bigger"],
    members: [
      {
        id: `finding-${index}`,
        severity: "minor",
        where: "editor/mobile",
        coordinates: ["editor/mobile"],
      },
    ],
    coordinates: ["editor/mobile"],
    states: ["editor"],
    viewports: ["mobile"],
    colorSchemes: [],
  }));
  return {
    flow: "example",
    runDirectory: "reports/run",
    reportPath: "reports/run/report.md",
    groups,
    issues: collapseIssues(groups, new Set()),
    blocking: 0,
    findings: groups.map((group) => ({
      id: group.members[0]?.id ?? "",
      severity: group.severity,
      category: group.category,
      where: group.where,
      problem: group.problem,
      fix: group.fix,
    })),
  };
}
const items = (text: string) => text.match(/^\d+\. /gm) ?? [];

test("default text lists Top 5 with remaining category counts and flow-specific hint", () => {
  const text = renderCheckSummary(summary());
  expect(text).toContain("Top issues (5 of 8)");
  expect(items(text)).toHaveLength(5);
  expect(text).toContain("Also found (3 more issue(s)):");
  expect(text).toContain("control-anatomy: 2 issue(s), 2 finding(s)");
  expect(text).toContain("target-size: 1 issue(s), 1 finding(s)");
  expect(text).toContain("List everything: idiom check example --all");
  expect(text.trimEnd().split("\n").at(-1)).toBe(
    "Full report: reports/run/report.md",
  );
});

test("--top limits the first section and --all numbers every issue", () => {
  expect(items(renderCheckSummary(summary(), { top: 2 }))).toHaveLength(2);
  const text = renderCheckSummary(summary(), { top: 2, all: true });
  expect(items(text)).toHaveLength(8);
  expect(text).toContain("8. [minor]");
  expect(text).not.toContain("List everything:");
  expect(renderCheckSummary(summary(), { top: 10 })).not.toContain(
    "Also found",
  );
});

test("collapsed issue shows one example and --all exposes each sibling's decision", () => {
  const result = summary();
  for (const [index, group] of (result.groups ?? []).entries()) {
    group.selector = `li:nth-child(${index + 1}) > button`;
    group.rule = "size";
  }
  result.issues = collapseIssues(result.groups ?? [], new Set());
  const text = renderCheckSummary(result);
  expect(text).toContain(
    "target-size family: 6 occurrences (6 findings in 1 places)",
  );
  expect(text.match(/ {3}Problem:/g)).toHaveLength(2);
  expect(text).toContain("Other groups: idiom check example --all lists them.");
  const all = renderCheckSummary(result, { all: true });
  expect(items(all)).toHaveLength(2);
  for (const group of result.groups ?? []) {
    expect(all).toContain(group.selector);
    expect(all).toContain(`--finding ${group.members[0]?.id}`);
  }
  expect(all).not.toContain("--all lists them");
});

test("ungrouped and baseline paths preserve their output and clean is byte-identical", () => {
  expect(renderCheckSummary(summary(), { ungrouped: true })).toContain(
    "Fix in this order:",
  );
  expect(
    items(renderCheckSummary(summary(), { ungrouped: true })),
  ).toHaveLength(8);
  const baseline = { ...summary(), preExisting: 3 };
  expect(renderCheckSummary(baseline)).toContain("Fix in this order:");
  expect(renderCheckSummary(baseline)).toContain("3 pre-existing finding(s)");
  expect(
    renderCheckSummary({ ...summary(), groups: [], findings: [], issues: [] }),
  ).toBe("idiom check example: clean — no open deterministic findings.\n");
});

test.each(["0", "x", "-1", "1.5", "Infinity"])(
  "--top %s is rejected before running checks",
  async (top) => {
    const stderr: string[] = [];
    expect(
      await runCli(
        ["node", "idiom", "check", "--all", "example", "--top", top],
        {
          stderr: (line) => stderr.push(line),
        },
      ),
    ).not.toBe(0);
    expect(stderr.join("\n")).toContain("positive integer");
  },
);

test("family heading uses worst severity while all occurrences keep their own rules", () => {
  const result = summary();
  const groups = (result.groups ?? []).slice(0, 2);
  const [first, second] = groups;
  if (!first || !second) throw new Error("two groups required");
  first.category = second.category = "adjacent-gap";
  first.rule = "idiom:adjacent-elements-touch";
  second.rule = "idiom:focus-ring-collision";
  second.severity = "major";
  // The minor occurrence wins on area while the family heading remains major.
  const context = new Map([
    [
      "editor/mobile",
      {
        state: "editor",
        viewport: { width: 100, height: 100 },
        elements: new Map([
          [
            first.selector ?? "",
            {
              selector: first.selector ?? "",
              tag: "button",
              visible: true,
              rect: { x: 0, y: 0, width: 100, height: 100 },
              ancestorSelectors: [],
            },
          ],
        ]),
        primaryRegions: new Set<string>(),
      },
    ],
  ]);
  result.groups = groups;
  result.issues = collapseIssues(groups, new Set(), context);
  expect(result.issues[0]).toMatchObject({
    id: first.id,
    severity: "major",
    rules: [first.rule, second.rule],
  });
  expect(result.issues[0]?.rule).toBeUndefined();
  const text = renderCheckSummary(result, { all: true });
  expect(text).toContain("1. [major] adjacent-gap");
  expect(text).toContain("adjacent-gap family: 2 occurrences");
  for (const g of groups) {
    expect(text).toContain(g.rule);
    expect(text).toContain(g.problem);
    expect(text).toContain(`--finding ${g.members[0]?.id}`);
  }
});

test("Top-N takes the severity-first prefix without dropping catalogue members or changing scores", () => {
  const result = summary();
  const groups = result.groups ?? [];
  const last = groups.at(-1);
  if (!last) throw new Error("missing group");
  last.severity = "major";
  const before = collapseIssues(
    groups.map((g) => ({ ...g, severity: "minor" })),
    new Set(),
  );
  result.issues = collapseIssues(groups, new Set());
  expect(result.issues[0]?.id).toBe(last.id);
  expect(result.issues.map((i) => [i.id, i.score]).sort()).toEqual(
    before.map((i) => [i.id, i.score]).sort(),
  );
  const text = renderCheckSummary(result, { top: 1 });
  expect(text).toContain("Top issues (1 of 8)");
  expect(text).toContain("1. [major]");
  expect(text).toContain("Problem 7");
  expect(text).not.toContain("Problem 0");
});
