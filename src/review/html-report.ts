import type { ProductionBuild } from "../capture/types.js";
import { coverageStatusText, paintedCoverageText } from "../checks/painted.js";
import type { CheckCoverage, CheckTuple } from "../checks/types.js";
import { tupleDesigns } from "../design/evidence.js";
import type { LoadedDesign } from "../design/types.js";
import {
  acceptanceDescription,
  acceptanceText,
  basisDescription,
} from "../findings/presentation.js";
import { type ReportCoverage, renderCoverageHtml } from "../report/coverage.js";
import {
  badge,
  escapeHtml,
  escapeHtmlAttribute,
  evidenceLink,
  preformatted,
  renderHtmlDocument,
  reportRelativeHref,
} from "../report/html.js";
import type { DesignDriftEvidence, Finding } from "../schemas/finding.js";
import type { RuleOverride } from "../schemas/rules.js";
import type { UnruledDecision } from "../schemas/ruling.js";
import type { AdvisoryReview } from "./advisory.js";
import type { SuppressedFinding } from "./findings.js";
import { describeSpread, type FindingGroup, isRepeated } from "./groups.js";
import { orderFindings } from "./presentation-order.js";
import { buildIssueRankingContext } from "./ranking.js";
import {
  designSourceTitle,
  fallbackSentence,
  groupCrop,
  type PageReviewScope,
  pageFindingEvidence,
  type ReviewOutcome,
} from "./report.js";

export type ReviewHtmlOptions = {
  flow: string;
  commit: string;
  build?: ProductionBuild | undefined;
  reportCoverage?: ReportCoverage | undefined;
  findings: Finding[];
  unruledDecisions?: UnruledDecision[] | undefined;
  discardedDecisionObservations?: number | undefined;
  tuples: CheckTuple[];
  screenshots: ReadonlyMap<string, string>;
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
};

