import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type SummaryFinding, summarizeFinding } from "../baseline/summary.js";
import { createArtifactWorkspace } from "../capture/artifacts.js";
import type { ProductionBuild } from "../capture/types.js";
import { IdiomError } from "../errors.js";
import type { ReviewOutcome } from "../review/report.js";
import { type ReviewDependencies, runReview } from "../review/run.js";
import type { Finding } from "../schemas/finding.js";
import { groupSweep } from "../sweep/group.js";
import { renderProductSweep } from "../sweep/report.js";
import { runProductSweep } from "../sweep/run.js";
import type { ProductSweepSummary, SweepFlowResult } from "../sweep/types.js";
import {
  type ClusterTicketsResult,
  emitClusterTickets,
  renderClusterTicketsResult,
} from "../tickets/emit.js";
import { indexTickets } from "../tickets/index.js";
import { resolveTicketTarget } from "../tickets/target.js";
import { validateProject } from "../validation.js";

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
export type SweepOptions = {
  flow?: string | undefined;
  all?: boolean | undefined;
  deterministicOnly?: boolean | undefined;
  maxTickets?: number | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  prod?: boolean | undefined;
  /** Serve the application on this port instead of a free one. */
  port?: number | undefined;
  from?: string | undefined;
  latest?: boolean | undefined;
  emitTickets?: string | undefined;
  dependencies?: ReviewDependencies | undefined;
};

export async function sweepCommand(
  options: SweepOptions & { all: true },
): Promise<ProductSweepSummary>;
export async function sweepCommand(
  options: SweepOptions & { flow: string; all?: false | undefined },
): Promise<SweepSummary>;
export async function sweepCommand(
  options: SweepOptions,
): Promise<SweepSummary | ProductSweepSummary>;
export async function sweepCommand(
  options: SweepOptions,
): Promise<SweepSummary | ProductSweepSummary> {
  if ((options.flow !== undefined) === (options.all === true))
    throw new IdiomError("select exactly one of sweep <flow> or sweep --all");
  if (
    !Number.isSafeInteger(options.maxTickets ?? 10) ||
    (options.maxTickets ?? 10) <= 0
  )
    throw new IdiomError("--max-tickets must be a positive safe integer");
  if (options.from !== undefined && options.latest === true)
    throw new IdiomError("--latest and --from are mutually exclusive");
  if (options.all && (options.from !== undefined || options.latest))
    throw new IdiomError(
      "--all requires fresh captures; --from and --latest are not supported",
    );
  if (options.all) return runProductSweep(options);
  if (options.emitTickets !== undefined) {
    const validated = await validateProject({
      project: options.project,
      cwd: options.cwd,
      flow: options.flow,
    });
    const target = await resolveTicketTarget({
      ...options,
      projectDirectory: validated.projectDirectory,
      out: options.emitTickets,
    });
    await indexTickets([target.root, target.canonicalRoot]);
  }
  if (options.flow === undefined) throw new IdiomError("sweep requires a flow");
  const rich = await sweepWithReview({ ...options, flow: options.flow });
  const summary = rich.summary;
  if (options.emitTickets !== undefined) {
    const proposals = await groupSweep([rich]);
    summary.tickets = await emitClusterTickets({
      project: options.project,
      cwd: options.cwd,
      out: options.emitTickets,
      maxTickets: options.maxTickets ?? 10,
      orderedClusters: proposals.map((p) => p.cluster),
      rootCauses: new Map(
        proposals.flatMap((p) =>
          p.cluster.members.flatMap((m) =>
            m.cause === undefined ? [] : [[m.id, m.cause] as const],
          ),
        ),
      ),
      occurrences: rich.occurrences,
      selection: { policy: "current-run", records: rich.records },
    });
  }
  return summary;
}

export async function sweepWithReview(
  options: SweepOptions & { flow: string },
): Promise<SweepFlowResult> {
  const {
    emitTickets: _emit,
    all: _all,
    maxTickets: _max,
    ...reviewOptions
  } = options;
  const capture = options.dependencies?.capture;
  const result = await runReview({
    ...reviewOptions,
    mode: "sweep",
    includeIssueRankingContext: true,
    dependencies: {
      ...options.dependencies,
      capture: {
        ...capture,
        createArtifactWorkspace:
          capture?.createArtifactWorkspace ??
          ((args) =>
            createArtifactWorkspace({
              ...args,
              out:
                args.out ??
                `${args.projectDirectory}/.idiom/reports/${(args.now ?? new Date()).toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID()}`,
            })),
      },
    },
  });
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
  const records = ranked.map((finding) => ({
    finding,
    runId: basename(result.runDirectory),
    runDirectory: result.runDirectory,
    findingsPath: result.findingsPath,
  }));
  return {
    flow: options.flow,
    summary,
    review: result,
    records,
    occurrences: (result.occurrences ?? ranked)
      .filter((f) => ranked.some((r) => r.id === f.id))
      .map((finding) => ({
        finding,
        runId: basename(result.runDirectory),
        runDirectory: result.runDirectory,
        findingsPath: result.findingsPath,
      })),
  };
}

export function renderSweepSummary(
  summary: SweepSummary | ProductSweepSummary,
): string {
  if ("scope" in summary) return renderProductSweep(summary);
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
