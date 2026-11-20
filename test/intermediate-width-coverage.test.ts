import { expect, test } from "vitest";
import type {
  CheckTuple,
  ObservationArtifactV2,
  ToolbarLayoutObservation,
} from "../src/checks/types.js";
import {
  computeFlowStateCoverage,
  renderStateCoverage,
} from "../src/coverage/states.js";
import { computeIntermediateWidthCoverage } from "../src/coverage/widths.js";
import { type Flow, flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const project = projectSchema.parse({
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
    { name: "tablet", width: 768, height: 1024 },
    { name: "desktop", width: 1280, height: 800 },
  ],
  colorSchemes: ["light", "dark"],
  capture: {},
  design: {},
  model: { provider: "anthropic", model: "unused" },
});

function flow(state: Record<string, unknown> = {}): Flow {
  return flowSchema.parse({
    id: "editor",
    title: "Editor",
    intent: [],
    setup: [],
    states: [
      { id: "draft", description: "Draft", url: "/", expect: {}, ...state },
    ],
  });
}

const toolbar = (
  fields: Partial<ToolbarLayoutObservation>,
): ToolbarLayoutObservation => ({
  toolbar: 'div[aria-label="Formatting"]',
  rect: { x: 0, y: 0, width: 900, height: 32 },
  vertical: false,
  height: 32,
  singleRowHeight: 32,
  rows: 1,
  items: [],
  controls: [],
  ...fields,
});

function tuple(
  viewport: "tablet" | "desktop",
  colorScheme: "light" | "dark",
  records: ToolbarLayoutObservation[],
): CheckTuple {
  const width = viewport === "tablet" ? 768 : 1280;
  const observations: ObservationArtifactV2 = {
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
    toolbarLayouts: { status: "ran", records },
  };
  return {
    flow: "editor",
    state: "draft",
    viewport,
    colorScheme,
    colorSchemeAxis: true,
    width,
    height: 800,
    metadataPath: `draft/${viewport}/${colorScheme}/metadata.json`,
    artifactPaths: [],
    commit: "c",
    createdAt: "2026-11-16T00:00:00.000Z",
    observations,
    console: [],
    mismatches: [],
  };
}

const grid = (
  tablet: ToolbarLayoutObservation[],
  desktop: ToolbarLayoutObservation[],
) => [
  tuple("tablet", "light", tablet),
  tuple("tablet", "dark", tablet),
  tuple("desktop", "light", desktop),
  tuple("desktop", "dark", desktop),
];

test("a toolbar that is one row at one width and wraps at another is suggested", () => {
  const coverage = computeIntermediateWidthCoverage({
    project,
    flow: flow(),
    tuples: grid([toolbar({ rows: 2 })], [toolbar({ rows: 1 })]),
  });
  expect(coverage).toEqual({
    suggestions: [
      {
        state: "draft",
        toolbar: 'div[aria-label="Formatting"]',
        reason:
          'div[aria-label="Formatting"] is one row at 1280px and wraps at 768px',
        remedy: 'add "intermediateWidths": true to state draft in flow editor',
        others: 0,
      },
    ],
  });
});

test("a one-row toolbar that nearly fills its row is suggested", () => {
  const coverage = computeIntermediateWidthCoverage({
    project,
    flow: flow(),
    tuples: grid(
      [toolbar({ rows: 1, fill: 0.5 })],
      [toolbar({ rows: 1, fill: 0.93 }), toolbar({ toolbar: "nav", rows: 2 })],
    ),
  });
  expect(coverage?.suggestions[0]?.reason).toBe(
    'div[aria-label="Formatting"] fills 93% of its row at 1280px',
  );
});

test("no suggestion when opted in, under the fill threshold, vertical, or only in the other scheme", () => {
  const wraps = grid([toolbar({ rows: 2 })], [toolbar({ rows: 1 })]);
  expect(
    computeIntermediateWidthCoverage({
      project,
      flow: flow({ intermediateWidths: [900] }),
      tuples: wraps,
    }),
  ).toBeUndefined();
  expect(
    computeIntermediateWidthCoverage({
      project,
      flow: flowSchema.parse({ ...flow(), intermediateWidths: true }),
      tuples: wraps,
    }),
  ).toBeUndefined();
  expect(
    computeIntermediateWidthCoverage({
      project,
      flow: flow(),
      tuples: grid(
        [toolbar({ rows: 1, fill: 0.84 })],
        [toolbar({ rows: 1, fill: 0.6 })],
      ),
    }),
  ).toBeUndefined();
  expect(
    computeIntermediateWidthCoverage({
      project,
      flow: flow(),
      tuples: grid(
        [toolbar({ vertical: true, rows: 2 })],
        [toolbar({ vertical: true, rows: 1, fill: 0.99 })],
      ),
    }),
  ).toBeUndefined();
  // The dark tuples wrap, but intermediates capture in light only.
  expect(
    computeIntermediateWidthCoverage({
      project,
      flow: flow(),
      tuples: [
        tuple("tablet", "light", [toolbar({ rows: 1 })]),
        tuple("tablet", "dark", [toolbar({ rows: 2 })]),
        tuple("desktop", "light", [toolbar({ rows: 1 })]),
        tuple("desktop", "dark", [toolbar({ rows: 1 })]),
      ],
    }),
  ).toBeUndefined();
});

test("coverage --states renders the block and leaves the percentages alone", () => {
  const tuples = grid([toolbar({ rows: 2 })], [toolbar({ rows: 1 })]);
  const plain = grid([toolbar({ rows: 1 })], [toolbar({ rows: 1 })]);
  const suggested = computeFlowStateCoverage({ project, flow: flow(), tuples });
  const quiet = computeFlowStateCoverage({
    project,
    flow: flow(),
    tuples: plain,
  });
  expect(quiet.intermediateWidths).toBeUndefined();
  expect(suggested.intermediateWidths?.suggestions).toHaveLength(1);
  expect(suggested.percent).toBe(quiet.percent);
  expect(suggested.observed).toBe(quiet.observed);
  expect(suggested.applicable).toBe(quiet.applicable);
  const text = renderStateCoverage({ flows: [suggested] });
  expect(text).toContain(
    "Intermediate widths: toolbars near a width boundary between declared viewports:\n" +
      '- draft: div[aria-label="Formatting"] is one row at 1280px and wraps at 768px\n' +
      "To cover:\n" +
      '- draft: add "intermediateWidths": true to state draft in flow editor',
  );
  expect(renderStateCoverage({ flows: [quiet] })).not.toContain(
    "Intermediate widths",
  );
});
