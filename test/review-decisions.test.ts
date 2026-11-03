import { expect, test } from "vitest";
import {
  decisionViews,
  isFingerprintSuppressed,
  ruleRejection,
} from "../src/decisions/log.js";
import {
  type FindingDraft,
  selectFindings,
  suppressFindingDrafts,
} from "../src/review/findings.js";
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
  expect(report).toContain(
    "minor-first (minor) — Report-only: not an `idiom decide --finding` target — Layer: deterministic",
  );
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

test("every selection branch applies the same suppression result for a fingerprint", () => {
  const item = finding("shared", "major");
  expect(item.fingerprint).toBe("fp-shared");
  const draft: FindingDraft = {
    finding: item,
    selectorHint: "button",
    stableOrder: 0,
  };
  const record = (
    decision: "accept" | "reject",
    scope: "instance" | "rule",
    at: string,
  ) =>
    decisionSchema.parse({
      at,
      commit: "abc123",
      findingId: "shared",
      fingerprint: "fp-shared",
      decision,
      scope,
      actor: "human",
    });
  const logs = {
    "rule reject": [record("reject", "rule", "2026-08-15T10:00:00.000Z")],
    "rule reject then accept": [
      record("reject", "rule", "2026-08-15T10:00:00.000Z"),
      record("accept", "rule", "2026-08-15T11:00:00.000Z"),
    ],
    "instance reject only": [
      record("reject", "instance", "2026-08-15T10:00:00.000Z"),
    ],
  };
  const expected = {
    "rule reject": true,
    "rule reject then accept": false,
    "instance reject only": false,
  };

  for (const [name, log] of Object.entries(logs)) {
    const canonical = ruleRejection(["fp-shared"], log);
    const views = decisionViews(log);
    const selected = selectFindings({
      findings: [item],
      decisions: views,
      maxFindings: 5,
    });
    const drafts = suppressFindingDrafts([draft], log);
    const results = {
      canonical: canonical !== undefined,
      selectedSuppressed: selected.suppressed.some(
        (entry) => entry.finding === item,
      ),
      selectedWithheld: ![
        ...selected.actionable,
        ...selected.deferred,
      ].includes(item),
      draftSuppressed: drafts.suppressed.some(
        (entry) => entry.finding === item,
      ),
      draftWithheld: !drafts.kept.includes(draft),
      wrapper: isFingerprintSuppressed("fp-shared", views),
    };
    const want = expected[name as keyof typeof expected];
    expect(results, name).toEqual({
      canonical: want,
      selectedSuppressed: want,
      selectedWithheld: want,
      draftSuppressed: want,
      draftWithheld: want,
      wrapper: want,
    });
    if (canonical !== undefined) {
      expect(selected.suppressed[0]?.decision).toBe(canonical);
      const draftSuppression = drafts.suppressed[0];
      expect(draftSuppression?.source).toBe("decision");
      if (draftSuppression?.source === "decision")
        expect(draftSuppression.decision).toBe(canonical);
    }
  }
});
