import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  expectedStatusByState,
  selectColorSchemes,
  snapshotSource,
} from "../capture/resolve.js";
import type { CaptureDependencies } from "../capture/run.js";
import { runCapture } from "../capture/run.js";
import type { SourceIdentity } from "../capture/types.js";
import type { ClaudeCodeRunner } from "../critique/claude-code.js";
import { IdiomError } from "../errors.js";
import type { AnthropicExplorationClient } from "../explore/anthropic.js";
import { loadExplorationRun } from "../explore/artifacts.js";
import { loadExplorationContext } from "../explore/context.js";
import {
  parseCandidatesWithRepair,
  parseRefinementWithRepair,
} from "../explore/output.js";
import { createExplorationAdapter } from "../explore/provider.js";
import { writeExplorationReport } from "../explore/report.js";
import { resolveExplorationChoice } from "../explore/resolve.js";
import {
  defaultExplorationPrompts,
  type ExplorationPrompts,
  ExplorationSession,
} from "../explore/session.js";
import type {
  CandidateRequest,
  ExplorationAdapter,
  RefinementRequest,
  RenderedCandidate,
} from "../explore/types.js";
import {
  CandidateDistinctnessError,
  validateDistinctCandidates,
  validateRenderedCandidate,
} from "../explore/validate.js";
import {
  applyExplorationEdits,
  createExplorationWorkspace,
  type ExplorationWorkspace,
  readExplorationEditSources,
} from "../explore/workspace.js";
import { loadCaptureRun } from "../review/artifacts.js";
import type { RulingConfirmation } from "../rulings/record.js";
import {
  type ExplorationCandidate,
  normalizeExplorationKey,
} from "../schemas/exploration.js";
import type { RulingResolution } from "../schemas/ruling.js";
import type { GitTopology } from "../verify/baseline.js";
import type { DecideDependencies } from "./decide.js";

async function defaultConfirmation(): Promise<boolean> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return /^(?:y|yes)$/i.test(
      (await readline.question("Record this ruling? [y/N] ")).trim(),
    );
  } finally {
    readline.close();
  }
}

export type ExploreDependencies = {
  adapter?: ExplorationAdapter | undefined;
  capture?: CaptureDependencies | undefined;
  runCapture?: typeof runCapture | undefined;
  workspace?: typeof createExplorationWorkspace | undefined;
  prompts?: ExplorationPrompts | undefined;
  confirm?: RulingConfirmation | undefined;
  clock?: (() => Date) | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  claudeCodeRunner?: ClaudeCodeRunner | undefined;
  anthropicClient?: AnthropicExplorationClient | undefined;
  gitTopology?: GitTopology | undefined;
  decide?: DecideDependencies | undefined;
  hasTTY?: (() => boolean) | undefined;
};

export type ExploreResult = {
  outcome: "pending" | "none" | "cancelled" | "rule-only" | "rule-plus-tickets";
  runDirectory?: string | undefined;
  reportPath?: string | undefined;
  ruling?: RulingResolution | undefined;
  ticketCount?: number | undefined;
};

function runName(now: Date, flow: string, state: string): string {
  return `${now.toISOString().replaceAll(":", "-").replaceAll(".", "-")}-explore-${flow}-${state}`;
}

function loadedOptions(
  context: Awaited<ReturnType<typeof loadExplorationContext>>,
  runDirectory: string,
) {
  return {
    runDirectory,
    expectedFlow: context.flow.id,
    expectedStatusByState: expectedStatusByState(context.flow),
    stateOrder: [context.state.id],
    viewportOrder:
      context.flow.viewports ??
      context.project.viewports.map((viewport) => viewport.name),
    colorSchemeOrder: selectColorSchemes(context.project, context.flow),
    legacyColorScheme: context.project.capture.colorScheme,
  };
}

