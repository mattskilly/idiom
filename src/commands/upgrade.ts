import {
  findOptionalProjectDirectory,
  resolveProjectArgument,
} from "../project.js";
import type { PreviousVersion, UpgradeReport } from "../skills/types.js";
import { type UpgradeDependencies, upgradeSkills } from "../skills/upgrade.js";
export async function upgradeCommand(
  options: {
    project?: string | undefined;
    cwd?: string | undefined;
    dryRun?: boolean | undefined;
    agent?: boolean | undefined;
  },
  dependencies: UpgradeDependencies = {},
): Promise<UpgradeReport> {
  const start = resolveProjectArgument(options.project, options.cwd);
  const projectDirectory =
    options.project === undefined
      ? ((await findOptionalProjectDirectory(start)) ?? start)
      : start;
  return upgradeSkills(
    { projectDirectory, dryRun: options.dryRun, agent: options.agent },
    dependencies,
  );
}
function renderVersion(value: UpgradeReport["previous"]): string {
  if (value.kind === "known") return value.version;
  if (value.kind === "candidates") return `one of ${value.versions.join(", ")}`;
  if (value.kind === "mixed")
    return `mixed (${value.versions.map((version: PreviousVersion) => renderVersion(version)).join("; ")})`;
  return "unknown";
}
export function renderUpgrade(report: UpgradeReport): string {
  const lines = [
    `Idiom skills ${report.dryRun ? "dry run " : ""}${renderVersion(report.previous)} → ${report.installedVersion}`,
  ];
  for (const file of report.files) {
    lines.push(
      `${file.action}: ${file.path}${file.reason ? ` — ${file.reason}` : ""}`,
    );
    if (file.action === "conflicted")
      lines.push(
        `  pristine: ${file.pristinePath}\n  incoming: ${file.incomingPath ?? "removed upstream"}`,
      );
  }
  for (const conflict of report.discoveryConflicts)
    lines.push(`protected: ${conflict.path} — ${conflict.reason}`);
  return lines.join("\n");
}
export const upgradeFailed = (report: UpgradeReport): boolean =>
  report.files.some((file) => file.action === "conflicted") ||
  report.discoveryConflicts.length > 0;
