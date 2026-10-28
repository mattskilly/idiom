import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { afterEach, expect, test } from "vitest";
import { observePage } from "../src/checks/observe.js";
import { checkCommand, renderCheckSummary } from "../src/commands/check.js";
import { initProject } from "../src/commands/init.js";
import { rulingCommand } from "../src/commands/ruling.js";
import { readUnruledDecisions } from "../src/rulings/artifacts.js";
import { fixture } from "./benchmark-support.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const git = (cwd: string, ...args: string[]) =>
  exec(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd },
  );

async function ordersProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "idiom-scale-questions-"));
  directories.push(project);
  await initProject({ project, yes: true });
  const projectPath = join(project, ".idiom", "project.json");
  const settings = JSON.parse(await readFile(projectPath, "utf8"));
  await writeFile(
    projectPath,
    `${JSON.stringify(
      {
        ...settings,
        checks: { ...settings.checks, scales: { spacing: [4, 8, 16, 24] } },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(project, ".idiom", "flows", "orders.json"),
    JSON.stringify({
      id: "orders",
      title: "Orders",
      intent: ["Order table"],
      setup: [],
      viewports: ["desktop"],
      states: [
        {
          id: "orders",
          description: "Orders",
          url: "/orders",
          expect: { status: 200 },
        },
      ],
    }),
  );
  await writeFile(join(project, ".gitignore"), ".idiom/reports/\n");
  await exec("git", ["init", "-q"], { cwd: project });
  await git(project, "add", "-A");
  await git(project, "commit", "-qm", "init");
  return project;
}

async function storedRun(project: string, runId: string, html: string) {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: project,
  });
  const tuple = join(project, ".idiom", "reports", runId, "orders", "desktop");
  await mkdir(tuple, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.setContent(await fixture(html));
    const observations = await observePage(page, { status: "not-configured" });
    await Promise.all([
      writeFile(join(tuple, "observations.json"), JSON.stringify(observations)),
      writeFile(
        join(tuple, "screenshot.png"),
        await page.screenshot({ fullPage: true }),
      ),
      writeFile(join(tuple, "dom.html"), await page.content()),
      writeFile(join(tuple, "console.jsonl"), ""),
      writeFile(join(tuple, "axe.json"), JSON.stringify({ violations: [] })),
      writeFile(
        join(tuple, "metadata.json"),
        JSON.stringify({
          source: { commit: stdout.trim(), dirty: false },
          flow: { id: "orders", title: "Orders" },
          state: { id: "orders", description: "Orders" },
          viewport: {
            name: "desktop",
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
          },
          url: {
            kind: "literal",
            origin: "http://127.0.0.1:3100",
            url: "http://127.0.0.1:3100/orders",
          },
          timestamps: {
            startedAt: "2026-10-27T12:00:00.000Z",
            endedAt: "2026-10-27T12:00:01.000Z",
          },
          status: 200,
          expectations: { passed: true, mismatches: [] },
          failure: null,
        }),
      ),
      writeFile(
        join(project, ".idiom", "reports", runId, "baseline.md"),
        "# Capture\n\nFlow `orders`: 1 passed, 0 failed, 1 total.\n",
      ),
    ]);
  } finally {
    await browser.close();
  }
}

test("an unanswered cluster is one question; nothing about the system changes until a human answers", async () => {
  const project = await ordersProject();
  const design = join(project, "DESIGN.md");
  const config = join(project, ".idiom", "project.json");
  const before = {
    design: await readFile(design),
    config: await readFile(config),
  };
  const from = "2026-10-27T12-00-00-000Z";
  await storedRun(project, from, "scale-cluster/before.html");

  const summary = await checkCommand({
    project,
    flow: "orders",
    from,
    all: true,
  });
  // DESIGN.md and the declared scale are byte-identical after the run.
  expect(await readFile(design)).toEqual(before.design);
  expect(await readFile(config)).toEqual(before.config);

  expect(
    summary.findings.filter(
      (finding) => finding.category === "scale-conformance",
    ),
  ).toEqual([]);
  expect(summary.designSystemQuestions).toEqual([
    {
      id: "ruling-1",
      question:
        "17px padding appears 12 times on button.row-control elements in main at desktop, between your 16px and 24px steps. Add a step for this context, or keep reporting it as drift?",
      count: 12,
      suggestedToken: "space-button-row-control-main",
    },
  ]);
  const rendered = renderCheckSummary(summary);
  expect(rendered).toContain("Design system questions (1):");
  expect(rendered).toContain(
    "Answer: idiom ruling --decision ruling-1 --add-step [--token space-button-row-control-main] | --drift",
  );

  const runDirectory = join(project, ".idiom", "reports", from);
  const [question] = await readUnruledDecisions(runDirectory);
  expect(question).toMatchObject({
    id: "ruling-1",
    candidates: [],
    nearestLawExcerpt: "checks.scales.spacing: [4px, 8px, 16px, 24px]",
    scaleCluster: {
      property: "spacing:padding",
      value: "17px",
      distinctElements: 6,
      context: { landmark: "main", component: "tag:button.row-control" },
    },
  });
  const crops = (question?.scaleCluster?.examples ?? []).map(
    (example) => example.crop,
  );
  expect(crops).toHaveLength(3);
  for (const crop of crops) {
    expect(crop).toMatch(/^crops\/scale-question-[0-9a-f]{8}-[1-3]\.png$/);
    expect(
      (await stat(join(runDirectory, crop as string))).size,
    ).toBeGreaterThan(0);
  }
  const markdown = await readFile(join(runDirectory, "report.md"), "utf8");
  expect(markdown).toContain("## Design system questions (1)");
  expect(markdown).toContain("idiom ruling --decision ruling-1 --drift");
  // The deterministic-only copy for model decisions is unchanged.
  expect(markdown).toContain(
    "## Unruled decisions\n\nUnavailable because the model layer was skipped.",
  );
  const html = await readFile(join(runDirectory, "report.html"), "utf8");
  expect(html).toContain("Design system questions (1)");
  expect(html).toContain("1 design system question");
  expect(html).toContain("data:image/png;base64,");

  // Skip: a second run without an answer asks again under the same name.
  const again = await checkCommand({
    project,
    flow: "orders",
    from,
    all: true,
  });
  expect(again.designSystemQuestions?.map(({ id }) => id)).toEqual([
    "ruling-1",
  ]);

  // Add a step: the only write is the confirmed DESIGN.md ruling.
  await rulingCommand({
    project,
    decision: "ruling-1",
    addStep: true,
    dependencies: { confirm: async () => true },
  });
  expect(
    (await readFile(design, "utf8")).startsWith(before.design.toString()),
  ).toBe(true);
  const answered = await checkCommand({
    project,
    flow: "orders",
    from,
    all: true,
  });
  expect(answered.designSystemQuestions).toBeUndefined();
  expect(
    answered.findings.filter(
      (finding) => finding.category === "scale-conformance",
    ),
  ).toEqual([]);
  expect(await readFile(config)).toEqual(before.config);
}, 120_000);

test("a drift answer returns the occurrences as one grouped issue", async () => {
  const project = await ordersProject();
  const from = "2026-10-27T12-00-00-000Z";
  await storedRun(project, from, "scale-cluster/before.html");
  await checkCommand({ project, flow: "orders", from, all: true });
  await rulingCommand({
    project,
    decision: "ruling-1",
    drift: true,
    dependencies: { confirm: async () => true },
  });
  const summary = await checkCommand({
    project,
    flow: "orders",
    from,
    all: true,
  });
  expect(summary.designSystemQuestions).toBeUndefined();
  const spacing = summary.findings.filter(
    (finding) => finding.rule === "idiom:off-scale-spacing",
  );
  expect(spacing).toHaveLength(1);
  expect(spacing[0]?.problem).toContain("12 padding occurrences at 17px");
  expect(spacing[0]?.problem).toContain("kept as drift by ruling-1");
}, 120_000);
