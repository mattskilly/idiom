import type {
  CheckTuple,
  InteractiveSurfaceKind,
  InteractiveSurfaceObservation,
} from "../checks/types.js";
import {
  contentPatternStateId,
  type Flow,
  holdsPointer,
  isWebFlow,
  pageStateId,
  routeStateId,
  type WebFlowState,
  type WebStep,
} from "../schemas/flow.js";

export type SurfaceStep = WebStep;

/**
 * A flow state the project can paste into its flow's `states` to capture a
 * surface open: loaded `from` a declared state (or by `url` for a route,
 * page or pattern state), then the steps that open, select or focus it.
 */
export type DraftState = {
  id: string;
  description: string;
  from?: string | undefined;
  url?: string | undefined;
  steps: SurfaceStep[];
  expect: Record<string, never>;
};

export type UnrevealedSurface = {
  /** The state the draft starts from. */
  state: string;
  label?: string | undefined;
  kind: InteractiveSurfaceKind;
  name: string;
  selector: string;
  reveals: number;
  /** Ranking weight: what it reveals plus a weight for its kind. */
  weight: number;
  suggestion: DraftState;
  /** When the draft needs a step a human has to add. */
  note?: string | undefined;
};

/**
 * Menus, popovers, disclosures, toolbars, editable text and selectable
 * elements on captured surfaces that no captured state shows open,
 * expanded, selected, focused or shown, ranked by how much UI each would
 * reveal, each with a draft state that reaches it.
 */
export type SurfaceCoverage =
  | { status: "unavailable"; reason: string }
  | {
      status: "ran";
      total: number;
      covered: number;
      unrevealed: UnrevealedSurface[];
      /** Unrevealed surfaces beyond the shown cap. */
      omitted: number;
    };

type SurfaceTuple = Pick<CheckTuple, "state" | "observations">;

export const SURFACES_SHOWN = 10;

/** Kind weights, in tie-break order. */
const weights: Record<InteractiveSurfaceKind, number> = {
  toolbar: 8,
  menu: 6,
  multiselect: 5,
  popover: 5,
  editable: 4,
  disclosure: 3,
  selectable: 2,
};
const kindOrder = Object.keys(weights) as InteractiveSurfaceKind[];

const verbs: Record<InteractiveSurfaceKind, string> = {
  menu: "open",
  popover: "open",
  disclosure: "open",
  selectable: "selected",
  multiselect: "multi-selected",
  editable: "editing",
  toolbar: "toolbar",
};

type Group = {
  key: string;
  entry: InteractiveSurfaceObservation;
  /** Flow index of the earliest state that saw it. */
  index: number;
  reveals: number;
  covered: boolean;
  /** States that saw it, in flow order. */
  states: string[];
};

type Base = { id: string; index: number; from?: string; url?: string };

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function slug(name: string, kind: InteractiveSurfaceKind): string {
  const value = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return value === "" ? kind : value;
}

function describe(
  base: string,
  kind: InteractiveSurfaceKind,
  name: string,
): string {
  const what = name || kind;
  switch (kind) {
    case "menu":
      return `${base} with the ${what} menu open`;
    case "popover":
      return `${base} with the ${what} popover open`;
    case "disclosure":
      return `${base} with ${what} expanded`;
    case "selectable":
      return `${base} with ${what} selected`;
    case "multiselect":
      return `${base} with two items in ${what} selected`;
    case "editable":
      return `${base} editing ${what}`;
    case "toolbar":
      return `${base} with the ${what} toolbar shown`;
  }
}

