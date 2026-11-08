import { expect, test } from "vitest";
import { renderFindingDetails } from "../src/baseline/render.js";
import { baselineFindingSchema } from "../src/baseline/schema.js";
import type { CheckTuple } from "../src/checks/types.js";
import {
  boundDeterministicFindings,
  DETERMINISTIC_FINDINGS_LIMIT,
} from "../src/critique/deterministic-bound.js";
import { materialEvidenceChange } from "../src/decisions/acknowledgements.js";
import { severityGateEligible } from "../src/findings/gate.js";
import { renderHostedReport } from "../src/hosted/render.js";
import { reportSchema } from "../src/hosted/schema.js";
import { applyRulesToDrafts } from "../src/review/findings.js";
import { groupRepeatedFindings } from "../src/review/groups.js";
import { renderReviewHtmlReport } from "../src/review/html-report.js";
import { collapseIssues } from "../src/review/issues.js";
import { comparePriority } from "../src/review/ranking.js";
import { renderReport } from "../src/review/report.js";
import { acknowledgementSchema } from "../src/schemas/decision.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { ruleOverrideSchema } from "../src/schemas/rules.js";
import {
  findingSeveritySchema,
  severityRank,
} from "../src/schemas/severity.js";

function finding(
  severity: Finding["severity"] = "info",
  overrides: Partial<Finding> = {},
): Finding {
  return findingSchema.parse({
    id: "finding-info",
    fingerprint: "0123456789abcdef0123",
    createdAt: "2026-11-06T00:00:00.000Z",
    commit: "fixture",
    flow: "cards",
    state: "gallery",
    viewport: "desktop",
    layer: "deterministic",
    category: "element-overlap",
    severity,
    confidence: 1,
    rule: "idiom:elements-overlap",
    evidence: { screenshots: [] },
    explanation: "3 cards have ambiguous overlapping links and actions",
    acceptance: [],
    verification: { kind: "deterministic-check", check: "element-overlap" },
    status: "open",
    ...overrides,
  });
}

test("all final severities round-trip in findings, overrides, baseline and acknowledgement evidence", () => {
  for (const severity of findingSeveritySchema.options) {
    const item = finding(severity);
    expect(findingSchema.parse(JSON.parse(JSON.stringify(item))).severity).toBe(
      severity,
    );
    expect(
      ruleOverrideSchema.parse({
        id: "override",
        match: { rule: item.rule },
        action: "severity",
        severity,
        reason: "human policy",
      }).severity,
    ).toBe(severity);
    expect(
      baselineFindingSchema.parse({
        fingerprint: item.fingerprint,
        aliases: [],
        category: item.category,
        rule: item.rule,
        selector: "#card",
        severity,
      }).severity,
    ).toBe(severity);
    expect(
      acknowledgementSchema.parse({
        at: item.createdAt,
        commit: item.commit,
        findingId: item.id,
        fingerprint: item.fingerprint,
        decision: "acknowledge",
        reference: "ABC-1",
        evidence: { category: item.category, rule: item.rule, severity },
      }).evidence?.severity,
    ).toBe(severity);
  }
});

test("info never gates, with every threshold, basis and judged opt-in; prior levels keep their ordering", () => {
  for (const severity of findingSeveritySchema.options)
    for (const failOn of ["never", "blocker", "major", "minor"] as const)
      for (const basis of ["measured", "observed", "judged"] as const)
        for (const judged of [false, true])
          expect(
            severityGateEligible({ severity, basis }, failOn, judged),
          ).toBe(
            severity !== "info" &&
              failOn !== "never" &&
              severityRank[severity] <= severityRank[failOn] &&
              (basis !== "judged" || judged),
          );
});

test("info-only aggregates stay info and mixed groups use their strongest actual member", () => {
  const info = finding("info", { groupKey: "same-card" });
  const only = groupRepeatedFindings([info], new Map());
  expect(only[0]?.severity).toBe("info");
  const minor = finding("minor", { groupKey: "same-card", id: "minor" });
  expect(groupRepeatedFindings([info, minor], new Map())[0]?.severity).toBe(
    "minor",
  );
  expect(
    collapseIssues(
      [
        {
          id: "group",
          severity: "info",
          category: "element-overlap",
          rule: "idiom:elements-overlap",
          selector: "#card",
          coordinates: ["gallery/desktop"],
          members: [info],
        },
      ],
      new Set(),
    )[0]?.severity,
  ).toBe("info");
  expect(
    comparePriority(
      { severity: "info", impact: 1, score: 1000 },
      { severity: "minor", impact: 0, score: 1 },
    ),
  ).toBeGreaterThan(0);
});

