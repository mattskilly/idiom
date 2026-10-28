import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CaptureCounts } from "../capture/types.js";
import { pageSections } from "../checks/page-content.js";
import { checksConfigFrom } from "../checks/registry.js";
import { ClaudeCodeCritiqueError } from "../critique/claude-code.js";
import {
  loadReferenceContext,
  tupleCritiqueMaterial,
} from "../critique/context.js";
import { referenceFromFile } from "../critique/reference-file.js";
import { validateCritiqueResult } from "../critique/schema.js";
import type {
  CritiqueInput,
  PageCritiqueContext,
  PageFocusArea,
  ReferenceRef,
} from "../critique/types.js";
import { IdiomError } from "../errors.js";
import {
  findOptionalProjectDirectory,
  resolveProjectArgument,
} from "../project.js";
import { createQuickConfiguration } from "../quick/config.js";
import {
  captureLiteralPages,
  type QuickDependencies,
  writeReviewReports,
} from "../quick/run.js";
import { buildReviewCoverage } from "../report/coverage.js";
import { designSourceSchema } from "../schemas/design.js";
import type { Finding } from "../schemas/finding.js";
import { checksConfigSchema, type Project } from "../schemas/project.js";
import { validateProjectConfiguration } from "../validation.js";
import { attachCrops } from "./crops.js";
import {
  buildDeterministicDrafts,
  buildModelDrafts,
  type FindingDraft,
  finalizeFindingSelection,
  finalizeFindings,
  writeFindings,
} from "./findings.js";
import type { PageReviewScope, ReviewOutcome } from "./report.js";
import {
  claudeCodeDegradationReason,
  createReviewCritiqueAdapter,
  type ReviewDependencies,
  safeDegradationReason,
} from "./run.js";

export type PageReviewDependencies = Omit<ReviewDependencies, "capture"> & {
  capture?: QuickDependencies | undefined;
};

export type PageReviewResult = {
  runDirectory: string;
  findingsPath: string;
  reportPath: string;
  htmlReportPath: string;
  findingCount: number;
  deferredFindings: Finding[];
  outcome: ReviewOutcome;
  counts: CaptureCounts;
};

const DEFAULT_MAX_FINDINGS = 10;

