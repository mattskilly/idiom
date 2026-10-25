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
    rule: "size",
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
  for (const [index, group] of (result.groups ?? []).entries())
    group.selector = `li:nth-child(${index + 1}) > button`;
  result.issues = collapseIssues(result.groups ?? [], new Set());
  const text = renderCheckSummary(result);
  expect(text).toContain(
    "Repeated on 6 similar elements (6 findings in 1 places)",
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
