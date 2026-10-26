import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProductionBuild } from "../capture/types.js";
import type { CheckCoverage, CheckTuple } from "../checks/types.js";
import { tupleDesigns } from "../design/evidence.js";
import type { DesignDescriptor } from "../design/types.js";
import {
  type ReportCoverage,
  renderCoverageMarkdown,
} from "../report/coverage.js";
import type { DesignDriftEvidence, Finding } from "../schemas/finding.js";
import type { RuleOverride } from "../schemas/rules.js";
import type { UnruledDecision } from "../schemas/ruling.js";
import type { AdvisoryReview } from "./advisory.js";
import type { SuppressedFinding } from "./findings.js";
import { describeSpread, type FindingGroup, isRepeated } from "./groups.js";

export type ReviewOutcome =
  | { kind: "full" }
  | { kind: "deterministic-only" }
  | { kind: "quick"; targets: string[] }
  | { kind: "degraded"; reason: string };

/** What a page review (`idiom review --page`) judged, for the report header. */
export type PageReviewScope = {
  url: string;
  brief?: string | undefined;
  direction?: string | undefined;
  focus: string[];
  sections: Array<{ id: string; heading?: string | undefined }>;
};

function pageScopeMarkdown(page: PageReviewScope): string[] {
  return [
    "## Page-review scope",
    "",
    `- Page: ${text(page.url)}`,
    `- Brief: ${page.brief === undefined ? "not supplied" : text(page.brief)}`,
    `- Art direction: ${page.direction === undefined ? "not supplied" : text(page.direction)}`,
    `- Focus areas: ${page.focus.length === 0 ? "none" : page.focus.map(text).join(", ")}`,
    "",
    "Only the brief is the source of truth for the offer and every statistic; claims were not fact-checked against the web.",
    "",
  ];
}

/** Section, brief/direction citations and fix of a page-review finding. */
export function pageFindingEvidence(
  finding: Finding,
  page: PageReviewScope | undefined,
): { section?: string; citations: string[]; fix?: string } {
  const sectionId = finding.evidence.section;
  const heading = page?.sections.find(
    (section) => section.id === sectionId,
  )?.heading;
  return {
    ...(sectionId === undefined
      ? {}
      : {
          section: `${sectionId}${heading === undefined ? "" : ` (${heading})`}`,
        }),
    citations: (finding.evidence.citations ?? []).map(
      (citation) =>
        `${citation.source === "brief" ? "Brief" : "Direction"} L${citation.line}: "${citation.excerpt}"`,
    ),
    ...(finding.fix === undefined ? {} : { fix: finding.fix }),
  };
}

function quickLimitsMarkdown(targets: string[]): string[] {
  return [
    "## Quick-review limits",
    "",
    `Only the supplied public URL${targets.length === 1 ? " was" : "s were"} visited; Idiom did not crawl links or submit forms:`,
    "",
    ...targets.map((target) => `- ${text(target)}`),
    "",
    "The following were not judged because quick review has no declared states, fixtures, credentials, product document, or design document:",
    "",
    "- fixture-dependent error and empty states",
    "- authenticated surfaces",
    "- destinations behind forms or other interactions",
    "- product-specific intent and design-law judgments",
    "- reference alignment and design-token judgments",
    "",
    "To judge those surfaces, run `idiom init`, define a flow manifest, then run `idiom review <flow>`.",
    "",
  ];
}

