import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type SummaryFinding, summarizeFinding } from "../baseline/summary.js";
import type { ProductionBuild } from "../capture/types.js";
import type { ReviewOutcome } from "../review/report.js";
import { type ReviewDependencies, runReview } from "../review/run.js";
import type { Finding } from "../schemas/finding.js";
import {
  type ClusterTicketsResult,
  emitClusterTickets,
  renderClusterTicketsResult,
} from "../tickets/emit.js";

export type SweepSummaryFinding = SummaryFinding & {
  layer: Finding["layer"];
};

export type SweepSummary = {
  flow: string;
  build?: ProductionBuild | undefined;
  runDirectory: string;
  reportPath: string;
  htmlReportPath: string;
  sweepPath: string;
  outcome: ReviewOutcome;
  surfaces: Array<{
    state: string;
    status: "ok" | "failed";
    reason?: string | undefined;
    findings: number;
  }>;
  findings: SweepSummaryFinding[];
  blocking: number;
  tickets?: ClusterTicketsResult | undefined;
};

const severityRank = { blocker: 0, major: 1, minor: 2 } as const;
// Measured findings outrank model judgement at the same severity.
const layerRank = { deterministic: 0, model: 1 } as const;

export function rankSweepFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      layerRank[left.layer] - layerRank[right.layer] ||
      right.confidence - left.confidence ||
      left.state.localeCompare(right.state) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * The design sweep: capture, every deterministic check, then a model critique
 * per surface with zoomed crops, measured geometry and the design spec. Every
 * finding is reported, ranked, and can become clustered ticket proposals.
 */
export async function sweepCommand(options: {
  flow: string;
  project?: string | undefined;
  cwd?: string | undefined;
  prod?: boolean | undefined;
  /** Serve the application on this port instead of a free one. */
  port?: number | undefined;
  from?: string | undefined;
  latest?: boolean | undefined;
  emitTickets?: string | undefined;
  dependencies?: ReviewDependencies | undefined;
}): Promise<SweepSummary> {
  const { emitTickets, ...reviewOptions } = options;
  const result = await runReview({ ...reviewOptions, mode: "sweep" });
  const findings = JSON.parse(
    await readFile(result.findingsPath, "utf8"),
  ) as Finding[];
  const ranked = rankSweepFindings(
    findings.filter(
      (finding) => finding.status === "open" || finding.status === "approved",
    ),
  );
  const base = options.cwd ?? process.cwd();
  const surfaces = result.sweep?.surfaces ?? [];
  const summary: SweepSummary = {
    flow: options.flow,
    ...(result.build === undefined ? {} : { build: result.build }),
    runDirectory: result.runDirectory,
    reportPath: result.reportPath,
    htmlReportPath: result.htmlReportPath,
    sweepPath: result.sweep?.path ?? "",
    outcome: result.outcome,
    surfaces: surfaces.map((surface) => ({
      state: surface.state,
      status: surface.status,
      ...(surface.reason === undefined ? {} : { reason: surface.reason }),
      findings: ranked.filter((finding) => finding.state === surface.state)
        .length,
    })),
    findings: ranked.map((finding) => ({
      ...summarizeFinding(finding, result, base),
      layer: finding.layer,
    })),
    blocking: ranked.filter((finding) => finding.severity !== "minor").length,
  };
  if (emitTickets !== undefined)
    summary.tickets = await emitClusterTickets({
      project: options.project,
      cwd: options.cwd,
      out: emitTickets,
      selection: {
        policy: "current-run",
        records: ranked.map((finding) => ({
          finding,
          runId: basename(result.runDirectory),
          runDirectory: result.runDirectory,
          findingsPath: result.findingsPath,
        })),
      },
    });
  return summary;
}

export function renderSweepSummary(summary: SweepSummary): string {
  const measured = summary.findings.filter(
    (finding) => finding.layer === "deterministic",
  ).length;
  const lines = [
    ...(summary.build === undefined
      ? []
      : [`Production build: ${summary.build.id}`]),
    `idiom sweep ${summary.flow}: ${summary.findings.length} finding(s) across ${summary.surfaces.length} surface(s), ${summary.blocking} blocking — deterministic ${measured}, model ${summary.findings.length - measured}`,
    ...summary.surfaces.map((surface) =>
      surface.status === "ok"
        ? `  ${surface.state}: ${surface.findings} finding(s)`
        : `  ${surface.state}: critique failed — ${surface.reason ?? "unknown"} (${surface.findings} deterministic finding(s) kept)`,
    ),
    "",
  ];
  for (const [index, finding] of summary.findings.entries()) {
    lines.push(
      `${index + 1}. [${finding.severity}] [${finding.layer === "model" ? "model" : "measured"}] ${finding.category} — ${finding.where}${finding.selector === undefined ? "" : ` — ${finding.selector}`}`,
      `   Problem: ${finding.problem}`,
      ...finding.fix.map((line) => `   Done when: ${line}`),
      ...(finding.screenshot === undefined
        ? []
        : [`   Evidence: ${finding.screenshot}`]),
      `   Decide: idiom decide --finding ${finding.id} --accept|--reject --reason "…"`,
      "",
    );
  }
  if (summary.tickets !== undefined)
    lines.push(renderClusterTicketsResult(summary.tickets), "");
  lines.push(`Full report: ${summary.reportPath}`);
  return `${lines.join("\n")}\n`;
}
