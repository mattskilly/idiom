import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { describe, expect, test } from "vitest";
import type { CheckTuple, FindingCandidate } from "../src/checks/types.js";
import {
  buildDeterministicDrafts,
  finalizeFindings,
} from "../src/review/findings.js";
import {
  affectedCounts,
  buildIssueRankingContext,
  scoreGroup,
} from "../src/review/ranking.js";
import {
  type ExpectedIdentity,
  matchesExpected,
  mutationProgram,
  operators,
} from "./fixtures/mutations/catalog.js";
import {
  assertBaseline,
  type Capture,
  type CaseResult,
  capturePage,
  discoverPages,
  evaluateSeed,
  loadFixture,
  type MutationReport,
  matchingFingerprints,
  profileFor,
  type RecallBaseline,
  rankFindings,
  runMutationBench,
  summarize,
} from "./mutation-support.js";

const root = resolve(import.meta.dirname, "..");
const baseline = JSON.parse(
  await readFile(join(root, "test/fixtures/mutations/baseline.json"), "utf8"),
) as RecallBaseline;
const execute = promisify(execFile);
const tuple: CheckTuple = {
  flow: "fixture",
  state: "mutation",
  viewport: "desktop",
  width: 1000,
  height: 900,
  metadataPath: "mutation/metadata.json",
  artifactPaths: [],
  console: [],
  mismatches: [],
  commit: "fixture",
  createdAt: "2026-10-27T00:00:00.000Z",
};
const candidate = (
  overrides: Partial<FindingCandidate> = {},
): FindingCandidate => ({
  category: "clipped-text",
  rule: "idiom:text-clipped",
  selectorHint: "#seed",
  severity: "major",
  explanation: "Text is clipped",
  acceptance: ["All text is readable"],
  verification: { check: "clipped-text", params: { selector: "#seed" } },
  ...overrides,
});
function capture(
  candidates: FindingCandidate[],
  observedTuple: CheckTuple = tuple,
): Capture {
  const entries = candidates.map((candidate, checkOrder) => ({
    tuple: observedTuple,
    candidate,
    checkOrder,
  }));
  const drafts = buildDeterministicDrafts({ runId: "test", entries });
  return {
    tuples: [observedTuple],
    entries,
    drafts,
    findings: finalizeFindings({ runId: "test", drafts }),
    coverage: [],
    audits: [],
  };
}
const expected: ExpectedIdentity = {
  check: "clipped-text",
  rule: "idiom:text-clipped",
  selectors: ["#seed"],
};
const result = (
  id: string,
  rule: string,
  caught: boolean,
  rank: number | null,
): CaseResult => ({
  id,
  operator: id,
  page: "fixture.html",
  rule,
  caught,
  rank,
  expectedFindings: [],
  findingCount: 20,
  otherFindings: caught ? 19 : 20,
  status: "evaluated",
  diagnostic: "test",
});

