import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { bisectFinding } from "../src/attribution/bisect.js";
import { recordRunAttribution } from "../src/attribution/check.js";
import {
  ATTRIBUTION_RECORD_FILE,
  readAttributionRecord,
  writeAttributionRecord,
} from "../src/attribution/record.js";
import type { GitRead } from "../src/changed/git.js";
import { readGit } from "../src/changed/git.js";
import { checkCommand, renderCheckSummary } from "../src/commands/check.js";
import { loadReviewCatalog } from "../src/review/catalog.js";
import { validateProject } from "../src/validation.js";
import { baselineProject, commit, git } from "./baseline-support.js";
import { fixtureCommand } from "./support/fixture-server.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const page = (title: string, overlap: boolean) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><style>body{color:#182030;background:#fff;font:16px sans-serif;margin:32px} .row{position:relative;height:40px} button{width:100px;height:32px} #control{position:absolute;left:${overlap ? 50 : 240}px;top:0}</style></head><body><main><h1>${title}</h1><p id="required">Required content</p><div class="row"><strong id="text">Zoom options</strong><button id="control">Fit</button></div></main></body></html>`;

/** c1 clean, c2 introduces an overlap, c3 changes unrelated text. */
async function fixture() {
  const created = await baselineProject();
  roots.push(created.project);
  const project = await realpath(created.project);
  const config = JSON.parse(await readFile(created.configPath, "utf8"));
  config.server = {
    build: "node build.mjs",
    start: fixtureCommand("server.mjs"),
    reuse: true,
    port: 3124,
    readyUrl: "http://127.0.0.1:3124",
    env: {},
  };
  config.capture = { settleMs: 0, maxMinutes: 1 };
  config.checks = { probe: { enabled: false } };
  await writeFile(created.configPath, JSON.stringify(config));
  await writeFile(
    join(project, ".gitignore"),
    ".idiom/reports/\n.idiom/cache/\n**/built.html\n",
  );
  await writeFile(
    join(project, "build.mjs"),
    'import {copyFileSync} from "node:fs"; copyFileSync("page.html", "built.html");',
  );
  await writeFile(
    join(project, "server.mjs"),
    'import http from "node:http"; import {readFileSync} from "node:fs"; http.createServer((q,r)=>{ r.setHeader("Content-Type","text/html"); r.end(readFileSync("built.html")); }).listen(Number(process.env.PORT),"127.0.0.1");',
  );
  await writeFile(join(project, "page.html"), page("Studio", false));
  const c1 = await commit(project, "Clean studio");
  await writeFile(join(project, "page.html"), page("Studio", true));
  const c2 = await commit(project, "Move the fit button (file-263)");
  await writeFile(join(project, "page.html"), page("Studio two", true));
  const c3 = await commit(project, "Rename the studio");
  return { project, c1, c2, c3 };
}

async function runs(project: string): Promise<string[]> {
  return (await readdir(join(project, ".idiom", "reports"))).sort();
}

test("two checks record the range, and bisect finds the commit that introduced the overlap", async () => {
  const { project, c1, c2, c3 } = await fixture();
  await checkCommand({ project, flow: "studio", ref: c1 });
  const second = await checkCommand({ project, flow: "studio", ref: c3 });
  expect(second.attributionWarning).toBeUndefined();
  const record = await readAttributionRecord(second.runDirectory);
  expect(record?.previous?.commit).toBe(c1);
  const overlap = record?.introductions.find((introduction) =>
    introduction.where.startsWith("editor/desktop"),
  );
  expect(overlap?.range).toMatchObject({
    from: c1,
    to: c3,
    commits: 2,
    linear: true,
  });
  const report = await readFile(second.reportPath, "utf8");
  expect(report).toContain(
    `appeared between ${c1.slice(0, 7)} and ${c3.slice(0, 7)} (2 commits)`,
  );
  const catalog = await loadReviewCatalog({ project });
  const lineage = catalog.lineages.find((candidate) =>
    candidate.fingerprints.includes(overlap?.fingerprint ?? ""),
  );
  if (lineage === undefined) throw new Error("no lineage for the overlap");

  const head = await git(project, "rev-parse", "HEAD");
  const branch = await git(project, "branch", "--show-current");
  const status = await git(project, "status", "--porcelain");
  const worktrees = await git(project, "worktree", "list", "--porcelain");
  const before = await runs(project);
  const lines: string[] = [];
  const result = await bisectFinding({
    project,
    finding: lineage.id,
    onLine: (line) => lines.push(line),
  });
  expect(result).toMatchObject({
    finding: lineage.id,
    flow: "studio",
    verdict: "found",
    range: { from: c1, to: c3, commits: 2 },
    firstBad: {
      commit: c2,
      subject: "Move the fit button (file-263)",
      tickets: ["file-263"],
    },
  });
  expect(result.probes).toEqual([{ commit: c2, present: true }]);
  expect(lines).toContain(
    `first appears at ${c2.slice(0, 7)} "Move the fit button (file-263)" (file-263)`,
  );
  expect(lines.at(-1)).toBe(
    `range ${c1.slice(0, 7)}..${c3.slice(0, 7)}, 2 commits, 1 probe`,
  );
  // The user's checkout, the worktree list and the run history are untouched.
  expect(await git(project, "rev-parse", "HEAD")).toBe(head);
  expect(await git(project, "branch", "--show-current")).toBe(branch);
  expect(await git(project, "status", "--porcelain")).toBe(status);
  expect(await git(project, "worktree", "list", "--porcelain")).toBe(worktrees);
  expect(await runs(project)).toEqual(before);
  await expect(
    access(join(project, ".idiom", "cache", "bisect")),
  ).rejects.toThrow();
}, 180_000);

