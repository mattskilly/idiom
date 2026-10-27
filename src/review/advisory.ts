import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PNG } from "pngjs";
import { pageSections } from "../checks/page-content.js";
import type { CheckTuple } from "../checks/types.js";
import { buildCritiqueContext } from "../critique/context.js";
import { referenceFromFile } from "../critique/reference-file.js";
import { validateCritiqueResult } from "../critique/schema.js";
import {
  type AdvisoryAspect,
  advisoryAspects,
  type CritiqueInput,
  type CritiqueResult,
  type ModelFindingCandidate,
  type PageCritiqueContext,
} from "../critique/types.js";
import type { Finding } from "../schemas/finding.js";
import {
  type ContentPattern,
  contentPatternStateId,
  type WebFlow,
} from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import { surfaceGeometry } from "../sweep/geometry.js";
import { attachCrops, cropToFile, screenshotPlacement } from "./crops.js";
import { buildModelDrafts, finalizeFindings } from "./findings.js";
import type { ReviewOutcome } from "./report.js";

/** One advisory model finding: never gating, never decided, never ticketed. */
export type AdvisoryEntry = {
  aspect: AdvisoryAspect;
  section: string;
  sectionHeading?: string | undefined;
  finding: Finding;
};

export type AdvisoryPattern = {
  id: string;
  state: string;
  intent: string;
  /** The paired design reference's label. */
  reference?: string | undefined;
  status: "ok" | "failed" | "skipped";
  reason?: string | undefined;
  screenshots: string[];
  findings: AdvisoryEntry[];
};

export type AdvisoryReview = {
  version: 1;
  flow: string;
  outcome: ReviewOutcome;
  patterns: AdvisoryPattern[];
};

type AdvisoryAdapter = {
  critique(
    input: CritiqueInput,
  ): Promise<CritiqueResult | ModelFindingCandidate[]>;
};

const MAX_REASON_LENGTH = 600;
const cropPadding = 16;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** The tuple sections are detected on, the way a page review picks it. */
function sectionTuple(tuples: CheckTuple[]): CheckTuple | undefined {
  return tuples.find((tuple) => tuple.viewport === "desktop") ?? tuples[0];
}

function patternSections(
  tuples: CheckTuple[],
): PageCritiqueContext["sections"] {
  const tuple = sectionTuple(tuples);
  const sections =
    tuple?.observations?.version === 2
      ? pageSections(tuple.observations, tuple.height)
      : [];
  // A pattern built only from divs has no detected sections; the whole page
  // stands in so findings still have a section to name.
  return sections.length === 0
    ? [{ id: "s0", role: "page", selector: "body" }]
    : sections.map(({ id, role, heading, selector }) => ({
        id,
        role,
        ...(heading === undefined ? {} : { heading }),
        selector,
      }));
}

/** The cited section cut out of the finding's own tuple screenshot. */
async function cropSection(options: {
  runDirectory: string;
  finding: Finding;
  selector: string;
  tuples: CheckTuple[];
  images: Map<string, PNG | undefined>;
}): Promise<Finding> {
  const { finding } = options;
  const tuple = options.tuples.find(
    (candidate) =>
      candidate.state === finding.state &&
      candidate.viewport === finding.viewport &&
      (finding.colorScheme === undefined ||
        candidate.colorScheme === finding.colorScheme),
  );
  const observations = tuple?.observations;
  if (tuple?.screenshotPath === undefined || observations === undefined)
    return finding;
  const element = observations.elements.find(
    (candidate) => candidate.visible && candidate.selector === options.selector,
  );
  if (
    element === undefined ||
    element.rect.width <= 0 ||
    element.rect.height <= 0
  )
    return finding;
  const placement = screenshotPlacement(observations);
  const relativePath = join(
    dirname(tuple.screenshotPath),
    "crops",
    `advisory-${finding.fingerprint.slice(0, 16)}.png`,
  );
  const written = await cropToFile({
    runDirectory: options.runDirectory,
    screenshotPath: tuple.screenshotPath,
    images: options.images,
    viewportWidth: observations.viewport.width,
    scale: placement.scale,
    rect: placement.rect(element),
    padding: cropPadding,
    relativePath,
  });
  return written
    ? {
        ...finding,
        evidence: {
          ...finding.evidence,
          screenshots: [...finding.evidence.screenshots, relativePath],
        },
      }
    : finding;
}

const hasCrop = (finding: Finding) =>
  finding.evidence.screenshots.some((path) => path.includes("/crops/"));

/** Resolve a pattern's design reference among the loaded references. */
async function patternReference(
  projectDirectory: string,
  pattern: ContentPattern,
  input: CritiqueInput,
): Promise<{ label?: string; extra?: CritiqueInput["references"][number] }> {
  const labels = new Set(input.references.map((item) => item.label));
  if (pattern.reference === undefined)
    return labels.has(`reference:${pattern.id}`)
      ? { label: `reference:${pattern.id}` }
      : {};
  if (labels.has(`reference:${pattern.reference}`))
    return { label: `reference:${pattern.reference}` };
  const file = await referenceFromFile({
    cwd: projectDirectory,
    value: pattern.reference,
    label: `pattern:${pattern.id}`,
    polarity: "reference",
  });
  if (file === undefined)
    throw new Error(
      `reference ${JSON.stringify(pattern.reference)} not found as a managed reference or a project file`,
    );
  return { label: file.label, extra: file };
}

