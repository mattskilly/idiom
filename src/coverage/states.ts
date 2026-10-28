import {
  captureTupleKey,
  selectColorSchemes,
  selectViewports,
  stateViewports,
} from "../capture/resolve.js";
import type { RunRecord } from "../capture/run-record.js";
import type { Coordinate } from "../capture/scope.js";
import type { CheckTuple, ProbeArtifact } from "../checks/types.js";
import {
  type DataState,
  type Flow,
  isElectronFlow,
  stateChainLabel,
} from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";

export type StateDimensionKind =
  | "viewport"
  | "colorScheme"
  | "reducedMotion"
  | "network"
  | "interaction"
  | "data";

export type StateDimension = {
  kind: StateDimensionKind;
  value: string;
  label: string;
  status: "observed" | "missing" | "not-applicable";
  /** Why it is missing or not applicable. */
  reason?: string | undefined;
  /** Missing only: the config, flow, or command change that covers it. */
  remedy?: string | undefined;
};

type Totals = {
  observed: number;
  applicable: number;
  notApplicable: number;
  /** Observed share of applicable dimensions; null when none apply. */
  percent: number | null;
};

export type StateCoverageEntry = Totals & {
  state: string;
  label?: string | undefined;
  dimensions: StateDimension[];
};

export type StateCoverageGap = {
  label: string;
  remedy: string;
  /** States missing it, in flow order; empty for flow-level data states. */
  states: string[];
};

export type FlowStateCoverage = Totals & {
  flow: string;
  run?: { id: string; commit: string } | undefined;
  captured: boolean;
  states: StateCoverageEntry[];
  /** Flow-level: the empty, one, many, and error data states. */
  data: StateDimension[];
  missing: StateCoverageGap[];
};

export type StateCoverageSummary = { flows: FlowStateCoverage[] };

type CoverageTuple = Pick<
  CheckTuple,
  | "state"
  | "viewport"
  | "colorScheme"
  | "failure"
  | "mismatches"
  | "observations"
>;

const dataStates: DataState[] = ["empty", "one", "many", "error"];
const schemes = ["light", "dark"] as const;

type Gap = { reason: string; remedy: string };
type Evidence = { status: "observed" } | ({ status: "missing" } & Gap);

const observed: Evidence = { status: "observed" };
const missing = (reason: string, remedy: string): Evidence => ({
  status: "missing",
  reason,
  remedy,
});
const notApplicable = (reason: string) => ({
  status: "not-applicable" as const,
  reason,
});

function totals(dimensions: StateDimension[]): Totals {
  const observedCount = dimensions.filter(
    (dimension) => dimension.status === "observed",
  ).length;
  const notApplicableCount = dimensions.filter(
    (dimension) => dimension.status === "not-applicable",
  ).length;
  const applicable = dimensions.length - notApplicableCount;
  return {
    observed: observedCount,
    applicable,
    notApplicable: notApplicableCount,
    percent:
      applicable === 0 ? null : Math.round((observedCount * 100) / applicable),
  };
}

function succeeded(tuple: CoverageTuple): boolean {
  return tuple.failure === undefined && tuple.mismatches.length === 0;
}

const coordinateLabel = (coordinate: Coordinate) =>
  `${coordinate.state}/${coordinate.viewport}/${coordinate.colorScheme}`;

/**
 * Which dimensions the latest capture of one flow observed, for every state:
 * each one observed, missing with the change that covers it, or not
 * applicable (never counted). Pure; reads only the loaded run.
 */
