import { type ReportCoverage, renderCoverageHtml } from "../report/coverage.js";
import {
  badge,
  comparison,
  escapeHtml,
  evidenceLink,
  type ImageComparison,
  renderHtmlDocument,
} from "../report/html.js";
import type { AttachmentManifest } from "./attachments.js";
import type { VerificationEvaluation } from "./evaluate.js";

export type VerificationHtmlOptions = {
  flow: string;
  baselineRunId: string;
  currentRunA: string;
  currentRunB: string;
  manifest: AttachmentManifest;
  comparisons?: ImageComparison[] | undefined;
  evaluation?: VerificationEvaluation | undefined;
  diagnostic?: string | undefined;
  noFindings?: boolean | undefined;
  reportCoverage?: ReportCoverage | undefined;
  filmstripImages?: ReadonlyMap<string, string> | undefined;
};

function attachments(options: VerificationHtmlOptions): string {
  if (options.manifest.composites.length === 0) return "";
  const films = (options.manifest.filmstrips ?? [])
    .map(
      (f) =>
        `<article><h3>${escapeHtml(f.kind)}: ${escapeHtml(f.finding)}</h3>${(
          ["before", "after"] as const
        )
          .map((side) => {
            const path = f[side];
            const image = path && options.filmstripImages?.get(path);
            return `<figure style="overflow-x:auto"><figcaption>${side}</figcaption>${path ? `${evidenceLink(path)}${image ? `<img style="max-width:none" src="${image}" alt="${side} filmstrip">` : ""}` : escapeHtml(f[side === "before" ? "beforeUnavailable" : "afterUnavailable"] ?? "unavailable")}</figure>`;
          })
          .join("")}</article>`,
    )
    .join("");
  return `<section>${films}<h2>Evidence attachments</h2>${options.manifest.composites
    .map((item, index) => {
      const images = options.comparisons?.find(
        (candidate) =>
          candidate.state === item.state &&
          candidate.viewport === item.viewport &&
          candidate.colorScheme === item.colorScheme,
      );
      return `<article><h3>${escapeHtml(item.state)} / ${escapeHtml(item.viewport)}${item.colorScheme === undefined ? "" : ` / ${escapeHtml(item.colorScheme)}`}</h3><p>${badge(item.kind)} ${evidenceLink(item.path, "Open composite PNG")}</p>${images === undefined ? "" : comparison(images, index)}</article>`;
    })
    .join("")}</section>`;
}

export function renderVerificationHtmlReport(
  options: VerificationHtmlOptions,
): string {
  if (options.noFindings === true) {
    return renderHtmlDocument({
      title: `Verification: ${options.flow}`,
      body: `<header><h1>Verification: ${escapeHtml(options.flow)}</h1><div class="summary">${badge("not applicable", "good")}</div><p>No embedded findings. No setup, build, server, browser, provider, or external API was invoked.</p><p class="muted">This report is read-only. Decisions are recorded only through idiom decide.</p></header>${options.reportCoverage === undefined ? "" : renderCoverageHtml(options.reportCoverage)}`,
      printable: true,
    });
  }
  const evaluation = options.evaluation;
  const failedDiagnostic = evaluation === undefined;
  const outcome = failedDiagnostic
    ? "failed — verification was not safely decidable"
    : evaluation.passed
      ? "passed"
      : "failed";
  const verdicts =
    evaluation === undefined
      ? `<section><h2>Diagnostic</h2><p>${escapeHtml(options.diagnostic ?? "unknown comparison failure")}</p><p>No finding was marked fixed.</p></section>`
      : `<section><h2>Finding verdicts</h2>${evaluation.findings
          .map(
            (verdict) =>
              `<article class="finding"><h3>${escapeHtml(verdict.finding.id)}</h3><div class="summary">${badge(verdict.status, verdict.status === "fixed" ? "good" : verdict.status)}</div><p class="meta">${escapeHtml(verdict.finding.state)} / ${escapeHtml(verdict.finding.viewport)}${verdict.finding.colorScheme === undefined ? "" : ` / ${escapeHtml(verdict.finding.colorScheme)}`} · ${escapeHtml(verdict.locus?.source ?? verdict.finding.verification.kind)}${verdict.locus?.target === undefined ? "" : ` · ${escapeHtml(verdict.locus.target)}`}</p><p>${escapeHtml(verdict.reason)}</p></article>`,
          )
          .join(
            "",
          )}</section><section><h2>New deterministic blockers</h2>${evaluation.newBlockers.length === 0 ? "<p>None.</p>" : `<ul>${evaluation.newBlockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join("")}</ul>`}</section>${evaluation.newFindings === undefined ? "" : `<section><h2>New deterministic findings (all severities)</h2>${evaluation.newFindings.length ? `<ul>${evaluation.newFindings.map((finding) => `<li>${escapeHtml(`${finding.severity}: ${finding.category} ${finding.rule ?? ""} at ${finding.key} (${finding.selector ?? "document"})`)}</li>`).join("")}</ul>` : "<p>None.</p>"}</section>`}`;
  const calibrations =
    evaluation === undefined
      ? ""
      : `<section><h2>Calibration and comparison basis</h2><p>Pixels and raw image dimensions are inspectable evidence only; they never determine the verdict. Date/time text and its reflow closure are excluded from verdict signatures.</p>${evaluation.calibrations
          .map((item) => {
            const reductions = item.baselineProfile.reductions;
            return `<article class="panel"><h3>${escapeHtml(item.state)} / ${escapeHtml(item.viewport)}${item.colorScheme === undefined ? "" : ` / ${escapeHtml(item.colorScheme)}`}</h3><p>Historical observation ${item.negotiated === "v1-compatible" ? "v1" : "v2"}; current observations v2/v2. Full-v2 and negotiated A/B evidence agree. Negotiated profile: ${escapeHtml(item.negotiated)}.</p><p><strong>Signatures:</strong> full-v2 current ${escapeHtml(item.fullV2Signature)}; negotiated historical ${escapeHtml(item.baselineProfile.signature)}; negotiated current ${escapeHtml(item.currentProfileB.signature)}.</p><p class="meta">Historical reduction: ${reductions.excludedNonRendered} non-rendered records excluded; text suppressed for ${reductions.textSuppressedBoundary} boundaries, ${reductions.textSuppressedTemporal} temporal records, and ${reductions.textSuppressedMask} masked records; ${reductions.geometrySuppressed} geometry records suppressed.</p>${reductions.maskStatus.map((mask) => `<p class="meta">Mask ${escapeHtml(mask.selector)}: ${escapeHtml(mask.status)}; transferred paths: ${mask.paths.length === 0 ? "none" : mask.paths.map(escapeHtml).join(", ")}.</p>`).join("")}</article>`;
          })
          .join("")}</section>`;
  return renderHtmlDocument({
    title: `Verification: ${options.flow}`,
    body: `<header><h1>Verification: ${escapeHtml(options.flow)}</h1><div class="summary">${badge(outcome, failedDiagnostic || evaluation?.passed !== true ? "failed" : "good")}</div><p>Historical baseline: ${escapeHtml(options.baselineRunId)}. Current calibration runs: ${escapeHtml(options.currentRunA)} and ${escapeHtml(options.currentRunB)}.</p><p class="muted">This report is read-only. Decisions are recorded only through idiom decide.</p></header>${options.reportCoverage === undefined ? "" : renderCoverageHtml(options.reportCoverage)}${calibrations}${verdicts}${attachments(options)}`,
    interactive: (options.comparisons?.length ?? 0) > 0,
    printable: true,
  });
}
