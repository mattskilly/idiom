import { IdiomError } from "../errors.js";
import { effectiveIntermediateWidths, type Flow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import {
  selectColorSchemes,
  selectViewports,
  stateViewports,
} from "./resolve.js";
import type { CaptureScope, SelectedTuple } from "./scope.js";
import type { SelectedColorScheme, SelectedViewport } from "./types.js";

/** Widths the documented default adds when they fall inside the range. */
export const intermediateLandmarkWidths = [900, 768] as const;

/**
 * The widths a state captures between its declared viewports. `true` is the
 * documented default: the midpoint of each adjacent pair of distinct declared
 * widths, plus 900 and 768 when strictly inside the declared range. Any width
 * equal to a declared width is dropped; the result is sorted ascending.
 */
export function intermediateWidthsFor(
  declared: ReadonlyArray<Pick<SelectedViewport, "width">>,
  setting: true | readonly number[],
): number[] {
  const widths = [...new Set(declared.map((viewport) => viewport.width))].sort(
    (a, b) => a - b,
  );
  const taken = new Set(widths);
  let candidates: number[];
  if (setting === true) {
    candidates = [];
    for (let index = 1; index < widths.length; index += 1) {
      const low = widths[index - 1] as number;
      const high = widths[index] as number;
      candidates.push(Math.round((low + high) / 2));
    }
    const min = widths[0];
    const max = widths[widths.length - 1];
    if (min !== undefined && max !== undefined)
      for (const landmark of intermediateLandmarkWidths)
        if (landmark > min && landmark < max) candidates.push(landmark);
  } else candidates = [...setting];
  return [...new Set(candidates)]
    .filter((width) => !taken.has(width))
    .sort((a, b) => a - b);
}

export const intermediateViewportName = (width: number) =>
  `intermediate-${width}`;
/** Viewport names of this shape are reserved for intermediate widths. */
export const isIntermediateViewportName = (name: string) =>
  /^intermediate-\d+$/.test(name);

/**
 * A synthetic viewport at `width`. Height and touch come from the narrowest
 * declared viewport wider than it, else the widest declared one: an editor at
 * 900px is a narrowed desktop window.
 */
export function intermediateViewport(
  width: number,
  declared: readonly SelectedViewport[],
  reservedNames: Iterable<string>,
): SelectedViewport {
  const name = intermediateViewportName(width);
  if (new Set(reservedNames).has(name))
    throw new IdiomError(
      `intermediateWidths: viewport name ${JSON.stringify(name)} is already declared; rename that viewport or drop width ${width}`,
    );
  const sorted = [...declared].sort((a, b) => a.width - b.width);
  const neighbour =
    sorted.find((viewport) => viewport.width > width) ?? sorted.at(-1);
  if (neighbour === undefined)
    throw new IdiomError(
      `intermediateWidths: width ${width} has no declared viewport to borrow a height from`,
    );
  return {
    name,
    width,
    height: neighbour.height,
    ...(neighbour.touch === undefined ? {} : { touch: neighbour.touch }),
    intermediate: true,
  };
}

/** The scheme intermediate widths capture in: the project default if selected. */
export function intermediateColorScheme(
  project: Project,
  flow: Flow,
): SelectedColorScheme | undefined {
  const schemes = selectColorSchemes(project, flow);
  return schemes.includes(project.capture.colorScheme)
    ? project.capture.colorScheme
    : schemes[0];
}

/**
 * Extra capture tuples for states that opt into intermediate widths, in
 * flow-state order then width order, in the default color scheme only.
 * `--viewports` (an explicit width narrowing) and a `--schemes` that leaves
 * out the default scheme add none; `--states` and exact tuples keep them for
 * every opted-in state with at least one selected tuple.
 */
export function intermediateCaptureTuples(options: {
  project: Project;
  flow: Flow;
  selected: readonly SelectedTuple[];
  scope?: CaptureScope | undefined;
}): { viewports: SelectedViewport[]; tuples: SelectedTuple[] } {
  const none = { viewports: [], tuples: [] };
  const { project, flow } = options;
  if (options.scope?.viewports !== undefined) return none;
  const colorScheme = intermediateColorScheme(project, flow);
  if (colorScheme === undefined) return none;
  if (
    options.scope?.schemes !== undefined &&
    !options.scope.schemes
      .split(",")
      .map((part) => part.trim())
      .includes(colorScheme)
  )
    return none;
  const declared = selectViewports(project, flow);
  const reserved = [
    ...project.viewports.map((viewport) => viewport.name),
    ...declared.map((viewport) => viewport.name),
  ];
  const selectedStates = new Set(
    options.selected.map((tuple) => tuple.state.id),
  );
  const viewports = new Map<number, SelectedViewport>();
  const tuples: SelectedTuple[] = [];
  for (const state of flow.states) {
    if (!selectedStates.has(state.id)) continue;
    const setting = effectiveIntermediateWidths(flow, state);
    if (setting === undefined) continue;
    for (const width of intermediateWidthsFor(
      stateViewports(declared, state),
      setting,
    )) {
      let viewport = viewports.get(width);
      if (viewport === undefined) {
        viewport = intermediateViewport(width, declared, reserved);
        viewports.set(width, viewport);
      }
      tuples.push({
        state,
        viewport,
        colorScheme,
        colorSchemeAxis: project.colorSchemes.length > 1,
      } as SelectedTuple);
    }
  }
  return {
    viewports: [...viewports.values()].sort((a, b) => a.width - b.width),
    tuples,
  };
}
