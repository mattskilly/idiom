import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { captureTupleKey } from "../src/capture/resolve.js";
import { type RunRecord, runRecordSchema } from "../src/capture/run-record.js";
import type { CheckTuple } from "../src/checks/types.js";
import { run } from "../src/cli.js";
import {
  type CheckSummary,
  renderCheckSummary,
} from "../src/commands/check.js";
import { stateCoverageCommand } from "../src/commands/coverage.js";
import { initProject } from "../src/commands/init.js";
import {
  computeFlowStateCoverage,
  type FlowStateCoverage,
  renderStateCoverage,
  stateCoverageLine,
  uncapturedFlowCoverage,
} from "../src/coverage/states.js";
import {
  buildReviewCoverage,
  renderCoverageHtml,
  renderCoverageMarkdown,
} from "../src/report/coverage.js";
import { findNewestCapture } from "../src/review/artifacts.js";
import { type Flow, flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const noScore = /\b(?:score|grade|rating)s?\b/i;

function project(overrides: Record<string, unknown> = {}) {
  return projectSchema.parse({
    version: 1,
    app: { name: "Editor", framework: "other" },
    server: {
      build: "true",
      start: "true",
      port: 3000,
      readyUrl: "http://localhost:3000/",
      env: {},
    },
    viewports: [
      { name: "desktop", width: 1280, height: 800 },
      { name: "mobile", width: 375, height: 812 },
    ],
    colorSchemes: ["light", "dark"],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
    ...overrides,
  });
}

function flow(
  states: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Flow {
  return flowSchema.parse({
    id: "editor",
    title: "Editor",
    intent: [],
    setup: [],
    states: states.map((state) => ({
      description: String(state.id),
      url: "/",
      expect: {},
      ...state,
    })),
    ...extra,
  });
}

type Probe = {
  status?: "ran" | "partial" | "timed-out";
  results?: Array<{ status?: "completed" | "not-reached" }>;
  heldReplay?:
    | { queued: number; ran: number; reused?: number; notes?: string[] }
    | undefined;
  failureReplay?:
    | { queued: number; ran: number; reused?: number; notes?: string[] }
    | undefined;
};

function observations(options: {
  probe?: Probe | undefined;
  focus?: "ran" | "partial" | "absent";
  reducedMotion?: boolean | undefined;
}): CheckTuple["observations"] {
  const probe = options.probe;
  return {
    version: 2,
    elements: [],
    ...(options.reducedMotion === undefined
      ? {}
      : {
          motion: {
            version: 1,
            status: "ran",
            reducedMotion: options.reducedMotion,
            actions: [],
          },
        }),
    ...(probe === undefined
      ? {}
      : {
          probe: {
            status: probe.status ?? "ran",
            results: (probe.results ?? [{ status: "completed" as const }]).map(
              (result, index) => ({
                selector: `#c${index}`,
                name: `Control ${index}`,
                effects: [],
                persistent: false,
                ...result,
              }),
            ),
            ...(probe.heldReplay === undefined
              ? {}
              : {
                  heldReplay: {
                    delayMs: 1500,
                    notes: [],
                    ...probe.heldReplay,
                  },
                }),
            ...(probe.failureReplay === undefined
              ? {}
              : {
                  failureReplay: {
                    mode: "status" as const,
                    status: 500,
                    feedbackWithinMs: 1000,
                    completed: [],
                    notes: [],
                    ...probe.failureReplay,
                  },
                }),
          },
        }),
    ...(options.focus === undefined || options.focus === "absent"
      ? {}
      : {
          focusVisible:
            options.focus === "ran"
              ? { status: "ran" as const, records: [] }
              : {
                  status: "partial" as const,
                  reason: "budget",
                  records: [],
                },
        }),
  } as unknown as CheckTuple["observations"];
}

type Tuple = Parameters<typeof computeFlowStateCoverage>[0]["tuples"][number];

function tuple(
  state: string,
  viewport: string,
  colorScheme: "light" | "dark",
  extra: Partial<Tuple> = {},
): Tuple {
  return {
    state,
    viewport,
    colorScheme,
    mismatches: [],
    observations: observations({ focus: "ran" }),
    ...extra,
  };
}

function record(options: {
  flow: string;
  declared: Array<[string, string, "light" | "dark"]>;
  selected?: Array<[string, string, "light" | "dark"]>;
  executed?: Array<[string, string, "light" | "dark"]>;
  policy?: "once-per-state" | "everywhere" | "unsupported";
  reducedMotion?: boolean | undefined;
  viewports?: string[];
}): RunRecord {
  const coordinate = ([state, viewport, colorScheme]: [
    string,
    string,
    "light" | "dark",
  ]) => ({ state, viewport, colorScheme });
  const selected = (options.selected ?? options.declared).map(coordinate);
  const executed = (options.executed ?? []).map(coordinate);
  const timing = { status: "measured" as const, ms: 1 };
  return runRecordSchema.parse({
    version: 1,
    flow: options.flow,
    source: { commit: "abc123", dirty: false },
    declared: options.declared.map(coordinate),
    selected,
    viewports: (options.viewports ?? ["desktop", "mobile"]).map((name) => ({
      name,
      width: name === "mobile" ? 375 : 1280,
      height: 800,
    })),
    probe: {
      policy: options.policy ?? "once-per-state",
      fallback: false,
      intended: executed,
      executed,
    },
    timings: {
      build: timing,
      start: timing,
      tuples: selected.map((tuple) => ({
        ...tuple,
        total: timing,
        probe: timing,
      })),
      probe: timing,
      checks: timing,
    },
    ...(options.reducedMotion === undefined
      ? {}
      : { capture: { reducedMotion: options.reducedMotion } }),
  });
}

const grid = (
  state: string,
  viewports = ["desktop", "mobile"],
  schemes: Array<"light" | "dark"> = ["light", "dark"],
): Array<[string, string, "light" | "dark"]> =>
  viewports.flatMap((viewport) =>
    schemes.map(
      (scheme) =>
        [state, viewport, scheme] as [string, string, "light" | "dark"],
    ),
  );

const fullProbe: Probe = {
  heldReplay: { queued: 1, ran: 1 },
  failureReplay: { queued: 1, ran: 1 },
};

function dimension(coverage: FlowStateCoverage, state: string, label: string) {
  return coverage.states
    .find((entry) => entry.state === state)
    ?.dimensions.find((entry) => entry.label === label);
}

function allDimensionsCoverage(probe: Probe = fullProbe) {
  const editor = flow([{ id: "home" }]);
  const tuples = grid("home").map(([state, viewport, scheme], index) =>
    tuple(state, viewport, scheme, {
      observations: observations({
        focus: "ran",
        ...(index === 0 ? { probe } : {}),
      }),
    }),
  );
  return computeFlowStateCoverage({
    project: project(),
    flow: editor,
    runId: "2026-10-28T00-00-00-000Z",
    commit: "abc123def4567890",
    record: record({
      flow: "editor",
      declared: grid("home"),
      executed: [["home", "desktop", "light"]],
      reducedMotion: true,
    }),
    tuples,
  });
}

test("a full capture observes every dimension except the other reduced-motion mode", () => {
  const coverage = allDimensionsCoverage();
  const home = coverage.states[0];
  expect(
    home?.dimensions.filter((entry) => entry.status !== "observed"),
  ).toEqual([
    expect.objectContaining({
      label: "reduced motion off",
      status: "missing",
      remedy: expect.stringContaining('"reducedMotion": false'),
    }),
  ]);
  expect(home?.dimensions.map((entry) => entry.label)).toEqual([
    "viewport desktop",
    "viewport mobile",
    "light scheme",
    "dark scheme",
    "reduced motion on",
    "reduced motion off",
    "fast network",
    "slow network replay",
    "failure replay",
    "probe reached controls",
    "focus sweep",
  ]);
  expect(home).toMatchObject({ observed: 10, applicable: 11, percent: 91 });
  // No state declares data, so all four data dimensions are not applicable.
  expect(coverage.data.map((entry) => entry.status)).toEqual([
    "not-applicable",
    "not-applicable",
    "not-applicable",
    "not-applicable",
  ]);
  expect(coverage).toMatchObject({
    observed: 10,
    applicable: 11,
    notApplicable: 4,
    percent: 91,
  });
  expect(coverage.missing).toEqual([
    {
      label: "reduced motion off",
      remedy:
        'capture once with "capture": { "reducedMotion": false } in project.json',
      states: ["home"],
    },
  ]);
});

test("not applicable dimensions are excluded from the denominator", () => {
  const full = allDimensionsCoverage();
  const quiet = allDimensionsCoverage({
    heldReplay: { queued: 0, ran: 0 },
    failureReplay: { queued: 0, ran: 0 },
  });
  const states = (coverage: FlowStateCoverage) => coverage.states[0];
  expect(dimension(quiet, "home", "slow network replay")).toMatchObject({
    status: "not-applicable",
    reason: "no probed action sent requests",
  });
  expect(dimension(quiet, "home", "failure replay")?.status).toBe(
    "not-applicable",
  );
  expect(states(quiet)?.applicable).toBe((states(full)?.applicable ?? 0) - 2);
  expect(states(quiet)?.observed).toBe((states(full)?.observed ?? 0) - 2);
  expect(states(quiet)?.percent).toBe(Math.round((8 * 100) / 9));
  expect(quiet.notApplicable).toBe(full.notApplicable + 2);
  expect(quiet.missing.map((gap) => gap.label)).toEqual(["reduced motion off"]);
});

test("a web-step replay copied from another state counts as observed", () => {
  const copied = allDimensionsCoverage({
    heldReplay: { queued: 1, ran: 0, reused: 1 },
    failureReplay: { queued: 0, ran: 0, reused: 1 },
  });
  expect(dimension(copied, "home", "slow network replay")?.status).toBe(
    "observed",
  );
  expect(dimension(copied, "home", "failure replay")?.status).toBe("observed");
});

test("an unsupported probe makes replays and the probe not applicable", () => {
  const coverage = computeFlowStateCoverage({
    project: project(),
    flow: flow([{ id: "home" }]),
    record: record({
      flow: "editor",
      declared: grid("home"),
      policy: "unsupported",
      reducedMotion: true,
    }),
    tuples: grid("home").map(([s, v, c]) => tuple(s, v, c)),
  });
  for (const label of [
    "slow network replay",
    "failure replay",
    "probe reached controls",
    // The focus sweep runs inside the probe pass.
    "focus sweep",
  ])
    expect(dimension(coverage, "home", label)).toMatchObject({
      status: "not-applicable",
      reason: "the probe is not supported for this target",
    });
  expect(coverage.states[0]).toMatchObject({ observed: 6, applicable: 7 });
});

test("an Electron flow without a run record treats the probe as unsupported", () => {
  const electron = flowSchema.parse({
    id: "desk",
    title: "Desk",
    intent: [],
    setup: [],
    target: {
      kind: "electron",
      launch: { executablePath: "/bin/app" },
      window: { title: "App" },
    },
    states: [{ id: "main", description: "Main", expect: {}, data: "many" }],
  });
  const coverage = computeFlowStateCoverage({
    project: project(),
    flow: electron,
    tuples: grid("main").map(([s, v, c]) => tuple(s, v, c)),
  });
  expect(dimension(coverage, "main", "probe reached controls")?.status).toBe(
    "not-applicable",
  );
  expect(coverage.data.find((entry) => entry.value === "many")?.status).toBe(
    "observed",
  );
});

test("each missing dimension names the change that covers it", () => {
  const narrowed = flow(
    [
      { id: "home", probe: false },
      { id: "panel", viewports: ["desktop"] },
    ],
    { viewports: ["desktop"] },
  );
  const lightOnly = project({ colorSchemes: undefined });
  const coverage = computeFlowStateCoverage({
    project: lightOnly,
    flow: narrowed,
    record: record({
      flow: "editor",
      declared: [
        ["home", "desktop", "light"],
        ["panel", "desktop", "light"],
      ],
      executed: [["panel", "desktop", "light"]],
      viewports: ["desktop"],
      reducedMotion: true,
    }),
    tuples: [
      tuple("home", "desktop", "light"),
      tuple("panel", "desktop", "light", {
        observations: observations({
          focus: "ran",
          probe: {
            results: [{ status: "completed" }, { status: "not-reached" }],
            heldReplay: { queued: 2, ran: 0, notes: [] },
            failureReplay: { queued: 1, ran: 1 },
          },
        }),
      }),
    ],
  });
  expect(dimension(coverage, "home", "viewport mobile")?.remedy).toBe(
    'add "mobile" to "viewports" in flow editor',
  );
  expect(dimension(coverage, "home", "dark scheme")?.remedy).toContain(
    'add "dark" to "colorSchemes" in project.json',
  );
  expect(dimension(coverage, "home", "probe reached controls")?.remedy).toBe(
    'set "probe": true on state home in flow editor',
  );
  expect(dimension(coverage, "panel", "probe reached controls")?.remedy).toBe(
    "raise checks.probe.maxControls (now 80) or split the state",
  );
  expect(dimension(coverage, "panel", "slow network replay")?.remedy).toContain(
    "the probe budget ran out before the replay",
  );
  expect(dimension(coverage, "panel", "failure replay")?.status).toBe(
    "observed",
  );
  const gap = coverage.missing.find(
    (entry) => entry.label === "viewport mobile",
  );
  expect(gap?.states).toEqual(["home", "panel"]);
});

test("a state's own viewport narrowing names the state", () => {
  const coverage = computeFlowStateCoverage({
    project: project(),
    flow: flow([{ id: "panel", viewports: ["desktop"] }]),
    record: record({
      flow: "editor",
      declared: grid("panel", ["desktop"]),
      reducedMotion: true,
    }),
    tuples: grid("panel", ["desktop"]).map(([s, v, c]) => tuple(s, v, c)),
  });
  expect(dimension(coverage, "panel", "viewport mobile")).toMatchObject({
    reason: "excluded by state",
    remedy: 'add "mobile" to "viewports" on state panel in flow editor',
  });
});

test("a flow-excluded colour scheme names the flow", () => {
  const coverage = computeFlowStateCoverage({
    project: project(),
    flow: flow([{ id: "home" }], { colorSchemes: ["light"] }),
    tuples: grid("home", undefined, ["light"]).map(([s, v, c]) =>
      tuple(s, v, c),
    ),
  });
  expect(dimension(coverage, "home", "dark scheme")?.remedy).toBe(
    'add "dark" to "colorSchemes" in flow editor',
  );
});

test("scoped runs and failed tuples say why they were not observed", () => {
  const coverage = computeFlowStateCoverage({
    project: project(),
    flow: flow([{ id: "home" }]),
    record: record({
      flow: "editor",
      declared: grid("home"),
      selected: grid("home", ["desktop"]),
      reducedMotion: true,
    }),
    tuples: [
      tuple("home", "desktop", "light", {
        failure: { stage: "navigation", message: "timeout" },
      }),
      tuple("home", "desktop", "dark"),
    ],
  });
  expect(dimension(coverage, "home", "viewport mobile")).toMatchObject({
    reason: "not selected",
    remedy: "recapture the whole flow: idiom capture editor",
  });
  expect(dimension(coverage, "home", "light scheme")).toMatchObject({
    reason: "failed",
    remedy: "fix the navigation failure at home/desktop/light and recapture",
  });
  expect(dimension(coverage, "home", "dark scheme")?.status).toBe("observed");
});

test("collapsed combination tuples count as observed through their representative", () => {
  const coverage = computeFlowStateCoverage({
    project: project({
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
    }),
    flow: flow([{ id: "home" }], { colorSchemes: ["light"] }),
    record: record({
      flow: "editor",
      declared: [["home", "desktop", "light"]],
      viewports: ["desktop"],
      reducedMotion: true,
    }),
    tuples: [],
    collapsedTupleKeys: [
      captureTupleKey({
        state: "home",
        viewport: "desktop",
        colorScheme: "light",
      }),
    ],
  });
  expect(dimension(coverage, "home", "viewport desktop")?.status).toBe(
    "observed",
  );
});

test("declared data states report undeclared and failed kinds", () => {
  const coverage = computeFlowStateCoverage({
    project: project({
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
    }),
    flow: flow(
      [
        { id: "list", data: "many" },
        { id: "broken", data: "error" },
      ],
      { colorSchemes: ["light"] },
    ),
    record: record({
      flow: "editor",
      declared: [
        ["list", "desktop", "light"],
        ["broken", "desktop", "light"],
      ],
      viewports: ["desktop"],
      reducedMotion: true,
    }),
    tuples: [
      tuple("list", "desktop", "light"),
      tuple("broken", "desktop", "light", {
        failure: { stage: "setup", message: "seed failed" },
      }),
    ],
  });
  expect(
    coverage.data.map(({ value, status, remedy }) => ({
      value,
      status,
      remedy,
    })),
  ).toEqual([
    {
      value: "empty",
      status: "missing",
      remedy:
        'add a state with "data": "empty" to flow editor, seeded by a "setup" command',
    },
    {
      value: "one",
      status: "missing",
      remedy:
        'add a state with "data": "one" to flow editor, seeded by a "setup" command',
    },
    { value: "many", status: "observed", remedy: undefined },
    {
      value: "error",
      status: "missing",
      remedy: "fix the setup failure at broken/desktop/light and recapture",
    },
  ]);
  expect(coverage.missing.filter((gap) => gap.label.endsWith(" data"))).toEqual(
    [
      expect.objectContaining({ label: "empty data", states: [] }),
      expect.objectContaining({ label: "one data", states: [] }),
      expect.objectContaining({ label: "error data", states: [] }),
    ],
  );
});

test("reduced motion falls back to the observation, then asks for a recapture", () => {
  const base = {
    project: project(),
    flow: flow([{ id: "home" }]),
    record: record({ flow: "editor", declared: grid("home") }),
  };
  const fromObservation = computeFlowStateCoverage({
    ...base,
    tuples: grid("home").map(([s, v, c]) =>
      tuple(s, v, c, {
        observations: observations({ focus: "ran", reducedMotion: false }),
      }),
    ),
  });
  expect(dimension(fromObservation, "home", "reduced motion off")?.status).toBe(
    "observed",
  );
  expect(dimension(fromObservation, "home", "reduced motion on")?.remedy).toBe(
    'capture once with "capture": { "reducedMotion": true } in project.json',
  );
  const unknown = computeFlowStateCoverage({
    ...base,
    tuples: grid("home").map(([s, v, c]) => tuple(s, v, c)),
  });
  for (const label of ["reduced motion on", "reduced motion off"])
    expect(dimension(unknown, "home", label)?.remedy).toBe(
      "recapture with this Idiom version: idiom capture editor",
    );
});

test("the focus sweep reports a disabled check and an incomplete scan", () => {
  const disabled = computeFlowStateCoverage({
    project: project({ checks: { focusVisible: { enabled: false } } }),
    flow: flow([{ id: "home" }]),
    tuples: grid("home").map(([s, v, c]) => tuple(s, v, c)),
  });
  expect(dimension(disabled, "home", "focus sweep")?.remedy).toBe(
    "set checks.focusVisible.enabled: true in project.json",
  );
  const probeOff = computeFlowStateCoverage({
    project: project(),
    flow: flow([{ id: "home", probe: false }]),
    tuples: grid("home").map(([s, v, c]) => tuple(s, v, c)),
  });
  expect(dimension(probeOff, "home", "focus sweep")?.remedy).toBe(
    'set "probe": true on state home in flow editor',
  );
  const partial = computeFlowStateCoverage({
    project: project(),
    flow: flow([{ id: "home" }]),
    tuples: grid("home").map(([s, v, c]) =>
      tuple(s, v, c, {
        observations: observations({ focus: "partial", probe: fullProbe }),
      }),
    ),
  });
  expect(dimension(partial, "home", "focus sweep")?.remedy).toContain(
    "(budget)",
  );
});

test("state coverage wording describes coverage, never quality", () => {
  const coverage = allDimensionsCoverage();
  const complete = { ...coverage, missing: [] };
  const uncaptured = uncapturedFlowCoverage(flow([{ id: "home" }]));
  const coverageBlock = buildReviewCoverage({
    flow: flow([{ id: "home" }]),
    project: project(),
    tuples: [],
    commit: "abc",
    stateCoverage: coverage,
  });
  const summary = {
    flow: "editor",
    reportPath: "/tmp/report.md",
    findings: [],
    blocking: 0,
    coverage: coverageBlock,
  } as unknown as CheckSummary;
  const outputs = {
    line: stateCoverageLine(coverage),
    complete: stateCoverageLine(complete),
    uncaptured: stateCoverageLine(uncaptured),
    table: renderStateCoverage({ flows: [coverage, uncaptured] }),
    markdown: renderCoverageMarkdown(coverageBlock),
    html: renderCoverageHtml(coverageBlock),
    check: renderCheckSummary(summary),
  };
  for (const [name, text] of Object.entries(outputs)) {
    expect(text, name).not.toMatch(noScore);
    expect(text, name).toContain("not a measure of quality");
  }
  expect(outputs.line).toBe(
    "State coverage: 10 of 11 applicable dimensions observed (91%), 4 not applicable; not observed: reduced motion off. This is coverage of what was reviewed, not a measure of quality; run `idiom coverage --states` for the changes that cover the rest.",
  );
  expect(outputs.complete).toBe(
    "State coverage: 10 of 11 applicable dimensions observed (91%), 4 not applicable. This is coverage of what was reviewed, not a measure of quality.",
  );
  expect(outputs.uncaptured).toContain(
    "not captured yet; run `idiom capture editor`",
  );
  // A clean check has no report line, so state coverage ends the output.
  expect(outputs.check.trimEnd().split("\n").at(-1)).toBe(outputs.line);
  expect(outputs.html).toContain("<dt>State coverage</dt>");
  expect(outputs.table).toContain(
    "| home | 10 | 11 | 91 | reduced motion off |",
  );
  expect(outputs.table).toContain("- reduced motion off (home): capture once");
  // Reports without state coverage keep their old shape.
  const plain = buildReviewCoverage({
    flow: flow([{ id: "home" }]),
    project: project(),
    tuples: [],
    commit: "abc",
  });
  expect(renderCoverageMarkdown(plain)).not.toContain("State coverage");
});

test("the one line lists four labels and counts the rest", () => {
  const coverage = computeFlowStateCoverage({
    project: project({ colorSchemes: undefined }),
    flow: flow([{ id: "home", probe: false }], { viewports: ["desktop"] }),
    tuples: [tuple("home", "desktop", "light")],
  });
  const line = stateCoverageLine(coverage);
  expect(line).toContain(
    "not observed: viewport mobile, dark scheme, reduced motion on, reduced motion off, +",
  );
  expect(line).toMatch(/\+\d+ more\./);
});

async function writeRun(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  const directory = join(root, ".idiom", "reports", name);
  await mkdir(directory, { recursive: true });
  for (const [file, content] of Object.entries(files))
    await writeFile(join(directory, file), content);
}

test("findNewestCapture picks each flow's newest run, by run.json or baseline.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "idiom-state-coverage-"));
  directories.push(root);
  await writeRun(root, "2026-10-01T00-00-00-000Z", {
    "run.json": JSON.stringify({ flow: "a" }),
  });
  await writeRun(root, "2026-10-03T00-00-00-000Z", {
    "run.json": JSON.stringify({ flow: "a" }),
  });
  await writeRun(root, "2026-10-04T00-00-00-000Z", {
    "baseline.md": "# Baseline\n\nFlow `b`: 1 passed, 2 failed\n",
  });
  await writeRun(root, "2026-10-05T00-00-00-000Z", {
    "run.json": JSON.stringify({ flow: "c" }),
  });
  await mkdir(join(root, ".idiom", "reports", "verify-2026"), {
    recursive: true,
  });
  expect(await findNewestCapture({ projectDirectory: root, flow: "a" })).toBe(
    join(root, ".idiom", "reports", "2026-10-03T00-00-00-000Z"),
  );
  expect(await findNewestCapture({ projectDirectory: root, flow: "b" })).toBe(
    join(root, ".idiom", "reports", "2026-10-04T00-00-00-000Z"),
  );
  expect(
    await findNewestCapture({ projectDirectory: root, flow: "missing" }),
  ).toBeUndefined();
});

async function siteProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "idiom-state-coverage-"));
  directories.push(root);
  await initProject({ project: root, yes: true });
  await writeFile(
    join(root, ".idiom/flows/site.json"),
    JSON.stringify({
      id: "site",
      title: "Site",
      intent: [],
      setup: [],
      states: [{ id: "home", description: "Home", url: "/", expect: {} }],
    }),
  );
  return root;
}

