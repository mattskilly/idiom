import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AdvanceDependencies,
  advanceBaselines,
  type BaselineAdvanceResult,
} from "../baseline/advance.js";
import { recordBaseline } from "../baseline/record.js";
import {
  composeResumedRun,
  findResumableRun,
  type ResumableRun,
  resumePlan,
  resumeRefusal,
} from "../baseline/resume.js";
import { snapshotSource } from "../capture/resolve.js";
import {
  runCapture,
  selectedCaptureCoordinates,
  toggleIdentity,
} from "../capture/run.js";
import { loadRunRecord } from "../capture/run-record.js";
import {
  renderSlowTuples,
  type SlowTuple,
  slowTupleSteps,
} from "../capture/timings.js";
import { IdiomError } from "../errors.js";
import { capturePredicateIdentity } from "../findings/settings.js";
import { preflightRun, validateForRun } from "../preflight.js";
import { type ReviewDependencies, runReview } from "../review/run.js";
import type { Flow } from "../schemas/flow.js";
import { isWebFlow } from "../schemas/flow.js";
import type { ValidationResult } from "../validation.js";
import { IDIOM_VERSION } from "../version.js";

/** The review's per-tuple check time, keyed `state\0viewport\0scheme`. */
async function checkTupleMs(
  runDirectory: string,
): Promise<Map<string, number>> {
  try {
    const parsed = JSON.parse(
      await readFile(join(runDirectory, "checks-timings.json"), "utf8"),
    ) as {
      tuples?: Array<{
        state: string;
        viewport: string;
        colorScheme: string;
        ms: number;
      }>;
    };
    return new Map(
      (parsed.tuples ?? []).map((tuple) => [
        `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme}`,
        tuple.ms,
      ]),
    );
  } catch {
    return new Map();
  }
}

const reportsOf = (validated: ValidationResult) =>
  join(validated.projectDirectory, ".idiom", "reports");

/**
 * A fresh capture that stopped keeps its finished tuples: name them and
 * how to continue. The error keeps its type, so exit codes do not change.
 */
async function withResumeHint(
  error: unknown,
  validated: ValidationResult,
  flow: Flow,
): Promise<unknown> {
  if (!(error instanceof Error)) return error;
  let newest: ResumableRun | undefined;
  try {
    newest = await findResumableRun(reportsOf(validated), flow.id);
  } catch {
    return error;
  }
  const kept = newest.record.finalTuples?.length ?? 0;
  if (newest.record.status !== "interrupted" || kept === 0) return error;
  error.message = `${error.message}\n${kept} of ${newest.record.selected.length} tuples are kept in run ${newest.record.runId}; continue with: idiom baseline record ${flow.id} --resume`;
  return error;
}

/**
 * Continue the newest interrupted capture of `flow`: capture only what it
 * left into a hidden partial run, then compose one complete run.
 */
