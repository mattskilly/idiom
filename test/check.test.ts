import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { afterEach, expect, test } from "vitest";
import { observePage } from "../src/checks/observe.js";
import { run as runCli } from "../src/cli.js";
import { baselineRecordCommand } from "../src/commands/baseline.js";
import { checkCommand, renderCheckSummary } from "../src/commands/check.js";
import { initProject } from "../src/commands/init.js";
import { readDecisionLog } from "../src/decisions/log.js";
import type { Finding } from "../src/schemas/finding.js";
import { parseFindingBlocks } from "../src/verify/spec.js";
import { fixture } from "./benchmark-support.js";

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function storedRun(
  project: string,
  runId: string,
  commit: string,
  html = "before.html",
  touch = false,
) {
  const tuple = join(project, ".idiom", "reports", runId, "editor", "desktop");
  await mkdir(tuple, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      hasTouch: touch,
    });
    await page.setContent(await fixture(html));
    const observations = await observePage(page, { status: "not-configured" });
    if (observations.version === 2) {
      const chip = observations.elements.find(
        (element) => element.selector === "#chip-button",
      );
      if (chip?.signals?.paint !== undefined)
        chip.signals.paint.primaryAction = true;
    }

    await Promise.all([
      writeFile(join(tuple, "observations.json"), JSON.stringify(observations)),
      writeFile(join(tuple, "screenshot.png"), await page.screenshot()),
      writeFile(join(tuple, "dom.html"), await page.content()),
      writeFile(join(tuple, "console.jsonl"), ""),
      writeFile(join(tuple, "axe.json"), JSON.stringify({ violations: [] })),
      writeFile(
        join(tuple, "metadata.json"),
        JSON.stringify({
          source: { commit, dirty: false },
          flow: { id: "studio-lab", title: "Studio" },
          state: { id: "editor", description: "Editor" },
          viewport: {
            name: "desktop",
            width: 1440,
            height: 900,
            deviceScaleFactor: 2,
          },
          url: {
            kind: "literal",
            origin: "http://127.0.0.1:3100",
            url: "http://127.0.0.1:3100/lab/editor",
          },
          timestamps: {
            startedAt: "2026-10-22T12:00:00.000Z",
            endedAt: "2026-10-22T12:00:01.000Z",
          },
          status: 200,
          expectations: { passed: true, mismatches: [] },
          failure: null,
        }),
      ),
      writeFile(
        join(project, ".idiom", "reports", runId, "baseline.md"),
        "# Capture\n\nFlow `studio-lab`: 1 passed, 0 failed, 1 total.\n",
      ),
    ]);
  } finally {
    await browser.close();
  }
}

async function studioProject(): Promise<{ project: string; commit: string }> {
  const project = await mkdtemp(join(tmpdir(), "idiom-check-"));
  directories.push(project);
  await initProject({ project, yes: true });
  const projectPath = join(project, ".idiom", "project.json");
  const settings = JSON.parse(await readFile(projectPath, "utf8"));
  await writeFile(
    projectPath,
    JSON.stringify({
      ...settings,
      checks: { ...settings.checks, explanation: "visible" },
    }),
  );
  await writeFile(
    join(project, ".idiom", "flows", "studio-lab.json"),
    JSON.stringify({
      id: "studio-lab",
      title: "Studio",
      intent: ["Editor chrome"],
      setup: [],
      viewports: ["desktop"],
      states: [
        {
          id: "editor",
          description: "Editor",
          url: "/lab/editor",
          expect: { status: 200 },
        },
      ],
    }),
  );
  await run("git", ["init", "-q"], { cwd: project });
  await run("git", ["add", "-A"], { cwd: project });
  await run(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "init",
    ],
    { cwd: project },
  );
  await writeFile(join(project, ".gitignore"), ".idiom/reports/\n");
  await run("git", ["add", "-A"], { cwd: project });
  await run(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "ignore reports",
    ],
    { cwd: project },
  );
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: project });
  return { project, commit: stdout.trim() };
}

