import type {
  CritiqueInput,
  CropRef,
  PageCritiqueContext,
  PatternCritiqueContext,
  ReferenceRef,
  ScreenshotRef,
} from "./types.js";

const flowCategories = [
  "hierarchy",
  "density",
  "brand-alignment",
  "generic-pattern",
  "reference-mismatch",
];
const pageCategories = ["direction-drift", "offer-change", "unsupported-claim"];

const focusDefinitions: Record<PageCritiqueContext["focus"][number], string> = {
  hierarchy:
    "hierarchy: one clear reading order per section; the headline leads",
  "primary-action":
    "primary-action: one primary action per view; secondary actions recede",
  naming:
    "naming: the product, plan and feature names stay the same everywhere",
  "radii-heights":
    "radii-heights: corner radii and control heights come from one consistent scale",
  jargon: "jargon: plain words a first-time visitor understands",
};

function orList(items: string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

function numbered(lines: string[]): string {
  return lines.map((line, index) => `L${index + 1}: ${line}`).join("\n");
}

function pageSections(
  page: PageCritiqueContext,
  colorScheme: boolean,
): string[] {
  return [
    section("Page under review", page.url),
    section(
      "Page sections",
      page.sections.map((item) => ({
        id: item.id,
        role: item.role,
        ...(item.heading === undefined ? {} : { heading: item.heading }),
      })),
    ),
    section(
      "Brief (numbered lines; the only source of truth for the offer and every statistic or claim)",
      page.brief === undefined ? "not supplied" : numbered(page.brief.lines),
    ),
    section(
      "Art direction (numbered lines)",
      page.direction === undefined
        ? "not supplied"
        : numbered(page.direction.lines),
    ),
    section(
      "Focus areas",
      page.focus.length === 0
        ? "none requested"
        : page.focus.map((area) => `- ${focusDefinitions[area]}`).join("\n"),
    ),
    [
      "This is a page review. Every finding must name the page section it concerns in section (one of the section ids above) and give a concrete fix: the change to make, not a restatement of the problem.",
      "direction-drift: a section departs from the stated art direction; cite the direction line it departs from.",
      "offer-change: the offer, price, plan, guarantee or CTA promise on the page differs from the brief; cite the brief line.",
      "unsupported-claim: a statistic or factual claim on the page that the brief does not contain; quote the claim in explanation and cite the brief line it most nearly purports to support.",
      'Cite lines in citations as {"source":"brief"|"direction","line":N,"excerpt":"..."}; copy the excerpt verbatim from the numbered line, without the L prefix.',
      "When focus areas are listed, set focus to the area a finding belongs to and prefer findings in those areas. Treat the reference frames among the references as judgment context.",
    ].join(" "),
    section("Exact page finding shape", {
      category: "unsupported-claim",
      severity: "major",
      confidence: 0.8,
      rule: "Brief: every statistic must come from the brief",
      selectorHint: "hero proof line",
      state: "captured-state",
      viewport: "captured-viewport",
      ...(colorScheme ? { colorScheme: "light" } : {}),
      screenshots: ["captured-state/captured-viewport"],
      references: [],
      explanation:
        'The hero claims "87% faster launches"; the brief has no such figure.',
      suggestedArea: "hero",
      acceptance: ["The hero states only figures from the brief."],
      section: "s1",
      citations: [{ source: "brief", line: 3, excerpt: "Exact text from L3" }],
      fix: "Replace the claim with the brief's figure or remove it.",
      ...(page.focus.length === 0 ? {} : { focus: page.focus[0] }),
    }),
  ];
}

/** An advisory design-intent review of one pattern: no brief, no gate. */
function patternSections(
  page: PageCritiqueContext,
  pattern: PatternCritiqueContext,
  colorScheme: boolean,
): string[] {
  return [
    section(
      "Pattern under review",
      [
        `id: ${pattern.id}`,
        `intent: ${pattern.intent}`,
        `design reference: ${pattern.reference ?? "no design reference"}`,
        `rendered at: ${page.url}`,
      ].join("\n"),
    ),
    section(
      "Page sections",
      page.sections.map((item) => ({
        id: item.id,
        role: item.role,
        ...(item.heading === undefined ? {} : { heading: item.heading }),
      })),
    ),
    [
      "This is an advisory design-intent review of one pattern. Judge the rendered pattern against its declared intent and, when one is paired, its design reference.",
      `Report only ${orList([...pattern.aspects])} problems, and set aspect to the one a finding concerns.`,
      "spacing: elements that crowd or touch, such as a heading with no gap above the content it introduces; cite the measured gap from the geometry.",
      "hierarchy: the reading order or emphasis contradicts the intent, such as placeholder media that reads as broken images and draws the eye.",
      "coherence: parts of the pattern disagree with each other or with the reference, such as colours only partly re-themed.",
      "Every finding must name the page section it concerns in section (one of the section ids above) and give a concrete fix: the change to make, not a restatement of the problem.",
    ].join(" "),
    section("Exact pattern finding shape", {
      category: "hierarchy",
      severity: "major",
      confidence: 0.8,
      rule: `Pattern intent: ${pattern.intent}`,
      selectorHint: "section heading",
      state: "captured-state",
      viewport: "captured-viewport",
      ...(colorScheme ? { colorScheme: "light" } : {}),
      screenshots: ["captured-state/captured-viewport"],
      references: pattern.reference === undefined ? [] : [pattern.reference],
      explanation:
        "The section heading sits 0px above the card row, so it reads as part of the first card.",
      suggestedArea: "section heading",
      acceptance: ["The heading has a clear gap above the card row."],
      section: "s1",
      fix: "Add the section's heading gap between the heading and the card row.",
      aspect: "spacing",
    }),
  ];
}

function section(label: string, value: unknown): string {
  return `## ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
}

export function critiquePrompt(
  input: CritiqueInput,
  screenshots: ScreenshotRef[],
  imageReferences = input.references.filter(
    (reference): reference is Extract<ReferenceRef, { kind: "image" }> =>
      reference.kind === "image",
  ),
  crops: CropRef[] = input.crops ?? [],
): string {
  const textReferences = input.references
    .filter((reference) => reference.kind === "text")
    .map((reference) => ({
      label: reference.label,
      polarity: reference.polarity,
      content: reference.content,
    }));
  const imageLabels = [
    ...screenshots.map((item) => ({
      label: item.label,
      kind: "captured-screenshot",
      state: item.state,
      viewport: item.viewport,
      ...(item.colorScheme === undefined
        ? {}
        : { colorScheme: item.colorScheme }),
    })),
    ...imageReferences.map((reference) => ({
      label: reference.label,
      kind: reference.polarity,
      ...(reference.note === undefined ? {} : { note: reference.note }),
      ...(reference.source === undefined
        ? {}
        : {
            sourceKind: reference.sourceKind,
            source: reference.source,
            capturedAt: reference.capturedAt,
            viewport: reference.viewport,
          }),
    })),
    ...crops.map((crop) => ({
      label: crop.label,
      kind: "zoomed-crop",
      magnifies: crop.screenshot,
      rect: crop.rect,
    })),
  ];
  const sweepSections = [
    ...(input.geometry === undefined
      ? []
      : [
          section(
            "Measured geometry (CSS px from the capture; trust these numbers over visual estimates)",
            input.geometry,
          ),
        ]),
    ...(input.spec === undefined
      ? []
      : [section(`Design spec (${input.spec.file})`, input.spec.content)]),
  ];
  const sweepInstructions = [
    ...(crops.length === 0
      ? []
      : [
          "Zoomed crops are magnified views of a captured screenshot; inspect them for small details, but cite the parent screenshot label they magnify, never a crop label.",
        ]),
    ...(input.geometry === undefined
      ? []
      : [
          `Compare the measured geometry against DESIGN.md${input.spec === undefined ? "" : " and the design spec"}; cite measured values in explanation instead of estimating sizes from pixels.`,
        ]),
    ...(input.spec === undefined
      ? []
      : [
          "spec-mismatch findings must quote the spec requirement in rule and state the measured or observed value in explanation.",
        ]),
  ];
  const categories = [
    ...flowCategories,
    ...(input.spec === undefined ? [] : ["spec-mismatch"]),
    ...(input.page === undefined || input.page.pattern !== undefined
      ? []
      : pageCategories),
  ];
  return [
    "You are Idiom's narrow product-design critique adapter. Return only the requested JSON object.",
    section("Flow", input.flow),
    section("Declared surface", input.surface ?? "not declared"),
    section("Flow intent", input.intent),
    section("PRODUCT.md", input.productMd),
    section("DESIGN.md", input.designMd),
    section("Text references and anti-references", textReferences),
    section("Labeled images", imageLabels),
    section(
      "Full-run governed screenshot coordinate manifest (citation universe; only the current batch images above are visible now)",
      input.screenshots.map((item) => ({
        label: item.label,
        state: item.state,
        viewport: item.viewport,
        ...(item.colorScheme === undefined
          ? {}
          : { colorScheme: item.colorScheme }),
      })),
    ),
    section("DOM excerpts", input.domExcerpts),
    ...sweepSections,
    section(
      "Already evaluated deterministic findings; do not duplicate them",
      input.deterministicFindings.map((finding) => ({
        category: finding.category,
        severity: finding.severity,
        state: finding.state,
        viewport: finding.viewport,
        ...(finding.colorScheme === undefined
          ? {}
          : { colorScheme: finding.colorScheme }),
        rule: finding.rule,
        explanation: finding.explanation,
      })),
    ),
    section(
      "Standing human rejections; do not re-litigate matching rules",
      input.priorDecisions.map((decision) => ({
        fingerprint: decision.fingerprint,
        reason: decision.reason,
      })),
    ),
    section(
      "Project-authored suppressions; do not emit matching findings",
      (input.priorRules ?? []).map((override) => ({
        id: override.id,
        match: override.match,
        reason: override.reason,
      })),
    ),
    section(
      "Recorded rulings; these choices are resolved and must not be observed again",
      input.rulingResolutions,
    ),
    `Return no more than ${input.modelCandidateAllowance} model candidate findings from only ${orList(categories)}. These candidates will be ranked with the already evaluated deterministic findings after this critique. Prioritize blocker, then major, then minor. Treat references and anti-references as equally binding judgment context: references identify qualities to follow and anti-references identify qualities to avoid. Every finding must cite at least one captured screenshot label from this request, use exactly that screenshot's state, viewport, and colorScheme when present, name the explicit product/design/reference guidance violated in rule, describe observable evidence, and provide observable acceptance criteria. Return references as the exact reference or anti-reference labels used by the finding; use an empty array when the finding does not rely on one, while reference-mismatch must cite at least one. confidence must be >= 0 and < 1. suggestedArea must name a UI surface, never a repository path. Do not emit a numeric or aggregate design score, rating, grade, or rubric total.${sweepInstructions.length === 0 ? "" : ` ${sweepInstructions.join(" ")}`}`,
    `Separately, return no more than ${input.decisionObservationAllowance} decisionObservations for visible states where the product makes a potentially systemic design choice that DESIGN.md does not rule on. These are questions, never findings. Emit at most one observation per visible state and choice. Spend this allowance on observations, not distinct choices: when the same choice appears in multiple visible states, emit it for each such state before introducing additional choice keys. Use a normalized project-wide choiceKey that will match the same choice in another state, but do not decide whether it recurs. Cite the exact visible screenshot coordinate and copy the nearest exact non-empty excerpt from DESIGN.md even though that passage does not settle the choice. A candidate ruling is optional and must never be invented: every candidate must cite either an exact DESIGN.md excerpt with kind law, or a screenshot in the full-run coordinate manifest showing the same choice already resolved on this governed flow with kind governed-surface. If neither precedent exists, candidates must be empty. Do not cite another flow or any image outside the full-run manifest. Do not repeat a choice listed in Recorded rulings.`,
    section("Exact JSON shape", {
      findings: [
        {
          category: "hierarchy",
          severity: "major",
          confidence: 0.8,
          rule: "Exact guidance violated",
          selectorHint: "stable UI surface selector or semantic hint",
          state: "captured-state",
          viewport: "captured-viewport",
          ...(screenshots.some((item) => item.colorScheme !== undefined)
            ? { colorScheme: "light" }
            : {}),
          screenshots: ["captured-state/captured-viewport"],
          references: [],
          explanation: "Observable problem and why it violates the guidance",
          suggestedArea: "surface-level area",
          acceptance: ["Observable criterion"],
        },
      ],
      decisionObservations: [
        {
          choiceKey: "systemic-choice-key",
          question: "What rule should govern this recurring choice?",
          state: "captured-state",
          viewport: "captured-viewport",
          ...(screenshots.some((item) => item.colorScheme !== undefined)
            ? { colorScheme: "light" }
            : {}),
          screenshot: "captured-state/captured-viewport",
          nearestLawExcerpt: "Exact excerpt copied from DESIGN.md",
          candidates: [
            {
              wording: "Candidate wording derived from cited precedent",
              precedent: {
                kind: "law",
                excerpt: "Exact excerpt copied from DESIGN.md",
              },
            },
          ],
        },
      ],
    }),
    ...(input.page === undefined
      ? []
      : input.page.pattern === undefined
        ? pageSections(
            input.page,
            screenshots.some((item) => item.colorScheme !== undefined),
          )
        : patternSections(
            input.page,
            input.page.pattern,
            screenshots.some((item) => item.colorScheme !== undefined),
          )),
  ].join("\n\n");
}
