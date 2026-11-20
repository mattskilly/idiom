import { readFile } from "node:fs/promises";
import { advanceBaselines, advanceFailed } from "../baseline/advance.js";
import {
  type ClusterInputs,
  clusterInputsFromCheck,
} from "../commands/check.js";
import { checkGate } from "../commands/check-gate.js";
import { learnHarvestCommand } from "../commands/learn-harvest.js";
import type { ResolvedFiling } from "../commands/nightly.js";
import { RunFailure } from "../errors.js";
import { severityGateEligible } from "../findings/gate.js";
import { fileNightly, type NightlyOutcome } from "../nightly/file.js";
import type { ReviewDependencies } from "../review/run.js";
import { findingSchema } from "../schemas/finding.js";
import { conditionLine } from "../unattended/condition.js";
import type { Merge } from "./merges.js";
import type { WatchOutcome } from "./state.js";
import { prepareTree } from "./tree.js";

export type WatchContext = {
  /** The repository top level of the primary checkout. */
  repository: string;
  /** The primary project: the ledger, harvest and learned records live here. */
  primaryProject: string;
  /** The project's path inside the repository ("" at the root). */
  projectRelative: string;
  watchDir: string;
  filing: ResolvedFiling;
  signal: AbortSignal;
  environment: NodeJS.ProcessEnv;
  review?: ReviewDependencies | undefined;
};

export type GateStepResult = {
  gate: WatchOutcome["gate"];
  inputs: ClusterInputs[];
};

export type WatchSteps = {
  prepare: (
    merge: Merge,
    context: WatchContext,
  ) => Promise<{ treeProject: string }>;
  gate: (
    merge: Merge,
    context: WatchContext & { treeProject: string },
  ) => Promise<GateStepResult>;
  file: (
    inputs: ClusterInputs[],
    context: WatchContext & { treeProject: string },
  ) => Promise<NightlyOutcome[]>;
  advance: (
    merge: Merge,
    context: WatchContext & { treeProject: string },
  ) => Promise<WatchOutcome["baseline"]>;
  harvest: (context: WatchContext) => Promise<WatchOutcome["harvest"]>;
};

const message = (error: unknown) =>
  error instanceof RunFailure
    ? error.headline
    : error instanceof Error
      ? (error.message.split("\n")[0] ?? error.message)
      : String(error);

const withSignal = (context: WatchContext): ReviewDependencies => ({
  ...context.review,
  capture: { ...context.review?.capture, signal: context.signal },
});

export const defaultWatchSteps: WatchSteps = {
  prepare: (merge, context) =>
    prepareTree({
      repository: context.repository,
      watchDir: context.watchDir,
      commit: merge.commit,
      projectRelative: context.projectRelative,
      signal: context.signal,
      environment: context.environment,
    }),

  async gate(merge, context) {
    let result: Awaited<ReturnType<typeof checkGate>>;
    try {
      result = await checkGate({
        project: context.treeProject,
        cwd: context.treeProject,
        changed: merge.parent,
        // A developer's dev server on the configured port serves other code.
        reuseServer: false,
        onPlan: () => {},
        dependencies: withSignal(context),
      });
    } catch (error) {
      if (context.signal.aborted || !(error instanceof RunFailure)) throw error;
      return {
        gate: {
          status: "failed",
          newFindings: 0,
          eligible: 0,
          reason: error.headline,
        },
        inputs: [],
      };
    }
    if (result.skipped)
      return {
        gate: {
          status: "skipped",
          newFindings: 0,
          eligible: 0,
          reason: result.line,
        },
        inputs: [],
      };
    if ("planOnly" in result)
      return {
        gate: { status: "skipped", newFindings: 0, eligible: 0 },
        inputs: [],
      };
    const inputs: ClusterInputs[] = [];
    let newFindings = 0;
    let eligible = 0;
    let deferred = false;
    let notRecorded: string | undefined;
    for (const entry of result.changed.checks) {
      if (entry.status !== "checked") continue;
      const { summary, review } = entry;
      const findings = findingSchema
        .array()
        .parse(JSON.parse(await readFile(review.findingsPath, "utf8")));
      inputs.push(clusterInputsFromCheck(summary, review, findings));
      newFindings += summary.findings.length;
      eligible += summary.findings.filter((finding) =>
        severityGateEligible(finding, context.filing.severity),
      ).length;
      if (summary.verdict === "deferred") deferred = true;
      notRecorded ??= summary.baselineNotRecorded?.message;
    }
    // A setup break (no usable baseline, a broken expectation, the app not
    // starting) makes the CLI gate exit 2, so it is never a clean merge here.
    // Its findings are still filed, as nightly files beside its conditions.
    // TODO(file-323): report these through reportConditions({ mode: "watch" }).
    const conditions = result.conditions.map(conditionLine).join("; ");
    const status: WatchOutcome["gate"]["status"] =
      notRecorded !== undefined
        ? "failed"
        : deferred
          ? "deferred"
          : eligible > 0
            ? "findings"
            : conditions !== ""
              ? "failed"
              : "clean";
    const reason = [
      conditions,
      notRecorded ??
        (deferred ? "host busy; some states were not reviewed" : ""),
    ]
      .filter((part) => part !== "")
      .join("; ");
    return {
      gate: {
        status,
        newFindings,
        eligible,
        ...(reason === "" ? {} : { reason }),
      },
      inputs,
    };
  },

  async file(inputs, context) {
    const { filing } = context;
    const result = await fileNightly({
      project: context.treeProject,
      cwd: context.treeProject,
      ledgerPath: filing.ledgerPath,
      inputs,
      severity: filing.severity,
      labels: filing.labels,
      sink: filing.sink.sink,
    });
    return result.outcomes;
  },

  async advance(merge, context) {
    const result = await advanceBaselines({
      project: context.treeProject,
      cwd: context.treeProject,
      target: merge.commit,
      dependencies: { review: withSignal(context) },
    });
    const flows = (status: string) =>
      result.flows
        .filter((flow) => flow.status === status)
        .map((flow) => flow.flow);
    if (advanceFailed(result))
      return {
        status: "failed",
        flows: flows("failed"),
        reason: result.flows
          .filter((flow) => flow.status === "failed")
          .map((flow) => `${flow.flow}: ${flow.reason ?? "failed"}`)
          .join("; "),
      };
    for (const status of ["advanced", "current", "superseded"] as const)
      if (flows(status).length > 0) return { status, flows: flows(status) };
    return { status: "absent", flows: flows("absent") };
  },

  async harvest(context) {
    const result = await learnHarvestCommand({
      project: context.primaryProject,
      cwd: context.primaryProject,
      dependencies: {
        harvest: { environment: context.environment },
      },
    });
    const sources = [result.sources.autobuild, result.sources.pullRequests];
    const unavailable = sources.filter(
      (source) => source.status === "unavailable",
    );
    if (unavailable.length === sources.length)
      return {
        status: "unavailable",
        reason:
          unavailable[0]?.status === "unavailable"
            ? unavailable[0].reason
            : "no source",
      };
    return { status: "recorded", recorded: result.recorded.length };
  },
};

