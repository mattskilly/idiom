import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type InferredComponent,
  inferDesignComponents,
  mergeInferredComponents,
} from "../checks/design-components.js";
import {
  loadTokenDeclarations,
  type TokenDeclarations,
} from "../checks/observe.js";
import {
  collectStandingProhibitions,
  type StandingProhibition,
} from "../decisions/prohibitions.js";
import { readDecisions } from "../decisions/read.js";
import { IdiomError } from "../errors.js";
import { acceptanceText } from "../findings/presentation.js";
import { reachableProjectStores } from "../report/roots.js";
import {
  anyReportRootExists,
  loadReviewCatalog,
  type ReviewCatalog,
  reportRootsFor,
} from "../review/catalog.js";
import {
  anyTrackerRootExists,
  type FindingLifecycle,
  lineageDecision,
  reduceLifecycles,
  trackerRootsFor,
} from "../review/lifecycle.js";
import { compareFindingNames } from "../review/names.js";
import { parseRulingBlocks } from "../rulings/law.js";
import type { Decision } from "../schemas/decision.js";
import type { ChecksSettings } from "../schemas/project.js";
import type { RuleOverride, Rules } from "../schemas/rules.js";
import type { RulingResolution } from "../schemas/ruling.js";
import { loadProjectContext, validateNamedFlow } from "../validation.js";
import type { GitTopology } from "../verify/baseline.js";

/** Documented hard ceiling on a rendered brief, measured in UTF-8 bytes. */
export const BRIEF_BYTE_CEILING = 12_000;

export const REVIEW_EVIDENCE_UNAVAILABLE =
  "Review evidence: unavailable in this checkout";
export const TRACKER_STATE_UNAVAILABLE =
  "Tracker state: unavailable in this checkout";
export const TOKENS_NOT_CONFIGURED =
  "design.tokensFile is not configured; token coverage is unavailable.";

export type BriefProhibition =
  | Omit<Extract<StandingProhibition, { kind: "described" }>, "evidence">
  | Extract<StandingProhibition, { kind: "degraded" }>;

export type BriefAcceptedWork = {
  id: string;
  severity: string;
  category: string;
  surface: string;
  explanation: string;
  acceptance: string[];
  tracker: string;
  verification: string;
};

export type DesignBrief = {
  flow: string | undefined;
  design: string;
  rulings: RulingResolution[];
  product: string;
  tokens: TokenDeclarations;
  rules: RuleOverride[];
  prohibitions: BriefProhibition[];
  accepted: BriefAcceptedWork[];
  evidence: { review: boolean; tracker: boolean };
  /** The deterministic craft checks, so agents avoid what review will flag. */
  checks?: ChecksSettings | undefined;
  /** Component sizes inferred from the design file (explicit config wins). */
  inferredComponents?: InferredComponent[] | undefined;
};

export type ContextDependencies = {
  gitTopology?: GitTopology | undefined;
};

