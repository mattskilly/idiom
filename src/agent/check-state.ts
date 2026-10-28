import {
  type CheckMetadata,
  createBudget,
  type HookContext,
  publishCheck,
  readState,
  resolveContext,
  snapshot,
  type UISnapshot,
} from "../../hooks/lib.mjs";
import type { CaptureScope } from "../capture/scope.js";
import { resolveProjectArgument } from "../project.js";
import type { ReportCoverage } from "../report/coverage.js";
import { validateProjectConfiguration } from "../validation.js";

export type CheckRecording = {
  context: HookContext;
  start: UISnapshot;
  metadata: CheckMetadata;
  overflow: boolean;
  paths: string[];
};

/** Best effort bookkeeping; never changes check results or protocol output. */
export async function beginCheckRecording(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow: string;
  scope?: CaptureScope | undefined;
}): Promise<CheckRecording | undefined> {
  const budget = createBudget();
  try {
    const validated = await validateProjectConfiguration(options);
    if (validated.project.agent?.hooks === false) return undefined;
    const context = await resolveContext(
      resolveProjectArgument(validated.projectDirectory, options.cwd),
      budget,
    );
    if (!context?.globs.length) return undefined;
    const state = await readState(context, budget);
    const metadata = {
      startedAt: performance.timeOrigin + performance.now(),
      editId: state.editId,
      flow: options.flow,
      scope: options.scope,
    };
    const paths = state.pending.map((entry) => entry.path);
    const overflow = state.overflow === true;
    const start = await snapshot(context, budget, paths, overflow);
    return { context, start, metadata, overflow, paths };
  } catch {
    return undefined;
  } finally {
    budget.close();
  }
}

export async function completeCheckRecording(
  recording: CheckRecording | undefined,
  coverage:
    | Pick<
        ReportCoverage,
        | "selectedTuples"
        | "successfulTuples"
        | "failedTuples"
        | "unresolvedTuples"
      >
    | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !recording ||
    signal?.aborted ||
    !coverage ||
    !Number.isSafeInteger(coverage.selectedTuples) ||
    coverage.selectedTuples <= 0 ||
    coverage.successfulTuples !== coverage.selectedTuples ||
    (coverage.failedTuples?.length ?? 0) > 0 ||
    (coverage.unresolvedTuples?.length ?? 0) > 0
  )
    return;
  const budget = createBudget();
  try {
    const context = await resolveContext(recording.context.root, budget);
    if (!context || context.identity !== recording.context.identity) return;
    const end = await snapshot(
      context,
      budget,
      recording.paths,
      recording.overflow,
    );
    await publishCheck(
      context,
      recording.start,
      end,
      recording.metadata,
      budget,
      signal,
    );
  } catch {
    // A check can succeed even when hook state cannot be saved.
  } finally {
    budget.close();
  }
}
