import { intermediateColorScheme } from "../capture/intermediate.js";
import { selectViewports, stateViewports } from "../capture/resolve.js";
import type { CheckTuple } from "../checks/types.js";
import {
  effectiveIntermediateWidths,
  type Flow,
  isWebFlow,
} from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";

/** A one-row toolbar this full at a declared width is close to wrapping. */
export const INTERMEDIATE_FILL_THRESHOLD = 0.85;

export type IntermediateWidthSuggestion = {
  state: string;
  label?: string | undefined;
  toolbar: string;
  reason: string;
  remedy: string;
  /** Other toolbars in the state that also triggered. */
  others: number;
};

export type IntermediateWidthCoverage = {
  suggestions: IntermediateWidthSuggestion[];
};

type WidthTuple = Pick<
  CheckTuple,
  | "state"
  | "viewport"
  | "colorScheme"
  | "failure"
  | "mismatches"
  | "observations"
  | "intermediateWidth"
>;

/**
 * States not yet opted into intermediateWidths whose captures show a
 * toolbar near a width boundary: one row at one declared width and wrapped
 * at another, or one row but nearly full. Undefined when none qualify.
 */
export function computeIntermediateWidthCoverage(options: {
  project: Project;
  flow: Flow;
  tuples: readonly WidthTuple[];
  labels?: Record<string, string> | undefined;
}): IntermediateWidthCoverage | undefined {
  const { project, flow } = options;
  if (!isWebFlow(flow)) return undefined;
  const scheme = intermediateColorScheme(project, flow);
  if (scheme === undefined) return undefined;
  const declared = selectViewports(project, flow);
  const suggestions: IntermediateWidthSuggestion[] = [];
  for (const state of flow.states) {
    if (effectiveIntermediateWidths(flow, state) !== undefined) continue;
    const widthOf = new Map(
      stateViewports(declared, state).map((viewport) => [
        viewport.name,
        viewport.width,
      ]),
    );
    // Per toolbar: its rows and fill at each declared width, narrow first.
    const byToolbar = new Map<
      string,
      Array<{ width: number; rows: number; fill: number | undefined }>
    >();
    for (const tuple of options.tuples) {
      const width = widthOf.get(tuple.viewport);
      if (
        tuple.state !== state.id ||
        tuple.intermediateWidth === true ||
        width === undefined ||
        (tuple.colorScheme ?? project.capture.colorScheme) !== scheme ||
        tuple.failure !== undefined ||
        tuple.mismatches.length > 0 ||
        tuple.observations?.version !== 2
      )
        continue;
      for (const record of tuple.observations.toolbarLayouts?.records ?? []) {
        if (record.vertical) continue;
        const entries = byToolbar.get(record.toolbar) ?? [];
        entries.push({ width, rows: record.rows, fill: record.fill });
        byToolbar.set(record.toolbar, entries);
      }
    }
    const reasons: Array<{ toolbar: string; reason: string }> = [];
    for (const [toolbar, entries] of byToolbar) {
      entries.sort((a, b) => b.width - a.width);
      const single = entries.find((entry) => entry.rows === 1);
      const wrapped = entries.find((entry) => entry.rows > 1);
      if (single !== undefined && wrapped !== undefined) {
        reasons.push({
          toolbar,
          reason: `${toolbar} is one row at ${single.width}px and wraps at ${wrapped.width}px`,
        });
        continue;
      }
      const full = entries.find(
        (entry) =>
          entry.rows === 1 &&
          entry.fill !== undefined &&
          entry.fill >= INTERMEDIATE_FILL_THRESHOLD,
      );
      if (full?.fill !== undefined)
        reasons.push({
          toolbar,
          reason: `${toolbar} fills ${Math.round(full.fill * 100)}% of its row at ${full.width}px`,
        });
    }
    const first = reasons[0];
    if (first === undefined) continue;
    const label = options.labels?.[state.id];
    suggestions.push({
      state: state.id,
      ...(label === undefined || label === state.id ? {} : { label }),
      toolbar: first.toolbar,
      reason: first.reason,
      remedy: `add "intermediateWidths": true to state ${state.id} in flow ${flow.id}`,
      others: reasons.length - 1,
    });
  }
  return suggestions.length === 0 ? undefined : { suggestions };
}

/** The `Intermediate widths:` block of `idiom coverage --states`. */
export function intermediateWidthCoverageLines(
  coverage: IntermediateWidthCoverage,
): string[] {
  return [
    "Intermediate widths: toolbars near a width boundary between declared viewports:",
    ...coverage.suggestions.map(
      (entry) =>
        `- ${entry.label ?? entry.state}: ${entry.reason}${entry.others > 0 ? ` (+${entry.others} more toolbar${entry.others === 1 ? "" : "s"})` : ""}`,
    ),
    "To cover:",
    ...coverage.suggestions.map(
      (entry) => `- ${entry.label ?? entry.state}: ${entry.remedy}`,
    ),
  ];
}
