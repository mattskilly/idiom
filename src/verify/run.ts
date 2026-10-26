import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  captureTupleKey,
  expectedCaptureTupleKeys,
  expectedStatusByState,
  selectCaptureTuples,
  selectColorSchemes,
} from "../capture/resolve.js";
import type { CaptureDependencies } from "../capture/run.js";
import { runCapture } from "../capture/run.js";
import { projectChecksConfig } from "../checks/project-config.js";
import { IdiomError } from "../errors.js";
import { buildVerificationCoverage } from "../report/coverage.js";
import { pngDataUri, writeHtmlReport } from "../report/html.js";
import { loadCaptureRun } from "../review/artifacts.js";
import { validateProject } from "../validation.js";
import {
  createAttachmentManifest,
  validateAttachmentManifest,
  writeAttachmentManifest,
} from "./attachments.js";
import { type GitTopology, resolveBaseline } from "./baseline.js";
import { writeBeforeAfterComposite } from "./compare.js";
import {
  evaluateVerification,
  type VerificationEvaluation,
} from "./evaluate.js";
import { renderVerificationHtmlReport } from "./html-report.js";
import {
  assertReplaceable,
  exists,
  publish,
  verifyOutputOwner,
} from "./output.js";
import { renderVerificationReport, writeVerificationReport } from "./report.js";
import { readVerificationSpec, selectFindingTuples } from "./spec.js";

export type VerifyDependencies = {
  capture?: CaptureDependencies | undefined;
  gitTopology?: GitTopology | undefined;
  now?: (() => Date) | undefined;
};

export type VerifyRunResult = {
  reportPath: string;
  htmlReportPath: string;
  outputDirectory: string;
  outcome: "fixed" | "failed" | "no-findings";
  passed: boolean;
  findingCount: number;
  causes: string[];
  /** Available only after calibrated evaluation and report publication. */
  verdicts?: VerificationEvaluation["findings"] | undefined;
  newBlockers?: VerificationEvaluation["newBlockers"] | undefined;
  newFindings?: VerificationEvaluation["newFindings"] | undefined;
  coverage?: import("../report/coverage.js").ReportCoverage | undefined;
};

function defaultOutput(projectDirectory: string, now: Date): string {
  return join(
    projectDirectory,
    ".idiom",
    "reports",
    `verify-${now.toISOString().replaceAll(":", "-").replaceAll(".", "-")}`,
  );
}