/** Lines as an editor numbers them; a final newline adds no line. */
function numberedLines(source: string): string[] {
  const lines = source.split(/\r\n?|\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

async function readInput(
  cwd: string,
  path: string,
  label: string,
): Promise<{ path: string; text: string }> {
  try {
    return { path, text: await readFile(resolve(cwd, path), "utf8") };
  } catch (error) {
    throw new IdiomError(
      `cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function optionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** --frame values: image files, text files, or literal text. */
async function frameReferences(
  cwd: string,
  frames: string[],
): Promise<ReferenceRef[]> {
  return await Promise.all(
    frames.map(async (frame, index): Promise<ReferenceRef> => {
      const label = `frame-${index + 1}`;
      return (
        (await referenceFromFile({
          cwd,
          value: frame,
          label,
          polarity: "reference",
        })) ?? { label, polarity: "reference", kind: "text", content: frame }
      );
    }),
  );
}

function defaultRunName(now: Date): string {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

/**
 * Review one rendered page without a flow: capture it like quick review,
 * run every deterministic check with page-content on, then (unless
 * deterministic-only) critique it against the brief and art direction.
 */
export async function runPageReview(options: {
  url: string;
  design?: string | undefined;
  refreshDesign?: boolean | undefined;
  brief?: string | undefined;
  direction?: string | undefined;
  focus?: PageFocusArea[] | undefined;
  frames?: string[] | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  out?: string | undefined;
  deterministicOnly?: boolean | undefined;
  provider?: "claude-code" | "anthropic" | undefined;
  model?: string | undefined;
  maxFindings?: number | undefined;
  dependencies?: PageReviewDependencies | undefined;
}): Promise<PageReviewResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const directory = resolveProjectArgument(options.project, cwd);
  const projectDirectory = await findOptionalProjectDirectory(directory);
  const project: Project | undefined =
    projectDirectory === undefined
      ? undefined
      : (await validateProjectConfiguration({ project: projectDirectory }))
          .project;
  const focus = [...new Set(options.focus ?? [])];
  const brief =
    options.brief === undefined
      ? undefined
      : await readInput(cwd, options.brief, "brief");
  const direction =
    options.direction === undefined
      ? undefined
      : await readInput(cwd, options.direction, "art direction");
  const frames = await frameReferences(cwd, options.frames ?? []);

  // One settings value feeds capture (selector marks) and review.
  const settings = checksConfigSchema.parse({
    ...(project?.checks ?? {}),
    page: project?.checks.page ?? {},
  });
  const configuration = createQuickConfiguration([options.url], {
    design:
      options.design === undefined
        ? undefined
        : /^https?:/i.test(designSourceSchema.parse(options.design))
          ? options.design
          : resolve(cwd, options.design),
    flowId: "page-review",
    title: "Page review",
    colorSchemes: ["light"],
    statePrefix: "page",
    checks: settings,
  });
  const checks = checksConfigFrom(settings);
  if (checks.page !== undefined && brief !== undefined)
    checks.page = { ...checks.page, brief: { text: brief.text } };

  const now = options.dependencies?.capture?.now ?? (() => new Date());
  const startedAt = now();
  const finalDirectory =
    options.out === undefined
      ? join(directory, "idiom-page-reviews", defaultRunName(startedAt))
      : resolve(directory, options.out);
  const { runDirectory, loaded, reviewed, counts } = await captureLiteralPages({
    directory,
    finalDirectory,
    configuration,
    checks,
    startedAt,
    label: "page review",
    refreshDesign: options.refreshDesign,
    dependencies: options.dependencies?.capture,
  });

  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const legacyColorScheme = configuration.project.capture.colorScheme;
  const deterministicDrafts = buildDeterministicDrafts({
    config: checks,
    tuples: loaded.tuples,
    runId: loaded.runId,
    entries: reviewed.candidates,
    legacyColorScheme,
  });
  const sectionTuple =
    loaded.tuples.find((tuple) => tuple.viewport === "desktop") ??
    loaded.tuples[0];
  const sections =
    sectionTuple?.observations?.version === 2
      ? pageSections(sectionTuple.observations, sectionTuple.height)
      : [];
  const pageContext: PageCritiqueContext = {
    url: configuration.urls[0] as string,
    // A page built only from divs has no detected sections; the whole page
    // stands in so page findings still have a section to name.
    sections:
      sections.length === 0
        ? [{ id: "s0", role: "page", selector: "body" }]
        : sections.map(({ id, role, heading, selector }) => ({
            id,
            role,
            ...(heading === undefined ? {} : { heading }),
            selector,
          })),
    ...(brief === undefined
      ? {}
      : { brief: { path: brief.path, lines: numberedLines(brief.text) } }),
    ...(direction === undefined
      ? {}
      : {
          direction: {
            path: direction.path,
            lines: numberedLines(direction.text),
          },
        }),
    focus,
  };

  let modelDrafts: FindingDraft[] = [];
  let outcome: ReviewOutcome;
  const provider =
    options.provider ?? project?.model.provider ?? ("claude-code" as const);
  const model = options.model ?? project?.model.model;
  if (options.deterministicOnly === true) {
    outcome = { kind: "deterministic-only" };
  } else if (model === undefined) {
    outcome = {
      kind: "degraded",
      reason:
        "no model configured; pass --model or run inside an Idiom project",
    };
  } else {
    try {
      const material = await tupleCritiqueMaterial(loaded.tuples, runDirectory);
      const references = [
        ...(projectDirectory === undefined
          ? []
          : await loadReferenceContext(projectDirectory)),
        ...frames,
      ];
      const input: CritiqueInput = {
        flow: configuration.flow.id,
        intent: [],
        screenshots: material.screenshots,
        domExcerpts: material.domExcerpts,
        productMd:
          projectDirectory === undefined || project === undefined
            ? ""
            : await optionalText(
                join(projectDirectory, project.design.productFile),
              ),
        designMd:
          projectDirectory === undefined || project === undefined
            ? ""
            : await optionalText(
                join(projectDirectory, project.design.designFile),
              ),
        references,
        priorDecisions: [],
        priorRules: [],
        deterministicFindings: finalizeFindings({
          runId: loaded.runId,
          drafts: deterministicDrafts,
        }),
        modelCandidateAllowance: maxFindings,
        decisionObservationAllowance: 0,
        rulingResolutions: [],
        page: pageContext,
      };
      const { capture: _capture, ...critiqueDependencies } =
        options.dependencies ?? {};
      const adapter = createReviewCritiqueAdapter({
        provider,
        model,
        projectDirectory: projectDirectory ?? directory,
        dependencies: critiqueDependencies,
      });
      const critique = validateCritiqueResult({
        result: await adapter.critique(input),
        screenshots: input.screenshots,
        references: input.references,
        designMd: input.designMd,
        page: pageContext,
      });
      modelDrafts = buildModelDrafts({
        runId: loaded.runId,
        candidates: critique.findings,
        screenshots: input.screenshots,
        tuples: loaded.tuples,
        legacyColorScheme,
      });
      outcome = { kind: "full" };
    } catch (error) {
      outcome = {
        kind: "degraded",
        reason:
          provider === "claude-code" && error instanceof ClaudeCodeCritiqueError
            ? claudeCodeDegradationReason(
                error,
                options.dependencies?.environment ?? process.env,
              )
            : safeDegradationReason(error),
      };
    }
  }

  // Requested focus areas rank ahead within a severity.
  const selection = finalizeFindingSelection({
    runId: loaded.runId,
    drafts: [...deterministicDrafts, ...modelDrafts],
    maxFindings,
    priority: (draft) =>
      draft.finding.focus !== undefined && focus.includes(draft.finding.focus)
        ? 0
        : 1,
  });
  const findings = await attachCrops(
    runDirectory,
    selection.material,
    loaded.tuples,
  );
  const deferredFindings = await attachCrops(
    runDirectory,
    selection.deferred,
    loaded.tuples,
  );
  const findingsPath = await writeFindings(runDirectory, findings);
  const scope: PageReviewScope = {
    url: pageContext.url,
    ...(brief === undefined ? {} : { brief: brief.path }),
    ...(direction === undefined ? {} : { direction: direction.path }),
    focus,
    sections: pageContext.sections,
  };
  const { reportPath, htmlReportPath } = await writeReviewReports(
    runDirectory,
    {
      flow: configuration.flow.id,
      commit: loaded.commit,
      findings,
      tuples: loaded.tuples,
      coverage: reviewed.coverage,
      captureCoverage: reviewed.captureCoverage,
      deferred: deferredFindings,
      ...(reviewed.narrowWidth === undefined
        ? {}
        : { narrowWidth: reviewed.narrowWidth }),
      outcome,
      page: scope,
      reportCoverage: buildReviewCoverage({
        collapsedTupleKeys: loaded.collapsedTupleKeys,
        flow: configuration.flow,
        project: configuration.project,
        tuples: loaded.tuples,
        commit: loaded.commit,
      }),
    },
  );
  return {
    runDirectory,
    findingsPath,
    reportPath,
    htmlReportPath,
    findingCount: findings.length,
    deferredFindings,
    outcome,
    counts,
  };
}
