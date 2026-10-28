import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { summarizeFinding } from "../baseline/summary.js";
import {
  type ArtifactTuple,
  cleanupWorkspace,
  createArtifactWorkspace,
  publishArtifacts,
  scanForSecrets,
  writeBaselineReport,
  writeTupleArtifacts,
} from "../capture/artifacts.js";
import { createBrowserLauncher } from "../capture/browser.js";
import {
  type CaptureLifetime,
  type CaptureOwnership,
  withCaptureOwnership,
} from "../capture/ownership.js";
import { createProbeLedger } from "../capture/probe-ledger.js";
import {
  captureTupleKey,
  expectedCaptureTupleKeys,
  expectedStatusByState,
  selectCaptureTuples,
} from "../capture/resolve.js";
import { coordinate, probeCoordinates } from "../capture/scope.js";
import type {
  BrowserLauncher,
  CaptureCounts,
  ProbeProgress,
} from "../capture/types.js";
import {
  type PaintedCoverageReport,
  reportedCheckCoverage,
} from "../checks/painted.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../checks/registry.js";
import type { ChecksConfig } from "../checks/types.js";
import { captureDesigns, figmaFrameLoader } from "../design/capture.js";
import { tupleDesigns } from "../design/evidence.js";
import { claudeWrapper, isFigmaHost } from "../design/source.js";
import { IdiomError } from "../errors.js";
import {
  findOptionalProjectDirectory,
  resolveProjectArgument,
} from "../project.js";
import { buildReviewCoverage } from "../report/coverage.js";
import { pngDataUri, writeHtmlReport } from "../report/html.js";
import { loadCaptureRun } from "../review/artifacts.js";
import { attachCrops } from "../review/crops.js";
import { attachFilmstrips } from "../review/filmstrips.js";
import {
  buildDeterministicDrafts,
  finalizeFindingSelection,
  writeFindings,
} from "../review/findings.js";
import {
  coordinateIndex,
  type FindingGroup,
  groupRepeatedFindings,
  writeGroups,
} from "../review/groups.js";
import { renderReviewHtmlReport } from "../review/html-report.js";
import type { CheckIssue } from "../review/issues.js";
import { renderReport, writeReport } from "../review/report.js";
import { projectIssueSummary } from "../review/summary.js";
import {
  type DesignLocation,
  designLocationSchema,
} from "../schemas/design.js";
import type { Finding } from "../schemas/finding.js";
import {
  createQuickConfiguration,
  parseProbeBudget,
  QUICK_PROBE_BUDGET_MS,
  QUICK_PROBE_MAX_CONTROLS,
  type QuickConfiguration,
} from "./config.js";
import {
  type ProbedPage,
  type QuickInteraction,
  summarizeQuickInteraction,
} from "./interaction.js";

export type QuickDependencies = CaptureLifetime & {
  onProbeProgress?: ((event: ProbeProgress) => void) | undefined;
  browserLauncher?: BrowserLauncher | undefined;
  now?: (() => Date) | undefined;
  createArtifactWorkspace?: typeof createArtifactWorkspace | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  /** Recorded Figma API responses in tests. */
  figma?: import("../design/figma/client.js").FigmaDependencies | undefined;
};

export type QuickRunResult = PaintedCoverageReport & {
  runDirectory: string;
  findingsPath: string;
  reportPath: string;
  htmlReportPath: string;
  findingCount: number;
  counts: CaptureCounts;
  findings?: Finding[];
  groups?: FindingGroup[];
  issues?: CheckIssue[];
  /** What the interaction probe did, or that it was off. */
  interaction: QuickInteraction;
};

