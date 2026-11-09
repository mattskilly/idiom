import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, expect, test } from "vitest";
import { observePage } from "../src/checks/observe.js";
import { run } from "../src/cli.js";
import {
  type CheckSummary,
  checkCommand,
  renderCheckSummary,
} from "../src/commands/check.js";
import { learnCommand } from "../src/commands/learn.js";
import {
  learnCoveredCommand,
  learnFixtureCommand,
  learnListCommand,
} from "../src/commands/learn-misses.js";
import {
  appendDecisionBatch,
  readRawDecisionLog,
} from "../src/decisions/log.js";
import { type DigestRecord, writeDigestRecord } from "../src/digest/record.js";
import {
  humanFoundLine,
  LEARNED_RULES,
  missStatuses,
  readLearnedLog,
  relativeAge,
  summarizeMisses,
} from "../src/learn/misses.js";
import { renderReviewHtmlReport } from "../src/review/html-report.js";
import { renderReport } from "../src/review/report.js";
import type { LearnedEntry } from "../src/schemas/learned.js";
import { projectSchema } from "../src/schemas/project.js";
import { storedRun, studioProject } from "./stored-run-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const now = new Date("2026-11-06T12:00:00.000Z");
const recordedAt = "2026-11-04T12:00:00.000Z";
const later = "2026-11-05T12:00:00.000Z";
const runId = "2026-11-05T12-00-00-000Z";
function entry(overrides: Partial<LearnedEntry> = {}): LearnedEntry {
  return {
    version: 1,
    id: "learned-1",
    recordedAt,
    flow: "studio-lab",
    state: "editor",
    observation: "the dots should be 8px",
    kind: "component",
    target: { file: ".idiom/project.json", selector: ".dot" },
    entry: { width: 8, height: 8 },
    ...overrides,
  };
}
async function temp() {
  const project = await mkdtemp(join(tmpdir(), "idiom-misses-"));
  directories.push(project);
  await mkdir(join(project, ".idiom"));
  return project;
}
async function log(project: string, entries: LearnedEntry[]) {
  const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(join(project, ".idiom", "learned.jsonl"), content);
  return content;
}
async function evidence(project: string, items: unknown[], id = runId) {
  const directory = join(project, ".idiom", "reports", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "findings.json"), JSON.stringify(items));
  return directory;
}
const finding = {
  flow: "studio-lab",
  state: "editor",
  rule: "idiom:component-size-mismatch",
  createdAt: later,
};
function digest(): DigestRecord {
  return {
    version: 1,
    flow: "studio-lab",
    runId,
    completedAt: later,
    commit: "abc",
    dirty: false,
    reportPath: "report.md",
    configHash: "checks",
    scope: "full",
    coverage: { selected: 1, captured: ["editor/desktop"], problems: [] },
    occurrences: [
      {
        id: "finding-1",
        fingerprint: "f",
        where: "editor/desktop",
        state: "editor",
        viewport: "desktop",
        category: "component-size",
        rule: finding.rule,
        severity: "major",
        problem: "Dots too small",
        disposition: "acknowledged",
        score: 8,
        impactReasons: [],
      },
    ],
  };
}

test("missing and empty logs have no summary; strict parsing identifies corrupt lines", async () => {
  const project = await temp();
  expect(await summarizeMisses({ projectDirectory: project })).toBeUndefined();
  await writeFile(join(project, ".idiom", "learned.jsonl"), "\n");
  expect(await summarizeMisses({ projectDirectory: project })).toBeUndefined();
  await writeFile(
    join(project, ".idiom", "learned.jsonl"),
    `${JSON.stringify(entry())}\nnot json\n{}\n`,
  );
  expect(await summarizeMisses({ projectDirectory: project })).toMatchObject({
    logged: 1,
    open: 1,
  });
  await expect(readLearnedLog(project, { strict: true })).rejects.toThrow(
    "line 2",
  );
});

test("counts runs, marks and open entries, using the newest logged date including marks", async () => {
  const project = await temp();
  await log(project, [
    entry(),
    entry({ id: "learned-2", kind: "invariant" }),
    entry({
      id: "learned-3",
      kind: "glossary",
      recordedAt: "2026-11-04T13:00:00+01:00",
      covered: { by: "copy test", at: later },
    }),
    entry({
      id: "learned-4",
      kind: "ruling",
      recordedAt: "2026-11-03T12:00:00.000Z",
    }),
  ]);
  await evidence(project, [
    finding,
    {
      ...finding,
      rule: "idiom:layout-invariants:height",
      createdAt: "2026-11-03T12:00:00.000Z",
    },
    null,
    { rule: "broken" },
  ]);
  const summary = await summarizeMisses({ projectDirectory: project });
  expect(summary).toMatchObject({
    logged: 4,
    covered: 2,
    coveredByRun: 1,
    coveredByMark: 1,
    open: 2,
    latest: recordedAt,
  });
  expect(summary?.openEntries.map((entry) => entry.id)).toEqual([
    "learned-2",
    "learned-4",
  ]);
  if (!summary) throw new Error("expected a summary");
  expect(humanFoundLine(summary, now)).toBe(
    "Human-found misses: 4 logged, 2 now covered by a rule, 2 open (latest: 2 days ago).",
  );
});