export function computeFlowStateCoverage(options: {
  project: Project;
  flow: Flow;
  runId?: string | undefined;
  commit?: string | undefined;
  record?: RunRecord | undefined;
  tuples: CoverageTuple[];
  collapsedTupleKeys?: string[] | undefined;
}): FlowStateCoverage {
  const { project, flow, record } = options;
  const recapture = `recapture the whole flow: idiom capture ${flow.id}`;
  const recaptureVersion = `recapture with this Idiom version: idiom capture ${flow.id}`;
  const flowViewports = selectViewports(project, flow);
  const flowSchemes = selectColorSchemes(project, flow);
  const keyOf = (tuple: CoverageTuple) =>
    captureTupleKey({
      state: tuple.state,
      viewport: tuple.viewport,
      colorScheme: tuple.colorScheme ?? project.capture.colorScheme,
    });
  const tupleByKey = new Map(
    options.tuples.map((tuple) => [keyOf(tuple), tuple]),
  );
  const collapsed = new Set(options.collapsedTupleKeys);
  const selected = record
    ? new Set(record.selected.map(captureTupleKey))
    : undefined;
  const coordinatesOf = (state: Flow["states"][number]): Coordinate[] =>
    stateViewports(flowViewports, state).flatMap((viewport) =>
      flowSchemes.map((colorScheme) => ({
        state: state.id,
        viewport: viewport.name,
        colorScheme,
      })),
    );
  const successful = (coordinate: Coordinate) => {
    const key = captureTupleKey(coordinate);
    const tuple = tupleByKey.get(key);
    return collapsed.has(key) || (tuple !== undefined && succeeded(tuple));
  };
  /** Observed when any coordinate succeeded; otherwise why none did. */
  const evidenceFor = (coordinates: Coordinate[]): Evidence => {
    if (coordinates.some(successful)) return observed;
    const chosen = coordinates.filter(
      (coordinate) =>
        selected === undefined || selected.has(captureTupleKey(coordinate)),
    );
    const first = chosen[0];
    if (first === undefined) return missing("not selected", recapture);
    const tuple = tupleByKey.get(captureTupleKey(first));
    const problem =
      tuple?.failure !== undefined
        ? `${tuple.failure.stage} failure`
        : tuple === undefined
          ? "missing capture"
          : "expectation mismatch";
    return missing(
      "failed",
      `fix the ${problem} at ${coordinateLabel(first)} and recapture`,
    );
  };
  const mode =
    record?.capture?.reducedMotion ??
    options.tuples
      .map((tuple) =>
        tuple.observations?.version === 2
          ? (tuple.observations.motion?.reducedMotion ??
            tuple.observations.probe?.motion?.reducedMotion)
          : undefined,
      )
      .find((value) => value !== undefined);
  const policy =
    record?.probe.policy ??
    (isElectronFlow(flow) ? "unsupported" : "once-per-state");
  const projectViewports = [
    ...project.viewports.map(({ name }) => name),
    ...flowViewports
      .map(({ name }) => name)
      .filter((name) => !project.viewports.some((v) => v.name === name)),
  ];

  const states = flow.states.map((state): StateCoverageEntry => {
    const dimensions: StateDimension[] = [];
    const add = (
      kind: StateDimensionKind,
      value: string,
      label: string,
      evidence: Evidence | ReturnType<typeof notApplicable>,
    ) => dimensions.push({ kind, value, label, ...evidence });
    const coordinates = coordinatesOf(state);
    const stateNames = new Set(coordinates.map(({ viewport }) => viewport));
    for (const viewport of projectViewports) {
      const label = `viewport ${viewport}`;
      if (!flowViewports.some(({ name }) => name === viewport))
        add(
          "viewport",
          viewport,
          label,
          missing(
            "excluded by flow",
            `add "${viewport}" to "viewports" in flow ${flow.id}`,
          ),
        );
      else if (!stateNames.has(viewport))
        add(
          "viewport",
          viewport,
          label,
          missing(
            "excluded by state",
            `add "${viewport}" to "viewports" on state ${state.id} in flow ${flow.id}`,
          ),
        );
      else
        add(
          "viewport",
          viewport,
          label,
          evidenceFor(coordinates.filter((c) => c.viewport === viewport)),
        );
    }
    for (const scheme of schemes) {
      const label = `${scheme} scheme`;
      if (!project.colorSchemes.includes(scheme))
        add(
          "colorScheme",
          scheme,
          label,
          missing(
            "not in project",
            `add "${scheme}" to "colorSchemes" in project.json (set capture.colorSchemeAttribute if the app themes by attribute)`,
          ),
        );
      else if (!flowSchemes.includes(scheme))
        add(
          "colorScheme",
          scheme,
          label,
          missing(
            "excluded by flow",
            `add "${scheme}" to "colorSchemes" in flow ${flow.id}`,
          ),
        );
      else
        add(
          "colorScheme",
          scheme,
          label,
          evidenceFor(coordinates.filter((c) => c.colorScheme === scheme)),
        );
    }
    const any = evidenceFor(coordinates);
    for (const value of [true, false]) {
      const label = `reduced motion ${value ? "on" : "off"}`;
      add(
        "reducedMotion",
        value ? "on" : "off",
        label,
        any.status === "missing"
          ? any
          : mode === undefined
            ? missing("mode not recorded", recaptureVersion)
            : mode === value
              ? observed
              : missing(
                  "other mode captured",
                  `capture once with "capture": { "reducedMotion": ${value} } in project.json`,
                ),
      );
    }
    add("network", "fast", "fast network", any);

    const successes = coordinates.flatMap((coordinate) => {
      const tuple = tupleByKey.get(captureTupleKey(coordinate));
      return tuple !== undefined && succeeded(tuple) ? [tuple] : [];
    });
    const probes = successes.flatMap((tuple): ProbeArtifact[] =>
      tuple.observations?.version === 2 &&
      tuple.observations.probe !== undefined
        ? [tuple.observations.probe as ProbeArtifact]
        : [],
    );
    const probeEnabled = state.probe ?? project.checks.probe.enabled;
    const base =
      "combination" in state && state.combination !== undefined
        ? state.combination.base
        : state.id;
    const probeGap: Evidence | ReturnType<typeof notApplicable> | undefined =
      policy === "unsupported"
        ? notApplicable("the probe is not supported for this target")
        : !probeEnabled
          ? state.probe === false || base !== state.id
            ? missing(
                "probe off",
                `set "probe": true on state ${base} in flow ${flow.id}`,
              )
            : missing(
                "probe off",
                "set checks.probe.enabled: true in project.json",
              )
          : probes.length === 0
            ? any.status === "missing"
              ? any
              : missing("probe not executed", recapture)
            : undefined;
    const replay = (
      field: "heldReplay" | "failureReplay",
      label: string,
      value: string,
    ) => {
      if (probeGap !== undefined) return add("network", value, label, probeGap);
      const runs = probes.map((probe) => probe[field]);
      if (
        runs.some(
          (entry) =>
            entry !== undefined && (entry.ran > 0 || (entry.reused ?? 0) > 0),
        )
      )
        return add("network", value, label, observed);
      if (runs.every((entry) => entry !== undefined && entry.queued === 0))
        return add(
          "network",
          value,
          label,
          notApplicable("no probed action sent requests"),
        );
      if (runs.some((entry) => entry === undefined))
        return add(
          "network",
          value,
          label,
          missing("replay not recorded", recaptureVersion),
        );
      const note = runs.flatMap((entry) => entry?.notes ?? [])[0];
      return add(
        "network",
        value,
        label,
        missing(
          "replay did not run",
          `${note === undefined ? "the probe budget ran out before the replay" : `the replay did not run (${note})`}; reduce checks.probe.maxControls (now ${project.checks.probe.maxControls}) or split the state`,
        ),
      );
    };
    replay("heldReplay", "slow network replay", "slow");
    replay("failureReplay", "failure replay", "failure");

    const probeLabel = "probe reached controls";
    if (probeGap !== undefined)
      add("interaction", "probe", probeLabel, probeGap);
    else if (
      probes.every(
        (probe) =>
          probe.results.length === 0 && (probe.candidates ?? []).length === 0,
      )
    )
      add("interaction", "probe", probeLabel, notApplicable("no controls"));
    else if (
      probes.some(
        (probe) =>
          probe.status === "ran" &&
          !probe.results.some((result) => result.status === "not-reached"),
      )
    )
      add("interaction", "probe", probeLabel, observed);
    else
      add(
        "interaction",
        "probe",
        probeLabel,
        probes.some((probe) => probe.status === "timed-out")
          ? missing(
              "probe timed out",
              `raise checks.probe.stateTimeoutMs (now ${project.checks.probe.stateTimeoutMs}) or split the state`,
            )
          : missing(
              "controls not reached",
              `raise checks.probe.maxControls (now ${project.checks.probe.maxControls}) or split the state`,
            ),
      );

    const sweeps = successes.flatMap((tuple) =>
      tuple.observations?.version === 2 &&
      tuple.observations.focusVisible !== undefined
        ? [tuple.observations.focusVisible]
        : [],
    );
    const incomplete = sweeps.find((sweep) => sweep.status !== "ran");
    add(
      "interaction",
      "focus",
      "focus sweep",
      // The focus sweep runs inside the probe pass, at the probed coordinate.
      probeGap?.status === "not-applicable"
        ? probeGap
        : !project.checks.focusVisible.enabled
          ? missing(
              "focus sweep off",
              "set checks.focusVisible.enabled: true in project.json",
            )
          : probeGap !== undefined
            ? probeGap
            : sweeps.some((sweep) => sweep.status === "ran")
              ? observed
              : incomplete !== undefined && "reason" in incomplete
                ? missing(
                    `focus sweep ${incomplete.status}`,
                    `fix what stopped the focus sweep (${incomplete.reason}) and recapture`,
                  )
                : missing("focus sweep not recorded", recaptureVersion),
    );
    const label = stateChainLabel(state);
    return {
      state: state.id,
      ...(label === state.id ? {} : { label }),
      dimensions,
      ...totals(dimensions),
    };
  });

  const declaresData = flow.states.some((state) => state.data !== undefined);
  const data: StateDimension[] = dataStates.map((kind) => {
    const label = `${kind} data`;
    if (!declaresData)
      return {
        kind: "data",
        value: kind,
        label,
        ...notApplicable("the flow declares no data states"),
      };
    const declared = flow.states.filter((state) => state.data === kind);
    if (declared.length === 0)
      return {
        kind: "data",
        value: kind,
        label,
        ...missing(
          "not declared",
          `add a state with "data": "${kind}" to flow ${flow.id}, seeded by a "setup" command`,
        ),
      };
    return {
      kind: "data",
      value: kind,
      label,
      ...evidenceFor(declared.flatMap(coordinatesOf)),
    };
  });

  return {
    flow: flow.id,
    ...(options.runId === undefined
      ? {}
      : { run: { id: options.runId, commit: options.commit ?? "unknown" } }),
    captured: true,
    states,
    data,
    ...totals([...states.flatMap((entry) => entry.dimensions), ...data]),
    missing: gaps(states, data),
  };
}

