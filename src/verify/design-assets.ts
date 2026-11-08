import { join } from "node:path";
import {
  assertedStates,
  type DesignAssetBrief,
} from "../brief/design-asset.js";
import {
  expectedStatusByState,
  selectCaptureTuples,
} from "../capture/resolve.js";
import { type CaptureDependencies, runCapture } from "../capture/run.js";
import {
  briefLabel,
  evaluateBriefAssertions,
} from "../checks/brief-mismatch.js";
import { computeBriefCoverage } from "../coverage/briefs.js";
import { annotateDeclaredExpectations } from "../findings/settings.js";
import { escapeHtml } from "../report/html.js";
import { loadCaptureRun } from "../review/artifacts.js";
import type { Flow } from "../schemas/flow.js";
import type { ValidationResult } from "../validation.js";

export type DesignAssetVerdict = {
  slug: string;
  title: string;
  asset: string;
  passed: boolean;
  /** Assertions, not tuples: held everywhere measured, broke somewhere, never measured. */
  held: number;
  mismatched: number;
  unmeasured: number;
  failures: string[];
  notes: string[];
};

export type DesignAssetVerification = {
  briefs: DesignAssetVerdict[];
  passed: boolean;
};

/**
 * Captures every asserted state of `flow` once, at every configured viewport
 * and scheme, and judges each pinned brief's assertions. Mismatches fail;
 * unmeasured assertions are reported, as `idiom check` reports them.
 */
export async function verifyDesignAssets(options: {
  validated: ValidationResult;
  flow: Flow;
  briefs: readonly DesignAssetBrief[];
  capturesRoot: string;
  dependencies?: CaptureDependencies | undefined;
}): Promise<DesignAssetVerification> {
  const { validated, flow } = options;
  const states = assertedStates(options.briefs)
    .filter((entry) => entry.flow === flow.id)
    .map((entry) => entry.state);
  const tuples = selectCaptureTuples({ project: validated.project, flow })
    .filter((tuple) => states.includes(tuple.state.id))
    .map((tuple) => ({
      state: tuple.state.id,
      viewport: tuple.viewport.name,
      colorScheme: tuple.colorScheme,
    }));
  const run = await runCapture({
    projectDirectory: validated.projectDirectory,
    project: validated.project,
    flow,
    out: join(options.capturesRoot, "design-asset"),
    deduplicateCombinations: false,
    tuples,
    dependencies: options.dependencies,
  });
  const loaded = await loadCaptureRun({
    runDirectory: run.runDirectory,
    expectedFlow: flow.id,
    expectedStatusByState: expectedStatusByState(flow),
    legacyColorScheme: validated.project.capture.colorScheme,
  });
  annotateDeclaredExpectations(loaded.tuples, flow);
  const captureFailures = loaded.tuples.flatMap((tuple) =>
    tuple.failure === undefined
      ? []
      : [
          `capture failed at ${flow.id}/${tuple.state}/${tuple.viewport}/${tuple.colorScheme}: ${tuple.failure.message}`,
        ],
  );
  const measured = loaded.tuples.filter((tuple) => tuple.failure === undefined);
  const briefs = options.briefs.map((brief): DesignAssetVerdict => {
    const failures = [...captureFailures];
    for (const tuple of measured)
      for (const result of evaluateBriefAssertions(tuple, [brief]))
        for (const failure of result.failures)
          failures.push(
            `${briefLabel(brief)}, criterion "${result.criterion.statement}": ${failure.detail} (${tuple.state}/${tuple.viewport}/${tuple.colorScheme})`,
          );
    const coverage = computeBriefCoverage(measured, [brief], flow.id).entries;
    const assertions = coverage.flatMap((entry) =>
      entry.status === "checked" ? entry.assertions : [],
    );
    const mismatched = assertions.filter((entry) => entry.mismatched > 0);
    const unmeasured = assertions.filter(
      (entry) => entry.mismatched === 0 && entry.passed === 0,
    );
    const notCaptured = coverage.flatMap((entry) =>
      entry.status === "not-captured"
        ? [`states ${entry.states.join(", ")} were not captured`]
        : [],
    );
    return {
      slug: brief.slug,
      title: brief.title,
      asset: brief.source.name,
      passed: failures.length === 0,
      held: assertions.length - mismatched.length - unmeasured.length,
      mismatched: mismatched.length,
      unmeasured: unmeasured.length,
      failures,
      notes: [
        ...notCaptured,
        ...unmeasured.map(
          (entry) =>
            `criterion ${entry.criterion} assertion ${entry.assertion} (${entry.form} ${entry.selector} at ${entry.state}) unmeasured: ${entry.unmeasured.join("; ")}`,
        ),
      ],
    };
  });
  return { briefs, passed: briefs.every((brief) => brief.passed) };
}

function summary(brief: DesignAssetVerdict): string {
  return `Brief "${brief.title}" (${brief.slug}), design asset ${brief.asset}: ${brief.passed ? "passed" : "failed"}; ${brief.held} held, ${brief.mismatched} mismatched, ${brief.unmeasured} unmeasured`;
}

export function designAssetMarkdown(result: DesignAssetVerification): string[] {
  return [
    "## Design asset",
    "",
    `The build was checked against the design asset${result.briefs.length === 1 ? "" : "s"} pinned to it: **${result.passed ? "passed" : "failed"}**.`,
    "",
    ...result.briefs.flatMap((brief) => [
      `- ${summary(brief)}`,
      ...brief.failures.map((failure) => `  - ${failure}`),
      ...brief.notes.map((note) => `  - ${note}`),
    ]),
    "",
  ];
}

export function designAssetHtml(result: DesignAssetVerification): string {
  return `<section><h2>Design asset</h2><p>The build was checked against the design asset${result.briefs.length === 1 ? "" : "s"} pinned to it: <strong>${result.passed ? "passed" : "failed"}</strong>.</p><ul>${result.briefs
    .map(
      (brief) =>
        `<li>${escapeHtml(summary(brief))}${
          brief.failures.length + brief.notes.length === 0
            ? ""
            : `<ul>${[...brief.failures, ...brief.notes]
                .map((line) => `<li>${escapeHtml(line)}</li>`)
                .join("")}</ul>`
        }</li>`,
    )
    .join("")}</ul></section>`;
}