test.each([
  [recordedAt, "2 days ago"],
  [later, "1 day ago"],
  [now.toISOString(), "today"],
  ["2026-11-07T12:00:00.000Z", "today"],
  ["2026-11-06T00:00:00.000Z", "today"],
])("relative age of %s is %s", (at, expected) =>
  expect(relativeAge(at, now)).toBe(expected),
);

test.each([
  { state: "other" },
  { flow: "other" },
  { rule: "idiom:other" },
  { createdAt: recordedAt },
  { createdAt: "2026-11-03T12:00:00.000Z" },
])(
  "coverage requires a strictly later matching flow/state/rule: %j",
  async (changes) => {
    const project = await temp();
    await log(project, [entry()]);
    await evidence(project, [{ ...finding, ...changes }]);
    expect(await summarizeMisses({ projectDirectory: project })).toMatchObject({
      open: 1,
      covered: 0,
    });
    await evidence(project, [finding]);
    expect(await summarizeMisses({ projectDirectory: project })).toMatchObject({
      open: 0,
      coveredByRun: 1,
    });
  },
);

test("digest-only occurrences cover misses; corrupt findings and historical digests are harmless", async () => {
  const project = await temp();
  await log(project, [entry()]);
  const directory = await evidence(project, []);
  await writeFile(join(directory, "findings.json"), "broken");
  await writeDigestRecord(directory, digest());
  await writeFile(
    join(
      await evidence(project, [], "2026-11-06T12-00-00-000Z"),
      "digest.json",
    ),
    "broken",
  );
  expect(await summarizeMisses({ projectDirectory: project })).toMatchObject({
    coveredByRun: 1,
  });
});

test("prefix rules, marks, current evidence and earliest timestamps determine coverage", async () => {
  const project = await temp();
  const entries = [
    entry({ kind: "invariant" }),
    entry({ id: "learned-2", covered: { by: "fixture", at: later } }),
  ];
  const evidenceItems = [
    {
      flow: "studio-lab",
      state: "editor",
      rule: "idiom:layout-invariants:width",
      at: later,
      runId,
    },
  ];
  expect(missStatuses(entries, evidenceItems)).toMatchObject([
    { status: "covered", via: "run", rule: "layout-invariants" },
    { status: "covered", via: "mark", by: "fixture" },
  ]);
  await log(project, entries);
  expect(
    await summarizeMisses({ projectDirectory: project, extra: evidenceItems }),
  ).toMatchObject({ covered: 2 });
  await evidence(project, [
    {
      ...finding,
      rule: evidenceItems[0]?.rule,
      createdAt: "2026-11-04T14:00:00.000Z",
    },
  ]);
  const { collectMissEvidence } = await import("../src/learn/misses.js");
  expect(
    missStatuses(
      entries,
      await collectMissEvidence(project, entries, evidenceItems),
    )[0],
  ).toMatchObject({ at: "2026-11-04T14:00:00.000Z" });
});

test("rule table matches rule strings emitted by shipped checks", async () => {
  const rules = [
    ["component", "component-size", "idiom:component-size-mismatch"],
    ["invariant", "layout-invariants", "idiom:layout-invariants:width"],
    ["glossary", "copy-lint", "idiom:glossary-term"],
    ["mirrored", "mirrored-control", "idiom:mirrored-asymmetry"],
  ] as const;
  for (const [kind, file, rule] of rules) {
    expect(LEARNED_RULES[kind].matches(rule)).toBe(true);
    expect(
      await readFile(
        new URL(`../src/checks/${file}.ts`, import.meta.url),
        "utf8",
      ),
    ).toContain(kind === "invariant" ? "idiom:layout-invariants:" : rule);
  }
});

