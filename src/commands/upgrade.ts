import {
  type FirstBaselineDependencies,
  type FirstBaselineOutcome,
  firstBaselineLines,
  recordFirstBaselines,
} from "../autobuild/first-baseline.js";
import {
  type SetupOptions,
  setupAutobuild,
  setupBaselineAdvance,
  setupFixStep,
} from "../autobuild/setup.js";
import {
  migrateProjectFiles,
  type ProjectFileOutcome,
} from "../migrations/run.js";
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
    /** Apply every offered Autobuild change without prompting. */
    yes?: boolean | undefined;
    /** Wiring surfaces to leave alone (init's --skip-wiring ids). */
    skipWiring?: string[] | undefined;
    /** Test seam for the gate's first baseline under --yes. */
    firstBaseline?: FirstBaselineDependencies | undefined;
  },
  dependencies: UpgradeDependencies = {},
): Promise<UpgradeReport> {
  const start = resolveProjectArgument(options.project, options.cwd);
  const projectDirectory =
    options.project === undefined
      ? ((await findOptionalProjectDirectory(start)) ?? start)
      : start;
  // Project files move first, so later steps of this run read current formats.
  const projectFiles = await migrateProjectFiles(
    {
      projectDirectory,
      dryRun: options.dryRun === true,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    },
    { formats: dependencies.projectFileFormats },
  );
  let firstBaseline: FirstBaselineOutcome | undefined;
  const autobuild = await setupAutobuild({
    ...options,
    projectDirectory,
    skip: options.skipWiring?.includes("autobuild-gate"),
    // Recorded before the wiring writes, while HEAD may still be clean.
    beforeApply: async () => {
      firstBaseline = await recordFirstBaselines(
        projectDirectory,
        options.firstBaseline,
      );
    },
  });
  // Offered only when the gate is (or would be) wired: the fix step swaps
  // the gate's skill and never wires a gate behind a declined or manual one.
  // It stays an explicit choice: --yes does not apply it.
  const fixStep =
    autobuild.kind === "applied" ||
    autobuild.kind === "already-wired" ||
    autobuild.kind === "available-noninteractive"
      ? await setupFixStep({
          ...options,
          projectDirectory,
          skip: options.skipWiring?.includes("autobuild-fix"),
        })
      : undefined;
  const baselineAdvance = await setupBaselineAdvance({
    ...options,
    projectDirectory,
    skip: options.skipWiring?.includes("autobuild-baseline"),
  });
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
  return {
    ...report,
    autobuild,
    ...(fixStep === undefined ? {} : { fixStep }),
    baselineAdvance,
    ...(firstBaseline === undefined ? {} : { firstBaseline }),
    projectFiles,
  };
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
/** The final line of a noninteractive run that left offered wiring unapplied. */
export const UPGRADE_HINT_LINE =
  "Apply the offered wiring without a prompt: idiom upgrade --yes";
export function upgradeHintLine(
  report: UpgradeReport,
  briefInstruction: readonly { kind: string }[],
  options: {
    dryRun?: boolean | undefined;
    yes?: boolean | undefined;
    json?: boolean | undefined;
  },
): string | undefined {
  if (options.dryRun || options.yes || options.json) return undefined;
  const offered =
    report.autobuild?.kind === "available-noninteractive" ||
    report.baselineAdvance?.kind === "available-noninteractive" ||
    briefInstruction.some((outcome) => outcome.kind === "available");
  return offered ? UPGRADE_HINT_LINE : undefined;
}
export function renderUpgrade(report: UpgradeReport): string {
  const lines = [
    `Idiom skills ${report.dryRun ? "dry run " : ""}${renderVersion(report.previous)} → ${report.installedVersion}`,
    ...renderSkillSections(report),
  ];
  if (report.autobuild) {
    lines.push(`Autobuild: ${report.autobuild.kind}`);
    if (
      "diff" in report.autobuild &&
      report.autobuild.kind !== "applied" &&
      report.autobuild.kind !== "skipped"
    )
      lines.push(report.autobuild.diff ?? "", report.autobuild.migration ?? "");
    if (report.autobuild.kind === "manual")
      lines.push(report.autobuild.reason, report.autobuild.addition);
  }
  lines.push(...firstBaselineLines(report.firstBaseline));
  const fix = report.fixStep;
  if (fix !== undefined && fix.kind !== "not-detected") {
    lines.push(`Autobuild fix step: ${fix.kind}`);
    if ("diff" in fix && fix.kind !== "applied" && fix.diff)
      lines.push(fix.diff);
    if (fix.kind === "manual") lines.push(fix.reason, fix.addition);
  }
  const advance = report.baselineAdvance;
  if (advance !== undefined && advance.kind !== "not-detected") {
    lines.push(`Autobuild baseline advance: ${advance.kind}`);
    if ("diff" in advance && advance.kind !== "applied" && advance.diff)
      lines.push(advance.diff);
    if (advance.kind === "manual") lines.push(advance.reason, advance.addition);
  }
  for (const conflict of report.discoveryConflicts)
    lines.push(`protected: ${conflict.path} — ${conflict.reason}`);
  lines.push(...renderProjectFiles(report));
  return lines.join("\n");
}
function projectFileLine(
  file: ProjectFileOutcome,
  report: UpgradeReport,
): string {
  if (file.outcome === "migrated")
    return report.dryRun
      ? `  would migrate: ${file.path} — format ${file.from} → ${file.to} (nothing written)`
      : `  migrated: ${file.path} — format ${file.from} → ${file.to}, original kept at ${file.backupPath}`;
  if (file.outcome === "refused")
    return `  refused: ${file.path} — format ${file.version}; Idiom ${report.installedVersion} understands format ${file.currentVersion}. Update Idiom, then run idiom upgrade again.`;
  return `  ${file.outcome}: ${file.path} — ${file.reason ?? ""}`;
}
/** The versioned `.idiom/` file section: counts, then every non-current file. */
export function renderProjectFiles(report: UpgradeReport): string[] {
  const projectFiles = report.projectFiles;
  if (projectFiles === undefined) return [];
  const dry = report.dryRun ? " dry run" : "";
  if (projectFiles.files.length === 0)
    return [`Project files${dry}: none versioned`];
  const count = (outcome: ProjectFileOutcome["outcome"]) =>
    projectFiles.files.filter((file) => file.outcome === outcome).length;
  const counts = (
    ["migrated", "current", "kept", "refused", "skipped", "failed"] as const
  )
    .filter((outcome) => outcome === "current" || count(outcome) > 0)
    .map((outcome) => `${count(outcome)} ${outcome}`);
  const lines = [`Project files${dry}: ${counts.join(", ")}`];
  for (const file of projectFiles.files)
    if (file.outcome !== "current") lines.push(projectFileLine(file, report));
  if (projectFiles.backupDirectory !== null)
    lines.push(
      `Originals kept in ${projectFiles.backupDirectory}/. Commit the migrated files, then delete it.`,
    );
  return lines;
}
export const projectFilesRefused = (report: UpgradeReport): boolean =>
  report.projectFiles?.files.some((file) => file.outcome === "refused") ===
  true;
export const projectFilesFailed = (report: UpgradeReport): boolean =>
  report.projectFiles?.files.some((file) => file.outcome === "failed") === true;
export const skillsConflicted = (report: UpgradeReport): boolean =>
  report.files.some((file) => file.action === "conflicted") ||
  report.discoveryConflicts.length > 0;
export const upgradeFailed = (report: UpgradeReport): boolean =>
  skillsConflicted(report) ||
  projectFilesRefused(report) ||
  projectFilesFailed(report);