function findingCard(
  finding: Finding,
  severityOverrides: ReviewHtmlOptions["severityOverrides"],
  page?: PageReviewScope | undefined,
  screenshots?: ReadonlyMap<string, string>,
): string {
  const pageEvidence = pageFindingEvidence(finding, page);
  const severityOverride = severityOverrides?.find(
    (item) => item.fingerprint === finding.fingerprint,
  );
  const extras = (finding.evidence.artifacts ?? []).filter(
    (path) => !finding.evidence.screenshots.includes(path),
  );
  const verification =
    finding.verification.kind === "deterministic-check"
      ? `Re-run ${finding.verification.check ?? finding.category}.`
      : finding.verification.kind === "recapture-visual"
        ? "Recapture this state and visually compare the cited surface."
        : "Manual confirmation is required.";
  return `<article class="finding">
    <h4>${escapeHtml(finding.id)}: ${escapeHtml(finding.category)}</h4>
    <div class="summary">${badge(finding.severity, finding.severity)} ${badge(finding.layer)}${finding.basisDetails?.kind === "judged" && finding.basisDetails.confidence !== undefined ? ` ${badge(`confidence ${finding.basisDetails.confidence}`)}` : ""}</div>
    ${severityOverride === undefined ? "" : `<p><strong>Severity override:</strong> ${escapeHtml(severityOverride.original)} → ${escapeHtml(severityOverride.effective)} by rule ${escapeHtml(severityOverride.override.id)} (${escapeHtml(severityOverride.override.reason)})</p>`}
    ${finding.rule === undefined ? "" : `<p><strong>Guidance:</strong> ${escapeHtml(finding.rule)}</p>`}
    ${(finding.evidence.references?.length ?? 0) === 0 ? "" : `<p><strong>References:</strong> ${(finding.evidence.references ?? []).map((label) => escapeHtml(label)).join(" · ")}</p>`}
    <p><strong>Basis:</strong> ${escapeHtml(basisDescription(finding))}</p><p><strong>Machine condition:</strong> ${escapeHtml(acceptanceDescription(finding.acceptance))}</p><p>${escapeHtml(finding.explanation)}</p>
    ${finding.evidence.filmstrip?.sheet ? `<figure style="overflow-x:auto"><figcaption>Filmstrip (${escapeHtml(finding.evidence.filmstrip.status)})</figcaption><img style="max-width:none" src="${escapeHtmlAttribute(screenshots?.get(finding.evidence.filmstrip.sheet) ?? reportRelativeHref(finding.evidence.filmstrip.sheet))}" alt="Temporal frames for ${escapeHtmlAttribute(finding.id)}">${evidenceLink(finding.evidence.filmstrip.sheet, "Open filmstrip")}</figure>` : ""}
    ${finding.evidence.designDrift ? `<p>${driftHtml(finding.evidence.designDrift)}</p>${designDriftHtml(finding.evidence.designDrift)}<div class="comparison-pair">${(finding.evidence.designDrift.crops ?? []).map((crop) => `<figure><figcaption>${escapeHtml(crop.label)}</figcaption>${screenshots?.get(crop.path) ? `<img src="${escapeHtmlAttribute(screenshots.get(crop.path) as string)}" alt="${escapeHtmlAttribute(crop.label)}">` : ""}${evidenceLink(crop.path, crop.label)}</figure>`).join("")}</div>` : ""}
    ${pageEvidence.section === undefined ? "" : `<p><strong>Section:</strong> ${escapeHtml(pageEvidence.section)}</p>`}
    ${pageEvidence.citations.map((citation) => `<p>${escapeHtml(citation)}</p>`).join("")}
    ${pageEvidence.fix === undefined ? "" : `<p><strong>Fix:</strong> ${escapeHtml(pageEvidence.fix)}</p>`}
    ${finding.evidence.consoleExcerpt === undefined ? "" : preformatted("Console evidence", finding.evidence.consoleExcerpt)}
    ${finding.evidence.domSnippet === undefined ? "" : preformatted("DOM evidence", finding.evidence.domSnippet)}
    ${(finding.evidence.axeNodes?.length ?? 0) === 0 ? "" : preformatted("Accessibility evidence", JSON.stringify(finding.evidence.axeNodes, null, 2))}
    ${extras.length === 0 ? "" : `<p><strong>Local evidence:</strong> ${extras.map((path) => evidenceLink(path)).join(" · ")}</p>`}
    <h5>Acceptance criteria</h5>
    <ul>${acceptanceText(finding)
      .map((criterion) => `<li>${escapeHtml(criterion)}</li>`)
      .join("")}</ul>
    <p><strong>Verification:</strong> ${escapeHtml(verification)}</p>
  </article>`;
}

function repeatedSection(options: ReviewHtmlOptions): string {
  const repeated = (options.groups ?? []).filter(isRepeated);
  if (repeated.length === 0) return "";
  const findings = [...options.findings, ...(options.deferred ?? [])];
  return `<section><h2>Repeated findings</h2><p>The same element failing the same rule, listed once with everywhere it was seen. Each member is still reported under its own state.</p>${repeated
    .map((group) => {
      const crop = groupCrop(group, findings);
      return `<article class="panel"><h3>${escapeHtml(group.id)}: ${escapeHtml(group.category)}</h3><div class="summary">${badge(group.severity, group.severity)}</div><p>${escapeHtml(describeSpread(group))}</p><p class="meta">Members: ${escapeHtml(group.members.map((member) => member.id).join(", "))}</p>${crop === undefined ? "" : `<img class="screenshot" src="${escapeHtmlAttribute(reportRelativeHref(crop))}" alt="${escapeHtmlAttribute(`Representative crop for ${group.id}`)}">`}</article>`;
    })
    .join("")}</section>`;
}