test("stored checks use measured touch signals and fall back to width for old captures", async () => {
  const { project, commit } = await studioProject();
  const configPath = join(project, ".idiom/project.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.checks = {
    ...config.checks,
    targetSize: { fine: 24, coarse: 44, narrowBelow: 768 },
  };
  config.viewports = [
    { name: "desktop", width: 1440, height: 900, touch: true },
  ];
  await writeFile(configPath, JSON.stringify(config));
  const from = "2026-10-24T00-00-00-000Z";
  await storedRun(
    project,
    from,
    commit,
    "../target-size/compact-chrome.html",
    true,
  );
  const touched = await checkCommand({
    all: true,
    project,
    flow: "studio-lab",
    from,
  });
  const targets = touched.findings.filter(
    (finding) => finding.category === "target-size",
  );
  expect(targets).toHaveLength(5);
  expect(
    targets.every((finding) =>
      finding.problem.includes("at desktop (touch, minimum 44)"),
    ),
  ).toBe(true);

  const observationsPath = join(
    touched.runDirectory,
    "editor/desktop/observations.json",
  );
  const observed = JSON.parse(await readFile(observationsPath, "utf8"));
  delete observed.input;
  await writeFile(observationsPath, JSON.stringify(observed));
  const older = await checkCommand({
    all: true,
    project,
    flow: "studio-lab",
    from,
  });
  const olderTargets = older.findings.filter(
    (finding) => finding.category === "target-size",
  );
  expect(olderTargets).toHaveLength(1);
  expect(olderTargets[0]?.problem).toContain(
    "20×20 at desktop (fine pointer, minimum 24)",
  );
}, 30_000);

test("check lists open deterministic findings, most severe first, with the fix", async () => {
  const { project, commit } = await studioProject();
  await storedRun(project, "2026-10-22T12-00-00-000Z", commit);
  const summary = await checkCommand({
    all: true,
    project,
    flow: "studio-lab",
    from: "2026-10-22T12-00-00-000Z",
  });
  const severities = summary.findings.map((finding) => finding.severity);
  expect(severities).toEqual(
    [...severities].sort(
      (a, b) =>
        ["blocker", "major", "minor"].indexOf(a) -
        ["blocker", "major", "minor"].indexOf(b),
    ),
  );
  expect(summary.findings.map((finding) => finding.category)).toEqual(
    expect.arrayContaining([
      "dead-affordance",
      "unexplained-control",
      "text-centering",
      "adjacent-gap",
    ]),
  );
  expect(summary.blocking).toBeGreaterThan(0);
  const chipGroups =
    summary.groups?.filter((group) => group.selector === "#chip-button") ?? [];
  expect(chipGroups.length).toBeGreaterThan(0);
  for (const group of chipGroups)
    expect(
      summary.issues?.find((issue) => issue.groups.includes(group.id))
        ?.primaryAction,
    ).toBe(true);

  const terms = summary.findings.find(
    (finding) => finding.selector === "#view-terms",
  );
  expect(terms?.screenshot).toMatch(/\/crops\/[0-9a-f]{16}\.png$/);
  const text = renderCheckSummary(summary);
  expect(text).toContain("Top issues (");
  expect(text).toContain("Done when:");
  expect(text).toContain("idiom decide --finding finding-");
}, 60_000);

test("--latest resolves the newest passing capture at HEAD and refuses when there is none", async () => {
  const { project, commit } = await studioProject();
  await expect(
    checkCommand({ all: true, project, flow: "studio-lab", latest: true }),
  ).rejects.toThrow(/no fully passing capture/);
  await storedRun(
    project,
    "2026-10-22T12-00-00-000Z",
    "0000000000000000000000000000000000000000",
  );
  await expect(
    checkCommand({ all: true, project, flow: "studio-lab", latest: true }),
  ).rejects.toThrow(/no fully passing capture/);
  await storedRun(project, "2026-10-22T13-00-00-000Z", commit);
  const summary = await checkCommand({
    all: true,
    project,
    flow: "studio-lab",
    latest: true,
  });
  expect(summary.runDirectory).toContain("2026-10-22T13-00-00-000Z");
}, 60_000);

test("--baseline reports only findings the baseline run did not have", async () => {
  const { project, commit } = await studioProject();
  await storedRun(project, "2026-10-22T12-00-00-000Z", commit);
  await storedRun(project, "2026-10-22T13-00-00-000Z", commit);
  const same = await checkCommand({
    project,
    flow: "studio-lab",
    from: "2026-10-22T13-00-00-000Z",
    baseline: "2026-10-22T12-00-00-000Z",
  });
  expect(same.findings).toEqual([]);
  expect(same.preExisting).toBeGreaterThan(0);
  expect(renderCheckSummary(same)).toContain(
    "clean — no new deterministic findings",
  );
}, 60_000);

