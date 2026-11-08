import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recordRunAttribution } from "../attribution/check.js";
import type { RecordedIntroduction } from "../attribution/record.js";
import { tupleCoordinateKey as importCoordinate } from "../baseline/coordinate.js";
import type { CaptureExecutionContext } from "../capture/execution-context.js";
import { snapshotSource } from "../capture/resolve.js";
import type { CaptureDependencies } from "../capture/run.js";
import { runCapture } from "../capture/run.js";
import type { RunRecord } from "../capture/run-record.js";
import type { CaptureScope } from "../capture/scope.js";
import type { RunTimings } from "../capture/timings.js";
import type { ProductionBuild } from "../capture/types.js";
import type { GitRead } from "../changed/git.js";
import {
  type PaintedCoverageReport,
  reportedCheckCoverage,
} from "../checks/painted.js";
import { projectChecksConfig } from "../checks/project-config.js";
import { runDeterministicChecks } from "../checks/registry.js";
import { scaleQuestions } from "../checks/scale-conformance.js";
import type { CheckTuple } from "../checks/types.js";
import { computeFlowStateCoverage } from "../coverage/states.js";
import type { ClaudeCodeRunner } from "../critique/claude-code.js";
import {
  buildCritiqueContext,
  loadReferenceContext,
} from "../critique/context.js";
import {
  type DeterministicContextLimit,
  deterministicContextLimit,
} from "../critique/deterministic-bound.js";
import type { CritiqueProcessRunner } from "../critique/process.js";
import {
  type CritiqueAdapterLike,
  type CritiqueFallbackEvent,
  type CritiqueModelConfig,
  type CritiqueProvider,
  createCritiqueAdapter,
  createProviderCritiqueAdapter,
  describeCritiqueFailure,
  safeDegradationReason,
} from "../critique/provider.js";
import {
  type TruncatedReference,
  truncatedTextReferences,
} from "../critique/reference-bound.js";
import { validateCritiqueResult } from "../critique/schema.js";
import type { CritiqueEvidenceLimits } from "../critique/types.js";
import {
  type AcknowledgementLapse,
  type AcknowledgementTarget,
  stampAcknowledgements,
  ticketStateLookup,
} from "../decisions/acknowledgements.js";
import {
  acknowledgements as acknowledgementEntries,
  decisionViews,
  judgments,
  readDecisionLogEntries,
  ruleRejection,
} from "../decisions/log.js";
import { tupleDesigns } from "../design/evidence.js";
import { IdiomError } from "../errors.js";
import { findingsMissEvidence, summarizeMisses } from "../learn/misses.js";
import type { ReportCoverage } from "../report/coverage.js";
import { buildReviewCoverage } from "../report/coverage.js";
import { inlineReportImages, writeHtmlReport } from "../report/html.js";
import {
  type AggregatedDecision,
  aggregateDecisionObservations,
} from "../rulings/aggregate.js";
import { writeUnruledDecisions } from "../rulings/artifacts.js";
import {
  loadRulingNames,
  nameUnruledDecisions,
  persistRulingNames,
} from "../rulings/names.js";
import type { Finding } from "../schemas/finding.js";
import { isWebFlow } from "../schemas/flow.js";
import type { UnruledDecision } from "../schemas/ruling.js";
import { type SweepSurface, sweepCritique } from "../sweep/critique.js";
import {
  loadDeclaredSurfaceFlows,
  type ValidationResult,
  validateProject,
} from "../validation.js";
import {
  type AdvisoryReview,
  runAdvisoryReview,
  writeAdvisoryReview,
} from "./advisory.js";
import {
  findLatestCapture,
  loadRunTuples,
  resolveStoredRun,
} from "./artifacts.js";
import {
  isCatalogDecisionTarget,
  loadReviewCatalog,
  persistCatalogFindingNames,
} from "./catalog.js";
import { attachCrops } from "./crops.js";
import { attachFilmstrips } from "./filmstrips.js";
import { trackerRootsFor } from "./lifecycle.js";
import { scaleQuestionDecisions } from "./scale-questions.js";

async function attachVisualEvidence(...args: Parameters<typeof attachCrops>) {
  return attachFilmstrips(args[0], await attachCrops(...args), args[2]);
}

import {
  applyRulesToDrafts,
  buildDeterministicDrafts,
  buildModelDrafts,
  dedupeFindingDrafts,
  dedupeSuppressedFindings,
  type FindingDraft,
  finalizeDeterministicOccurrences,
  finalizeFindingOccurrences,
  finalizeFindingSelection,
  finalizeFindings,
  nameFindingDrafts,
  type SuppressedFinding,
  sortFindingDrafts,
  suppressFindingDrafts,
  writeFindings,
} from "./findings.js";
import {
  coordinateIndex,
  type FindingGroup,
  groupRepeatedFindings,
  writeGroups,
} from "./groups.js";
import { renderReviewHtmlReport } from "./html-report.js";
import { FindingNamingSession, findingNameDivergenceWarning } from "./names.js";
import {
  buildIssueRankingContext,
  type IssueRankingContext,
} from "./ranking.js";
import { type ReviewOutcome, renderReport, writeReport } from "./report.js";

type ReviewCritiqueAdapter = CritiqueAdapterLike;

