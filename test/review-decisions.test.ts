import { expect, test } from "vitest";
import { decisionViews } from "../src/decisions/log.js";
import { selectFindings } from "../src/review/findings.js";
import { renderReport } from "../src/review/report.js";
import { decisionSchema } from "../src/schemas/decision.js";
import { findingSchema } from "../src/schemas/finding.js";

function finding(id: string, severity: "blocker" | "major" | "minor") {
  return findingSchema.parse({
    id,
    fingerprint: `fp-${id}`,
    createdAt: "2026-08-14T12:00:00.000Z",
    commit: "abc123",
    flow: "booking",
    state: "ready",
    viewport: "phone",
    layer: "deterministic",
    category: "target-size",
    severity,
    confidence: 1,
    evidence: { screenshots: [] },
    explanation: `Explanation for ${id}`,
    acceptance: [`Observable outcome for ${id}`],
    verification: { kind: "deterministic-check", check: "target-size" },
    status: "open",
  });
}

test("review selection suppresses rules before stable severity ranking and cap", () => {
  const candidates = [
    finding("minor-suppressed", "minor"),
    finding("major-first", "major"),
    finding("minor-first", "minor"),
    finding("blocker-first", "blocker"),
    finding("major-second", "major"),
    finding("blocker-second", "blocker"),
    finding("minor-deferred", "minor"),
  ];
  const ruleReject = decisionSchema.parse({
    at: "2026-08-15T12:00:00.000Z",
    commit: "abc123",
    findingId: "minor-suppressed",
    fingerprint: "fp-minor-suppressed",
    decision: "reject",
    scope: "rule",
    reason: "Intentional treatment",
    actor: "human",
  });
  const selected = selectFindings({
    findings: candidates,
    decisions: decisionViews([ruleReject]),
    maxFindings: 5,
  });
  expect(selected.actionable.map((item) => item.id)).toEqual([
    "blocker-first",
    "blocker-second",
    "major-first",
    "major-second",
    "minor-deferred",
  ]);
  expect(selected.suppressed.map(({ finding: item }) => item.id)).toEqual([
    "minor-suppressed",
  ]);
  expect(selected.deferred.map((item) => item.id)).toEqual(["minor-first"]);

  const report = renderReport({
    flow: "booking",
    commit: "abc123",
    findings: selected.actionable,
    tuples: [],
    coverage: [],
    outcome: { kind: "deterministic-only" },
    suppressed: selected.suppressed,
    deferred: selected.deferred,
    severityOverrides: [
      {
        fingerprint: "fp-minor-first",
        original: "major",
        effective: "minor",
        override: {
          id: "lower-deferred",
          match: { fingerprint: "fp-minor-first" },
          action: "severity",
          severity: "minor",
          reason: "Known low impact",
        },
      },
    ],
  });
  expect(report).toContain("Intentional treatment");
  expect(report).toContain("minor-first (minor) — Layer: deterministic");
  expect(report).toContain(
    "Severity override: major -> minor by rule lower-deferred (Known low impact)",
  );
});

test("only the latest rule judgment suppresses; instance rejection never does", () => {
  const item = finding("finding", "major");
  const record = (
    decision: "accept" | "reject",
    scope: "instance" | "rule",
    at: string,
  ) =>
    decisionSchema.parse({
      at,
      commit: "abc123",
      findingId: "finding",
      fingerprint: item.fingerprint,
      decision,
      scope,
      actor: "human",
    });

  const instanceOnly = selectFindings({
    findings: [item],
    decisions: decisionViews([
      record("reject", "instance", "2026-08-15T10:00:00.000Z"),
    ]),
    maxFindings: 5,
  });
  expect(instanceOnly.actionable).toEqual([item]);

  const superseded = selectFindings({
    findings: [item],
    decisions: decisionViews([
      record("reject", "rule", "2026-08-15T10:00:00.000Z"),
      record("accept", "rule", "2026-08-15T11:00:00.000Z"),
    ]),
    maxFindings: 5,
  });
  expect(superseded.actionable).toEqual([item]);
});
