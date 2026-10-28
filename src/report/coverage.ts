import {
  captureTupleKey,
  expectedCaptureTupleKeys,
  selectColorSchemes,
  selectViewports,
} from "../capture/resolve.js";
import type { RunRecord } from "../capture/run-record.js";
import type { Coordinate } from "../capture/scope.js";
import type { CaptureTupleSelection } from "../capture/types.js";
import type { CheckTuple } from "../checks/types.js";
import {
  type FlowStateCoverage,
  stateCoverageLine,
} from "../coverage/states.js";
import {
  type QuickInteraction,
  renderInteractionSentences,
} from "../quick/interaction.js";
import { type Flow, stateChainLabel } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import { escapeHtml } from "./html.js";

export type ReportCoverage = {
  flow: string;
  purpose: string;
  declaredStateCount: number;
  states: string[];
  /** Display labels for states reached from another state, by id. */
  stateLabels?: Record<string, string> | undefined;
  viewports: Array<{ name: string; width: number; height: number }>;
  colorSchemes: Array<"light" | "dark">;
  selectedTuples: number;
  skippedTuples?: number | undefined;
  failedTuples?: Coordinate[] | undefined;
  unresolvedTuples?: Coordinate[] | undefined;
  omittedStates?: string[] | undefined;
  omittedViewports?: string[] | undefined;
  omittedSchemes?: string[] | undefined;
  successfulTuples: number;
  commits: Array<{ label: string; value: string }>;
  limitations: string[];
  surfaceCoverage?: SurfaceCoverage | undefined;
  /** Quick review only: what the interaction probe did on each page. */
  interaction?: QuickInteraction | undefined;
  /** Flow review only: which dimensions each state was observed in. */
  stateCoverage?: FlowStateCoverage | undefined;
};

export type SurfaceCoverageEntry = {
  id: string;
  name: string;
  flows: string[];
};

export type SurfaceCoverage = {
  judged: SurfaceCoverageEntry[];
  governedNotJudged: SurfaceCoverageEntry[];
  ungoverned: SurfaceCoverageEntry[];
};

export function resolveSurfaceCoverage(options: {
  project: Project;
  currentFlow: Flow;
  allFlows: Flow[];
}): SurfaceCoverage | undefined {
  if (options.project.surfaces.length === 0) return undefined;
  const flowsBySurface = new Map<string, string[]>();
  for (const flow of options.allFlows) {
    if (flow.surface === undefined) continue;
    flowsBySurface.set(flow.surface, [
      ...(flowsBySurface.get(flow.surface) ?? []),
      flow.id,
    ]);
  }
  const result: SurfaceCoverage = {
    judged: [],
    governedNotJudged: [],
    ungoverned: [],
  };
  for (const surface of options.project.surfaces) {
    const flows = [...new Set(flowsBySurface.get(surface.id) ?? [])].sort();
    const entry = { ...surface, flows };
    if (flows.includes(options.currentFlow.id)) result.judged.push(entry);
    else if (flows.length > 0) result.governedNotJudged.push(entry);
    else result.ungoverned.push(entry);
  }
  return result;
}

type CoverageTuple = Pick<
  CheckTuple,
  | "state"
  | "viewport"
  | "colorScheme"
  | "failure"
  | "mismatches"
  | "layoutRepresentative"
  | "observations"
>;

function tupleSucceeded(tuple: CoverageTuple): boolean {
  return tuple.failure === undefined && tuple.mismatches.length === 0;
}

/** One line per DESIGN.md-inferred component: what it matched, or that it didn't. */
function inferredComponentLimitations(tuples: CoverageTuple[]): string[] {
  const groups = new Map<
    string,
    {
      name: string;
      source: string;
      selectors: Set<string>;
      elements: number;
      captures: number;
    }
  >();
  for (const tuple of tuples.filter(tupleSucceeded)) {
    if (tuple.observations?.version !== 2) continue;
    for (const component of tuple.observations.components ?? []) {
      if (component.inferred === undefined) continue;
      const key = `${component.name}\u0000${component.inferred.source}`;
      const group = groups.get(key) ?? {
        name: component.name,
        source: component.inferred.source,
        selectors: new Set<string>(),
        elements: 0,
        captures: 0,
      };
      groups.set(key, group);
      if (component.unresolved === true || component.rects.length === 0)
        continue;
      group.selectors.add(component.selector);
      group.elements += component.rects.length;
      group.captures += 1;
    }
  }
  return [...groups.values()].map((group) =>
    group.selectors.size === 0
      ? `Component "${group.name}" inferred from ${group.source} was not matched by any class or aria-label words in capture; it was not checked.`
      : `Component "${group.name}" inferred from ${group.source}, matched ${[...group.selectors].join("; ")} (${group.elements} element${group.elements === 1 ? "" : "s"} across ${group.captures} capture${group.captures === 1 ? "" : "s"}); explicit checks.components overrides it.`,
  );
}