export type ReviewDependencies = {
  monotonicNow?: (() => number) | undefined;
  /** Wall clock for acknowledgement expiry. */
  now?: (() => Date) | undefined;
  capture?: CaptureDependencies | undefined;
  critique?: ReviewCritiqueAdapter | undefined;
  createCritiqueAdapter?:
    | ((options: {
        provider: CritiqueProvider;
        model: string;
        projectDirectory: string;
        environment: NodeJS.ProcessEnv;
      }) => ReviewCritiqueAdapter)
    | undefined;
  claudeCodeRunner?: ClaudeCodeRunner | undefined;
  codexRunner?: CritiqueProcessRunner | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  /** Git reads for check's first-seen attribution (tests). */
  attributionGit?: GitRead | undefined;
};

export type ReviewRunResult = PaintedCoverageReport & {
  scope?: RunRecord | undefined;
  timings?: RunTimings | undefined;
  reportCoverage?: ReportCoverage | undefined;
  build?: ProductionBuild | undefined;
  runDirectory: string;
  findingsPath: string;
  unruledDecisionsPath: string;
  reportPath: string;
  htmlReportPath: string;
  findingCount: number;
  /** Findings past the review's attention cap (model.maxFindings). */
  deferredFindings: Finding[];
  deterministicOccurrences?: Finding[];
  /**
   * Deterministic occurrences a rule-scope rejection or a rules.json
   * suppression withheld, marked rejected. Collected with
   * deterministicOccurrences; the digest counts them instead of calling them fixed.
   */
  rejectedOccurrences?: Finding[];
  /** Sweep evidence before viewport deduplication. Never a catalog input. */
  occurrences?: Finding[];
  probes?:
    | Array<{
        coordinate: string;
        probe?: import("../checks/types.js").ProbeArtifact | undefined;
      }>
    | undefined;
  /** Material and deferred findings grouped by element and rule (#52). */
  groups: FindingGroup[];
  /** Legacy run-wide primary-action signal; scoring uses tuple context. */
  primaryActionSelectors?: string[];
  issueRankingContext?: IssueRankingContext;
  unruledDecisionCount: number;
  /** Unanswered scale clusters, each standing for the findings it withholds. */
  designSystemQuestions: UnruledDecision[];
  discardedDecisionObservations: number;
  outcome: ReviewOutcome;
  /** Text references the main model pass saw in bounded form; absent when none. */
  truncatedReferences?: TruncatedReference[] | undefined;
  /** Prompts whose deterministic findings context was bounded; absent when none. */
  deterministicContextLimits?: DeterministicContextLimit[] | undefined;
  /** Set when the Claude Code critique split or left out evidence; absent otherwise. */
  critiqueEvidenceLimits?: CritiqueEvidenceLimits | undefined;
  /** Sweep mode only: the per-surface record written to sweep.json. */
  sweep?: { path: string; surfaces: SweepSurface[] } | undefined;
  /** The advisory design-intent review written to advisory.json. */
  advisory?: { path: string; review: AdvisoryReview } | undefined;
  /** One line when the primary checkout's finding names diverged. */
  findingNameWarning?: string | undefined;
  /** Acknowledgements on findings seen this run that no longer hold. */
  acknowledgementLapses: AcknowledgementLapse[];
  /** One line when check's attribution.json could not be written. */
  attributionWarning?: string | undefined;
};

/** Only capture execution failures are recoverable at the product controller. */
export class SweepCaptureError extends Error {
  constructor(cause: unknown) {
    super(safeDegradationReason(cause), { cause });
    this.name = "SweepCaptureError";
  }
}

const MAX_DEGRADATION_REASON_LENGTH = 600;

export {
  claudeCodeDegradationReason,
  safeDegradationReason,
} from "../critique/provider.js";

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * The injected adapter, else the configured provider's own, wrapped in the
 * configured fallback. The creation hook is asked once per provider.
 */
export function createReviewCritiqueAdapter(options: {
  model: CritiqueModelConfig;
  projectDirectory: string;
  dependencies?: Omit<ReviewDependencies, "capture"> | undefined;
  onFallback?: ((event: CritiqueFallbackEvent) => void) | undefined;
}): ReviewCritiqueAdapter {
  const dependencies = options.dependencies;
  if (dependencies?.critique !== undefined) return dependencies.critique;
  const environment = dependencies?.environment ?? process.env;
  return createCritiqueAdapter({
    model: options.model,
    environment,
    onFallback: options.onFallback,
    build: ({ provider, model }) =>
      dependencies?.createCritiqueAdapter?.({
        provider,
        model,
        projectDirectory: options.projectDirectory,
        environment,
      }) ??
      createProviderCritiqueAdapter({
        provider,
        model,
        projectDirectory: options.projectDirectory,
        environment: dependencies?.environment,
        claudeCodeRunner: dependencies?.claudeCodeRunner,
        codexRunner: dependencies?.codexRunner,
      }),
  });
}

/** Makes a fallback switch visible on the outcome it produced. */
export function withFallback(
  outcome: ReviewOutcome,
  fallback: CritiqueFallbackEvent | undefined,
): ReviewOutcome {
  if (fallback === undefined) return outcome;
  if (outcome.kind === "full") return { kind: "full", fallback };
  if (outcome.kind !== "degraded") return outcome;
  const note = `; critique used fallback ${fallback.to} after ${fallback.from} failed`;
  return {
    kind: "degraded",
    reason: `${truncate(outcome.reason, MAX_DEGRADATION_REASON_LENGTH - note.length)}${note}`,
  };
}

