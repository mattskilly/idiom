import { expect, test } from "vitest";
import {
  coordinate,
  probeCoordinates,
  resolveCaptureScope,
} from "../src/capture/scope.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const project = projectSchema.parse({
  version: 1,
  app: { name: "Scope", framework: "other" },
  server: {
    build: "true",
    start: "true",
    port: 3000,
    readyUrl: "http://localhost:3000",
    env: {},
  },
  capture: {},
  design: {},
  model: { provider: "anthropic", model: "unused" },
  viewports: Array.from({ length: 5 }, (_, i) => ({
    name: `v${i}`,
    width: 400 + i * 200,
    height: 600,
  })),
  colorSchemes: ["dark", "light"],
});
const flow = flowSchema.parse({
  id: "scope",
  title: "Scope",
  setup: [],
  intent: [],
  states: Array.from({ length: 13 }, (_, i) => ({
    id: `s${i}`,
    description: "State",
    expect: {},
    url: `/s${i}`,
  })),
});

test("axis scopes narrow the ordered 130 coordinate matrix", () => {
  const result = resolveCaptureScope({
    project,
    flow,
    scope: { states: " s2, s0 ", viewports: "v3,v1", schemes: "light" },
  });
  expect(result.declared).toHaveLength(130);
  expect(result.selected.map(coordinate)).toEqual(
    ["s0", "s2"].flatMap((state) =>
      ["v1", "v3"].map((viewport) => ({
        state,
        viewport,
        colorScheme: "light",
      })),
    ),
  );
});

test.each(["", "s0,", "s0,s0", "unknown"])(
  "invalid state list %j is rejected",
  (states) => {
    expect(() =>
      resolveCaptureScope({ project, flow, scope: { states } }),
    ).toThrow();
  },
);

test("internal exact coordinates stay pairs and cannot combine with axes", () => {
  const tuples = [
    { state: "s0", viewport: "v1", colorScheme: "light" as const },
    { state: "s2", viewport: "v3", colorScheme: "dark" as const },
  ];
  expect(
    resolveCaptureScope({ project, flow, tuples }).selected.map(coordinate),
  ).toEqual(tuples);
  expect(() =>
    resolveCaptureScope({ project, flow, tuples, scope: { states: "s0" } }),
  ).toThrow(/cannot combine/);
});

test("probe is on by default, prefers light at the first selected viewport and honors everywhere", () => {
  expect(project.checks.probe.enabled).toBe(true);
  const { selected } = resolveCaptureScope({
    project,
    flow,
    scope: { states: "s0", viewports: "v3,v1" },
  });
  expect(probeCoordinates(project, flow, selected).intended).toEqual([
    { state: "s0", viewport: "v1", colorScheme: "light" },
  ]);
  const everywhere = projectSchema.parse({
    ...project,
    checks: {
      ...project.checks,
      probe: { ...project.checks.probe, everywhere: true },
    },
  });
  expect(probeCoordinates(everywhere, flow, selected).intended).toHaveLength(4);
  const off = projectSchema.parse({
    ...project,
    checks: { probe: { enabled: false } },
  });
  expect(probeCoordinates(off, flow, selected).intended).toEqual([]);
  const dark = resolveCaptureScope({
    project,
    flow,
    scope: { states: "s0", schemes: "dark" },
  });
  expect(probeCoordinates(project, flow, dark.selected)).toMatchObject({
    fallback: true,
    intended: [{ state: "s0", viewport: "v0", colorScheme: "dark" }],
  });
});

test("flow and state restrictions intersect before side effects", () => {
  const narrowed = flowSchema.parse({
    ...flow,
    viewports: ["v1", "v3"],
    colorSchemes: ["light"],
    states: [{ ...flow.states[0], viewports: ["v3"] }],
  });
  expect(
    resolveCaptureScope({ project, flow: narrowed }).selected.map(coordinate),
  ).toEqual([{ state: "s0", viewport: "v3", colorScheme: "light" }]);
  expect(() =>
    resolveCaptureScope({
      project,
      flow: narrowed,
      scope: { states: "s0", viewports: "v1" },
    }),
  ).toThrow(/no capture tuples/);
  expect(() =>
    resolveCaptureScope({
      project,
      flow: narrowed,
      scope: { schemes: "dark" },
    }),
  ).toThrow(/flow-unselected/);
  expect(() =>
    resolveCaptureScope({
      project,
      flow: narrowed,
      scope: { viewports: "v0" },
    }),
  ).toThrow(/flow-unselected/);
});

test.each([
  { viewports: "v0,v0" },
  { viewports: "," },
  { schemes: "light," },
  { schemes: "sepia" },
  { schemes: "dark,dark" },
])("invalid axis list %j is rejected", (scope) => {
  expect(() => resolveCaptureScope({ project, flow, scope })).toThrow();
});

test("probe overrides never enable explicitly disabled or generated states", () => {
  const disabled = flowSchema.parse({
    ...flow,
    states: [
      { ...flow.states[0], probe: false },
      { ...flow.states[1], probe: true },
    ],
  });
  const config = projectSchema.parse({
    ...project,
    checks: { probe: { enabled: false, everywhere: true } },
  });
  const selected = resolveCaptureScope({
    project: config,
    flow: disabled,
  }).selected;
  expect(probeCoordinates(config, disabled, selected).intended).toHaveLength(
    10,
  );
  expect(
    probeCoordinates(config, disabled, selected).intended.every(
      (tuple) => tuple.state === "s1",
    ),
  ).toBe(true);
});

test("scope validation precedes setup, builds, source lookup and output creation", async () => {
  const { runCapture } = await import("../src/capture/run.js");
  await expect(
    runCapture({
      projectDirectory: "/does-not-exist",
      project,
      flow,
      scope: { states: "unknown" },
    }),
  ).rejects.toThrow(/unknown/);
  await expect(
    runCapture({
      projectDirectory: "/does-not-exist",
      project,
      flow,
      scope: { viewports: "" },
    }),
  ).rejects.toThrow(/nonempty/);
});

test("published widths and exact generated toggle IDs narrow without expanding their base state", () => {
  const published = flowSchema.parse({
    id: "published",
    title: "Published",
    intent: [],
    setup: [],
    kind: "published",
    pages: ["/"],
    viewports: [1280, 375],
  });
  const selected = resolveCaptureScope({
    project,
    flow: published,
    scope: { viewports: "1280", schemes: "light" },
  }).selected;
  expect(selected).toHaveLength(1);
  expect(selected[0]?.viewport).toEqual({
    name: "1280",
    width: 1280,
    height: 800,
  });
  expect(selected[0]?.colorSchemeAxis).toBe(true);
  const toggled = flowSchema.parse({
    ...flow,
    states: flow.states.slice(0, 1),
    toggles: {
      drawer: { closed: [], open: [{ action: "click", selector: "button" }] },
    },
  });
  const generated = toggled.states.find((state) => state.id !== "s0");
  if (!generated) throw new Error("missing generated toggle");
  const base = resolveCaptureScope({
    project,
    flow: toggled,
    scope: { states: "s0" },
  });
  expect(new Set(base.selected.map((tuple) => tuple.state.id))).toEqual(
    new Set(["s0"]),
  );
  const combination = resolveCaptureScope({
    project,
    flow: toggled,
    scope: { states: generated.id },
  });
  expect(
    combination.selected.every((tuple) => tuple.state.id === generated.id),
  ).toBe(true);
});
