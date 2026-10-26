import { z } from "zod";
import { parseRulingBlocks } from "../rulings/law.js";
import {
  advisoryAspects,
  briefCitationSchema,
  pageFocusAreas,
} from "../schemas/finding.js";
import {
  type DecisionObservation,
  decisionObservationSchema,
} from "../schemas/ruling.js";
import {
  type CritiqueResult,
  critiqueResult,
  type DesignImageRef,
  type ModelFindingCandidate,
  type PageCritiqueContext,
  type ReferenceRef,
  type ScreenshotRef,
} from "./types.js";

export const modelFindingSchema = z
  .object({
    category: z.enum([
      "hierarchy",
      "density",
      "brand-alignment",
      "generic-pattern",
      "reference-mismatch",
      "spec-mismatch",
      "design-drift",
      "direction-drift",
      "offer-change",
      "unsupported-claim",
    ]),
    severity: z.enum(["blocker", "major", "minor"]),
    confidence: z.number().min(0).lt(1),
    rule: z.string().trim().min(1),
    selectorHint: z.string().trim().min(1),
    state: z.string().trim().min(1),
    viewport: z.string().trim().min(1),
    colorScheme: z.enum(["light", "dark"]).optional(),
    screenshots: z.array(z.string().trim().min(1)).min(1),
    references: z.array(z.string().trim().min(1)),
    explanation: z.string().trim().min(1),
    suggestedArea: z.string().trim().min(1),
    acceptance: z.array(z.string().trim().min(1)).min(1),
    section: z.string().trim().min(1).optional(),
    citations: z.array(briefCitationSchema).optional(),
    fix: z.string().trim().min(1).optional(),
    focus: z.enum(pageFocusAreas).optional(),
    aspect: z.enum(advisoryAspects).optional(),
  })
  .strict();

const pageCategories = new Set([
  "direction-drift",
  "offer-change",
  "unsupported-claim",
]);

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Page fields are valid only in a page review, where every finding names a
 * detected section and a fix, and every citation quotes its numbered line.
 */
function pageIssues(
  index: number,
  finding: ModelFindingCandidate,
  page: PageCritiqueContext | undefined,
): string[] {
  const at = `findings.${index}`;
  if (page === undefined)
    return pageCategories.has(finding.category) ||
      finding.section !== undefined ||
      finding.citations !== undefined ||
      finding.fix !== undefined ||
      finding.focus !== undefined ||
      finding.aspect !== undefined
      ? [`${at}: page fields require a page review`]
      : [];
  const issues: string[] = [];
  if (page.pattern === undefined) {
    if (finding.aspect !== undefined)
      issues.push(`${at}.aspect: aspect requires a pattern review`);
  } else {
    if (finding.aspect === undefined)
      issues.push(`${at}.aspect: required in a pattern review`);
    if (pageCategories.has(finding.category))
      issues.push(
        `${at}.category: page-review categories need a brief or direction`,
      );
    if (finding.citations !== undefined || finding.focus !== undefined)
      issues.push(
        `${at}: citations and focus are not part of a pattern review`,
      );
  }
  if (finding.section === undefined)
    issues.push(`${at}.section: required in a page review`);
  else if (!page.sections.some((section) => section.id === finding.section))
    issues.push(
      `${at}.section: unknown section ${JSON.stringify(finding.section)}`,
    );
  if (finding.fix === undefined)
    issues.push(`${at}.fix: a concrete fix is required in a page review`);
  for (const [position, citation] of (finding.citations ?? []).entries()) {
    const file = page[citation.source];
    const path = `${at}.citations.${position}`;
    if (file === undefined) {
      issues.push(`${path}: no ${citation.source} was supplied`);
      continue;
    }
    const line = file.lines[citation.line - 1];
    if (line === undefined) {
      issues.push(
        `${path}.line: ${citation.source} has ${file.lines.length} line(s); L${citation.line} does not exist`,
      );
      continue;
    }
    const excerpt = collapse(citation.excerpt);
    if (excerpt === "" || !collapse(line).includes(excerpt))
      issues.push(
        `${path}.excerpt: not found verbatim on ${citation.source} L${citation.line}`,
      );
  }
  const cites = (source: "brief" | "direction") =>
    (finding.citations ?? []).some((citation) => citation.source === source);
  if (finding.category === "direction-drift" && !cites("direction"))
    issues.push(`${at}.citations: direction-drift must cite a direction line`);
  if (
    (finding.category === "offer-change" ||
      finding.category === "unsupported-claim") &&
    !cites("brief")
  )
    issues.push(`${at}.citations: ${finding.category} must cite a brief line`);
  if (finding.focus !== undefined && !page.focus.includes(finding.focus))
    issues.push(
      `${at}.focus: ${JSON.stringify(finding.focus)} was not a requested focus area`,
    );
  return issues;
}

const modelEnvelopeSchema = z
  .object({
    findings: z.array(modelFindingSchema),
    decisionObservations: z.unknown().optional(),
  })
  .strict();

