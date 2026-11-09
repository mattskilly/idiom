import {
  captureBaseRecord,
  missingScope,
  type SettledComparison,
  settleBaseComparison,
} from "../baseline/base.js";
import { type CheckTiming, combineCheckTimings } from "../capture/timings.js";
import { workingTreeIdentity } from "../changed/git.js";
import { IdiomError } from "../errors.js";
import { type GatePlanOptions, planGate } from "../gate/plan.js";
import {
  describeComparison,
  gatePlanLine,
  renderGatePlan,
} from "../gate/render.js";
import type {
  GatePlan,
  GateServer,
  GateSkip,
  GateSkipResult,
} from "../gate/types.js";
import {
  type ChangedCheckEntry,
  type ChangedCheckOptions,
  type ChangedCheckResult,
  checkChanged,
} from "./check-changed.js";

export type GateCheckOptions = Omit<ChangedCheckOptions, "changed"> & {
  changed?: true | string | undefined;
  budgetMs?: number | undefined;
  reuseServer?: boolean | undefined;
  /** Stop after planning: no server, browser or capture. */
  planOnly?: boolean | undefined;
  /** Receives the plan lines before any server starts (the CLI's stderr). */
  onPlan?: ((lines: string[]) => void) | undefined;
  gateDependencies?: GatePlanOptions["dependencies"];
};

export type GateRunResult = {
  skipped: false;
  plan: GatePlan;
  skippedWork: GateSkip[];
  estimateMs: number;
  budgetMs: number;
  server: GateServer;
  /** Per flow: what findings were judged against, with base capture time. */
  comparisons: GatePlan["comparisons"];
  changed: ChangedCheckResult;
  timing: CheckTiming;
};
export type GatePlanOnlyResult = {
  skipped: false;
  planOnly: true;
  plan: GatePlan;
};
export type GateResult = GateSkipResult | GatePlanOnlyResult | GateRunResult;

/**
 * `idiom check --gate`: plan the cheapest check that still covers the
 * change, say what it costs and what it leaves out, then run it through the
 * changed-check controller one flow at a time.
 */