/**
 * Critique each declared pattern on its own, told the pattern's intent and
 * paired reference, for spacing, hierarchy and coherence problems. Results
 * are advisory: they never join findings.json, groups, selection or the
 * check gate. A failing pattern is recorded and the rest carry on.
 */
export async function runAdvisoryReview(options: {
  projectDirectory: string;
  runDirectory: string;
  project: Project;
  flow: WebFlow & { content: { patterns: ContentPattern[] } };
  tuples: CheckTuple[];
  runId: string;
  deterministicFindings: Finding[];
  adapter: AdvisoryAdapter;
  describeFailure: (error: unknown) => string;
  legacyColorScheme?: "light" | "dark" | undefined;
}): Promise<AdvisoryReview> {
  const patterns: AdvisoryPattern[] = [];
  const images = new Map<string, PNG | undefined>();
  let sequence = 1;
  for (const pattern of options.flow.content.patterns) {
    const state = contentPatternStateId(pattern);
    const tuples = options.tuples.filter((tuple) => tuple.state === state);
    const entry: AdvisoryPattern = {
      id: pattern.id,
      state,
      intent: pattern.intent,
      status: "ok",
      screenshots: [],
      findings: [],
    };
    patterns.push(entry);
    if (tuples.length === 0) {
      entry.status = "skipped";
      entry.reason = "not captured in this run";
      continue;
    }
    try {
      const context = await buildCritiqueContext({
        projectDirectory: options.projectDirectory,
        runDirectory: options.runDirectory,
        project: options.project,
        flow: options.flow,
        tuples,
        priorDecisions: [],
        deterministicFindings: options.deterministicFindings.filter(
          (finding) => finding.state === state,
        ),
        modelCandidateAllowance: options.project.model.maxFindings,
      });
      entry.screenshots = context.screenshots.map((item) => item.label);
      const reference = await patternReference(
        options.projectDirectory,
        pattern,
        context,
      );
      if (reference.label !== undefined) entry.reference = reference.label;
      const page: PageCritiqueContext = {
        url: pattern.path ?? `state:${state}`,
        sections: patternSections(tuples),
        focus: [],
        pattern: {
          id: pattern.id,
          intent: pattern.intent,
          ...(reference.label === undefined
            ? {}
            : { reference: reference.label }),
          aspects: advisoryAspects,
        },
      };
      const input: CritiqueInput = {
        ...context,
        references:
          reference.extra === undefined
            ? context.references
            : [...context.references, reference.extra],
        // The advisory pass never produces unruled decisions.
        decisionObservationAllowance: 0,
        rulingResolutions: [],
        geometry: tuples.map(surfaceGeometry),
        page,
      };
      const critique = validateCritiqueResult({
        result: await options.adapter.critique(input),
        screenshots: input.screenshots,
        references: input.references,
        designMd: input.designMd,
        page,
      });
      const drafts = buildModelDrafts({
        runId: options.runId,
        candidates: critique.findings,
        screenshots: input.screenshots,
        tuples,
        legacyColorScheme: options.legacyColorScheme,
      });
      const finalized = await attachCrops(
        options.runDirectory,
        finalizeFindings({ runId: options.runId, drafts }),
        tuples,
      );
      for (const finding of finalized) {
        // A draft's stableOrder is its candidate's index in the response.
        const draft = drafts.find(
          (item) => item.finding.fingerprint === finding.fingerprint,
        );
        const candidate =
          draft === undefined
            ? undefined
            : critique.findings[draft.stableOrder];
        const sectionId = finding.evidence.section ?? "s0";
        const section = page.sections.find((item) => item.id === sectionId);
        const id = `advisory-${sequence}`;
        sequence += 1;
        const named = { ...finding, id };
        entry.findings.push({
          aspect: candidate?.aspect ?? "coherence",
          section: sectionId,
          ...(section?.heading === undefined
            ? {}
            : { sectionHeading: section.heading }),
          finding:
            hasCrop(named) || section === undefined
              ? named
              : await cropSection({
                  runDirectory: options.runDirectory,
                  finding: named,
                  selector: section.selector,
                  tuples,
                  images,
                }),
        });
      }
    } catch (error) {
      entry.status = "failed";
      entry.reason = options.describeFailure(error);
      entry.findings = [];
    }
  }
  const failed = patterns.filter((pattern) => pattern.status === "failed");
  return {
    version: 1,
    flow: options.flow.id,
    outcome:
      failed.length === 0
        ? { kind: "full" }
        : {
            kind: "degraded",
            reason: truncate(
              `advisory review failed for ${failed.length} of ${patterns.length} patterns: ${failed
                .map(
                  (pattern) => `${pattern.id}: ${pattern.reason ?? "unknown"}`,
                )
                .join("; ")}`,
              MAX_REASON_LENGTH,
            ),
          },
    patterns,
  };
}

export async function writeAdvisoryReview(
  runDirectory: string,
  review: AdvisoryReview,
): Promise<string> {
  const path = join(runDirectory, "advisory.json");
  await writeFile(path, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  return path;
}

export function advisoryCount(review: AdvisoryReview): number {
  return review.patterns.reduce(
    (total, pattern) => total + pattern.findings.length,
    0,
  );
}