function gaps(
  states: StateCoverageEntry[],
  data: StateDimension[],
): StateCoverageGap[] {
  const byKey = new Map<string, StateCoverageGap>();
  const record = (dimension: StateDimension, state?: string) => {
    if (dimension.status !== "missing" || dimension.remedy === undefined)
      return;
    const key = `${dimension.label}\u0000${dimension.remedy}`;
    const gap = byKey.get(key) ?? {
      label: dimension.label,
      remedy: dimension.remedy,
      states: [],
    };
    byKey.set(key, gap);
    if (state !== undefined && !gap.states.includes(state))
      gap.states.push(state);
  };
  // Dimension order first (viewport, scheme, ... data), states in flow order.
  const width = Math.max(0, ...states.map((entry) => entry.dimensions.length));
  for (let index = 0; index < width; index += 1)
    for (const entry of states) {
      const dimension = entry.dimensions[index];
      if (dimension !== undefined) record(dimension, entry.state);
    }
  for (const dimension of data) record(dimension);
  return [...byKey.values()];
}

/** A flow with no stored capture: nothing was observed. */
export function uncapturedFlowCoverage(
  flow: Flow,
  reason?: string | undefined,
): FlowStateCoverage {
  return {
    flow: flow.id,
    captured: false,
    states: flow.states.map((state) => ({
      state: state.id,
      dimensions: [],
      observed: 0,
      applicable: 0,
      notApplicable: 0,
      percent: null,
    })),
    data: [],
    observed: 0,
    applicable: 0,
    notApplicable: 0,
    percent: null,
    missing: [
      {
        label: "every state",
        remedy:
          reason === undefined
            ? `idiom capture ${flow.id}`
            : `recapture: ${reason}`,
        states: [],
      },
    ],
  };
}