export async function checkGate(
  options: GateCheckOptions,
): Promise<GateResult> {
  const started = performance.now();
  if (options.from !== undefined || options.latest)
    throw new IdiomError(
      "--gate requires fresh capture; cannot combine with --from or --latest",
    );
  if (
    options.all ||
    options.baseline !== undefined ||
    options.baselineFile !== undefined ||
    options.sinceBaseline
  )
    throw new IdiomError(
      "--gate chooses its own comparison; drop --all, --baseline, --since-baseline and --baseline-file",
    );
  const planned = await planGate({
    project: options.project,
    cwd: options.cwd,
    flow: options.flow,
    base: options.changed === true ? undefined : options.changed,
    scope: options.scope,
    prod: options.prod,
    probeBudgetMs: options.probeBudgetMs,
    budgetMs: options.budgetMs,
    reuseServer: options.reuseServer,
    dependencies: options.gateDependencies,
  });
  if (planned.skipped) return planned;
  const { execution, ...plan } = planned;
  options.onPlan?.(renderGatePlan(plan));
  if (options.planOnly) return { skipped: false, planOnly: true, plan };
  options.dependencies?.capture?.signal?.throwIfAborted();
  const inputIdentity = execution.production
    ? await workingTreeIdentity(execution.selection.git.repository)
    : undefined;
  // Capture the base before the head: a failure here degrades the flow to
  // the fallback comparison with a warning, never fails the gate.
  const comparisons: GatePlan["comparisons"] = { ...plan.comparisons };
  const settled = new Map<string, SettledComparison>();
  for (const [flow, entry] of execution.baseComparisons) {
    if (entry.settled !== undefined) {
      settled.set(flow, entry.settled);
      continue;
    }
    const signal = options.dependencies?.capture?.signal;
    signal?.throwIfAborted();
    const scope = execution.scopes.get(flow);
    const result = await settleBaseComparison({
      resolution: entry.resolution,
      flow,
      configHash: execution.configHash,
      capture: () =>
        captureBaseRecord({
          base: entry.resolution.base,
          flow,
          project: options.project,
          cwd: options.cwd,
          scope: missingScope(entry.resolution.missing),
          prod: options.prod,
          ...(plan.probeBudgetMs === undefined
            ? {}
            : { probeBudgetMs: plan.probeBudgetMs }),
          ...(execution.probeDisabled ? { probeDisabled: true } : {}),
          probeRegions: scope ? execution.probeRegions.get(flow) : undefined,
          cachePath: entry.resolution.cachePath,
          dependencies: options.dependencies,
        }),
      signal,
    });
    settled.set(flow, result);
    const previous = comparisons[flow];
    if (previous !== undefined)
      comparisons[flow] = {
        ...previous,
        ...(result.comparison?.source === "base-capture"
          ? {}
          : {
              mode: result.comparison === undefined ? "none" : "fallback",
              ...(result.comparison?.baselineCommit === undefined
                ? {}
                : {
                    baselineCommit: result.comparison.baselineCommit,
                    behindBase: result.comparison.behindBase,
                  }),
            }),
        ...(result.captureMs === undefined
          ? {}
          : { baseCaptureMs: result.captureMs }),
      };
    if (result.warning !== undefined) options.onPlan?.([result.warning]);
    else if (comparisons[flow] !== undefined)
      options.onPlan?.([describeComparison(flow, comparisons[flow])]);
  }
  const checks: ChangedCheckEntry[] = [];
  let checkedStates = 0;
  let findingNameWarning: string | undefined;
  const {
    budgetMs: _budget,
    onPlan: _onPlan,
    gateDependencies: _dependencies,
    reuseServer: _reuse,
    planOnly: _planOnly,
    ...shared
  } = options;
  const section = {
    plan: gatePlanLine(plan),
    skippedWork: plan.skippedWork,
    estimateMs: plan.estimate.totalMs,
    budgetMs: plan.budgetMs,
  };
  for (const { flow } of execution.validated.flows) {
    const scope = execution.scopes.get(flow.id);
    if (!scope) {
      if (options.flow === undefined) continue;
      checks.push({
        flow: flow.id,
        status: "not-checked",
        reason: "no affected states after the gate's plan",
      });
      continue;
    }
    options.dependencies?.capture?.signal?.throwIfAborted();
    const result = await checkChanged({
      ...shared,
      flow: flow.id,
      changed: execution.selection.git.resolvedBase,
      scope,
      comparisonFor: (id) =>
        settled.get(id) ?? {
          unavailable: "no base comparison was planned for this flow",
        },
      ...(plan.probeBudgetMs === undefined
        ? {}
        : { probeBudgetMs: plan.probeBudgetMs }),
      ...(execution.probeDisabled ? { probeDisabled: true } : {}),
      probeRegions: execution.probeRegions.get(flow.id),
      // Explicit either way: a rejected reuse must not fall back to server.reuse.
      reuseServer: execution.reuseServer,
      ...(inputIdentity === undefined ? {} : { inputIdentity }),
      gateReport: {
        ...section,
        skippedWork: plan.skippedWork.filter((skip) => skip.flow === flow.id),
      },
    });
    checks.push(...result.checks);
    checkedStates += result.checkedStates;
    findingNameWarning ??= result.findingNameWarning;
  }
  const timings = checks.flatMap((entry) =>
    entry.status === "checked" && entry.summary.timing
      ? [entry.summary.timing]
      : [],
  );
  const changed: ChangedCheckResult = {
    selection: execution.selection,
    checks,
    checkedStates,
    ...(findingNameWarning === undefined ? {} : { findingNameWarning }),
  };
  return {
    skipped: false,
    plan,
    skippedWork: plan.skippedWork,
    estimateMs: plan.estimate.totalMs,
    budgetMs: plan.budgetMs,
    server: plan.server,
    comparisons,
    changed,
    timing: combineCheckTimings(timings, performance.now() - started),
  };
}