test("stateCoverageCommand reports every flow with no runs as not captured", async () => {
  const root = await siteProject();
  const summary = await stateCoverageCommand({ project: root, cwd: root });
  expect(
    summary.flows.map((entry) => [entry.flow, entry.captured]),
  ).toContainEqual(["site", false]);
  expect(summary.flows.every((entry) => entry.percent === null)).toBe(true);
});

test("stateCoverageCommand reports an unreadable run instead of failing every flow", async () => {
  const root = await siteProject();
  await writeRun(root, "2026-10-01T00-00-00-000Z", {
    "run.json": JSON.stringify({ flow: "site", version: 9 }),
  });
  const summary = await stateCoverageCommand({ project: root, cwd: root });
  const site = summary.flows.find((entry) => entry.flow === "site");
  expect(site?.captured).toBe(false);
  expect(site?.missing[0]?.remedy).toMatch(/^recapture: invalid run\.json/);
});

test("state data and run.json capture mode parse, and data survives from chains", () => {
  const parsed = flow([
    { id: "empty", data: "empty" },
    { id: "added", from: "empty", url: undefined, data: "one" },
  ]);
  expect(parsed.states.map((state) => state.data)).toEqual(["empty", "one"]);
  expect(() => flow([{ id: "home", data: "lots" }])).toThrow();
  expect(
    flowSchema.safeParse({
      id: "desk",
      title: "Desk",
      intent: [],
      setup: [],
      target: {
        kind: "electron",
        launch: { executablePath: "/bin/app" },
        window: { title: "App" },
      },
      states: [{ id: "main", description: "Main", expect: {}, data: "error" }],
    }).success,
  ).toBe(true);
  const base = record({ flow: "editor", declared: grid("home") });
  expect(base.capture).toBeUndefined();
  expect(
    record({ flow: "editor", declared: grid("home"), reducedMotion: false })
      .capture,
  ).toEqual({ reducedMotion: false });
});

test("idiom coverage --states prints JSON and refuses --crawl", async () => {
  const root = await siteProject();
  const stdout: string[] = [];
  const code = await run(
    ["node", "idiom", "coverage", "--states", "--json", "--project", root],
    { stdout: (message) => stdout.push(message), stderr: () => undefined },
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(stdout.join("")) as { flows: unknown[] };
  expect(Array.isArray(parsed.flows)).toBe(true);
  const text: string[] = [];
  expect(
    await run(["node", "idiom", "coverage", "--states", "--project", root], {
      stdout: (message) => text.push(message),
      stderr: () => undefined,
    }),
  ).toBe(0);
  expect(text.join("")).toContain("not a measure of quality");
  const errors: string[] = [];
  const refused = await run(
    [
      "node",
      "idiom",
      "coverage",
      "--states",
      "--crawl",
      "http://localhost:3000/",
      "--project",
      root,
    ],
    { stdout: () => undefined, stderr: (message) => errors.push(message) },
  );
  expect(refused).toBe(1);
  expect(errors.join("")).toContain("--states cannot be combined with --crawl");
});