async function requiredDocument(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new IdiomError(
      `cannot read ${JSON.stringify(label)} for the design brief: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function trackerLabel(lifecycle: FindingLifecycle | undefined): string {
  const ticket = lifecycle?.ticket;
  if (ticket === undefined) return "none";
  if (ticket.state === undefined) return "unknown state";
  return ticket.state === "custom" ? "custom checkpoint" : ticket.state;
}

function collectAcceptedWork(
  catalog: ReviewCatalog,
  decisions: readonly Decision[],
  lifecycles: readonly FindingLifecycle[],
  flow: string | undefined,
): BriefAcceptedWork[] {
  const byId = new Map(
    lifecycles.map((lifecycle) => [lifecycle.id, lifecycle] as const),
  );
  const accepted: BriefAcceptedWork[] = [];
  for (const lineage of catalog.lineages) {
    // The same latest-occurrence semantics ticket eligibility uses.
    const decision = lineageDecision(lineage, decisions, lineage.latest);
    if (decision?.decision !== "accept") continue;
    const lifecycle = byId.get(lineage.id);
    if (lifecycle?.verification === "verified-fixed") continue;
    if (lifecycle?.ticket?.state === "done") continue;
    const finding = lineage.latest.finding;
    if (flow !== undefined && finding.flow !== flow) continue;
    accepted.push({
      id: lineage.id,
      severity: finding.severity,
      category: finding.category,
      surface: `${finding.flow}/${finding.state}/${finding.viewport}${finding.colorScheme === undefined ? "" : `/${finding.colorScheme}`}`,
      explanation: finding.explanation,
      acceptance: acceptanceText(finding),
      tracker: trackerLabel(lifecycle),
      verification: lifecycle?.verification ?? "none",
    });
  }
  return accepted.sort((left, right) => compareFindingNames(left.id, right.id));
}

function selectRules(rules: Rules, flow: string | undefined): RuleOverride[] {
  // With no flow the brief is the complete project-wide view, so every
  // flow-specific override is retained and annotated rather than filtered out.
  if (flow === undefined) return rules.overrides;
  return rules.overrides.filter(
    (override) =>
      override.match.flow === undefined || override.match.flow === flow,
  );
}

export async function collectDesignBrief(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow?: string | undefined;
  dependencies?: ContextDependencies | undefined;
}): Promise<DesignBrief> {
  const context = await loadProjectContext(options);
  if (options.flow !== undefined)
    await validateNamedFlow(context, options.flow);

  const designSource = await requiredDocument(
    join(context.projectDirectory, context.project.design.designFile),
    context.project.design.designFile,
  );
  const parsedLaw = parseRulingBlocks(designSource);
  const product = await requiredDocument(
    join(context.projectDirectory, context.project.design.productFile),
    context.project.design.productFile,
  );
  const tokens = await loadTokenDeclarations(
    context.projectDirectory,
    context.project.design.tokensFile,
    context.project.design.tokens,
  );

  const stores = await reachableProjectStores(
    context.projectDirectory,
    options.dependencies?.gitTopology,
  );
  const { additionalReportRoots, additionalTrackerRoots } = stores;

  const catalog = await loadReviewCatalog({
    project: context.projectDirectory,
    additionalReportRoots,
    additionalTrackerRoots,
  });
  const decisions = await readDecisions(context.projectDirectory);
  const lifecycles = await reduceLifecycles({
    catalog,
    decisions,
    additionalTrackerRoots,
  });

  return {
    flow: options.flow,
    design: parsedLaw.prose,
    rulings: parsedLaw.resolutions,
    product,
    tokens,
    rules: selectRules(context.rules, options.flow),
    checks: context.project.checks,
    inferredComponents: mergeInferredComponents(
      context.project.checks.components,
      inferDesignComponents(designSource, context.project.design.designFile),
    ),
    prohibitions: collectStandingProhibitions(catalog, decisions).map(
      (prohibition): BriefProhibition => {
        if (prohibition.kind === "degraded") return prohibition;
        const { evidence: _evidence, ...briefProhibition } = prohibition;
        return briefProhibition;
      },
    ),
    accepted: collectAcceptedWork(catalog, decisions, lifecycles, options.flow),
    evidence: {
      // Both markers mean the same thing: the store is absent from this
      // checkout. A present store holding no runs is a genuine answer.
      review: await anyReportRootExists(
        reportRootsFor(context.projectDirectory, additionalReportRoots),
      ),
      tracker: await anyTrackerRootExists(
        trackerRootsFor(context.projectDirectory, additionalTrackerRoots),
      ),
    },
  };
}

type Section = {
  title: string;
  priority: number;
  markers: string[];
  entries: string[][];
  emptyText: string;
  unit: "entries" | "lines";
  spaced: boolean;
};

function documentLines(source: string): string[][] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  return lines.map((line) => [line]);
}

/**
 * Free text recorded elsewhere may carry newlines. An entry line must stay one
 * line, or truncation could cut an entry apart at a boundary the allocator does
 * not know about.
 */
function inline(value: string): string {
  return value.replace(/[ \t]*[\r\n]+[ \t]*/gu, " ").trim();
}

function matchText(match: RuleOverride["match"]): string {
  // Schema-field order, so flow provenance always reads in the same place.
  const fields: Array<[string, string | undefined]> = [
    ["fingerprint", match.fingerprint],
    ["category", match.category],
    ["flow", match.flow],
    ["state", match.state],
    ["rule", match.rule],
  ];
  return fields
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
}

function prohibitionEntry(prohibition: BriefProhibition): string[] {
  const reason = `  Reason: ${
    prohibition.reason === undefined
      ? "No reason recorded"
      : inline(prohibition.reason)
  }`;
  const rejections = `  Rejections: ${prohibition.rejections}`;
  const applies = "  Applies: project-wide, in every flow and state";
  if (prohibition.kind === "degraded") {
    return [
      `- Do not reintroduce the standing rejected pattern identified by fingerprint ${prohibition.fingerprint}; descriptive finding evidence is unavailable.`,
      reason,
      rejections,
      applies,
    ];
  }
  return [
    `- Do not repeat this rejected pattern: ${inline(prohibition.behavior)}`,
    `  Rule: ${inline(prohibition.rule)}`,
    reason,
    rejections,
    applies,
    `  First observed: ${prohibition.surface}`,
  ];
}

function acceptedEntry(work: BriefAcceptedWork): string[] {
  return [
    `- ${work.id} — ${work.severity} ${work.category} in ${work.surface}`,
    `  ${inline(work.explanation)}`,
    "  Acceptance:",
    ...work.acceptance.map((criterion) => `  - ${inline(criterion)}`),
    `  Tracker: ${work.tracker}`,
    `  Verification: ${work.verification}`,
  ];
}

function tokenEntries(tokens: TokenDeclarations): string[][] {
  if (tokens.status === "not-configured") return [];
  const fileEntries =
    tokens.source === "design.tokens"
      ? []
      : Object.entries(tokens.declarations)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, value]) => [`${name}: ${inline(value)}`]);
  return [
    ...fileEntries,
    ...(tokens.inline ?? []).map((t) => [
      `${t.name}: ${inline(t.value)}${t.theme === undefined ? "" : ` (theme ${t.theme})`}`,
    ]),
  ];
}

function rulingEntry(ruling: RulingResolution): string[] {
  return [
    `- ${ruling.id} — ${ruling.outcome === "rule" ? inline(ruling.wording as string) : "No rule needed (deliberately left unruled)"}`,
    `  Choice: ${inline(ruling.choiceKey)}`,
    `  Fingerprint: ${ruling.fingerprint}`,
    ...(ruling.reason === undefined
      ? []
      : [`  Reason: ${inline(ruling.reason)}`]),
  ];
}

/**
 * What `idiom check` will reject, phrased as instructions for whoever is
 * writing the UI. Values come from the project's own configuration.
 */
export function craftCheckEntries(
  checks: ChecksSettings,
  inferred: InferredComponent[] = [],
): string[][] {
  const entries = [
    "- Every icon-only or single-glyph control (?, ⋮, ×, a bare icon) has a visible tooltip on hover and focus and an accessible name that says what it does; a disabled one says why.",
    "- Every enabled button does something visible when clicked. If it cannot work yet, disable it with a reason or leave it out.",
    '- Text that reads like a link ("View terms", "Learn more", "Help") is a real link or button; use href="#" as a visible placeholder rather than dead text.',
    "- One persistent entry point per action. Do not add a second gear, menu item or disguised button that opens the same panel or focuses the same field.",
    `- Neighbouring controls keep at least ${checks.minGap}px between them, including a focused field's ring; so do bordered shapes within the same group or row. Layout regions (rails, panels, dialog sections) and small indicator dots may sit flush. Joined groups (segmented controls, input groups) square their touching corners.`,
    `- Single-line labels in chips, buttons and badges sit on the vertical centre of their box (within ${checks.centeringTolerance}px); balance padding or line-height instead of nudging.`,
    '- Visible copy is product language: no camelCase or dotted token names (onPrimary, color.text), no Group/Token paths, no stutter ("On primary on primary"), and one casing convention per set of sibling labels.',
    "- Icons come from the product's icon set, not Unicode glyphs (▾ ▸ ◆ ◉ ▣ ↗ ×) standing in for them.",
    '- Failures render a designed fallback, never raw engineering text ("Renderer failed", stack traces, [object Object], JSON).',
    "- Form controls in a view either all use the product's styled control or all use the native one.",
    '- A button never looks like a text field: no placeholder-like copy ("Describe a change", "Search…") on a button, and no readonly or disabled field styled as editable without saying why.',
    '- On first load nothing claims prior work: undo/redo start disabled and no "unsaved changes" indicator shows.',
    "- In dark mode every surface follows its surroundings: no field, card or panel stays light while its container and neighbours darken. Primary-action labels reach 4.5:1 contrast in every scheme, at any text size.",
  ].map((line) => [line]);
  if (checks.frame.selector !== undefined)
    entries.push([
      `- The page frame (${checks.frame.selector}) stands apart from what surrounds it: a fill at least ${checks.frame.minLuminanceDelta} luminance away, a visible border, or a shadow.`,
    ]);
  for (const component of checks.components)
    entries.push([
      `- "${component.name}" (${component.selector}) renders at ${component.width}×${component.height}px (±the ${component.tolerance.mode === "tighter" ? "smaller" : "larger"} of ${Math.round(component.tolerance.ratio * 100)}% and ${component.tolerance.px}px per dimension).`,
    ]);
  for (const component of inferred) {
    const size =
      component.width === undefined
        ? `renders ${component.height}px high`
        : component.height === undefined
          ? `renders ${component.width}px wide`
          : `renders at ${component.width}×${component.height}px`;
    entries.push([
      `- "${component.name}" ${size} (inferred from ${component.source}; selector resolved at capture from class or aria-label words "${component.words.join(" ")}"; set checks.components to override).`,
    ]);
  }
  for (const pair of checks.mirrored)
    entries.push([
      `- "${pair.name}": ${pair.a} and ${pair.b} mirror each other — same size, same kind of element (icon or text), same type, each the same distance from the canvas-facing edge of its own panel.`,
    ]);
  for (const term of checks.copy.glossary)
    entries.push([
      term.preferred === undefined
        ? `- Do not use the term "${term.term}".`
        : `- Say "${term.preferred}", not "${term.term}".`,
    ]);
  if (checks.copy.locale !== undefined)
    entries.push([`- Spell in ${checks.copy.locale}.`]);
  entries.push([
    "- After any UI change, run `idiom check <flow>` and fix every blocker and major finding before calling the work done.",
  ]);
  return entries;
}

