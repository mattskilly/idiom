import { describe, expect, test } from "vitest";
import {
  boundDeterministicFindings,
  DETERMINISTIC_FINDINGS_CHAR_LIMIT,
  DETERMINISTIC_FINDINGS_LIMIT,
  DETERMINISTIC_SUMMARY_GROUP_LIMIT,
  deterministicContextLimit,
  deterministicContextSentence,
  deterministicOmissionMarker,
} from "../src/critique/deterministic-bound.js";
import { critiquePrompt } from "../src/critique/prompt.js";
import type { CritiqueInput } from "../src/critique/types.js";
import {
  type Finding,
  findingCategories,
  findingSchema,
} from "../src/schemas/finding.js";

const label =
  "## Already evaluated deterministic findings; do not duplicate them\n";
const instruction =
  "The deterministic findings list is bounded (marked); the summarized findings were also evaluated, so do not report them as model findings either.";

function finding(overrides: Partial<Record<string, unknown>> = {}): Finding {
  return findingSchema.parse({
    id: "f1",
    fingerprint: "0123456789abcdef0123",
    createdAt: "2026-10-26T00:00:00.000Z",
    commit: "fixture",
    flow: "f",
    state: "s",
    viewport: "desktop",
    layer: "deterministic",
    category: "contrast",
    severity: "minor",
    confidence: 1,
    rule: "WCAG 1.4.3",
    evidence: { screenshots: [] },
    explanation: "x",
    acceptance: [],
    verification: { kind: "deterministic-check", check: "contrast" },
    status: "open",
    ...overrides,
  });
}

function many(count: number, overrides: Partial<Record<string, unknown>> = {}) {
  return Array.from({ length: count }, (_, index) =>
    finding({ explanation: `explanation-${index}`, ...overrides }),
  );
}

/** The prompt section exactly as it was serialized before the bound. */
function legacySection(findings: Finding[]): string {
  return `${label}${JSON.stringify(
    findings.map((item) => ({
      category: item.category,
      severity: item.severity,
      state: item.state,
      viewport: item.viewport,
      ...(item.colorScheme === undefined
        ? {}
        : { colorScheme: item.colorScheme }),
      rule: item.rule,
      explanation: item.explanation,
    })),
    null,
    2,
  )}`;
}

function input(deterministicFindings: Finding[]): CritiqueInput {
  return {
    flow: "booking",
    intent: ["Booking is obvious in one screen."],
    screenshots: [],
    domExcerpts: [],
    productMd: "Serve recipients quickly.",
    designMd: "Keep one dominant action.",
    references: [],
    priorDecisions: [],
    deterministicFindings,
    modelCandidateAllowance: 5,
    decisionObservationAllowance: 3,
    rulingResolutions: [],
  };
}

