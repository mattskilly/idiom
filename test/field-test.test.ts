import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error The field-test helpers are plain Node ESM without declarations.
import * as lib from "../scripts/field-test-lib.mjs";

const {
  countProbeTimeouts,
  classifyFailure,
  GENERATED_END,
  GENERATED_START,
  mergeLabelTemplate,
  precisionByRule,
  replaceGeneratedSection,
  renderGenerated,
  summarizeCheckResult,
  probeTupleOverheadMs,
  summarizeProbeSafety,
  summarizeQuickResult,
  sumProbeSafety,
  validateTargets,
} = lib;

const fixtures = join(import.meta.dirname, "fixtures", "field-test");
const json = async (name: string) =>
  JSON.parse(await readFile(join(fixtures, name), "utf8"));

type Target = {
  id: string;
  kind: string;
  aiBuilt: boolean;
  urls: string[];
  repo?: unknown;
};
type Row = { rule: string; disagree: number };
const target = (id: string, kind: string, extra: object = {}): Target => ({
  id,
  kind,
  aiBuilt: false,
  urls: [`https://${id}.example/`],
  ...extra,
});
const validTargets = (): Target[] => [
  target("marketing", "marketing"),
  target("dashboard", "saas-dashboard"),
  target("docs", "docs", {
    repo: {
      url: "https://github.com/example/docs",
      commit: "a".repeat(40),
      install: ["npm ci"],
      dev: ["npm run dev"],
      server: {},
    },
  }),
  target("shop", "ecommerce"),
  target("form", "form-heavy"),
  target("mobile", "mobile-first"),
  target("ai-1", "ai-built", { aiBuilt: true }),
  target("ai-2", "ai-built", { aiBuilt: true }),
  target("ai-3", "ai-built", { aiBuilt: true }),
];

describe("validateTargets", () => {
  test("accepts the required mix", () => {
    expect(validateTargets(validTargets())).toHaveLength(9);
  });
  test("rejects a missing kind", () => {
    const targets = validTargets().filter((item) => item.kind !== "ecommerce");
    targets.push(target("extra", "docs"));
    expect(() => validateTargets(targets)).toThrow(/ecommerce/);
  });
  test("rejects fewer than three AI-built targets", () => {
    const targets = validTargets();
    targets[6] = { ...(targets[6] as Target), aiBuilt: false };
    expect(() => validateTargets(targets)).toThrow(/3 AI-built/);
  });
  test("rejects cross-origin URLs within a target", () => {
    const targets = validTargets();
    targets[0] = {
      ...(targets[0] as Target),
      urls: ["https://a.example/", "https://b.example/"],
    };
    expect(() => validateTargets(targets)).toThrow(/one origin/);
  });
  test("rejects a missing repo target and a wrong count", () => {
    const targets = validTargets().map(({ repo: _repo, ...rest }) => rest);
    expect(() => validateTargets(targets)).toThrow(/repo target/);
    expect(() => validateTargets(validTargets().slice(0, 7))).toThrow(/8–10/);
  });
  test("the committed targets file satisfies the acceptance mix", async () => {
    const committed = JSON.parse(
      await readFile(
        join(import.meta.dirname, "..", "scripts", "field-test.targets.json"),
        "utf8",
      ),
    );
    expect(() => validateTargets(committed)).not.toThrow();
  });
});