test("a git failure inside the range never fails the check", async () => {
  const { project, c1, c3 } = await fixture();
  await checkCommand({ project, flow: "studio", ref: c1 });
  const failing: GitRead = async (cwd, args) => {
    if (args[0] === "diff-tree") throw new Error("fatal: injected failure");
    return readGit(cwd, args);
  };
  const second = await checkCommand({
    project,
    flow: "studio",
    ref: c3,
    dependencies: { attributionGit: failing },
  });
  expect(second.attributionWarning).toBeUndefined();
  const record = await readAttributionRecord(second.runDirectory);
  expect(record?.introductions[0]?.candidatesOmitted).toBe(
    "git: fatal: injected failure",
  );
  expect(await readFile(second.reportPath, "utf8")).toContain(
    "git: fatal: injected failure",
  );
}, 120_000);

test("an attribution that cannot be written warns instead of failing", async () => {
  const { project } = await fixture();
  const validated = await validateProject({ project, flow: "studio" });
  const result = await recordRunAttribution({
    validated,
    flow: "studio",
    runDirectory: join(project, ".idiom", "reports", "missing", "run"),
    occurrences: [],
    coverage: undefined,
    scope: undefined,
    rankingContext: undefined,
    now: new Date(),
  });
  expect(result.warning).toMatch(/^attribution not recorded: /);
  expect(
    renderCheckSummary({
      flow: "studio",
      runDirectory: "run",
      reportPath: "report.md",
      findings: [],
      blocking: 0,
      attributionWarning: result.warning,
    }),
  ).toContain(`Warning: ${result.warning}`);
});

test("bisect refuses without a range, a linear range, commits or committed config", async () => {
  const { project, c1, c2, c3 } = await fixture();
  const runDirectory = join(
    project,
    ".idiom",
    "reports",
    "2026-11-06T00-00-00-000Z",
  );
  const fingerprint = "f-overlap";
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "findings.json"),
    JSON.stringify([
      {
        id: "finding-1",
        fingerprint,
        createdAt: "2026-11-06T00:00:00.000Z",
        commit: c3,
        flow: "studio",
        state: "editor",
        viewport: "desktop",
        layer: "deterministic",
        category: "element-overlap",
        severity: "major",
        confidence: 1,
        rule: "idiom:element-overlap",
        evidence: { screenshots: [] },
        explanation: "Overlap.",
        acceptance: [],
        verification: { kind: "deterministic-check", check: "element-overlap" },
        status: "open",
      },
    ]),
  );
  const capture = async () => {
    throw new Error("no capture expected");
  };
  const bisect = () =>
    bisectFinding({
      project,
      finding: "finding-1",
      dependencies: { capture },
    });
  await expect(bisect()).rejects.toThrow(
    "no first-seen range recorded for finding-1",
  );
  const write = (range: Record<string, unknown>) =>
    writeAttributionRecord(runDirectory, {
      version: 1,
      flow: "studio",
      runId: "2026-11-06T00-00-00-000Z",
      commit: c3,
      dirty: false,
      previous: { runId: "x", commit: c1, dirty: false, completedAt: "x" },
      configChanged: false,
      introductions: [
        {
          id: "finding-1",
          fingerprint,
          where: "editor/desktop",
          state: "editor",
          range: {
            from: c1,
            to: c3,
            commits: 2,
            linear: true,
            fromDirty: false,
            toDirty: false,
            ...range,
          },
        },
      ],
    });
  await write({ from: "f".repeat(40) });
  await expect(bisect()).rejects.toThrow(
    "bisect needs local history for fffffff",
  );
  await write({ from: c3, to: c2, linear: false, commits: null });
  await expect(bisect()).rejects.toThrow("the recorded range is not linear");
  await write({ from: c3, to: c3, commits: 0 });
  await expect(bisect()).rejects.toThrow("no commits between the runs");
  // A revision before the project configuration was committed.
  const root = (
    await git(project, "rev-list", "--max-parents=0", "HEAD")
  ).trim();
  const config = join(project, ".idiom", "project.json");
  const aside = join(project, "project.json.aside");
  await rename(config, aside);
  await writeFile(
    join(project, ".gitignore"),
    "project.json.aside\n.idiom/reports/\n.idiom/cache/\n**/built.html\n",
  );
  const uncommitted = await commit(project, "Drop the config from Git");
  await rename(aside, config);
  await commit(project, "Restore the config");
  await write({ from: root, to: uncommitted, commits: 4 });
  await expect(bisect()).rejects.toThrow(
    "bisect needs --ref worktree capture: no committed .idiom/project.json",
  );
  expect(ATTRIBUTION_RECORD_FILE).toBe("attribution.json");
});