function markdownText(value: string): string {
  return value
    .replace(/([\\`|[\]*_#])/g, "\\$1")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\r\n?|\n/g, "<br>");
}

function collapsedLimitations(
  keys: string[] = [],
  retainedCount = 0,
): string[] {
  return [
    ...(retainedCount === 0
      ? []
      : [
          `${retainedCount} combination layout screenshots were collapsed as layout-identical; every combination retains independent deterministic evidence.`,
        ]),
    ...(keys.length === 0
      ? []
      : [
          `${keys.length} legacy combination tuples were collapsed without per-combination evidence; their deterministic checks are unavailable. Recapture the flow to check every combination.`,
        ]),
  ];
}

/** `{ versions: "versions from empty" }` for the flow's chained states. */
function chainedStateLabels(
  flow: Flow,
  states: string[],
): { stateLabels?: Record<string, string> } {
  const labels = Object.fromEntries(
    flow.states.flatMap((state) =>
      "reachedFrom" in state &&
      state.reachedFrom !== undefined &&
      states.includes(state.id)
        ? [[state.id, stateChainLabel(state)]]
        : [],
    ),
  );
  return Object.keys(labels).length === 0 ? {} : { stateLabels: labels };
}

export function buildReviewCoverage(options: {
  record?: RunRecord | undefined;
  flow: Flow;
  project: Project;
  collapsedTupleKeys?: string[] | undefined;
  allFlows?: Flow[] | undefined;
  tuples: CoverageTuple[];
  commit: string;
  interaction?: QuickInteraction | undefined;
  stateCoverage?: FlowStateCoverage | undefined;
}): ReportCoverage {
  const record = options.record;
  const states = record
    ? [...new Set(record.selected.map((tuple) => tuple.state))]
    : options.flow.states.map((state) => state.id);
  const viewports = record
    ? record.viewports.filter((v) =>
        record.selected.some((tuple) => tuple.viewport === v.name),
      )
    : selectViewports(options.project, options.flow);
  const colorSchemes = record
    ? [...new Set(record.selected.map((tuple) => tuple.colorScheme))]
    : selectColorSchemes(options.project, options.flow);
  const expectedKeys = new Set(
    record
      ? record.selected
          .map(captureTupleKey)
          .filter((key) => !(options.collapsedTupleKeys ?? []).includes(key))
      : expectedCaptureTupleKeys({
          project: options.project,
          flow: options.flow,
          collapsed: options.collapsedTupleKeys,
        }),
  );
  const successfulKeys = new Set(
    options.tuples.flatMap((tuple) => {
      const key = captureTupleKey({
        state: tuple.state,
        viewport: tuple.viewport,
        colorScheme: tuple.colorScheme ?? options.project.capture.colorScheme,
      });
      return expectedKeys.has(key) && tupleSucceeded(tuple) ? [key] : [];
    }),
  );
  const narrowedViewports = record
    ? []
    : options.project.viewports
        .filter(
          (viewport) => !viewports.some(({ name }) => name === viewport.name),
        )
        .map(({ name }) => name);
  const narrowedSchemes = record
    ? []
    : options.project.colorSchemes.filter(
        (scheme) => !colorSchemes.includes(scheme),
      );
  const skippedTuples = record
    ? record.declared.length - record.selected.length
    : 0;
  const omittedStates = record
    ? [...new Set(record.declared.map((tuple) => tuple.state))].filter(
        (state) => !states.includes(state),
      )
    : [];
  const omittedViewports = record
    ? [...new Set(record.declared.map((tuple) => tuple.viewport))].filter(
        (name) => !viewports.some((v) => v.name === name),
      )
    : [];
  const omittedSchemes = record
    ? [...new Set(record.declared.map((tuple) => tuple.colorScheme))].filter(
        (scheme) => !colorSchemes.includes(scheme),
      )
    : [];
  const successfulCount = successfulKeys.size;
  const byKey = new Map(
    options.tuples.map((tuple) => [
      captureTupleKey({
        ...tuple,
        colorScheme: tuple.colorScheme ?? options.project.capture.colorScheme,
      }),
      tuple,
    ]),
  );
  const unresolvedTuples = (record?.selected ?? []).filter((coordinate) => {
    const tuple = byKey.get(captureTupleKey(coordinate));
    return !tuple || tuple.failure?.stage === "url-resolution";
  });
  const failedTuples = (record?.selected ?? []).filter((coordinate) => {
    const tuple = byKey.get(captureTupleKey(coordinate));
    return (
      tuple &&
      !tupleSucceeded(tuple) &&
      tuple.failure?.stage !== "url-resolution"
    );
  });
  const limitations = [
    ...(record
      ? [
          `${failedTuples.length} selected captures failed; ${unresolvedTuples.length} selected coordinates are unresolved.`,
          `${skippedTuples} declared tuples intentionally skipped. Omitted states: ${omittedStates.join(", ") || "none"}; viewports: ${omittedViewports.join(", ") || "none"}; colour schemes: ${omittedSchemes.join(", ") || "none"}.`,
          `Interaction probe policy: ${record.probe.policy}; ${record.probe.executed.length} of ${record.probe.intended.length} designated coordinates executed.${record.probe.policy === "once-per-state" ? " Sibling coordinates have no probe evidence under this policy." : " Probe evidence belongs only to its executed coordinate."}${record.probe.fallback ? " Light was excluded; the first selected scheme was used." : ""}${record.probe.policy === "unsupported" ? " Interaction probing is unavailable for Electron." : ""}`,
        ]
      : []),
    ...collapsedLimitations(
      options.collapsedTupleKeys,
      options.tuples.filter((tuple) => tuple.layoutRepresentative !== undefined)
        .length,
    ),
    `This review covers only flow ${options.flow.id} and the states, viewports, and colour schemes listed above.`,
    ...(narrowedViewports.length === 0
      ? []
      : [
          `The flow excludes project viewport${narrowedViewports.length === 1 ? "" : "s"}: ${narrowedViewports.join(", ")}.`,
        ]),
    ...(narrowedSchemes.length === 0
      ? []
      : [
          `The flow excludes project colour scheme${narrowedSchemes.length === 1 ? "" : "s"}: ${narrowedSchemes.join(", ")}.`,
        ]),
    ...(successfulCount === expectedKeys.size
      ? []
      : [
          `${expectedKeys.size - successfulCount} selected tuple${expectedKeys.size - successfulKeys.size === 1 ? " was" : "s were"} not successfully captured and are not covered.`,
        ]),
    ...inferredComponentLimitations(options.tuples),
  ];
  const surfaceCoverage = resolveSurfaceCoverage({
    project: options.project,
    currentFlow: options.flow,
    allFlows: options.allFlows ?? [options.flow],
  });
  return {
    flow: options.flow.id,
    purpose: "Declared review coverage",
    declaredStateCount: record
      ? new Set(record.declared.map((tuple) => tuple.state)).size
      : options.flow.states.length,
    states,
    skippedTuples,
    failedTuples,
    unresolvedTuples,
    omittedStates,
    omittedViewports,
    omittedSchemes,
    ...chainedStateLabels(options.flow, states),
    viewports,
    colorSchemes,
    selectedTuples: expectedKeys.size,
    successfulTuples: successfulCount,
    commits: [{ label: "Captured commit", value: options.commit }],
    limitations,
    ...(surfaceCoverage === undefined ? {} : { surfaceCoverage }),
    ...(options.interaction === undefined
      ? {}
      : { interaction: options.interaction }),
    ...(options.stateCoverage === undefined
      ? {}
      : { stateCoverage: options.stateCoverage }),
  };
}

export function buildVerificationCoverage(options: {
  flow: Flow;
  project: Project;
  collapsedTupleKeys?: string[] | undefined;
  tuples: CaptureTupleSelection[];
  successfulTuples: number;
  baselineCommit?: string | undefined;
  currentCommit?: string | undefined;
}): ReportCoverage {
  const collapsed = new Set(options.collapsedTupleKeys);
  const tuples = options.tuples.filter(
    (tuple) =>
      !collapsed.has(
        captureTupleKey({
          state: tuple.state,
          viewport: tuple.viewport,
          colorScheme: tuple.colorScheme ?? options.project.capture.colorScheme,
        }),
      ),
  );
  const selectedStates = options.flow.states
    .map(({ id }) => id)
    .filter((state) => tuples.some((tuple) => tuple.state === state));
  const selectedViewportNames = new Set(tuples.map(({ viewport }) => viewport));
  const viewports = selectViewports(options.project, options.flow).filter(
    ({ name }) => selectedViewportNames.has(name),
  );
  const selectedSchemes = new Set(
    tuples.map(
      (tuple) => tuple.colorScheme ?? options.project.capture.colorScheme,
    ),
  );
  const colorSchemes = selectColorSchemes(options.project, options.flow).filter(
    (scheme) => selectedSchemes.has(scheme),
  );
  const fullGridCount = expectedCaptureTupleKeys({
    collapsed: options.collapsedTupleKeys,
    project: options.project,
    flow: options.flow,
  }).length;
  const fullGrid = tuples.length > 0 && tuples.length === fullGridCount;
  const noTuples = tuples.length === 0;
  return {
    flow: options.flow.id,
    purpose: noTuples
      ? "No finding verification coverage"
      : fullGrid
        ? "Full declared grid selected for finding verification"
        : "Finding-scoped verification coverage",
    declaredStateCount: options.flow.states.length,
    states: selectedStates,
    ...chainedStateLabels(options.flow, selectedStates),
    viewports,
    colorSchemes,
    selectedTuples: tuples.length,
    successfulTuples: options.successfulTuples,
    commits: [
      {
        label: "Historical baseline commit",
        value: options.baselineCommit ?? "not captured",
      },
      {
        label: "Current recapture commit",
        value: options.currentCommit ?? "not captured",
      },
    ],
    limitations: noTuples
      ? [
          "No findings were embedded, so zero states or tuples were exercised and no commit identity was captured.",
          "This result is not a fresh review of the flow.",
        ]
      : [
          ...collapsedLimitations(options.collapsedTupleKeys),
          fullGrid
            ? "The full declared tuple grid was selected only as evidence for the embedded findings; this is not a fresh whole-flow review."
            : "Only tuples selected by the embedded findings were rechecked; this is not a fresh whole-flow review.",
          ...(options.successfulTuples === tuples.length
            ? []
            : [
                `${tuples.length - options.successfulTuples} selected tuple${tuples.length - options.successfulTuples === 1 ? " was" : "s were"} not successfully recaptured and are not covered.`,
              ]),
        ],
  };
}

export function renderCoverageMarkdown(coverage: ReportCoverage): string {
  const states =
    coverage.states.length === 0
      ? "none"
      : coverage.states
          .map((state) => markdownText(coverage.stateLabels?.[state] ?? state))
          .join(", ");
  const viewports =
    coverage.viewports.length === 0
      ? "none"
      : coverage.viewports
          .map(
            ({ name, width, height }) =>
              `${markdownText(name)} (${width}×${height})`,
          )
          .join(", ");
  const schemes =
    coverage.colorSchemes.length === 0
      ? "none"
      : coverage.colorSchemes.map(markdownText).join(", ");
  const surfaceLines =
    coverage.surfaceCoverage === undefined
      ? []
      : [
          "### Project surfaces",
          "",
          ...renderSurfaceGroupMarkdown(
            "Judged in this review",
            coverage.surfaceCoverage.judged,
          ),
          ...renderSurfaceGroupMarkdown(
            "Governed by another flow, not judged here",
            coverage.surfaceCoverage.governedNotJudged,
          ),
          ...renderSurfaceGroupMarkdown(
            "Ungoverned (no flow captures this surface)",
            coverage.surfaceCoverage.ungoverned,
          ),
        ];
  return [
    "## Coverage and limits",
    "",
    markdownText(coverage.purpose),
    "",
    `- Flow: ${markdownText(coverage.flow)}`,
    `- States: ${coverage.states.length} of ${coverage.declaredStateCount} declared (${states})`,
    `- Viewports: ${viewports}`,
    `- Colour schemes: ${schemes}`,
    `- Successful tuples: ${coverage.successfulTuples} of ${coverage.selectedTuples} selected`,
    ...(coverage.stateCoverage === undefined
      ? []
      : [`- ${markdownText(stateCoverageLine(coverage.stateCoverage))}`]),
    ...coverage.commits.map(
      ({ label, value }) =>
        `- ${markdownText(label)}: \`${markdownText(value)}\``,
    ),
    "",
    ...surfaceLines,
    ...(coverage.interaction === undefined
      ? []
      : [
          "### Interaction",
          "",
          ...renderInteractionSentences(coverage.interaction).map((sentence) =>
            coverage.interaction?.status === "probed" &&
            coverage.interaction.pages.length > 1
              ? `- ${markdownText(sentence)}`
              : markdownText(sentence),
          ),
          "",
        ]),
    "Limitations:",
    "",
    ...coverage.limitations.map(
      (limitation) => `- ${markdownText(limitation)}`,
    ),
    "",
  ].join("\n");
}

function renderSurfaceGroupMarkdown(
  label: string,
  entries: SurfaceCoverageEntry[],
): string[] {
  if (entries.length === 0) return [`- ${label}: none`, ""];
  return [
    `- ${label}:`,
    ...entries.map(
      (entry) =>
        `  - ${markdownText(entry.name)} (${markdownText(entry.id)}) — flows: ${entry.flows.length === 0 ? "none" : entry.flows.map(markdownText).join(", ")}`,
    ),
    "",
  ];
}

export function renderCoverageHtml(coverage: ReportCoverage): string {
  const states =
    coverage.states.length === 0
      ? "none"
      : coverage.states
          .map((state) => escapeHtml(coverage.stateLabels?.[state] ?? state))
          .join(", ");
  const viewports =
    coverage.viewports.length === 0
      ? "none"
      : coverage.viewports
          .map(
            ({ name, width, height }) =>
              `${escapeHtml(name)} (${width}×${height})`,
          )
          .join(", ");
  const schemes =
    coverage.colorSchemes.length === 0
      ? "none"
      : coverage.colorSchemes.map(escapeHtml).join(", ");
  const surfaces = coverage.surfaceCoverage;
  const surfaceHtml =
    surfaces === undefined
      ? ""
      : `<h3>Project surfaces</h3><dl>${renderSurfaceGroupHtml("Judged in this review", surfaces.judged)}${renderSurfaceGroupHtml("Governed by another flow, not judged here", surfaces.governedNotJudged)}${renderSurfaceGroupHtml("Ungoverned (no flow captures this surface)", surfaces.ungoverned)}</dl>`;
  return `<section class="panel coverage" aria-labelledby="coverage-heading"><h2 id="coverage-heading">Coverage and limits</h2><p>${escapeHtml(coverage.purpose)}</p><dl><dt>Flow</dt><dd>${escapeHtml(coverage.flow)}</dd><dt>States</dt><dd>${coverage.states.length} of ${coverage.declaredStateCount} declared (${states})</dd><dt>Viewports</dt><dd>${viewports}</dd><dt>Colour schemes</dt><dd>${schemes}</dd><dt>Successful tuples</dt><dd>${coverage.successfulTuples} of ${coverage.selectedTuples} selected</dd>${coverage.stateCoverage === undefined ? "" : `<dt>State coverage</dt><dd>${escapeHtml(stateCoverageLine(coverage.stateCoverage))}</dd>`}${coverage.commits.map(({ label, value }) => `<dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value)}</code></dd>`).join("")}</dl>${surfaceHtml}${interactionHtml(coverage.interaction)}<h3>Limitations</h3><ul>${coverage.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul></section>`;
}

function interactionHtml(interaction: QuickInteraction | undefined): string {
  if (interaction === undefined) return "";
  const sentences = renderInteractionSentences(interaction);
  const body =
    interaction.status === "probed" && interaction.pages.length > 1
      ? `<ul>${sentences.map((sentence) => `<li>${escapeHtml(sentence)}</li>`).join("")}</ul>`
      : sentences.map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join("");
  return `<h3>Interaction</h3>${body}`;
}

function renderSurfaceGroupHtml(
  label: string,
  entries: SurfaceCoverageEntry[],
): string {
  const value =
    entries.length === 0
      ? "none"
      : `<ul>${entries
          .map(
            (entry) =>
              `<li>${escapeHtml(entry.name)} (${escapeHtml(entry.id)}) — flows: ${entry.flows.length === 0 ? "none" : entry.flows.map(escapeHtml).join(", ")}</li>`,
          )
          .join("")}</ul>`;
  return `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`;
}