function suppressedSection(items: SuppressedFinding[]): string {
  const content =
    items.length === 0
      ? "<p>None.</p>"
      : items
          .map(({ finding, ...suppressed }) => {
            const basis =
              "decision" in suppressed
                ? `Decision: ${suppressed.decision.decision} (${suppressed.decision.scope}) on ${suppressed.decisionFindingId ?? finding.id} — ${suppressed.decision.reason ?? "standing rule-scope rejection"}`
                : `Rule: ${suppressed.override.id} — ${suppressed.override.reason}`;
            return `<article class="panel"><h3>${escapeHtml(finding.id)}: ${escapeHtml(finding.category)} — ${escapeHtml(finding.state)}/${escapeHtml(finding.viewport)}${finding.colorScheme === undefined ? "" : `/${escapeHtml(finding.colorScheme)}`}${finding.combination === undefined ? "" : ` [${escapeHtml(finding.combination)}]`}</h3><p class="meta">${escapeHtml(finding.layer)} · ${escapeHtml(finding.fingerprint)}</p><p><strong>Basis:</strong> ${escapeHtml(basisDescription(finding))}</p><p><strong>Machine condition:</strong> ${escapeHtml(acceptanceDescription(finding.acceptance))}</p><p>${escapeHtml(finding.explanation)}</p><p>${escapeHtml(basis)}</p></article>`;
          })
          .join("");
  return `<section><h2>Suppressed findings</h2><p>Suppressed by prior decision or project rule.</p>${content}</section>`;
}

function coverageTable(options: ReviewHtmlOptions): string {
  const axisAware = options.tuples.some((tuple) => tuple.colorSchemeAxis);
  const rows = [
    ...(options.captureCoverage ?? []).map((coverage) => ({
      state: "—",
      viewport: "—",
      colorScheme: "—",
      coverage,
    })),
    ...options.coverage.map((entry) => ({
      state: entry.tuple.state,
      viewport: entry.tuple.viewport,
      colorScheme: entry.tuple.colorScheme ?? "light",
      coverage: entry.coverage,
    })),
  ];
  const narrow =
    options.narrowWidth === undefined
      ? "The responsive check was unavailable because the capture has no viewport tuples."
      : `The responsive check (responsive-break) runs only at the minimum captured CSS width, ${options.narrowWidth}px; at other viewports it is reported as not applicable.`;
  return `<section><h2>Check coverage</h2><p>${escapeHtml(narrow)}</p><table><thead><tr><th>State</th><th>Viewport</th>${axisAware ? "<th>Scheme</th>" : ""}<th>Check</th><th>Coverage</th><th>Reason</th></tr></thead><tbody>${rows
    .map(
      ({ state, viewport, colorScheme, coverage }) =>
        `<tr><td>${escapeHtml(state)}</td><td>${escapeHtml(viewport)}</td>${axisAware ? `<td>${escapeHtml(colorScheme)}</td>` : ""}<td>${escapeHtml(coverage.check)}</td><td>${escapeHtml(coverageStatusText(coverage.status))}</td><td>${escapeHtml(paintedCoverageText(coverage))}</td></tr>`,
    )
    .join("")}</tbody></table></section>`;
}

function designSystemSection(options: ReviewHtmlOptions): string {
  if (options.outcome.kind === "quick") return "";
  const questions = (options.unruledDecisions ?? []).filter(
    (decision) => decision.scaleCluster !== undefined,
  );
  if (questions.length === 0) return "";
  const articles = questions
    .map((decision) => {
      const cluster = decision.scaleCluster as NonNullable<
        UnruledDecision["scaleCluster"]
      >;
      const examples = cluster.examples
        .map((example) => {
          const source =
            example.crop === undefined
              ? undefined
              : options.screenshots.get(example.crop);
          return `<li>${escapeHtml(example.screenshot)} — <code>${escapeHtml(example.selector)}</code>${source === undefined ? "" : `<br><img class="screenshot" src="${escapeHtmlAttribute(source)}" alt="${escapeHtmlAttribute(`Occurrence of ${cluster.value} at ${example.selector}`)}">`}</li>`;
        })
        .join("");
      return `<article class="panel"><h3>${escapeHtml(decision.id)}: ${escapeHtml(cluster.value)} on ${escapeHtml(cluster.componentLabel)}</h3><p>${escapeHtml(decision.question)}</p><ul><li>Occurrences: ${cluster.count} (${cluster.distinctStates} state${cluster.distinctStates === 1 ? "" : "s"}, ${cluster.distinctElements} element${cluster.distinctElements === 1 ? "" : "s"})</li><li>Context: ${escapeHtml(cluster.context.component)} in ${escapeHtml(cluster.context.landmark)} at ${escapeHtml(cluster.context.viewport)}</li><li>Declared scale: ${escapeHtml(decision.nearestLawExcerpt)}</li><li>Suggested token: <code>${escapeHtml(cluster.suggestedToken)}</code></li></ul><h4>Examples</h4><ul>${examples}</ul>${preformatted("Answer", `idiom ruling --decision ${decision.id} --add-step [--token ${cluster.suggestedToken}]\nidiom ruling --decision ${decision.id} --drift`)}<p class="muted">Skip by not answering; it is asked again next run.</p></article>`;
    })
    .join("");
  return `<section><h2>Design system questions (${questions.length})</h2><p>Each repeats one off-scale value in one context. Its occurrences are held here instead of being reported as separate findings until you answer.</p>${articles}</section>`;
}

