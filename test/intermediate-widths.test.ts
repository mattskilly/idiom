import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  intermediateCaptureTuples,
  intermediateViewport,
  intermediateWidthsFor,
} from "../src/capture/intermediate.js";
import { runRecordSchema } from "../src/capture/run-record.js";
import { probeCoordinates, resolveCaptureScope } from "../src/capture/scope.js";
import {
  checkTiming,
  combineCheckTimings,
  type GateTiming,
  type RunTimings,
  renderGateTimingLine,
  renderTimingLine,
  renderTimings,
} from "../src/capture/timings.js";
import {
  checksConfigFrom,
  intermediateWidthChecks,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type {
  CheckTuple,
  ObservationArtifactV2,
  ToolbarLayoutObservation,
} from "../src/checks/types.js";
import { buildCritiqueContext } from "../src/critique/context.js";
import { renderReport } from "../src/review/report.js";
import {
  effectiveIntermediateWidths,
  type Flow,
  flowSchema,
} from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
      { name: "tablet", width: 768, height: 1024, touch: true },
      { name: "desktop", width: 1280, height: 800 },
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

const viewport = (name: string, width: number, height = 800) => ({
  name,
  width,
  height,
});

// ---- schema ----

test("intermediateWidths accepts true, false and a width list on states and flows", () => {
  const parsed = flow(
    [
      { id: "a", intermediateWidths: true },
      { id: "b", intermediateWidths: false },
      { id: "c", intermediateWidths: [900, 1100] },
      { id: "d" },
    ],
    { intermediateWidths: true },
  );
  expect(effectiveIntermediateWidths(parsed, { id: "a" })).toBe(true);
  // A state's false opts out of the flow default.
  expect(effectiveIntermediateWidths(parsed, { id: "b" })).toBeUndefined();
  expect(effectiveIntermediateWidths(parsed, { id: "c" })).toEqual([900, 1100]);
  expect(effectiveIntermediateWidths(parsed, { id: "d" })).toBe(true);
  expect(
    effectiveIntermediateWidths(flow([{ id: "a" }]), { id: "a" }),
  ).toBeUndefined();
});

test("intermediateWidths rejects duplicates, out-of-range widths and electron flows", () => {
  const issues = (states: Array<Record<string, unknown>>) =>
    flowSchema.safeParse({
      id: "editor",
      title: "Editor",
      intent: [],
      setup: [],
      states: states.map((state) => ({
        description: "s",
        url: "/",
        expect: {},
        ...state,
      })),
    });
  expect(issues([{ id: "a", intermediateWidths: [900, 900] }]).success).toBe(
    false,
  );
  expect(issues([{ id: "a", intermediateWidths: [100] }]).success).toBe(false);
  expect(issues([{ id: "a", intermediateWidths: [5000] }]).success).toBe(false);
  expect(issues([{ id: "a", intermediateWidths: [] }]).success).toBe(false);
  expect(
    issues([
      {
        id: "a",
        intermediateWidths: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => 300 + n),
      },
    ]).success,
  ).toBe(false);
  expect(issues([{ id: "a", intermediateWidths: [901.5] }]).success).toBe(
    false,
  );
  const electron = flowSchema.safeParse({
    id: "desk",
    title: "Desk",
    intent: [],
    setup: [],
    target: { kind: "electron", main: "main.js" },
    intermediateWidths: true,
    states: [],
  });
  expect(electron.success).toBe(false);
});

test("toggle combinations take the base's own value, never the flow default", () => {
  const parsed = flow(
    [{ id: "plain" }, { id: "opted", intermediateWidths: [900] }],
    {
      intermediateWidths: true,
      toggles: {
        density: {
          compact: [],
          roomy: [{ action: "click", selector: "button" }],
        },
      },
    },
  );
  const combos = parsed.states.filter(
    (state) => "combination" in state && state.combination !== undefined,
  );
  expect(combos.length).toBeGreaterThan(0);
  for (const combo of combos) {
    const expected = combo.id.startsWith("opted") ? [900] : undefined;
    expect(effectiveIntermediateWidths(parsed, combo)).toEqual(expected);
  }
  expect(effectiveIntermediateWidths(parsed, { id: "plain" })).toBe(true);
});

// ---- resolution ----

