import { expect, test } from "vitest";
import type { InteractiveSurfaceObservation } from "../src/checks/types.js";
import { renderStateCoverage } from "../src/coverage/states.js";
import {
  computeSurfaceCoverage,
  type DraftState,
  SURFACES_SHOWN,
  surfaceCoverageLines,
} from "../src/coverage/surfaces.js";
import { type Flow, flowSchema } from "../src/schemas/flow.js";
import { element, observation, tupleOf } from "./revealed-support.js";

type RawFlow = Record<string, unknown> & { states: unknown[] };

const rawFlow = (states: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    id: "editor",
    title: "Editor",
    intent: [],
    setup: [],
    states,
    ...extra,
  }) as RawFlow;
const state = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  description: id,
  ...(extra.from === undefined ? { url: `/${id}` } : {}),
  expect: {},
  ...extra,
});
const parse = (raw: RawFlow): Flow => flowSchema.parse(raw);

const surface = (
  kind: InteractiveSurfaceObservation["kind"],
  selector: string,
  extra: Partial<InteractiveSurfaceObservation> = {},
): InteractiveSurfaceObservation => ({
  kind,
  selector,
  path: `html > body:nth-of-type(1) > ${selector.replace(/[^a-z]/g, "")}`,
  name: selector.replace(/^[#.]/, ""),
  role: "button",
  active: false,
  reveals: 0,
  ...extra,
});
const at = (
  stateId: string,
  surfaces: InteractiveSurfaceObservation[] | undefined,
) =>
  tupleOf(
    observation([element("#a")], {
      ...(surfaces === undefined ? {} : { interactiveSurfaces: surfaces }),
    }),
    stateId,
  );

/** The draft pasted into the raw flow parses, and returns it. */
function pastes(raw: RawFlow, draft: DraftState) {
  const parsed = parse({ ...raw, states: [...raw.states, draft] });
  return parsed.states.find((entry) => entry.id === draft.id);
}

function ran(coverage: ReturnType<typeof computeSurfaceCoverage>) {
  if (coverage.status !== "ran") throw Error(coverage.reason);
  return coverage;
}

const menu = surface("menu", "#more", {
  name: "More",
  target: "#more-menu",
  reveals: 6,
});

test("an unopened menu drafts a state from where it was seen; one opened anywhere is covered", () => {
  const raw = rawFlow([state("canvas"), state("settings")]);
  const flow = parse(raw);
  const coverage = ran(computeSurfaceCoverage([at("canvas", [menu])], flow));
  expect(coverage).toMatchObject({ total: 1, covered: 0, omitted: 0 });
  expect(coverage.unrevealed).toEqual([
    {
      state: "canvas",
      kind: "menu",
      name: "More",
      selector: "#more",
      reveals: 6,
      weight: 12,
      suggestion: {
        id: "canvas-more-open",
        description: "canvas with the More menu open",
        from: "canvas",
        steps: [
          { action: "click", selector: "#more" },
          { action: "waitFor", selector: "#more-menu", state: "visible" },
        ],
        expect: {},
      },
    },
  ]);
  const pasted = pastes(raw, coverage.unrevealed[0]?.suggestion as DraftState);
  expect(pasted?.url).toBe("/canvas");
  expect(pasted?.steps.map((step) => step.action)).toEqual([
    "click",
    "waitFor",
  ]);

  expect(
    ran(
      computeSurfaceCoverage(
        [at("canvas", [menu]), at("settings", [{ ...menu, active: true }])],
        flow,
      ),
    ),
  ).toEqual({
    status: "ran",
    total: 1,
    covered: 1,
    unrevealed: [],
    omitted: 0,
  });
});

test("menus and disclosures without a known target wait for an open menu or expanded trigger", () => {
  const flow = parse(rawFlow([state("canvas")]));
  const coverage = ran(
    computeSurfaceCoverage(
      [
        at("canvas", [
          surface("menu", "#actions", { name: "Actions" }),
          surface("disclosure", "#filters", { name: "Filters" }),
          surface("popover", "#pick", { name: "Pick" }),
        ]),
      ],
      flow,
    ),
  );
  const waits = Object.fromEntries(
    coverage.unrevealed.map((entry) => [entry.kind, entry.suggestion.steps[1]]),
  );
  expect(waits).toEqual({
    menu: {
      action: "waitFor",
      selector: '[role="menu"]:visible >> nth=0',
      state: "visible",
    },
    disclosure: {
      action: "waitFor",
      selector: '#filters[aria-expanded="true"]',
      state: "visible",
    },
    popover: {
      action: "waitFor",
      selector: '#pick[aria-expanded="true"]',
      state: "visible",
    },
  });
});

test("selectable, multi-select, editable and toolbar surfaces draft the steps that reveal them", () => {
  const raw = rawFlow([state("canvas"), state("blank")]);
  const flow = parse(raw);
  const coverage = ran(
    computeSurfaceCoverage(
      [
        at("canvas", [
          surface("selectable", "#hero", { name: "Hero", role: "option" }),
          surface("multiselect", "#layers", {
            name: "Layers",
            role: "listbox",
            members: ["#layer-1", "#layer-2"],
          }),
          surface("editable", "#headline", {
            name: "Headline",
            role: "textbox",
          }),
          surface("toolbar", "#selection-bar", {
            name: "Selection",
            role: "toolbar",
            target: "#selection-bar",
            reveals: 5,
          }),
        ]),
        at("blank", [
          surface("toolbar", "#format-bar", {
            name: "Format",
            role: "toolbar",
            target: "#format-bar",
          }),
        ]),
      ],
      flow,
    ),
  );
  const byKind = Object.fromEntries(
    coverage.unrevealed.map((entry) => [entry.selector, entry]),
  );
  expect(byKind["#hero"]?.suggestion).toMatchObject({
    id: "canvas-hero-selected",
    steps: [
      { action: "click", selector: "#hero" },
      {
        action: "waitFor",
        selector: '#hero[aria-selected="true"]',
        state: "visible",
      },
    ],
  });
  expect(byKind["#layers"]?.suggestion).toMatchObject({
    id: "canvas-layers-multi-selected",
    steps: [
      { action: "click", selector: "#layer-1" },
      { action: "click", selector: "#layer-2", modifiers: ["ControlOrMeta"] },
      {
        action: "waitFor",
        selector: '#layer-2[aria-selected="true"]',
        state: "visible",
      },
    ],
  });
  expect(byKind["#headline"]?.suggestion).toMatchObject({
    id: "canvas-headline-editing",
    steps: [
      { action: "dblclick", selector: "#headline" },
      { action: "focus", selector: "#headline" },
    ],
  });
  // A toolbar in a state with a selectable element selects it first.
  expect(byKind["#selection-bar"]?.suggestion.steps).toEqual([
    { action: "click", selector: "#hero" },
    {
      action: "waitFor",
      selector: '#hero[aria-selected="true"]',
      state: "visible",
    },
    { action: "waitFor", selector: "#selection-bar", state: "visible" },
  ]);
  expect(byKind["#selection-bar"]?.note).toBeUndefined();
  // With nothing to select, the draft only waits and says what is missing.
  expect(byKind["#format-bar"]).toMatchObject({
    state: "blank",
    suggestion: {
      id: "blank-format-toolbar",
      from: "blank",
      steps: [{ action: "waitFor", selector: "#format-bar", state: "visible" }],
    },
    note: "add the step that reveals this toolbar before the waitFor",
  });
  for (const entry of coverage.unrevealed) pastes(raw, entry.suggestion);
});

test("drafts skip held-drag states and resolve a toggle combination to its declared base", () => {
  const raw = rawFlow(
    [
      state("canvas"),
      state("dragging", {
        from: "canvas",
        steps: [
          {
            action: "drag",
            selector: "#block",
            offset: { x: 40, y: 0 },
            hold: true,
          },
        ],
      }),
      state("after"),
    ],
    {
      toggles: {
        panel: { closed: [], open: [{ action: "click", selector: "#panel" }] },
      },
      toggleStates: ["canvas"],
    },
  );
  const flow = parse(raw);
  const combination = flow.states.find(
    (entry) => "combination" in entry && entry.combination,
  );
  if (combination === undefined) throw Error("no combination");
  const coverage = ran(
    computeSurfaceCoverage(
      [
        at("dragging", [surface("menu", "#drag-menu")]),
        at("after", [surface("menu", "#drag-menu")]),
        at(combination.id, [surface("menu", "#panel-menu")]),
      ],
      flow,
    ),
  );
  const bases = Object.fromEntries(
    coverage.unrevealed.map((entry) => [entry.selector, entry.suggestion.from]),
  );
  expect(bases).toEqual({ "#drag-menu": "after", "#panel-menu": "canvas" });
  // Seen only while a drag is held: counted, but nothing to draft from.
  const onlyDragging = ran(
    computeSurfaceCoverage(
      [at("dragging", [surface("menu", "#drag-menu")])],
      flow,
    ),
  );
  expect(onlyDragging).toMatchObject({ total: 1, covered: 0, unrevealed: [] });
  for (const entry of coverage.unrevealed) pastes(raw, entry.suggestion);
});

test("route, published page and content pattern states draft by url", () => {
  const routes = rawFlow([state("home")], { routes: ["/leads/new"] });
  const routeCoverage = ran(
    computeSurfaceCoverage([at("route-leads-new", [menu])], parse(routes)),
  );
  const routeDraft = routeCoverage.unrevealed[0]?.suggestion as DraftState;
  expect(routeDraft).toMatchObject({
    id: "route-leads-new-more-open",
    url: "/leads/new",
  });
  expect(routeDraft.from).toBeUndefined();
  expect(pastes(routes, routeDraft)?.url).toBe("/leads/new");

  const published = rawFlow([], { kind: "published", pages: ["/p/abc"] });
  const pageDraft = ran(
    computeSurfaceCoverage([at("page-p-abc", [menu])], parse(published)),
  ).unrevealed[0]?.suggestion as DraftState;
  expect(pageDraft).toMatchObject({ url: "/p/abc" });
  pastes(published, pageDraft);

  const patterns = rawFlow([state("home")], {
    content: {
      patterns: [{ id: "pricing", path: "/pricing", intent: "Compare plans" }],
    },
  });
  const patternDraft = ran(
    computeSurfaceCoverage([at("pattern-pricing", [menu])], parse(patterns)),
  ).unrevealed[0]?.suggestion as DraftState;
  expect(patternDraft).toMatchObject({ url: "/pricing" });
  pastes(patterns, patternDraft);

  // Declared states come before path states, so `from` wins.
  const both = ran(
    computeSurfaceCoverage(
      [at("route-leads-new", [menu]), at("home", [menu])],
      parse(routes),
    ),
  );
  expect(both.unrevealed[0]?.suggestion).toMatchObject({ from: "home" });
});

test("draft ids never collide with existing states or each other", () => {
  const raw = rawFlow([state("canvas"), state("canvas-more-open")]);
  const coverage = ran(
    computeSurfaceCoverage(
      [
        at("canvas", [
          menu,
          surface("menu", "#more-2", { name: "More", reveals: 1 }),
        ]),
      ],
      parse(raw),
    ),
  );
  expect(coverage.unrevealed.map((entry) => entry.suggestion.id)).toEqual([
    "canvas-more-open-2",
    "canvas-more-open-3",
  ]);
  pastes(
    { ...raw, states: [...raw.states, coverage.unrevealed[0]?.suggestion] },
    coverage.unrevealed[1]?.suggestion as DraftState,
  );
});

test("ranked by what each reveals, capped, and stable on the same captures", () => {
  const flow = parse(rawFlow([state("first"), state("second")]));
  const many = Array.from({ length: 12 }, (_, index) =>
    surface("selectable", `#item-${String(index).padStart(2, "0")}`, {
      reveals: index % 4,
    }),
  );
  const tuples = [
    at("first", many.slice(0, 6)),
    at("second", [...many.slice(6), menu]),
  ];
  const coverage = ran(computeSurfaceCoverage(tuples, flow));
  expect(coverage.total).toBe(13);
  expect(coverage.unrevealed).toHaveLength(SURFACES_SHOWN);
  expect(coverage.omitted).toBe(3);
  expect(coverage.unrevealed[0]?.selector).toBe("#more");
  const weights = coverage.unrevealed.map((entry) => entry.weight);
  expect(weights).toEqual([...weights].sort((a, b) => b - a));
  // Equal weights: earlier state first, then selector.
  expect(
    coverage.unrevealed
      .filter((entry) => entry.weight === 5)
      .map((entry) => entry.selector),
  ).toEqual(["#item-03", "#item-07", "#item-11"]);
  const shuffled = [
    at("second", [menu, ...many.slice(6).reverse()]),
    at("first", many.slice(0, 6).reverse()),
  ];
  expect(computeSurfaceCoverage(shuffled, flow)).toEqual(coverage);
});

test("unavailable without captures, for captures that predate the inventory, and for Electron flows", () => {
  const flow = parse(rawFlow([state("canvas")]));
  expect(computeSurfaceCoverage([], flow)).toEqual({
    status: "unavailable",
    reason: "no captured surfaces",
  });
  expect(
    computeSurfaceCoverage(
      [at("canvas", [menu]), at("canvas", undefined)],
      flow,
    ),
  ).toEqual({
    status: "unavailable",
    reason: "capture predates the surface inventory; recapture",
  });
  const electron = flowSchema.parse({
    id: "desk",
    title: "Desk",
    intent: [],
    setup: [],
    target: {
      kind: "electron",
      launch: { executablePath: "bin/electron", args: ["main.cjs"] },
      window: { title: "Desk" },
    },
    states: [{ id: "home", description: "home", expect: {} }],
  });
  expect(computeSurfaceCoverage([at("home", [menu])], electron)).toEqual({
    status: "unavailable",
    reason: "web flows only",
  });
  expect(
    surfaceCoverageLines({ status: "unavailable", reason: "web flows only" }),
  ).toEqual(["Surfaces: unavailable (web flows only)."]);
});

test("the state coverage table lists each surface with a pasteable draft", () => {
  const flow = parse(rawFlow([state("canvas")]));
  const coverage = computeSurfaceCoverage([at("canvas", [menu])], flow);
  const lines = surfaceCoverageLines(coverage);
  expect(lines[0]).toBe(
    "Surfaces: 0 of 1 shown open, selected or focused by a state; never shown (top 1 by what they reveal):",
  );
  expect(lines[1]).toBe("- canvas › More (menu, reveals 6)");
  const pasted = lines[2]?.replace(/^ {2}add to "states": /, "") ?? "";
  expect(JSON.parse(pasted)).toMatchObject({ id: "canvas-more-open" });
  const text = renderStateCoverage({
    flows: [
      {
        flow: "editor",
        captured: true,
        states: [],
        data: [],
        missing: [],
        observed: 0,
        applicable: 0,
        notApplicable: 0,
        percent: null,
        surfaces: coverage,
      },
    ],
  });
  expect(text).toContain(lines[2]);
  expect(
    surfaceCoverageLines({
      status: "ran",
      total: 2,
      covered: 2,
      unrevealed: [],
      omitted: 0,
    }),
  ).toEqual(["Surfaces: 2 of 2 shown open, selected or focused by a state."]);
});