async function resumeCapture(options: {
  validated: ValidationResult;
  flow: Flow;
  prod?: boolean | undefined;
  port?: number | undefined;
  dependencies?: ReviewDependencies | undefined;
}): Promise<{
  runId: string;
  resumed: { from: string; carried: number; captured: number };
}> {
  const { validated, flow } = options;
  const reports = reportsOf(validated);
  const interrupted = await findResumableRun(reports, flow.id);
  const id = interrupted.record.runId ?? interrupted.directory;
  const source = await snapshotSource(validated.projectDirectory, {
    excludedPaths: [reports],
    ignoreDirty: validated.project.baselines?.ignoreDirty,
  });
  const refusal = resumeRefusal(interrupted.record, {
    commit: source.commit,
    dirty: source.dirty,
    captureSettingsIdentity: capturePredicateIdentity(validated.project, flow),
    idiomVersion: IDIOM_VERSION,
    production:
      options.prod === true ||
      (isWebFlow(flow) && flow.server === "production"),
    toggleIdentity: toggleIdentity(flow),
    selected: selectedCaptureCoordinates({ project: validated.project, flow }),
  });
  if (refusal !== undefined)
    throw new IdiomError(
      `cannot resume run ${id}: ${refusal}; run idiom baseline record ${flow.id} for a fresh capture`,
    );
  const plan = await resumePlan(interrupted, flow);
  let partial: ResumableRun | undefined;
  const out =
    plan.capture === undefined
      ? undefined
      : join(reports, `.resume-${id}-${randomUUID()}`);
  try {
    if (plan.capture !== undefined && out !== undefined) {
      try {
        await runCapture({
          projectDirectory: validated.projectDirectory,
          project: validated.project,
          flow,
          prod: options.prod,
          port: options.port,
          out,
          resume: plan.capture,
          dependencies: options.dependencies?.capture,
        });
      } catch (error) {
        if (error instanceof Error)
          error.message = `${error.message}\nThe remaining ${plan.remaining.length} tuple(s) did not finish; run ${id} is unchanged and can still be resumed.`;
        throw error;
      }
      const record = await loadRunRecord(out);
      if (record === undefined)
        throw new IdiomError(
          `the resumed capture left no run record in ${out}`,
        );
      partial = { directory: out, record };
    }
    const composed = await composeResumedRun({
      reports,
      flow,
      interrupted,
      partial,
      carried: plan.carried,
    });
    return {
      runId: composed.record.runId ?? composed.directory,
      resumed: {
        from: id,
        carried: plan.carried.length,
        captured: plan.remaining.length,
      },
    };
  } finally {
    if (out !== undefined) await rm(out, { recursive: true, force: true });
  }
}

export async function baselineRecordCommand(options: {
  flow?: string | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  prod?: boolean | undefined;
  port?: number | undefined;
  from?: string | undefined;
  latest?: boolean | undefined;
  out?: string | undefined;
  /** Continue the newest interrupted capture of the flow (`--resume`). */
  resume?: boolean | undefined;
  /** Ignore the primary checkout's finding names (throwaway worktrees). */
  isolatedRegistry?: boolean | undefined;
  dependencies?: ReviewDependencies | undefined;
}) {
  if (
    options.resume === true &&
    (options.from !== undefined || options.latest === true)
  )
    throw new IdiomError("--resume cannot be combined with --from or --latest");
  const validated = await validateForRun(options);
  if (options.flow === undefined && validated.flows.length !== 1)
    throw new IdiomError(
      `baseline accept needs a flow; choose one of: ${validated.flows.map(({ flow }) => flow.id).join(", ")}`,
    );
  const flow = validated.flows[0]?.flow;
  if (flow === undefined) throw new IdiomError(`unknown flow ${options.flow}`);
  await preflightRun({
    validated,
    baseline:
      options.from === undefined && options.latest !== true
        ? "record-from-fresh-capture"
        : "none",
    allHint: false,
    capture:
      options.from === undefined && options.latest !== true
        ? { prod: options.prod }
        : undefined,
    isolatedRegistry: options.isolatedRegistry,
  });
  const { out, resume: _resume, ...reviewOptions } = options;
  const fresh = options.from === undefined && options.latest !== true;
  const resumed =
    options.resume === true
      ? await resumeCapture({
          validated,
          flow,
          prod: options.prod,
          port: options.port,
          dependencies: options.dependencies,
        })
      : undefined;
  const result = await runReview({
    ...reviewOptions,
    ...(resumed === undefined ? {} : { from: resumed.runId, prod: undefined }),
    flow: options.flow ?? flow.id,
    deterministicOnly: true,
  }).catch(async (error: unknown) => {
    throw fresh && resumed === undefined
      ? await withResumeHint(error, validated, flow)
      : error;
  });
  const slowTuples: SlowTuple[] = slowTupleSteps(
    result.scope?.timings,
    await checkTupleMs(result.runDirectory),
  );
  const recorded = await recordBaseline({
    validated,
    flow,
    runDirectory: result.runDirectory,
    out:
      out === undefined
        ? undefined
        : resolve(options.cwd ?? process.cwd(), out),
  });
  return {
    ...recorded,
    timing: { slowTuples },
    ...(resumed === undefined ? {} : { resumed: resumed.resumed }),
    ...(result.findingNameWarning === undefined
      ? {}
      : { findingNameWarning: result.findingNameWarning }),
  };
}
export function renderBaselineRecord(
  result: Awaited<ReturnType<typeof baselineRecordCommand>>,
): string {
  const resumed =
    result.resumed === undefined
      ? ""
      : `Resumed run ${result.resumed.from}: kept ${result.resumed.carried} tuple(s), captured ${result.resumed.captured}.\n`;
  const budget = (result.stateBudgetFailures ?? []).map(
    (failure) =>
      `\n${failure.message.replace(/^state /, "State ")}; its ${failure.tuples} tuple(s) were not recorded.`,
  );
  return `${resumed}Recorded baseline for ${result.flow} at ${result.commit.slice(0, 12)}: ${result.findingCount} finding(s) across ${result.tupleCount} tuple(s) → ${result.path}${result.pixelCount === 0 ? ". Commit this file." : `; ${result.pixelCount} pixel baseline(s) → ${result.pixelDirectory}. Commit both.`}${budget.join("")}`;
}

