import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error The field-test helpers are plain Node ESM without declarations.
import * as lib from "../scripts/field-test-lib.mjs";

const {
  ALLOWED_KINDS,
  countProbeTimeouts,
  classifyFailure,
  FEEL_RULES,
  feelIssues,
  feelPrecision,
  GENERATED_END,
  GENERATED_START,
  mergeLabelTemplate,
  precisionByRule,
  replaceGeneratedSection,
  renderGenerated,
  summarizeCheckResult,
  summarizeHeldReplays,
  sumHeldReplays,
  probeTupleOverheadMs,
  summarizeProbeSafety,
  summarizeQuickResult,
  sumProbeSafety,
  uniqueFeelKeys,
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
  local?: unknown;
  stack?: unknown;
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
    expect(() => validateTargets(targets)).toThrow(/repo or local target/);
    expect(() => validateTargets(validTargets().slice(0, 7))).toThrow(/8–20/);
  });
  const local = {
    path: "test/fixtures/field-app",
    dev: ["node server.mjs --port 4410"],
    server: { readyUrl: "http://127.0.0.1:4410/" },
  };
  test("accepts up to 20 targets, the extra kinds and an optional stack", () => {
    const targets = validTargets();
    for (let index = 0; targets.length < 20; index += 1)
      targets.push(
        target(`spa-${index}`, "interactive-spa", { stack: "SvelteKit" }),
      );
    expect(validateTargets(targets)).toHaveLength(20);
    expect(ALLOWED_KINDS).toEqual(
      expect.arrayContaining(["interactive-spa", "field-app"]),
    );
    targets.push(target("spa-extra", "interactive-spa"));
    expect(() => validateTargets(targets)).toThrow(/8–20/);
    const typed = validTargets();
    typed.push(target("spa", "interactive-spa", { stack: 3 }));
    expect(() => validateTargets(typed)).toThrow(/stack/);
    const unknown = validTargets();
    unknown.push(target("odd", "kiosk"));
    expect(() => validateTargets(unknown)).toThrow(/unknown kind/);
  });
  test("a local target counts as the repo-backed target", () => {
    const targets = validTargets().map(({ repo: _repo, ...rest }) => rest);
    targets.push(target("field-app", "field-app", { local }));
    expect(validateTargets(targets)).toHaveLength(10);
  });
  test("local needs exactly one of repo and local, and a path inside the repo", () => {
    const both = validTargets();
    both[2] = { ...(both[2] as Target), local };
    expect(() => validateTargets(both)).toThrow(/exactly one/);
    for (const path of ["/tmp/app", "../outside", "test/../../outside"]) {
      const targets = validTargets();
      targets.push(
        target("field-app", "field-app", { local: { ...local, path } }),
      );
      expect(() => validateTargets(targets), path).toThrow(/inside the repo/);
    }
    const noDev = validTargets();
    noDev.push(
      target("field-app", "field-app", { local: { ...local, dev: [] } }),
    );
    expect(() => validateTargets(noDev)).toThrow(/dev/);
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

describe("feel issues", () => {
  const quickIssue = (index: number, rule: string, extra: object = {}) => ({
    id: `quick:run-1:group-${index}`,
    severity: "major",
    category: rule.replace("idiom:", ""),
    rule,
    rules: [rule],
    score: 20 - index,
    representative: {
      selector: `#c${index}`,
      cropPath: `/runs/x/page-1/desktop/light/crops/c${index}.png`,
      finding: {
        state: "page-1",
        viewport: "desktop",
        explanation: `finding ${index}`,
        evidence: {
          timeline: { id: `slow-probe-${index}`, artifact: "t.json" },
          filmstrip: {
            sheet: `page-1/desktop/light/crops/f${index}-filmstrip.png`,
          },
        },
      },
      ...extra,
    },
  });
  test("quick: keeps feel issues at every rank with Top-10 keys and evidence", () => {
    const issues = Array.from({ length: 14 }, (_, index) =>
      quickIssue(
        index,
        index === 2 || index === 12
          ? "idiom:double-submit"
          : "idiom:orphan-word",
      ),
    );
    const content = { runDirectory: "/runs/x", issues, counts: {} };
    const summary = summarizeQuickResult(content, {
      elapsedMs: 1,
      target: "site",
    });
    expect(
      summary.feelIssues.map((item: { rank: number }) => item.rank),
    ).toEqual([3, 13]);
    const [top, below] = summary.feelIssues;
    expect(top.key).toBe(summary.topIssues[2].key);
    expect(below).toMatchObject({
      key: "site:group-12",
      rules: ["idiom:double-submit"],
      timeline: "slow-probe-12",
      evidence: "page-1/desktop/light/crops/f12-filmstrip.png",
      state: "page-1",
      viewport: "desktop",
    });
  });
  test("per-state runs: a colliding group id gets the state as a suffix", () => {
    const keys = uniqueFeelKeys([
      { key: "app:group-1", state: "route-a" },
      { key: "app:group-2", state: "route-a" },
      { key: "app:group-1", state: "route-b" },
      { key: "app:group-1", state: "route-b" },
    ]).map((item: { key: string }) => item.key);
    expect(keys).toEqual([
      "app:group-1",
      "app:group-2",
      "app:group-1@route-b",
      "app:group-1@2",
    ]);
  });
  test("check: resolves the group's member finding for the timeline", () => {
    const issues = [
      {
        id: "group-a",
        severity: "major",
        rules: ["idiom:loading-state-missing"],
        groups: ["group-a"],
        explanation: { selector: "#save" },
      },
      {
        id: "group-b",
        severity: "minor",
        rules: ["idiom:orphan-word"],
        groups: ["group-b"],
      },
    ];
    const feel = feelIssues(issues, {
      target: "app",
      mode: "check",
      groups: [
        {
          id: "group-a",
          where: "route-settings/desktop",
          problem: "Clicking #save showed nothing",
          filmstrip:
            "/x/.idiom/reports/run-1/route-settings/desktop/crops/f-filmstrip.png",
          members: [{ id: "finding-9" }],
        },
      ],
      findings: [{ id: "finding-9", timeline: { id: "slow-probe-2" } }],
    });
    expect(feel).toEqual([
      expect.objectContaining({
        key: "app:group-a",
        rank: 1,
        state: "route-settings",
        viewport: "desktop",
        selector: "#save",
        timeline: "slow-probe-2",
        evidence: "route-settings/desktop/crops/f-filmstrip.png",
      }),
    ]);
  });
  test("summarizeHeldReplays counts queued and run replays and slow-replay tuples", () => {
    const documents = [
      {
        probe: {
          heldReplay: { queued: 3, ran: 2 },
          failureReplay: { queued: 1, ran: 1 },
        },
      },
      { probe: { heldReplay: { queued: 0, ran: 0 } } },
      {},
    ];
    const timelines = [
      { actions: [{ source: "probe" }, { source: "slow-replay" }] },
      { actions: [{ source: "probe" }] },
      undefined,
    ];
    const summary = summarizeHeldReplays(documents, timelines);
    expect(summary).toEqual({
      heldQueued: 3,
      heldRan: 2,
      failureQueued: 1,
      failureRan: 1,
      tuplesWithSlowReplay: 1,
    });
    expect(sumHeldReplays([summary, summary]).heldQueued).toBe(6);
  });
  test("mergeLabelTemplate adds feel slots once and never overwrites", () => {
    const results = {
      targets: [
        {
          id: "t",
          topIssues: [issue("t:a", ["idiom:double-submit"])],
          feelIssues: [
            issue("t:a", ["idiom:double-submit"]),
            issue("t:z", ["idiom:motion-snap"]),
          ],
        },
      ],
    };
    const existing = { version: 1, labels: { "t:z": rate("agree") } };
    const { labels, added } = mergeLabelTemplate(results, existing);
    expect(added).toBe(1);
    expect(labels.labels["t:z"]).toEqual(rate("agree"));
    expect(labels.labels["t:a"]).toMatchObject({ agent: null, human: null });
  });
  test("feelPrecision: null at n=0, public/field-app split and the gate", () => {
    const feel = (prefix: string, count: number, rule: string) =>
      Array.from({ length: count }, (_, index) =>
        issue(`${prefix}:${rule}:${index}`, [rule]),
      );
    const results = {
      targets: [
        {
          id: "spa",
          kind: "interactive-spa",
          feelIssues: feel("spa", 2, "idiom:loading-state-missing"),
        },
        {
          id: "app",
          kind: "field-app",
          feelIssues: [
            ...feel("app", 4, "idiom:loading-state-missing"),
            ...feel("app", 4, "idiom:double-submit"),
          ],
        },
      ],
    };
    const labels = { labels: {} as Record<string, unknown> };
    for (const target of results.targets)
      for (const item of target.feelIssues)
        labels.labels[item.key] = rate("agree");
    labels.labels["app:idiom:loading-state-missing:0"] = rate("disagree");
    labels.labels["app:idiom:double-submit:0"] = rate("unsure");
    const rows = feelPrecision(results, labels);
    expect(rows.map((row: { rule: string }) => row.rule)).toEqual(FEEL_RULES);
    const loading = rows.find(
      (row: { rule: string }) => row.rule === "idiom:loading-state-missing",
    );
    expect(loading.public).toMatchObject({
      agree: 2,
      disagree: 0,
      n: 2,
      precision: 1,
    });
    expect(loading.fieldApp).toMatchObject({
      agree: 3,
      disagree: 1,
      n: 4,
      precision: 0.75,
    });
    expect(loading.combined).toMatchObject({ agree: 5, disagree: 1, n: 6 });
    expect(loading.met).toBe(true);
    const double = rows.find(
      (row: { rule: string }) => row.rule === "idiom:double-submit",
    );
    expect(double.combined).toMatchObject({
      agree: 3,
      unsure: 1,
      n: 3,
      precision: 1,
    });
    expect(double.met).toBe(false);
    const shift = rows.find(
      (row: { rule: string }) => row.rule === "idiom:interaction-shift",
    );
    expect(shift.combined).toMatchObject({ n: 0, precision: null });
    expect(shift.met).toBe(false);
  });
  test("feelPrecision: exactly 80% at n=5 meets the gate; 4 of 5 below n does not", () => {
    const rule = "idiom:motion-snap";
    const issues = Array.from({ length: 5 }, (_, index) =>
      issue(`a:${index}`, [rule]),
    );
    const labels = {
      labels: Object.fromEntries(
        issues.map((item, index) => [
          item.key,
          rate(index === 0 ? "disagree" : "agree"),
        ]),
      ),
    };
    const row = (results: object) =>
      feelPrecision(results, labels).find(
        (item: { rule: string }) => item.rule === rule,
      );
    expect(
      row({ targets: [{ id: "a", kind: "field-app", feelIssues: issues }] })
        .met,
    ).toBe(true);
    expect(
      row({
        targets: [
          { id: "a", kind: "field-app", feelIssues: issues.slice(0, 4) },
        ],
      }).met,
    ).toBe(false);
  });
  test("renders the feel table with unmeasured rules", () => {
    const markdown = renderGenerated(
      {
        targets: [
          {
            id: "app",
            kind: "field-app",
            aiBuilt: false,
            mode: "local",
            topIssues: [],
            feelIssues: [issue("app:a", ["idiom:double-submit"])],
            failures: [],
          },
        ],
      },
      { labels: { "app:a": rate("agree") } },
    );
    expect(markdown).toContain(
      "### Feel rules (all findings, not just Top 10)",
    );
    expect(markdown).toContain(
      "| `idiom:double-submit` | n=0 (unmeasured) | n=1 / 100% | n=1 / 100% | no |",
    );
    expect(markdown).toContain(
      "| `idiom:retry-blocked` | n=0 (unmeasured) | n=0 (unmeasured) | n=0 (unmeasured) | no |",
    );
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
