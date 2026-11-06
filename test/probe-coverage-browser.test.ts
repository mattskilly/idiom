import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { runCapture } from "../src/capture/run.js";
import type { ProbeResult } from "../src/checks/types.js";
import { checkCommand, renderCheckSummary } from "../src/commands/check.js";
import { initProject } from "../src/commands/init.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { fixtureCommand } from "./support/fixture-server.js";

const BUDGET_REASONS =
  /flow budget share|state budget|nested-menu budget|held replay reserve|not completed in any state|probe budget|flow probe time exhausted/;

async function freePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return address.port;
}

/**
 * A page with more plain controls and menu items than a tiny budget allows.
 * The menu's checkbox items are ordinary controls, not the probe's own check
 * candidates, so they fall under the nested-menu cap; distinct classes keep
 * every control out of repeated-row sampling.
 */
const page = `<!doctype html><html lang="en"><title>Many controls</title><body><main><button id="menu" aria-haspopup="menu" onclick="document.querySelector('#items').hidden=false">Tools</button><div id="items" role="menu" aria-label="Tools" hidden>${Array.from(
  { length: 12 },
  (_, index) =>
    `<button class="tool-${index}" role="menuitemcheckbox" aria-checked="false" onclick="this.setAttribute('aria-checked',String(this.getAttribute('aria-checked')!=='true'))">Tool ${index + 1}</button>`,
).join("")}</div>${Array.from(
  { length: 4 },
  (_, index) =>
    `<button class="action-${index}" onclick="this.dataset.done='1'">Action ${index + 1}</button>`,
).join("")}</main></body></html>`;

async function capturedFixture(
  probe: Record<string, unknown>,
  probeBudgetMs?: number,
) {
  const directory = await mkdtemp(join(tmpdir(), "idiom-probe-coverage-"));
  const port = await freePort();
  await initProject({ project: directory, yes: true });
  const script = join(directory, "server.mjs");
  await writeFile(
    script,
    `import { createServer } from 'node:http'; createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(${JSON.stringify(page)})}).listen(Number(process.env.PORT),'127.0.0.1');`,
  );
  const project = projectSchema.parse({
    version: 1,
    app: { name: "Fixture", framework: "other" },
    server: {
      build: "node -e 0",
      start: fixtureCommand(script),
      readyUrl: `http://127.0.0.1:${port}/`,
      port,
      env: { PORT: String(port) },
    },
    viewports: [{ name: "desktop", width: 1000, height: 800 }],
    colorSchemes: ["light"],
    capture: { settleMs: 0 },
    checks: { probe: { waitMs: 50, ...probe } },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "many",
    title: "Many",
    setup: [],
    intent: [],
    states: [{ id: "editor", description: "Editor", url: "/", expect: {} }],
  });
  await writeFile(
    join(directory, ".idiom/project.json"),
    JSON.stringify(project),
  );
  await writeFile(
    join(directory, ".idiom/flows/many.json"),
    JSON.stringify(flow),
  );
  const captured = await runCapture({
    projectDirectory: directory,
    project,
    flow,
    probeBudgetMs,
    dependencies: {
      snapshotSource: async () => ({ commit: "fixture", dirty: false }),
      inheritedEnvironment: { PATH: process.env.PATH },
    },
  });
  expect(captured.counts).toEqual({ passed: 1, failed: 0, total: 1 });
  const loaded = await loadCaptureRun({
    runDirectory: captured.runDirectory,
    expectedFlow: flow.id,
  });
  const [tuple] = loaded.tuples;
  if (tuple?.observations?.version !== 2 || !tuple.observations.probe)
    throw new Error("missing probe evidence");
  const results: ProbeResult[] = tuple.observations.probe.results;
  const record = JSON.parse(
    await readFile(join(captured.runDirectory, "run.json"), "utf8"),
  ) as { probe: { flowBudgetMs?: number } };
  return { directory, runDirectory: captured.runDirectory, results, record };
}