function unruledSection(options: ReviewHtmlOptions): string {
  if (options.outcome.kind === "quick" || options.page !== undefined) return "";
  if (options.outcome.kind !== "full")
    return `<section><h2>Unruled decisions</h2><p>${options.outcome.kind === "deterministic-only" ? "Unavailable because the model layer was skipped." : "Unavailable because the model layer did not complete."}</p></section>`;
  const discarded = options.discardedDecisionObservations ?? 0;
  const warning =
    discarded === 0
      ? ""
      : `<p>${discarded} incomplete or unsupported observation${discarded === 1 ? " was" : "s were"} discarded; unruled-decision analysis may be incomplete.</p>`;
  const decisions = (options.unruledDecisions ?? []).filter(
    (decision) => decision.scaleCluster === undefined,
  );
  const content =
    decisions.length === 0
      ? "<p>None qualified across multiple states in this review.</p>"
      : decisions
          .map((decision) => {
            const occurrences = `<ul>${decision.occurrences.map((item) => `<li>${escapeHtml(item.state)} / ${escapeHtml(item.viewport)}${item.colorScheme === undefined ? "" : ` / ${escapeHtml(item.colorScheme)}`} — ${escapeHtml(item.screenshot)}</li>`).join("")}</ul>`;
            const candidates =
              decision.candidates.length === 0
                ? "<p>No precedent-backed candidate is available. The question requires human wording or an explicit no-rule decision.</p>"
                : `<ol>${decision.candidates
                    .map((candidate) => {
                      const precedent = candidate.precedent;
                      const evidence =
                        precedent.kind === "law"
                          ? preformatted(
                              "Precedent — exact design-law excerpt",
                              precedent.excerpt,
                            )
                          : (() => {
                              const tuple = options.tuples.find((item) => {
                                const label = item.colorSchemeAxis
                                  ? `${item.state}/${item.viewport}/${item.colorScheme}`
                                  : `${item.state}/${item.viewport}`;
                                return label === precedent.screenshot;
                              });
                              const source =
                                tuple?.screenshotPath === undefined
                                  ? undefined
                                  : options.screenshots.get(
                                      tuple.screenshotPath,
                                    );
                              return `<p><strong>Precedent — governed screenshot:</strong> ${escapeHtml(precedent.screenshot)} (${escapeHtml(precedent.state)} / ${escapeHtml(precedent.viewport)}${precedent.colorScheme === undefined ? "" : ` / ${escapeHtml(precedent.colorScheme)}`})</p>${source === undefined ? "" : `<img class="screenshot" src="${escapeHtmlAttribute(source)}" alt="${escapeHtmlAttribute(`Precedent ${precedent.screenshot}`)}">`}`;
                            })();
                      return `<li><p>${escapeHtml(candidate.wording)}</p>${evidence}</li>`;
                    })
                    .join("")}</ol>`;
            return `<article class="panel"><h3>${escapeHtml(decision.id)}: ${escapeHtml(decision.choiceKey)}</h3><p>${escapeHtml(decision.question)}</p>${preformatted("Nearest design-law passage", decision.nearestLawExcerpt)}<h4>Recurring evidence</h4>${occurrences}<h4>Candidate rulings (not applied)</h4>${candidates}</article>`;
          })
          .join("");
  return `<section><h2>Unruled decisions</h2>${warning}${content}</section>`;
}

