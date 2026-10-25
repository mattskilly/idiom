import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { learnCommand } from "../src/commands/learn.js";
import { parseRulingBlocks } from "../src/rulings/law.js";
import { learnedEntrySchema } from "../src/schemas/learned.js";
import { fixture, reviewFixture } from "./benchmark-support.js";
import { storedRun, studioProject } from "./stored-run-support.js";

const directories: string[] = [];
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const runId = "2026-10-22T12-00-00-000Z";
const noTopology = async () => undefined;

async function learnProject() {
  const { project, commit } = await studioProject(directories);
  await storedRun(project, runId, commit);
  return project;
}

async function projectChecks(project: string): Promise<unknown> {
  return JSON.parse(
    await readFile(join(project, ".idiom", "project.json"), "utf8"),
  ).checks;
}

const componentFindings = (
  findings: Awaited<ReturnType<typeof reviewFixture>>,
) =>
  findings.filter(({ candidate }) => candidate.category === "component-size");

test("the override dots should be 8px becomes a checks.components entry that the next check reports", async () => {
  const project = await learnProject();
  const projectPath = join(project, ".idiom", "project.json");
  const logPath = join(project, ".idiom", "learned.jsonl");
  const before = await fixture("before.html");
  const after = await fixture("after.html");

  // The miss: nothing declares the dot size, so nothing reports it.
  expect(
    componentFindings(
      await reviewFixture(browser, before, {
        checks: await projectChecks(project),
      }),
    ),
  ).toEqual([]);

  // Declined: nothing is written.
  const original = await readFile(projectPath, "utf8");
  const declined = await learnCommand({
    project,
    state: "editor",
    observation: "the override dots should be 8px",
    dependencies: { confirm: async () => false, gitTopology: noTopology },
  });
  expect(declined).toEqual({ recorded: false });
  expect(await readFile(projectPath, "utf8")).toBe(original);
  await expect(access(logPath)).rejects.toThrow();

  // Accepted: exactly the shown diff is written.
  let shown = "";
  const accepted = await learnCommand({
    project,
    state: "editor",
    observation: "the override dots should be 8px",
    dependencies: {
      confirm: async (diff) => {
        shown = diff;
        return true;
      },
      clock: () => new Date("2026-10-23T09:00:00.000Z"),
      gitTopology: noTopology,
    },
  });
  expect(accepted).toMatchObject({
    recorded: true,
    kind: "component",
    id: "learned-1",
    paths: [".idiom/project.json", ".idiom/learned.jsonl"],
  });
  const written = JSON.parse(await readFile(projectPath, "utf8"));
  expect(written.checks.components).toEqual([
    {
      name: "override dot",
      selector: ".bp-override-dot",
      width: 8,
      height: 8,
    },
  ]);
  expect(shown).toContain("--- a/.idiom/project.json");
  expect(shown).toContain('+        "selector": ".bp-override-dot",');
  expect(shown).toContain("--- /dev/null\n+++ b/.idiom/learned.jsonl");
  const writtenLines = new Set(
    (await readFile(projectPath, "utf8")).split("\n"),
  );
  const added = shown
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  const log = await readFile(logPath, "utf8");
  for (const line of added)
    expect(writtenLines.has(line) || log.includes(line)).toBe(true);
  const entries = log
    .trim()
    .split("\n")
    .map((line) => learnedEntrySchema.parse(JSON.parse(line)));
  expect(entries).toEqual([
    expect.objectContaining({
      id: "learned-1",
      kind: "component",
      flow: "studio-lab",
      state: "editor",
      observation: "the override dots should be 8px",
      target: { file: ".idiom/project.json", selector: ".bp-override-dot" },
      capture: {
        runId,
        viewport: "desktop",
        screenshot: "editor/desktop/screenshot.png",
      },
    }),
  ]);

  // The next check measures the dots against the learned size.
  const checks = await projectChecks(project);
  const reported = componentFindings(
    await reviewFixture(browser, before, { checks }),
  );
  expect(reported).toHaveLength(1);
  expect(reported[0]?.candidate.explanation).toContain('"override dot"');
  expect(reported[0]?.candidate.explanation).toContain("12×12");
  expect(
    componentFindings(await reviewFixture(browser, after, { checks })),
  ).toEqual([]);

  // Learning the same component again is refused.
  await expect(
    learnCommand({
      project,
      state: "editor",
      observation: "the override dots should be 8px",
      yes: true,
      dependencies: { gitTopology: noTopology },
    }),
  ).rejects.toThrow(/already declares "override dot"/);
}, 60_000);