/** The steps that open, select or focus a surface, toolbars aside. */
function stepsFor(entry: InteractiveSurfaceObservation): SurfaceStep[] {
  switch (entry.kind) {
    case "menu":
    case "popover":
    case "disclosure": {
      const wait =
        entry.target ??
        (entry.kind === "menu"
          ? '[role="menu"]:visible >> nth=0'
          : `${entry.selector}[aria-expanded="true"]`);
      return [
        { action: "click", selector: entry.selector },
        { action: "waitFor", selector: wait, state: "visible" },
      ];
    }
    case "selectable":
      return [
        { action: "click", selector: entry.selector },
        {
          action: "waitFor",
          selector: `${entry.selector}[aria-selected="true"]`,
          state: "visible",
        },
      ];
    case "multiselect": {
      const [first, second] = entry.members ?? [];
      if (first === undefined || second === undefined) return [];
      return [
        { action: "click", selector: first },
        { action: "click", selector: second, modifiers: ["ControlOrMeta"] },
        {
          action: "waitFor",
          selector: `${second}[aria-selected="true"]`,
          state: "visible",
        },
      ];
    }
    case "editable":
      return [
        { action: "dblclick", selector: entry.selector },
        { action: "focus", selector: entry.selector },
      ];
    case "toolbar":
      return [];
  }
}

/** Generated path states (routes, published pages, content patterns). */
function pathStatesOf(flow: Flow): Map<string, string> {
  const paths = new Map<string, string>();
  if (!isWebFlow(flow)) return paths;
  for (const route of flow.routes ?? []) paths.set(routeStateId(route), route);
  for (const page of flow.pages ?? []) paths.set(pageStateId(page), page);
  for (const pattern of flow.content?.patterns ?? [])
    if (pattern.path !== undefined)
      paths.set(contentPatternStateId(pattern), pattern.path);
  return paths;
}

