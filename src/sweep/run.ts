import { mkdir, mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import { type SweepOptions, sweepWithReview } from "../commands/sweep.js";
import { readDecisionLog } from "../decisions/log.js";
import { IdiomError } from "../errors.js";
import { SweepCaptureError, safeDegradationReason } from "../review/run.js";
import { emitClusterTickets } from "../tickets/emit.js";
import { indexTickets } from "../tickets/index.js";
import { resolveTicketTarget } from "../tickets/target.js";
import { validateProject } from "../validation.js";
import { sweepProbeCoverage } from "./coverage.js";
import { groupSweep } from "./group.js";
import { writePolishReports } from "./report.js";
import type { ProductSweepSummary, SweepFlowResult } from "./types.js";

export async function runProductSweep(
  options: SweepOptions,
): Promise<ProductSweepSummary> {
  const signal = options.dependencies?.capture?.signal;
  signal?.throwIfAborted();
  const project = await validateProject({
    project: options.project,
    cwd: options.cwd,
  });
  if (options.prod && project.project.server.production === undefined)
    throw new IdiomError("--prod requires server.production configuration");
  const ids = new Set<string>();
  for (const { file, flow } of project.flows) {
    if (basename(file, ".json") !== flow.id || ids.has(flow.id))
      throw new IdiomError(
        `${file}: filename must match its unique manifest id ${JSON.stringify(flow.id)}`,
      );
    ids.add(flow.id);
  }
  // Fatal project/tracker/decision data errors must happen before capture.
  await readDecisionLog(project.projectDirectory);
  if (options.emitTickets !== undefined) {
    const target = await resolveTicketTarget({
      projectDirectory: project.projectDirectory,
      cwd: options.cwd,
      out: options.emitTickets,
    });
    await indexTickets([
      target.canonicalRoot,
      target.root,
      join(project.projectDirectory, ".autobuild/tickets"),
    ]);
  }
  const complete: SweepFlowResult[] = [];
  const flows: ProductSweepSummary["flows"] = [];
  for (const { flow } of project.flows) {
    signal?.throwIfAborted();
    const capture = options.dependencies?.capture;
    try {
      const result = await sweepWithReview({
        ...options,
        flow: flow.id,
        project: project.projectDirectory,
        dependencies: {
          ...options.dependencies,
          capture: {
            ...capture,
            onActivity: (activity) =>
              capture?.onActivity?.({
                ...activity,
                step: `${flow.id}: ${activity.step}`,
              }),
          },
        },
      });
      complete.push(result);
      const { scope, reportCoverage, checkCoverage, probes, timings } =
        result.review;
      flows.push({
        flow: flow.id,
        status: "reviewed",
        probeCoverage: sweepProbeCoverage(result.review),
        summary: result.summary,
        coverage: { scope, reportCoverage, checkCoverage, probes, timings },
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      // Configuration, decision, tracker and report-data errors stay actionable.
      if (!(error instanceof SweepCaptureError)) throw error;
      flows.push({
        flow: flow.id,
        status: "failed",
        reason: safeDegradationReason(error),
      });
    }
  }
  signal?.throwIfAborted();
  const ranked = await groupSweep(complete);
  const tickets =
    options.emitTickets === undefined
      ? undefined
      : await emitClusterTickets({
          project: project.projectDirectory,
          cwd: options.cwd,
          out: options.emitTickets,
          maxTickets: options.maxTickets ?? 10,
          orderedClusters: ranked.map((p) => p.cluster),
          rootCauses: new Map(
            ranked.flatMap((p) =>
              p.cluster.members.flatMap((m) =>
                m.cause === undefined ? [] : [[m.id, m.cause] as const],
              ),
            ),
          ),
          occurrences: complete.flatMap((f) => f.occurrences),
          selection: {
            policy: "current-run",
            records: complete.flatMap((f) => f.records),
          },
        });
  const selected = new Map(tickets?.selectedClusters?.map((c) => [c.key, c]));
  const proposals =
    tickets === undefined
      ? ranked.slice(0, options.maxTickets ?? 10)
      : ranked.flatMap((p) => {
          const cluster = selected.get(p.id);
          return cluster === undefined
            ? []
            : [{ ...p, cluster, findingIds: cluster.members.map((m) => m.id) }];
        });
  const findings = complete.flatMap((f) =>
    f.summary.findings.map((finding) => ({ ...finding, flow: f.flow })),
  );
  const severityCounts: Record<string, number> = Object.create(null);
  const ruleCounts: Record<string, number> = Object.create(null);
  for (const f of complete.flatMap((f) => f.records.map((r) => r.finding))) {
    severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1;
    const rule = f.rule ?? f.category;
    ruleCounts[rule] = (ruleCounts[rule] ?? 0) + 1;
  }
  const incomplete = flows.some(
    (f) =>
      f.status === "failed" ||
      f.summary.outcome.kind === "degraded" ||
      (f.coverage.reportCoverage?.successfulTuples ?? 0) <
        (f.coverage.reportCoverage?.selectedTuples ?? 0),
  );
  const parent = join(project.projectDirectory, ".idiom/reports");
  await mkdir(parent, { recursive: true });
  const runDirectory = await mkdtemp(join(parent, "polish-"));
  const summary: ProductSweepSummary = {
    scope: "all",
    outcome: incomplete
      ? {
          kind: "degraded",
          reason:
            "Whole-product sweep incomplete; inspect flow failures and coverage limitations.",
        }
      : { kind: options.deterministicOnly ? "deterministic-only" : "full" },
    flows,
    findings,
    sourceFindings: complete.flatMap((f) => f.records),
    occurrences: complete.flatMap((f) => f.occurrences),
    proposals,
    proposalCount: ranked.length,
    selectedCount: proposals.length,
    omittedCount: tickets?.omittedCount ?? ranked.length - proposals.length,
    occurrenceCount: complete.reduce((n, f) => n + f.occurrences.length, 0),
    severityCounts,
    ruleCounts,
    blocking: complete.reduce((n, f) => n + f.summary.blocking, 0),
    tickets,
    runDirectory,
    jsonPath: join(runDirectory, "polish.json"),
    reportPath: join(runDirectory, "polish.md"),
    htmlReportPath: join(runDirectory, "polish.html"),
  };
  await writePolishReports(summary);
  return summary;
}