test("--screenshot is copied only after confirmation", async () => {
  const project = await learnProject();
  const png = join(project, "annotated.png");
  await writeFile(
    png,
    await readFile(
      join(
        project,
        ".idiom",
        "reports",
        runId,
        "editor",
        "desktop",
        "screenshot.png",
      ),
    ),
  );
  const copied = join(project, ".idiom", "learned", "learned-1.png");
  let shown = "";
  await learnCommand({
    project,
    state: "editor",
    observation: "the override dots should be 8px",
    screenshot: png,
    dependencies: {
      confirm: async (diff) => {
        shown = diff;
        return false;
      },
      gitTopology: noTopology,
    },
  });
  expect(shown).toContain(
    `Binary file .idiom/learned/learned-1.png added (copied from ${png})`,
  );
  await expect(access(copied)).rejects.toThrow();
  const result = await learnCommand({
    project,
    state: "editor",
    observation: "the override dots should be 8px",
    screenshot: png,
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(result).toMatchObject({
    recorded: true,
    paths: expect.arrayContaining([".idiom/learned/learned-1.png"]),
  });
  await access(copied);
  await writeFile(join(project, "not.png"), "text");
  await expect(
    learnCommand({
      project,
      state: "editor",
      observation: "the override dots should be 8px",
      screenshot: join(project, "not.png"),
      yes: true,
      dependencies: { gitTopology: noTopology },
    }),
  ).rejects.toThrow(/not a PNG/);
}, 60_000);

test("--selector works without a capture; ambiguity and missing captures point at it", async () => {
  const { project } = await studioProject(directories);
  await expect(
    learnCommand({
      project,
      state: "editor",
      observation: "the override dots should be 8px",
      yes: true,
      dependencies: { gitTopology: noTopology },
    }),
  ).rejects.toThrow(/no capture of studio-lab\/editor found.*--selector/);
  const result = await learnCommand({
    project,
    state: "editor",
    observation: "the status pills should be 32×24px",
    selectors: [".pill"],
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(result).toMatchObject({ recorded: true, kind: "component" });
  expect((await projectChecks(project)) as unknown).toMatchObject({
    components: [
      { name: "status pill", selector: ".pill", width: 32, height: 24 },
    ],
  });
  const captured = await learnProject();
  await expect(
    learnCommand({
      project: captured,
      state: "editor",
      observation: "the rows should be 40px tall",
      yes: true,
      dependencies: { gitTopology: noTopology },
    }),
  ).rejects.toThrow(/pass --selector/);
  await expect(
    learnCommand({
      project: captured,
      state: "nowhere",
      observation: "the rows should be 40px tall",
      yes: true,
    }),
  ).rejects.toThrow(/no flow declares state "nowhere"/);
}, 60_000);

test("invariant, glossary and mirrored observations land in their check configuration", async () => {
  const { project } = await studioProject(directories);
  await learnCommand({
    project,
    state: "editor",
    observation: "the toolbar should be 48px tall",
    selectors: [".toolbar"],
    yes: true,
  });
  const flow = JSON.parse(
    await readFile(join(project, ".idiom", "flows", "studio-lab.json"), "utf8"),
  );
  expect(flow.states[0].invariants).toEqual([
    { name: "toolbar", selector: ".toolbar", height: 48 },
  ]);
  await learnCommand({
    project,
    state: "editor",
    observation: 'say "Sign in" not "Log in"',
    yes: true,
  });
  await learnCommand({
    project,
    state: "editor",
    observation: "the left rail and the right rail should mirror horizontally",
    selectors: [".rail-left", ".rail-right"],
    yes: true,
  });
  expect(await projectChecks(project)).toMatchObject({
    copy: { glossary: [{ term: "Log in", preferred: "Sign in" }] },
    mirrored: [
      {
        name: "left rail / right rail",
        a: ".rail-left",
        b: ".rail-right",
        axis: "horizontal",
      },
    ],
  });
  const log = (await readFile(join(project, ".idiom", "learned.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => learnedEntrySchema.parse(JSON.parse(line)));
  expect(log.map((entry) => [entry.id, entry.kind])).toEqual([
    ["learned-1", "invariant"],
    ["learned-2", "glossary"],
    ["learned-3", "mirrored"],
  ]);
}, 60_000);

test("free text becomes a design-law ruling through the ruling machinery", async () => {
  const project = await learnProject();
  const designPath = join(project, "DESIGN.md");
  const namesPath = join(project, ".idiom", "ruling-names.json");
  const design = await readFile(designPath, "utf8");
  const names = await readFile(namesPath, "utf8").catch(() => undefined);
  let shown = "";
  const declined = await learnCommand({
    project,
    state: "editor",
    observation: "section headers never use all caps",
    dependencies: {
      confirm: async (diff) => {
        shown = diff;
        return false;
      },
      gitTopology: noTopology,
    },
  });
  expect(declined).toEqual({ recorded: false });
  expect(shown).toContain("<!-- idiom:ruling:start -->");
  expect(shown).toContain("ruling-1");
  expect(await readFile(designPath, "utf8")).toBe(design);
  expect(await readFile(namesPath, "utf8").catch(() => undefined)).toBe(names);

  const accepted = await learnCommand({
    project,
    state: "editor",
    observation: "section headers never use all caps",
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(accepted).toMatchObject({ recorded: true, kind: "ruling" });
  const resolutions = parseRulingBlocks(
    await readFile(designPath, "utf8"),
  ).resolutions;
  expect(resolutions).toEqual([
    expect.objectContaining({
      id: "ruling-1",
      outcome: "rule",
      wording: "Section headers never use all caps.",
      reason: "Learned from human review of studio-lab/editor",
    }),
  ]);
  expect(await readFile(namesPath, "utf8")).toContain("ruling-1");
  const entry = learnedEntrySchema.parse(
    JSON.parse(
      (await readFile(join(project, ".idiom", "learned.jsonl"), "utf8")).trim(),
    ),
  );
  expect(entry).toMatchObject({
    kind: "ruling",
    target: { file: "DESIGN.md", rulingId: "ruling-1" },
  });
  // --ruling forces a ruling even for a size observation.
  const forced = await learnCommand({
    project,
    state: "editor",
    observation: "the override dots should be 8px",
    ruling: true,
    wording: "Override dots are 8px.",
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(forced).toMatchObject({ recorded: true, kind: "ruling" });
}, 60_000);

test("the learn CLI prints the diff, then the recorded id or the cancellation", async () => {
  const { project } = await studioProject(directories);
  const output: string[] = [];
  const cancelled = await run(
    [
      "node",
      "idiom",
      "learn",
      "the status pills should be 32×24px",
      "--state",
      "editor",
      "--selector",
      ".pill",
      "--project",
      project,
    ],
    {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message),
      learn: { confirm: async () => false },
    },
  );
  expect(cancelled).toBe(0);
  expect(output.join("")).toContain('+        "selector": ".pill",');
  expect(output.join("")).toContain("Cancelled; no files changed.");
  output.length = 0;
  const recorded = await run(
    [
      "node",
      "idiom",
      "learn",
      "the status pills should be 32×24px",
      "--state",
      "editor",
      "--selector",
      ".pill",
      "--yes",
      "--project",
      project,
    ],
    {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message),
    },
  );
  expect(recorded).toBe(0);
  expect(output.join("")).toContain(
    "Recorded learned-1 (component) — .idiom/project.json, .idiom/learned.jsonl",
  );
  expect(output.join("")).toContain("Next: idiom check studio-lab");
}, 60_000);
