import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../src/cli.js";
import { appendDecision } from "../src/decisions/log.js";
import {
  eligibleRecords,
  type FixSnapshot,
  refreshEligibility,
  selectTargets,
} from "../src/fix/check.js";
import { compareOccurrences, type Occurrence } from "../src/fix/compare.js";
import { repairPrompt } from "../src/fix/prompt.js";
import { type FixDependencies, runFix } from "../src/fix/run.js";
import type { CatalogFinding, FindingLineage } from "../src/review/catalog.js";
import { loadFindingNames } from "../src/review/names.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { unavailableAcceptance } from "../src/verify/acceptance.js";
import type { VerifyRunResult } from "../src/verify/run.js";
import { parseFindingBlocks } from "../src/verify/spec.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "idiom-fix-unit-"));
  directories.push(path);
  await mkdir(join(path, ".idiom"));
  return path;
}
function finding(id: number): Finding {
  return findingSchema.parse({
    id: `finding-${id}`,
    fingerprint: `fp-${id}`,
    createdAt: "2026-10-25T00:00:00.000Z",
    commit: "same-head",
    flow: "flow",
    state: "page",
    viewport: "desktop",
    layer: "deterministic",
    category: "target-size",
    severity: "minor",
    confidence: 1,
    rule: "idiom:minimum-target-size",
    evidence: { screenshots: [`page/crops/${id}.png`] },
    explanation: `#target${id} is 12×12; minimum 24`,
    acceptance: ["Hit area is at least 24×24 CSS pixels"],
    verification: {
      kind: "deterministic-check",
      check: "target-size",
      params: { selector: `#target${id}`, minimum: 24 },
    },
    status: "open",
  });
}
function occurrence(id: number, extra: Partial<Occurrence> = {}): Occurrence {
  return {
    coordinate: { state: "page", viewport: "desktop" },
    key: "page/desktop",
    fingerprint: `fp-${id}`,
    aliases: [],
    category: "target-size",
    severity: "minor",
    selector: `#target${id}`,
    rule: "idiom:minimum-target-size",
    ...extra,
  };
}
async function snapshot(
  projectDirectory: string,
  ids: number[],
  name = "run",
  rawIds = ids,
): Promise<FixSnapshot> {
  const runDirectory = join(projectDirectory, ".idiom/reports", name);
  const records: CatalogFinding[] = ids.map((id) => ({
    finding: finding(id),
    runDirectory,
    runId: name,
    findingsPath: join(runDirectory, "findings.json"),
  }));
  const lineages: FindingLineage[] = records.map((record) => ({
    id: record.finding.id,
    first: record,
    latest: record,
    occurrences: [record],
    ids: [record.finding.id, `legacy-${record.finding.id}`],
    fingerprints: [record.finding.fingerprint],
    identities: [
      { findingId: record.finding.id, fingerprint: record.finding.fingerprint },
    ],
  }));
  return {
    projectDirectory,
    runDirectory,
    records,
    occurrences: records.map(({ finding }) => finding),
    raw: rawIds.map((id) => occurrence(id)),
    eligible: ids.map((id) => occurrence(id)),
    configuration: "stable",
    designFile: join(projectDirectory, "DESIGN.md"),
    summary: {
      flow: "flow",
      runDirectory,
      reportPath: join(runDirectory, "report.md"),
      findings: [],
      groups: records.map(({ finding }) => ({
        id: `group-${finding.id}`,
        severity: finding.severity,
        category: finding.category,
        where: "page",
        problem: finding.explanation,
        fix: [],
        members: [
          {
            id: finding.id,
            severity: finding.severity,
            where: "page",
            coordinates: ["page/desktop"],
          },
        ],
        coordinates: ["page/desktop"],
        states: ["page"],
        viewports: ["desktop"],
        colorSchemes: [],
      })),
      issues: records.map(({ finding }) => ({
        id: `issue-${finding.id}`,
        severity: finding.severity,
        category: finding.category,
        groups: [`group-${finding.id}`],
        elements: 1,
        places: 1,
        findings: 1,
        primaryAction: false,
        rules: [],
        salience: 4,
        prominence: 1,
        score: 4,
        explanation: {
          areaRatio: 0,
          aboveFold: false,
          primaryRegion: false,
          primaryAction: false,
          states: 1,
          places: 1,
          geometryAvailable: false,
        },
      })),
      blocking: 0,
    },
    catalog: {
      projectDirectory,
      names: await loadFindingNames({ projectDirectory }),
      findings: records,
      runs: [
        {
          runId: name,
          runDirectory,
          findingsPath: join(runDirectory, "findings.json"),
          findings: records,
        },
      ],
      lineages,
    },
  };
}
function verified(
  findings: Finding[],
  fixed: number[],
  extra: Partial<VerifyRunResult> = {},
): VerifyRunResult {
  const verdicts = findings.map((finding) => ({
    finding,
    status: fixed.includes(Number(finding.id.slice(8)))
      ? ("fixed" as const)
      : ("reproduced" as const),
    reason: "measured",
    acceptance: unavailableAcceptance(finding.acceptance),
  }));
  return {
    reportPath: "/verify/before-after.md",
    htmlReportPath: "/verify/report.html",
    outputDirectory: "/verify",
    outcome: "fixed",
    passed: verdicts.every((v) => v.status === "fixed"),
    findingCount: findings.length,
    causes: [],
    verdicts,
    ...extra,
  };
}
async function executeSnapshots(
  project: string,
  snapshots: Array<FixSnapshot | Error>,
  fixed: number[],
  overrides: FixDependencies = {},
  maxRounds = 3,
  top = 5,
) {
  let cursor = 0;
  const agent = vi.fn(async () => ({ ok: true }));
  const verify = vi.fn(
    async (options: Parameters<NonNullable<FixDependencies["verify"]>>[0]) =>
      verified(parseFindingBlocks(await readFile(options.spec, "utf8")), fixed),
  );
  const result = await runFix({
    flow: "flow",
    project,
    maxRounds,
    top,
    dependencies: {
      head: async () => "same-head",
      agent,
      verify,
      check: async () => {
        const value = snapshots[cursor++];
        if (!value) throw new Error("unexpected check");
        if (value instanceof Error) throw value;
        return value;
      },
      ...overrides,
    },
  });
  if (result.dryRun) throw new Error("unexpected dry run");
  return { summary: result.summary, agent, verify };
}
test("initially clean runs no agent/verify and creates no fix session", async () => {
  const project = await fixture();
  const empty = await snapshot(project, []);
  const { summary, agent, verify } = await executeSnapshots(
    project,
    [empty],
    [],
  );
  expect(summary).toMatchObject({
    passed: true,
    reason: "clean",
    remaining: 0,
  });
  expect(agent).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  await expect(readdir(join(project, ".idiom/reports"))).rejects.toThrow();
});
test("partial batch progress with reproduced targets continues from fresh evidence", async () => {
  const project = await fixture();
  const a = await snapshot(project, [1, 2]);
  const b = await snapshot(project, [2], "second");
  const c = await snapshot(project, [], "final");
  let count = 0;
  const { summary, agent } = await executeSnapshots(project, [a, b, c], [], {
    verify: async (options) =>
      verified(
        parseFindingBlocks(await readFile(options.spec, "utf8")),
        ++count === 1 ? [1] : [2],
      ),
  });
  expect(summary).toMatchObject({ passed: true, reason: "clean" });
  expect(agent).toHaveBeenCalledTimes(2);
  expect(summary.rounds[0]?.verification?.passed).toBe(false);
  expect(summary.rounds[0]?.verifiedFixed).toEqual(["finding-1"]);
  expect(summary.rounds[1]?.beforeRun).toBe(b.runDirectory);
  expect(summary.changes.fixed).toHaveLength(2);
  expect(
    JSON.parse(
      await readFile(
        join(summary.sessionDirectory ?? "", "summary.json"),
        "utf8",
      ),
    ),
  ).toMatchObject({ reason: "clean" });
});
test("exact maxRounds bound with continuing progress", async () => {
  const project = await fixture();
  const snapshots = await Promise.all(
    [[1, 2, 3, 4], [2, 3, 4], [3, 4], [4]].map((ids, i) =>
      snapshot(project, ids, `run-${i}`),
    ),
  );
  const { summary, agent } = await executeSnapshots(
    project,
    snapshots,
    [1, 2, 3, 4],
    {},
    3,
    1,
  );
  expect(agent).toHaveBeenCalledTimes(3);
  expect(summary).toMatchObject({
    passed: false,
    reason: "max rounds reached with work remaining",
    remaining: 1,
  });
});
test("no-op terminates immediately with verification links", async () => {
  const project = await fixture();
  const a = await snapshot(project, [1]);
  const { summary, agent } = await executeSnapshots(project, [a, a], []);
  expect(summary.reason).toBe("no verified progress");
  expect(agent).toHaveBeenCalledTimes(1);
  expect(summary.rounds[0]?.verification?.reportPath).toBeTruthy();
});
test("any raw regression stops despite net reduction and presentation suppression", async () => {
  const project = await fixture();
  const a = await snapshot(project, [1, 2, 3]);
  const b = await snapshot(project, [], "after", [4]);
  const { summary, agent } = await executeSnapshots(project, [a, b], [1, 2, 3]);
  expect(summary.reason).toContain("regression");
  expect(summary.changes.fixed).toHaveLength(3);
  expect(summary.changes.introduced).toHaveLength(1);
  expect(summary.rounds[0]?.verifiedFixed).toHaveLength(3);
  expect(agent).toHaveBeenCalledTimes(1);
});
test("previous raw suppressed occurrences becoming visible are remaining work, not new regressions", async () => {
  const project = await fixture();
  const a = await snapshot(project, [1], "before", [1, 2]);
  const b = await snapshot(project, [2], "after", [2]);
  const { summary } = await executeSnapshots(project, [a, b], [1], {}, 1);
  expect(summary.changes.introduced).toHaveLength(0);
  expect(summary.remaining).toBe(1);
  expect(summary.reason).toContain("max rounds");
});
for (const mode of [
  "capture",
  "calibration",
  "unverifiable",
  "agent",
  "head",
  "drift",
])
  test(`failure stops and preserves session: ${mode}`, async () => {
    const project = await fixture();
    const before = await snapshot(project, [1]);
    const after = await snapshot(project, [], "after");
    const overrides: FixDependencies = {};
    if (mode === "calibration")
      overrides.verify = async () =>
        verified([], [], {
          verdicts: undefined,
          passed: false,
          causes: ["nondeterministic"],
        });
    if (mode === "unverifiable")
      overrides.verify = async () =>
        verified([], [], {
          verdicts: [
            {
              finding: finding(1),
              acceptance: unavailableAcceptance(finding(1).acceptance),
              status: "unverifiable",
              reason: "locus changed",
            },
          ],
        });
    if (mode === "agent")
      overrides.agent = async () => ({
        ok: false,
        diagnostic: "partial edits then failed",
      });
    if (mode === "head") {
      let n = 0;
      overrides.head = async () => String(n++);
    }
    if (mode === "drift") after.configuration = "weakened";
    const { summary, agent } = await executeSnapshots(
      project,
      [before, mode === "capture" ? new Error("failed tuple coverage") : after],
      [1],
      overrides,
    );
    expect(summary.passed).toBe(false);
    expect(summary.reason).toContain("failed");
    expect(summary.rounds).toHaveLength(1);
    expect(summary.rounds[0]?.verifiedFixed).toHaveLength(0);
    if (mode !== "agent") expect(agent).toHaveBeenCalledTimes(1);
    expect(await readFile(summary.summaryPath ?? "", "utf8")).toContain(
      "failed",
    );
  });