test("a budget-limited run reports not-reached probe work on every surface", async () => {
  // A target below the 20s reserve leaves only round 1's stateTimeoutMs floor.
  const fixture = await capturedFixture({
    stateTimeoutMs: 8000,
    flowBudgetMs: 1,
  });
  try {
    expect(fixture.record.probe.flowBudgetMs).toBe(1);
    const notReached = fixture.results.filter(
      (result) => result.status === "not-reached",
    );
    expect(notReached.length / fixture.results.length).toBeGreaterThan(0.1);
    // The fixture really exercises the nested menu's own cut.
    expect(
      notReached.some((result) =>
        /nested-menu budget/.test(result.skipped ?? ""),
      ),
    ).toBe(true);
    const summary = await checkCommand({
      project: fixture.directory,
      flow: "many",
      from: basename(fixture.runDirectory),
      all: true,
    });
    const probe = summary.coverage?.probeCoverage;
    expect(probe?.flowBudgetMs).toBe(1);
    expect(probe?.totals.notReached).toBe(notReached.length);
    expect(probe?.totals.candidates).toBe(fixture.results.length);
    expect(probe?.warning).toMatch(
      /probe candidates \(\d+%\) were not reached within the 0\.001s probe target\. Raise checks\.probe\.flowBudgetMs/,
    );
    // --json prints the summary as is.
    expect(
      JSON.parse(JSON.stringify(summary)).coverage.probeCoverage.totals,
    ).toEqual(probe?.totals);
    const text = renderCheckSummary(summary);
    expect(text).toContain("Probe coverage (target 0.001s):");
    expect(text).toMatch(
      new RegExp(
        `editor: \\d+ completed, \\d+ timed out, ${probe?.states[0]?.notReached} not reached`,
      ),
    );
    expect(text).toContain("top not-reached reason:");
    expect(text).toContain(`Warning: ${probe?.warning}`);
    // Probe lines end the summary, before any trailing Full report line.
    const lines = text.trimEnd().split("\n");
    expect(
      lines.at(-1)?.startsWith("Full report: ") ? lines.at(-2) : lines.at(-1),
    ).toBe(`Warning: ${probe?.warning}`);
    const markdown = await readFile(summary.reportPath, "utf8");
    expect(markdown).toContain("### Interaction probe");
    expect(markdown).toContain("**Warning:**");
    expect(markdown).toContain(
      `${probe?.totals.notReached} not reached of ${probe?.totals.candidates} candidates`,
    );
    const html = await readFile(
      join(fixture.runDirectory, "report.html"),
      "utf8",
    );
    expect(html).toContain("<h3>Interaction probe</h3>");
    expect(html).toContain(
      `${probe?.totals.notReached} not reached of ${probe?.totals.candidates} candidates`,
    );
    expect(html).toContain("--probe-budget &lt;ms&gt;");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 90000);

test("with no flow target every candidate completes or names a non-budget reason", async () => {
  // stateTimeoutMs is far below the work: it no longer binds without a target.
  const fixture = await capturedFixture(
    { stateTimeoutMs: 1500, flowBudgetMs: 0 },
    0,
  );
  try {
    expect(fixture.record.probe.flowBudgetMs).toBe(0);
    expect(fixture.results.length).toBe(17);
    expect(
      fixture.results.filter((result) =>
        BUDGET_REASONS.test(result.skipped ?? ""),
      ),
    ).toEqual([]);
    expect(
      fixture.results.filter(
        (result) =>
          result.status === "not-reached" || result.status === "timed-out",
      ),
    ).toEqual([]);
    // Nested menu items ran too.
    expect(
      fixture.results.filter((result) =>
        result.name.startsWith("Tools › Tool "),
      ).length,
    ).toBe(12);
    const summary = await checkCommand({
      project: fixture.directory,
      flow: "many",
      from: basename(fixture.runDirectory),
      all: true,
    });
    const probe = summary.coverage?.probeCoverage;
    expect(probe?.totals.notReached).toBe(0);
    expect(probe?.totals.timedOut).toBe(0);
    expect(probe?.warning).toBeUndefined();
    expect(renderCheckSummary(summary)).toContain(
      "Probe coverage (no target):",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 120000);