describe("summaries", () => {
  test("quick: Top 10 truncation and family rule attribution", async () => {
    const content = await json("quick.json");
    const summary = summarizeQuickResult(content, {
      elapsedMs: 1234.4,
      target: "site",
    });
    expect(content.issues.length).toBeGreaterThan(10);
    expect(summary.topIssues).toHaveLength(10);
    expect(
      summary.topIssues.map((issue: { rank: number }) => issue.rank),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(summary.topIssues[0]).toMatchObject({
      key: "site:group-efefd6884e81",
      rules: ["idiom:elements-overlap"],
      state: "page-1",
      viewport: "desktop",
    });
    expect(summary.topIssues[0].evidence).not.toMatch(/^\//);
    expect(summary.topIssues[1].rules).toEqual([
      "idiom:adjacent-elements-touch",
      "idiom:focus-ring-collision",
    ]);
    expect(summary).toMatchObject({ elapsedMs: 1234, tuples: 4 });
  });
  test("check: Top 10, coordinates and timing digest", async () => {
    const output = await json("check.json");
    const runRecord = await json("run.json");
    const summary = summarizeCheckResult(output, runRecord, {
      elapsedMs: 9000,
      target: "repo",
    });
    expect(summary.topIssues).toHaveLength(10);
    expect(summary.topIssues[0]).toMatchObject({
      key: `repo:${output.issues[0].id}`,
      rules: output.issues[0].rules,
    });
    expect(summary.topIssues[0].state).toBeTruthy();
    expect(summary.tuples).toBe(runRecord.selected.length);
    expect(summary.timings?.slowestTuples.length).toBeGreaterThan(0);
    expect(summary.probeCoverage?.intended).toBe(
      runRecord.probe.intended.length,
    );
  });
});

test("countProbeTimeouts separates ran, partial and timed-out probes", () => {
  expect(
    countProbeTimeouts([
      { probe: { status: "ran" } },
      { probe: { status: "ran" } },
      { probe: { status: "timed-out" } },
      { probe: { status: "partial", reason: "control timed-out after 5s" } },
      { probe: { status: "partial", reason: "budget exhausted" } },
      {},
    ]),
  ).toEqual({ ran: 2, partial: 2, timedOut: 1, partialTimedOut: 1 });
});

test("classifyFailure", () => {
  expect(
    classifyFailure({
      stage: "mcp",
      message: "MCP error -32001: Request timed out",
    }).kind,
  ).toBe("timeout");
  expect(classifyFailure({ stage: "check", timedOut: true }).kind).toBe(
    "timeout",
  );
  expect(
    classifyFailure({
      stage: "mcp",
      message: "Quick capture failed: navigation",
    }).kind,
  ).toBe("capture-failed");
  expect(classifyFailure({ stage: "cli", exitCode: 1 })).toEqual({
    kind: "crash",
    stage: "cli",
    message: "exited with code 1",
  });
});

const issue = (key: string, rules: string[]) => ({
  key,
  rank: 1,
  rules,
  severity: "minor",
  category: "layout",
  score: 1,
  title: key,
});
const rate = (rating: string, human?: string) => ({
  target: "t",
  rules: [],
  title: "",
  agent: { rating, reason: "agent" },
  human: human ? { rating: human, reason: "human" } : null,
});

describe("precisionByRule", () => {
  const results = (issues: ReturnType<typeof issue>[]) => ({
    targets: [{ id: "t", topIssues: issues }],
  });
  const row = (rows: Row[], rule: string) =>
    rows.find((item) => item.rule === rule);

  test("excludes unsure and leaves a zero denominator unflagged", () => {
    const rows = precisionByRule(
      results([issue("a", ["r"]), issue("b", ["r"]), issue("c", ["u"])]),
      {
        labels: {
          a: rate("agree"),
          b: rate("unsure"),
          c: rate("unsure"),
        },
      },
    );
    expect(row(rows, "r")).toMatchObject({
      agree: 1,
      unsure: 1,
      n: 2,
      precision: 1,
      belowThreshold: false,
    });
    expect(row(rows, "u")).toMatchObject({
      precision: null,
      belowThreshold: false,
    });
  });
  test("exactly 70% is not flagged; 69.9% is", () => {
    const keys = Array.from({ length: 10 }, (_, index) => `k${index}`);
    const seven = Object.fromEntries(
      keys.map((key, index) => [key, rate(index < 7 ? "agree" : "disagree")]),
    );
    expect(
      precisionByRule(results(keys.map((key) => issue(key, ["r"]))), {
        labels: seven,
      })[0],
    ).toMatchObject({ precision: 0.7, belowThreshold: false });
    const many = Array.from({ length: 1000 }, (_, index) => `m${index}`);
    const below = Object.fromEntries(
      many.map((key, index) => [key, rate(index < 699 ? "agree" : "disagree")]),
    );
    expect(
      precisionByRule(results(many.map((key) => issue(key, ["r"]))), {
        labels: below,
      })[0],
    ).toMatchObject({ precision: 0.699, belowThreshold: true });
  });
  test("a family issue counts for every constituent rule", () => {
    const rows = precisionByRule(results([issue("f", ["x", "y"])]), {
      labels: { f: rate("disagree") },
    });
    expect(rows.map((item: Row) => [item.rule, item.disagree])).toEqual([
      ["x", 1],
      ["y", 1],
    ]);
  });
  test("human ratings override agent ratings", () => {
    const rows = precisionByRule(
      results([issue("a", ["r"]), issue("b", ["r"])]),
      { labels: { a: rate("disagree", "agree"), b: rate("agree") } },
    );
    expect(rows[0]).toMatchObject({
      agree: 2,
      disagree: 0,
      source: "mixed",
    });
  });
});

test("mergeLabelTemplate preserves existing ratings", () => {
  const results = {
    targets: [
      { id: "t", topIssues: [issue("t:a", ["r"]), issue("t:b", ["s"])] },
    ],
  };
  const existing = { version: 1, labels: { "t:a": rate("disagree") } };
  const { labels, added } = mergeLabelTemplate(results, existing);
  expect(added).toBe(1);
  expect(labels.labels["t:a"]).toEqual(rate("disagree"));
  expect(labels.labels["t:b"]).toMatchObject({
    target: "t",
    rules: ["s"],
    agent: null,
    human: null,
  });
});

describe("generated section", () => {
  const doc = `# Title\n\nIntro prose.\n\n${GENERATED_START}\nold\n${GENERATED_END}\n\nOutro prose.\n`;
  test("replaces only the marked region", () => {
    const next = replaceGeneratedSection(doc, "NEW\n");
    expect(next).toContain("Intro prose.");
    expect(next).toContain("Outro prose.");
    expect(next).toContain("NEW");
    expect(next).not.toContain("old");
    expect(replaceGeneratedSection(next, "NEW\n")).toBe(next);
  });
  test("throws without markers", () => {
    expect(() => replaceGeneratedSection("# none", "x")).toThrow(/markers/);
  });
  test("renders run, precision and Top 10 tables", () => {
    const markdown = renderGenerated(
      {
        targets: [
          {
            id: "t",
            kind: "docs",
            aiBuilt: false,
            mode: "quick",
            topIssues: [issue("t:a", ["r"])],
            failures: [],
          },
        ],
      },
      { labels: { "t:a": rate("agree") } },
    );
    expect(markdown).toContain("### Precision by rule");
    expect(markdown).toContain("| `r` | 1 | 0 | 0 | 1 | 100% | agent |  |");
    expect(markdown).toContain("#### t");
  });
});

test("summarizeProbeSafety sums the probe ledger and detects non-safe sends", () => {
  const ledger = (sent: Record<string, number>) => ({
    policy: "third-party",
    origins: ["https://a.example"],
    requests: { sent, blocked: { POST: 2 } },
    blocked: {
      crossOriginNavigation: 1,
      formSubmission: 1,
      download: 0,
      popup: 0,
      windowOpen: 1,
      beforeunload: 0,
      permission: 0,
    },
    skipped: { destructive: 1 },
  });
  const clean = summarizeProbeSafety([
    {
      probe: {
        status: "partial",
        safety: ledger({ GET: 5, HEAD: 1 }),
        results: [
          { status: "completed", effects: ["dom"] },
          { status: "completed", skipped: "destructive name" },
          { status: "completed", skipped: "not clickable: hidden" },
          { status: "not-reached", skipped: "not reached: state budget" },
          { status: "timed-out", timeoutScope: "state" },
          { status: "timed-out", timeoutScope: "control" },
        ],
      },
    },
    { probe: undefined },
    {},
  ]);
  expect(clean).toEqual({
    probedPages: 1,
    probed: 2,
    skippedDestructive: 1,
    skippedOther: 1,
    notReached: 2,
    blocked: {
      crossOriginNavigation: 1,
      formSubmission: 1,
      download: 0,
      popup: 0,
      windowOpen: 1,
      beforeunload: 0,
      permission: 0,
    },
    sent: { GET: 5, HEAD: 1 },
    nonSafeSent: 0,
  });
  const leaked = summarizeProbeSafety([
    {
      probe: {
        status: "ran",
        safety: ledger({ GET: 1, POST: 2 }),
        results: [],
      },
    },
  ]);
  expect(leaked.nonSafeSent).toBe(2);
  const total = sumProbeSafety([clean, leaked]);
  expect(total.probedPages).toBe(2);
  expect(total.sent).toEqual({ GET: 6, HEAD: 1, POST: 2 });
  expect(total.blocked.crossOriginNavigation).toBe(2);
  expect(total.nonSafeSent).toBe(2);
});

test("probeTupleOverheadMs compares a probed tuple with its unprobed sibling", () => {
  const meta = (viewport: string, scheme: string, seconds: number) => ({
    state: { id: "page-1" },
    viewport: { name: viewport },
    colorScheme: scheme,
    timestamps: {
      startedAt: "2026-10-26T00:00:00.000Z",
      endedAt: new Date(
        Date.parse("2026-10-26T00:00:00.000Z") + seconds * 1000,
      ).toISOString(),
    },
  });
  expect(
    probeTupleOverheadMs(
      [
        meta("desktop", "light", 50),
        meta("desktop", "dark", 20),
        meta("mobile", "light", 9),
      ],
      [{ probe: { status: "ran", results: [] } }, {}, {}],
    ),
  ).toBe(30_000);
  expect(
    probeTupleOverheadMs([meta("desktop", "light", 5)], [{}]),
  ).toBeUndefined();
});