test("--baseline surfaces a regression introduced since the baseline", async () => {
  const { project, commit } = await studioProject();
  await storedRun(project, "2026-10-22T12-00-00-000Z", commit, "after.html");
  await storedRun(project, "2026-10-22T13-00-00-000Z", commit, "before.html");
  const regressed = await checkCommand({
    project,
    flow: "studio-lab",
    from: "2026-10-22T13-00-00-000Z",
    baseline: "2026-10-22T12-00-00-000Z",
  });
  expect(regressed.findings.map((finding) => finding.selector)).toEqual(
    expect.arrayContaining(["#view-terms", "#top-help"]),
  );
}, 60_000);

async function embeddedCheckFindings(paths: string[]): Promise<Finding[]> {
  return (
    await Promise.all(
      paths.map(async (path) =>
        parseFindingBlocks(await readFile(path, "utf8")),
      ),
    )
  ).flat();
}

test("check proposes current open material without accepting, changing the summary, or checkpointing", async () => {
  const { project, commit } = await studioProject();
  const from = "2026-10-22T12-00-00-000Z";
  await storedRun(project, from, commit);
  const before = await checkCommand({
    all: true,
    project,
    flow: "studio-lab",
    from,
    dependencies: { monotonicNow: () => 0 },
  });
  expect(before.tickets).toBeUndefined();
  const summary = await checkCommand({
    all: true,
    project,
    flow: "studio-lab",
    from,
    emitTickets: join(project, "proposals"),
    dependencies: { monotonicNow: () => 0 },
  });
  const { tickets, ...unchanged } = summary;
  expect(unchanged).toEqual(before);
  expect(tickets?.createdPaths.length).toBeGreaterThan(0);
  const persisted = JSON.parse(
    await readFile(join(summary.runDirectory, "findings.json"), "utf8"),
  ) as Finding[];
  const embedded = await embeddedCheckFindings(tickets?.createdPaths ?? []);
  expect(embedded.map((f) => f.id).sort()).toEqual(
    persisted
      .filter((f) =>
        summary.findings.some((row) => row.id === f.id && !row.deferred),
      )
      .map((f) => f.id)
      .sort(),
  );
  expect(embedded.every((f) => f.status === "open")).toBe(true);
  expect(await readDecisionLog(project)).toEqual([]);
  expect(renderCheckSummary(summary)).toContain("Tickets:");
  const retry = await checkCommand({
    all: true,
    project,
    flow: "studio-lab",
    from,
    emitTickets: join(project, "proposals"),
    dependencies: { monotonicNow: () => 0 },
  });
  expect(retry.tickets?.createdPaths).toHaveLength(0);
  expect(retry.blocking).toBe(before.blocking);
}, 60_000);

test("check emits persisted current-run records instead of a newer catalog occurrence", async () => {
  const { project, commit } = await studioProject();
  const from = "2026-10-22T12-00-00-000Z";
  await storedRun(project, from, commit);
  const current = await checkCommand({
    all: true,
    project,
    flow: "studio-lab",
    from,
  });
  const persisted = JSON.parse(
    await readFile(join(current.runDirectory, "findings.json"), "utf8"),
  ) as Finding[];
  const later = join(project, ".idiom/reports/2026-10-22T14-00-00-000Z");
  await mkdir(later, { recursive: true });
  await writeFile(
    join(later, "findings.json"),
    JSON.stringify(
      persisted.map((f) => ({
        ...f,
        commit: "newer-commit",
        explanation: "Wrong later occurrence",
      })),
    ),
  );
  const summary = await checkCommand({
    all: true,
    project,
    flow: "studio-lab",
    from,
    emitTickets: join(project, "proposals"),
  });
  const embedded = await embeddedCheckFindings(
    summary.tickets?.createdPaths ?? [],
  );
  expect(embedded.length).toBeGreaterThan(0);
  expect(
    embedded.every(
      (f) => f.commit === commit && f.explanation !== "Wrong later occurrence",
    ),
  ).toBe(true);
}, 60_000);