function defaultRunName(now: Date): string {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export type LiteralCapture = {
  runDirectory: string;
  loaded: Awaited<ReturnType<typeof loadCaptureRun>>;
  reviewed: ReturnType<typeof runDeterministicChecks>;
  counts: CaptureCounts;
  /** Pages the interaction probe was asked to run on. */
  probed: ProbedPage[];
};

/**
 * Capture literal URLs into an immutable run, load it back and run every
 * deterministic check. `checks` must derive from the same settings as
 * `configuration.project.checks`, so capture-time selector marks and
 * review-time config agree.
 */
type LiteralOptions = {
  directory: string;
  finalDirectory: string;
  configuration: QuickConfiguration;
  checks: ChecksConfig;
  startedAt: Date;
  /** Names the run in interruption and failure messages. */
  label: string;
  /** Refetch pinned Figma frames instead of reusing the cache. */
  refreshDesign?: boolean | undefined;
  /**
   * Probe each page once at the first viewport in light (quick review).
   * Absent keeps the capture static (page review).
   */
  probe?: { budgetMs: number; safety: "third-party" } | undefined;
  dependencies?: QuickDependencies | undefined;
};

export async function captureLiteralPages(
  options: LiteralOptions,
): Promise<LiteralCapture> {
  return withCaptureOwnership(
    options.configuration.project.capture.maxMinutes ?? 30,
    options.dependencies,
    (owner) => captureLiteralOwned(options, owner),
  );
}

async function captureLiteralOwned(
  options: LiteralOptions,
  owner: CaptureOwnership,
): Promise<LiteralCapture> {
  const { configuration, startedAt, label } = options;
  owner.stage("workspace initialization");
  const workspace = await owner.acquire(
    (options.dependencies?.createArtifactWorkspace ?? createArtifactWorkspace)({
      projectDirectory: options.directory,
      out: options.finalDirectory,
      now: startedAt,
    }),
    cleanupWorkspace,
  );
  try {
    owner.stage("browser launch");
    const browser = await owner.acquire(
      (options.dependencies?.browserLauncher ?? createBrowserLauncher())({
        signal: owner.signal,
        onActivity: owner.stage,
      }),
      (value) => value.close(),
    );
    const browserVersion = browser.version;
    owner.check();
    const tuples: ArtifactTuple[] = [];
    const selectedTuples = [
      ...selectCaptureTuples({
        project: configuration.project,
        flow: configuration.flow,
      }),
    ];
    // The same coordinate rule configured flows use.
    const probeKeys = new Set(
      options.probe === undefined
        ? []
        : probeCoordinates(
            configuration.project,
            configuration.flow,
            selectedTuples,
          ).intended.map(captureTupleKey),
    );
    const probeLedger = createProbeLedger();
    const probed: ProbedPage[] = selectedTuples
      .filter((selected) =>
        probeKeys.has(captureTupleKey(coordinate(selected))),
      )
      .map((selected) => ({
        ...coordinate(selected),
        url: selected.state.url as string,
      }));
    for (const selected of selectedTuples) {
      owner.coordinate(selected, "tuple capture");
      const probe =
        options.probe !== undefined &&
        probeKeys.has(captureTupleKey(coordinate(selected)));
      const url = selected.state.url as string;
      const result = await browser.capture({
        signal: owner.signal,
        onActivity: owner.stage,
        onProbeProgress: (event) =>
          options.dependencies?.onProbeProgress?.({
            ...event,
            state: selected.state.id,
            viewport: selected.viewport.name,
            colorScheme: selected.colorScheme,
          }),
        project: configuration.project,
        state: selected.state,
        viewport: selected.viewport,
        colorScheme: selected.colorScheme,
        navigationUrl: url,
        tokens: { status: "not-configured" },
        ...(probe && options.probe !== undefined
          ? {
              probe: true,
              probeLedger,
              probeSafety: options.probe.safety,
              probePageBudgetMs: options.probe.budgetMs,
            }
          : {}),
      });
      tuples.push({
        flow: configuration.flow,
        state: selected.state,
        viewport: selected.viewport,
        colorScheme: selected.colorScheme,
        colorSchemeAxis: selected.colorSchemeAxis,
        metadataUrl: {
          kind: "literal",
          origin: new URL(url).origin,
          url,
        },
        result,
      });
      owner.check();
    }
    owner.stage("design capture");
    const figma = figmaFrameLoader({
      projectDirectory: options.directory,
      refresh: options.refreshDesign,
      deps: options.dependencies?.figma,
    });
    for (const tuple of tuples) {
      if (tuple.state.design === undefined) continue;
      const planned = await captureDesigns({
        state: tuple.state,
        directory: options.directory,
        project: configuration.project,
        viewport: tuple.viewport,
        colorScheme:
          tuple.colorScheme ?? configuration.project.capture.colorScheme,
        browser: async () => browser,
        figma,
      });
      tuple.designs = planned.designs;
      tuple.designNotApplicable = planned.notApplicable;
      owner.check();
    }
    owner.stage("runtime teardown");
    await owner.close(browser);
    const fallbackTimestamp = startedAt.toISOString();
    for (const tuple of tuples) {
      owner.check();
      await writeTupleArtifacts({
        stagingDirectory: workspace.stagingDirectory,
        tuple,
        source: { commit: `unavailable (${label})`, dirty: false },
        browserVersion,
        fallbackTimestamp,
      });
    }
    const counts = await writeBaselineReport({
      stagingDirectory: workspace.stagingDirectory,
      flow: configuration.flow,
      tuples,
    });
    await scanForSecrets(workspace.stagingDirectory, [
      options.dependencies?.environment ?? process.env,
    ]);
    owner.stage("artifact publication");
    await publishArtifacts(workspace, owner.signal);
    owner.check();

    const loaded = await loadCaptureRun({
      runDirectory: workspace.finalDirectory,
      expectedFlow: configuration.flow.id,
      expectedStatusByState: expectedStatusByState(configuration.flow),
      stateOrder: configuration.flow.states.map((state) => state.id),
      viewportOrder: configuration.project.viewports.map(
        (viewport) => viewport.name,
      ),
      colorSchemeOrder: configuration.project.colorSchemes,
      legacyColorScheme: configuration.project.capture.colorScheme,
    });
    const reviewed = runDeterministicChecks(
      loaded.tuples,
      expectedCaptureTupleKeys({
        collapsed: loaded.collapsedTupleKeys,
        project: configuration.project,
        flow: configuration.flow,
      }),
      options.checks,
    );
    return {
      runDirectory: workspace.finalDirectory,
      loaded,
      reviewed,
      counts,
      probed,
    };
  } catch (error) {
    if (error instanceof IdiomError) throw error;
    throw new IdiomError(
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await owner.close(workspace);
  }
}

/** Inline every captured screenshot and write report.md and report.html. */
export async function writeReviewReports(
  runDirectory: string,
  reportOptions: Parameters<typeof renderReport>[0],
): Promise<{ reportPath: string; htmlReportPath: string }> {
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
  const [reportPath, htmlReportPath] = await Promise.all([
    writeReport(runDirectory, renderReport(reportOptions)),
    writeHtmlReport(
      runDirectory,
      renderReviewHtmlReport({ ...reportOptions, screenshots }),
    ),
  ]);
  return { reportPath, htmlReportPath };
}

/**
 * What `quick --design <value>` compares against: a Figma frame or Claude
 * share URL passes through as a design string, any other HTTP(S) URL is a
 * live reference site, and anything else is a local path (HTML or image).
 */
export function quickDesignReference(
  value: string,
  cwd: string,
): DesignLocation {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    if (isFigmaHost(trimmed) || claudeWrapper(trimmed)) return trimmed;
    return { site: trimmed };
  }
  return resolve(cwd, trimmed);
}

export async function runQuick(options: {
  urls: string[];
  design?: string | undefined;
  viewports?: Array<"desktop" | "mobile"> | undefined;
  /** Run the safe interaction probe; default true. */
  probe?: boolean | undefined;
  /** Per-page probe budget in milliseconds (CLI `--probe-budget`). */
  probeBudgetMs?: string | number | undefined;
  literal?: boolean | undefined;
  materializeAllDeterministic?: boolean | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  out?: string | undefined;
  dependencies?: QuickDependencies | undefined;
}): Promise<QuickRunResult> {
  const directory = resolveProjectArgument(options.project, options.cwd);
  const configured =
    options.literal === true
      ? undefined
      : await findOptionalProjectDirectory(directory);
  if (configured !== undefined) {
    throw new IdiomError(
      `quick review is unavailable inside configured Idiom project ${configured}; run \`idiom validate\` and then \`idiom review <flow>\` so declared states and project guidance are not bypassed`,
    );
  }
  let design: DesignLocation | undefined;
  if (options.design !== undefined) {
    if (options.urls.length !== 1)
      throw new IdiomError("--design compares one page; pass a single URL");
    const parsed = designLocationSchema.safeParse(
      quickDesignReference(options.design, directory),
    );
    if (!parsed.success)
      throw new IdiomError(
        `invalid --design: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    design = parsed.data;
  }
  const probing = options.probe !== false;
  if (!probing && options.probeBudgetMs !== undefined)
    throw new IdiomError("--probe-budget requires the probe; drop --no-probe");
  const probeBudgetMs =
    options.probeBudgetMs === undefined
      ? QUICK_PROBE_BUDGET_MS
      : parseProbeBudget(options.probeBudgetMs);
  const configuration = createQuickConfiguration(options.urls, {
    viewports: options.viewports,
    design,
    ...(probing ? { probe: { maxControls: QUICK_PROBE_MAX_CONTROLS } } : {}),
  });
  const now = options.dependencies?.now ?? (() => new Date());
  const startedAt = now();
  const finalDirectory =
    options.out === undefined
      ? join(
          directory,
          "idiom-quick-reports",
          options.literal
            ? `${defaultRunName(startedAt)}-${randomUUID().slice(0, 8)}`
            : defaultRunName(startedAt),
        )
      : resolve(directory, options.out);
  const { runDirectory, loaded, reviewed, counts, probed } =
    await captureLiteralPages({
      directory,
      finalDirectory,
      configuration,
      checks: checksConfigFrom(configuration.project.checks),
      startedAt,
      label: "quick review",
      ...(probing
        ? { probe: { budgetMs: probeBudgetMs, safety: "third-party" as const } }
        : {}),
      dependencies: options.dependencies,
    });
  const interaction = summarizeQuickInteraction({
    tuples: loaded.tuples,
    probed,
    enabled: probing,
    budgetMs: probeBudgetMs,
    maxControls: configuration.project.checks.probe.maxControls,
  });
  try {
    options.dependencies?.signal?.throwIfAborted();
    const drafts = buildDeterministicDrafts({
      config: checksConfigFrom(configuration.project.checks),
      tuples: loaded.tuples,
      runId: loaded.runId,
      entries: reviewed.candidates,
      legacyColorScheme: configuration.project.capture.colorScheme,
    });
    const selection = finalizeFindingSelection({
      runId: loaded.runId,
      drafts,
      maxFindings: options.materializeAllDeterministic
        ? Number.POSITIVE_INFINITY
        : 5,
    });
    const findings = await attachFilmstrips(
      runDirectory,
      options.materializeAllDeterministic
        ? await attachCrops(runDirectory, selection.material, loaded.tuples)
        : selection.material,
      loaded.tuples,
    );
    const deferred = await attachFilmstrips(
      runDirectory,
      selection.deferred,
      loaded.tuples,
    );
    const groups = groupRepeatedFindings(
      [...findings, ...deferred],
      coordinateIndex(drafts),
      new Set(deferred.map((finding) => finding.id)),
    );
    const primaryActionSelectors = loaded.tuples.flatMap((tuple) =>
      tuple.observations?.version === 2
        ? tuple.observations.elements
            .filter((element) => element.signals?.paint?.primaryAction === true)
            .map((element) => element.selector)
        : [],
    );
    const summaries = new Map(
      findings.map((finding) => [
        finding.id,
        summarizeFinding(finding, { runDirectory }, directory),
      ]),
    );
    const { issues } = projectIssueSummary({
      findings,
      groups,
      summaries,
      primaryActionSelectors,
    });
    options.dependencies?.signal?.throwIfAborted();
    const findingsPath = await writeFindings(runDirectory, findings);
    if (options.materializeAllDeterministic) {
      await writeGroups(runDirectory, groups);
      await writeFile(
        join(runDirectory, "mcp-detail.json"),
        JSON.stringify({ version: 1, issues, interaction }),
      );
    }
    const outcome = {
      kind: "quick" as const,
      targets: configuration.urls,
    };
    const reportOptions = {
      flow: configuration.flow.id,
      commit: loaded.commit,
      findings,
      tuples: loaded.tuples,
      coverage: reviewed.coverage,
      captureCoverage: reviewed.captureCoverage,
      deferred: deferred,
      ...(reviewed.narrowWidth === undefined
        ? {}
        : { narrowWidth: reviewed.narrowWidth }),
      outcome,
      reportCoverage: buildReviewCoverage({
        collapsedTupleKeys: loaded.collapsedTupleKeys,
        flow: configuration.flow,
        project: configuration.project,
        tuples: loaded.tuples,
        commit: loaded.commit,
        interaction,
      }),
    };
    const { reportPath, htmlReportPath } = await writeReviewReports(
      runDirectory,
      reportOptions,
    );
    await scanForSecrets(runDirectory, [
      options.dependencies?.environment ?? process.env,
    ]);
    options.dependencies?.signal?.throwIfAborted();
    return {
      runDirectory,
      findingsPath,
      reportPath,
      htmlReportPath,
      findingCount: findings.length,
      ...reportedCheckCoverage(reviewed.coverage),
      counts,
      interaction,
      ...(options.materializeAllDeterministic
        ? { findings, groups, issues }
        : {}),
    };
  } catch (error) {
    if (error instanceof IdiomError) throw error;
    throw new IdiomError(
      `quick review failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