function advisorySection(review: AdvisoryReview | undefined): string {
  if (review === undefined) return "";
  return `<section><h2>Advisory design review</h2><p>A model pass told each declared pattern's intent, asked only for spacing, hierarchy and coherence problems. These results do not gate: they never fail idiom check and are not counted as actionable findings.</p>${review.outcome.kind === "degraded" ? `<p><strong>Incomplete:</strong> ${escapeHtml(review.outcome.reason)}</p>` : ""}${review.outcome.kind === "full" && review.outcome.fallback !== undefined ? `<p>${escapeHtml(fallbackSentence(review.outcome.fallback))}</p>` : ""}${review.patterns
    .map(
      (pattern) =>
        `<article class="panel"><h3>${escapeHtml(pattern.id)}</h3><p><strong>Intent:</strong> ${escapeHtml(pattern.intent)}</p><p class="meta">Reference: ${escapeHtml(pattern.reference ?? "none")} · Status: ${escapeHtml(pattern.status)}${pattern.reason === undefined ? "" : ` (${escapeHtml(pattern.reason)})`}</p>${
          pattern.status === "ok" && pattern.findings.length === 0
            ? "<p>No advisory findings.</p>"
            : pattern.findings
                .map(({ aspect, section, sectionHeading, finding }) => {
                  const crop =
                    finding.evidence.screenshots.find((path) =>
                      path.includes("/crops/"),
                    ) ?? finding.evidence.screenshots[0];
                  return `<article class="finding"><h4>${escapeHtml(finding.id)}: ${escapeHtml(aspect)}</h4><div class="summary">${badge(finding.severity, finding.severity)} ${badge("advisory")}</div><p><strong>Section:</strong> ${escapeHtml(section)}${sectionHeading === undefined ? "" : ` (${escapeHtml(sectionHeading)})`} · ${escapeHtml(finding.state)}/${escapeHtml(finding.viewport)}${finding.colorScheme === undefined ? "" : `/${escapeHtml(finding.colorScheme)}`}</p><p><strong>Basis:</strong> ${escapeHtml(basisDescription(finding))}</p><p><strong>Machine condition:</strong> ${escapeHtml(acceptanceDescription(finding.acceptance))}</p><p>${escapeHtml(finding.explanation)}</p>${finding.fix === undefined ? "" : `<p><strong>Fix:</strong> ${escapeHtml(finding.fix)}</p>`}<ul>${acceptanceText(
                    finding,
                  )
                    .map((line) => `<li>${escapeHtml(line)}</li>`)
                    .join(
                      "",
                    )}</ul>${crop === undefined ? "" : `<img class="screenshot" src="${escapeHtmlAttribute(reportRelativeHref(crop))}" alt="${escapeHtmlAttribute(`Advisory crop for ${finding.id}`)}">`}</article>`;
                })
                .join("")
        }</article>`,
    )
    .join("")}</section>`;
}