test("bounded critique context retains info and names it in omission summaries", () => {
  const input = Array.from({ length: DETERMINISTIC_FINDINGS_LIMIT + 1 }, () =>
    finding(),
  );
  const bounded = boundDeterministicFindings(input);
  expect(bounded.entries[0]?.severity).toBe("info");
  expect(bounded.omitted).toEqual([
    { category: "element-overlap", severity: "info", count: 1 },
  ]);
});

test("an info acknowledgement lapses on escalation; lowering severity preserves it", () => {
  const info = finding();
  const evidence = {
    severity: info.severity,
    rule: info.rule,
    category: info.category,
  };
  const ack = acknowledgementSchema.parse({
    at: info.createdAt,
    commit: info.commit,
    findingId: info.id,
    fingerprint: info.fingerprint,
    decision: "acknowledge",
    reference: "ABC-1",
    evidence,
  });
  for (const severity of ["minor", "major", "blocker"] as const)
    expect(materialEvidenceChange(ack, finding(severity))).toBeDefined();
  expect(
    materialEvidenceChange(
      { ...ack, evidence: { ...evidence, severity: "major" } },
      info,
    ),
  ).toBeUndefined();
});

test("markdown, HTML, JSON, baseline details and hosted reports keep the info label", () => {
  const item = finding();
  const options = {
    flow: "cards",
    commit: "fixture",
    findings: [item],
    tuples: [
      {
        flow: "cards",
        state: "gallery",
        viewport: "desktop",
        width: 1440,
        height: 900,
        commit: "fixture",
        createdAt: item.createdAt,
        console: [],
        mismatches: [],
        metadataPath: "metadata.json",
        artifactPaths: [],
      } as CheckTuple,
    ],
    coverage: [],
    outcome: { kind: "deterministic-only" as const },
  };
  expect(renderReport(options)).toContain("info");
  const rendered = renderReviewHtmlReport({
    ...options,
    screenshots: new Map(),
  });
  expect(rendered).toContain("badge-info");
  expect(rendered).toContain(item.explanation);
  expect(JSON.parse(JSON.stringify([item]))[0].severity).toBe("info");
  expect(
    renderFindingDetails([
      {
        id: item.id,
        severity: "info",
        category: item.category,
        where: "gallery/desktop",
        problem: item.explanation,
        fix: [],
      },
    ]).join("\n"),
  ).toContain("[info]");
  const hosted = reportSchema.parse({
    version: 1,
    target: "https://example.test/",
    runtimeHash: "a".repeat(64),
    issues: [
      {
        title: "Card actions",
        severity: "info",
        detail: item.explanation,
        assets: [],
      },
    ],
    filmstrips: [],
    design: { status: "none", detail: "No reference", assets: [] },
    coverage: [],
    metrics: { elapsedMs: 1, networkBytes: 0, requests: 0, findings: 1 },
    assets: [],
  });
  expect(renderHostedReport("a".repeat(64), hosted, Date.now())).toContain(
    'class="meta">info</p>',
  );
});

test("human severity overrides retain provenance and gate on their effective severity", () => {
  const original = finding();
  const draft = {
    finding: original,
    selectorHint: "#card",
    checkOrder: 0,
    stableOrder: 0,
  };
  const override = ruleOverrideSchema.parse({
    id: "raise",
    match: { rule: original.rule },
    action: "severity",
    severity: "major",
    reason: "Confirmed obstruction",
  });
  const raised = applyRulesToDrafts([draft], {
    version: 1,
    overrides: [override],
  });
  expect(raised.kept[0]?.finding.severity).toBe("major");
  expect(raised.kept[0]?.severityOverride).toMatchObject({
    original: "info",
    effective: "major",
    override: { id: "raise" },
  });
  expect(
    severityGateEligible(raised.kept[0]?.finding ?? original, "major"),
  ).toBe(true);
  const lowered = applyRulesToDrafts(raised.kept, {
    version: 1,
    overrides: [{ ...override, id: "lower", severity: "info" }],
  });
  expect(lowered.kept[0]?.finding.severity).toBe("info");
  expect(
    severityGateEligible(lowered.kept[0]?.finding ?? original, "minor", true),
  ).toBe(false);
});
