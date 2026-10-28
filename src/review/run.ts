import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tupleCoordinateKey as importCoordinate } from "../baseline/coordinate.js";
import { snapshotSource } from "../capture/resolve.js";
import type { CaptureDependencies } from "../capture/run.js";
import { runCapture } from "../capture/run.js";
import type { RunRecord } from "../capture/run-record.js";
import type { CaptureScope } from "../capture/scope.js";
import type { RunTimings } from "../capture/timings.js";
import type { ProductionBuild } from "../capture/types.js";
import {
  type PaintedCoverageReport,
  reportedCheckCoverage,
} from "../checks/painted.js";
import { projectChecksConfig } from "../checks/project-config.js";
import { runDeterministicChecks } from "../checks/registry.js";
import { scaleQuestions } from "../checks/scale-conformance.js";
import { AnthropicCritiqueAdapter } from "../critique/anthropic.js";
import {
  ClaudeCodeCritiqueAdapter,
  ClaudeCodeCritiqueError,
  type ClaudeCodeRunner,
  sanitizeCritiqueDiagnostic,
} from "../critique/claude-code.js";
import { buildCritiqueContext } from "../critique/context.js";
import { validateCritiqueResult } from "../critique/schema.js";
import type {
  CritiqueAdapter,
  CritiqueInput,
  CritiqueResult,
  ModelFindingCandidate,
} from "../critique/types.js";
import { decisionViews, readDecisionLog } from "../decisions/log.js";
import { tupleDesigns } from "../design/evidence.js";
import { IdiomError } from "../errors.js";
import type { ReportCoverage } from "../report/coverage.js";
import { buildReviewCoverage } from "../report/coverage.js";
import { pngDataUri, writeHtmlReport } from "../report/html.js";
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
import { loadReviewCatalog, persistCatalogFindingNames } from "./catalog.js";
import { attachCrops } from "./crops.js";
import { attachFilmstrips } from "./filmstrips.js";
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
import { FindingNamingSession } from "./names.js";
import {
  buildIssueRankingContext,
  type IssueRankingContext,
} from "./ranking.js";
import { type ReviewOutcome, renderReport, writeReport } from "./report.js";

type ReviewCritiqueAdapter =
  | CritiqueAdapter
  | {
      critique(
        input: CritiqueInput,
      ): Promise<CritiqueResult | ModelFindingCandidate[]>;
    };

export type ReviewDependencies = {
  monotonicNow?: (() => number) | undefined;
  capture?: CaptureDependencies | undefined;
  critique?: ReviewCritiqueAdapter | undefined;
  createCritiqueAdapter?:
    | ((options: {
        provider: "claude-code" | "anthropic";
        model: string;
        projectDirectory: string;
        environment: NodeJS.ProcessEnv;
      }) => ReviewCritiqueAdapter)
    | undefined;
  claudeCodeRunner?: ClaudeCodeRunner | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
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
  /** Sweep mode only: the per-surface record written to sweep.json. */
  sweep?: { path: string; surfaces: SweepSurface[] } | undefined;
  /** The advisory design-intent review written to advisory.json. */
  advisory?: { path: string; review: AdvisoryReview } | undefined;
};

/** Only capture execution failures are recoverable at the product controller. */
export class SweepCaptureError extends Error {
  constructor(cause: unknown) {
    super(safeDegradationReason(cause), { cause });
    this.name = "SweepCaptureError";
  }
}

const MAX_DEGRADATION_REASON_LENGTH = 600;

function safeDegradationDetail(error: unknown, limit: number): string {
  return sanitizeCritiqueDiagnostic(error, limit);
}