/** The slow-tuple block a text-mode `baseline record` prints on stderr. */
export function renderBaselineTiming(
  result: Awaited<ReturnType<typeof baselineRecordCommand>>,
): string {
  return renderSlowTuples(result.timing?.slowTuples ?? []);
}

export type {
  BaselineAdvanceResult,
  FlowAdvance,
} from "../baseline/advance.js";
export { advanceFailed } from "../baseline/advance.js";

/**
 * `idiom baseline advance`: capture the target branch's tip in its own
 * worktree and record it as the base the gate compares with, for the given
 * flow or every flow that needs it. Because it records the target branch's
 * commit, every later build's base reaches it, squash merges included.
 */
export async function baselineAdvanceCommand(options: {
  flow?: string | undefined;
  target?: string | undefined;
  commitFile?: boolean | undefined;
  fetch?: boolean | undefined;
  waitMs?: number | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  prod?: boolean | undefined;
  dependencies?: ReviewDependencies | undefined;
  advance?: Omit<AdvanceDependencies, "review"> | undefined;
}): Promise<BaselineAdvanceResult> {
  return advanceBaselines({
    flow: options.flow,
    target: options.target,
    commitFile: options.commitFile,
    fetch: options.fetch,
    waitMs: options.waitMs,
    project: options.project,
    cwd: options.cwd,
    prod: options.prod,
    dependencies: { ...options.advance, review: options.dependencies },
  });
}

const short = (commit: string | undefined) => (commit ?? "").slice(0, 12);

export function renderBaselineAdvance(result: BaselineAdvanceResult): string {
  const lines = result.flows.map((flow) => {
    switch (flow.status) {
      case "advanced":
        return `advanced ${flow.flow} to ${result.target} ${short(result.commit)}: ${flow.findingCount ?? 0} finding(s) across ${flow.tupleCount ?? 0} tuple(s) ${flow.reason === "from the base cache" ? "from the base cache" : "→ base cache"}${flow.path === undefined ? "" : `; committed baseline → ${flow.path}. Commit it.`}`;
      case "current":
        return `current ${flow.flow} at ${short(result.commit)}: the stored baseline already covers it`;
      case "superseded":
        return `superseded ${flow.flow}: baseline ${short(flow.supersededBy)} is newer than ${short(result.commit)}; left unchanged`;
      case "absent":
        return `absent ${flow.flow}: ${flow.reason ?? `not on ${result.target} yet`}`;
      case "failed":
        return `FAILED ${flow.flow} at ${short(result.commit)}: ${flow.reason ?? "capture failed"}; ${flow.previous === undefined ? "no baseline recorded yet" : `kept baseline ${short(flow.previous)}`}`;
    }
    return "";
  });
  if (result.flows.length === 0) lines.push("No flows to advance.");
  return lines.join("\n");
}

/** One stderr line per failed flow: what a CI log or finalize record shows. */
export function advanceFailureLines(result: BaselineAdvanceResult): string[] {
  return result.flows
    .filter((flow) => flow.status === "failed")
    .map(
      (flow) =>
        `idiom: baseline advance failed for ${flow.flow} at ${short(result.commit)}: ${flow.reason ?? "capture failed"}; the previous baseline is unchanged`,
    );
}
