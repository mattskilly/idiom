import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { learnCommand } from "../src/commands/learn.js";
import { placeObservation } from "../src/learn/place.js";
import { webStateSchema } from "../src/schemas/flow.js";
import { learnedEntrySchema } from "../src/schemas/learned.js";
import { validateProject } from "../src/validation.js";
import { fixture } from "./benchmark-support.js";
import { storedRun, studioProject } from "./stored-run-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const runId = "2026-10-22T12-00-00-000Z";
const noTopology = async () => undefined;

/** A studio-lab project with a stored run of `editor` and `settings`. */
async function placeProject() {
  const { project, commit } = await studioProject(directories, [
    "editor",
    "settings",
  ]);
  await storedRun(project, runId, commit, [
    { state: "editor", html: "before.html" },
    { state: "settings", html: "copy-before.html" },
  ]);
  return project;
}

/** Draw a red annotation stroke on a PNG, the way a human marks a miss. */
function annotate(bytes: Buffer): Buffer {
  const png = PNG.sync.read(bytes);
  const [x0, x1] = [Math.floor(png.width * 0.3), Math.floor(png.width * 0.5)];
  const [y0, y1] = [Math.floor(png.height * 0.3), Math.floor(png.height * 0.5)];
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      if (x - x0 >= 5 && x1 - x > 5 && y - y0 >= 5 && y1 - y > 5) continue;
      const offset = (y * png.width + x) * 4;
      png.data.set([230, 20, 20, 255], offset);
    }
  return PNG.sync.write(png);
}

async function screenshotOf(html: string, path: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.setContent(html);
    await writeFile(path, await page.screenshot());
  } finally {
    await browser.close();
  }
  return path;
}