export function safeDegradationReason(error: unknown): string {
  return safeDegradationDetail(error, MAX_DEGRADATION_REASON_LENGTH);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function claudeCodeDegradationReason(
  error: unknown,
  environment: NodeJS.ProcessEnv,
): string {
  const cliClause =
    "Claude Code CLI is unavailable or not authenticated; install or update Claude Code and run `claude auth login`";
  const fallbackClause =
    environment.ANTHROPIC_API_KEY === undefined ||
    environment.ANTHROPIC_API_KEY.trim() === ""
      ? "ANTHROPIC_API_KEY is not set for the explicit direct-API fallback"
      : 'select model.provider: "anthropic" to use the explicit direct-API fallback';
  const separator = "; ";
  const detailPrefix = "diagnostic: ";
  const detailBudget =
    MAX_DEGRADATION_REASON_LENGTH -
    cliClause.length -
    fallbackClause.length -
    separator.length * 2 -
    detailPrefix.length;
  const detail = safeDegradationDetail(
    error instanceof ClaudeCodeCritiqueError ? error.detail : error,
    detailBudget,
  );
  return [
    cliClause,
    ...(detail === "" ? [] : [`${detailPrefix}${detail}`]),
    fallbackClause,
  ].join(separator);
}

/** The injected adapter, else the configured provider's own. */
export function createReviewCritiqueAdapter(options: {
  provider: "claude-code" | "anthropic";
  model: string;
  projectDirectory: string;
  dependencies?: Omit<ReviewDependencies, "capture"> | undefined;
}): ReviewCritiqueAdapter {
  const dependencies = options.dependencies;
  return (
    dependencies?.critique ??
    dependencies?.createCritiqueAdapter?.({
      provider: options.provider,
      model: options.model,
      projectDirectory: options.projectDirectory,
      environment: dependencies?.environment ?? process.env,
    }) ??
    (options.provider === "claude-code"
      ? new ClaudeCodeCritiqueAdapter({
          model: options.model,
          projectDirectory: options.projectDirectory,
          environment: dependencies?.environment,
          runner: dependencies?.claudeCodeRunner,
        })
      : new AnthropicCritiqueAdapter({
          model: options.model,
          environment: dependencies?.environment,
        }))
  );
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
  flow: string;
  project?: string | undefined;
  cwd?: string | undefined;
  prod?: boolean | undefined;
  scope?: CaptureScope | undefined;
  /** Serve the application on this port instead of a free one. */
  port?: number | undefined;
  /** Refetch pinned Figma frames when this review captures. */
  refreshDesign?: boolean | undefined;
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
  const validated = await validateProject({
    project: options.project,
    flow: options.flow,
    cwd: options.cwd,
  });
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
  let runDirectory: string;
  if (options.latest === true && options.from !== undefined)
    throw new IdiomError("--latest and --from are mutually exclusive");
  if (options.latest === true) {
    const source = await snapshotSource(validated.projectDirectory);
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
      project: validated.project,
      flow: record.flow,
      prod: options.prod,
      scope: options.scope,
      port: options.port,
      refreshDesign: options.refreshDesign,
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
    project: validated.projectDirectory,
  });
  const naming = new FindingNamingSession(catalog.names);
  const decisions = await readDecisionLog(validated.projectDirectory);
  const views = decisionViews(decisions);
  const ruleRejections = [...views.byRuleFingerprint.values()].filter(
    (decision) => {
      if (decision.decision !== "reject") return false;
      const lineage = catalog.lineages.find((candidate) =>
        candidate.fingerprints.includes(decision.fingerprint),
      );
      if (lineage === undefined) return true;
      return (
        decisions
          .filter(
            (candidate) =>
              candidate.scope === "rule" &&
              lineage.fingerprints.includes(candidate.fingerprint),
          )
          .at(-1)?.decision === "reject"
      );
    },
  );

  const deterministicDrafts = nameFindingDrafts(
    naming,
    buildDeterministicDrafts({
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
  let unruledDecisions: UnruledDecision[] = [];
  let aggregatedDecisions: AggregatedDecision[] = [];
  let discardedDecisionObservations = 0;
  let sweepSurfaces: SweepSurface[] | undefined;

  if (options.deterministicOnly === true) {
    outcome = { kind: "deterministic-only" };
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
      const sweep = await sweepCritique({
        projectDirectory: validated.projectDirectory,
        runDirectory,
        project: validated.project,
        flow: record.flow,
        tuples: loaded.tuples,
        priorDecisions: ruleRejections,
        priorRules,
        deterministicFindings,
        adapter: createReviewCritiqueAdapter({
          provider: validated.project.model.provider,
          model: validated.project.model.model,
          projectDirectory: validated.projectDirectory,
          dependencies: options.dependencies,
        }),
        spec,
        describeFailure: (error) =>
          validated.project.model.provider === "claude-code" &&
          error instanceof ClaudeCodeCritiqueError
            ? claudeCodeDegradationReason(
                error,
                options.dependencies?.environment ?? process.env,
              )
            : safeDegradationReason(error),
      });
      sweepSurfaces = sweep.surfaces;
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
      outcome =
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
            };
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
      const adapter = createReviewCritiqueAdapter({
        provider: validated.project.model.provider,
        model: validated.project.model.model,
        projectDirectory: validated.projectDirectory,
        dependencies: options.dependencies,
      });
      const critique = validateCritiqueResult({
        result: await adapter.critique(context),
        screenshots: context.screenshots,
        references: context.references,
        designMd: context.designMd,
        designImages: context.designImages,
      });
      const candidates = critique.findings;
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
      outcome = { kind: "full" };
    } catch (error) {
      outcome = {
        kind: "degraded",
        reason:
          validated.project.model.provider === "claude-code" &&
          error instanceof ClaudeCodeCritiqueError
            ? claudeCodeDegradationReason(
                error,
                options.dependencies?.environment ?? process.env,
              )
            : safeDegradationReason(error),
      };
    }
  }

  const describeFailure = (error: unknown) =>
    validated.project.model.provider === "claude-code" &&
    error instanceof ClaudeCodeCritiqueError
      ? claudeCodeDegradationReason(
          error,
          options.dependencies?.environment ?? process.env,
        )
      : safeDegradationReason(error);
  let advisory: ReviewRunResult["advisory"];
  if (runAdvisory && contentFlow !== undefined) {
    const review = await runAdvisoryReview({
      projectDirectory: validated.projectDirectory,
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
        provider: validated.project.model.provider,
        model: validated.project.model.model,
        projectDirectory: validated.projectDirectory,
        dependencies: options.dependencies,
      }),
      describeFailure,
      legacyColorScheme: validated.project.capture.colorScheme,
    });
    advisory = {
      path: await writeAdvisoryReview(runDirectory, review),
      review,
    };
  }

  if (outcome.kind === "full" || scaleDecisions.length > 0) {
    const rulingNames = await loadRulingNames({
      projectDirectory: validated.projectDirectory,
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
  const findings = await attachVisualEvidence(
    runDirectory,
    selection.material,
    loaded.tuples,
  );
  const deferredFindings = await attachVisualEvidence(
    runDirectory,
    selection.deferred,
    loaded.tuples,
  );
  const deterministicOccurrences =
    options.includeDeterministicOccurrences === true
      ? await attachVisualEvidence(
          runDirectory,
          finalizeDeterministicOccurrences({
            runId: loaded.runId,
            drafts: deterministic.kept,
            catalog,
          }),
          loaded.tuples,
        )
      : undefined;
  const occurrences = sweepMode
    ? await attachVisualEvidence(
        runDirectory,
        finalizeFindingOccurrences({
          runId: loaded.runId,
          drafts: [...deterministic.kept, ...modelKeptDrafts],
          catalog,
        }),
        loaded.tuples,
      )
    : undefined;
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
  const reportOptions = {
    flow: options.flow,
    commit: loaded.commit,
    build: loaded.build,
    reportCoverage: buildReviewCoverage({
      record: loaded.record,
      collapsedTupleKeys: loaded.collapsedTupleKeys,
      flow: record.flow,
      project: validated.project,
      tuples: loaded.tuples,
      commit: loaded.commit,
      allFlows:
        surfaceFlows.length === 0
          ? [record.flow]
          : surfaceFlows.map(({ flow }) => flow),
    }),
    findings,
    unruledDecisions,
    discardedDecisionObservations,
    tuples: loaded.tuples,
    coverage: reviewed.coverage,
    captureCoverage: reviewed.captureCoverage,
    deferred: deferredFindings,
    groups,
    ...(reviewed.narrowWidth === undefined
      ? {}
      : { narrowWidth: reviewed.narrowWidth }),
    outcome,
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
  const screenshots = new Map(
    await Promise.all(
      screenshotPaths.map(
        async (path) =>
          [path, pngDataUri(await readFile(join(runDirectory, path)))] as const,
      ),
    ),
  );
  checkCancelled();
  const [reportPath, htmlReportPath] = await Promise.all([
    writeReport(runDirectory, renderReport(reportOptions)),
    writeHtmlReport(
      runDirectory,
      renderReviewHtmlReport({ ...reportOptions, screenshots }),
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
    ...(sweep === undefined ? {} : { sweep }),
    ...(advisory === undefined ? {} : { advisory }),
  };
}
