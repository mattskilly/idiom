import { rename, writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { basisDescription } from "../findings/presentation.js";
import {
  renderCoverageHtml,
  renderCoverageMarkdown,
} from "../report/coverage.js";
import {
  escapeHtml,
  escapeHtmlAttribute,
  reportContentSecurityPolicy,
} from "../report/html.js";
import { renderClusterTicketsResult } from "../tickets/emit.js";
import type { ProductSweepSummary } from "./types.js";

const href = (s: ProductSweepSummary, path: string) =>
  relative(s.runDirectory, path).split(sep).map(encodeURIComponent).join("/");
const text = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]])/g, "\\$1");
export function renderProductSweep(s: ProductSweepSummary): string {
  return [
    `idiom sweep --all: ${s.flows.length} flow(s), ${s.findings.length} actionable finding(s), ${s.occurrenceCount} occurrence(s), ${s.proposalCount} proposal(s).`,
    `Coverage: ${s.flows.filter((f) => f.status === "reviewed").length} reviewed; ${s.flows.filter((f) => f.status === "failed").length} failed. ${s.outcome.kind === "degraded" ? s.outcome.reason : s.outcome.kind}.`,
    `Tickets: ${s.selectedCount} selected, ${s.omittedCount} additional new proposal(s) omitted by budget.`,
    ...s.proposals.map(
      (p, i) =>
        `${i + 1}. [${p.severity}] score ${p.score.toFixed(2)} — ${p.cluster.cause?.cause ?? p.cluster.component} (${p.findingIds.join(", ")}) — ${p.cluster.members.map((m) => basisDescription(m.record.finding)).join("; ")}`,
    ),
    ...(s.tickets === undefined ? [] : [renderClusterTicketsResult(s.tickets)]),
    `Polish report: ${s.reportPath}`,
    `HTML: ${s.htmlReportPath}`,
    `JSON: ${s.jsonPath}`,
    "",
  ].join("\n");
}

export function polishMarkdown(s: ProductSweepSummary): string {
  return [
    "# Whole-product polish",
    "",
    text(renderProductSweep(s)),
    "",
    `Severity counts (all findings): ${JSON.stringify(s.severityCounts)}`,
    `Rule counts (all findings): ${text(JSON.stringify(s.ruleCounts))}`,
    "",
    "## Ranked cleanup tickets",
    "",
    ...s.proposals.flatMap((p, i) => [
      `### ${i + 1}. ${text(p.cluster.cause?.cause ?? p.cluster.component)}`,
      "",
      `Salience ${p.salience}; prominence ${p.prominence}; score ${p.score}. ${text(JSON.stringify(p.explanation))}`,
      "",
      ...p.cluster.members.map(
        (m) =>
          `- ${text(m.id)}: ${text(basisDescription(m.record.finding))} — ${text(m.record.finding.explanation)} ([source report](${href(s, `${m.record.runDirectory}/report.md`)}))`,
      ),
      "",
    ]),
    ...(s.tickets?.outcomes ?? []).map((o) =>
      o.kind === "created" || o.kind === "already-emitted"
        ? `- ${o.kind}: [ticket](${href(s, o.path)})`
        : `- ${text(JSON.stringify(o))}`,
    ),
    "",
    "## Flows and coverage",
    "",
    ...s.flows.flatMap((f) =>
      f.status === "failed"
        ? [`### ${text(f.flow)}`, `Failed/unreviewed: ${text(f.reason)}`, ""]
        : [
            `### ${text(f.flow)}`,
            "",
            `[Markdown report](${href(s, f.summary.reportPath)}) · [HTML report](${href(s, f.summary.htmlReportPath)})`,
            "",
            f.coverage.reportCoverage === undefined
              ? "Coverage unavailable."
              : renderCoverageMarkdown(f.coverage.reportCoverage),
            `Model: ${text(JSON.stringify({ outcome: f.summary.outcome, surfaces: f.summary.surfaces }))}`,
            "",
            "Probe coordinates, controls, reuse and limitations (reused controls are not additional clicks):",
            "",
            "```json",
            JSON.stringify(
              {
                summary: f.probeCoverage,
                policy: f.coverage.scope?.probe,
                observations: f.coverage.probes,
              },
              null,
              2,
            ),
            "```",
            "",
            "Deterministic and temporal registry coverage (skipped/unsupported prerequisites are not passes):",
            "",
            "```json",
            JSON.stringify(f.coverage.checkCoverage, null, 2),
            "```",
            "",
          ],
    ),
  ].join("\n");
}

export function polishHtml(s: ProductSweepSummary): string {
  const links = [
    ...s.flows.flatMap((f) =>
      f.status === "failed"
        ? []
        : [{ label: `${f.flow} report`, path: f.summary.htmlReportPath }],
    ),
    ...(s.tickets?.outcomes ?? []).flatMap((o) =>
      o.kind === "created" || o.kind === "already-emitted"
        ? [{ label: `${o.kind} ticket`, path: o.path }]
        : [],
    ),
  ];
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(reportContentSecurityPolicy())}"><title>Whole-product polish</title><style>body{font:16px system-ui;max-width:1000px;margin:2rem auto;padding:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}dt{font-weight:bold}</style><h1>Whole-product polish</h1><nav>${links.map((l) => `<p><a href="${escapeHtmlAttribute(href(s, l.path))}">${escapeHtml(l.label)}</a></p>`).join("")}</nav>${s.flows.map((f) => (f.status === "reviewed" && f.coverage.reportCoverage ? renderCoverageHtml(f.coverage.reportCoverage) : "")).join("")}<pre>${escapeHtml(polishMarkdown(s))}</pre></html>`;
}

export async function writePolishReports(
  s: ProductSweepSummary,
): Promise<void> {
  const artifacts: Array<[string, string]> = [
    [s.jsonPath, `${JSON.stringify(s, null, 2)}\n`],
    [s.reportPath, polishMarkdown(s)],
    [s.htmlReportPath, polishHtml(s)],
  ];
  for (const [path, body] of artifacts) {
    await writeFile(`${path}.tmp`, body, "utf8");
    await rename(`${path}.tmp`, path);
  }
}
