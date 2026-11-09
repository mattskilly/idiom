import { resolve } from "node:path";
import { captureBaseRecord } from "../baseline/base.js";
import { baseCachePath } from "../baseline/base-cache.js";
import { recordBaseline } from "../baseline/record.js";
import {
  baselineDirectory,
  baselinePath,
  writeBaselineRecord,
} from "../baseline/store.js";
import { defaultBranch, type GitRead, readGit } from "../changed/git.js";
import { IdiomError } from "../errors.js";
import { preflightRun, validateForRun } from "../preflight.js";
import { type ReviewDependencies, runReview } from "../review/run.js";
import { validateProject } from "../validation.js";

export async function baselineRecordCommand(options: {
  flow?: string | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  prod?: boolean | undefined;
  port?: number | undefined;
  from?: string | undefined;
  latest?: boolean | undefined;
  out?: string | undefined;
  /** Ignore the primary checkout's finding names (throwaway worktrees). */
  isolatedRegistry?: boolean | undefined;
  dependencies?: ReviewDependencies | undefined;
}) {
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
  const { out, ...reviewOptions } = options;
  const result = await runReview({
    ...reviewOptions,
    flow: options.flow ?? flow.id,
    deterministicOnly: true,
  });
  const recorded = await recordBaseline({
    validated,
    flow,
    runDirectory: result.runDirectory,
    out:
      out === undefined
        ? undefined
        : resolve(options.cwd ?? process.cwd(), out),
  });
  return result.findingNameWarning === undefined
    ? recorded
    : { ...recorded, findingNameWarning: result.findingNameWarning };
}
export function renderBaselineRecord(
  result: Awaited<ReturnType<typeof baselineRecordCommand>>,
): string {
  return `Recorded baseline for ${result.flow} at ${result.commit.slice(0, 12)}: ${result.findingCount} finding(s) across ${result.tupleCount} tuple(s) → ${result.path}${result.pixelCount === 0 ? ". Commit this file." : `; ${result.pixelCount} pixel baseline(s) → ${result.pixelDirectory}. Commit both.`}`;
}

export type BaselineAdvanceResult = {
  flow: string;
  target: string;
  commit: string;
  findingCount: number;
  tupleCount: number;
  failedTuples: string[];
  cachePath: string;
  /** With --commit-file: the committed baseline written. */
  path?: string | undefined;
};

/**
 * `idiom baseline advance`: capture the target branch's tip in its own
 * worktree and record it as the base the gate compares with. Because it
 * records the target branch's commit, every later build's base reaches it,
 * squash merges included.
 */
export async function baselineAdvanceCommand(options: {
  flow?: string | undefined;
  target?: string | undefined;
  commitFile?: boolean | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  prod?: boolean | undefined;
  dependencies?: ReviewDependencies | undefined;
  git?: GitRead | undefined;
}): Promise<BaselineAdvanceResult> {
  const git = options.git ?? readGit;
  const validated = await validateProject({
    project: options.project,
    flow: options.flow,
    cwd: options.cwd,
  });
  if (options.flow === undefined && validated.flows.length !== 1)
    throw new IdiomError(
      `baseline advance needs a flow; choose one of: ${validated.flows.map(({ flow }) => flow.id).join(", ")}`,
    );
  const flow = validated.flows[0]?.flow;
  if (flow === undefined) throw new IdiomError(`unknown flow ${options.flow}`);
  const repository = (
    await git(validated.projectDirectory, ["rev-parse", "--show-toplevel"])
  ).trim();
  const target = options.target ?? (await defaultBranch(repository, git));
  if (target === undefined)
    throw new IdiomError(
      "baseline advance found no target branch (no remote HEAD, main or master); pass --target <ref>",
    );
  let commit: string;
  try {
    commit = (
      await git(repository, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${target}^{commit}`,
      ])
    ).trim();
  } catch {
    throw new IdiomError(
      `cannot resolve --target ${JSON.stringify(target)} to a local commit; fetch it and retry`,
    );
  }
  const stateDirectory =
    validated.stateProjectDirectory ?? validated.projectDirectory;
  const cachePath = await baseCachePath(stateDirectory, flow.id, git);
  const captured = await captureBaseRecord({
    base: commit,
    flow: flow.id,
    project: options.project,
    cwd: options.cwd,
    scope: {},
    prod: options.prod,
    cachePath,
    dependencies: options.dependencies,
  });
  const record = captured.record;
  if (record === undefined || record.tuples.length === 0)
    throw new IdiomError(
      `baseline advance captured no tuple of ${flow.id} at ${target} ${commit.slice(0, 12)}${captured.failedTupleKeys.length ? ` (failed: ${captured.failedTupleKeys.join(", ")})` : ""}`,
    );
  let path: string | undefined;
  if (options.commitFile === true) {
    if (captured.failedTupleKeys.length > 0)
      throw new IdiomError(
        `baseline advance refused --commit-file: ${captured.failedTupleKeys.length} tuple(s) failed (${captured.failedTupleKeys.join(", ")}); the base cache holds the ${record.tuples.length} that succeeded`,
      );
    path = baselinePath(
      baselineDirectory(stateDirectory, validated.project),
      flow.id,
    );
    await writeBaselineRecord(path, flow.id, record);
  }
  return {
    flow: flow.id,
    target,
    commit,
    findingCount: record.tuples.reduce(
      (sum, tuple) => sum + tuple.findings.length,
      0,
    ),
    tupleCount: record.tuples.length,
    failedTuples: captured.failedTupleKeys,
    cachePath,
    ...(path === undefined ? {} : { path }),
  };
}

export function renderBaselineAdvance(result: BaselineAdvanceResult): string {
  return `Advanced ${result.flow} to ${result.target} ${result.commit.slice(0, 12)}: ${result.findingCount} finding(s) across ${result.tupleCount} tuple(s) → base cache${result.failedTuples.length ? ` (failed, not recorded: ${result.failedTuples.join(", ")})` : ""}${result.path === undefined ? "" : `; committed baseline → ${result.path}. Commit it.`}`;
}