export function renderReviewHtmlReport(options: ReviewHtmlOptions): string {
  const axisAware = options.tuples.some((tuple) => tuple.colorSchemeAxis);
  const heading =
    options.outcome.kind === "full"
      ? "Full"
      : options.outcome.kind === "deterministic-only"
        ? "Deterministic-only"
        : options.outcome.kind === "quick"
          ? "Quick"
          : "Degraded";
  const outcome =
    options.outcome.kind === "quick"
      ? "Model layer is unavailable in quick review; deterministic checks ran against the captured public pages."
      : options.outcome.kind === "full"
        ? options.outcome.fallback === undefined
          ? "Model layer completed successfully."
          : fallbackSentence(options.outcome.fallback)
        : options.outcome.kind === "deterministic-only"
          ? "Model layer skipped by choice (--deterministic-only)."
          : `Model layer did not run: ${options.outcome.reason} Deterministic findings remain available.`;
  const rankedFindings = orderFindings(
    options.findings,
    buildIssueRankingContext(options.tuples),
  );
  const states = [...new Set(options.tuples.map((tuple) => tuple.state))];
  const stateSections = states
    .map((state) => {
      const tuples = options.tuples.filter((tuple) => tuple.state === state);
      return `<section><h2>${escapeHtml(state)}</h2>${tuples
        .map((tuple) => {
          const screenshot =
            tuple.screenshotPath === undefined
              ? undefined
              : options.screenshots.get(tuple.screenshotPath);
          const findings = rankedFindings.filter(
            (finding) =>
              finding.state === state &&
              finding.viewport === tuple.viewport &&
              finding.colorScheme ===
                (tuple.colorSchemeAxis ? tuple.colorScheme : undefined),
          );
          return `<section class="panel"><h3>${escapeHtml(tuple.viewport)}${axisAware ? ` / ${escapeHtml(tuple.colorScheme ?? "light")}` : ""} (${tuple.width}×${tuple.height})${tuple.combination === undefined ? "" : ` [${escapeHtml(tuple.combination)}]`}</h3>
          ${tuple.design ? designTupleHtml(tuple, screenshot, options.screenshots) : screenshot === undefined ? "" : `<img class="screenshot" src="${escapeHtmlAttribute(screenshot)}" alt="${escapeHtmlAttribute(`${state} at ${tuple.viewport}${axisAware ? ` in ${tuple.colorScheme}` : ""}`)}">`}
          ${tuple.failure === undefined ? "" : `<p><strong>Capture failure:</strong> ${escapeHtml(tuple.failure.message)} (${evidenceLink(tuple.metadataPath, "metadata")})</p>`}
          ${findings.length === 0 ? "<p>No findings.</p>" : findings.map((finding) => findingCard(finding, options.severityOverrides, options.page, options.screenshots)).join("")}
          </section>`;
        })
        .join("")}</section>`;
    })
    .join("");
  const deferred = options.deferred ?? [];
  const questionCount = (options.unruledDecisions ?? []).filter(
    (decision) => decision.scaleCluster !== undefined,
  ).length;
  const modelDecisionCount =
    (options.unruledDecisions?.length ?? 0) - questionCount;
  const deferredSection = `<section><h2>Evaluated but not selected</h2><p>${options.outcome.kind === "quick" ? "Eligible findings outside the five-finding material cap." : "Eligible findings outside the configured material-finding cap."}</p>${
    deferred.length === 0
      ? "<p>None.</p>"
      : `<ul>${deferred
          .map((finding) => {
            const severityOverride = options.severityOverrides?.find(
              (item) => item.fingerprint === finding.fingerprint,
            );
            if (finding.evidence.designDrift)
              return findingCard(
                finding,
                options.severityOverrides,
                options.page,
                options.screenshots,
              );
            return `<li><strong>${escapeHtml(finding.id)}</strong> (${escapeHtml(finding.severity)}, ${escapeHtml(finding.layer)}) — ${escapeHtml(finding.flow)} / ${escapeHtml(finding.state)} / ${escapeHtml(finding.viewport)}${finding.colorScheme === undefined ? "" : ` / ${escapeHtml(finding.colorScheme)}`}${finding.combination === undefined ? "" : ` [${escapeHtml(finding.combination)}]`} — ${escapeHtml(basisDescription(finding))} — ${escapeHtml(finding.explanation)}${severityOverride === undefined ? "" : ` — Severity override: ${escapeHtml(severityOverride.original)} → ${escapeHtml(severityOverride.effective)} by rule ${escapeHtml(severityOverride.override.id)} (${escapeHtml(severityOverride.override.reason)})`}</li>`;
          })
          .join("")}</ul>`
  }</section>`;
  const quickLimits =
    options.outcome.kind !== "quick"
      ? ""
      : `<section><h2>Quick-review limits</h2><p>Only the supplied public URL${options.outcome.targets.length === 1 ? " was" : "s were"} visited; Idiom did not crawl links, and form submission and non-GET requests were blocked while probing.</p><ul>${options.outcome.targets.map((target) => `<li>${escapeHtml(target)}</li>`).join("")}</ul><p>The following were not judged because quick review has no declared states, fixtures, credentials, product document, or design document:</p><ul><li>fixture-dependent error and empty states</li><li>authenticated surfaces</li><li>destinations behind forms or other interactions</li><li>product-specific intent and design-law judgments</li><li>reference alignment and design-token judgments</li></ul><p>To judge those surfaces, run <code>idiom init</code>, define a flow manifest, then run <code>idiom review &lt;flow&gt;</code>.</p></section>`;
  const pageScope =
    options.page === undefined
      ? ""
      : `<section><h2>Page-review scope</h2><ul><li>Page: ${escapeHtml(options.page.url)}</li><li>Brief: ${escapeHtml(options.page.brief ?? "not supplied")}</li><li>Art direction: ${escapeHtml(options.page.direction ?? "not supplied")}</li><li>Focus areas: ${escapeHtml(options.page.focus.length === 0 ? "none" : options.page.focus.join(", "))}</li></ul><p>Only the brief is the source of truth for the offer and every statistic; claims were not fact-checked against the web.</p></section>`;
  return renderHtmlDocument({
    title: `${heading} review: ${options.flow}`,
    body: `<header><h1>${escapeHtml(heading)} review: ${escapeHtml(options.flow)}</h1><p class="meta">${options.outcome.kind === "quick" ? "Source commit" : "Captured commit"}: ${escapeHtml(options.commit)}${options.outcome.kind === "quick" ? " (live URL capture; no Git source identity)" : ""}</p>${options.build === undefined ? "" : `<p class="meta">Production build: ${escapeHtml(options.build.id)}</p>`}<div class="summary">${badge(`${options.findings.length} actionable finding${options.findings.length === 1 ? "" : "s"}`)}${options.outcome.kind === "quick" || options.page !== undefined ? "" : ` ${badge(`${modelDecisionCount} unruled decision${modelDecisionCount === 1 ? "" : "s"}`)}`}${questionCount === 0 ? "" : ` ${badge(`${questionCount} design system question${questionCount === 1 ? "" : "s"}`)}`} ${badge(options.outcome.kind, options.outcome.kind === "full" ? "good" : "neutral")}</div><p>${escapeHtml(outcome)}</p><p class="muted">${options.outcome.kind === "quick" || options.page !== undefined ? "Each finding is reported independently." : "Findings and unruled decisions are independent. Findings are decided through idiom decide; rulings are recorded only through idiom ruling."}</p></header>${repeatedSection(options)}${options.reportCoverage === undefined ? "" : renderCoverageHtml(options.reportCoverage)}${pageScope}${designSystemSection(options)}${unruledSection(options)}${stateSections}${suppressedSection(options.suppressed ?? [])}${deferredSection}${coverageTable(options)}${advisorySection(options.advisory)}${quickLimits}`,
    printable: true,
  });
}

