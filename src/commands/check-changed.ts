import {
  beginCheckRecording,
  completeCheckRecording,
} from "../agent/check-state.js";
import { resolveRunBaseline } from "../baseline/compare.js";
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
import { isWebFlow } from "../schemas/flow.js";
import { productionConfigExample } from "../schemas/project.js";
import { validateProject } from "../validation.js";
import {
  type CheckOptions,
  type CheckSummary,
  checkWithReview,
} from "./check.js";

export type ChangedCheckOptions = Omit<CheckOptions, "flow"> & {
  flow?: string | undefined;
  changed: true | string;
  materializeAllDeterministic?: boolean;
  captureFailureIsError?: boolean;
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
    if (!options.all && options.baseline === undefined) {
      const { selected, path } = await resolveRunBaseline({
        validated,
        flow,
        baselineFile: options.baselineFile,
        cwd: options.cwd,
      });
      if (
        !selected &&
        (options.sinceBaseline || options.baselineFile !== undefined)
      )
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
  const { changed: _changed, flow: _flow, ...checkOptions } = options;
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
    const checked = await checkWithReview({
      ...checkOptions,
      flow: flow.id,
      scope,
      bootstrapBaseline: false,
      recordAgentCheck: false,
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
  return { selection, checks, checkedStates };
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