export async function exploreCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow: string;
  state: string;
  question?: string | undefined;
  decision?: string | undefined;
  dependencies?: ExploreDependencies | undefined;
  write?: ((message: string) => void) | undefined;
}): Promise<ExploreResult> {
  const dependencies = options.dependencies;
  const context = await loadExplorationContext({
    ...options,
    gitTopology: dependencies?.gitTopology,
  });
  const adapter =
    dependencies?.adapter ??
    createExplorationAdapter({
      model: context.project.model,
      environment: dependencies?.environment,
      claudeCodeRunner: dependencies?.claudeCodeRunner,
      anthropicClient: dependencies?.anthropicClient,
    });

  // Availability is the only operation allowed before this point to contact a
  // model. It intentionally precedes source snapshots, capture output, and temp roots.
  await adapter.preflight();

  const capture = dependencies?.runCapture ?? runCapture;
  const sourceSnapshot =
    dependencies?.capture?.snapshotSource ?? snapshotSource;
  const source: SourceIdentity = await sourceSnapshot(
    context.projectDirectory,
    {},
  );
  const now = (dependencies?.clock ?? (() => new Date()))();
  const requestedRun = join(
    context.projectDirectory,
    ".idiom",
    "reports",
    runName(now, context.flow.id, context.state.id),
  );
  const baselineCapture = await capture({
    projectDirectory: context.projectDirectory,
    project: context.project,
    flow: context.flow,
    out: requestedRun,
    tuples: context.tuples,
    dependencies: {
      ...dependencies?.capture,
      snapshotSource: async () => source,
    },
  });
  if (baselineCapture.counts.failed > 0)
    throw new IdiomError(
      `baseline exploration capture failed ${baselineCapture.counts.failed} declared tuple(s)`,
    );
  const runDirectory = resolve(baselineCapture.runDirectory);
  const baseline = await loadCaptureRun(loadedOptions(context, runDirectory));
  const createWorkspace = dependencies?.workspace ?? createExplorationWorkspace;
  let workspace: ExplorationWorkspace | undefined;
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted = signal;
    void workspace?.cleanup();
  };
  const sigint = () => onSignal("SIGINT");
  const sigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);

  try {
    workspace = await createWorkspace(context.projectDirectory);
    const evidenceFiles = baseline.tuples.flatMap((tuple) =>
      tuple.screenshotPath === undefined
        ? []
        : [join(runDirectory, tuple.screenshotPath)],
    );
    evidenceFiles.push(
      ...context.references.flatMap((reference) =>
        reference.kind === "image" ? [reference.readPath] : [],
      ),
    );
    const staged = await workspace.stageEvidence(evidenceFiles);
    const evidence = {
      mirrorRoot: workspace.mirrorBase,
      readablePaths: [...workspace.readablePaths, ...staged],
      baselineTuples: baseline.tuples,
      runDirectory,
    };
    const permittedReferenceLabels = context.references.map(
      (reference) => reference.label,
    );
    const proposeConformingCandidates = async (request: CandidateRequest) => {
      const initial = await adapter.proposeCandidates(request);
      return parseCandidatesWithRepair({
        evidence: request.evidence,
        initial: { candidates: initial },
        permittedReferenceLabels,
        repair: async (issues) => ({
          candidates: await adapter.proposeCandidates({
            context: request.context,
            evidence: request.evidence,
            rejected: {
              candidate: initial[0] as ExplorationCandidate,
              issues,
            },
          }),
        }),
      });
    };
    const refineConformingCandidate = async (request: RefinementRequest) => {
      const initial = await adapter.refineCandidate(request);
      return parseRefinementWithRepair({
        evidence: request.evidence,
        initial: { refinement: initial },
        permittedReferenceLabels,
        repair: async (issues) => ({
          refinement: await adapter.refineCandidate({
            context: request.context,
            evidence: request.evidence,
            candidate: request.candidate,
            instruction: request.instruction,
            rejected: { refinement: initial, issues },
          }),
        }),
      });
    };
    let candidates = await proposeConformingCandidates({ context, evidence });
    const repaired = new Set<number>();
    const removeCandidate = async (label: string) => {
      const candidateWorkspace = `candidate-${label.toLowerCase()}`;
      await Promise.all([
        rm(join(runDirectory, "candidates", candidateWorkspace), {
          recursive: true,
          force: true,
        }),
        rm(
          join(
            (workspace as ExplorationWorkspace).root,
            `runtime-${candidateWorkspace}`,
          ),
          {
            recursive: true,
            force: true,
          },
        ),
        rm(
          join(
            (workspace as ExplorationWorkspace).root,
            `mirror-${candidateWorkspace}`,
          ),
          {
            recursive: true,
            force: true,
          },
        ),
      ]);
    };

    const render = async (
      candidate: ExplorationCandidate,
      _index: number,
      suffix = "",
      bases?: { runtime?: string; mirror?: string },
      edits = candidate.edits,
    ): Promise<RenderedCandidate> => {
      const label = `candidate-${candidate.label.toLowerCase()}${suffix}`;
      const directories = await (
        workspace as ExplorationWorkspace
      ).createCandidate(label, bases);
      const generatedContentSources = await readExplorationEditSources({
        mirrorDirectory: directories.mirrorDirectory,
        edits,
      });
      await applyExplorationEdits({ ...directories, edits });
      const completedContentSources = await readExplorationEditSources({
        mirrorDirectory: directories.mirrorDirectory,
        edits,
      });
      const completedContentByPath = new Map(
        completedContentSources.map((source) => [source.path, source.source]),
      );
      const output = join(runDirectory, "candidates", label);
      await mkdir(join(runDirectory, "candidates"), { recursive: true });
      const result = await capture({
        projectDirectory: directories.cloneDirectory,
        project: context.project,
        flow: context.flow,
        out: output,
        tuples: context.tuples,
        dependencies: {
          ...dependencies?.capture,
          snapshotSource: async () => source,
        },
      });
      if (result.counts.failed > 0)
        throw new IdiomError(
          `${candidate.label} failed ${result.counts.failed} declared capture tuple(s)`,
        );
      const loaded = await loadCaptureRun(
        loadedOptions(context, result.runDirectory),
      );
      await validateRenderedCandidate({
        candidate,
        edits,
        baselineRun: runDirectory,
        baseline: baseline.tuples,
        candidateRun: result.runDirectory,
        candidateTuples: loaded.tuples,
        generatedContentSources: generatedContentSources.map((source) => {
          const after = completedContentByPath.get(source.path);
          if (after === undefined)
            throw new IdiomError(
              `missing completed exploration source ${source.path}`,
            );
          return { path: source.path, before: source.source, after };
        }),
      });
      return {
        candidate,
        ...directories,
        runDirectory: result.runDirectory,
        tuples: loaded.tuples,
        ...(suffix === "-refined" ? { refined: true } : {}),
      };
    };

    const renderWithRepair = async (
      index: number,
    ): Promise<RenderedCandidate> => {
      const candidate = candidates[index];
      if (candidate === undefined)
        throw new IdiomError(`missing exploration candidate ${index + 1}`);
      try {
        return await render(candidate, index);
      } catch (error) {
        if (repaired.has(index)) throw error;
        repaired.add(index);
        await removeCandidate(candidate.label);
        const replacements = await proposeConformingCandidates({
          context,
          evidence,
          rejected: {
            candidate,
            issues: [error instanceof Error ? error.message : String(error)],
          },
        });
        const replacement = replacements[index];
        if (replacement === undefined) throw error;
        candidates = candidates.map((item, candidateIndex) =>
          candidateIndex === index
            ? { ...replacement, label: candidate.label }
            : item,
        );
        return render(candidates[index] as ExplorationCandidate, index);
      }
    };

    const rendered: RenderedCandidate[] = [];
    for (let index = 0; index < candidates.length; index += 1)
      rendered.push(await renderWithRepair(index));
    try {
      await validateDistinctCandidates(rendered);
    } catch (error) {
      if (!(error instanceof CandidateDistinctnessError)) throw error;
      const index = error.candidateIndex;
      const current = candidates[index];
      if (current === undefined || repaired.has(index)) throw error;
      repaired.add(index);
      const rejectedRun = rendered[index]?.runDirectory;
      if (rejectedRun === undefined) throw error;
      await removeCandidate(current.label);
      const replacements = await proposeConformingCandidates({
        context,
        evidence,
        rejected: {
          candidate: current,
          issues: [error instanceof Error ? error.message : String(error)],
        },
      });
      candidates[index] = {
        ...(replacements[index] as ExplorationCandidate),
        label: current.label,
      };
      rendered[index] = await render(
        candidates[index] as ExplorationCandidate,
        index,
      );
      await validateDistinctCandidates(rendered);
    }

    let report = await writeExplorationReport(runDirectory, {
      flow: context.flow.id,
      state: context.state.id,
      question: context.question,
      baselineRun: runDirectory,
      baseline: baseline.tuples,
      candidates: rendered,
      ...(context.decision === undefined
        ? {}
        : {
            steering: {
              decision: context.decision.id,
              fingerprint: context.decision.fingerprint,
              choiceKey: context.decision.choiceKey,
            },
          }),
    });
    options.write?.(`Comparison: ${report.htmlPath}`);
    for (const item of rendered)
      options.write?.(`${item.candidate.label}: ${item.candidate.direction}`);

    const promptCapable =
      dependencies?.hasTTY?.() ??
      (dependencies?.prompts !== undefined
        ? true
        : stdin.isTTY === true && stdout.isTTY === true);
    if (!promptCapable) {
      const runId = basename(runDirectory);
      options.write?.(`Exploration ${runId} is ready for a deferred choice.`);
      options.write?.(
        `Record it with: idiom explore resolve ${runId} --candidate <A|B|C> --reason <text> --yes (or use --none instead of --candidate).`,
      );
      return {
        outcome: "pending",
        runDirectory,
        reportPath: report.htmlPath,
      };
    }

    const prompts = dependencies?.prompts ?? defaultExplorationPrompts;
    const session = new ExplorationSession(candidates);
    const selected = session.select(await prompts.choose(candidates));
    if (selected === undefined) {
      await rm(runDirectory, { recursive: true, force: true });
      return { outcome: "none" };
    }
    let winner = rendered.find(
      (item) => item.candidate.label === selected.label,
    );
    if (winner === undefined)
      throw new IdiomError("selected candidate has no rendered evidence");
    const refinementInstruction = await prompts.refinement(selected);
    if (refinementInstruction !== undefined) {
      const instruction = session.useRefinement(refinementInstruction);
      const refinementEvidencePaths = winner.tuples.flatMap((tuple) =>
        tuple.screenshotPath === undefined
          ? []
          : [join(winner?.runDirectory ?? "", tuple.screenshotPath)],
      );
      const stagedRefinement = await workspace.stageEvidence(
        refinementEvidencePaths,
        winner.mirrorDirectory,
        "selected",
      );
      const refinementEvidence = {
        ...evidence,
        mirrorRoot: winner.mirrorDirectory,
        readablePaths: [
          ...evidence.readablePaths.map((path) =>
            path.replace(
              workspace?.mirrorBase ?? "",
              winner?.mirrorDirectory ?? "",
            ),
          ),
          ...stagedRefinement,
        ],
      };
      let refinement = await refineConformingCandidate({
        context,
        evidence: refinementEvidence,
        candidate: selected,
        instruction,
      });
      const refinedCandidate: ExplorationCandidate = {
        label: selected.label,
        ...refinement,
      };
      try {
        winner = await render(
          refinedCandidate,
          candidates.indexOf(selected),
          "-refined",
          { runtime: winner.cloneDirectory, mirror: winner.mirrorDirectory },
          refinement.edits,
        );
      } catch (error) {
        await removeCandidate(`${selected.label}-refined`);
        refinement = await refineConformingCandidate({
          context,
          evidence: refinementEvidence,
          candidate: selected,
          instruction,
          rejected: {
            refinement,
            issues: [error instanceof Error ? error.message : String(error)],
          },
        });
        const repairedCandidate: ExplorationCandidate = {
          label: selected.label,
          ...refinement,
        };
        const originalWinner = rendered.find(
          (item) => item.candidate.label === selected.label,
        );
        if (originalWinner === undefined) throw error;
        winner = await render(
          repairedCandidate,
          candidates.indexOf(selected),
          "-refined",
          {
            runtime: originalWinner.cloneDirectory,
            mirror: originalWinner.mirrorDirectory,
          },
          refinement.edits,
        );
      }
      report = await writeExplorationReport(runDirectory, {
        flow: context.flow.id,
        state: context.state.id,
        question: context.question,
        baselineRun: runDirectory,
        baseline: baseline.tuples,
        candidates: [...rendered, winner],
        selected: selected.label,
        refined: winner.candidate.direction,
        ...(context.decision === undefined
          ? {}
          : {
              steering: {
                decision: context.decision.id,
                fingerprint: context.decision.fingerprint,
                choiceKey: context.decision.choiceKey,
              },
            }),
      });
    }
    const reason = (await prompts.reason(winner.candidate.reason)).trim();
    if (reason === "") throw new IdiomError("ruling reason must not be blank");
    const stored = await loadExplorationRun({
      projectDirectory: context.projectDirectory,
      runId: basename(runDirectory),
    });
    const winnerLabel = normalizeExplorationKey(winner.candidate.label);
    const persistedWinner = stored.candidates.find(
      (candidate) => normalizeExplorationKey(candidate.label) === winnerLabel,
    );
    if (persistedWinner === undefined)
      throw new IdiomError(
        "selected candidate is missing from exploration artifacts",
      );
    const result = await resolveExplorationChoice({
      projectDirectory: context.projectDirectory,
      project: context.project,
      stored,
      baseline: baseline.tuples,
      candidate: persistedWinner,
      winnerRun: stored.capturePath(persistedWinner),
      winner: winner.tuples,
      reason,
      repairs: prompts.repairs,
      confirm: dependencies?.confirm ?? defaultConfirmation,
      write: options.write,
      clock: dependencies?.clock,
      gitTopology: dependencies?.gitTopology,
      decide: dependencies?.decide,
    });
    if (result.outcome === "cancelled") {
      await rm(runDirectory, { recursive: true, force: true });
      return { outcome: "cancelled" };
    }
    return result;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    await workspace?.cleanup();
    if (interrupted !== undefined)
      await Promise.reject(
        new IdiomError(`exploration interrupted by ${interrupted}`),
      );
  }
}