async function records(project: string) {
  return (await readFile(join(project, ".idiom", "learned.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => learnedEntrySchema.parse(JSON.parse(line)));
}

test("a screenshot of a captured state is matched to it with no --state, and the record carries the match", async () => {
  const project = await placeProject();
  const stored = join(
    project,
    ".idiom",
    "reports",
    runId,
    "editor",
    "desktop",
    "screenshot.png",
  );
  const screenshot = join(project, "annotated.png");
  await writeFile(screenshot, annotate(await readFile(stored)));
  const output: string[] = [];
  let asked = false;
  const result = await learnCommand({
    project,
    observation: "the override dots should be 8px",
    screenshot,
    yes: true,
    write: (message) => output.push(message),
    dependencies: {
      gitTopology: noTopology,
      confirm: async () => {
        asked = true;
        return true;
      },
    },
  });
  expect(asked).toBe(false);
  expect(result).toMatchObject({
    recorded: true,
    kind: "component",
    placement: { via: "screenshot", confidence: "high", runId },
  });
  expect(output[0]).toMatch(
    new RegExp(
      `^Matched screenshot to studio-lab/editor @ desktop \\(run ${runId}\\), \\d+% similar, high confidence; next closest studio-lab/settings @ desktop, \\d+%\\.$`,
    ),
  );
  const [entry] = await records(project);
  expect(entry).toMatchObject({
    state: "editor",
    kind: "component",
    capture: {
      runId,
      viewport: "desktop",
      screenshot: "editor/desktop/screenshot.png",
    },
    target: { file: ".idiom/project.json", selector: expect.any(String) },
    candidate: {
      rule: "Every override dot is 8×8px.",
      kind: "component",
      checkable: "deterministic",
    },
    placement: { via: "screenshot", confidence: "high", viewport: "desktop" },
    screenshot: ".idiom/learned/learned-1.png",
  });
  expect(entry?.placement?.similarity).toBeGreaterThanOrEqual(0.9);
  await expect(access(join(project, ".idiom", "proposals"))).rejects.toThrow();
}, 60_000);

test("a screenshot of an uncaptured state records the miss open with a draft state proposal, written only on confirm", async () => {
  const project = await placeProject();
  const screenshot = await screenshotOf(
    await fixture("scale-before.html"),
    join(project, "uncaptured.png"),
  );
  const proposalPath = join(
    project,
    ".idiom",
    "proposals",
    "states",
    "learned-1.json",
  );

  // Declined: nothing is written, the proposal included.
  let shown = "";
  const declined = await learnCommand({
    project,
    observation: "the export menu items should be 32px tall",
    screenshot,
    dependencies: {
      gitTopology: noTopology,
      confirm: async (diff) => {
        shown = diff;
        return false;
      },
    },
  });
  expect(declined).toEqual({ recorded: false });
  expect(shown).toContain("+++ b/.idiom/proposals/states/learned-1.json");
  await expect(access(proposalPath)).rejects.toThrow();
  await expect(
    access(join(project, ".idiom", "learned.jsonl")),
  ).rejects.toThrow();

  const output: string[] = [];
  const result = await learnCommand({
    project,
    observation: "the export menu items should be 32px tall",
    screenshot,
    yes: true,
    write: (message) => output.push(message),
    dependencies: { gitTopology: noTopology },
  });
  expect(result).toMatchObject({
    recorded: true,
    kind: "observation",
    proposal: ".idiom/proposals/states/learned-1.json",
    placement: {
      via: "proposed",
      proposal: ".idiom/proposals/states/learned-1.json",
    },
  });
  expect(result.recorded && result.next).toBe(
    "Next: add the draft state in .idiom/proposals/states/learned-1.json to .idiom/flows/studio-lab.json, then idiom capture studio-lab.",
  );
  expect(output[0]).toMatch(
    /^No captured state matches the screenshot well enough \(closest studio-lab\/\w+ @ desktop, \d+%\); recording the miss as open against a draft state studio-lab\/export-menu-item-32px — \.idiom\/proposals\/states\/learned-1\.json\.$/,
  );
  const proposal = JSON.parse(await readFile(proposalPath, "utf8"));
  expect(proposal).toMatchObject({
    version: 1,
    learned: "learned-1",
    flow: "studio-lab",
    file: ".idiom/flows/studio-lab.json",
    observation: "the export menu items should be 32px tall",
    nearest: { flow: "studio-lab", viewport: "desktop", runId },
    state: {
      id: "export-menu-item-32px",
      description: "The export menu items should be 32px tall.",
      steps: [],
    },
  });
  expect(["editor", "settings"]).toContain(proposal.state.from);
  expect(webStateSchema.safeParse(proposal.state).success).toBe(true);

  const [entry] = await records(project);
  expect(entry).toMatchObject({
    flow: "studio-lab",
    state: proposal.state.id,
    kind: "observation",
    target: { file: ".idiom/proposals/states/learned-1.json" },
    entry: { name: "export menu items", height: 32 },
    candidate: {
      rule: "The export menu items are 32px tall.",
      kind: "invariant",
      checkable: "deterministic",
    },
    placement: { via: "proposed" },
  });
  expect(entry?.capture).toBeUndefined();
  // The flow manifest is untouched and the project still validates.
  expect(
    (await validateProject({ project })).flows[0]?.flow.states.map(
      (state) => state.id,
    ),
  ).toEqual(["editor", "settings"]);

  // Once the draft state is added to the flow, the miss lists as matched.
  const listed: string[] = [];
  await run(["node", "idiom", "learn", "--list", "--project", project], {
    stdout: (message) => listed.push(message),
  });
  expect(listed.join("")).toContain(
    "learned-1  open  studio-lab/export-menu-item-32px (state proposed: .idiom/proposals/states/learned-1.json)  observation",
  );
  const flowPath = join(project, ".idiom", "flows", "studio-lab.json");
  const flow = JSON.parse(await readFile(flowPath, "utf8"));
  flow.states.push(proposal.state);
  await writeFile(flowPath, JSON.stringify(flow));
  listed.length = 0;
  await run(["node", "idiom", "learn", "--list", "--project", project], {
    stdout: (message) => listed.push(message),
  });
  expect(listed.join("")).toContain(
    "learned-1  open  studio-lab/export-menu-item-32px (state matched, added)  observation",
  );
}, 60_000);

test("a proposed state still applies project-wide config: glossary and selector-given components", async () => {
  const project = await placeProject();
  const screenshot = await screenshotOf(
    await fixture("scale-before.html"),
    join(project, "uncaptured.png"),
  );
  const glossary = await learnCommand({
    project,
    observation: 'say "Sign in", not "Log in"',
    screenshot,
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(glossary).toMatchObject({ recorded: true, kind: "glossary" });
  const checks = JSON.parse(
    await readFile(join(project, ".idiom", "project.json"), "utf8"),
  ).checks;
  expect(checks.copy.glossary).toContainEqual({
    term: "Log in",
    preferred: "Sign in",
  });
  const component = await learnCommand({
    project,
    observation: "the status pills should be 32×24px",
    screenshot,
    selectors: [".pill"],
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(component).toMatchObject({ recorded: true, kind: "component" });
  const [first, second] = await records(project);
  expect(first).toMatchObject({
    kind: "glossary",
    state: "say-sign-log",
    candidate: {
      rule: 'Say "Sign in", not "Log in".',
      checkable: "deterministic",
    },
    placement: { via: "proposed" },
  });
  expect(second).toMatchObject({
    kind: "component",
    state: "status-pill-32-24px",
    target: { selector: ".pill" },
    placement: {
      via: "proposed",
      proposal: ".idiom/proposals/states/learned-2.json",
    },
  });
}, 60_000);

test("with no screenshot the words place the observation, or it is proposed when they are ambiguous", async () => {
  const project = await placeProject();
  const named = await learnCommand({
    project,
    observation: "the settings toggle labels feel cramped",
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(named).toMatchObject({
    recorded: true,
    kind: "ruling",
    placement: { via: "words", tokens: ["setting"] },
  });
  const ambiguous = await learnCommand({
    project,
    observation: "the toolbar labels feel cramped",
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(ambiguous).toMatchObject({
    recorded: true,
    kind: "ruling",
    placement: { via: "proposed" },
  });
  const reference = await learnCommand({
    project,
    observation: "the editor header should match the figma mock",
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(reference).toMatchObject({
    placement: { via: "words", tokens: ["editor"] },
  });
  const [first, second, third] = await records(project);
  expect(first).toMatchObject({
    state: "settings",
    candidate: {
      rule: "The settings toggle labels feel cramped.",
      kind: "ruling",
      checkable: "judged",
    },
  });
  expect(second).toMatchObject({
    state: "toolbar-label-feel-cramped",
    kind: "ruling",
    target: { rulingId: expect.stringMatching(/^ruling-/) },
  });
  expect(third).toMatchObject({
    state: "editor",
    candidate: { checkable: "reference" },
  });
  const design = await readFile(join(project, "DESIGN.md"), "utf8");
  expect(design).toContain(
    "Learned from human review (state proposed: studio-lab/toolbar-label-feel-cramped)",
  );

  // A project with one declared state uses it.
  const { project: single } = await studioProject(directories);
  const only = await learnCommand({
    project: single,
    observation: "the layout feels heavy",
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(only).toMatchObject({
    recorded: true,
    placement: { via: "only-state" },
  });
}, 60_000);

test("--state placements are recorded as such; the CLI says when a state is proposed", async () => {
  const project = await placeProject();
  await learnCommand({
    project,
    state: "editor",
    observation: "the status pills should be 32×24px",
    selectors: [".pill"],
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect((await records(project))[0]?.placement).toEqual({ via: "state" });

  const output: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "learn",
      "the toolbar labels feel cramped",
      "--yes",
      "--project",
      project,
    ],
    {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message),
      learn: { gitTopology: noTopology },
    },
  );
  expect(code).toBe(0);
  expect(output.join("\n")).toContain(
    "Recorded learned-2 (ruling), open, with a draft flow state proposal — .idiom/proposals/states/learned-2.json,",
  );
}, 60_000);

/** A schema-valid run record of a capture that never finished. */
function interruptedRecord(id: string, commit: string) {
  const tuple = { state: "editor", viewport: "desktop", colorScheme: "light" };
  const phase = { status: "measured", ms: 1 };
  return {
    version: 1,
    status: "interrupted",
    runId: id,
    owner: { pid: 1 },
    startedAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:01.000Z",
    completedTuples: [],
    interruption: { reason: "signal", signal: "SIGINT" },
    flow: "studio-lab",
    source: { commit, dirty: false },
    declared: [tuple],
    selected: [tuple],
    viewports: [{ name: "desktop", width: 1440, height: 900 }],
    probe: {
      policy: "once-per-state",
      fallback: false,
      intended: [],
      executed: [],
    },
    timings: {
      build: phase,
      start: phase,
      tuples: [{ ...tuple, total: phase, probe: phase }],
      probe: phase,
      checks: phase,
    },
  };
}

/** Folders under .idiom/reports/ that are not complete runs with simple IDs. */
const incompleteRun = "2026-10-23T12-00-00-000Z";
async function pollute(project: string, commit: string) {
  const reports = join(project, ".idiom", "reports");
  await mkdir(join(reports, ".cache"), { recursive: true });
  const notes = join(reports, "my notes", "editor", "desktop");
  await mkdir(notes, { recursive: true });
  await writeFile(join(notes, "dom.html"), "<main>stray</main>");
  // A newer run that never finished: its editor capture must not be used.
  await storedRun(project, incompleteRun, commit, [
    { state: "editor", html: "before.html" },
  ]);
  await writeFile(
    join(reports, incompleteRun, "run.json"),
    JSON.stringify(interruptedRecord(incompleteRun, commit)),
  );
}

async function pollutedProject() {
  const { project, commit } = await studioProject(directories, [
    "editor",
    "settings",
  ]);
  await storedRun(project, runId, commit, [
    { state: "editor", html: "before.html" },
    { state: "settings", html: "copy-before.html" },
  ]);
  await pollute(project, commit);
  return project;
}

test("learn skips stored folders that are not complete runs: screenshot and --flow --state both use the newest complete run", async () => {
  const project = await pollutedProject();
  const stored = join(
    project,
    ".idiom",
    "reports",
    runId,
    "editor",
    "desktop",
    "screenshot.png",
  );
  const screenshot = join(project, "annotated.png");
  await writeFile(screenshot, annotate(await readFile(stored)));
  const fromScreenshot = await learnCommand({
    project,
    observation: "the override dots should be 8px",
    screenshot,
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(fromScreenshot).toMatchObject({
    recorded: true,
    placement: { via: "screenshot", runId },
  });

  await learnCommand({
    project,
    flow: "studio-lab",
    state: "editor",
    observation: "the status pills should be 32×24px",
    selectors: [".pill"],
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  const [first, second] = await records(project);
  expect(first).toMatchObject({
    flow: "studio-lab",
    state: "editor",
    capture: { runId },
  });
  expect(second).toMatchObject({
    flow: "studio-lab",
    state: "editor",
    capture: { runId },
  });
}, 60_000);

test("an explicit --from is still validated: a folder name or an unfinished run is refused", async () => {
  const project = await pollutedProject();
  await expect(
    learnCommand({
      project,
      state: "editor",
      from: "my notes",
      observation: "the status pills should be 32×24px",
      selectors: [".pill"],
      yes: true,
      dependencies: { gitTopology: noTopology },
    }),
  ).rejects.toThrow("--from must be a simple run ID beneath .idiom/reports");
  await expect(
    learnCommand({
      project,
      state: "editor",
      from: incompleteRun,
      observation: "the status pills should be 32×24px",
      selectors: [".pill"],
      yes: true,
      dependencies: { gitTopology: noTopology },
    }),
  ).rejects.toThrow(`Run ${incompleteRun} is interrupted`);
  await expect(
    access(join(project, ".idiom", "learned.jsonl")),
  ).rejects.toThrow();
}, 60_000);

const guideRun = "2026-10-21T12-00-00-000Z";

/**
 * Two flows: studio-lab (editor, settings) and tablet-guide (guide, editor,
 * options). Both declare `editor`, captured from the same page, and
 * tablet-guide/options is the same page as studio-lab/settings.
 */
async function multiFlowProject() {
  const { project, commit } = await studioProject(directories, [
    "editor",
    "settings",
  ]);
  await writeFile(
    join(project, ".idiom", "flows", "tablet-guide.json"),
    JSON.stringify({
      id: "tablet-guide",
      title: "Guide",
      intent: ["Tablet style guide"],
      setup: [],
      viewports: ["desktop"],
      states: ["guide", "editor", "options"].map((state) => ({
        id: state,
        description: state,
        url: `/guide/${state}`,
        expect: { status: 200 },
      })),
    }),
  );
  await storedRun(project, runId, commit, [
    { state: "editor", html: "before.html" },
    { state: "settings", html: "copy-before.html" },
  ]);
  const guideFlow = { flow: { id: "tablet-guide", title: "Guide" } };
  await storedRun(project, guideRun, commit, [
    { state: "guide", html: "empty-state-before.html", metadata: guideFlow },
    { state: "editor", html: "before.html", metadata: guideFlow },
    { state: "options", html: "copy-before.html", metadata: guideFlow },
  ]);
  await pollute(project, commit);
  return project;
}

const storedScreenshot = (project: string, run: string, state: string) =>
  join(project, ".idiom", "reports", run, state, "desktop", "screenshot.png");

test("with several flows, learn places on the flow the screenshot or words matched, and names the candidates when it cannot tell", async () => {
  const project = await multiFlowProject();

  // A screenshot of a state only the second flow declares lands there.
  const guide = join(project, "guide.png");
  await writeFile(
    guide,
    annotate(await readFile(storedScreenshot(project, guideRun, "guide"))),
  );
  const fromGuide = await learnCommand({
    project,
    observation: "the empty state heading feels cramped",
    screenshot: guide,
    ruling: true,
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(fromGuide).toMatchObject({
    recorded: true,
    kind: "ruling",
    placement: { via: "screenshot", runId: guideRun },
  });

  // A ruling whose words name a state of the first flow lands there.
  const ruling = await learnCommand({
    project,
    observation: "the settings toggle labels feel cramped",
    ruling: true,
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(ruling).toMatchObject({
    recorded: true,
    kind: "ruling",
    placement: { via: "words", tokens: ["setting"] },
  });
  const [first, second] = await records(project);
  expect(first).toMatchObject({ flow: "tablet-guide", state: "guide" });
  expect(second).toMatchObject({ flow: "studio-lab", state: "settings" });

  // Words naming a state both flows declare: ambiguous, nothing written.
  await expect(
    learnCommand({
      project,
      observation: "the editor header feels heavy",
      yes: true,
      dependencies: { gitTopology: noTopology },
    }),
  ).rejects.toThrow(
    "The words name states in several flows: studio-lab/editor, tablet-guide/editor; pass --flow <id> to choose.",
  );
  // Words that name nothing: ambiguous between every flow.
  await expect(
    learnCommand({
      project,
      observation: "the toolbar labels feel cramped",
      ruling: true,
      yes: true,
      dependencies: { gitTopology: noTopology },
    }),
  ).rejects.toThrow(
    "The words do not say which flow this is about (studio-lab, tablet-guide); pass --flow <id> or --state <id>.",
  );
  expect(await records(project)).toHaveLength(2);
  await expect(access(join(project, ".idiom", "proposals"))).rejects.toThrow();

  // --flow settles it: the draft state goes on that flow.
  const chosen = await learnCommand({
    project,
    flow: "tablet-guide",
    observation: "the toolbar labels feel cramped",
    ruling: true,
    yes: true,
    dependencies: { gitTopology: noTopology },
  });
  expect(chosen).toMatchObject({
    recorded: true,
    kind: "ruling",
    placement: { via: "proposed" },
  });
  expect((await records(project))[2]).toMatchObject({
    flow: "tablet-guide",
    state: "toolbar-label-feel-cramped",
  });
  const design = await readFile(join(project, "DESIGN.md"), "utf8");
  expect(design).toContain(
    "Learned from human review (state proposed: tablet-guide/toolbar-label-feel-cramped)",
  );
}, 90_000);

test("a screenshot too close to call between flows is reported, unless the words name one of the contenders", async () => {
  const project = await multiFlowProject();
  const flows = (await validateProject({ project })).flows;

  // The editor page is captured identically in both flows.
  const editor = join(project, "editor.png");
  await writeFile(
    editor,
    annotate(await readFile(storedScreenshot(project, runId, "editor"))),
  );
  const tied = await placeObservation({
    projectDirectory: project,
    flows,
    observation: "the override dots should be 8px",
    screenshot: editor,
    learnedId: "learned-1",
  });
  expect(tied.ambiguous?.candidates.sort()).toEqual([
    "studio-lab/editor",
    "tablet-guide/editor",
  ]);
  expect(tied.ambiguous?.message).toMatch(
    /^The screenshot matches states in several flows: (studio-lab|tablet-guide)\/editor \(\d+%\), (studio-lab|tablet-guide)\/editor \(\d+%\); pass --flow <id> to choose\.$/,
  );

  // The settings page ties with tablet-guide/options; the words settle it.
  const settings = join(project, "settings.png");
  await writeFile(
    settings,
    annotate(await readFile(storedScreenshot(project, runId, "settings"))),
  );
  const named = await placeObservation({
    projectDirectory: project,
    flows,
    observation: "the settings toggle labels feel cramped",
    screenshot: settings,
    learnedId: "learned-1",
  });
  expect(named.matched).toMatchObject({
    flow: { flow: { id: "studio-lab" } },
    state: "settings",
    placement: { via: "screenshot", confidence: "low", runId },
  });
  const unnamed = await placeObservation({
    projectDirectory: project,
    flows,
    observation: "the toggle labels feel cramped",
    screenshot: settings,
    learnedId: "learned-1",
  });
  expect(unnamed.ambiguous?.candidates.sort()).toEqual([
    "studio-lab/settings",
    "tablet-guide/options",
  ]);
}, 90_000);