test("rejected instance/legacy and standing decisions are filtered before top and siblings", async () => {
  const project = await fixture();
  const a = await snapshot(project, [1, 2, 3]);
  await appendDecision({
    projectDirectory: project,
    finding: { ...finding(1), id: "legacy-finding-1" },
    decision: "reject",
    scope: "instance",
  });
  await appendDecision({
    projectDirectory: project,
    finding: { ...finding(2), commit: "older-head" },
    decision: "reject",
    scope: "rule",
  });
  await refreshEligibility(a);
  const eligible = await eligibleRecords(a);
  const selected = selectTargets(a, eligible, 1);
  expect(selected.map((r) => r.finding.id)).toEqual(["finding-3"]);
  expect(a.eligible).toHaveLength(1);
  const prompt = await repairPrompt(a, selected, eligible);
  expect(prompt).not.toContain("finding-1");
  expect(prompt).not.toContain("finding-2");
  expect(prompt).toContain("#target3");
  expect(prompt).toContain("12×12");
  expect(prompt).toContain("minimum-target-size");
  expect(prompt).toContain("/crops/3.png");
  await appendDecision({
    projectDirectory: project,
    finding: finding(2),
    decision: "accept",
    scope: "instance",
  });
  expect((await eligibleRecords(a)).map((r) => r.finding.id)).toEqual([
    "finding-2",
    "finding-3",
  ]);
});
test("stale instance rejection on another commit does not hide current repair work", async () => {
  const project = await fixture();
  const a = await snapshot(project, [1]);
  await appendDecision({
    projectDirectory: project,
    finding: { ...finding(1), commit: "old" },
    decision: "reject",
    scope: "instance",
  });
  expect(await eligibleRecords(a)).toHaveLength(1);
});
test("dry run returns exact prompt with no agent/verify/session and no source writes", async () => {
  const project = await fixture();
  const a = await snapshot(project, [1]);
  const agent = vi.fn();
  const verify = vi.fn();
  const expected = await repairPrompt(a, a.records, a.records);
  expect(
    await runFix({
      flow: "flow",
      dryRun: true,
      dependencies: { check: async () => a, agent, verify },
    }),
  ).toEqual({ dryRun: true, prompt: expected });
  expect(agent).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  await expect(readdir(join(project, ".idiom/reports"))).rejects.toThrow();
});
test("unselectable eligible work is never called clean", async () => {
  const project = await fixture();
  const a = await snapshot(project, [1]);
  a.records = [];
  const { summary, agent } = await executeSnapshots(project, [a], []);
  expect(summary).toMatchObject({
    passed: false,
    reason: "no selectable eligible findings",
  });
  expect(agent).not.toHaveBeenCalled();
});
test("comparison partitions exact viewport/scheme/combination occurrences using aliases", () => {
  const before = [
    occurrence(1),
    occurrence(1, { key: "page/mobile" }),
    occurrence(2, { key: "page/desktop/dark#one" }),
    occurrence(2, { key: "page/desktop/dark#two" }),
  ];
  const after = [
    occurrence(99, { fingerprint: "new-fp", aliases: ["fp-1"] }),
    occurrence(1, { key: "page/mobile" }),
    occurrence(2, { key: "page/desktop/light#one" }),
    occurrence(2, { key: "page/desktop/dark#two" }),
  ];
  const comparison = compareOccurrences(before, after);
  expect(comparison.fixed).toEqual([before[2]]);
  expect(comparison.stillOpen).toHaveLength(3);
  expect(comparison.introduced).toEqual([after[2]]);
});
test("resurfacing initial work is not counted as cumulative progress", () => {
  const initial = [occurrence(1), occurrence(2)];
  const middle = [occurrence(2)];
  const final = [occurrence(1)];
  expect(compareOccurrences(initial, middle).fixed).toHaveLength(1);
  expect(compareOccurrences(middle, final).introduced).toHaveLength(1);
  expect(compareOccurrences(initial, final).fixed).toEqual([occurrence(2)]);
});