function driftHtml(drift: DesignDriftEvidence): string {
  if (drift.region)
    return `<strong>Region:</strong> ${escapeHtml(drift.region.id)} · <strong>Covers:</strong> ${drift.region.elements.length ? drift.region.elements.map((selector) => `<code>${escapeHtml(selector)}</code>`).join(", ") : "no single element"} · <strong>Offset:</strong> ${escapeHtml(String(drift.region.offset))}px`;
  return `<strong>Match:</strong> ${escapeHtml(drift.method)} · <strong>Property:</strong> ${escapeHtml(drift.property)} · Design ${escapeHtml(JSON.stringify(drift.designValue))} / App capture ${escapeHtml(JSON.stringify(drift.appValue))}`;
}

/** Each design reference beside the app capture, with Figma provenance. */
function designTupleHtml(
  tuple: CheckTuple,
  screenshot: string | undefined,
  screenshots: ReadonlyMap<string, string>,
): string {
  const designs = tupleDesigns(tuple);
  const several = designs.length > 1;
  const label = (design: LoadedDesign) =>
    several ? `Design: ${design.descriptor.name ?? "design"}` : "Design";
  const sources = designs
    .map((design) => {
      const figma = design.descriptor.figma;
      return `<p>${escapeHtml(designSourceTitle(design.descriptor))}${several ? ` (${escapeHtml(design.descriptor.name ?? "design")})` : ""}: ${escapeHtml(design.descriptor.source)}${figma ? ` · Figma file version ${escapeHtml(figma.version)} · <a href="${escapeHtmlAttribute(figma.link)}">frame</a> · variables: ${escapeHtml(figma.variables)}` : ""}</p>${design.regions?.uncompared.length ? `<p>Not compared${several ? ` (${escapeHtml(design.descriptor.name ?? "design")})` : ""}: ${escapeHtml(design.regions.uncompared.map((band) => `${band.side} rows ${band.top}–${band.top + band.height} px`).join("; "))}</p>` : ""}${design.unavailable ? `<p><strong>Design unavailable${several ? ` (${escapeHtml(design.descriptor.name ?? "design")})` : ""}:</strong> ${escapeHtml(design.unavailable)}</p>` : ""}`;
    })
    .join("");
  const figures = designs
    .filter((design) => !design.unavailable)
    .map(
      (design) =>
        `<figure><figcaption>${escapeHtml(label(design))}</figcaption>${design.screenshotPath && screenshots.get(design.screenshotPath) ? `<img src="${escapeHtmlAttribute(screenshots.get(design.screenshotPath) as string)}" alt="${escapeHtmlAttribute(label(design))}">${evidenceLink(design.screenshotPath, "Full design")}` : ""}</figure>`,
    );
  if (!figures.length) return sources;
  return `${sources}<div class="comparison-pair">${figures.join("")}<figure><figcaption>App capture</figcaption>${screenshot ? `<img src="${escapeHtmlAttribute(screenshot)}" alt="App capture">` : ""}${tuple.screenshotPath ? evidenceLink(tuple.screenshotPath, "Full app capture") : ""}</figure></div>`;
}