test("the default is the midpoints plus 900 and 768 strictly inside the range", () => {
  expect(
    intermediateWidthsFor([viewport("t", 768), viewport("d", 1280)], true),
  ).toEqual([900, 1024]);
  expect(
    intermediateWidthsFor(
      [viewport("m", 375), viewport("t", 768), viewport("d", 1280)],
      true,
    ),
  ).toEqual([572, 900, 1024]);
  expect(intermediateWidthsFor([viewport("d", 1280)], true)).toEqual([]);
  // Duplicate declared widths are one width; 768 on the edge is not inside.
  expect(
    intermediateWidthsFor(
      [viewport("t", 768), viewport("t2", 768), viewport("d", 1280)],
      true,
    ),
  ).toEqual([900, 1024]);
});

test("explicit widths drop declared widths and may fall outside the range", () => {
  expect(
    intermediateWidthsFor(
      [viewport("t", 768), viewport("d", 1280)],
      [1600, 1280, 640, 900],
    ),
  ).toEqual([640, 900, 1600]);
});

test("a synthetic viewport borrows height and touch from its wider neighbour", () => {
  const declared = [
    { name: "phone", width: 375, height: 812, touch: true },
    { name: "tablet", width: 768, height: 1024, touch: true },
    viewport("desktop", 1280),
  ];
  expect(intermediateViewport(572, declared, [])).toEqual({
    name: "intermediate-572",
    width: 572,
    height: 1024,
    touch: true,
    intermediate: true,
  });
  expect(intermediateViewport(900, declared, [])).toEqual({
    name: "intermediate-900",
    width: 900,
    height: 800,
    intermediate: true,
  });
  // Wider than every declared viewport: the widest one.
  expect(intermediateViewport(1600, declared, []).height).toBe(800);
  expect(() =>
    intermediateViewport(900, declared, ["desktop", "intermediate-900"]),
  ).toThrow(/intermediate-900.*already declared/);
});

test("intermediate tuples use the default scheme only and follow scope", () => {
  const p = project();
  const f = flow([{ id: "editor", intermediateWidths: true }, { id: "list" }]);
  const add = (
    scope?: Parameters<typeof resolveCaptureScope>[0]["scope"],
    tuples?: Parameters<typeof resolveCaptureScope>[0]["tuples"],
  ) =>
    intermediateCaptureTuples({
      project: p,
      flow: f,
      selected: resolveCaptureScope({ project: p, flow: f, scope, tuples })
        .selected,
      scope,
    });
  const all = add();
  expect(
    all.tuples.map(
      (tuple) =>
        `${tuple.state.id}/${tuple.viewport.name}/${tuple.colorScheme}`,
    ),
  ).toEqual([
    "editor/intermediate-900/light",
    "editor/intermediate-1024/light",
  ]);
  expect(all.viewports.map((v) => v.name)).toEqual([
    "intermediate-900",
    "intermediate-1024",
  ]);
  expect(add({ viewports: "desktop" }).tuples).toEqual([]);
  expect(add({ schemes: "dark" }).tuples).toEqual([]);
  expect(add({ schemes: "light" }).tuples).toHaveLength(2);
  expect(add({ states: "list" }).tuples).toEqual([]);
  expect(add({ states: "editor" }).tuples).toHaveLength(2);
  expect(
    add(undefined, [
      { state: "editor", viewport: "desktop", colorScheme: "dark" },
    ]).tuples,
  ).toHaveLength(2);
  expect(
    add(undefined, [{ state: "list", viewport: "desktop" }]).tuples,
  ).toEqual([]);
  // The project default scheme, when the flow selects it; else its first.
  const dark = project({ capture: { colorScheme: "dark" } });
  expect(
    intermediateCaptureTuples({
      project: dark,
      flow: f,
      selected: resolveCaptureScope({ project: dark, flow: f }).selected,
    }).tuples[0]?.colorScheme,
  ).toBe("dark");
  const lightOnly = flow([{ id: "editor", intermediateWidths: true }], {
    colorSchemes: ["light"],
  });
  expect(
    intermediateCaptureTuples({
      project: dark,
      flow: lightOnly,
      selected: resolveCaptureScope({ project: dark, flow: lightOnly })
        .selected,
    }).tuples[0]?.colorScheme,
  ).toBe("light");
});