test("mark rewrites one line, preserves others and next learned id, and wins over runs", async () => {
  const { project } = await studioProject(directories);
  const first = JSON.stringify(entry(), null, 0).replace(
    '{"version":',
    '{ "version":',
  );
  const second = JSON.stringify(entry({ id: "learned-2" }));
  const path = join(project, ".idiom", "learned.jsonl");
  await writeFile(path, `${first}\n${second}\n`);
  await learnCoveredCommand({
    project,
    id: "learned-2",
    by: " fixtures/dots ",
    clock: () => now,
  });
  const lines = (await readFile(path, "utf8")).split("\n");
  expect(lines[0]).toBe(first);
  expect(lines).toHaveLength(3);
  expect(JSON.parse(lines[1] ?? "")).toMatchObject({
    covered: { by: "fixtures/dots", at: now.toISOString() },
  });
  await expect(
    learnCoveredCommand({ project, id: "learned-2", by: "other" }),
  ).rejects.toThrow("already marked");
  await expect(
    learnCoveredCommand({ project, id: "learned-999", by: "other" }),
  ).rejects.toThrow("unknown learned id");
  await expect(
    learnCoveredCommand({ project, id: "learned-1", by: " " }),
  ).rejects.toThrow("nonblank");
  await evidence(project, [finding]);
  expect((await learnListCommand({ project })).statuses[1]).toMatchObject({
    via: "mark",
  });
  expect(
    await learnCommand({
      project,
      state: "editor",
      observation: "the pills should be 8px",
      selectors: [".pill"],
      yes: true,
    }),
  ).toMatchObject({ id: "learned-3" });
});

async function cli(project: string, args: string[]) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await run(["node", "idiom", ...args, "--project", project], {
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
    learn: { clock: () => now },
    review: { now: () => now },
    report: { launch: async () => undefined },
  });
  return { code, text: output.join(""), error: errors.join("") };
}

test("learn CLI lists statuses/JSON, marks entries, and validates exclusive modes", async () => {
  const { project } = await studioProject(directories);
  expect((await cli(project, ["learn", "--list"])).text).toContain(
    "No human-found misses logged yet",
  );
  await log(project, [entry(), entry({ id: "learned-2", kind: "ruling" })]);
  expect(
    (await cli(project, ["learn", "--covered", "learned-2", "--by", "fixture"]))
      .text,
  ).toContain("Marked learned-2 covered by fixture");
  const listed = await cli(project, ["learn", "--list"]);
  expect(listed.code).toBe(0);
  expect(listed.text).toContain("learned-1  open");
  expect(listed.text).toContain("learned-2  covered by fixture (marked");
  const json = JSON.parse(
    (await cli(project, ["learn", "--list", "--json"])).text,
  );
  expect(json.summary).toMatchObject({ logged: 2, open: 1, coveredByMark: 1 });
  expect(json.statuses).toHaveLength(2);
  for (const args of [
    [],
    ["--list", "observation"],
    ["--list", "--covered", "learned-1"],
    ["--by", "x"],
    ["--list", "--out", "x"],
    ["observation", "--json"],
    ["--covered", "learned-1"],
    ["--fixture", "learned-1"],
  ]) {
    expect(
      (await cli(project, ["learn", ...args])).code,
      args.join(" "),
    ).not.toBe(0);
  }
});

async function tree(path: string): Promise<Record<string, string>> {
  const files = await readdir(path, { recursive: true, withFileTypes: true });
  const result: Record<string, string> = {};
  for (const file of files.filter((file) => file.isFile())) {
    const full = join(file.parentPath, file.name);
    result[full.slice(path.length + 1)] = (await readFile(full)).toString(
      "base64",
    );
  }
  return result;
}

test("fixture exports only two files, retaining captured DOM and provenance without modifying the project", async () => {
  const { project, commit } = await studioProject(directories);
  await storedRun(project, runId, commit, [
    {
      state: "editor",
      html: "before.html",
      content:
        '<div class="dot">original</div><span class="dot">another</span>',
    },
  ]);
  const original = await log(project, [
    entry({
      target: { file: "project.json", selector: ".dot, .missing" },
      capture: { runId, viewport: "desktop" },
    }),
  ]);
  const before = await tree(join(project, ".idiom"));
  const out = await temp();
  const outBefore = await tree(out);
  const exported = await learnFixtureCommand({
    project,
    cwd: out,
    id: "learned-1",
    out: "fixtures",
  });
  expect(exported.paths).toEqual([
    join(out, "fixtures", "learned-1", "snippet.html"),
    join(out, "fixtures", "learned-1", "expectation.json"),
  ]);
  expect(await readFile(exported.paths[0], "utf8")).toContain(
    '<div class="dot">original</div>\n<span class="dot">another</span>',
  );
  expect(JSON.parse(await readFile(exported.paths[1], "utf8"))).toEqual({
    version: 1,
    learned: "learned-1",
    flow: "studio-lab",
    state: "editor",
    viewport: "desktop",
    runId,
    kind: "component",
    rule: "component-size",
    selector: ".dot, .missing",
    observation: entry().observation,
    expect: entry().entry,
    recordedAt,
    snippet: "snippet.html",
  });
  expect(await tree(join(project, ".idiom"))).toEqual(before);
  expect(Object.keys(await tree(out)).sort()).toEqual(
    [
      ...Object.keys(outBefore),
      "fixtures/learned-1/expectation.json",
      "fixtures/learned-1/snippet.html",
    ].sort(),
  );
  expect(await readFile(join(project, ".idiom", "learned.jsonl"), "utf8")).toBe(
    original,
  );
  await expect(
    learnFixtureCommand({
      project,
      id: "learned-1",
      out: join(out, "fixtures"),
    }),
  ).rejects.toThrow("overwrite");
});

