import { formatCritiqueTimeout } from "../duration.js";
import {
  type BriefAssertion,
  type BriefCriterion,
  type BriefOption,
  type CompleteStoredBrief,
  isCompleteBrief,
  type ResearchRun,
  type StoredBrief,
} from "../schemas/brief.js";
import type { BriefSection, BriefSettings } from "../schemas/project.js";

const CRITERION_ORDER: Array<[BriefCriterion["kind"], string]> = [
  ["geometry", "Geometry"],
  ["input-states", "Input states"],
  ["contrast", "Contrast"],
  ["behaviour", "Behaviour"],
];

/** Titles and headings are single-line. */
function line(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function pixels(value: number | { min: number; max: number }): string {
  return typeof value === "number"
    ? `${value}px`
    : `${value.min}–${value.max}px`;
}

function assertionForm(assertion: BriefAssertion): string {
  const tolerance = `±${assertion.tolerance}`;
  if ("sameSizeAs" in assertion)
    return `${assertion.axis === "both" ? "same size" : `same ${assertion.axis}`} as \`${assertion.sameSizeAs}\` ${tolerance}`;
  if ("within" in assertion) return `within \`${assertion.within}\``;
  if ("visibleWithoutHover" in assertion)
    return "visible without hover on touch";
  if ("stableOnHover" in assertion)
    return `no layout shift on hover (${tolerance}px)`;
  if ("minContrast" in assertion)
    return `contrast at least ${assertion.minContrast}:1`;
  const sizes = [
    ...(assertion.width === undefined
      ? []
      : [`width ${pixels(assertion.width)}`]),
    ...(assertion.height === undefined
      ? []
      : [`height ${pixels(assertion.height)}`]),
  ];
  return `${sizes.join(", ")} ${tolerance}`;
}

/** One line naming where and how Idiom checks an assertion. */
export function assertionText(assertion: BriefAssertion): string {
  return `${assertion.flow}/${assertion.state} — \`${assertion.selector}\` ${assertionForm(assertion)}`;
}

function optionTitle(option: BriefOption): string {
  return option.kind === "dont-build"
    ? `Don't build it — ${line(option.title)}`
    : line(option.title);
}

function costLine(option: BriefOption): string {
  return `space: ${line(option.cost.space)}; steps: ${line(option.cost.steps)}; new concepts: ${line(option.cost.concepts)}; code: ${line(option.cost.code)}`;
}

/** The chosen option on a decided brief: the recommendation unless named. */
export function chosenOption(brief: StoredBrief): BriefOption | undefined {
  if (brief.status !== "decided" || !isCompleteBrief(brief)) return undefined;
  const id = brief.chosenOption ?? brief.recommendation.option;
  return brief.options.find((option) => option.id === id);
}

function decidedSection(
  brief: CompleteStoredBrief,
  chosen: BriefOption,
  recommended: BriefOption,
): string[] {
  const others = brief.options.filter((option) => option !== chosen);
  return [
    brief.decision.trim(),
    `**Decision:** ${optionTitle(chosen)} (decided by ${line(brief.decidedBy ?? "requester")}). ${chosen.summary.trim()}`,
    ...(chosen === recommended
      ? [`Why: ${brief.recommendation.reason.trim()}`]
      : [
          `Recommended was ${optionTitle(recommended)}: ${brief.recommendation.reason.trim()}`,
        ]),
    `Cost: ${costLine(chosen)}`,
    "**Other options:**",
    others
      .map(
        (option) =>
          `- **${optionTitle(option)}**: ${option === recommended ? "recommended, not chosen" : line(option.rejectedBecause ?? "")} (cost: ${costLine(option)})`,
      )
      .join("\n"),
  ];
}

function decisionSection(brief: CompleteStoredBrief): string[] {
  const recommended = brief.options.find(
    (option) => option.id === brief.recommendation.option,
  ) as BriefOption;
  const chosen = chosenOption(brief);
  if (chosen !== undefined) return decidedSection(brief, chosen, recommended);
  const rejected = brief.options.filter((option) => option !== recommended);
  return [
    brief.decision.trim(),
    `**Recommendation:** ${optionTitle(recommended)}. ${recommended.summary.trim()}`,
    `Why: ${brief.recommendation.reason.trim()}`,
    `Cost: ${costLine(recommended)}`,
    "**Rejected options:**",
    rejected
      .map(
        (option) =>
          `- **${optionTitle(option)}**: ${line(option.rejectedBecause ?? "")} (cost: ${costLine(option)})`,
      )
      .join("\n"),
  ];
}

function cell(value: string): string {
  return line(value).replace(/\|/g, "\\|");
}

function optionsSection(brief: CompleteStoredBrief): string[] {
  const chosen = chosenOption(brief);
  return [
    [
      "| Option | Space | Steps | New concepts | Code |",
      "| --- | --- | --- | --- | --- |",
      ...brief.options.map(
        (option) =>
          `| ${cell(optionTitle(option))}${option.id === brief.recommendation.option ? " (recommended)" : ""}${option === chosen ? " (chosen)" : ""} | ${cell(option.cost.space)} | ${cell(option.cost.steps)} | ${cell(option.cost.concepts)} | ${cell(option.cost.code)} |`,
      ),
    ].join("\n"),
  ];
}

/** The recommended option, unless the human decided on another one. */
function overridden(
  brief: StoredBrief,
): { chosen: BriefOption; recommended: BriefOption } | undefined {
  const chosen = chosenOption(brief);
  if (
    chosen === undefined ||
    !isCompleteBrief(brief) ||
    chosen.id === brief.recommendation.option
  )
    return undefined;
  const recommended = brief.options.find(
    (option) => option.id === brief.recommendation.option,
  ) as BriefOption;
  return { chosen, recommended };
}

function criteriaSection(brief: CompleteStoredBrief): string[] {
  const override = overridden(brief);
  if (override?.chosen.kind === "dont-build")
    return [
      `**Nothing to build.** The decision is not to build it; the criteria written for the recommendation (${optionTitle(override.recommended)}) do not apply.`,
    ];
  const groups = CRITERION_ORDER.flatMap(([kind, label]) => {
    const statements = brief.acceptanceCriteria.filter(
      (criterion) => criterion.kind === kind,
    );
    if (statements.length === 0) return [];
    return [
      `**${label}**`,
      statements
        .map((criterion) =>
          [
            `- ${override === undefined ? "[ ] " : ""}${line(criterion.statement)}`,
            ...(criterion.assertions ?? []).map(
              (assertion) =>
                `  - Checked by Idiom: ${assertionText(assertion)}`,
            ),
          ].join("\n"),
        )
        .join("\n"),
    ];
  });
  if (override === undefined) return groups;
  return [
    `**Not ticket-ready.** These criteria were written for the recommendation (${optionTitle(override.recommended)}), not the chosen ${optionTitle(override.chosen)}. Re-record the brief with criteria for ${override.chosen.id} before using it as a ticket.`,
    ...groups,
  ];
}

/** "9m 12s", "45s": the run's duration in the cost line. */
export function formatResearchDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

/** "9m 12s, 4 calls, 18 turns, …, budget 15 minutes": figures the provider exposed. */
export function researchCostLine(run: ResearchRun): string {
  return [
    formatResearchDuration(run.durationMs),
    `${run.calls} ${run.calls === 1 ? "call" : "calls"}`,
    ...(run.turns === undefined ? [] : [`${run.turns} turns`]),
    ...(run.searches === undefined ? [] : [`${run.searches} searches`]),
    ...(run.tokens === undefined
      ? []
      : [
          `${run.tokens.input.toLocaleString("en-US")} input / ${run.tokens.output.toLocaleString("en-US")} output tokens`,
        ]),
  ]
    .join(", ")
    .concat(` (budget ${formatCritiqueTimeout(run.budgetMs)})`);
}

function evidenceSection(brief: StoredBrief): string[] {
  const unresearched = brief.researchRun?.incomplete?.unresearched ?? [];
  return [
    ...brief.research.flatMap((research) => [
      `### ${line(research.question)}`,
      research.findings === "nothing found"
        ? "- Nothing found."
        : research.findings
            .map(
              (finding) =>
                `- ${line(finding.claim)} ([source](${finding.source}), verified: ${finding.verified})`,
            )
            .join("\n"),
    ]),
    ...unresearched.flatMap((question) => [
      `### ${line(question)}`,
      "- Not researched (research incomplete).",
    ]),
    ...(brief.researchRun === undefined
      ? []
      : [
          `Research run: ${brief.researchRun.provider} ${line(brief.researchRun.model)}, ${researchCostLine(brief.researchRun)}.`,
        ]),
    "Request:",
    brief.request
      .trim()
      .split(/\r?\n/)
      .map((text) => (text === "" ? ">" : `> ${text}`))
      .join("\n"),
  ];
}

const NOT_REACHED = "Not reached: research incomplete.";

function sectionBody(
  section: BriefSection,
  brief: StoredBrief,
  settings: BriefSettings,
): string[] {
  switch (section.content) {
    case "decision":
      return isCompleteBrief(brief) ? decisionSection(brief) : [NOT_REACHED];
    case "options":
      return isCompleteBrief(brief) ? optionsSection(brief) : [NOT_REACHED];
    case "criteria":
      return isCompleteBrief(brief) ? criteriaSection(brief) : [NOT_REACHED];
    case "outOfScope":
      return [
        brief.outOfScope.length === 0
          ? "- Nothing listed."
          : brief.outOfScope.map((item) => `- ${line(item)}`).join("\n"),
      ];
    case "evidence":
      return evidenceSection(brief);
    case "references":
      return [
        settings.references.length === 0
          ? "No reference products configured."
          : settings.references
              .map(
                (reference) =>
                  `- **${line(reference.name)}** (${reference.tier}): ${line(reference.note)}`,
              )
              .join("\n"),
      ];
    case "text":
      return [section.body ?? ""];
  }
}

/** The ticket-ready brief; deterministic for a given record and settings. */
export function renderBrief(
  brief: StoredBrief,
  settings: BriefSettings,
): string {
  const status = [
    `Status: ${brief.status}`,
    ...(brief.decidedBy === undefined
      ? []
      : [`decided by ${line(brief.decidedBy)}`]),
    ...(brief.supersededBy === undefined
      ? []
      : [`superseded by ${brief.supersededBy}`]),
    ...(overridden(brief) === undefined ? [] : ["not ticket-ready"]),
    ...(brief.researchRun?.incomplete === undefined
      ? []
      : ["research incomplete"]),
    `rubric v${brief.rubricVersion}`,
  ].join(" · ");
  const blocks = [`# ${line(brief.title)}`, status];
  const incomplete = brief.researchRun?.incomplete;
  if (incomplete !== undefined)
    blocks.push(
      [
        `> ${line(incomplete.note)}`,
        ...(incomplete.unresearched.length === 0
          ? []
          : [
              `> Not researched: ${incomplete.unresearched.map(line).join("; ")}`,
            ]),
      ].join("\n"),
    );
  for (const section of settings.sections)
    blocks.push(
      `## ${line(section.heading)}`,
      ...sectionBody(section, brief, settings),
    );
  return `${blocks.join("\n\n")}\n`;
}
