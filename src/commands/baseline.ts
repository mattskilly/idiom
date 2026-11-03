import { resolve } from "node:path";
import { recordBaseline } from "../baseline/record.js";
import { IdiomError } from "../errors.js";
import { preflightRun, validateForRun } from "../preflight.js";
import { type ReviewDependencies, runReview } from "../review/run.js";

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