describe("seed identity, ranking and measurement", () => {
  test("catalog covers all fourteen categories; discovery includes nested and suffixed after pages", async () => {
    expect(operators).toHaveLength(14);
    expect(new Set(operators.map((operator) => operator.id)).size).toBe(14);
    expect(new Set(operators.map((operator) => operator.category)).size).toBe(
      14,
    );
    expect(operators.map((operator) => operator.rule)).toEqual(
      expect.arrayContaining([
        "axe:color-contrast",
        "idiom:minimum-target-size",
        "idiom:off-scale-spacing",
        "idiom:off-scale-radius",
        "idiom:label-off-centre",
        "idiom:adjacent-elements-touch",
        "idiom:unexplained-control",
        "idiom:control-does-nothing",
        "idiom:retired-term",
        "idiom:layout-shift",
        "idiom:interaction-shift",
        "idiom:loading-state-missing",
        "idiom:motion-snap",
        "idiom:text-clipped",
      ]),
    );
    const pages = await discoverPages(root);
    expect(pages).toContain(
      "test/fixtures/benchmark/layout-shift-late-content/after.html",
    );
    expect(pages).toContain("test/fixtures/benchmark/scale-after.html");
    expect(pages.some((page) => page.endsWith("before.html"))).toBe(false);
    expect(pages).toEqual([...pages].sort());
  });

  test("full artifact covers every operator and retains real evidence for full-script-only rules", async () => {
    const full = JSON.parse(
      await readFile(join(root, "docs/field-test/recall.json"), "utf8"),
    ) as MutationReport;
    expect(full).toMatchObject({
      scope: "full-catalog",
      status: "complete",
      catalogErrors: [],
    });
    expect(
      [...new Set(full.cases.map((item) => item.operator))].sort(),
    ).toEqual(operators.map((operator) => operator.id).sort());
    expect(full.cases.length + full.skipped.length).toBe(
      (await discoverPages(root)).length * operators.length,
    );
    const held = full.cases.find((item) => item.operator === "missing-pending");
    expect(
      held?.evidence?.some(
        (evidence) =>
          evidence.probe?.heldReplay?.ran &&
          evidence.actions.some(
            (action) =>
              action.source === "slow-replay" &&
              action.held?.requests.some(
                (request) => request.path === "/api/items",
              ),
          ),
      ),
    ).toBe(true);
    const interaction = full.cases.find(
      (item) => item.operator === "unreserved-interaction",
    );
    expect(interaction?.mutation?.applications).toBeGreaterThan(1);
    expect(
      interaction?.evidence?.some((evidence) =>
        evidence.actions.some(
          (action) =>
            action.source === "probe-click" &&
            action.mutations.some(
              (mutation) => mutation.selector === 'div[role="status"]',
            ) &&
            action.shifts.length > 0,
        ),
      ),
    ).toBe(true);
  });

  test("same-rule noise, wrong aggregated property and wrong request/action cannot become catches", () => {
    expect(
      matchesExpected(
        candidate({
          selectorHint: "#noise",
          verification: {
            check: "clipped-text",
            params: { selector: "#noise" },
          },
        }),
        expected,
      ),
    ).toBe(false);
    const pair: ExpectedIdentity = {
      check: "adjacent-gap",
      rule: "idiom:adjacent-elements-touch",
      selectors: ["#first", "#second"],
    };
    const touching = candidate({
      category: "adjacent-gap",
      rule: pair.rule,
      selectorHint: "#first",
      verification: {
        check: "adjacent-gap",
        params: { selector: "#first", neighbour: "#unrelated" },
      },
    });
    expect(matchesExpected(touching, pair)).toBe(false);
    expect(
      matchesExpected(
        {
          ...touching,
          verification: {
            check: "adjacent-gap",
            params: { selector: "#second", neighbour: "#first" },
          },
        },
        pair,
      ),
    ).toBe(true);
    const spacing: ExpectedIdentity = {
      check: "scale-conformance",
      rule: "idiom:off-scale-spacing",
      selectors: ["#seed"],
      property: "spacing",
      value: "37px",
      targetProperty: "paddingLeft",
    };
    const scaled = candidate({
      category: "scale-conformance",
      rule: spacing.rule,
      verification: {
        check: "scale-conformance",
        params: {
          property: "spacing",
          value: "37px",
          targets: [{ selector: "#seed", property: "marginTop" }],
        },
      },
    });
    expect(matchesExpected(scaled, spacing)).toBe(false);
    expect(
      matchesExpected(
        {
          ...scaled,
          verification: {
            check: "scale-conformance",
            params: {
              ...scaled.verification.params,
              targets: [{ selector: "#seed", property: "paddingLeft" }],
            },
          },
        },
        spacing,
      ),
    ).toBe(true);
    expect(
      matchesExpected(
        {
          ...scaled,
          verification: {
            check: "scale-conformance",
            params: { ...scaled.verification.params, value: "38px" },
          },
        },
        spacing,
      ),
    ).toBe(false);
    const loading = candidate({
      category: "loading-state-missing",
      rule: "idiom:loading-state-missing",
      verification: {
        check: "loading-state-missing",
        params: { selector: "#seed", requests: ["GET /wrong"] },
      },
    });
    expect(
      matchesExpected(loading, {
        check: loading.category,
        rule: loading.rule,
        selectors: ["#seed"],
        request: "GET /api/items",
      }),
    ).toBe(false);
    const motion = candidate({
      category: "motion",
      rule: "idiom:motion-snap",
      verification: {
        check: "motion",
        params: {
          surface: "#seed",
          kind: "expand-collapse",
          actions: [{ name: "Wrong action" }],
        },
      },
    });
    expect(
      matchesExpected(motion, {
        check: "motion",
        rule: motion.rule,
        selectors: ["#seed"],
        kind: "expand-collapse",
        actionName: "Show more",
      }),
    ).toBe(false);
  });

  test("clean matching defects are invalid, while a seed hidden among noise remains a miss", () => {
    const clean = capture([]);
    const noise = capture(
      Array.from({ length: 20 }, (_, index) =>
        candidate({
          selectorHint: `#noise-${index}`,
          verification: {
            check: "clipped-text",
            params: { selector: `#noise-${index}` },
          },
        }),
      ),
    );
    expect(evaluateSeed(clean, noise, expected)).toMatchObject({
      caught: false,
      rank: null,
      findingCount: 20,
      otherFindings: 20,
      expectedFindings: [],
    });
    expect(() =>
      evaluateSeed(capture([candidate()]), capture([candidate()]), expected),
    ).toThrow(/Control invalid/);
    expect(matchingFingerprints(noise, expected).size).toBe(0);
  });

  test("individual rank uses production salience × prominence before severity, preserving stable ties and all noise", () => {
    const sample = capture([
      candidate({
        category: "contrast",
        rule: "axe:color-contrast",
        severity: "blocker",
        selectorHint: "#noise",
      }),
      candidate({ severity: "minor" }),
      candidate({
        selectorHint: "#tie",
        severity: "minor",
        verification: { check: "clipped-text", params: { selector: "#tie" } },
      }),
    ]);
    const ranked = rankFindings(sample);
    expect(sample.findings[0]?.category).toBe("contrast");
    expect(ranked.map((item) => item.selector)).toEqual([
      "#seed",
      "#tie",
      "#noise",
    ]);
    const context = buildIssueRankingContext(sample.tuples);
    expect(ranked[0]?.score).toBe(
      scoreGroup(
        {
          category: "clipped-text",
          rule: "idiom:text-clipped",
          selector: "#seed",
          coordinates: ["mutation/desktop"],
        },
        affectedCounts(["mutation/desktop"], context),
        context,
      ).score,
    );
    expect(evaluateSeed(capture([]), sample, expected)).toMatchObject({
      caught: true,
      rank: 1,
      otherFindings: 2,
    });
    const duplicate = capture([candidate(), candidate()]);
    expect(duplicate.findings).toHaveLength(1);
    expect(evaluateSeed(capture([]), duplicate, expected)).toMatchObject({
      rank: 1,
      findingCount: 1,
      otherFindings: 0,
    });
  });

  test("rank resolves geometry at the exact finding selector and tuple", () => {
    // The production scorer only consumes these observation fields.
    const observed = {
      ...tuple,
      observations: {
        version: 2,
        viewport: { width: 1000, height: 900 },
        elements: [
          {
            selector: "#seed",
            tag: "p",
            visible: true,
            rect: { x: 10, y: 10, width: 700, height: 200 },
            ancestorSelectors: ["main"],
          },
          {
            selector: "#noise",
            tag: "p",
            visible: true,
            rect: { x: 0, y: 1000, width: 700, height: 200 },
            ancestorSelectors: [],
          },
          {
            selector: "main",
            tag: "main",
            visible: true,
            rect: { x: 0, y: 0, width: 1000, height: 900 },
            ancestorSelectors: [],
          },
        ],
      },
    } as CheckTuple;
    const sample = capture(
      [
        candidate({ severity: "minor" }),
        candidate({
          selectorHint: "#noise",
          severity: "blocker",
          verification: {
            check: "clipped-text",
            params: { selector: "#noise" },
          },
        }),
      ],
      observed,
    );
    const ranked = rankFindings(sample);
    expect(sample.findings[0]?.severity).toBe("blocker");
    expect(ranked.map((item) => item.selector)).toEqual(["#seed", "#noise"]);
    expect(ranked[0]?.prominence).toBeGreaterThan(2);
    expect(ranked[1]?.prominence).toBe(1);
    const context = buildIssueRankingContext(sample.tuples);
    expect(ranked[0]?.score).toBe(
      scoreGroup(
        {
          category: "clipped-text",
          rule: "idiom:text-clipped",
          selector: "#seed",
          coordinates: ["mutation/desktop"],
        },
        affectedCounts(["mutation/desktop"], context),
        context,
      ).score,
    );
  });

  test("case-weighted recall, medians, errors and empty populations are explicit", () => {
    expect(summarize([]).overall).toMatchObject({
      attempted: 0,
      recall: null,
      medianRank: null,
    });
    expect(summarize([result("a", "A", false, null)]).overall).toMatchObject({
      attempted: 1,
      recall: 0,
      medianRank: null,
    });
    const summary = summarize([
      result("a", "A", true, 2),
      result("b", "A", true, 4),
      result("c", "B", false, null),
      { ...result("d", "B", false, null), status: "error" },
    ]);
    expect(summary.overall).toMatchObject({
      attempted: 3,
      caught: 2,
      recall: 2 / 3,
      medianRank: 3,
      errors: 1,
    });
    expect(summary.perRule.B).toMatchObject({ attempted: 1, recall: 0 });
    expect(summary.misses.map((item) => item.id)).toEqual(["c"]);
  });

  test("one rule's lost catch fails even when another improves; selection and caught identities are pinned", () => {
    const previous = [result("a", "A", true, 1), result("b", "B", false, null)];
    const measurement = summarize(previous);
    const guard: RecallBaseline = {
      caseIds: ["a", "b"],
      membership: { a: "A", b: "B" },
      caughtCaseIds: ["a"],
      overall: measurement.overall,
      perRule: measurement.perRule,
    };
    expect(() => assertBaseline(previous, guard)).not.toThrow();
    expect(() =>
      assertBaseline(
        [result("a", "A", false, null), result("b", "B", true, 1)],
        guard,
      ),
    ).toThrow(/Recall regression for A/);
    expect(() => assertBaseline(previous.slice(1), guard)).toThrow(/selection/);
    expect(() =>
      assertBaseline(
        [
          previous[0] as CaseResult,
          { ...(previous[1] as CaseResult), rule: "C" },
        ],
        guard,
      ),
    ).toThrow(/membership/);
  });
});