test("fixture prefers its original capture and falls back when pruned; refusal cases write nothing", async () => {
  const { project, commit } = await studioProject(directories);
  const newerRun = "2026-11-06T12-00-00-000Z";
  await storedRun(project, runId, commit, [
    { state: "editor", html: "before.html", content: '<p class="dot">old</p>' },
  ]);
  await storedRun(project, newerRun, commit, [
    { state: "editor", html: "before.html", content: '<p class="dot">new</p>' },
  ]);
  const entries = [
    entry({ capture: { runId, viewport: "desktop" } }),
    entry({ id: "learned-2", covered: { by: "test", at: later } }),
    entry({ id: "learned-3", target: { file: "DESIGN.md" } }),
    entry({ id: "learned-4", target: { file: "x", selector: ".absent" } }),
  ];
  await log(project, entries);
  const out = await temp();
  for (const [id, message] of [
    ["learned-2", "covered by test"],
    ["learned-3", "names no element"],
    ["learned-4", "matches no elements"],
    ["learned-999", "unknown learned id"],
  ] as const) {
    await expect(learnFixtureCommand({ project, id, out })).rejects.toThrow(
      message,
    );
  }
  expect(await tree(out)).toEqual({});
  const first = await learnFixtureCommand({ project, id: "learned-1", out });
  expect(await readFile(first.paths[0], "utf8")).toContain(">old</p>");
  await rm(join(project, ".idiom", "reports", runId), { recursive: true });
  const second = await learnFixtureCommand({
    project,
    id: "learned-1",
    out: join(out, "fallback"),
  });
  expect(JSON.parse(await readFile(second.paths[1], "utf8"))).toMatchObject({
    runId: newerRun,
  });
  expect(await readFile(second.paths[0], "utf8")).toContain(">new</p>");
  await symlink(join(out, "elsewhere"), join(out, "learned-4"));
  await expect(
    learnFixtureCommand({ project, id: "learned-4", out }),
  ).rejects.toThrow("overwrite");
  await rm(join(project, ".idiom", "reports"), { recursive: true });
  await expect(
    learnFixtureCommand({
      project,
      id: "learned-1",
      out: join(out, "missing"),
    }),
  ).rejects.toThrow("no captured DOM");
});

test("check and review report renderers display the metric only when supplied", async () => {
  const project = await temp();
  await log(project, [entry()]);
  const humanFound = await summarizeMisses({ projectDirectory: project });
  if (!humanFound) throw new Error("expected a summary");
  const line = humanFoundLine(humanFound, now);
  const summary: CheckSummary = {
    flow: "studio-lab",
    runDirectory: "/run",
    reportPath: "/run/report.md",
    findings: [
      {
        id: "finding-1",
        severity: "minor",
        category: "component-size",
        where: "editor/desktop",
        problem: "dots too small",
        fix: [],
      },
    ],
    blocking: 0,
    humanFound,
  };
  const text = renderCheckSummary(summary, { now });
  expect(text).toContain(line);
  expect(text.indexOf(line)).toBeLessThan(text.indexOf("Full report:"));
  expect(renderCheckSummary(summary, { humanFound: false })).not.toContain(
    "Human-found misses:",
  );
  expect(
    renderCheckSummary({ ...summary, humanFound: undefined }),
  ).not.toContain("Human-found misses:");
  const options = {
    flow: "studio-lab",
    commit: "abc",
    findings: [],
    tuples: [],
    coverage: [],
    outcome: { kind: "deterministic-only" as const },
    humanFound,
    now,
  };
  expect(renderReport(options)).toContain(line);
  expect(
    renderReviewHtmlReport({ ...options, screenshots: new Map() }),
  ).toContain(line);
  expect(renderReport({ ...options, humanFound: undefined })).not.toContain(
    "Human-found misses:",
  );
  expect(
    renderReviewHtmlReport({
      ...options,
      humanFound: undefined,
      screenshots: new Map(),
    }),
  ).not.toContain("Human-found misses:");
});

