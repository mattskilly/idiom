import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  expectedCaptureTupleKeys,
  expectedStatusByState,
  selectCaptureTuples,
} from "../capture/resolve.js";
import type { BrowserLauncher, CaptureCounts } from "../capture/types.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../checks/registry.js";
import type { ChecksConfig } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import {
  findOptionalProjectDirectory,
  resolveProjectArgument,
} from "../project.js";
import { buildReviewCoverage } from "../report/coverage.js";
import { pngDataUri, writeHtmlReport } from "../report/html.js";
import { loadCaptureRun } from "../review/artifacts.js";
import {
  buildDeterministicDrafts,
  finalizeFindingSelection,
  writeFindings,
} from "../review/findings.js";
import { renderReviewHtmlReport } from "../review/html-report.js";
import { renderReport, writeReport } from "../review/report.js";
import { createQuickConfiguration, type QuickConfiguration } from "./config.js";

export type QuickDependencies = {
  browserLauncher?: BrowserLauncher | undefined;
  now?: (() => Date) | undefined;
  createArtifactWorkspace?: typeof createArtifactWorkspace | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
};

export type QuickRunResult = {
  runDirectory: string;
  findingsPath: string;
  reportPath: string;
  htmlReportPath: string;
  findingCount: number;
  counts: CaptureCounts;
};

function defaultRunName(now: Date): string {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export type LiteralCapture = {
  runDirectory: string;
  loaded: Awaited<ReturnType<typeof loadCaptureRun>>;
  reviewed: ReturnType<typeof runDeterministicChecks>;
  counts: CaptureCounts;
};

/**
 * Capture literal URLs into an immutable run, load it back and run every
 * deterministic check. `checks` must derive from the same settings as
 * `configuration.project.checks`, so capture-time selector marks and
 * review-time config agree.
 */
export async function captureLiteralPages(options: {
  directory: string;
  finalDirectory: string;
  configuration: QuickConfiguration;
  checks: ChecksConfig;
  startedAt: Date;
  /** Names the run in interruption and failure messages. */
  label: string;
  dependencies?: QuickDependencies | undefined;
}): Promise<LiteralCapture> {
  const { configuration, startedAt, label } = options;
  const workspace = await (
    options.dependencies?.createArtifactWorkspace ?? createArtifactWorkspace
  )({
    projectDirectory: options.directory,
    out: options.finalDirectory,
    now: startedAt,
  });
  let browser: Awaited<ReturnType<BrowserLauncher>> | undefined;
  let interrupted: NodeJS.Signals | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const closeBrowser = async () => {
    cleanupPromise = (cleanupPromise ?? Promise.resolve()).then(async () => {
      const active = browser;
      browser = undefined;
      await active?.close().catch(() => undefined);
    });
    return cleanupPromise;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted = signal;
    void closeBrowser().catch(() => undefined);
  };
  const sigint = () => onSignal("SIGINT");
  const sigterm = () => onSignal("SIGTERM");
  const assertNotInterrupted = () => {
    if (interrupted !== undefined)
      throw new IdiomError(`${label} interrupted by ${interrupted}`);
  };
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);

  try {
    browser = await (
      options.dependencies?.browserLauncher ?? createBrowserLauncher()
    )();
    const browserVersion = browser.version;
    assertNotInterrupted();
    const tuples: ArtifactTuple[] = [];
    for (const selected of selectCaptureTuples({
      project: configuration.project,
      flow: configuration.flow,
    })) {
      const url = selected.state.url as string;
      const result = await browser.capture({
        project: configuration.project,
        state: selected.state,
        viewport: selected.viewport,
        colorScheme: selected.colorScheme,
        navigationUrl: url,
        tokens: { status: "not-configured" },
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
      assertNotInterrupted();
    }
    await closeBrowser();
    const fallbackTimestamp = startedAt.toISOString();
    for (const tuple of tuples) {
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
    await publishArtifacts(workspace);

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
    };
  } catch (error) {
    if (error instanceof IdiomError) throw error;
    throw new IdiomError(
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    await closeBrowser().catch(() => undefined);
    await cleanupWorkspace(workspace);
  }
}

/** Inline every captured screenshot and write report.md and report.html. */
export async function writeReviewReports(
  runDirectory: string,
  reportOptions: Parameters<typeof renderReport>[0],
): Promise<{ reportPath: string; htmlReportPath: string }> {
  const screenshotPaths = [
    ...new Set(
      reportOptions.tuples.flatMap((tuple) =>
        tuple.screenshotPath === undefined ? [] : [tuple.screenshotPath],
      ),
    ),
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

export async function runQuick(options: {
  urls: string[];
  project?: string | undefined;
  cwd?: string | undefined;
  out?: string | undefined;
  dependencies?: QuickDependencies | undefined;
}): Promise<QuickRunResult> {
  const directory = resolveProjectArgument(options.project, options.cwd);
  const configured = await findOptionalProjectDirectory(directory);
  if (configured !== undefined) {
    throw new IdiomError(
      `quick review is unavailable inside configured Idiom project ${configured}; run \`idiom validate\` and then \`idiom review <flow>\` so declared states and project guidance are not bypassed`,
    );
  }
  const configuration = createQuickConfiguration(options.urls);
  const now = options.dependencies?.now ?? (() => new Date());
  const startedAt = now();
  const finalDirectory =
    options.out === undefined
      ? join(directory, "idiom-quick-reports", defaultRunName(startedAt))
      : resolve(directory, options.out);
  const { runDirectory, loaded, reviewed, counts } = await captureLiteralPages({
    directory,
    finalDirectory,
    configuration,
    checks: checksConfigFrom(configuration.project.checks),
    startedAt,
    label: "quick review",
    dependencies: options.dependencies,
  });
  try {
    const selection = finalizeFindingSelection({
      runId: loaded.runId,
      drafts: buildDeterministicDrafts({
        runId: loaded.runId,
        entries: reviewed.candidates,
        legacyColorScheme: configuration.project.capture.colorScheme,
      }),
      maxFindings: 5,
    });
    const findings = selection.material;
    const findingsPath = await writeFindings(runDirectory, findings);
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
      deferred: selection.deferred,
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
      }),
    };
    const { reportPath, htmlReportPath } = await writeReviewReports(
      runDirectory,
      reportOptions,
    );
    return {
      runDirectory,
      findingsPath,
      reportPath,
      htmlReportPath,
      findingCount: findings.length,
      counts,
    };
  } catch (error) {
    if (error instanceof IdiomError) throw error;
    throw new IdiomError(
      `quick review failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
