import {
  beginCheckRecording,
  completeCheckRecording,
} from "../agent/check-state.js";
import {
  captureBaseRecord,
  missingScope,
  resolveBaseComparison,
  type SettledComparison,
  settleBaseComparison,
} from "../baseline/base.js";
import { resolveRunBaseline } from "../baseline/compare.js";
import { checksConfigHash } from "../baseline/config-hash.js";
import { resolveCaptureScope } from "../capture/scope.js";
import { collectChanges } from "../changed/git.js";
import {
  type ChangedSelection,
  selectChangedStates,
  stateKey,
} from "../changed/select.js";
import { IdiomError } from "../errors.js";
import { loadRunTuples, resolveStoredRun } from "../review/artifacts.js";
import type { ReviewRunResult } from "../review/run.js";
import { type Flow, isWebFlow } from "../schemas/flow.js";
import {
  productionConfigExample,
  resolveGateConfig,
} from "../schemas/project.js";
import { type ValidationResult, validateProject } from "../validation.js";
import {
  type CheckOptions,
  type CheckSummary,
  checkWithReview,
} from "./check.js";

export type ChangedCheckOptions = Omit<CheckOptions, "flow"> & {
  flow?: string | undefined;
  changed: true | string;
  materializeAllDeterministic?: boolean;
  /**
   * The gate's own comparison per flow (decided within its budget); unset,
   * the default mode resolves and, when needed, captures the base itself.
   */
  comparisonFor?: ((flow: string) => SettledComparison) | undefined;
};
export type ChangedCheckEntry =
  | { flow: string; status: "not-checked"; reason: string }
  | {
      flow: string;
      status: "checked";
      summary: CheckSummary;
      review: ReviewRunResult;
    };
export type ChangedCheckResult = {
  selection: ChangedSelection;
  checks: ChangedCheckEntry[];
  checkedStates: number;
  /** The divergence line, once: every flow in a project yields the same. */
  findingNameWarning?: string | undefined;
};

/** Shared CLI/MCP controller. No run, baseline or hook success is invented for skipped flows. */
export async function checkChanged(
  options: ChangedCheckOptions,
): Promise<ChangedCheckResult> {
  if (options.from !== undefined || options.latest)
    throw new IdiomError(
      "--changed requires fresh capture; cannot combine with --from or --latest",
    );
  if (
    !options.flow &&
    (options.scope?.states !== undefined ||
      options.baseline !== undefined ||
      options.baselineFile !== undefined)
  )
    throw new IdiomError(
      "name a flow before using --states, --baseline or --baseline-file with --changed",
    );
  const selectors = [
    options.baseline !== undefined,
    options.sinceBaseline === true,
    options.baselineFile !== undefined,
  ].filter(Boolean).length;
  if (selectors > 1 || (options.all && selectors))
    throw new IdiomError(
      "--all, --baseline, --since-baseline and --baseline-file are mutually exclusive",
    );
  const validated = await validateProject(options);
  const recording = await beginCheckRecording({
    ...options,
    flow: options.flow ?? "changed",
  });
  const changes = await collectChanges(
    validated.projectDirectory,
    options.changed === true ? undefined : options.changed,
  );
  const selection = await selectChangedStates(
    validated.projectDirectory,
    validated.flows.map((record) => record.flow),
    changes,
  );
  options.dependencies?.capture?.signal?.throwIfAborted();
  // Validate every candidate scope and every selected baseline before starting any server.
  const scopes = new Map<string, NonNullable<CheckOptions["scope"]>>();
  for (const { flow } of validated.flows) {
    if (
      !options.flow &&
      !selection.selected.some((state) => state.flow === flow.id)
    )
      continue;
    const requested = resolveCaptureScope({
      project: validated.project,
      flow,
      scope: options.scope,
    });
    const allowed = new Set(requested.selected.map((tuple) => tuple.state.id));
    selection.selected = selection.selected.filter(
      (state) => state.flow !== flow.id || allowed.has(state.state),
    );
    const states = selection.selected
      .filter((state) => state.flow === flow.id)
      .map((state) => state.state);
    if (!states.length) continue;
    const scope = { ...options.scope, states: states.join(",") };
    resolveCaptureScope({ project: validated.project, flow, scope });
    scopes.set(flow.id, scope);
    const productionRequested =
      options.prod === true ||
      (isWebFlow(flow) && flow.server === "production");
    if (productionRequested && !isWebFlow(flow))
      throw new IdiomError(
        "production capture is only available for web flows",
      );
    if (
      productionRequested &&
      validated.project.server.production === undefined
    )
      throw new IdiomError(
        `production capture requires server.production; ${productionConfigExample}`,
      );
    if (
      !options.all &&
      options.baseline === undefined &&
      (options.sinceBaseline || options.baselineFile !== undefined)
    ) {
      const { selected, path } = await resolveRunBaseline({
        validated,
        flow,
        baselineFile: options.baselineFile,
        cwd: options.cwd,
      });
      if (!selected)
        throw new IdiomError(
          `no recorded baseline for "${flow.id}" reachable from HEAD in ${path}; run idiom baseline record ${flow.id}`,
        );
    } else if (options.baseline !== undefined) {
      await loadRunTuples(
        validated,
        flow,
        resolveStoredRun(validated.projectDirectory, options.baseline),
      );
    }
  }
  const selectedKeys = new Set(selection.selected.map(stateKey));
  selection.skipped = selection.candidates.filter(
    (state) => !selectedKeys.has(stateKey(state)),
  );
  const checks: ChangedCheckEntry[] = [];
  const {
    changed: _changed,
    flow: _flow,
    comparisonFor,
    ...checkOptions
  } = options;
  // Default mode judges findings against the build's base: present there,
  // a finding is pre-existing, whatever the recorded baseline says.
  const baseMode =
    !options.all &&
    options.baseline === undefined &&
    !options.sinceBaseline &&
    options.baselineFile === undefined;
  let checkedStates = 0;
  const combined = {
    selectedTuples: 0,
    successfulTuples: 0,
    failedTuples: [] as NonNullable<
      NonNullable<CheckSummary["coverage"]>["failedTuples"]
    >,
    unresolvedTuples: [] as NonNullable<
      NonNullable<CheckSummary["coverage"]>["unresolvedTuples"]
    >,
  };
  for (const { flow } of validated.flows) {
    const scope = scopes.get(flow.id);
    if (!scope) {
      checks.push({
        flow: flow.id,
        status: "not-checked",
        reason:
          "no affected states after changed-file mapping and explicit scope",
      });
      continue;
    }
    options.dependencies?.capture?.signal?.throwIfAborted();
    const settled = !baseMode
      ? undefined
      : comparisonFor !== undefined
        ? comparisonFor(flow.id)
        : await changedBaseComparison(options, validated, flow, scope, {
            base: changes.resolvedBase,
          });
    const checked = await checkWithReview({
      ...checkOptions,
      flow: flow.id,
      scope,
      bootstrapBaseline: false,
      recordAgentCheck: false,
      ...(settled?.comparison === undefined
        ? {}
        : { comparison: settled.comparison }),
      ...(settled?.unavailable === undefined
        ? {}
        : { comparisonUnavailable: settled.unavailable }),
    });
    checks.push({ flow: flow.id, status: "checked", ...checked });
    const coverage = checked.summary.coverage;
    if (coverage) {
      const failed = [
        ...(coverage.failedTuples ?? []),
        ...(coverage.unresolvedTuples ?? []),
      ];
      checkedStates += coverage.states.filter(
        (state) => !failed.some((tuple) => tuple.state === state),
      ).length;
      combined.selectedTuples += coverage.selectedTuples;
      combined.successfulTuples += coverage.successfulTuples;
      combined.failedTuples.push(...(coverage.failedTuples ?? []));
      combined.unresolvedTuples.push(...(coverage.unresolvedTuples ?? []));
    } else
      combined.unresolvedTuples.push({
        state: "unknown",
        viewport: "unknown",
        colorScheme: "light",
      });
  }
  await completeCheckRecording(
    recording,
    combined,
    options.dependencies?.capture?.signal,
  );
  const findingNameWarning = checks
    .map((entry) =>
      entry.status === "checked" ? entry.summary.findingNameWarning : undefined,
    )
    .find((warning) => warning !== undefined);
  return {
    selection,
    checks,
    checkedStates,
    ...(findingNameWarning === undefined ? {} : { findingNameWarning }),
  };
}

