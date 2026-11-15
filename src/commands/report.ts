import { type FlowTrend, loadTrends } from "../digest/trend.js";
import {
  type OpenReportDependencies,
  type OpenReportResult,
  openHtmlReport,
} from "../report/open.js";

export type ReportCommandResult = OpenReportResult & {
  /** Every flow's trend over its last five full runs, sorted by flow id. */
  trend: FlowTrend[];
};

export async function reportCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  runId?: string | undefined;
  dependencies?: OpenReportDependencies | undefined;
}): Promise<ReportCommandResult> {
  const opened = await openHtmlReport(options);
  const trend = await loadTrends({
    projectDirectory: opened.projectDirectory,
  }).catch((): FlowTrend[] => []);
  return { ...opened, trend };
}