test("a project viewport named like an intermediate width is an explicit error", () => {
  const p = project({
    viewports: [viewport("tablet", 768), viewport("intermediate-900", 1280)],
  });
  const f = flow([{ id: "editor", intermediateWidths: true }]);
  expect(() =>
    intermediateCaptureTuples({
      project: p,
      flow: f,
      selected: resolveCaptureScope({ project: p, flow: f }).selected,
    }),
  ).toThrow(/intermediate-900/);
});

test("the probe never picks an intermediate tuple", () => {
  for (const everywhere of [false, true]) {
    const p = project({ checks: { probe: { everywhere } } });
    const f = flow([{ id: "editor", intermediateWidths: true }]);
    const selected = resolveCaptureScope({ project: p, flow: f }).selected;
    const extra = intermediateCaptureTuples({ project: p, flow: f, selected });
    // Put intermediates first so once-per-state would otherwise pick one.
    const policy = probeCoordinates(p, f, [...extra.tuples, ...selected]);
    expect(policy.intended.length).toBeGreaterThan(0);
    expect(
      policy.intended.some((tuple) =>
        tuple.viewport.startsWith("intermediate"),
      ),
    ).toBe(false);
  }
});

// ---- run record ----

const phase = (ms = 0) => ({ status: "measured" as const, ms });
const recordBase = {
  version: 1,
  flow: "editor",
  source: { commit: "c", dirty: false },
  probe: {
    policy: "once-per-state",
    fallback: false,
    intended: [],
    executed: [],
  },
};

test("run.json records intermediate viewports and timing flags; older records still parse", () => {
  const declared = {
    state: "editor",
    viewport: "desktop",
    colorScheme: "light",
  };
  const between = {
    state: "editor",
    viewport: "intermediate-900",
    colorScheme: "light",
  };
  const parsed = runRecordSchema.parse({
    ...recordBase,
    declared: [declared, between],
    selected: [declared, between],
    viewports: [
      viewport("desktop", 1280),
      { ...viewport("intermediate-900", 900), intermediate: true },
    ],
    timings: {
      build: phase(),
      start: phase(),
      probe: phase(),
      checks: phase(),
      tuples: [
        { ...declared, total: phase(1), probe: phase() },
        { ...between, total: phase(1), probe: phase(), intermediate: true },
      ],
    },
  });
  expect(parsed.viewports[1]?.intermediate).toBe(true);
  expect(parsed.timings.tuples[1]?.intermediate).toBe(true);
  expect(
    runRecordSchema.safeParse({
      ...recordBase,
      declared: [declared],
      selected: [declared],
      viewports: [viewport("desktop", 1280)],
      timings: {
        build: phase(),
        start: phase(),
        probe: phase(),
        checks: phase(),
        tuples: [{ ...declared, total: phase(1), probe: phase() }],
      },
    }).success,
  ).toBe(true);
});

// ---- checks ----

function observations(
  width: number,
  toolbar: Partial<ToolbarLayoutObservation>,
): ObservationArtifactV2 {
  return {
    version: 2,
    viewport: { width, height: 800 },
    document: {
      scrollWidth: width,
      scrollHeight: 800,
      clientWidth: width,
      clientHeight: 800,
    },
    elements: [],
    headings: [],
    maskMembership: [],
    tokens: { status: "not-configured" },
    toolbarLayouts: {
      status: "ran",
      records: [
        {
          toolbar: 'div[aria-label="Formatting"]',
          rect: { x: 16, y: 16, width: width - 32, height: 32 },
          vertical: false,
          height: 32,
          singleRowHeight: 32,
          rows: 1,
          items: [
            {
              selector: "button.a",
              row: 0,
              centre: 32,
              top: 16,
              height: 32,
              text: "Bold",
            },
            {
              selector: "button.b",
              row: 0,
              centre: 32,
              top: 16,
              height: 32,
              text: "Italic",
            },
          ],
          controls: [],
          ...toolbar,
        },
      ],
    },
  };
}

function tuple(
  viewportName: string,
  width: number,
  colorScheme: "light" | "dark",
  toolbar: Partial<ToolbarLayoutObservation> = {},
  extra: Partial<CheckTuple> = {},
): CheckTuple {
  return {
    flow: "editor",
    state: "editor",
    viewport: viewportName,
    colorScheme,
    colorSchemeAxis: true,
    width,
    height: 800,
    metadataPath: `editor/${viewportName}/${colorScheme}/metadata.json`,
    screenshotPath: `editor/${viewportName}/${colorScheme}/screenshot.png`,
    artifactPaths: [],
    commit: "c",
    createdAt: "2026-11-16T00:00:00.000Z",
    observations: observations(width, toolbar),
    console: [],
    mismatches: [],
    ...extra,
  };
}

