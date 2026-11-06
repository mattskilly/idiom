import { expect, test } from "vitest";
import { checksConfigHash } from "../src/baseline/config-hash.js";
import type { ProbeResult } from "../src/checks/types.js";
import {
  type CheckSummary,
  renderCheckSummary,
} from "../src/commands/check.js";
import {
  computeProbeCoverage,
  probeCoverageLines,
} from "../src/coverage/probe.js";
import { capturePredicateIdentity } from "../src/findings/settings.js";
import {
  buildReviewCoverage,
  renderCoverageHtml,
  renderCoverageMarkdown,
} from "../src/report/coverage.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { fixtureCommand } from "./support/fixture-server.js";

const result = (
  name: string,
  overrides: Partial<ProbeResult> = {},
): ProbeResult => ({
  selector: `#${name}`,
  name,
  effects: [],
  persistent: false,
  ...overrides,
});

const notReached = (name: string, reason: string) =>
  result(name, { status: "not-reached", skipped: `not reached: ${reason}` });

function tuple(
  state: string,
  results: ProbeResult[],
  viewport = "desktop",
  colorScheme: "light" | "dark" = "light",
) {
  return {
    state,
    viewport,
    colorScheme,
    mismatches: [],
    observations: {
      version: 2,
      probe: { status: "ran", results },
    },
  } as unknown as Parameters<
    typeof computeProbeCoverage
  >[0]["tuples"][number] & {
    mismatches: [];
  };
}

/** Ten results: `unreached` of them not reached, the rest completed. */
const ten = (unreached: number) =>
  Array.from({ length: 10 }, (_, index) =>
    index < unreached
      ? notReached(`n${index}`, "flow budget share")
      : result(`c${index}`),
  );

const project = projectSchema.parse({
  version: 1,
  app: { name: "Fixture", framework: "other" },
  server: {
    build: "node -e 0",
    start: fixtureCommand("server.mjs"),
    readyUrl: "http://127.0.0.1:3000/",
    port: 3000,
    env: {},
  },
  viewports: [{ name: "desktop", width: 1000, height: 800 }],
  colorSchemes: ["light"],
  capture: {},
  design: {},
  model: { provider: "anthropic", model: "unused" },
});
const flow = flowSchema.parse({
  id: "editor",
  title: "Editor",
  setup: [],
  intent: [],
  states: [
    { id: "home", description: "Home", url: "/", expect: {} },
    { id: "menu", description: "Menu", url: "/menu", expect: {} },
  ],
});

test("each probe status is classified, and an absent status counts as completed", () => {
  const coverage = computeProbeCoverage({
    tuples: [
      tuple("home", [
        result("plain"),
        result("explicit", { status: "completed" }),
        result("delete", { skipped: "destructive name" }),
        result("slow", { status: "timed-out", timeoutScope: "control" }),
        result("cut", { status: "timed-out", timeoutScope: "state" }),
        notReached("late", "flow budget share"),
      ]),
    ],
    flowBudgetMs: 400000,
  });
  expect(coverage?.states).toEqual([
    {
      state: "home",
      viewport: "desktop",
      colorScheme: "light",
      status: "ran",
      completed: 2,
      skipped: 1,
      timedOut: 2,
      notReached: 1,
      topNotReached: { reason: "flow budget share", count: 1 },
    },
  ]);
  expect(coverage?.totals).toEqual({
    candidates: 6,
    completed: 2,
    skipped: 1,
    timedOut: 2,
    notReached: 1,
  });
});

test("the top not-reached reason groups variants and breaks ties alphabetically", () => {
  const coverage = computeProbeCoverage({
    tuples: [
      tuple("home", [
        notReached(
          "a",
          "not completed in any state that shows it (tried a, b)",
        ),
        notReached("b", "not completed in any state that shows it (tried c)"),
        notReached("c", "flow budget share"),
      ]),
      tuple("menu", [
        notReached("d", "nested-menu budget"),
        notReached("e", "checks.probe.maxControls"),
      ]),
    ],
  });
  expect(coverage?.states[0]?.topNotReached).toEqual({
    reason: "not completed in any state that shows it",
    count: 2,
  });
  expect(coverage?.states[1]?.topNotReached).toEqual({
    reason: "checks.probe.maxControls",
    count: 1,
  });
});

test("the warning fires strictly above 10% not reached", () => {
  expect(
    computeProbeCoverage({ tuples: [tuple("home", ten(1))] })?.warning,
  ).toBeUndefined();
  const over = computeProbeCoverage({
    tuples: [tuple("home", ten(2))],
    flowBudgetMs: 400000,
  });
  expect(over?.notReachedShare).toBeCloseTo(0.2);
  expect(over?.warning).toBe(
    "2 of 10 probe candidates (20%) were not reached within the 400s probe target. Raise checks.probe.flowBudgetMs or pass --probe-budget <ms> (0 = no target).",
  );
});

test("the target reads 400s, no target, or not recorded", () => {
  const header = (flowBudgetMs: number | undefined) => {
    const coverage = computeProbeCoverage({
      tuples: [tuple("home", ten(3))],
      flowBudgetMs,
    });
    if (!coverage) throw new Error("no coverage");
    return { ...probeCoverageLines(coverage), warning: coverage.warning };
  };
  expect(header(400000).header).toBe(
    "Probe coverage (target 400s): 7 completed, 0 timed out, 3 not reached of 10 candidates",
  );
  const none = header(0);
  expect(none.header).toContain("(no target)");
  expect(none.warning).toBe(
    "3 of 10 probe candidates (30%) were not reached with no flow target applied; the not-reached reasons name the limit that stopped them.",
  );
  const unrecorded = header(undefined);
  expect(unrecorded.header).toContain("(target not recorded)");
  expect(unrecorded.warning).toBe(
    "3 of 10 probe candidates (30%) were not reached. Raise checks.probe.flowBudgetMs or pass --probe-budget <ms> (0 = no target).",
  );
});