const coverageDisclaimer =
  "This is coverage of what was reviewed, not a measure of quality";

/** The one line reports and `idiom check` print for a flow. */
export function stateCoverageLine(coverage: FlowStateCoverage): string {
  if (!coverage.captured)
    return `State coverage: not captured yet; run \`idiom capture ${coverage.flow}\`. ${coverageDisclaimer}.`;
  const head = `State coverage: ${coverage.observed} of ${coverage.applicable} applicable dimensions observed${coverage.percent === null ? "" : ` (${coverage.percent}%)`}, ${coverage.notApplicable} not applicable`;
  const labels = [...new Set(coverage.missing.map((gap) => gap.label))];
  if (labels.length === 0) return `${head}. ${coverageDisclaimer}.`;
  const shown = labels.slice(0, 4).join(", ");
  const more = labels.length > 4 ? `, +${labels.length - 4} more` : "";
  return `${head}; not observed: ${shown}${more}. ${coverageDisclaimer}; run \`idiom coverage --states\` for the changes that cover the rest.`;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|");
}

/** The `idiom coverage --states` table, also the MCP text. */
export function renderStateCoverage(summary: StateCoverageSummary): string {
  const lines = [
    "State coverage: which dimensions each flow's latest capture observed. It describes what was reviewed, not a measure of quality; not applicable dimensions are never counted.",
  ];
  for (const flow of summary.flows) {
    lines.push("");
    if (!flow.captured) {
      lines.push(
        `Flow ${flow.flow} — not captured: ${flow.missing[0]?.remedy ?? `idiom capture ${flow.flow}`}`,
      );
      continue;
    }
    const run =
      flow.run === undefined
        ? ""
        : ` — run ${flow.run.id} at ${flow.run.commit.slice(0, 12)}`;
    lines.push(
      `Flow ${flow.flow}${run}: ${flow.observed} of ${flow.applicable} applicable dimensions observed${flow.percent === null ? "" : ` (${flow.percent}%)`}, ${flow.notApplicable} not applicable.`,
      "",
      "| State | Observed | Applicable | % | Not observed |",
      "| --- | --- | --- | --- | --- |",
      ...flow.states.map(
        (entry) =>
          `| ${cell(entry.label ?? entry.state)} | ${entry.observed} | ${entry.applicable} | ${entry.percent === null ? "n/a" : entry.percent} | ${cell(
            entry.dimensions
              .filter((dimension) => dimension.status === "missing")
              .map((dimension) => dimension.label)
              .join(", ") || "none",
          )} |`,
      ),
      "",
      `Data states: ${flow.data
        .map(
          (dimension) =>
            `${dimension.value} ${dimension.status === "not-applicable" ? "n/a" : dimension.status}`,
        )
        .join(
          ", ",
        )}${flow.data.every((d) => d.status === "not-applicable") ? ` (${flow.data[0]?.reason ?? "not applicable"}; add "data" to a state to declare them)` : ""}.`,
    );
    if (flow.missing.length > 0) {
      lines.push("", "To cover:");
      const all = flow.states.length;
      for (const gap of flow.missing)
        lines.push(
          `- ${gap.label} (${gap.states.length === 0 ? "flow" : gap.states.length === all && all > 1 ? "all states" : gap.states.join(", ")}): ${gap.remedy}`,
        );
    }
  }
  return `${lines.join("\n")}\n`;
}