function buildSections(brief: DesignBrief): Section[] {
  const reviewMarkers = brief.evidence.review
    ? []
    : [REVIEW_EVIDENCE_UNAVAILABLE];
  return [
    {
      title: "Recorded rulings",
      priority: 0,
      markers: [],
      entries: brief.rulings.map(rulingEntry),
      emptyText: "No design rulings recorded.",
      unit: "entries",
      spaced: true,
    },
    {
      title: "Design law",
      priority: 1,
      markers: [],
      entries: documentLines(brief.design),
      emptyText: "No design law recorded.",
      unit: "lines",
      spaced: false,
    },
    {
      // Distilled judgment is the least replaceable content in the brief, so it
      // is allocated before the prose it was distilled from. Sections render in
      // declaration order regardless.
      title: "Standing prohibitions",
      priority: 0,
      markers: reviewMarkers,
      entries: brief.prohibitions.map(prohibitionEntry),
      emptyText: "No standing rule-scope rejections recorded.",
      unit: "entries",
      spaced: true,
    },
    ...(brief.checks === undefined
      ? []
      : [
          {
            title: "Craft checks",
            priority: 1,
            markers: [],
            entries: craftCheckEntries(brief.checks, brief.inferredComponents),
            emptyText: "",
            unit: "entries" as const,
            spaced: false,
          },
        ]),
    {
      title: "Design tokens",
      priority: 2,
      markers: [],
      entries: tokenEntries(brief.tokens),
      emptyText: TOKENS_NOT_CONFIGURED,
      unit: "entries",
      spaced: false,
    },
    {
      title: "Project rules",
      priority: 2,
      markers: [],
      entries: brief.rules.map((override) => [
        `- ${override.id}: ${
          override.action === "suppress"
            ? "suppress"
            : `severity ${override.severity}`
        } when ${matchText(override.match)} — ${inline(override.reason)}`,
      ]),
      emptyText: "No project rule overrides recorded.",
      unit: "entries",
      spaced: false,
    },
    {
      title: "Accepted work not yet built",
      priority: 3,
      markers: [
        ...reviewMarkers,
        ...(brief.evidence.tracker ? [] : [TRACKER_STATE_UNAVAILABLE]),
      ],
      entries: brief.accepted.map(acceptedEntry),
      emptyText: "No accepted findings are outstanding.",
      unit: "entries",
      spaced: true,
    },
    {
      title: "Product intent",
      priority: 4,
      markers: [],
      entries: documentLines(brief.product),
      emptyText: "No product intent recorded.",
      unit: "lines",
      spaced: false,
    },
  ];
}