const transportPrecedentSchema = z
  .object({
    kind: z.enum(["law", "governed-surface"]).optional(),
    excerpt: z.string().optional(),
    screenshot: z.string().optional(),
    state: z.string().optional(),
    viewport: z.string().optional(),
    colorScheme: z.enum(["light", "dark"]).optional(),
  })
  .strict();
const transportCandidateSchema = z
  .object({
    wording: z.string().optional(),
    precedent: transportPrecedentSchema.optional(),
  })
  .strict();
const transportObservationSchema = z
  .object({
    choiceKey: z.string().optional(),
    question: z.string().optional(),
    state: z.string().optional(),
    viewport: z.string().optional(),
    colorScheme: z.enum(["light", "dark"]).optional(),
    screenshot: z.string().optional(),
    nearestLawExcerpt: z.string().optional(),
    candidates: z.array(transportCandidateSchema).optional(),
  })
  .strict();
const transportEnvelopeSchema = z
  .object({
    findings: z.array(modelFindingSchema),
    decisionObservations: z.array(transportObservationSchema).optional(),
  })
  .strict();

export const modelResponseSchema = modelEnvelopeSchema;
export const modelResponseJsonSchema = z.toJSONSchema(transportEnvelopeSchema, {
  target: "draft-7",
});

export class MalformedCritiqueError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`malformed model critique: ${issues.join("; ")}`);
    this.name = "MalformedCritiqueError";
    this.issues = issues;
  }
}

function findingIssues(
  findings: ModelFindingCandidate[],
  screenshots: ScreenshotRef[],
  references: ReferenceRef[],
  specAvailable: boolean,
  page?: PageCritiqueContext | undefined,
  designImages: DesignImageRef[] = [],
): string[] {
  const known = new Map(screenshots.map((item) => [item.label, item]));
  const knownReferences = new Set(references.map((item) => item.label));
  const designLabels = new Set(designImages.map((item) => item.label));
  const issues: string[] = [];
  const axisAware = screenshots.some(
    (screenshot) => screenshot.colorScheme !== undefined,
  );
  for (const [index, finding] of findings.entries()) {
    const joined = [
      finding.rule,
      finding.explanation,
      finding.suggestedArea,
      ...finding.acceptance,
      ...(finding.fix === undefined ? [] : [finding.fix]),
    ].join("\n");
    // A page review quotes the page's own claims ("4.9/5 rating"); quoted
    // page copy is evidence, not the model rating the design.
    const prose =
      page === undefined ? joined : joined.replace(/"[^"]*"|“[^”]*”/g, "");
    if (axisAware && finding.colorScheme === undefined)
      issues.push(
        `findings.${index}.colorScheme: required for a multi-scheme capture`,
      );
    if (
      /\b(?:score|scores|rating|ratings|grade|grades|rubric total)\b/i.test(
        prose,
      )
    )
      issues.push(
        `findings.${index}: aggregate or numeric design-rating language is forbidden`,
      );
    for (const label of finding.screenshots) {
      const screenshot = known.get(label);
      if (screenshot === undefined)
        issues.push(
          `findings.${index}.screenshots: unknown label ${JSON.stringify(label)}`,
        );
      else if (
        screenshot.state !== finding.state ||
        screenshot.viewport !== finding.viewport ||
        screenshot.colorScheme !== finding.colorScheme
      )
        issues.push(
          `findings.${index}.screenshots: ${JSON.stringify(label)} does not match state/viewport/colorScheme`,
        );
    }
    for (const label of finding.references)
      if (
        !knownReferences.has(label) &&
        !(finding.category === "design-drift" && designLabels.has(label))
      )
        issues.push(
          `findings.${index}.references: unknown label ${JSON.stringify(label)}`,
        );
    if (finding.category === "design-drift") {
      const design = designImages.find(
        (item) =>
          item.state === finding.state &&
          item.viewport === finding.viewport &&
          item.colorScheme === finding.colorScheme,
      );
      if (design === undefined)
        issues.push(
          `findings.${index}.category: design-drift requires an intended design image for its state/viewport`,
        );
      else if (!finding.references.includes(design.label))
        issues.push(
          `findings.${index}.references: design-drift must cite the design image ${JSON.stringify(design.label)}`,
        );
      if (/^(?:html|body)$/i.test(finding.selectorHint.trim()))
        issues.push(
          `findings.${index}.selectorHint: design-drift must name the departing element, not the page`,
        );
    }
    if (
      finding.category === "reference-mismatch" &&
      finding.references.length === 0
    )
      issues.push(
        `findings.${index}.references: reference-mismatch requires at least one exact reference label`,
      );
    if (finding.category === "spec-mismatch" && !specAvailable)
      issues.push(
        `findings.${index}.category: spec-mismatch requires a configured design spec`,
      );
    issues.push(...pageIssues(index, finding, page));
  }
  return issues;
}

function coordinateMatches(
  screenshot: ScreenshotRef,
  item: {
    state: string;
    viewport: string;
    colorScheme?: "light" | "dark" | undefined;
  },
): boolean {
  return (
    screenshot.state === item.state &&
    screenshot.viewport === item.viewport &&
    screenshot.colorScheme === item.colorScheme
  );
}

