import { relative } from "node:path";
import {
  type BaseCaptureBatchResult,
  type BaseCaptureResult,
  captureBaseRecords,
  missingScope,
  type SettledComparison,
  settleBaseComparison,
} from "../baseline/base.js";
import {
  type CheckTiming,
  combineCheckTimings,
  type GateTiming,
} from "../capture/timings.js";
import { workingTreeIdentity } from "../changed/git.js";
import { IdiomError } from "../errors.js";
import { type GatePlanOptions, planGate } from "../gate/plan.js";
import {
  describeComparison,
  gatePlanLine,
  renderGatePlan,
} from "../gate/render.js";
import { leaseServer, serverLeaseEligible } from "../gate/server-lease.js";
import type {
  GatePlan,
  GateServer,
  GateSkip,
  GateSkipResult,
} from "../gate/types.js";
import type { Project } from "../schemas/project.js";
import {
  appStartKey,
  type ClearedScope,
  type Condition,
  clearedScopes,
  fromBaseline,
  fromBrokenCoverage,
  fromGateComparison,
  fromRunFailure,
} from "../unattended/condition.js";
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
  timing: GateTiming;
  /** Setup breaks: the app could not start, no usable baseline, broken expectations. */
  conditions: Condition[];
  /** The scopes this gate fully exercised; they clear open conditions. */
  cleared: ClearedScope[];
  /** Where conditions are recorded, and the project's `unattended` config. */
  projectDirectory: string;
  unattended?: Project["unattended"];
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
    // The plan scales its estimate by the same host sample the capture reads.
    dependencies: {
      ...options.gateDependencies,
      readHost:
        options.gateDependencies?.readHost ??
        options.dependencies?.capture?.readHost,
    },
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
  const unsettled = [...execution.baseComparisons].filter(
    ([, entry]) => entry.settled === undefined,
  );
  for (const [flow, entry] of execution.baseComparisons)
    if (entry.settled !== undefined) settled.set(flow, entry.settled);
  // Every unsettled flow's base in one worktree: one install, one server.
  let batch: BaseCaptureBatchResult | undefined;
  let batchError: unknown;
  if (unsettled.length) {
    const signal = options.dependencies?.capture?.signal;
    signal?.throwIfAborted();
    try {
      batch = await captureBaseRecords({
        base: execution.selection.git.resolvedBase,
        project: options.project,
        cwd: options.cwd,
        prod: options.prod,
        ...(plan.probeBudgetMs === undefined
          ? {}
          : { probeBudgetMs: plan.probeBudgetMs }),
        ...(execution.probeDisabled ? { probeDisabled: true } : {}),
        dependencies: options.dependencies,
        flows: unsettled.map(([flow, entry]) => ({
          flow,
          scope: missingScope(entry.resolution.missing),
          probeRegions: execution.scopes.get(flow)
            ? execution.probeRegions.get(flow)
            : undefined,
          cachePath: entry.resolution.cachePath,
        })),
        leaseServer: async (context) => {
          const baseFlows = context.validated.flows
            .map((record) => record.flow)
            .filter((flow) => unsettled.some(([id]) => id === flow.id));
          if (
            !execution.serverLease ||
            !serverLeaseEligible(context.validated.project, baseFlows, {
              production: execution.production,
              reused: false,
            }).eligible
          )
            return undefined;
          const lease = await leaseServer({
            projectDirectory: context.sourceProjectDirectory,
            project: context.validated.project,
            signal: context.signal,
            dependencies: options.dependencies?.capture,
          });
          return { server: lease, stop: lease.stop };
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      batchError = error;
    }
  }
  for (const [flow, entry] of unsettled) {
    const signal = options.dependencies?.capture?.signal;
    const result = await settleBaseComparison({
      resolution: entry.resolution,
      flow,
      configHash: execution.configHash,
      capture: async (): Promise<BaseCaptureResult> => {
        if (batchError !== undefined) throw batchError;
        const captured = batch?.results.get(flow);
        if (captured === undefined)
          throw new IdiomError("the base capture did not run");
        if ("error" in captured) throw captured.error;
        return captured;
      },
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
  const conditions: Condition[] = [];
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
    ...(plan.coverageGap === undefined
      ? {}
      : {
          coverageGap:
            plan.notes.find((note) =>
              note.startsWith("warning: coverage gap:"),
            ) ?? "warning: coverage gap",
        }),
  };
  // One head server for every gated flow, started once and stopped here.
  let lease: Awaited<ReturnType<typeof leaseServer>> | undefined;
  let serverFailed = false;
  if (
    execution.serverLease &&
    options.port === undefined &&
    execution.scopes.size > 0
  ) {
    try {
      lease = await leaseServer({
        projectDirectory: execution.validated.projectDirectory,
        project: execution.validated.project,
        signal: options.dependencies?.capture?.signal,
        dependencies: options.dependencies?.capture,
      });
    } catch (error) {
      const first =
        execution.validated.flows.find(({ flow }) =>
          execution.scopes.has(flow.id),
        )?.flow.id ?? [...execution.scopes.keys()][0];
      const condition =
        first === undefined
          ? undefined
          : fromRunFailure(error, { mode: "gate", flow: first });
      if (condition === undefined) throw error;
      // The leased server is shared: one that cannot start stops the whole gate.
      conditions.push(condition);
      serverFailed = true;
    }
  }
  try {
    for (const { flow } of serverFailed ? [] : execution.validated.flows) {
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
      let result: ChangedCheckResult;
      try {
        result = await checkChanged({
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
          ...(lease === undefined ? {} : { leasedServer: lease }),
          ...(inputIdentity === undefined ? {} : { inputIdentity }),
          gateReport: {
            ...section,
            skippedWork: plan.skippedWork.filter(
              (skip) => skip.flow === flow.id,
            ),
          },
        });
      } catch (error) {
        const condition = fromRunFailure(error, {
          mode: "gate",
          flow: flow.id,
        });
        if (condition === undefined) throw error;
        // The server is shared: one that cannot start stops the whole gate.
        conditions.push(condition);
        break;
      }
      checks.push(...result.checks);
      checkedStates += result.checkedStates;
      findingNameWarning ??= result.findingNameWarning;
    }
  } finally {
    await lease?.stop();
  }
  const cleared: ClearedScope[] = [];
  const checkedEntries = checks.flatMap((entry) =>
    entry.status === "checked" ? [entry] : [],
  );
  for (const [flow, comparison] of Object.entries(comparisons)) {
    if (!checkedEntries.some((entry) => entry.flow === flow)) continue;
    const condition = fromGateComparison({ flow, comparison });
    if (condition !== undefined) conditions.push(condition);
  }
  for (const entry of checkedEntries) {
    const { summary } = entry;
    // A gate's checked scope is partial by design, so only an expired
    // baseline counts here; nightly also refuses one that covers nothing.
    const baseline = fromBaseline({
      mode: "gate",
      flow: entry.flow,
      baseline:
        summary.baseline?.stale === undefined
          ? undefined
          : { stale: summary.baseline.stale },
    });
    if (
      baseline !== undefined &&
      !conditions.some((condition) => condition.key === baseline.key)
    )
      conditions.push(baseline);
    const file = execution.validated.flows.find(
      (record) => record.flow.id === entry.flow,
    )?.file;
    conditions.push(
      ...fromBrokenCoverage({
        mode: "gate",
        flow: entry.flow,
        broken: summary.brokenCoverage,
        flowFile:
          file === undefined
            ? undefined
            : relative(execution.validated.projectDirectory, file),
      }),
    );
    cleared.push(
      ...clearedScopes({
        flow: entry.flow,
        summary,
        legacyColorScheme: execution.validated.project.capture.colorScheme,
        // Only a committed baseline clears baseline:<flow>; a base capture
        // or base cache compares fine but says nothing about the recorded one.
        baselineUsable:
          summary.baseline !== undefined &&
          baseline === undefined &&
          (summary.baseline.source === undefined ||
            summary.baseline.source === "baseline" ||
            summary.baseline.source === "fallback"),
      }),
    );
  }
  if (checkedEntries.length > 0) cleared.push({ key: appStartKey() });
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
    timing: gateTiming({
      combined: combineCheckTimings(timings, performance.now() - started),
      flowTimings: timings,
      lease,
      batch,
      reused: execution.reuseServer,
      comparisons,
    }),
    conditions,
    cleared,
    projectDirectory:
      execution.validated.stateProjectDirectory ??
      execution.validated.projectDirectory,
    ...(execution.validated.project.unattended === undefined
      ? {}
      : { unattended: execution.validated.project.unattended }),
  };
}

/** The gate's phase breakdown from its flows' timings, lease and base batch. */
export function gateTiming(options: {
  combined: CheckTiming;
  flowTimings: CheckTiming[];
  lease?: { buildMs: number; startMs: number } | undefined;
  batch?:
    | Pick<BaseCaptureBatchResult, "ms" | "serverMs" | "servers" | "results">
    | undefined;
  reused: boolean;
  comparisons: GatePlan["comparisons"];
}): GateTiming {
  const { combined } = options;
  const measured = (phase: { status: string; ms: number }) =>
    phase.status === "measured" ? phase.ms : 0;
  const ownServers = options.lease
    ? 0
    : options.flowTimings.filter(
        (timing) => timing.phases.serverStart.status === "measured",
      ).length;
  const ownStartMs = options.lease
    ? 0
    : options.flowTimings.reduce(
        (sum, timing) =>
          sum +
          measured(timing.phases.build) +
          measured(timing.phases.serverStart),
        0,
      );
  const baseServers = options.batch
    ? options.batch.servers ||
      [...options.batch.results.values()].filter(
        (result) => !("error" in result),
      ).length
    : 0;
  const modes = Object.values(options.comparisons).map(
    (comparison) => comparison.mode,
  );
  const baseCapture: GateTiming["gate"]["baseCapture"] = options.batch
    ? "captured"
    : modes.includes("base-cache")
      ? "cached"
      : modes.includes("baseline")
        ? "baseline"
        : modes.length
          ? "skipped"
          : "none";
  const probeMs = measured(combined.phases.probe);
  return {
    ...combined,
    gate: {
      servers: (options.lease ? 1 : ownServers) + baseServers,
      serversReused: options.reused ? 1 : 0,
      serverStartMs: Math.round(
        (options.lease ? options.lease.buildMs + options.lease.startMs : 0) +
          ownStartMs +
          (options.batch?.serverMs ?? 0),
      ),
      baseCaptureMs: options.batch
        ? Math.max(0, options.batch.ms - options.batch.serverMs)
        : 0,
      baseCapture,
      captureMs: Math.max(0, measured(combined.phases.capture) - probeMs),
      probeMs,
      checksMs: measured(combined.phases.checks),
      ...(combined.intermediateWidths
        ? { intermediateWidths: combined.intermediateWidths }
        : {}),
    },
  };
}