export async function runVerify(options: {
  flow: string;
  spec: string;
  project?: string | undefined;
  /** Refetch pinned Figma frames before the first recapture; the second reuses them. */
  refreshDesign?: boolean | undefined;
  cwd?: string | undefined;
  against?: string | undefined;
  out?: string | undefined;
  fullFlow?: boolean | undefined;
  dependencies?: VerifyDependencies | undefined;
}): Promise<VerifyRunResult> {
  const checkCancelled = () =>
    options.dependencies?.capture?.signal?.throwIfAborted();
  checkCancelled();
  const validated = await validateProject({
    project: options.project,
    flow: options.flow,
    cwd: options.cwd,
  });
  const flow = validated.flows[0]?.flow;
  if (flow === undefined || flow.id !== options.flow)
    throw new IdiomError(`requested flow ${options.flow} was not validated`);
  const specPath = isAbsolute(options.spec)
    ? options.spec
    : resolve(validated.projectDirectory, options.spec);
  const findings = await readVerificationSpec(specPath);
  const findingTuples = selectFindingTuples({
    findings,
    flow,
    project: validated.project,
  });
  const tuples = options.fullFlow
    ? selectCaptureTuples({ project: validated.project, flow }).map(
        (tuple) => ({
          state: tuple.state.id,
          viewport: tuple.viewport.name,
          colorScheme: tuple.colorScheme,
        }),
      )
    : findingTuples;
  const now = options.dependencies?.now?.() ?? new Date();
  const outputDirectory =
    options.out === undefined
      ? defaultOutput(validated.projectDirectory, now)
      : resolve(validated.projectDirectory, options.out);
  if (options.out === undefined && (await exists(outputDirectory)))
    throw new IdiomError(
      `default verify output already exists; retry with --out for atomic replacement: ${outputDirectory}`,
    );
  await assertReplaceable(outputDirectory, verifyOutputOwner);
  const staging = await mkdtemp(
    join(dirname(outputDirectory), `.${basename(outputDirectory)}.staging-`),
  ).catch(async () => {
    await mkdir(dirname(outputDirectory), { recursive: true });
    return mkdtemp(
      join(dirname(outputDirectory), `.${basename(outputDirectory)}.staging-`),
    );
  });
  let published = false;
  let capturesRoot: string | undefined;
  try {
    const manifest = createAttachmentManifest(tuples);
    if (findings.length === 0) {
      const reportCoverage = buildVerificationCoverage({
        flow,
        project: validated.project,
        tuples,
        successfulTuples: 0,
      });
      const report = renderVerificationReport({
        flow: options.flow,
        baselineRunId: "not applicable",
        currentRunA: "not run",
        currentRunB: "not run",
        manifest,
        noFindings: true,
        reportCoverage,
      });
      const reportPath = await writeVerificationReport(staging, report);
      const htmlReportPath = await writeHtmlReport(
        staging,
        renderVerificationHtmlReport({
          flow: options.flow,
          baselineRunId: "not applicable",
          currentRunA: "not run",
          currentRunB: "not run",
          manifest,
          noFindings: true,
          reportCoverage,
        }),
      );
      await writeAttachmentManifest(staging, manifest);
      await writeFile(
        join(staging, verifyOutputOwner.marker),
        verifyOutputOwner.text,
      );
      await validateAttachmentManifest({ outputDirectory: staging, manifest });
      checkCancelled();
      await publish(staging, outputDirectory, verifyOutputOwner);
      published = true;
      return {
        reportPath: join(outputDirectory, basename(reportPath)),
        htmlReportPath: join(outputDirectory, basename(htmlReportPath)),
        outputDirectory,
        outcome: "no-findings",
        passed: true,
        findingCount: 0,
        causes: [],
        verdicts: [],
        newBlockers: [],
      };
    }

    const baseline = await resolveBaseline({
      projectDirectory: validated.projectDirectory,
      findings,
      against: options.against,
      gitTopology: options.dependencies?.gitTopology,
    });
    capturesRoot = await mkdtemp(join(tmpdir(), "idiom-verify-captures-"));
    checkCancelled();
    const runA = await runCapture({
      projectDirectory: validated.projectDirectory,
      project: validated.project,
      flow,
      out: join(capturesRoot, "current-a"),
      deduplicateCombinations: false,
      refreshDesign: options.refreshDesign,
      tuples,
      dependencies: options.dependencies?.capture,
    });
    checkCancelled();
    const runB = await runCapture({
      projectDirectory: validated.projectDirectory,
      project: validated.project,
      flow,
      out: join(capturesRoot, "current-b"),
      deduplicateCombinations: false,
      tuples,
      dependencies: options.dependencies?.capture,
    });
    checkCancelled();
    const stateOrder = flow.states.map(({ id }) => id);
    const viewportOrder =
      flow.viewports ?? validated.project.viewports.map(({ name }) => name);
    const colorSchemeOrder = selectColorSchemes(validated.project, flow);
    const statuses = expectedStatusByState(flow);
    const [baselineLoaded, loadedA, loadedB] = await Promise.all([
      loadCaptureRun({
        runDirectory: baseline.runDirectory,
        expectedFlow: options.flow,
        expectedStatusByState: statuses,
        stateOrder,
        viewportOrder,
        colorSchemeOrder,
        legacyColorScheme: validated.project.capture.colorScheme,
      }),
      loadCaptureRun({
        runDirectory: runA.runDirectory,
        expectedFlow: options.flow,
        expectedStatusByState: statuses,
        stateOrder,
        viewportOrder,
        colorSchemeOrder,
        legacyColorScheme: validated.project.capture.colorScheme,
      }),
      loadCaptureRun({
        runDirectory: runB.runDirectory,
        expectedFlow: options.flow,
        expectedStatusByState: statuses,
        stateOrder,
        viewportOrder,
        colorSchemeOrder,
        legacyColorScheme: validated.project.capture.colorScheme,
      }),
    ]);
    if (runA.counts.failed > 0 || runB.counts.failed > 0) {
      const coordinate = (tuple: (typeof loadedA.tuples)[number]) =>
        `${tuple.state}/${tuple.viewport}${tuple.colorSchemeAxis ? `/${tuple.colorScheme ?? validated.project.capture.colorScheme}` : ""}`;
      const failures = [
        ...loadedA.tuples.flatMap((tuple) =>
          tuple.failure === undefined
            ? []
            : [
                `A ${coordinate(tuple)} ${tuple.failure.stage}: ${tuple.failure.message}`,
              ],
        ),
        ...loadedB.tuples.flatMap((tuple) =>
          tuple.failure === undefined
            ? []
            : [
                `B ${coordinate(tuple)} ${tuple.failure.stage}: ${tuple.failure.message}`,
              ],
        ),
      ];
      throw new IdiomError(
        `fresh verification capture failed (${runA.counts.failed} in A, ${runB.counts.failed} in B): ${failures.join("; ")}`,
      );
    }
    const selectedKeys = new Set(
      tuples.map(
        (tuple) =>
          `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? validated.project.capture.colorScheme}`,
      ),
    );
    const baselineTuples = baselineLoaded.tuples.filter((tuple) =>
      selectedKeys.has(
        `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? validated.project.capture.colorScheme}`,
      ),
    );
    for (const finding of findings) {
      const sourceTuple = baselineTuples.find(
        (tuple) =>
          tuple.state === finding.state &&
          tuple.viewport === finding.viewport &&
          (tuple.colorScheme ?? validated.project.capture.colorScheme) ===
            (finding.colorScheme ?? validated.project.capture.colorScheme),
      );
      if (sourceTuple === undefined || sourceTuple.commit !== finding.commit)
        throw new IdiomError(
          `baseline metadata does not match finding ${finding.id} commit/state/viewport${finding.colorScheme === undefined ? "" : "/colorScheme"}`,
        );
    }
    await cp(runA.runDirectory, join(staging, "current-a"), {
      recursive: true,
    });
    await cp(runB.runDirectory, join(staging, "current-b"), {
      recursive: true,
    });
    const comparisons = [];
    for (const composite of manifest.composites) {
      const beforeTuple = baselineTuples.find(
        (tuple) =>
          tuple.state === composite.state &&
          tuple.viewport === composite.viewport &&
          (tuple.colorScheme ?? validated.project.capture.colorScheme) ===
            (composite.colorScheme ?? validated.project.capture.colorScheme),
      );
      const afterTuple = loadedB.tuples.find(
        (tuple) =>
          tuple.state === composite.state &&
          tuple.viewport === composite.viewport &&
          (tuple.colorScheme ?? validated.project.capture.colorScheme) ===
            (composite.colorScheme ?? validated.project.capture.colorScheme),
      );
      if (
        beforeTuple?.screenshotPath === undefined ||
        afterTuple?.screenshotPath === undefined
      )
        throw new IdiomError(
          `cannot create paired image for ${composite.state}/${composite.viewport}${composite.colorScheme === undefined ? "" : `/${composite.colorScheme}`}: screenshot missing`,
        );
      const beforePath = join(
        baseline.runDirectory,
        beforeTuple.screenshotPath,
      );
      const afterPath = join(runB.runDirectory, afterTuple.screenshotPath);
      const [beforeSource, afterSource] = await Promise.all([
        readFile(beforePath),
        readFile(afterPath),
      ]);
      await writeBeforeAfterComposite({
        beforePath,
        afterPath,
        outputPath: join(staging, composite.path),
        beforeSource,
        afterSource,
      });
      comparisons.push({
        state: composite.state,
        viewport: composite.viewport,
        ...(composite.colorScheme === undefined
          ? {}
          : { colorScheme: composite.colorScheme }),
        before: pngDataUri(beforeSource),
        after: pngDataUri(afterSource),
      });
    }

    let evaluation: VerificationEvaluation | undefined;
    let diagnostic: string | undefined;
    try {
      checkCancelled();
      if (options.fullFlow) {
        const expected = expectedCaptureTupleKeys({
          project: validated.project,
          flow,
        });
        for (const [label, loaded] of [
          ["baseline", baselineLoaded],
          ["A", loadedA],
          ["B", loadedB],
        ] as const) {
          const actual = loaded.tuples.map((tuple) =>
            captureTupleKey({
              ...tuple,
              colorScheme:
                tuple.colorScheme ?? validated.project.capture.colorScheme,
            }),
          );
          if (
            expected.some((key) => !actual.includes(key)) ||
            actual.some((key) => !expected.includes(key)) ||
            new Set(actual).size !== actual.length ||
            loaded.tuples.some(
              (tuple) =>
                tuple.failure || tuple.mismatches.length || !tuple.observations,
            )
          )
            throw new IdiomError(
              `${label} requires complete successful full-flow coverage; obtain a full idiom_check or idiom_fix_plan first`,
            );
        }
      }
      evaluation = evaluateVerification({
        fullFlow: options.fullFlow,
        findings,
        baseline: baselineTuples,
        currentA: loadedA.tuples,
        currentB: loadedB.tuples,
        legacyColorScheme: validated.project.capture.colorScheme,
        checksConfig: await projectChecksConfig(validated),
        expectedTupleKeys: expectedCaptureTupleKeys({
          collapsed: loadedB.collapsedTupleKeys,
          project: validated.project,
          flow,
        }),
      });
    } catch (error) {
      checkCancelled();
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    const currentCommit =
      loadedA.commit === loadedB.commit
        ? loadedB.commit
        : `unavailable (calibration commits disagree: ${loadedA.commit} / ${loadedB.commit})`;
    const reportCoverage = buildVerificationCoverage({
      flow,
      project: validated.project,
      tuples,
      successfulTuples: loadedB.tuples.filter(
        (tuple) => tuple.failure === undefined && tuple.mismatches.length === 0,
      ).length,
      collapsedTupleKeys: loadedB.collapsedTupleKeys,
      baselineCommit: baselineLoaded.commit,
      currentCommit,
    });
    const report = renderVerificationReport({
      flow: options.flow,
      baselineRunId: baselineLoaded.runId,
      currentRunA: loadedA.runId,
      currentRunB: loadedB.runId,
      manifest,
      reportCoverage,
      ...(evaluation === undefined
        ? { diagnostic: diagnostic ?? "unknown comparison failure" }
        : { evaluation }),
    });
    await writeVerificationReport(staging, report);
    await writeHtmlReport(
      staging,
      renderVerificationHtmlReport({
        flow: options.flow,
        baselineRunId: baselineLoaded.runId,
        currentRunA: loadedA.runId,
        currentRunB: loadedB.runId,
        manifest,
        comparisons,
        reportCoverage,
        ...(evaluation === undefined
          ? { diagnostic: diagnostic ?? "unknown comparison failure" }
          : { evaluation }),
      }),
    );
    await writeAttachmentManifest(staging, manifest);
    await writeFile(
      join(staging, verifyOutputOwner.marker),
      verifyOutputOwner.text,
    );
    await validateAttachmentManifest({ outputDirectory: staging, manifest });
    checkCancelled();
    await publish(staging, outputDirectory, verifyOutputOwner);
    published = true;
    const causes =
      evaluation === undefined
        ? [diagnostic ?? "comparison failed"]
        : [
            ...evaluation.findings
              .filter(({ status }) => status !== "fixed")
              .map(({ finding, reason }) => `${finding.id}: ${reason}`),
            ...evaluation.newBlockers,
          ];
    return {
      reportPath: join(outputDirectory, "before-after.md"),
      htmlReportPath: join(outputDirectory, "report.html"),
      outputDirectory,
      outcome: evaluation?.passed === true ? "fixed" : "failed",
      passed: evaluation?.passed === true,
      coverage: reportCoverage,
      findingCount: findings.length,
      causes,
      ...(evaluation === undefined
        ? {}
        : {
            verdicts: evaluation.findings,
            newBlockers: evaluation.newBlockers,
            ...(evaluation.newFindings === undefined
              ? {}
              : { newFindings: evaluation.newFindings }),
          }),
    };
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
    if (capturesRoot !== undefined)
      await rm(capturesRoot, { recursive: true, force: true });
  }
}