/** Whether the gate's verdict lets the baseline advance to this merge. */
const advances = (gate: WatchOutcome["gate"]) =>
  gate.status === "clean" || gate.status === "skipped";

/**
 * One merge: prepare the tree, gate it against its first parent, file new
 * findings, advance the baseline when clean, then harvest corrections. An
 * abort propagates; any other failure is recorded and stops the chain.
 * Harvest never decides a merge's success.
 */
export async function processMerge(
  merge: Merge,
  context: WatchContext,
  steps: WatchSteps = defaultWatchSteps,
  now: () => Date = () => new Date(),
): Promise<WatchOutcome> {
  const started = now();
  const outcome: WatchOutcome = {
    commit: merge.commit,
    parent: merge.parent,
    subject: merge.subject,
    startedAt: started.toISOString(),
    finishedAt: started.toISOString(),
    ms: 0,
    gate: { status: "skipped", newFindings: 0, eligible: 0 },
    tickets: [],
    baseline: { status: "not-advanced", reason: "not reached" },
    harvest: { status: "off" },
  };
  const aborted = (error: unknown) =>
    context.signal.aborted ||
    (error as { name?: unknown } | undefined)?.name === "AbortError";
  try {
    const { treeProject } = await steps.prepare(merge, context);
    const inTree = { ...context, treeProject };
    const gated = await steps.gate(merge, inTree);
    outcome.gate = gated.gate;
    if (gated.gate.status === "failed")
      outcome.error = `gate failed: ${gated.gate.reason ?? "unknown"}`;
    if (gated.inputs.some((input) => input.records.length > 0)) {
      const filed = await steps.file(gated.inputs, inTree);
      outcome.tickets = filed.map((item) => ({
        kind: item.kind,
        ...(item.ticket === undefined ? {} : { ticket: item.ticket }),
        findingIds: item.findingIds,
      }));
      const errors = filed.filter((item) => item.kind === "error");
      if (errors.length > 0)
        outcome.error ??= `${errors.length} filing(s) failed: ${errors[0]?.message ?? "unknown"}`;
    }
    if (advances(gated.gate))
      outcome.baseline = await steps.advance(merge, inTree);
    else
      outcome.baseline = {
        status: "not-advanced",
        reason: gated.gate.status,
      };
  } catch (error) {
    if (aborted(error)) throw error;
    outcome.error = message(error);
  }
  if (outcome.error === undefined) {
    try {
      outcome.harvest = await steps.harvest(context);
    } catch (error) {
      if (aborted(error)) throw error;
      outcome.harvest = { status: "error", reason: message(error) };
    }
  }
  const finished = now();
  outcome.finishedAt = finished.toISOString();
  outcome.ms = finished.getTime() - started.getTime();
  return outcome;
}