test("check baseline empty selection does not emit old work and clean reports include ticket counts", async () => {
  const { project, commit } = await studioProject();
  await storedRun(project, "2026-10-22T12-00-00-000Z", commit);
  await storedRun(project, "2026-10-22T13-00-00-000Z", commit);
  const summary = await checkCommand({
    project,
    flow: "studio-lab",
    from: "2026-10-22T13-00-00-000Z",
    baseline: "2026-10-22T12-00-00-000Z",
    emitTickets: join(project, "proposals"),
  });
  expect(summary.findings).toEqual([]);
  expect(summary.tickets?.outcomes).toEqual([]);
  expect(renderCheckSummary(summary)).toContain("Tickets: 0 created");
}, 60_000);

test("default baseline proposals exclude pre-existing and occurrence-only or deferred rows", async () => {
  const { project, commit } = await studioProject();
  const base = "2026-10-22T12-00-00-000Z";
  const from = "2026-10-22T13-00-00-000Z";
  await storedRun(project, base, commit, "after.html");
  await baselineRecordCommand({ project, flow: "studio-lab", from: base });
  // A one-finding attention cap makes the remaining new occurrences non-material.
  const configPath = join(project, ".idiom/project.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.model.maxFindings = 1;
  await writeFile(configPath, JSON.stringify(config));
  await storedRun(project, from, commit);
  const summary = await checkCommand({
    project,
    flow: "studio-lab",
    from,
    emitTickets: join(project, "proposals"),
  });
  expect(summary.findings.length).toBeGreaterThan(1);
  expect(summary.findings.some((f) => f.deferred || f.occurrenceOnly)).toBe(
    true,
  );
  const embedded = await embeddedCheckFindings(
    summary.tickets?.createdPaths ?? [],
  );
  const selected = summary.findings.filter(
    (f) => !f.deferred && !f.occurrenceOnly,
  );
  expect(embedded.map((f) => f.id).sort()).toEqual(
    selected.map((f) => f.id).sort(),
  );
  const clean = await checkCommand({
    project,
    flow: "studio-lab",
    from: base,
    emitTickets: join(project, "empty-proposals"),
  });
  expect(clean.tickets?.createdPaths).toEqual([]);
  expect(renderCheckSummary(clean)).toContain("Tickets: 0 created");
}, 60_000);

test("CLI emits tickets before fail-on error and includes grouped paths in JSON", async () => {
  const { project, commit } = await studioProject();
  const from = "2026-10-22T12-00-00-000Z";
  await storedRun(project, from, commit);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    [
      "node",
      "idiom",
      "check",
      "--all",
      "studio-lab",
      "--project",
      project,
      "--from",
      from,
      "--emit-tickets",
      join(project, "proposals"),
      "--top",
      "1",
      "--all",
      "--json",
      "--fail-on",
      "major",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  );
  expect(code).toBe(1);
  expect(stderr.join("\n")).toContain("check failed");
  const summary = JSON.parse(stdout.join("\n"));
  expect(summary.tickets.createdPaths.length).toBeGreaterThan(0);
  for (const path of summary.tickets.createdPaths)
    expect(await readFile(path, "utf8")).toContain("idiom:finding");
  expect(await readDecisionLog(project)).toEqual([]);
}, 60_000);

test("text selection keeps full-finding gating even with hidden blocking findings", async () => {
  const { project, commit } = await studioProject();
  const from = "2026-10-22T12-00-00-000Z";
  await storedRun(project, from, commit);
  const summary = await checkCommand({
    all: true,
    project,
    flow: "studio-lab",
    from,
  });
  const first = summary.issues?.[0];
  const hiddenGroups =
    summary.groups?.filter((g) => !first?.groups.includes(g.id)) ?? [];
  expect(
    hiddenGroups.some(
      (g) => g.severity === "major" || g.severity === "blocker",
    ),
  ).toBe(true);
  for (const selection of [[], ["--top", "1"], ["--all"]]) {
    for (const failOn of ["major", "never"]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(
        [
          "node",
          "idiom",
          "check",
          "--all",
          "studio-lab",
          "--project",
          project,
          "--from",
          from,
          ...selection,
          "--fail-on",
          failOn,
        ],
        {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        },
      );
      expect(code).toBe(failOn === "major" ? 1 : 0);
      expect(stdout.join("\n")).toContain(
        `${summary.blocking} blocking (blocker/major)`,
      );
      if (failOn === "major")
        expect(stderr.join("\n")).toContain("check failed");
      else expect(stderr.join("\n")).not.toContain("check failed");
    }
  }
}, 60_000);

test.each([false, true])(
  "stored terminology policy reaches report findings and real crops (project merge: %s)",
  async (splitPolicy) => {
    const { project, commit } = await studioProject();
    const policy = {
      locale: "en-CA",
      retired: [
        { term: "Style guide", preferred: "Brand" },
        { term: "Follow guide", preferred: "Follow brand" },
      ],
      jargon: [
        { term: "nodes", preferred: "items" },
        { term: "Disclosure", preferred: "Expand" },
        { term: "Inherited", preferred: "From brand" },
        { term: "en", preferred: "English" },
      ],
    };
    if (splitPolicy) {
      const configPath = join(project, ".idiom/project.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.checks.copy = {
        retired: [
          policy.retired.pop(),
          { term: "Style guide", preferred: "Brand" },
        ],
        jargon: [
          policy.jargon.splice(1, 1)[0],
          { term: "nodes", preferred: "items" },
        ],
      };
      await writeFile(configPath, JSON.stringify(config));
    }
    await writeFile(
      join(project, ".idiom/glossary.json"),
      JSON.stringify(policy),
    );
    const from = "2026-10-24T12-00-00-000Z";
    await storedRun(project, from, commit, "../retired-jargon/before.html");
    const summary = await checkCommand({
      all: true,
      project,
      flow: "studio-lab",
      from,
    });
    const persisted = JSON.parse(
      await readFile(join(summary.runDirectory, "findings.json"), "utf8"),
    ) as Finding[];
    const rules = [
      "idiom:retired-term",
      "idiom:jargon-in-copy",
      "idiom:mixed-locale-spelling",
    ];
    const policies = summary.findings.filter((f) =>
      rules.includes(f.rule ?? ""),
    );
    expect(policies).toHaveLength(10);
    for (const [selector, term, preferred] of [
      ["#history", "Style guide", "Brand"],
      ["#follow", "Follow guide", "Follow brand"],
      ["#highlight", "nodes", "items"],
      ["#disclosure", "Disclosure", "Expand"],
      ["#language", "en", "English"],
      ["#colors", "Colors", "Colours"],
      ["#multiple", "Style guide", "Brand"],
      ["#multiple", "nodes", "items"],
    ]) {
      const row = policies.find(
        (f) => f.selector === selector && f.problem.includes(`"${term}"`),
      );
      expect(row?.problem).toContain(preferred ?? "");
      expect(row?.fix.join(" ")).toContain(preferred ?? "");
    }
    expect(new Set(policies.map((f) => f.groupKey)).size).toBe(10);
    expect(
      summary.groups?.filter((f) => f.selector === "#multiple"),
    ).toHaveLength(2);
    for (const row of policies) {
      expect(row.screenshot).toMatch(/\/crops\/[0-9a-f]{16}\.png$/);
      const png = PNG.sync.read(await readFile(row.screenshot ?? ""));
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);
    }
    const material = persisted.filter((f) => rules.includes(f.rule ?? ""));
    expect(material.length).toBeGreaterThan(0);
    for (const finding of material) {
      const row = policies.find((f) => f.id === finding.id);
      const crop = finding.evidence.screenshots.find((path) =>
        path.includes("/crops/"),
      );
      expect(join(summary.runDirectory, crop ?? "")).toBe(row?.screenshot);
      expect(finding.verification.params).toEqual(
        expect.objectContaining({
          selector: row?.selector,
          term: expect.any(String),
          preferred: expect.any(String),
        }),
      );
    }
    expect(JSON.parse(JSON.stringify(summary)).reportPath).toBe(
      summary.reportPath,
    );
    expect(renderCheckSummary(summary)).toContain(
      `Full report: ${summary.reportPath}`,
    );
    const cleanFrom = "2026-10-24T13-00-00-000Z";
    await storedRun(project, cleanFrom, commit, "../retired-jargon/after.html");
    const clean = await checkCommand({
      all: true,
      project,
      flow: "studio-lab",
      from: cleanFrom,
    });
    expect(clean.findings.filter((f) => f.category === "copy-lint")).toEqual(
      [],
    );
  },
  60_000,
);