const wrapped = {
  rows: 2,
  height: 72,
  items: [
    {
      selector: "button.a",
      row: 0,
      centre: 32,
      top: 16,
      height: 32,
      text: "Bold",
    },
    {
      selector: "button.b",
      row: 1,
      centre: 72,
      top: 56,
      height: 32,
      text: "Italic",
    },
  ],
};

test("intermediate tuples run only the layout set and leave declared findings alone", () => {
  const declared = [
    tuple("tablet", 768, "light"),
    tuple("tablet", 768, "dark"),
    tuple("desktop", 1280, "light"),
    tuple("desktop", 1280, "dark"),
  ];
  const keys = (tuples: CheckTuple[]) =>
    tuples.map(
      (entry) => `${entry.state}\0${entry.viewport}\0${entry.colorScheme}`,
    );
  const between = tuple("intermediate-900", 900, "light", wrapped, {
    intermediateWidth: true,
  });
  const config = checksConfigFrom();
  const before = runDeterministicChecks(declared, keys(declared), config);
  const after = runDeterministicChecks(
    [...declared, between],
    keys([...declared, between]),
    config,
  );
  const describe = (result: typeof before, intermediate: boolean) =>
    result.candidates
      .filter(
        (entry) => (entry.tuple.intermediateWidth === true) === intermediate,
      )
      .map(
        (entry) =>
          `${entry.tuple.viewport}/${entry.tuple.colorScheme}/${entry.candidate.rule}/${entry.checkOrder}`,
      )
      .sort();
  expect(describe(after, false)).toEqual(describe(before, false));
  expect(after.narrowWidth).toBe(before.narrowWidth);
  const atBetween = after.candidates.filter((entry) => entry.tuple === between);
  expect(atBetween.map((entry) => entry.candidate.rule)).toContain(
    "idiom:toolbar-wrap",
  );
  const allowed = new Set(intermediateWidthChecks.map((check) => check.id));
  expect(
    after.coverage
      .filter((entry) => entry.tuple === between)
      .every((entry) => allowed.has(entry.coverage.check)),
  ).toBe(true);
  // No missing-colour-scheme candidate for the light-only intermediate.
  expect(
    atBetween.some((entry) => entry.candidate.rule.includes("color-scheme")),
  ).toBe(false);
});

test("a failed intermediate capture does not hide the declared scheme comparison", () => {
  const declared = [
    tuple("desktop", 1280, "light"),
    tuple("desktop", 1280, "dark"),
  ];
  const keys = [
    "editor\0desktop\0light",
    "editor\0desktop\0dark",
    "editor\0intermediate-900\0light",
  ];
  const withMissing = runDeterministicChecks(declared, keys);
  const plain = runDeterministicChecks(declared, keys.slice(0, 2));
  expect(withMissing.candidates.map((entry) => entry.candidate.rule)).toEqual(
    plain.candidates.map((entry) => entry.candidate.rule),
  );
});

// ---- timing ----

test("the timing line breaks out intermediate widths per state", () => {
  const timings: RunTimings = {
    build: phase(0),
    start: phase(100),
    probe: phase(2_000),
    checks: phase(500),
    capture: phase(12_000),
    tuples: [
      {
        state: "editor",
        viewport: "desktop",
        colorScheme: "light",
        total: phase(3_000),
        probe: phase(2_000),
      },
      {
        state: "editor",
        viewport: "intermediate-900",
        colorScheme: "light",
        total: phase(800),
        probe: { status: "skipped", ms: 0 },
        intermediate: true,
      },
      {
        state: "editor",
        viewport: "intermediate-1024",
        colorScheme: "light",
        total: phase(800),
        probe: { status: "skipped", ms: 0 },
        intermediate: true,
      },
      {
        state: "toolbar",
        viewport: "intermediate-900",
        colorScheme: "light",
        total: phase(1_500),
        probe: { status: "skipped", ms: 0 },
        intermediate: true,
      },
    ],
  };
  const timing = checkTiming(timings, 13_000);
  expect(timing.intermediateWidths).toEqual({
    ms: 3_100,
    states: [
      { state: "editor", widths: 2, ms: 1_600 },
      { state: "toolbar", widths: 1, ms: 1_500 },
    ],
  });
  expect(renderTimingLine(timing)).toContain(
    "capture 12s (probe 2.0s; intermediate widths +3.1s: editor +1.6s over 2 widths, toolbar +1.5s over 1 width)",
  );
  const noProbe = checkTiming(
    { ...timings, probe: { status: "skipped", ms: 0 } },
    13_000,
  );
  expect(renderTimingLine(noProbe)).toContain(
    "capture 12s (intermediate widths +3.1s:",
  );
  expect(renderTimings(timings)).toContain(
    "capture editor/intermediate-900/light (intermediate width):",
  );
  expect(
    checkTiming({ ...timings, tuples: timings.tuples.slice(0, 1) }, 1)
      .intermediateWidths,
  ).toBeUndefined();
  expect(
    checkTiming({ ...timings, historical: true }, 1).intermediateWidths,
  ).toBeUndefined();
});