test("fixed browser subset, isolation and Node launcher finish within one 30-second budget", async () => {
  const started = performance.now();
  const originalBaseline = await readFile(
    join(root, "test/fixtures/mutations/baseline.json"),
    "utf8",
  );
  const report = await runMutationBench({
    root,
    caseIds: baseline.caseIds,
    verifyIsolation: true,
  });
  expect(
    report.status,
    JSON.stringify(report.cases.filter((item) => item.status === "error")),
  ).toBe("complete");
  assertBaseline(report.cases, baseline);
  expect(report.isolation).toMatchObject({ noOp: true, freshControl: true });
  expect(
    report.cases.every(
      (item) =>
        item.mutation?.pure &&
        (item.mutation.changed || item.operator === "dead-button"),
    ),
  ).toBe(true);
  const load = report.cases.find((item) => item.operator === "unreserved-load");
  expect(
    load?.evidence?.some((evidence) =>
      evidence.actions.some(
        (action) => action.source === "load" && action.shifts.length > 0,
      ),
    ),
  ).toBe(true);
  const motion = report.cases.find(
    (item) => item.operator === "snapping-content",
  );
  expect(motion?.mutation?.applications).toBeGreaterThan(1);
  expect(
    motion?.evidence?.some((evidence) =>
      evidence.actions.some(
        (action) =>
          action.confirmation &&
          action.reducedMotion === false &&
          action.visibleChanges?.length,
      ),
    ),
  ).toBe(true);
  const scratch = await mkdtemp(join(tmpdir(), "idiom-mutation-"));
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const html = await loadFixture(
        root,
        "test/fixtures/mutations/clean/static.html",
      );
      await page.setContent(html);
      const operator = operators.find(
        (operator) => operator.id === "retired-copy",
      );
      if (!operator) throw new Error("Missing catalog operator");
      const audit = await page.evaluate(mutationProgram, {
        operator,
        apply: true,
      });
      expect(audit.pure).toBe(true);
      expect(audit.after).toBe(
        audit.before.replace(
          "Your workspace is ready for the next project.",
          "Style guide",
        ),
      );
      const centre = operators.find(
        (operator) => operator.id === "off-centre-label",
      );
      if (!centre) throw new Error("Missing centring operator");
      const beforeBox = await page.locator("#action").boundingBox();
      await page.evaluate(mutationProgram, { operator: centre, apply: true });
      expect(await page.locator("#action").boundingBox()).toEqual(beforeBox);
      await context.close();
      const broken = html.replace(
        "<script>",
        '<script>fetch("/missing-local-route");',
      );
      await expect(
        capturePage(
          browser,
          broken,
          "broken.html",
          profileFor(operator, "broken.html"),
        ),
      ).rejects.toThrow(/Missing local route/);
    } finally {
      await browser.close();
    }
    const out = join(scratch, "smoke.json");
    await execute(
      process.execPath,
      [
        join(root, "scripts/mutation-bench.mjs"),
        "--case",
        "retired-copy::test/fixtures/mutations/clean/static.html",
        "--out",
        out,
      ],
      { cwd: root, timeout: 10_000 },
    );
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({
      version: 1,
      status: "complete",
      scope: "selection",
      overall: { attempted: 1, caught: 1 },
    });
    const incomplete = join(scratch, "incomplete.json");
    await expect(
      execute(
        process.execPath,
        [
          join(root, "scripts/mutation-bench.mjs"),
          "--case",
          "retired-copy::test/fixtures/mutations/clean/missing.html",
          "--out",
          incomplete,
        ],
        { cwd: root, timeout: 10_000 },
      ),
    ).rejects.toThrow(/unknown or inapplicable/);
    expect(JSON.parse(await readFile(incomplete, "utf8"))).toMatchObject({
      status: "incomplete",
      overall: { attempted: 0, errors: 1, recall: null },
      cases: [{ status: "error" }],
    });
    await expect(
      execute(
        process.execPath,
        [
          join(root, "scripts/mutation-bench.mjs"),
          "--case",
          baseline.caseIds[0] as string,
        ],
        { cwd: root },
      ),
    ).rejects.toThrow(/Filtered runs require/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  expect(
    await readFile(join(root, "test/fixtures/mutations/baseline.json"), "utf8"),
  ).toBe(originalBaseline);
  expect(performance.now() - started).toBeLessThan(30_000);
}, 30_000);