function linesCost(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) total += Buffer.byteLength(line, "utf8") + 1;
  return total;
}

function omissionLine(count: number, unit: Section["unit"]): string {
  const noun =
    unit === "lines"
      ? count === 1
        ? "line"
        : "lines"
      : count === 1
        ? "entry"
        : "entries";
  return `(${count} further ${noun} omitted to stay within the ${BRIEF_BYTE_CEILING}-byte ceiling)`;
}

function renderSection(
  section: Section,
  taken: readonly string[][],
  dropped: number,
): string[] {
  const body: string[] = [];
  for (const entry of taken) {
    if (section.spaced && body.length > 0) body.push("");
    body.push(...entry);
  }
  if (dropped > 0) {
    if (section.spaced && body.length > 0) body.push("");
    body.push(omissionLine(dropped, section.unit));
  }
  const content = body.length === 0 ? [section.emptyText] : body;
  return [
    `## ${section.title}`,
    "",
    ...section.markers,
    ...(section.markers.length > 0 ? [""] : []),
    ...content,
    "",
  ];
}

export function renderDesignBrief(brief: DesignBrief): string {
  const sections = buildSections(brief);
  const header = [
    "# Design brief",
    "",
    `Scope: ${brief.flow === undefined ? "project-wide" : `flow ${brief.flow}`}`,
    "",
    "Findings are measured (a deterministic rule with its measurement), observed (an action or probe with its timing and result), or judged (model critique with stated confidence when supplied). Treat judged findings as suggestions: severity gates count measured and observed findings by default; --fail-on-judged opts judged suggestions in.",
    "",
  ];

  // Reserve headers, markers, and one worst-case omission line per nonempty
  // section first, so law and prohibitions cannot be crowded out by prose and
  // no entry is ever cut apart from its reason.
  let used = linesCost(header);
  for (const section of sections) {
    used += linesCost(renderSection(section, [], 0));
    if (section.entries.length > 0) {
      used -= linesCost([section.emptyText]);
      used += linesCost([
        omissionLine(section.entries.length, section.unit),
        ...(section.spaced ? [""] : []),
      ]);
    }
  }

  const taken = sections.map(() => [] as string[][]);
  const order = sections
    .map((section, index) => ({ section, index }))
    .sort(
      (left, right) =>
        left.section.priority - right.section.priority ||
        left.index - right.index,
    );
  for (const { section, index } of order) {
    const chosen = taken[index] as string[][];
    for (const entry of section.entries) {
      const cost =
        linesCost(entry) + (section.spaced && chosen.length > 0 ? 1 : 0);
      if (used + cost > BRIEF_BYTE_CEILING) break;
      used += cost;
      chosen.push(entry);
    }
  }

  const lines = [...header];
  for (const [index, section] of sections.entries()) {
    const chosen = taken[index] as string[][];
    lines.push(
      ...renderSection(section, chosen, section.entries.length - chosen.length),
    );
  }
  while (lines.at(-1) === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

export async function designBrief(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow?: string | undefined;
  dependencies?: ContextDependencies | undefined;
}): Promise<string> {
  return renderDesignBrief(await collectDesignBrief(options));
}