test("verification blockers fail even when a mixed batch proves partial progress", async () => {
  const project = await fixture();
  const before = await snapshot(project, [1, 2]);
  const after = await snapshot(project, [2], "after");
  const { summary } = await executeSnapshots(project, [before, after], [1], {
    verify: async (options) =>
      verified(parseFindingBlocks(await readFile(options.spec, "utf8")), [1], {
        newBlockers: ["new blocker during verification"],
      }),
  });
  expect(summary.passed).toBe(false);
  expect(summary.rounds[0]?.verifiedFixed).toEqual(["finding-1"]);
  expect(summary.rounds[0]?.errors).toContain(
    "new blocker during verification",
  );
});

test("failed agent plus failed diagnostic recheck retains both causes", async () => {
  const project = await fixture();
  const before = await snapshot(project, [1]);
  const { summary } = await executeSnapshots(
    project,
    [before, new Error("capture unavailable")],
    [],
    {
      agent: async () => ({
        ok: false,
        diagnostic: "agent failed after edits",
      }),
    },
  );
  expect(summary.rounds[0]?.errors).toEqual([
    "agent failed after edits",
    "recheck failed: capture unavailable",
  ]);
});

test("CLI defaults select Claude, five targets, three rounds and print failure summary first", async () => {
  const project = await fixture();
  const a = await snapshot(project, [1, 2, 3, 4, 5, 6]);
  let output = "";
  let errors = "";
  const requests: string[] = [];
  const code = await run(["node", "idiom", "fix", "flow"], {
    stdout: (s) => {
      output += s;
    },
    stderr: (s) => {
      errors += s;
    },
    fix: {
      check: async () => a,
      head: async () => "head",
      agent: async (request) => {
        expect(request.agent).toBe("claude");
        requests.push(request.prompt);
        return { ok: true };
      },
      verify: async (options) =>
        verified(parseFindingBlocks(await readFile(options.spec, "utf8")), []),
    },
  });
  expect(code).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.match(/# Finding /g)).toHaveLength(5);
  expect(errors).toContain("Fix round 1/3");
  expect(errors).toContain("fix failed: no verified progress");
  expect(output).toContain("Fix flow: no verified progress");
});

for (const status of [
  "open",
  "approved",
  "rejected",
  "ticketed",
  "verified-fixed",
  "verify-failed",
] as const) {
  test(`${status} uses the same eligibility for records, occurrences, and prompt siblings`, async () => {
    const project = await fixture();
    const current = await snapshot(project, [1, 2]);
    const candidate = current.records[0];
    if (!candidate) throw new Error("missing candidate");
    candidate.finding.status = status;
    await refreshEligibility(current);
    const records = await eligibleRecords(current);
    const open = status === "open" || status === "approved";
    expect(
      records.some((record) => record.finding.id === candidate.finding.id),
    ).toBe(open);
    expect(
      current.eligible.some(
        (item) => item.fingerprint === candidate.finding.fingerprint,
      ),
    ).toBe(open);
    expect(current.raw).toHaveLength(2);
    const selected = selectTargets(current, records, 1);
    expect(selected[0]?.finding.id).toBe(open ? "finding-1" : "finding-2");
    const prompt = await repairPrompt(current, selected, records);
    if (!open) expect(prompt).not.toContain("finding-1");
  });
}
/** Fold the issues of `ids` into one root-cause issue at the first one's rank. */
function withCause(snap: FixSnapshot, ids: number[]): FixSnapshot {
  const issues = snap.summary.issues ?? [];
  const members = ids.map((id) => `group-finding-${id}`);
  const at = issues.findIndex((issue) =>
    members.includes(issue.groups[0] ?? ""),
  );
  const first = issues[at];
  if (first === undefined) throw new Error("no issue to fold");
  const cause = {
    ...first,
    groups: members,
    rootCause: {
      id: "cause-000000000001",
      kind: "token" as const,
      key: "--control-scale",
      cause: "`--control-scale` is not applied: 3 controls render 4px",
      confidence: 0.9,
      evidence: ["3 of 3 measured values come from `var(--control-scale)`"],
      fix: "Define `--control-scale` where these elements inherit it",
      symptoms: ids.map((id) => ({
        group: `group-finding-${id}`,
        category: "target-size",
        measurement: "m",
        findings: [
          {
            id: `finding-${id}`,
            fingerprint: `fp-${id}`,
            status: "open" as const,
          },
        ],
      })),
      counts: { symptoms: ids.length, findings: ids.length },
    },
  };
  const rest = issues.filter(
    (issue) => !members.includes(issue.groups[0] ?? ""),
  );
  rest.splice(at, 0, cause);
  return { ...snap, summary: { ...snap.summary, issues: rest } };
}
test("a root cause is selected whole past --top and never split after plain findings", async () => {
  const project = await fixture();
  const leading = withCause(await snapshot(project, [1, 2, 3, 4]), [1, 2, 3]);
  const ids = (selected: CatalogFinding[]) =>
    selected.map(({ finding }) => finding.id);
  expect(ids(selectTargets(leading, leading.records, 2))).toEqual([
    "finding-1",
    "finding-2",
    "finding-3",
  ]);
  const trailing = withCause(await snapshot(project, [1, 2, 3, 4]), [2, 3]);
  // finding-1 fills first; the cause is never split, so it waits.
  expect(ids(selectTargets(trailing, trailing.records, 5))).toEqual([
    "finding-1",
  ]);
  const prompt = await repairPrompt(
    leading,
    selectTargets(leading, leading.records, 2),
    leading.records,
  );
  expect(prompt).toContain("# Root cause cause-000000000001");
  expect(prompt).toContain(
    "Make one change to the shared cause; every symptom below must clear.",
  );
  expect(prompt.indexOf("# Root cause")).toBeLessThan(
    prompt.indexOf("# Finding finding-1"),
  );
  expect(
    await repairPrompt(
      trailing,
      selectTargets(trailing, trailing.records, 5),
      trailing.records,
    ),
  ).not.toContain("# Root cause");
});
test("a root-cause round is verified only when every symptom is proven fixed", async () => {
  const project = await fixture();
  const before = withCause(await snapshot(project, [1, 2]), [1, 2]);
  const partial = withCause(await snapshot(project, [2], "second"), [2]);
  const { summary } = await executeSnapshots(
    project,
    [before, partial],
    [1],
    {},
    1,
  );
  expect(summary.rounds[0]?.cause).toEqual({
    id: "cause-000000000001",
    cause: "`--control-scale` is not applied: 3 controls render 4px",
    findings: ["finding-1", "finding-2"],
    verified: false,
  });
  const project2 = await fixture();
  const all = withCause(await snapshot(project2, [1, 2]), [1, 2]);
  const clean = await snapshot(project2, [], "final");
  const done = await executeSnapshots(project2, [all, clean], [1, 2], {}, 1);
  expect(done.summary.rounds[0]?.cause?.verified).toBe(true);
  const { renderFixSummary } = await import("../src/fix/report.js");
  expect(renderFixSummary(done.summary)).toContain(
    "Root cause cause-000000000001: verified (2/2 symptoms cleared)",
  );
  expect(renderFixSummary(summary)).toContain(
    "Root cause cause-000000000001: partial (1/2)",
  );
});
