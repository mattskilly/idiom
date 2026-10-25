import { resolve } from "node:path";
import { recordBaseline } from "../baseline/record.js";
import { IdiomError } from "../errors.js";
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
  dependencies?: ReviewDependencies | undefined;
}) {
  const validated = await validateProject(options);
  if (options.flow === undefined && validated.flows.length !== 1)
    throw new IdiomError(
      `baseline accept needs a flow; choose one of: ${validated.flows.map(({ flow }) => flow.id).join(", ")}`,
    );
  const flow = validated.flows[0]?.flow;
  if (flow === undefined) throw new IdiomError(`unknown flow ${options.flow}`);
  const { out, ...reviewOptions } = options;
  const result = await runReview({
    ...reviewOptions,
    flow: options.flow ?? flow.id,
    deterministicOnly: true,
  });
  return recordBaseline({
    validated,
    flow,
    runDirectory: result.runDirectory,
    out:
      out === undefined
        ? undefined
        : resolve(options.cwd ?? process.cwd(), out),
  });
}
export function renderBaselineRecord(
  result: Awaited<ReturnType<typeof baselineRecordCommand>>,
): string {
  return `Recorded baseline for ${result.flow} at ${result.commit.slice(0, 12)}: ${result.findingCount} finding(s) across ${result.tupleCount} tuple(s) → ${result.path}${result.pixelCount === 0 ? ". Commit this file." : `; ${result.pixelCount} pixel baseline(s) → ${result.pixelDirectory}. Commit both.`}`;
}
