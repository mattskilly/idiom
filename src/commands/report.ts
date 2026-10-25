import {
  type OpenReportDependencies,
  type OpenReportResult,
  openHtmlReport,
} from "../report/open.js";

export async function reportCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  runId?: string | undefined;
  dependencies?: OpenReportDependencies | undefined;
}): Promise<OpenReportResult> {
  return openHtmlReport(options);
}