function text(value: string): string {
  return value
    .replace(/([\\`|[\]*_#])/g, "\\$1")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\r\n?|\n/g, "<br>");
}

function fencedEvidence(
  label: string,
  value: string,
  language = "text",
): string[] {
  const normalized = value.replace(/\r\n?/g, "\n");
  const longestRun = Math.max(
    0,
    ...(normalized.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [label, "", `${fence}${language}`, normalized, fence, ""];
}

function screenshotPathForLabel(
  tuples: CheckTuple[],
  label: string,
): string | undefined {
  return tuples.find((tuple) => {
    const tupleLabel = tuple.colorSchemeAxis
      ? `${tuple.state}/${tuple.viewport}/${tuple.colorScheme}`
      : `${tuple.state}/${tuple.viewport}`;
    return tupleLabel === label;
  })?.screenshotPath;
}

/** The representative's crop, else its first screenshot. */
export function groupCrop(
  group: FindingGroup,
  findings: Finding[],
): string | undefined {
  const screenshots =
    findings.find((finding) => finding.id === group.representative)?.evidence
      .screenshots ?? [];
  return screenshots.find((path) => path.includes("/crops/")) ?? screenshots[0];
}

function repeatedFindingsMarkdown(
  groups: FindingGroup[],
  findings: Finding[],
): string[] {
  const repeated = groups.filter(isRepeated);
  if (repeated.length === 0) return [];
  return [
    "## Repeated findings",
    "",
    "The same element failing the same rule, listed once with everywhere it was seen. Each member is still reported below under its own state.",
    "",
    ...repeated.map((group) => {
      const representative = findings.find(
        (finding) => finding.id === group.representative,
      );
      const params = representative?.verification.params ?? {};
      const where =
        typeof params.selector === "string"
          ? params.selector
          : (group.rule ?? group.category);
      const crop = groupCrop(group, findings);
      return `- ${group.id}: ${group.category} (${group.severity}) — ${text(where)} — ${describeSpread(group)}. Members: ${group.members.map((member) => member.id).join(", ")}.${crop === undefined ? "" : ` Crop: [${text(crop)}](${crop})`}`;
    }),
    "",
  ];
}

/** The advisory design-intent review, apart from every gating finding. */
export function advisoryMarkdown(review: AdvisoryReview): string[] {
  const lines = [
    "## Advisory design review (does not gate)",
    "",
    "A model pass told each declared pattern's intent, asked only for spacing, hierarchy and coherence problems. These results never fail `idiom check`, are not selected or ticketed, and cannot be decided through `idiom decide`.",
    "",
  ];
  if (review.outcome.kind === "degraded")
    lines.push(`Incomplete: ${text(review.outcome.reason)}`, "");
  for (const pattern of review.patterns) {
    lines.push(
      `### ${text(pattern.id)}`,
      "",
      `Intent: ${text(pattern.intent)}`,
      "",
      `Reference: ${pattern.reference === undefined ? "none" : text(pattern.reference)}`,
      "",
      `Status: ${pattern.status}${pattern.reason === undefined ? "" : ` (${text(pattern.reason)})`}`,
      "",
    );
    if (pattern.status === "ok" && pattern.findings.length === 0)
      lines.push("No advisory findings.", "");
    for (const { aspect, section, sectionHeading, finding } of pattern.findings)
      lines.push(
        `#### ${finding.id}: ${aspect} (${finding.severity}, advisory)`,
        "",
        `Section: ${text(section)}${sectionHeading === undefined ? "" : ` (${text(sectionHeading)})`} · ${text(finding.state)}/${text(finding.viewport)}${finding.colorScheme === undefined ? "" : `/${finding.colorScheme}`}`,
        "",
        text(finding.explanation),
        "",
        ...(finding.fix === undefined ? [] : [`Fix: ${text(finding.fix)}`, ""]),
        ...finding.acceptance.map((line) => `Done when: ${text(line)}`),
        "",
        `Evidence: ${finding.evidence.screenshots.map((path) => `[${path}](${path})`).join(" · ")}`,
        "",
      );
  }
  return lines;
}

export function renderReport(options: {
  flow: string;
  commit: string;
  build?: ProductionBuild | undefined;
  reportCoverage?: ReportCoverage | undefined;
  findings: Finding[];
  unruledDecisions?: UnruledDecision[] | undefined;
  discardedDecisionObservations?: number | undefined;
  tuples: CheckTuple[];
  coverage: Array<{ tuple: CheckTuple; coverage: CheckCoverage }>;
  captureCoverage?: CheckCoverage[] | undefined;
  narrowWidth?: number | undefined;
  outcome: ReviewOutcome;
  page?: PageReviewScope | undefined;
  advisory?: AdvisoryReview | undefined;
  suppressed?: SuppressedFinding[] | undefined;
  deferred?: Finding[] | undefined;
  groups?: FindingGroup[] | undefined;
  severityOverrides?:
    | Array<{
        fingerprint: string;
        override: RuleOverride;
        original: Finding["severity"];
        effective: Finding["severity"];
      }>
    | undefined;
}): string {
  const axisAware = options.tuples.some((tuple) => tuple.colorSchemeAxis);
  const heading =
    options.outcome.kind === "full"
      ? "Full"
      : options.outcome.kind === "deterministic-only"
        ? "Deterministic-only"
        : options.outcome.kind === "quick"
          ? "Quick"
          : "Degraded";
  const lines = [
    `# ${heading} review: ${options.flow}`,
    "",
    options.outcome.kind === "quick"
      ? `Source commit: \`${options.commit}\` (live URL capture; no Git source identity)`
      : `Captured commit: \`${options.commit}\``,
    ...(options.build === undefined
      ? []
      : [`Production build: \`${options.build.id}\``]),
    "",
    `${options.findings.length} actionable finding${options.findings.length === 1 ? "" : "s"}. Each finding is reported independently; no aggregate rating is produced.`,
    "",
  ];
  lines.push(
    ...repeatedFindingsMarkdown(options.groups ?? [], [
      ...options.findings,
      ...(options.deferred ?? []),
    ]),
  );
  if (options.reportCoverage !== undefined) {
    lines.push(renderCoverageMarkdown(options.reportCoverage), "");
  }
  if (options.outcome.kind === "quick") {
    lines.push(
      "Model layer: unavailable in quick review; deterministic checks ran against the captured public pages.",
      "",
    );
  } else if (options.outcome.kind === "full") {
    lines.push("Model layer: completed successfully.", "");
  } else if (options.outcome.kind === "deterministic-only") {
    lines.push("Model layer: skipped by choice (`--deterministic-only`).", "");
  } else {
    lines.push(
      "## Model layer did not run",
      "",
      `${text(options.outcome.reason)} Deterministic findings remain available.`,
      "",
    );
  }
  if (options.page !== undefined)
    lines.push(...pageScopeMarkdown(options.page));
  // Page reviews are standalone and take no part in rulings.
  const rulings =
    options.outcome.kind !== "quick" && options.page === undefined;
  if (rulings) lines.push("## Unruled decisions", "");
  if (rulings && options.outcome.kind !== "full") {
    lines.push(
      options.outcome.kind === "deterministic-only"
        ? "Unavailable because the model layer was skipped."
        : "Unavailable because the model layer did not complete.",
      "",
    );
  } else if (rulings && options.outcome.kind === "full") {
    const discarded = options.discardedDecisionObservations ?? 0;
    if (discarded > 0)
      lines.push(
        `${discarded} incomplete or unsupported observation${discarded === 1 ? " was" : "s were"} discarded; unruled-decision analysis may be incomplete.`,
        "",
      );
    if ((options.unruledDecisions?.length ?? 0) === 0)
      lines.push("None qualified across multiple states in this review.", "");
    for (const decision of options.unruledDecisions ?? []) {
      lines.push(
        `### ${text(decision.id)}: ${text(decision.choiceKey)}`,
        "",
        text(decision.question),
        "",
        ...fencedEvidence(
          "Nearest design-law passage:",
          decision.nearestLawExcerpt,
          "markdown",
        ),
        "Recurring evidence:",
        "",
        ...decision.occurrences.map(
          (item) =>
            `- ${text(item.state)} / ${text(item.viewport)}${item.colorScheme === undefined ? "" : ` / ${item.colorScheme}`} — ${text(item.screenshot)}`,
        ),
        "",
      );
      if (decision.candidates.length === 0) {
        lines.push(
          "No precedent-backed candidate is available. The question requires human wording or an explicit no-rule decision.",
          "",
        );
      } else {
        lines.push("Candidate rulings (not applied):", "");
        for (const [index, candidate] of decision.candidates.entries()) {
          lines.push(`${index + 1}. ${text(candidate.wording)}`, "");
          if (candidate.precedent.kind === "law")
            lines.push(
              ...fencedEvidence(
                "   Precedent — exact design-law excerpt:",
                candidate.precedent.excerpt,
                "markdown",
              ),
            );
          else {
            const path = screenshotPathForLabel(
              options.tuples,
              candidate.precedent.screenshot,
            );
            lines.push(
              `   Precedent — governed screenshot: ${path === undefined ? text(candidate.precedent.screenshot) : `[${text(candidate.precedent.screenshot)}](${path})`} (${text(candidate.precedent.state)} / ${text(candidate.precedent.viewport)}${candidate.precedent.colorScheme === undefined ? "" : ` / ${candidate.precedent.colorScheme}`})`,
              "",
            );
          }
        }
      }
    }
  }
  const states = [...new Set(options.tuples.map((tuple) => tuple.state))];
  for (const state of states) {
    lines.push(`## ${state}`, "");
    for (const tuple of options.tuples.filter(
      (entry) => entry.state === state,
    )) {
      lines.push(
        `### ${tuple.viewport}${axisAware ? ` / ${tuple.colorScheme}` : ""} (${tuple.width}×${tuple.height})${tuple.combination === undefined ? "" : ` [${text(tuple.combination)}]`}`,
        "",
      );
      const designs = tupleDesigns(tuple);
      for (const design of designs) {
        const name =
          designs.length > 1
            ? ` (${text(design.descriptor.name ?? "design")})`
            : "";
        lines.push(
          `${designSourceTitle(design.descriptor)}${name}: ${text(design.descriptor.source)}`,
          "",
          ...(design.regions?.uncompared.length
            ? [
                `Not compared: ${design.regions.uncompared.map((band) => `${band.side} rows ${band.top}–${band.top + band.height} px`).join("; ")}`,
                "",
              ]
            : []),
        );
        const figma = design.descriptor.figma;
        if (figma)
          lines.push(
            `Figma file version ${text(figma.version)} · [frame](${figma.link}) · variables: ${text(figma.variables)}`,
            "",
          );
        if (design.unavailable)
          lines.push(`Design unavailable: ${text(design.unavailable)}`, "");
        else if (design.screenshotPath)
          lines.push(`![Design${name}](${design.screenshotPath})`, "");
      }
      if (
        designs.some((design) => !design.unavailable && design.screenshotPath)
      )
        lines.push("App capture:", "");
      if (tuple.screenshotPath !== undefined)
        lines.push(
          `![${state} at ${tuple.viewport}${axisAware ? ` in ${tuple.colorScheme}` : ""}](${tuple.screenshotPath})`,
          "",
        );
      if (tuple.failure !== undefined)
        lines.push(
          `Capture failure: ${text(tuple.failure.message)} ([metadata](${tuple.metadataPath}))`,
          "",
        );
      const findings = options.findings.filter(
        (finding) =>
          finding.state === state &&
          finding.viewport === tuple.viewport &&
          finding.colorScheme ===
            (tuple.colorSchemeAxis ? tuple.colorScheme : undefined),
      );
      if (findings.length === 0) {
        lines.push("No findings.", "");
        continue;
      }
      for (const finding of findings) {
        const severityOverride = options.severityOverrides?.find(
          (item) => item.fingerprint === finding.fingerprint,
        );
        lines.push(
          `#### ${finding.id}: ${finding.category} (${finding.severity})`,
          "",
          ...(finding.evidence.designDrift
            ? [
                driftLine(finding.evidence.designDrift),
                "",
                ...designDriftMarkdown(finding.evidence.designDrift),
                ...(finding.evidence.designDrift.crops ?? []).map(
                  (crop) => `[${crop.label}](${crop.path})`,
                ),
                "",
                `Fix: ${text(finding.fix ?? "")}`,
                "",
              ]
            : []),
          `Layer: ${finding.layer}${finding.layer === "model" ? ` · Confidence: ${finding.confidence}` : ""}`,
          "",
          ...(severityOverride === undefined
            ? []
            : [
                `Severity override: ${severityOverride.original} -> ${severityOverride.effective} by rule ${text(severityOverride.override.id)} (${text(severityOverride.override.reason)})`,
                "",
              ]),
          ...(finding.rule === undefined
            ? []
            : [`Guidance: ${text(finding.rule)}`, ""]),
          ...((finding.evidence.references?.length ?? 0) === 0
            ? []
            : [
                `References: ${finding.evidence.references?.map(text).join(" · ")}`,
                "",
              ]),
          text(finding.explanation),
          "",
        );
        const pageEvidence = pageFindingEvidence(finding, options.page);
        if (pageEvidence.section !== undefined)
          lines.push(`Section: ${text(pageEvidence.section)}`, "");
        for (const citation of pageEvidence.citations)
          lines.push(text(citation), "");
        if (pageEvidence.fix !== undefined)
          lines.push(`Fix: ${text(pageEvidence.fix)}`, "");
        if (finding.evidence.consoleExcerpt !== undefined)
          lines.push(
            ...fencedEvidence(
              "Console evidence:",
              finding.evidence.consoleExcerpt,
            ),
          );
        if (finding.evidence.domSnippet !== undefined)
          lines.push(
            ...fencedEvidence(
              "DOM evidence:",
              finding.evidence.domSnippet,
              "html",
            ),
          );
        if ((finding.evidence.axeNodes?.length ?? 0) > 0)
          lines.push(
            ...fencedEvidence(
              "Accessibility evidence:",
              JSON.stringify(finding.evidence.axeNodes, null, 2),
              "json",
            ),
          );
        const extras = (finding.evidence.artifacts ?? []).filter(
          (path) => !finding.evidence.screenshots.includes(path),
        );
        if (extras.length > 0)
          lines.push(
            `Evidence: ${extras.map((path) => `[${path}](${path})`).join(" · ")}`,
            "",
          );
        lines.push(
          "Acceptance:",
          "",
          ...finding.acceptance.map((criterion) => `- ${text(criterion)}`),
          "",
        );
        if (finding.verification.kind === "deterministic-check")
          lines.push(
            `Verification: re-run \`${finding.verification.check ?? finding.category}\`.`,
            "",
          );
        else if (finding.verification.kind === "recapture-visual")
          lines.push(
            "Verification: recapture this state and visually compare the cited surface.",
            "",
          );
        else lines.push("Verification: manual confirmation is required.", "");
      }
    }
  }
  lines.push("## Suppressed findings", "");
  lines.push("Suppressed by prior decision or project rule:", "");
  if ((options.suppressed?.length ?? 0) === 0) {
    lines.push("None.", "");
  } else {
    for (const suppressed of options.suppressed ?? []) {
      const { finding } = suppressed;
      lines.push(
        `### ${finding.id}: ${finding.category} — ${finding.state}/${finding.viewport}${finding.colorScheme === undefined ? "" : `/${finding.colorScheme}`}${finding.combination === undefined ? "" : ` [${text(finding.combination)}]`}`,
        "",
        `Layer: ${finding.layer}`,
        "",
        `Fingerprint: \`${finding.fingerprint}\``,
        "",
        text(finding.explanation),
        "",
        ...("decision" in suppressed
          ? [
              `Decision: ${suppressed.decision.decision} (${suppressed.decision.scope}) on ${text(suppressed.decisionFindingId ?? finding.id)} — ${text(suppressed.decision.reason ?? "standing rule-scope rejection")}`,
            ]
          : [
              `Rule: ${text(suppressed.override.id)} — ${text(suppressed.override.reason)}`,
            ]),
        "",
      );
    }
  }
  lines.push("## Evaluated but not selected", "");
  lines.push(
    options.outcome.kind === "quick"
      ? "Eligible findings outside the five-finding material cap:"
      : "Eligible findings outside the configured material-finding cap:",
    "",
  );
  if ((options.deferred?.length ?? 0) === 0) {
    lines.push("None.", "");
  } else {
    for (const finding of options.deferred ?? []) {
      const severityOverride = options.severityOverrides?.find(
        (item) => item.fingerprint === finding.fingerprint,
      );
      lines.push(
        `- ${finding.id} (${finding.severity}) — Layer: ${finding.layer}${finding.layer === "model" ? ` · Confidence: ${finding.confidence}` : ""} — ${text(finding.flow)} / ${text(finding.state)} / ${text(finding.viewport)}${finding.colorScheme === undefined ? "" : ` / ${finding.colorScheme}`}${finding.combination === undefined ? "" : ` [${text(finding.combination)}]`} — ${text(finding.explanation)}${severityOverride === undefined ? "" : ` — Severity override: ${severityOverride.original} -> ${severityOverride.effective} by rule ${text(severityOverride.override.id)} (${text(severityOverride.override.reason)})`}`,
      );
      if (finding.evidence.designDrift)
        lines.push(
          "",
          `Fix: ${text(finding.fix ?? "")}`,
          "",
          ...(finding.evidence.designDrift.crops ?? []).map(
            (crop) => `[${crop.label}](${crop.path})`,
          ),
          "",
        );
    }
    lines.push("");
  }
  lines.push("## Check coverage", "");
  if (options.narrowWidth === undefined)
    lines.push(
      "Responsive and target checks were unavailable because the capture has no viewport tuples.",
      "",
    );
  else {
    const narrowNames = options.tuples
      .filter((tuple) => tuple.width === options.narrowWidth)
      .map((tuple) => tuple.viewport);
    lines.push(
      `Responsive and target checks use the minimum captured CSS width, ${options.narrowWidth}px (${[...new Set(narrowNames)].sort().join(", ")}).`,
      "",
    );
  }
  lines.push(
    axisAware
      ? "| State | Viewport | Scheme | Check | Coverage | Reason |"
      : "| State | Viewport | Check | Coverage | Reason |",
    axisAware
      ? "| --- | --- | --- | --- | --- | --- |"
      : "| --- | --- | --- | --- | --- |",
  );
  for (const coverage of options.captureCoverage ?? []) {
    lines.push(
      axisAware
        ? `| — | — | — | ${coverage.check} | ${coverage.status} | ${text(coverage.reason ?? "")} |`
        : `| — | — | ${coverage.check} | ${coverage.status} | ${text(coverage.reason ?? "")} |`,
    );
  }
  for (const entry of options.coverage) {
    lines.push(
      axisAware
        ? `| ${text(entry.tuple.state)} | ${text(entry.tuple.viewport)} | ${entry.tuple.colorScheme ?? "light"} | ${entry.coverage.check} | ${entry.coverage.status} | ${text(entry.coverage.reason ?? "")} |`
        : `| ${text(entry.tuple.state)} | ${text(entry.tuple.viewport)} | ${entry.coverage.check} | ${entry.coverage.status} | ${text(entry.coverage.reason ?? "")} |`,
    );
  }
  lines.push("");
  if (options.advisory !== undefined)
    lines.push(...advisoryMarkdown(options.advisory));
  if (options.outcome.kind === "quick") {
    lines.push(...quickLimitsMarkdown(options.outcome.targets));
  }
  return `${lines.join("\n")}\n`;
}

export async function writeReport(
  runDirectory: string,
  report: string,
): Promise<string> {
  const path = join(runDirectory, "report.md");
  const temporary = `${path}.tmp`;
  await writeFile(temporary, report);
  await rename(temporary, path);
  return path;
}

/** The finding line for a design-drift comparison: a region or a property. */
export function driftLine(drift: DesignDriftEvidence): string {
  if (drift.region)
    return `Region ${drift.region.id} · covers: ${drift.region.elements.length ? drift.region.elements.map((selector) => `\`${text(selector)}\``).join(", ") : "no single element"} · offset ${drift.region.offset}px`;
  return `Match: ${text(drift.method)} · Property: ${text(drift.property)}`;
}
export function designSourceTitle(descriptor: DesignDescriptor): string {
  return descriptor.resolved?.kind === "image"
    ? "Design image"
    : descriptor.resolved?.kind === "site"
      ? "Reference site"
      : "Design source";
}
/** Figma layer links and design-decision tables for a drift finding. */
function designDriftMarkdown(
  drift: NonNullable<Finding["evidence"]["designDrift"]>,
): string[] {
  const lines: string[] = [];
  if (drift.designLayerPath)
    lines.push(
      `Figma layer: ${drift.designLink ? `[${text(drift.designLayerPath)}](${drift.designLink})` : text(drift.designLayerPath)}${drift.designVariable ? ` · variable ${text(drift.designVariable)}` : ""}`,
      "",
    );
  const decision = drift.designDecision;
  if (decision)
    lines.push(
      "| Reference | Value | Matches build |",
      "| --- | --- | --- |",
      ...decision.references.map(
        (reference) =>
          `| ${reference.link ? `[${text(reference.name)}](${reference.link})` : text(reference.name)} | ${text(JSON.stringify(reference.value))} | ${reference.matchesBuild ? "yes" : "no"} |`,
      ),
      `| App (build) | ${text(JSON.stringify(decision.appValue))} | — |`,
      "",
    );
  if (drift.chosenReference)
    lines.push(`Chosen reference: ${text(drift.chosenReference)}`, "");
  return lines;
}
