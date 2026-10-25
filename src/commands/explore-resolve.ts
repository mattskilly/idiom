import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expectedStatusByState,
  selectColorSchemes,
  selectViewports,
} from "../capture/resolve.js";
import type { CheckTuple } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import { loadExplorationRun } from "../explore/artifacts.js";
import {
  resolveExplorationChoice,
  resolveExplorationNone,
} from "../explore/resolve.js";
import { loadCaptureRun } from "../review/artifacts.js";
import { readUnruledDecisions } from "../rulings/artifacts.js";
import { normalizeExplorationKey } from "../schemas/exploration.js";
import { loadProjectContext, validateNamedFlow } from "../validation.js";
import type { ExploreDependencies, ExploreResult } from "./explore.js";

function tupleKey(tuple: {
  state: string;
  viewport: string;
  colorScheme?: string | undefined;
}): string {
  return `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? "light"}`;
}

function assertGrid(label: string, tuples: CheckTuple[], expected: string[]) {
  const actual = tuples.map(tupleKey);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    tuples.some((tuple) => tuple.failure !== undefined)
  )
    throw new IdiomError(
      `exploration run is incomplete: ${label} does not contain the complete successful capture grid`,
    );
}

async function assertLegacySteeringIsUnambiguous(
  projectDirectory: string,
  question: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(join(projectDirectory, ".idiom", "reports"));
  } catch {
    return;
  }
  const target = normalizeExplorationKey(question);
  for (const entry of entries) {
    try {
      const decisions = await readUnruledDecisions(
        join(projectDirectory, ".idiom", "reports", entry),
      );
      if (
        decisions.some(
          (decision) => normalizeExplorationKey(decision.question) === target,
        )
      )
        throw new IdiomError(
          "this legacy exploration may have been steered by a reviewed decision, but its stored artifact does not identify that decision; rerun exploration",
        );
    } catch (error) {
      if (
        error instanceof IdiomError &&
        error.message.startsWith("this legacy")
      )
        throw error;
    }
  }
}

export async function exploreResolveCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  runId: string;
  candidate?: string | undefined;
  none?: boolean | undefined;
  reason?: string | undefined;
  yes?: boolean | undefined;
  repairs?: boolean | undefined;
  dependencies?: ExploreDependencies | undefined;
  write?: ((message: string) => void) | undefined;
}): Promise<ExploreResult> {
  if ((options.candidate === undefined) === (options.none !== true))
    throw new IdiomError(
      "provide exactly one of --candidate <A|B|C> or --none",
    );
  const reason = options.reason?.trim() ?? "";
  if (reason === "")
    throw new IdiomError("--reason <text> is required and must not be blank");
  if (options.yes !== true)
    throw new IdiomError(
      "--yes is required to resolve an exploration non-interactively",
    );
  const label = options.candidate?.trim().toUpperCase();
  if (label !== undefined && !["A", "B", "C"].includes(label))
    throw new IdiomError("--candidate must be A, B, or C");
  if (options.none === true && options.repairs === true)
    throw new IdiomError("--repairs cannot be used with --none");

  const context = await loadProjectContext(options);
  const stored = await loadExplorationRun({
    projectDirectory: context.projectDirectory,
    runId: options.runId,
  });
  const flow = await validateNamedFlow(context, stored.manifest.flow);
  const state = flow.flow.states.find(
    (candidate) => candidate.id === stored.manifest.state,
  );
  if (state === undefined)
    throw new IdiomError(
      `stored exploration state ${JSON.stringify(stored.manifest.state)} is not declared by flow ${JSON.stringify(flow.flow.id)}`,
    );
  if (stored.manifest.steering === undefined)
    await assertLegacySteeringIsUnambiguous(
      context.projectDirectory,
      stored.manifest.question,
    );

  const viewports = selectViewports(context.project, flow.flow);
  const colorSchemes = selectColorSchemes(context.project, flow.flow);
  const expected = viewports.flatMap((viewport) =>
    colorSchemes.map((colorScheme) =>
      tupleKey({ state: state.id, viewport: viewport.name, colorScheme }),
    ),
  );
  const loadedOptions = (runDirectory: string) => ({
    runDirectory,
    expectedFlow: flow.flow.id,
    expectedStatusByState: expectedStatusByState(flow.flow),
    stateOrder: [state.id],
    viewportOrder: viewports.map((viewport) => viewport.name),
    colorSchemeOrder: colorSchemes,
    legacyColorScheme: context.project.capture.colorScheme,
  });
  const baseline = await loadCaptureRun(loadedOptions(stored.runDirectory));
  assertGrid("baseline", baseline.tuples, expected);
  const loadedCandidates = await Promise.all(
    stored.candidates.map(async (candidate) => {
      const runDirectory = stored.capturePath(candidate);
      const capture = await loadCaptureRun(loadedOptions(runDirectory));
      assertGrid(`candidate ${candidate.label}`, capture.tuples, expected);
      if (capture.commit !== baseline.commit)
        throw new IdiomError(
          `exploration run is incomplete: candidate ${candidate.label} was captured from a different source commit than the baseline`,
        );
      return { candidate, runDirectory, tuples: capture.tuples };
    }),
  );

  if (options.none === true)
    return resolveExplorationNone({
      projectDirectory: context.projectDirectory,
      project: context.project,
      stored,
      reason,
      clock: options.dependencies?.clock,
    });
  const winner = loadedCandidates.find(
    (item) => item.candidate.label === label,
  );
  if (winner === undefined)
    throw new IdiomError(`exploration candidate ${label} is unavailable`);
  return resolveExplorationChoice({
    projectDirectory: context.projectDirectory,
    project: context.project,
    stored,
    baseline: baseline.tuples,
    candidate: winner.candidate,
    winnerRun: winner.runDirectory,
    winner: winner.tuples,
    reason,
    repairs: options.repairs === true,
    confirm: async () => true,
    write: options.write,
    clock: options.dependencies?.clock,
    gitTopology: options.dependencies?.gitTopology,
    decide: options.dependencies?.decide,
  });
}