function parseObservations(options: {
  value: unknown;
  batchScreenshots: ScreenshotRef[];
  fullRunScreenshots: ScreenshotRef[];
  designMd: string;
}): { observations: DecisionObservation[]; discarded: number } {
  if (options.value === undefined) return { observations: [], discarded: 0 };
  if (!Array.isArray(options.value)) return { observations: [], discarded: 1 };
  const batch = new Map(
    options.batchScreenshots.map((item) => [item.label, item]),
  );
  const full = new Map(
    options.fullRunScreenshots.map((item) => [item.label, item]),
  );
  const observations: DecisionObservation[] = [];
  const parsedLaw = parseRulingBlocks(options.designMd);
  const supportsLawCandidate = (excerpt: string) =>
    parsedLaw.prose.includes(excerpt) ||
    parsedLaw.resolutions.some(
      (resolution) =>
        resolution.outcome === "rule" &&
        resolution.wording?.includes(excerpt) === true,
    );
  let discarded = 0;
  for (const item of options.value) {
    const parsed = decisionObservationSchema.safeParse(item);
    if (!parsed.success) {
      discarded += 1;
      continue;
    }
    const observation = parsed.data;
    const screenshot = batch.get(observation.screenshot);
    let valid =
      screenshot !== undefined && coordinateMatches(screenshot, observation);
    valid &&= options.designMd.includes(observation.nearestLawExcerpt);
    for (const candidate of observation.candidates) {
      if (candidate.precedent.kind === "law") {
        valid &&= supportsLawCandidate(candidate.precedent.excerpt);
      } else {
        const precedent = full.get(candidate.precedent.screenshot);
        valid &&=
          precedent !== undefined &&
          coordinateMatches(precedent, candidate.precedent);
      }
    }
    if (valid) observations.push(observation);
    else discarded += 1;
  }
  return { observations, discarded };
}

export function parseModelResponse(
  source: string,
  screenshots: ScreenshotRef[],
  references: ReferenceRef[] = [],
  fullRunScreenshots: ScreenshotRef[] = screenshots,
  designMd = "",
  specAvailable = false,
  page?: PageCritiqueContext | undefined,
  designImages: DesignImageRef[] = [],
): CritiqueResult {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}"))
    throw new MalformedCritiqueError([
      "response must be one JSON object with no prose or code fence",
    ]);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new MalformedCritiqueError([
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const parsed = modelEnvelopeSchema.safeParse(value);
  if (!parsed.success)
    throw new MalformedCritiqueError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      ),
    );
  const issues = findingIssues(
    parsed.data.findings,
    screenshots,
    references,
    specAvailable,
    page,
    designImages,
  );
  if (issues.length > 0) throw new MalformedCritiqueError(issues);
  const observationResult = parseObservations({
    value: parsed.data.decisionObservations,
    batchScreenshots: screenshots,
    fullRunScreenshots,
    designMd,
  });
  return critiqueResult({
    findings: parsed.data.findings,
    decisionObservations: observationResult.observations,
    discardedDecisionObservations: observationResult.discarded,
  });
}

export function validateCritiqueResult(options: {
  result: unknown;
  screenshots: ScreenshotRef[];
  references?: ReferenceRef[] | undefined;
  designMd: string;
  specAvailable?: boolean | undefined;
  page?: PageCritiqueContext | undefined;
  designImages?: DesignImageRef[] | undefined;
}): CritiqueResult {
  let upstreamDiscarded = 0;
  if (Array.isArray(options.result)) {
    const value = options.result as Partial<CritiqueResult>;
    const parsed = parseModelResponse(
      JSON.stringify({
        findings: value.findings ?? options.result,
        decisionObservations: value.decisionObservations ?? [],
      }),
      options.screenshots,
      options.references ?? [],
      options.screenshots,
      options.designMd,
      options.specAvailable === true,
      options.page,
      options.designImages,
    );
    upstreamDiscarded = value.discardedDecisionObservations ?? 0;
    return critiqueResult({
      findings: parsed.findings,
      decisionObservations: parsed.decisionObservations,
      discardedDecisionObservations:
        upstreamDiscarded + parsed.discardedDecisionObservations,
    });
  }
  const record =
    options.result !== null && typeof options.result === "object"
      ? (options.result as Record<string, unknown>)
      : {};
  upstreamDiscarded =
    typeof record.discardedDecisionObservations === "number" &&
    Number.isSafeInteger(record.discardedDecisionObservations) &&
    record.discardedDecisionObservations >= 0
      ? record.discardedDecisionObservations
      : 0;
  const parsed = parseModelResponse(
    JSON.stringify({
      findings: record.findings,
      decisionObservations: record.decisionObservations,
    }),
    options.screenshots,
    options.references ?? [],
    options.screenshots,
    options.designMd,
    options.specAvailable === true,
    options.page,
    options.designImages,
  );
  return critiqueResult({
    findings: parsed.findings,
    decisionObservations: parsed.decisionObservations,
    discardedDecisionObservations:
      upstreamDiscarded + parsed.discardedDecisionObservations,
  });
}