export function computeSurfaceCoverage(
  tuples: readonly SurfaceTuple[],
  flow: Flow,
  stateLabels: Readonly<Record<string, string>> = {},
): SurfaceCoverage {
  if (!isWebFlow(flow))
    return { status: "unavailable", reason: "web flows only" };
  const observed = tuples.flatMap((tuple) =>
    tuple.observations?.version === 2 &&
    (tuple.observations.elements?.length ?? 0) > 0
      ? [{ tuple, observations: tuple.observations }]
      : [],
  );
  if (observed.length === 0)
    return { status: "unavailable", reason: "no captured surfaces" };
  if (observed.some(({ observations }) => !observations.interactiveSurfaces))
    return {
      status: "unavailable",
      reason: "capture predates the surface inventory; recapture",
    };

  const states = flow.states as WebFlowState[];
  const indexOf = new Map(states.map((state, index) => [state.id, index]));
  const byId = new Map(states.map((state) => [state.id, state]));
  const pathStates = pathStatesOf(flow);
  const declaredBase = (state: WebFlowState | undefined) =>
    state !== undefined &&
    state.combination === undefined &&
    !pathStates.has(state.id) &&
    !state.steps.some(holdsPointer);
  const baseOf = (id: string): Base | undefined => {
    const state = byId.get(id);
    if (state === undefined) return undefined;
    const index = indexOf.get(id) ?? 0;
    if (declaredBase(state)) return { id, index, from: id };
    const path = pathStates.get(id);
    if (path !== undefined && state.combination === undefined)
      return { id, index, url: path };
    const combined = state.combination?.base;
    if (combined !== undefined && declaredBase(byId.get(combined)))
      return {
        id: combined,
        index: indexOf.get(combined) ?? 0,
        from: combined,
      };
    return undefined;
  };

  const groups = new Map<string, Group>();
  /** Surfaces each state saw, for toolbars that follow a selection. */
  const seenIn = new Map<string, InteractiveSurfaceObservation[]>();
  for (const { tuple, observations } of observed) {
    const index = indexOf.get(tuple.state);
    if (index === undefined) continue;
    for (const entry of observations.interactiveSurfaces ?? []) {
      const list = seenIn.get(tuple.state) ?? [];
      list.push(entry);
      seenIn.set(tuple.state, list);
      const key = `${entry.kind}\0${entry.selector}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, {
          key,
          entry,
          index,
          reveals: entry.reveals,
          covered: entry.active,
          states: [tuple.state],
        });
        continue;
      }
      if (index < group.index) {
        group.entry = entry;
        group.index = index;
      }
      group.reveals = Math.max(group.reveals, entry.reveals);
      group.covered ||= entry.active;
      if (!group.states.includes(tuple.state)) group.states.push(tuple.state);
    }
  }

  const covered = [...groups.values()].filter((group) => group.covered).length;
  type Ranked = { group: Group; base: Base; weight: number };
  const ranked: Ranked[] = [];
  for (const group of groups.values()) {
    if (group.covered) continue;
    if (group.entry.kind === "multiselect" && group.entry.members === undefined)
      continue;
    const sightings = [...group.states].sort(
      (a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0),
    );
    // Every sighting holding a drag leaves nothing to start a draft from.
    const base = sightings
      .map(baseOf)
      .find((candidate) => candidate !== undefined);
    if (base === undefined) continue;
    ranked.push({
      group,
      base,
      weight: group.reveals + weights[group.entry.kind],
    });
  }
  ranked.sort(
    (a, b) =>
      b.weight - a.weight ||
      a.base.index - b.base.index ||
      kindOrder.indexOf(a.group.entry.kind) -
        kindOrder.indexOf(b.group.entry.kind) ||
      compare(a.group.entry.selector, b.group.entry.selector),
  );

  const taken = new Set(states.map((state) => state.id));
  const uniqueId = (candidate: string) => {
    let id = candidate;
    for (let suffix = 2; taken.has(id); suffix += 1)
      id = `${candidate}-${suffix}`;
    taken.add(id);
    return id;
  };
  /** The first selectable, then editable, surface the base state saw. */
  const revealerIn = (state: string) => {
    const seen = seenIn.get(state) ?? [];
    for (const kind of ["selectable", "editable"] as const) {
      const match = seen
        .filter((entry) => entry.kind === kind)
        .sort((a, b) => compare(a.selector, b.selector))[0];
      if (match !== undefined) return match;
    }
    return undefined;
  };

  const unrevealed = ranked.map(
    ({ group, base, weight }): UnrevealedSurface => {
      const { entry } = group;
      let steps = stepsFor(entry);
      let note: string | undefined;
      if (entry.kind === "toolbar") {
        const revealer = revealerIn(base.id);
        steps = [
          ...(revealer === undefined ? [] : stepsFor(revealer)),
          { action: "waitFor", selector: entry.selector, state: "visible" },
        ];
        if (revealer === undefined)
          note = "add the step that reveals this toolbar before the waitFor";
      }
      const label = stateLabels[base.id];
      const suggestion: DraftState = {
        id: uniqueId(
          `${base.id}-${slug(entry.name, entry.kind)}-${verbs[entry.kind]}`,
        ),
        description: describe(label ?? base.id, entry.kind, entry.name),
        ...(base.from === undefined ? { url: base.url } : { from: base.from }),
        steps,
        expect: {},
      };
      return {
        state: base.id,
        ...(label === undefined || label === base.id ? {} : { label }),
        kind: entry.kind,
        name: entry.name,
        selector: entry.selector,
        reveals: group.reveals,
        weight,
        suggestion,
        ...(note === undefined ? {} : { note }),
      };
    },
  );
  return {
    status: "ran",
    total: groups.size,
    covered,
    unrevealed: unrevealed.slice(0, SURFACES_SHOWN),
    omitted: Math.max(0, unrevealed.length - SURFACES_SHOWN),
  };
}

/** Text lines for `idiom coverage --states`. */
export function surfaceCoverageLines(coverage: SurfaceCoverage): string[] {
  if (coverage.status === "unavailable")
    return [`Surfaces: unavailable (${coverage.reason}).`];
  const head = `Surfaces: ${coverage.covered} of ${coverage.total} shown open, selected or focused by a state`;
  if (coverage.unrevealed.length === 0) return [`${head}.`];
  return [
    `${head}; never shown (top ${coverage.unrevealed.length} by what they reveal):`,
    ...coverage.unrevealed.flatMap((entry) => [
      `- ${entry.label ?? entry.state} › ${entry.name || entry.selector} (${entry.kind}, reveals ${entry.reveals})`,
      `  add to "states": ${JSON.stringify(entry.suggestion)}`,
      ...(entry.note === undefined ? [] : [`  note: ${entry.note}`]),
    ]),
    ...(coverage.omitted > 0 ? [`- +${coverage.omitted} more`] : []),
  ];
}