/** Figma layer link and, for a design decision, each reference beside the build. */
function designDriftHtml(
  drift: NonNullable<Finding["evidence"]["designDrift"]>,
): string {
  const layer = drift.designLayerPath
    ? `<p><strong>Figma layer:</strong> ${drift.designLink ? `<a href="${escapeHtmlAttribute(drift.designLink)}">${escapeHtml(drift.designLayerPath)}</a>` : escapeHtml(drift.designLayerPath)}${drift.designVariable ? ` · variable <code>${escapeHtml(drift.designVariable)}</code>` : ""}</p>`
    : "";
  const decision = drift.designDecision;
  const table = decision
    ? `<table><thead><tr><th>Reference</th><th>Value</th><th>Matches build</th></tr></thead><tbody>${decision.references
        .map(
          (reference) =>
            `<tr><td>${reference.link ? `<a href="${escapeHtmlAttribute(reference.link)}">${escapeHtml(reference.name)}</a>` : escapeHtml(reference.name)}</td><td>${escapeHtml(JSON.stringify(reference.value))}</td><td>${reference.matchesBuild ? "yes" : "no"}</td></tr>`,
        )
        .join(
          "",
        )}<tr><td>App (build)</td><td>${escapeHtml(JSON.stringify(decision.appValue))}</td><td>—</td></tr></tbody></table>`
    : "";
  const chosen = drift.chosenReference
    ? `<p><strong>Chosen reference:</strong> ${escapeHtml(drift.chosenReference)}</p>`
    : "";
  return `${layer}${table}${chosen}`;
}
