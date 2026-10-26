import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CheckTuple } from "../checks/types.js";
import { designEvidenceProblem } from "../design/evidence.js";
import { IdiomError } from "../errors.js";
import {
  listManagedReferences,
  loadLegacyReferences,
} from "../references/catalog.js";
import { MAX_UNRULED_DECISIONS } from "../rulings/aggregate.js";
import { parseRulingBlocks } from "../rulings/law.js";
import type { Decision } from "../schemas/decision.js";
import type { Finding } from "../schemas/finding.js";
import type { Flow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import type { RuleOverride } from "../schemas/rules.js";
import type {
  CritiqueInput,
  DesignImageRef,
  DomExcerpt,
  ReferenceRef,
  ScreenshotRef,
} from "./types.js";

const DOM_LIMIT = 2_000;

function bodyExcerpt(source: string): string {
  const body =
    /<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i.exec(source)?.[1] ?? source;
  const compact = body.replace(/<script\b[\s\S]*?<\/script>/gi, "").trim();
  if (compact.length <= DOM_LIMIT) return compact;
  return `${compact.slice(0, DOM_LIMIT)}\n<!-- excerpt truncated -->`;
}

async function requiredText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new IdiomError(
      `cannot load ${label} for model critique from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function loadReferenceContext(
  projectDirectory: string,
): Promise<ReferenceRef[]> {
  const managed = (await listManagedReferences(projectDirectory)).map(
    (entry): ReferenceRef => ({
      label: entry.label,
      polarity: entry.polarity,
      kind: "image",
      readPath: entry.imagePath,
      mediaType: entry.metadata.mediaType,
      note: entry.metadata.note,
      sourceKind: entry.metadata.sourceKind,
      source: entry.metadata.source,
      ...(entry.metadata.sourceKind === "url"
        ? {
            capturedAt: entry.metadata.capturedAt,
            viewport: entry.metadata.viewport,
          }
        : {}),
    }),
  );
  const polarityOrder = new Map([
    ["reference", 0],
    ["anti-reference", 1],
  ]);
  return [...managed, ...(await loadLegacyReferences(projectDirectory))].sort(
    (left, right) =>
      (polarityOrder.get(left.polarity) ?? 2) -
        (polarityOrder.get(right.polarity) ?? 2) ||
      left.label.localeCompare(right.label),
  );
}

/** The screenshot label a tuple is cited by in critique requests. */
export function tupleLabel(tuple: CheckTuple): string {
  return tuple.colorSchemeAxis
    ? `${tuple.state}/${tuple.viewport}/${tuple.colorScheme}`
    : `${tuple.state}/${tuple.viewport}`;
}

/** Labelled screenshots and DOM excerpts for every captured tuple. */
export async function tupleCritiqueMaterial(
  tuples: CheckTuple[],
  runDirectory: string,
): Promise<{ screenshots: ScreenshotRef[]; domExcerpts: DomExcerpt[] }> {
  const screenshots: ScreenshotRef[] = [];
  const domExcerpts: DomExcerpt[] = [];
  for (const tuple of tuples) {
    const label = tupleLabel(tuple);
    if (tuple.screenshotPath !== undefined) {
      screenshots.push({
        label,
        path: tuple.screenshotPath,
        readPath: resolve(runDirectory, tuple.screenshotPath),
        state: tuple.state,
        viewport: tuple.viewport,
        ...(tuple.colorSchemeAxis ? { colorScheme: tuple.colorScheme } : {}),
      });
    }
    const domPath = tuple.artifactPaths.find((path) =>
      path.endsWith("/dom.html"),
    );
    if (domPath !== undefined) {
      domExcerpts.push({
        label,
        state: tuple.state,
        viewport: tuple.viewport,
        ...(tuple.colorSchemeAxis ? { colorScheme: tuple.colorScheme } : {}),
        content: bodyExcerpt(
          await requiredText(resolve(runDirectory, domPath), "DOM excerpt"),
        ),
      });
    }
  }
  return { screenshots, domExcerpts };
}

/** Intended design images for tuples whose image comparison is usable. */
export function tupleDesignImages(
  tuples: CheckTuple[],
  runDirectory: string,
): DesignImageRef[] {
  return tuples.flatMap((tuple): DesignImageRef[] => {
    const design = tuple.design;
    if (
      design?.descriptor.resolved?.kind !== "image" ||
      !design.regions ||
      !design.screenshotPath ||
      tuple.screenshotPath === undefined ||
      designEvidenceProblem(tuple)
    )
      return [];
    const label = tupleLabel(tuple);
    return [
      {
        label: `${label}/design`,
        designFor: label,
        path: design.screenshotPath,
        readPath: resolve(runDirectory, design.screenshotPath),
        state: tuple.state,
        viewport: tuple.viewport,
        ...(tuple.colorSchemeAxis ? { colorScheme: tuple.colorScheme } : {}),
        offset: design.regions.offset,
        regions: design.regions.regions.map((region) => ({
          id: region.id,
          rect: region.rect,
          elements: region.elements,
        })),
      },
    ];
  });
}

export async function buildCritiqueContext(options: {
  projectDirectory: string;
  runDirectory: string;
  project: Project;
  flow: Flow;
  tuples: CheckTuple[];
  priorDecisions: Decision[];
  priorRules?: RuleOverride[] | undefined;
  deterministicFindings: Finding[];
  modelCandidateAllowance: number;
}): Promise<CritiqueInput> {
  const { screenshots, domExcerpts } = await tupleCritiqueMaterial(
    options.tuples,
    options.runDirectory,
  );

  const designMd = await requiredText(
    join(options.projectDirectory, options.project.design.designFile),
    "design guidance",
  );
  const parsedLaw = parseRulingBlocks(designMd);
  const designImages = tupleDesignImages(options.tuples, options.runDirectory);
  return {
    flow: options.flow.id,
    ...(options.flow.surface === undefined
      ? {}
      : { surface: options.flow.surface }),
    intent: options.flow.intent,
    screenshots,
    domExcerpts,
    productMd: await requiredText(
      join(options.projectDirectory, options.project.design.productFile),
      "product guidance",
    ),
    designMd,
    references: await loadReferenceContext(options.projectDirectory),
    priorDecisions: options.priorDecisions,
    priorRules: options.priorRules ?? [],
    deterministicFindings: options.deterministicFindings,
    modelCandidateAllowance: options.modelCandidateAllowance,
    decisionObservationAllowance:
      MAX_UNRULED_DECISIONS *
      new Set(screenshots.map((screenshot) => screenshot.state)).size,
    rulingResolutions: parsedLaw.resolutions,
    ...(designImages.length ? { designImages } : {}),
  };
}