/** Stable prefix of the reason a capture with no screenshots degrades with. */
export const NO_REVIEWABLE_SCREENSHOTS_REASON = "no reviewable screenshots";

/** Whether any captured tuple carries a screenshot the model can review. */
export function hasReviewableScreenshot(
  tuples: readonly CheckTuple[],
): boolean {
  return tuples.some((tuple) => tuple.screenshotPath !== undefined);
}

/** The degraded outcome for a capture that left the model nothing to review. */
export function noReviewableScreenshotsOutcome(
  tuples: readonly CheckTuple[],
): ReviewOutcome {
  const count = tuples.length;
  return {
    kind: "degraded",
    reason: `${NO_REVIEWABLE_SCREENSHOTS_REASON}: 0 of ${count} capture tuple${count === 1 ? "" : "s"} produced a screenshot, so model critique did not run`,
  };
}

async function loadSpec(
  validated: ValidationResult,
): Promise<{ file: string; content: string } | undefined> {
  const file = validated.project.design.specFile;
  if (file === undefined) return undefined;
  try {
    return {
      file,
      content: await readFile(join(validated.projectDirectory, file), "utf8"),
    };
  } catch (error) {
    throw new IdiomError(
      `cannot load design.specFile ${JSON.stringify(file)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runReview(options: {
  executionContext?: CaptureExecutionContext | undefined;
  flow: string;
  project?: string | undefined;
  cwd?: string | undefined;
  prod?: boolean | undefined;
  scope?: CaptureScope | undefined;
  /** Serve the application on this port instead of a free one. */
  port?: number | undefined;
  /** Refetch pinned Figma frames when this review captures. */
  refreshDesign?: boolean | undefined;
  /** Probe run target for this capture only (`--probe-budget`); 0 = no target. */
  probeBudgetMs?: number | undefined;
  /** Build gate capture levers; see `runCapture`. */
  probeDisabled?: boolean | undefined;
  probeRegions?:
    | ReadonlyMap<string, import("../capture/probe.js").ProbeRegion>
    | undefined;
  reuseServer?: boolean | undefined;
  inputIdentity?: string | undefined;
  /** `idiom check --gate`: rendered under **Build gate** in the report. */
  gateReport?: import("../gate/types.js").GateReportSection | undefined;
  from?: string | undefined;
  latest?: boolean | undefined;
  deterministicOnly?: boolean | undefined;
  includeDeterministicOccurrences?: boolean | undefined;
  /** In-memory presentation inputs requested only by check. */
  includeIssueRankingContext?: boolean | undefined;
  materializeAllDeterministic?: boolean | undefined;
  /**
   * "sweep" critiques one surface at a time with zoomed crops, measured
   * geometry and the design spec, and reports every finding uncapped.
   */
  mode?: "review" | "sweep" | undefined;
  /**
   * The advisory design-intent review of the flow's content patterns. Unset,
   * it runs whenever the flow declares content and the main critique runs;
   * true runs it even beside deterministic-only checks.
   */
  advisory?: boolean | undefined;
  /** Ignore the primary checkout's finding names (throwaway worktrees). */
  isolatedRegistry?: boolean | undefined;
  /** `check` only: tie new findings to their first-seen commit range. */
  recordAttribution?: boolean | undefined;
  dependencies?: ReviewDependencies | undefined;
}): Promise<ReviewRunResult> {
  if (options.materializeAllDeterministic && !options.deterministicOnly)
    throw new IdiomError(
      "materializeAllDeterministic requires deterministic-only review",
    );
  const sweepMode = options.mode === "sweep";
  const checkCancelled = () =>
    options.dependencies?.capture?.signal?.throwIfAborted();
  checkCancelled();
  const validated =
    options.executionContext?.validated ??
    (await validateProject({
      project: options.project,
      flow: options.flow,
      cwd: options.cwd,
    }));
  const record = validated.flows[0];
  if (record === undefined || record.flow.id !== options.flow) {
    throw new IdiomError(
      `requested flow ${JSON.stringify(options.flow)} does not match the manifest id ${JSON.stringify(record?.flow.id)}`,
    );
  }
  const contentFlow =
    isWebFlow(record.flow) && record.flow.content !== undefined
      ? { ...record.flow, content: record.flow.content }
      : undefined;
  if (options.advisory === true && contentFlow === undefined)
    throw new IdiomError(
      "--advisory needs a flow with a content block declaring patterns",
    );
  const runAdvisory =
    contentFlow !== undefined &&
    (options.advisory === true ||
      (options.advisory === undefined &&
        options.deterministicOnly !== true &&
        !sweepMode));
  const surfaceFlows = await loadDeclaredSurfaceFlows(validated);
  const spec =
    sweepMode && !options.deterministicOnly
      ? await loadSpec(validated)
      : undefined;

  if (
    options.prod === true &&
    (options.from !== undefined || options.latest === true)
  )
    throw new IdiomError(
      "--prod cannot be combined with --from or --latest; it requires a fresh capture",
    );
  if (
    Object.values(options.scope ?? {}).some((value) => value !== undefined) &&
    (options.from !== undefined || options.latest === true)
  )
    throw new IdiomError(
      "scope flags cannot be combined with --from or --latest; they select a fresh capture",
    );
  if (
    options.probeBudgetMs !== undefined &&
    (options.from !== undefined || options.latest === true)
  )
    throw new IdiomError(
      "--probe-budget cannot be combined with --from or --latest; it requires a fresh capture",
    );
  let runDirectory: string;
  if (options.latest === true && options.from !== undefined)
    throw new IdiomError("--latest and --from are mutually exclusive");
  if (options.latest === true) {
    const source = await snapshotSource(validated.projectDirectory, {
      ignoreDirty: validated.project.baselines?.ignoreDirty,
    });
    runDirectory = resolveStoredRun(
      validated.projectDirectory,
      await findLatestCapture({
        projectDirectory: validated.projectDirectory,
        flow: options.flow,
        commit: source.commit,
        production:
          isWebFlow(record.flow) && record.flow.server === "production",
      }),
    );
  } else if (options.from === undefined) {
    const capture = await runCapture({
      projectDirectory: validated.projectDirectory,
      executionContext: options.executionContext,
      project: validated.project,
      flow: record.flow,
      prod: options.prod,
      scope: options.scope,
      port: options.port,
      refreshDesign: options.refreshDesign,
      probeBudgetMs: options.probeBudgetMs,
      probeDisabled: options.probeDisabled,
      probeRegions: options.probeRegions,
      reuseServer: options.reuseServer,
      inputIdentity: options.inputIdentity,
      dependencies: options.dependencies?.capture,
    }).catch((error) => {
      checkCancelled();
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (sweepMode) throw new SweepCaptureError(error);
      throw error;
    });
    runDirectory = capture.runDirectory;
  } else {
    runDirectory = resolveStoredRun(validated.projectDirectory, options.from);
  }

  checkCancelled();
  options.dependencies?.capture?.onActivity?.({
    state: "review",
    viewport: "all",
    colorScheme: "all",
    step: "deterministic review",
  });
  const loaded = await loadRunTuples(validated, record.flow, runDirectory);
  const issueRankingContext =
    options.includeIssueRankingContext === true
      ? buildIssueRankingContext(loaded.tuples)
      : undefined;
  const primaryActionSelectors = [
    ...new Set(
      loaded.tuples.flatMap((tuple) =>
        tuple.observations?.version === 2
          ? tuple.observations.elements
              .filter(
                (element) => element.signals?.paint?.primaryAction === true,
              )
              .map((element) => element.selector)
          : [],
      ),
    ),
  ].sort();
  const clock = options.dependencies?.monotonicNow ?? (() => performance.now());
  const checksStarted = clock();
  const checksConfig = await projectChecksConfig(validated);
  const reviewed = runDeterministicChecks(
    loaded.tuples,
    loaded.expectedTupleKeys,
    checksConfig,
  );
  // Deterministic, so asked on every review outcome; the findings they
  // stand for are already withheld from the candidates.
  const scaleDecisions = await scaleQuestionDecisions({
    runDirectory,
    clusters: scaleQuestions(loaded.tuples, checksConfig),
    resolvedFingerprints: new Set(
      (checksConfig.scaleQuestions?.rulings ?? []).map(
        (ruling) => ruling.fingerprint,
      ),
    ),
  });
  const checksTiming = {
    status: "measured" as const,
    ms: Math.max(0, clock() - checksStarted),
  };
  await writeFile(
    join(runDirectory, "checks-timings.json"),
    `${JSON.stringify({ version: 1, checks: checksTiming }, null, 2)}\n`,
  );
  const historical = options.from !== undefined || options.latest === true;
  const unavailable = { status: "unavailable" as const, ms: 0 };
  const timings: RunTimings = {
    ...(loaded.record?.timings ?? {
      build: unavailable,
      start: unavailable,
      tuples: [],
      probe: unavailable,
    }),
    checks: checksTiming,
    historical,
  };
  const catalog = await loadReviewCatalog({
    project: validated.stateProjectDirectory ?? validated.projectDirectory,
    isolatedRegistry: options.isolatedRegistry,
  });
  const findingNameWarning = findingNameDivergenceWarning(catalog.names);
  const naming = new FindingNamingSession(catalog.names);
  const decisionLog = await readDecisionLogEntries(
    validated.stateProjectDirectory ?? validated.projectDirectory,
  );
  const decisions = judgments(decisionLog);
  const views = decisionViews(decisions);
  const ruleRejections = [...views.byRuleFingerprint.values()].filter(
    (decision) => {
      if (ruleRejection([decision.fingerprint], decisions) === undefined)
        return false;
      const lineage = catalog.lineages.find((candidate) =>
        candidate.fingerprints.includes(decision.fingerprint),
      );
      if (lineage === undefined) return true;
      return ruleRejection(lineage.fingerprints, decisions) !== undefined;
    },
  );

  const deterministicDrafts = nameFindingDrafts(
    naming,
    buildDeterministicDrafts({
      config: checksConfig,
      tuples: loaded.tuples,
      runId: loaded.runId,
      entries: reviewed.candidates,
      legacyColorScheme: validated.project.capture.colorScheme,
    }),
  );
  const deterministicRules = applyRulesToDrafts(
    deterministicDrafts,
    validated.rules,
  );
  const deterministic = suppressFindingDrafts(
    deterministicRules.kept,
    decisions,
  );
  const orderedDeterministic = dedupeFindingDrafts(
    sortFindingDrafts(deterministic.kept),
  );
  let allDrafts = [...orderedDeterministic];
  // Every kept model draft, before viewport dedupe, for group coordinates.
  let modelKeptDrafts: FindingDraft[] = [];
  const suppressed = [
    ...deterministicRules.suppressed,
    ...deterministic.suppressed,
  ];
  let outcome: ReviewOutcome;
  let truncatedReferences: TruncatedReference[] = [];
  let deterministicContextLimits: DeterministicContextLimit[] = [];
  let critiqueEvidenceLimits: CritiqueEvidenceLimits | undefined;
  let unruledDecisions: UnruledDecision[] = [];
  let aggregatedDecisions: AggregatedDecision[] = [];
  let discardedDecisionObservations = 0;
  let sweepSurfaces: SweepSurface[] | undefined;
  const fallbacks: CritiqueFallbackEvent[] = [];
  const describeFailure = (error: unknown) =>
    describeCritiqueFailure(
      error,
      options.dependencies?.environment ?? process.env,
    );

  if (options.deterministicOnly === true) {
    outcome = { kind: "deterministic-only" };
  } else if (!hasReviewableScreenshot(loaded.tuples)) {
    outcome = noReviewableScreenshotsOutcome(loaded.tuples);
  } else if (sweepMode) {
    const deterministicFindings = finalizeFindings({
      runId: loaded.runId,
      drafts: orderedDeterministic,
      catalog,
    });
    const priorRules = validated.rules.overrides.filter(
      (override) =>
        override.action === "suppress" &&
        (override.match.flow === undefined ||
          override.match.flow === options.flow),
    );
    try {
      truncatedReferences = truncatedTextReferences(
        await loadReferenceContext(validated.projectDirectory),
      );
      const sweep = await sweepCritique({
        projectDirectory: validated.projectDirectory,
        stateProjectDirectory: validated.stateProjectDirectory,
        runDirectory,
        project: validated.project,
        flow: record.flow,
        tuples: loaded.tuples,
        priorDecisions: ruleRejections,
        priorRules,
        deterministicFindings,
        adapter: createReviewCritiqueAdapter({
          model: validated.project.model,
          projectDirectory: validated.projectDirectory,
          dependencies: options.dependencies,
          onFallback: (event) => fallbacks.push(event),
        }),
        spec,
        describeFailure,
      });
      sweepSurfaces = sweep.surfaces;
      deterministicContextLimits = sweep.surfaces.flatMap(
        (surface) => surface.deterministicContextLimit ?? [],
      );
      discardedDecisionObservations = sweep.discardedDecisionObservations;
      aggregatedDecisions = aggregateDecisionObservations({
        observations: sweep.decisionObservations,
        resolvedFingerprints: new Set(
          sweep.rulingResolutions.map((resolution) => resolution.fingerprint),
        ),
      });
      const modelDrafts = nameFindingDrafts(
        naming,
        buildModelDrafts({
          runId: loaded.runId,
          candidates: sweep.findings,
          screenshots: sweep.screenshots,
          tuples: loaded.tuples,
          legacyColorScheme: validated.project.capture.colorScheme,
        }),
      );
      const modelRules = applyRulesToDrafts(modelDrafts, validated.rules);
      const model = suppressFindingDrafts(modelRules.kept, decisions);
      suppressed.push(...modelRules.suppressed, ...model.suppressed);
      allDrafts = [...orderedDeterministic, ...model.kept];
      modelKeptDrafts = model.kept;
      const failed = sweep.surfaces.filter(
        (surface) => surface.status === "failed",
      );
      // Unlike review, a partial sweep keeps the surfaces that succeeded.
      outcome = withFallback(
        failed.length === 0
          ? { kind: "full" }
          : {
              kind: "degraded",
              reason: truncate(
                `critique failed for ${failed.length} of ${sweep.surfaces.length} surfaces: ${failed
                  .map(
                    (surface) =>
                      `${surface.state}: ${surface.reason ?? "unknown"}`,
                  )
                  .join("; ")}`,
                MAX_DEGRADATION_REASON_LENGTH,
              ),
            },
        fallbacks[0],
      );
    } catch (error) {
      outcome = { kind: "degraded", reason: safeDegradationReason(error) };
    }
  } else {
    try {
      const deterministicFindings = finalizeFindings({
        runId: loaded.runId,
        drafts: orderedDeterministic,
        catalog,
      });
      const context = await buildCritiqueContext({
        projectDirectory: validated.projectDirectory,
        stateProjectDirectory: validated.stateProjectDirectory,
        runDirectory,
        project: validated.project,
        flow: record.flow,
        tuples: loaded.tuples,
        priorDecisions: ruleRejections,
        priorRules: validated.rules.overrides.filter(
          (override) =>
            override.action === "suppress" &&
            (override.match.flow === undefined ||
              override.match.flow === options.flow),
        ),
        deterministicFindings,
        modelCandidateAllowance: validated.project.model.maxFindings,
      });
      truncatedReferences = truncatedTextReferences(context.references);
      deterministicContextLimits = [
        deterministicContextLimit(context.deterministicFindings),
      ].flatMap((limit) => limit ?? []);
      const adapter = createReviewCritiqueAdapter({
        model: validated.project.model,
        projectDirectory: validated.projectDirectory,
        dependencies: options.dependencies,
        onFallback: (event) => fallbacks.push(event),
      });
      const critique = validateCritiqueResult({
        result: await adapter.critique(context),
        screenshots: context.screenshots,
        references: context.references,
        designMd: context.designMd,
        designImages: context.designImages,
      });
      const candidates = critique.findings;
      critiqueEvidenceLimits = critique.evidenceLimits;
      discardedDecisionObservations = critique.discardedDecisionObservations;
      aggregatedDecisions = aggregateDecisionObservations({
        observations: critique.decisionObservations,
        resolvedFingerprints: new Set(
          context.rulingResolutions.map((resolution) => resolution.fingerprint),
        ),
      });
      const modelDrafts = nameFindingDrafts(
        naming,
        buildModelDrafts({
          runId: loaded.runId,
          candidates,
          screenshots: context.screenshots,
          tuples: loaded.tuples,
          legacyColorScheme: validated.project.capture.colorScheme,
        }),
      );
      const modelRules = applyRulesToDrafts(modelDrafts, validated.rules);
      const model = suppressFindingDrafts(modelRules.kept, decisions);
      suppressed.push(...modelRules.suppressed, ...model.suppressed);
      allDrafts = [...orderedDeterministic, ...model.kept];
      modelKeptDrafts = model.kept;
      outcome = withFallback({ kind: "full" }, fallbacks[0]);
    } catch (error) {
      outcome = { kind: "degraded", reason: describeFailure(error) };
    }
  }

  let advisory: ReviewRunResult["advisory"];
  if (runAdvisory && contentFlow !== undefined) {
    const advisoryFallbacks: CritiqueFallbackEvent[] = [];
    const ran = await runAdvisoryReview({
      projectDirectory: validated.projectDirectory,
      stateProjectDirectory: validated.stateProjectDirectory,
      runDirectory,
      project: validated.project,
      flow: contentFlow,
      tuples: loaded.tuples,
      runId: loaded.runId,
      deterministicFindings: finalizeFindings({
        runId: loaded.runId,
        drafts: orderedDeterministic,
      }),
      adapter: createReviewCritiqueAdapter({
        model: validated.project.model,
        projectDirectory: validated.projectDirectory,
        dependencies: options.dependencies,
        onFallback: (event) => advisoryFallbacks.push(event),
      }),
      describeFailure,
      legacyColorScheme: validated.project.capture.colorScheme,
    });
    const review = {
      ...ran,
      outcome: withFallback(ran.outcome, advisoryFallbacks[0]),
    };
    advisory = {
      path: await writeAdvisoryReview(runDirectory, review),
      review,
    };
  }

  if (outcome.kind === "full" || scaleDecisions.length > 0) {
    const rulingNames = await loadRulingNames({
      projectDirectory:
        validated.stateProjectDirectory ?? validated.projectDirectory,
    });
    unruledDecisions = nameUnruledDecisions(rulingNames, [
      ...(outcome.kind === "full" ? aggregatedDecisions : []),
      ...scaleDecisions,
    ]);
    await persistRulingNames(rulingNames);
  }
  const designSystemQuestions = unruledDecisions.filter(
    (decision) => decision.scaleCluster !== undefined,
  );

  checkCancelled();
  const selection = finalizeFindingSelection({
    runId: loaded.runId,
    drafts: allDrafts,
    maxFindings:
      sweepMode || options.materializeAllDeterministic === true
        ? Number.POSITIVE_INFINITY
        : validated.project.model.maxFindings,
    catalog,
  });
  // Explicit reference choices remain addressable even beyond the presentation cap.
  const questions = selection.deferred.filter(
    (f) =>
      f.rule === "idiom:design-decision" &&
      f.evidence.designDrift?.designDecision !== undefined,
  );
  selection.material.push(...questions);
  selection.deferred = selection.deferred.filter((f) => !questions.includes(f));
  // Acknowledgements are resolved against this run's observations and
  // stamped before any artifact or gate reads the findings.
  const acknowledged = acknowledgementStamper({
    catalog,
    entries: acknowledgementEntries(decisionLog),
    projectDirectory:
      validated.stateProjectDirectory ?? validated.projectDirectory,
    now: options.dependencies?.now?.() ?? new Date(),
  });
  const findings = await acknowledged.stamp(
    await attachVisualEvidence(runDirectory, selection.material, loaded.tuples),
  );
  const deferredFindings = await acknowledged.stamp(
    await attachVisualEvidence(runDirectory, selection.deferred, loaded.tuples),
  );
  // This run overwrites its own findings.json with material findings only, so
  // an occurrence there cannot keep a deferred id decidable.
  const deferredDecisionTargets = new Set(
    deferredFindings
      .filter((finding) =>
        isCatalogDecisionTarget(catalog, finding.id, runDirectory),
      )
      .map((finding) => finding.id),
  );
  const deterministicOccurrences =
    options.includeDeterministicOccurrences === true
      ? await acknowledged.stamp(
          await attachVisualEvidence(
            runDirectory,
            finalizeDeterministicOccurrences({
              runId: loaded.runId,
              drafts: deterministic.kept,
              catalog,
            }),
            loaded.tuples,
          ),
        )
      : undefined;
  const rejectedOccurrences =
    options.includeDeterministicOccurrences === true
      ? rejectedDeterministicOccurrences({
          runId: loaded.runId,
          drafts: deterministicDrafts,
          kept: deterministic.kept,
          suppressed: [
            ...deterministicRules.suppressed,
            ...deterministic.suppressed,
          ],
          catalog,
        })
      : undefined;
  const occurrences = sweepMode
    ? await acknowledged.stamp(
        await attachVisualEvidence(
          runDirectory,
          finalizeFindingOccurrences({
            runId: loaded.runId,
            drafts: [...deterministic.kept, ...modelKeptDrafts],
            catalog,
          }),
          loaded.tuples,
        ),
      )
    : undefined;
  const acknowledgementLapses = acknowledged.lapses();
  if (occurrences !== undefined)
    await writeFile(
      join(runDirectory, "occurrences.json"),
      `${JSON.stringify(occurrences, null, 2)}\n`,
    );
  const groups = groupRepeatedFindings(
    [...findings, ...deferredFindings],
    coordinateIndex([...deterministic.kept, ...modelKeptDrafts]),
    new Set(deferredFindings.map((finding) => finding.id)),
  );
  // The registry is the durable reservation boundary and must be published
  // before any report artifact cites a name from it.
  checkCancelled();
  await persistCatalogFindingNames(catalog);
  const findingsPath = await writeFindings(runDirectory, findings);
  await writeGroups(runDirectory, groups);
  const unruledDecisionsPath = await writeUnruledDecisions(
    runDirectory,
    unruledDecisions,
  );
  const humanFound = await summarizeMisses({
    projectDirectory: validated.projectDirectory,
    extra: findingsMissEvidence(
      [
        ...findings,
        ...deferredFindings,
        ...(deterministicOccurrences ?? []),
        ...(rejectedOccurrences ?? []),
      ],
      loaded.runId,
    ),
  }).catch(() => undefined);
  const reportOptions = {
    humanFound,
    now: options.dependencies?.now?.() ?? new Date(),
    flow: options.flow,
    commit: loaded.commit,
    build: loaded.build,
    reportCoverage: {
      ...buildReviewCoverage({
        record: loaded.record,
        collapsedTupleKeys: loaded.collapsedTupleKeys,
        flow: record.flow,
        project: validated.project,
        tuples: loaded.tuples,
        commit: loaded.commit,
        briefs: checksConfig.briefs,
        allFlows:
          surfaceFlows.length === 0
            ? [record.flow]
            : surfaceFlows.map(({ flow }) => flow),
        stateCoverage: computeFlowStateCoverage({
          project: validated.project,
          flow: record.flow,
          runId: loaded.runId,
          commit: loaded.commit,
          record: loaded.record,
          tuples: loaded.tuples,
          collapsedTupleKeys: loaded.collapsedTupleKeys,
        }),
      }),
      ...(options.gateReport === undefined ? {} : { gate: options.gateReport }),
    },
    findings,
    unruledDecisions,
    discardedDecisionObservations,
    tuples: loaded.tuples,
    coverage: reviewed.coverage,
    captureCoverage: reviewed.captureCoverage,
    deferred: deferredFindings,
    deferredDecisionTargets,
    acknowledgementLapses,
    groups,
    ...(reviewed.narrowWidth === undefined
      ? {}
      : { narrowWidth: reviewed.narrowWidth }),
    outcome,
    truncatedReferences,
    ...(deterministicContextLimits.length === 0
      ? {}
      : { deterministicContextLimits }),
    ...(critiqueEvidenceLimits === undefined ? {} : { critiqueEvidenceLimits }),
    ...(advisory === undefined ? {} : { advisory: advisory.review }),
    suppressed: dedupeSuppressedFindings(suppressed),
    severityOverrides: selection.orderedDrafts.flatMap((draft) =>
      draft.severityOverride === undefined
        ? []
        : [
            {
              fingerprint: draft.finding.fingerprint,
              ...draft.severityOverride,
            },
          ],
    ),
  };
  const attribution =
    options.recordAttribution === true && deterministicOccurrences !== undefined
      ? await recordRunAttribution({
          validated,
          flow: options.flow,
          runDirectory,
          occurrences: [
            ...deterministicOccurrences,
            ...(rejectedOccurrences ?? []),
          ],
          coverage: reportOptions.reportCoverage,
          scope: loaded.record,
          rankingContext: issueRankingContext,
          now: options.dependencies?.now?.() ?? new Date(),
          git: options.dependencies?.attributionGit,
        })
      : undefined;
  const introductions: ReadonlyMap<string, RecordedIntroduction> | undefined =
    attribution?.introductions;
  const screenshotPaths = [
    ...new Set([
      ...reportOptions.tuples.flatMap((tuple) =>
        [
          tuple.screenshotPath,
          ...tupleDesigns(tuple).map((design) => design.screenshotPath),
        ].filter((p): p is string => p !== undefined),
      ),
      ...[reportOptions.findings, reportOptions.deferred ?? []]
        .flat()
        .flatMap((finding) => [
          ...(finding.evidence.designDrift?.crops?.map((crop) => crop.path) ??
            []),
          ...(finding.evidence.filmstrip?.sheet
            ? [finding.evidence.filmstrip.sheet]
            : []),
        ]),
      ...designSystemQuestions.flatMap((decision) =>
        (decision.scaleCluster?.examples ?? []).flatMap((example) =>
          example.crop === undefined ? [] : [example.crop],
        ),
      ),
    ]),
  ];
  const screenshots = await inlineReportImages(runDirectory, screenshotPaths);
  checkCancelled();
  const [reportPath, htmlReportPath] = await Promise.all([
    writeReport(
      runDirectory,
      renderReport({ ...reportOptions, introductions }),
    ),
    writeHtmlReport(
      runDirectory,
      renderReviewHtmlReport({ ...reportOptions, screenshots, introductions }),
    ),
  ]);
  let sweep: ReviewRunResult["sweep"];
  if (sweepMode) {
    const surfaces = sweepSurfaces ?? [];
    const path = join(runDirectory, "sweep.json");
    await writeFile(
      path,
      `${JSON.stringify(
        {
          flow: options.flow,
          ...(spec === undefined ? {} : { spec: spec.file }),
          outcome,
          surfaces,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    sweep = { path, surfaces };
  }
  checkCancelled();
  return {
    ...(issueRankingContext === undefined ? {} : { issueRankingContext }),
    ...(occurrences === undefined ? {} : { occurrences }),
    probes: loaded.tuples.map((tuple) => ({
      coordinate: importCoordinate(tuple),
      probe:
        tuple.observations?.version === 2
          ? tuple.observations.probe
          : undefined,
    })),
    scope: loaded.record,
    timings,
    reportCoverage: reportOptions.reportCoverage,
    ...reportedCheckCoverage(reviewed.coverage),
    ...(sweepMode
      ? {
          checkCoverage: reviewed.coverage.map(({ tuple, coverage }) => ({
            ...coverage,
            state: tuple.state,
            viewport: tuple.viewport,
            ...(tuple.colorScheme === undefined
              ? {}
              : { colorScheme: tuple.colorScheme }),
          })),
        }
      : {}),
    runDirectory,
    findingsPath,
    deferredFindings,
    groups,
    ...(primaryActionSelectors.length === 0 ? {} : { primaryActionSelectors }),
    ...(deterministicOccurrences === undefined
      ? {}
      : { deterministicOccurrences }),
    ...(rejectedOccurrences === undefined ? {} : { rejectedOccurrences }),
    unruledDecisionsPath,
    reportPath,
    htmlReportPath,
    findingCount: findings.length,
    ...(loaded.build === undefined ? {} : { build: loaded.build }),
    unruledDecisionCount:
      unruledDecisions.length - designSystemQuestions.length,
    designSystemQuestions,
    discardedDecisionObservations,
    outcome,
    ...(truncatedReferences.length === 0 ? {} : { truncatedReferences }),
    ...(deterministicContextLimits.length === 0
      ? {}
      : { deterministicContextLimits }),
    ...(critiqueEvidenceLimits === undefined ? {} : { critiqueEvidenceLimits }),
    ...(sweep === undefined ? {} : { sweep }),
    ...(advisory === undefined ? {} : { advisory }),
    ...(findingNameWarning === undefined ? {} : { findingNameWarning }),
    acknowledgementLapses,
    ...(attribution?.warning === undefined
      ? {}
      : { attributionWarning: attribution.warning }),
  };
}

/**
 * One resolver per run: ticket states are probed once per reference, and each
 * lapse is reported once per finding however many occurrences carry it.
 */
/**
 * Re-finalize the deterministic drafts a rejection withheld, so a later
 * digest can tell a rejected finding from a fixed one. Keyed by
 * fingerprint and coordinate: suppression is the only filter between the
 * drafts and the kept set.
 */
function rejectedDeterministicOccurrences(options: {
  runId: string;
  drafts: FindingDraft[];
  kept: FindingDraft[];
  suppressed: SuppressedFinding[];
  catalog: Awaited<ReturnType<typeof loadReviewCatalog>>;
}): Finding[] {
  const key = (finding: Finding) =>
    `${finding.fingerprint}\0${importCoordinate(finding)}`;
  const kept = new Set(options.kept.map((draft) => key(draft.finding)));
  const withheld = new Set(
    options.suppressed
      .map(({ finding }) => key(finding))
      .filter((identity) => !kept.has(identity)),
  );
  return finalizeDeterministicOccurrences({
    runId: options.runId,
    drafts: options.drafts.filter((draft) => withheld.has(key(draft.finding))),
    catalog: options.catalog,
  }).map((finding) => ({ ...finding, status: "rejected" as const }));
}

function acknowledgementStamper(options: {
  catalog: Awaited<ReturnType<typeof loadReviewCatalog>>;
  entries: Parameters<typeof stampAcknowledgements>[1]["entries"];
  projectDirectory: string;
  now: Date;
}) {
  const ticketState = ticketStateLookup(
    trackerRootsFor(options.projectDirectory),
  );
  const lapses = new Map<string, AcknowledgementLapse>();
  // Matched by fingerprint, as finalizeFindingSelection assigns lineage ids.
  const targetFor = (finding: Finding): AcknowledgementTarget => {
    const lineage = options.catalog.lineages.find((candidate) =>
      candidate.fingerprints.includes(finding.fingerprint),
    );
    return lineage === undefined
      ? { id: finding.id, ids: [], fingerprints: [finding.fingerprint] }
      : {
          id: lineage.id,
          ids: lineage.ids,
          fingerprints: lineage.fingerprints,
        };
  };
  return {
    async stamp(findings: Finding[]): Promise<Finding[]> {
      const result = await stampAcknowledgements(findings, {
        targetFor,
        entries: options.entries,
        ticketState,
        now: options.now,
      });
      for (const lapse of result.lapses)
        if (!lapses.has(lapse.findingId)) lapses.set(lapse.findingId, lapse);
      return result.findings;
    },
    lapses: () => [...lapses.values()],
  };
}
