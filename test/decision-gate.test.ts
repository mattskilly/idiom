import { expect, test, vi } from "vitest";
import { run } from "../src/cli.js";
import type { CheckSummary } from "../src/commands/check.js";
import { checkGate } from "../src/commands/check-gate.js";
import { decisionQuestion } from "../src/decisions/question.js";
import type { PendingDecision } from "../src/schemas/pending-decision.js";

vi.mock("../src/commands/check-gate.js", () => ({ checkGate: vi.fn() }));
const question: PendingDecision = {
  kind: "reference-conflict",
  key: "key",
  fingerprint: "fp",
  id: "finding-1",
  flow: "site",
  runDirectory: "/run",
  artifact: "/run/findings.json",
  question: "Which reference?",
  coordinates: [{ state: "home", viewport: "wide" }],
  evidence: ["/run/crops/card.png"],
  missingCropEvidence: false,
  citations: ["a: 8px; b: 12px"],
  options: [{ label: "a", args: ["--finding", "finding-1", "--choose", "a"] }],
};
function summary(
  questions: PendingDecision[] = [question],
  ordinary = false,
  deferred = false,
): CheckSummary {
  return {
    flow: "site",
    runDirectory: "/run",
    reportPath: "/run/report.md",
    blocking: ordinary ? 1 : 0,
    ...(deferred ? { verdict: "deferred" } : {}),
    decisionNeeded: questions,
    decisionQuestion: decisionQuestion(questions),
    findings: [
      {
        id: "finding-1",
        category: "design-drift",
        severity: "minor",
        where: "home",
        problem: "Which reference?",
        fix: [],
        rule: "idiom:design-decision",
      },
      ...(ordinary
        ? [
            {
              id: "finding-2",
              category: "overflow-clip" as const,
              severity: "major" as const,
              where: "home",
              problem: "Overflow",
              fix: [],
            },
          ]
        : []),
    ],
  };
}
function mockResult(summaries: CheckSummary[]) {
  // Only the controller's output formatting/status seam is replaced here;
  // pendingForRun and real CLI/storage integration are covered separately.
  vi.mocked(checkGate).mockResolvedValue({
    skipped: false,
    plan: {},
    skippedWork: [],
    estimateMs: 0,
    budgetMs: 100,
    server: {},
    changed: {
      checkedStates: 1,
      selection: {},
      checks: summaries.map((s) => ({
        flow: s.flow,
        status: "checked",
        summary: s,
      })),
    },
    timing: {
      totalMs: 1,
      phases: Object.fromEntries(
        ["build", "serverStart", "capture", "probe", "checks"].map((p) => [
          p,
          { status: "measured", ms: 1 },
        ]),
      ),
      slowest: "checks",
      probeIncludedInCapture: true,
    },
  } as unknown as Awaited<ReturnType<typeof checkGate>>);
}
async function cli(flags: string[] = []) {
  const out: string[] = [],
    err: string[] = [];
  const status = await run(
    [
      "node",
      "idiom",
      "check",
      "--gate",
      "--json",
      "--fail-on",
      "major",
      ...flags,
    ],
    { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
  );
  return { status, out: out.join("\n"), err: err.join("\n") };
}

test("decision-only gate exits 4 at default major, preserving per-flow and aggregate questions", async () => {
  mockResult([summary()]);
  const result = await cli();
  expect(result.status, result.err).toBe(4);
  const payload = JSON.parse(result.out);
  expect(payload.interfaceVersion).toBe(1);
  expect(payload.decisionNeeded).toEqual([question]);
  expect(payload.decisionQuestion).toBe(decisionQuestion([question]));
  expect(payload.checks[0].summary.decisionNeeded).toEqual([question]);
});
test.each([
  { ordinary: true, deferred: false, flags: [], exit: 1 },
  { ordinary: true, deferred: true, flags: [], exit: 3 },
  { ordinary: true, deferred: true, flags: ["--deferred", "warn"], exit: 1 },
  { ordinary: false, deferred: true, flags: ["--deferred", "warn"], exit: 4 },
  { ordinary: true, deferred: false, flags: ["--fail-on", "never"], exit: 0 },
])(
  "gate precedence $exit for $ordinary / $deferred / $flags",
  async ({ ordinary, deferred, flags, exit }) => {
    mockResult([summary([question], ordinary, deferred)]);
    const result = await cli(flags);
    expect(result.status, result.err).toBe(exit);
    expect(JSON.parse(result.out).decisionNeeded).toEqual([question]);
  },
);
test("questions still gate when the baseline/presentation removes their summary findings", async () => {
  mockResult([{ ...summary(), findings: [] }]);
  expect((await cli()).status).toBe(4);
});
test("every viewport occurrence of a pending reference question is the question, not an ordinary failure", async () => {
  const merged = { ...question, findingIds: ["finding-1", "finding-phone"] };
  const base = summary([merged]);
  const first = base.findings?.[0];
  if (!first) throw new Error("missing fixture finding");
  mockResult([
    {
      ...base,
      findings: [first, { ...first, id: "finding-phone", severity: "major" }],
    },
  ]);
  const result = await cli();
  expect(result.status, result.err).toBe(4);
});
test("multiple flows aggregate and deduplicate pending identities", async () => {
  const other = {
    ...question,
    key: "other",
    id: "ruling-1",
    kind: "unruled" as const,
    flow: "other",
  };
  mockResult([summary(), { ...summary([question, other]), flow: "other" }]);
  const response = await cli();
  expect(response.status, response.err).toBe(4);
  expect(JSON.parse(response.out).decisionNeeded).toHaveLength(2);
});
test("clean gate passes and run errors remain 2", async () => {
  mockResult([{ ...summary([]), findings: [] }]);
  expect((await cli()).status).toBe(0);
  const { RunFailure } = await import("../src/errors.js");
  vi.mocked(checkGate).mockRejectedValue(
    new RunFailure({
      stage: "capture",
      cause: "capture-failed",
      headline: "Cannot capture",
      hint: "Repair fixture",
    }),
  );
  expect((await cli()).status).toBe(2);
});