test("a state probed at several coordinates is labelled by viewport and scheme", () => {
  const coverage = computeProbeCoverage({
    tuples: [
      tuple("home", [result("a")], "desktop", "light"),
      tuple(
        "home",
        [result("a"), result("b", { skipped: "probe.skip" })],
        "mobile",
        "dark",
      ),
      tuple("menu", [notReached("x", "flow budget share")]),
    ],
  });
  if (!coverage) throw new Error("no coverage");
  expect(probeCoverageLines(coverage, { menu: "home → menu" }).states).toEqual([
    "home (desktop, light): 1 completed, 0 timed out, 0 not reached",
    "home (mobile, dark): 1 completed, 0 timed out, 0 not reached, 1 skipped",
    'home → menu: 0 completed, 0 timed out, 1 not reached — top not-reached reason: "flow budget share" (×1)',
  ]);
});

test("no probe evidence means no probe coverage", () => {
  expect(computeProbeCoverage({ tuples: [] })).toBeUndefined();
  expect(
    computeProbeCoverage({
      tuples: [
        {
          state: "home",
          viewport: "desktop",
          observations: { version: 2 },
        } as never,
      ],
    }),
  ).toBeUndefined();
});

test("reports and the check summary carry the probe section and warning", () => {
  const coverage = buildReviewCoverage({
    flow,
    project,
    tuples: [tuple("home", ten(4)), tuple("menu", ten(0))],
    commit: "abc",
  });
  expect(coverage.probeCoverage?.totals.notReached).toBe(4);
  const markdown = renderCoverageMarkdown(coverage);
  expect(markdown).toContain("### Interaction probe");
  expect(markdown).toContain(
    "- home: 6 completed, 0 timed out, 4 not reached — top not-reached reason:",
  );
  expect(markdown).toContain("**Warning:** 4 of 20 probe candidates (20%)");
  expect(markdown.indexOf("### Interaction probe")).toBeLessThan(
    markdown.indexOf("Limitations:"),
  );
  const html = renderCoverageHtml(coverage);
  expect(html).toContain("<h3>Interaction probe</h3>");
  expect(html).toContain(
    "<li>menu: 10 completed, 0 timed out, 0 not reached</li>",
  );
  expect(html).toContain(
    "<p><strong>Warning:</strong> 4 of 20 probe candidates (20%)",
  );
  const summary = {
    flow: "editor",
    reportPath: "/tmp/report.md",
    findings: [],
    blocking: 0,
    coverage,
  } as unknown as CheckSummary;
  const lines = renderCheckSummary(summary).trimEnd().split("\n");
  const header = lines.findIndex((line) => line.startsWith("Probe coverage"));
  expect(lines.slice(header)).toEqual([
    "Probe coverage (target not recorded): 16 completed, 0 timed out, 4 not reached of 20 candidates",
    '  home: 6 completed, 0 timed out, 4 not reached — top not-reached reason: "flow budget share" (×4)',
    "  menu: 10 completed, 0 timed out, 0 not reached",
    "Warning: 4 of 20 probe candidates (20%) were not reached. Raise checks.probe.flowBudgetMs or pass --probe-budget <ms> (0 = no target).",
  ]);
});

test("without a warning the summary shows counts only, and reports stay unchanged without probe evidence", () => {
  const quiet = buildReviewCoverage({
    flow,
    project,
    tuples: [tuple("home", ten(1))],
    commit: "abc",
  });
  expect(quiet.probeCoverage?.warning).toBeUndefined();
  expect(renderCoverageMarkdown(quiet)).not.toContain("**Warning:**");
  const plain = buildReviewCoverage({
    flow,
    project,
    tuples: [],
    commit: "abc",
  });
  expect(plain.probeCoverage).toBeUndefined();
  expect(renderCoverageMarkdown(plain)).not.toContain("Interaction probe");
  expect(renderCoverageHtml(plain)).not.toContain("Interaction probe");
});

test("quick review keeps its own Interaction section instead", () => {
  const coverage = buildReviewCoverage({
    flow,
    project,
    tuples: [tuple("home", ten(4))],
    commit: "abc",
    interaction: { status: "off" },
  });
  expect(coverage.probeCoverage).toBeUndefined();
  expect(renderCoverageMarkdown(coverage)).not.toContain(
    "### Interaction probe",
  );
});

test("the flow target never changes captured-settings identity or the default checks hash", () => {
  expect("flowBudgetMs" in project.checks.probe).toBe(false);
  const raised = projectSchema.parse({
    ...project,
    checks: {
      ...project.checks,
      probe: { ...project.checks.probe, flowBudgetMs: 0 },
    },
  });
  expect(raised.checks.probe.flowBudgetMs).toBe(0);
  expect(capturePredicateIdentity(raised, flow)).toBe(
    capturePredicateIdentity(project, flow),
  );
  // A project that never set the key hashes exactly as it did before.
  const { flowBudgetMs: _unset, ...probe } = raised.checks.probe;
  expect(checksConfigHash({ ...project.checks, probe })).toBe(
    checksConfigHash(project.checks),
  );
  for (const value of [-1, 1.5, "400000"])
    expect(
      projectSchema.safeParse({
        ...project,
        checks: { probe: { flowBudgetMs: value } },
      }).success,
    ).toBe(false);
});