test("a check covers a miss in its own text/JSON summary and reports, and corrupt logs do not fail it", async () => {
  const { project, commit } = await studioProject(directories);
  await storedRun(project, runId, commit);
  await learnCommand({
    project,
    state: "editor",
    observation: "the override dots should be 8px",
    yes: true,
    dependencies: { clock: () => new Date("2026-10-22T12:00:00.000Z") },
  });
  // The learned size is measured at capture time, so collect a new observation
  // with that configuration before checking the stored run.
  const tuple = join(project, ".idiom", "reports", runId, "editor", "desktop");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.setContent(await readFile(join(tuple, "dom.html"), "utf8"));
    const config = projectSchema.parse(
      JSON.parse(
        await readFile(join(project, ".idiom", "project.json"), "utf8"),
      ),
    );
    await writeFile(
      join(tuple, "observations.json"),
      JSON.stringify(
        await observePage(page, { status: "not-configured" }, undefined, [], {
          components: config.checks.components,
        }),
      ),
    );
  } finally {
    await browser.close();
  }
  const metadataPath = join(tuple, "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.timestamps = { startedAt: later, endedAt: later };
  await writeFile(metadataPath, JSON.stringify(metadata));
  const result = await checkCommand({
    project,
    flow: "studio-lab",
    from: runId,
    dependencies: { now: () => now },
  });
  expect(result.humanFound).toMatchObject({
    covered: 1,
    coveredByRun: 1,
    open: 0,
  });
  expect(await readFile(result.reportPath, "utf8")).toContain(
    "Human-found misses: 1 logged, 1 now covered",
  );
  expect(
    await readFile(join(result.runDirectory, "report.html"), "utf8"),
  ).toContain("Human-found misses: 1 logged, 1 now covered");
  expect((await cli(project, ["report", runId])).text).toContain(
    "Human-found misses: 1 logged, 1 now covered",
  );
  const output = await cli(project, [
    "check",
    "studio-lab",
    "--from",
    runId,
    "--json",
    "--fail-on",
    "never",
  ]);
  expect(output.code).toBe(0);
  expect(JSON.parse(output.text).humanFound).toMatchObject({ covered: 1 });
  await writeFile(join(project, ".idiom", "learned.jsonl"), "corrupt\n");
  const clean = await checkCommand({
    project,
    flow: "studio-lab",
    from: runId,
  });
  expect(clean.humanFound).toBeUndefined();
});

test("digest CLI JSON carries humanFound counts and open entries when a log is present", async () => {
  const { project } = await studioProject(directories);
  const directory = join(project, ".idiom", "reports", runId);
  await mkdir(directory, { recursive: true });
  await writeDigestRecord(directory, { ...digest(), occurrences: [] });
  const empty = await cli(project, ["digest", "--json"]);
  expect(empty.code).toBe(0);
  expect(JSON.parse(empty.text)).not.toHaveProperty("humanFound");
  const content = await log(project, [entry()]);
  await writeFile(
    join(project, ".idiom", "learned.jsonl"),
    `${content}corrupt line\n`,
  );
  const output = await cli(project, ["digest", "--json"]);
  expect(output.code).toBe(0);
  expect(JSON.parse(output.text).humanFound).toMatchObject({
    logged: 1,
    covered: 0,
    open: 1,
    openEntries: [{ id: "learned-1", selector: ".dot" }],
  });
  expect((await cli(project, ["digest"])).text).toContain(
    "Human-found misses: 1 logged, 0 now covered by a rule, 1 open (latest: 2 days ago).",
  );
});

test("decision reattribution never creates learned human misses", async () => {
  const project = await temp();
  await log(project, [entry()]);
  const before = await summarizeMisses({ projectDirectory: project });
  await writeFile(
    join(project, ".idiom/decisions.jsonl"),
    `${JSON.stringify({
      at: recordedAt,
      commit: "unknown",
      findingId: "one",
      fingerprint: "fp",
      decision: "accept",
      scope: "instance",
      actor: "human",
    })}\n`,
  );
  const raw = (await readRawDecisionLog(project))[0];
  if (!raw) throw new Error("missing original");
  await appendDecisionBatch(project, [
    {
      at: later,
      commit: "unknown",
      findingId: "one",
      fingerprint: "fp",
      decision: "reattribute",
      target: raw.source,
      actor: "agent",
      note: "historical build",
    },
  ]);
  expect(await summarizeMisses({ projectDirectory: project })).toEqual(before);
});
