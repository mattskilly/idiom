import { IdiomError } from "../errors.js";
import { type Flow, isWebFlow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import {
  selectCaptureTuples,
  selectColorSchemes,
  selectViewports,
} from "./resolve.js";
import type { CaptureTupleSelection, SelectedColorScheme } from "./types.js";

export type CaptureScope = {
  states?: string | undefined;
  viewports?: string | undefined;
  schemes?: string | undefined;
};
export type Coordinate = {
  state: string;
  viewport: string;
  colorScheme: SelectedColorScheme;
};
export type SelectedTuple = ReturnType<typeof selectCaptureTuples>[number];
export const coordinate = (tuple: SelectedTuple): Coordinate => ({
  state: tuple.state.id,
  viewport: tuple.viewport.name,
  colorScheme: tuple.colorScheme,
});
export const hasScope = (scope?: CaptureScope) =>
  scope !== undefined &&
  Object.values(scope).some((value) => value !== undefined);

function parse(
  value: string | undefined,
  allowed: string[],
  label: string,
): Set<string> | undefined {
  if (value === undefined) return undefined;
  const values = value.split(",").map((part) => part.trim());
  if (values.some((part) => !part) || new Set(values).size !== values.length)
    throw new IdiomError(
      `--${label} requires a nonempty comma-separated list without duplicates`,
    );
  for (const part of values)
    if (!allowed.includes(part))
      throw new IdiomError(
        `--${label}: unknown or flow-unselected value ${JSON.stringify(part)}`,
      );
  return new Set(values);
}

export function resolveCaptureScope(options: {
  project: Project;
  flow: Flow;
  scope?: CaptureScope | undefined;
  tuples?: CaptureTupleSelection[] | undefined;
}) {
  const declared = selectCaptureTuples(options);
  if (options.tuples !== undefined && hasScope(options.scope))
    throw new IdiomError(
      "cannot combine exact capture tuples with scope flags",
    );
  const states = parse(
    options.scope?.states,
    options.flow.states.map((state) => state.id),
    "states",
  );
  const viewports = parse(
    options.scope?.viewports,
    selectViewports(options.project, options.flow).map((v) => v.name),
    "viewports",
  );
  const schemes = parse(
    options.scope?.schemes,
    selectColorSchemes(options.project, options.flow),
    "schemes",
  );
  const selected =
    options.tuples !== undefined
      ? selectCaptureTuples({ ...options, requested: options.tuples })
      : declared.filter(
          (tuple) =>
            (!states || states.has(tuple.state.id)) &&
            (!viewports || viewports.has(tuple.viewport.name)) &&
            (!schemes || schemes.has(tuple.colorScheme)),
        );
  if (hasScope(options.scope) && selected.length === 0)
    throw new IdiomError(
      "scope selects no capture tuples after state viewport restrictions",
    );
  return { declared, selected };
}

export function probeCoordinates(
  project: Project,
  flow: Flow,
  tuples: SelectedTuple[],
) {
  const enabled = tuples.filter(
    (tuple) => tuple.state.probe ?? project.checks.probe.enabled,
  );
  const intended: Coordinate[] = [];
  if (isWebFlow(flow)) {
    if (project.checks.probe.everywhere)
      intended.push(...enabled.map(coordinate));
    else
      for (const state of new Set(enabled.map((tuple) => tuple.state.id))) {
        const candidates = enabled.filter((tuple) => tuple.state.id === state);
        const first = candidates[0];
        if (!first) continue;
        intended.push(
          coordinate(
            candidates.find(
              (tuple) =>
                tuple.viewport.name === first.viewport.name &&
                tuple.colorScheme === "light",
            ) ?? first,
          ),
        );
      }
  }
  return {
    policy: isWebFlow(flow)
      ? project.checks.probe.everywhere
        ? ("everywhere" as const)
        : ("once-per-state" as const)
      : ("unsupported" as const),
    fallback:
      !project.checks.probe.everywhere &&
      intended.some((tuple) => tuple.colorScheme !== "light"),
    intended,
    executed: [] as Coordinate[],
  };
}