/** `check --changed` has no budget: it captures the base whenever needed. */
async function changedBaseComparison(
  options: ChangedCheckOptions,
  validated: ValidationResult,
  flow: Flow,
  scope: NonNullable<CheckOptions["scope"]>,
  { base }: { base: string },
): Promise<SettledComparison> {
  const resolution = await resolveBaseComparison({
    validated,
    flow: flow.id,
    base,
    tuples: resolveCaptureScope({
      project: validated.project,
      flow,
      scope,
    }).selected.map((tuple) => ({
      state: tuple.state.id,
      viewport: tuple.viewport.name,
      scheme: tuple.colorScheme,
    })),
    nonUi: resolveGateConfig(validated.project).nonUi,
  });
  return settleBaseComparison({
    resolution,
    flow: flow.id,
    configHash: checksConfigHash(validated.project.checks),
    capture: () =>
      captureBaseRecord({
        base,
        flow: flow.id,
        project: options.project,
        cwd: options.cwd,
        scope: missingScope(resolution.missing),
        prod: options.prod,
        probeBudgetMs: options.probeBudgetMs,
        probeDisabled: options.probeDisabled,
        probeRegions: options.probeRegions,
        cachePath: resolution.cachePath,
        dependencies: options.dependencies,
      }),
    signal: options.dependencies?.capture?.signal,
  });
}

export function renderChangedSelection(
  result: Pick<ChangedCheckResult, "selection" | "checkedStates">,
): string {
  const { selection } = result;
  return [
    `idiom check --changed: checked ${result.checkedStates} of ${selection.candidates.length} states (${selection.selected.length} selected).`,
    `Base: ${selection.git.resolvedBase} (${selection.git.baseReason})`,
    ...(selection.git.fallbackReason ? [selection.git.fallbackReason] : []),
    ...selection.files.map(
      (file) =>
        `${JSON.stringify(file.path)}: ${file.kind} — ${file.reason}${selection.fallbackFiles.includes(file.path) ? " (fallback: all states)" : ""}; routes: ${file.routes.join(", ") || "none"}; states: ${file.states.map((state) => `${state.flow}/${state.state}`).join(", ") || "none"}${!selection.fallbackFiles.includes(file.path) && file.uncertainties?.length ? `; also included: ${file.uncertainties.join("; ")}` : ""}`,
    ),
    ...selection.skipped.map(
      (state) => `${state.flow}/${state.state}: not checked`,
    ),
    ...(selection.selected.length
      ? []
      : ["No affected states selected; no capture or review was run."]),
  ].join("\n");
}
