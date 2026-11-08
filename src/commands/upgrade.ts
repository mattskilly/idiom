import { type SetupOptions, setupAutobuild } from "../autobuild/setup.js";
import {
  findOptionalProjectDirectory,
  resolveProjectArgument,
} from "../project.js";
import { inspect } from "../skills/paths.js";
import { skillSummaryLine } from "../skills/rollup.js";
import type { PreviousVersion, UpgradeReport } from "../skills/types.js";
import { type UpgradeDependencies, upgradeSkills } from "../skills/upgrade.js";
export async function upgradeCommand(
  options: {
    project?: string | undefined;
    cwd?: string | undefined;
    dryRun?: boolean | undefined;
    agent?: boolean | undefined;
    interactive?: boolean | undefined;
    confirm?: SetupOptions["confirm"];
    write?: SetupOptions["write"];
  },
  dependencies: UpgradeDependencies = {},
): Promise<UpgradeReport> {
  const start = resolveProjectArgument(options.project, options.cwd);
  const projectDirectory =
    options.project === undefined
      ? ((await findOptionalProjectDirectory(start)) ?? start)
      : start;
  const autobuild = await setupAutobuild({ ...options, projectDirectory });
  // A declined/conflicting migration must not modify either verifier copy.
  // Other skills still upgrade independently.
  let legacyRemains = true;
  try {
    legacyRemains =
      (await inspect(projectDirectory, ".agents/skills/ab-verify-idiom"))
        .kind !== "absent";
  } catch {
    /* Protected ancestry also excludes the verifier. */
  }
  const report = await upgradeSkills(
    {
      projectDirectory,
      dryRun: options.dryRun,
      agent: options.agent,
      ...(legacyRemains ? { skills: ["idiom"] as ["idiom"] } : {}),
    },
    dependencies,
  );
  return { ...report, autobuild };
}
function renderVersion(value: UpgradeReport["previous"]): string {
  if (value.kind === "known") return value.version;
  if (value.kind === "candidates") return `one of ${value.versions.join(", ")}`;
  if (value.kind === "mixed")
    return `mixed (${value.versions.map((version: PreviousVersion) => renderVersion(version)).join("; ")})`;
  return "unknown";
}
const conflictPreviewLines = 80;
/** Per-skill sections: a rollup line, then each file's outcome beneath it. */
export function renderSkillSections(report: UpgradeReport): string[] {
  const lines: string[] = [];
  for (const summary of report.skills) {
    lines.push(skillSummaryLine(summary));
    for (const file of summary.files) {
      lines.push(
        `  ${file.action}: ${file.path}${file.reason ? ` — ${file.reason}` : ""}`,
      );
      if (file.action === "conflicted")
        lines.push(
          `    pristine: ${file.pristinePath}`,
          `    incoming: ${file.incomingPath ?? "removed upstream"}`,
        );
      if (file.conflictText === undefined) continue;
      const text = file.conflictText.replace(/\n$/, "").split("\n");
      lines.push(
        "    conflict (not written to disk; the live file is unchanged):",
      );
      for (const line of text.slice(0, conflictPreviewLines))
        lines.push(`      ${line}`);
      if (text.length > conflictPreviewLines)
        lines.push(
          `      … ${text.length - conflictPreviewLines} more lines not shown; compare ${file.path}, ${file.pristinePath} and ${file.incomingPath ?? "removed upstream"}`,
        );
    }
  }
  return lines;
}
export function renderUpgrade(report: UpgradeReport): string {
  const lines = [
    `Idiom skills ${report.dryRun ? "dry run " : ""}${renderVersion(report.previous)} → ${report.installedVersion}`,
    ...renderSkillSections(report),
  ];
  if (report.autobuild) {
    lines.push(`Autobuild: ${report.autobuild.kind}`);
    if ("diff" in report.autobuild && report.autobuild.kind !== "applied")
      lines.push(report.autobuild.diff ?? "", report.autobuild.migration ?? "");
    if (report.autobuild.kind === "manual")
      lines.push(report.autobuild.reason, report.autobuild.addition);
  }
  for (const conflict of report.discoveryConflicts)
    lines.push(`protected: ${conflict.path} — ${conflict.reason}`);
  return lines.join("\n");
}
export const upgradeFailed = (report: UpgradeReport): boolean =>
  report.files.some((file) => file.action === "conflicted") ||
  report.discoveryConflicts.length > 0;