test("combined and gate timing lines carry intermediate widths, at most three states", () => {
  const one = (state: string, ms: number) =>
    checkTiming(
      {
        build: phase(0),
        start: phase(0),
        probe: phase(0),
        checks: phase(0),
        capture: phase(5_000),
        tuples: [
          {
            state,
            viewport: "intermediate-900",
            colorScheme: "light",
            total: phase(ms),
            probe: phase(0),
            intermediate: true,
          },
        ],
      },
      5_000,
    );
  const combined = combineCheckTimings(
    [one("a", 1_000), one("b", 1_000), one("c", 1_000), one("d", 1_000)],
    20_000,
  );
  expect(combined.intermediateWidths?.ms).toBe(4_000);
  expect(renderTimingLine(combined)).toContain(
    "intermediate widths +4.0s: a +1.0s over 1 width, b +1.0s over 1 width, c +1.0s over 1 width, +1 more",
  );
  const gate: GateTiming = {
    ...combined,
    gate: {
      servers: 1,
      serversReused: 0,
      serverStartMs: 0,
      baseCaptureMs: 0,
      baseCapture: "none",
      captureMs: 20_000,
      probeMs: 0,
      checksMs: 0,
      ...(combined.intermediateWidths
        ? { intermediateWidths: combined.intermediateWidths }
        : {}),
    },
  };
  expect(renderGateTimingLine(gate)).toContain(
    "captures 20s (intermediate widths +4.0s: a +1.0s over 1 width",
  );
});

// ---- report and model review ----

test("reports label intermediate-width tuples", () => {
  const between = tuple(
    "intermediate-900",
    900,
    "light",
    {},
    {
      intermediateWidth: true,
    },
  );
  const markdown = renderReport({
    flow: "editor",
    commit: "c",
    findings: [],
    tuples: [tuple("desktop", 1280, "light"), between],
    coverage: [],
    outcome: { kind: "deterministic-only" },
  });
  expect(markdown).toContain(
    "intermediate-900 / light (900×800) — intermediate width (layout checks only)",
  );
  expect(markdown).not.toContain(
    "desktop / light (1280×800) — intermediate width",
  );
});

test("model critique context leaves out intermediate-width screenshots", async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), "idiom-intermediate-"));
  directories.push(projectDirectory);
  const runDirectory = join(projectDirectory, ".idiom", "reports", "run");
  for (const name of ["desktop", "intermediate-900"]) {
    await mkdir(join(runDirectory, "editor", name, "light"), {
      recursive: true,
    });
    await writeFile(
      join(runDirectory, "editor", name, "light", "screenshot.png"),
      "png",
    );
  }
  await writeFile(join(projectDirectory, "PRODUCT.md"), "Product");
  await writeFile(join(projectDirectory, "DESIGN.md"), "Design");
  const context = await buildCritiqueContext({
    projectDirectory,
    runDirectory,
    project: project(),
    flow: flow([{ id: "editor" }]),
    tuples: [
      tuple("desktop", 1280, "light"),
      tuple("intermediate-900", 900, "light", {}, { intermediateWidth: true }),
    ],
    priorDecisions: [],
    deterministicFindings: [],
    modelCandidateAllowance: 5,
  });
  expect(context.screenshots.map((shot) => shot.viewport)).toEqual(["desktop"]);
});
