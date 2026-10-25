import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { IdiomError } from "../errors.js";
import { findProjectDirectory, resolveProjectArgument } from "../project.js";

export type LaunchProcess = (command: string, args: string[]) => Promise<void>;

export type OpenReportDependencies = {
  platform?: NodeJS.Platform | undefined;
  launch?: LaunchProcess | undefined;
};

export type OpenReportResult = {
  projectDirectory: string;
  runId: string;
  reportPath: string;
};

function validateRunId(runId: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) ||
    runId === "." ||
    runId === ".."
  ) {
    throw new IdiomError(
      "report run ID must be a simple directory name beneath .idiom/reports",
    );
  }
}

async function regularReport(
  reportsDirectory: string,
  runId: string,
): Promise<{ runId: string; reportPath: string; mtimeMs: number } | undefined> {
  const runDirectory = join(reportsDirectory, runId);
  const reportPath = join(runDirectory, "report.html");
  try {
    const [run, report] = await Promise.all([
      lstat(runDirectory),
      lstat(reportPath),
    ]);
    if (!run.isDirectory() || !report.isFile()) return undefined;
    return { runId, reportPath, mtimeMs: report.mtimeMs };
  } catch {
    return undefined;
  }
}

export async function resolveHtmlReport(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  runId?: string | undefined;
}): Promise<OpenReportResult> {
  const projectDirectory = await findProjectDirectory(
    resolveProjectArgument(options.project, options.cwd),
  );
  const reportsDirectory = join(projectDirectory, ".idiom", "reports");
  if (options.runId !== undefined) {
    validateRunId(options.runId);
    const selected = await regularReport(reportsDirectory, options.runId);
    if (selected === undefined)
      throw new IdiomError(
        `HTML report does not exist for run ${options.runId}: ${join(reportsDirectory, options.runId, "report.html")}`,
      );
    return {
      projectDirectory,
      runId: selected.runId,
      reportPath: selected.reportPath,
    };
  }

  let entries: Dirent<string>[];
  try {
    entries = await readdir(reportsDirectory, { withFileTypes: true });
  } catch {
    throw new IdiomError(
      `no HTML reports found beneath ${reportsDirectory}; run idiom review or idiom verify first`,
    );
  }
  const candidates = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => regularReport(reportsDirectory, entry.name)),
    )
  ).filter((candidate) => candidate !== undefined);
  candidates.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || right.runId.localeCompare(left.runId),
  );
  const selected = candidates[0];
  if (selected === undefined)
    throw new IdiomError(
      `no HTML reports found beneath ${reportsDirectory}; run idiom review or idiom verify first`,
    );
  return {
    projectDirectory,
    runId: selected.runId,
    reportPath: selected.reportPath,
  };
}

export function reportLaunchCommand(
  platform: NodeJS.Platform,
  reportPath: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [reportPath] };
  if (platform === "win32")
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", reportPath],
    };
  return { command: "xdg-open", args: [reportPath] };
}

export const launchProcess: LaunchProcess = async (command, args) => {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      accept();
    });
  });
};

export async function launchHtmlFile(
  reportPath: string,
  dependencies?: OpenReportDependencies | undefined,
): Promise<void> {
  const launch = dependencies?.launch ?? launchProcess;
  const invocation = reportLaunchCommand(
    dependencies?.platform ?? process.platform,
    reportPath,
  );
  try {
    await launch(invocation.command, invocation.args);
  } catch (error) {
    throw new IdiomError(
      `could not open HTML report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function openHtmlReport(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  runId?: string | undefined;
  dependencies?: OpenReportDependencies | undefined;
}): Promise<OpenReportResult> {
  const selected = await resolveHtmlReport(options);
  await launchHtmlFile(selected.reportPath, options.dependencies);
  return selected;
}