describe("boundDeterministicFindings", () => {
  test("keeps every entry of sets at or under the bound", () => {
    for (const size of [0, 1, DETERMINISTIC_FINDINGS_LIMIT]) {
      const findings = many(size);
      const bounded = boundDeterministicFindings(findings);
      expect(bounded.entries, `size ${size}`).toHaveLength(size);
      expect(bounded.omitted).toEqual([]);
      expect(bounded.includedFindings).toBe(size);
      expect(deterministicContextLimit(findings)).toBeUndefined();
    }
  });

  test("lists the first entries in input order and groups the rest by count", () => {
    const findings = [
      ...many(DETERMINISTIC_FINDINGS_LIMIT, { severity: "blocker" }),
      ...many(5, { category: "a11y-label", severity: "major" }),
      ...many(15, { category: "target-size", severity: "minor" }),
      ...many(5, { category: "a11y-label", severity: "minor" }),
    ];
    const bounded = boundDeterministicFindings(findings);
    expect(bounded.entries.map((entry) => entry.explanation)).toEqual(
      findings.slice(0, 50).map((item) => item.explanation),
    );
    expect(bounded.omitted).toEqual([
      { category: "target-size", severity: "minor", count: 15 },
      { category: "a11y-label", severity: "major", count: 5 },
      { category: "a11y-label", severity: "minor", count: 5 },
    ]);
    expect(deterministicOmissionMarker(bounded)).toBe(
      "[deterministic findings bounded: first 50 of 75 listed; the other 25, by category and severity: target-size (minor) ×15, a11y-label (major) ×5, a11y-label (minor) ×5]",
    );
    expect(deterministicContextLimit(findings, "checkout")).toEqual({
      state: "checkout",
      totalFindings: 75,
      includedFindings: 50,
    });
  });

  test("stops at the character budget without cutting an entry", () => {
    const findings = many(5, { explanation: "e".repeat(9_000) });
    const bounded = boundDeterministicFindings(findings);
    expect(bounded.includedFindings).toBe(2);
    expect(
      bounded.entries.every((entry) => entry.explanation.length === 9_000),
    ).toBe(true);
    expect(
      bounded.entries.reduce(
        (total, entry) => total + JSON.stringify(entry).length,
        0,
      ),
    ).toBeLessThanOrEqual(DETERMINISTIC_FINDINGS_CHAR_LIMIT);
    expect(bounded.omitted).toEqual([
      { category: "contrast", severity: "minor", count: 3 },
    ]);
  });

  test("summarizes everything when the first entry alone exceeds the budget", () => {
    const findings = [
      finding({ explanation: "e".repeat(DETERMINISTIC_FINDINGS_CHAR_LIMIT) }),
      finding(),
    ];
    const bounded = boundDeterministicFindings(findings);
    expect(bounded.entries).toEqual([]);
    expect(deterministicOmissionMarker(bounded)).toBe(
      "[deterministic findings bounded: first 0 of 2 listed; the other 2, by category and severity: contrast (minor) ×2]",
    );
  });

  test("names at most the group limit and counts the rest", () => {
    const groups = DETERMINISTIC_SUMMARY_GROUP_LIMIT + 4;
    const findings = [
      ...many(DETERMINISTIC_FINDINGS_LIMIT),
      ...findingCategories
        .slice(0, groups)
        .flatMap((category) => many(1, { category })),
    ];
    const marker = deterministicOmissionMarker(
      boundDeterministicFindings(findings),
    );
    expect(marker).toMatch(
      /^\[deterministic findings bounded: first 50 of 84 listed; the other 34, by category and severity: /,
    );
    expect(marker.match(/×/g)).toHaveLength(DETERMINISTIC_SUMMARY_GROUP_LIMIT);
    expect(marker.endsWith(", and 4 more in other categories]")).toBe(true);
  });
});

test("deterministicContextSentence names one or several bounded prompts", () => {
  expect(
    deterministicContextSentence([
      { totalFindings: 212, includedFindings: 50 },
    ]),
  ).toBe(
    "Deterministic findings context for the model was bounded (limit 50 findings or 20,000 characters per prompt): 50 of 212 listed, the rest summarized by category and severity.",
  );
  expect(
    deterministicContextSentence([
      { state: "checkout", totalFindings: 1_212, includedFindings: 50 },
      { state: "confirm", totalFindings: 61, includedFindings: 31 },
    ]),
  ).toBe(
    "Deterministic findings context for the model was bounded (limit 50 findings or 20,000 characters per prompt): checkout 50 of 1,212 listed, confirm 31 of 61 listed; the rest summarized by category and severity.",
  );
});

describe("critiquePrompt deterministic findings section", () => {
  test("small sets keep the exact unbounded serialization", () => {
    const findings = [
      finding({ colorScheme: "dark", severity: "blocker" }),
      finding({ rule: undefined, explanation: "no rule" }),
      ...many(DETERMINISTIC_FINDINGS_LIMIT - 2),
    ];
    const prompt = critiquePrompt(input(findings), []);
    expect(prompt).toContain(`${legacySection(findings)}\n\n## Standing`);
    expect(prompt).not.toContain("deterministic findings bounded");
    expect(prompt).not.toContain(instruction);
  });

  test("oversized sets list a bounded prefix with a marker and instruction", () => {
    const findings = many(200);
    const prompt = critiquePrompt(input(findings), []);
    expect(prompt).toContain(
      `${legacySection(findings.slice(0, 50))}\n[deterministic findings bounded: first 50 of 200 listed; the other 150, by category and severity: contrast (minor) ×150]`,
    );
    expect(prompt).not.toContain('"explanation-50"');
    expect(prompt).toContain(instruction);
    const larger = critiquePrompt(input(many(2_000)), []);
    expect(larger.length - prompt.length).toBe(
      "2,0001,9501,950".length - "200150150".length,
    );
  });
});
