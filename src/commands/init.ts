import {
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import type { BriefInstructionOutcome } from "../brief/instruction.js";
import { sanitizeCritiqueDiagnostic } from "../critique/claude-code.js";
import {
  type GenerateFlow,
  type Generation,
  generateSiteFlow,
} from "../flows/generate.js";
import { resolveProjectArgument } from "../project.js";
import { skillIdentity } from "../skills/merge.js";
import { applyWrites, inspect } from "../skills/paths.js";
import { seedPristine } from "../skills/pristine.js";
import type { SkillName, UpgradeReport } from "../skills/types.js";
import { type UpgradeDependencies, upgradeSkills } from "../skills/upgrade.js";
import { discoverSources } from "../system/learn/discover.js";
import { applySystemDraft } from "../system/learn/draft.js";
import {
  prepareSystemLearning,
  printSystemProposal,
  type SystemLearningDependencies,
} from "../system/learn/run.js";
import {
  idiomSkillFileNames,
  readAutobuildTemplate,
  readIdiomSkillFile,
  readTemplate,
  templateNames,
} from "../templates.js";
import { validateProjectConfiguration } from "../validation.js";
import { IDIOM_VERSION } from "../version.js";
import { renderSkillSections } from "./upgrade.js";

export {
  type Confirmation,
  defaultConfirmation,
  type InitConfirmationRequest,
} from "../confirmation.js";

import { type Confirmation, defaultConfirmation } from "../confirmation.js";
import { DESIGN_QA_LINES } from "../wiring/instructions.js";
import { runWiring, wiringSummaryLines } from "../wiring/run.js";
import type {
  WiringDependencies,
  WiringOptions,
  WiringReport,
} from "../wiring/types.js";
export type AutobuildInitOutcome =
  import("../autobuild/setup.js").AutobuildSetupOutcome;

export type InitResult = {
  projectDirectory: string;
  created: string[];
  replaced: string[];
  unchanged: string[];
  skipped: string[];
  skillWarnings?: string[];
  /** Existing, differing managed skills, upgraded in place without a model. */
  skillUpgrade?: UpgradeReport;
  /** Projection of the autobuild-gate wiring row, kept for MCP and scripts. */
  autobuild: AutobuildInitOutcome;
  /** Projection of the Design QA rows for AGENTS.md and CLAUDE.md. */
  briefInstruction: BriefInstructionOutcome[];
  /** The single detected-then-confirmed wiring plan and its outcome. */
  wiring?: WiringReport;
  /** Wiring-only (--wire) or preview-only (--dry-run) runs skip scaffolding. */
  mode?: "wire" | "dry-run";
  systemLearning: {
    kind:
      | "not-detected"
      | "available-noninteractive"
      | "declined"
      | "applied"
      | "no-changes";
  };
  flows:
    | { kind: "not-requested" | "declined" }
    | (Generation & {
        kind: "generated" | "unchanged" | "preserved" | "no-routes";
      });
};

const directoryNames = [
  join(".idiom", "flows"),
  join(".idiom", "references"),
  join(".idiom", "anti-references"),
  join(".idiom", "reports"),
];

const canonicalSkillPath = join(".agents", "skills", "idiom");
const canonicalSkillFile = join(canonicalSkillPath, "SKILL.md");
const claudeSkillPath = join(".claude", "skills", "idiom");
const claudeSkillTarget = "../../.agents/skills/idiom";
async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function matchesTemplate(
  file: string,
  template: string,
): Promise<boolean> {
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return (await readFile(file, "utf8")) === template;
}

async function regularFile(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return readFile(path, "utf8");
}

/** Absent skills are created and exact ones recorded; an existing idiom skill
 * that differs is deferred to the upgrade engine, never written here. */
async function installSkills(
  projectDirectory: string,
  result: InitResult,
  deferred: SkillName[],
): Promise<void> {
  try {
    await inspect(projectDirectory, canonicalSkillFile);
  } catch {
    result.skipped.push(canonicalSkillFile);
    return;
  }
  const canonicalDirectory = join(projectDirectory, canonicalSkillPath);
  let canonicalOwned = false;

  if (!(await entryExists(canonicalDirectory))) {
    await mkdir(canonicalDirectory, { recursive: true });
    for (const name of idiomSkillFileNames) {
      const relativePath = join(canonicalSkillPath, name);
      await writeFile(
        join(projectDirectory, relativePath),
        await readIdiomSkillFile(name),
        "utf8",
      );
      result.created.push(relativePath);
    }
    canonicalOwned = true;
  } else {
    const directoryEntry = await lstat(canonicalDirectory);
    if (directoryEntry.isDirectory() && !directoryEntry.isSymbolicLink()) {
      const main = await regularFile(
        join(projectDirectory, canonicalSkillFile),
      );
      if (main !== undefined && skillIdentity(main) === "idiom") {
        let differs = main !== (await readIdiomSkillFile("SKILL.md"));
        for (const name of idiomSkillFileNames) {
          if (differs || name === "SKILL.md") continue;
          const file = join(projectDirectory, canonicalSkillPath, name);
          if (
            (await entryExists(file)) &&
            !(await matchesTemplate(file, await readIdiomSkillFile(name)))
          )
            differs = true;
        }
        if (differs) {
          deferred.push("idiom");
          return;
        }
        canonicalOwned = true;
      }
    }
    (canonicalOwned ? result.unchanged : result.skipped).push(
      canonicalSkillFile,
    );
    // Only a directory whose SKILL.md is ours may receive the other managed
    // files; a foreign skill directory is reported and left completely alone.
    if (canonicalOwned) {
      for (const name of idiomSkillFileNames) {
        if (name === "SKILL.md") continue;
        const relativePath = join(canonicalSkillPath, name);
        const file = join(projectDirectory, relativePath);
        const template = await readIdiomSkillFile(name);
        if (!(await entryExists(file))) {
          await writeFile(file, template, "utf8");
          result.created.push(relativePath);
        } else if (await matchesTemplate(file, template)) {
          result.unchanged.push(relativePath);
        } else {
          result.skipped.push(relativePath);
        }
      }
    }
  }

  if (!canonicalOwned) return;

  try {
    await inspect(projectDirectory, claudeSkillPath);
  } catch {
    result.skipped.push(claudeSkillPath);
    return;
  }
  const claudeEntry = join(projectDirectory, claudeSkillPath);
  if (!(await entryExists(claudeEntry))) {
    await mkdir(dirname(claudeEntry), { recursive: true });
    await symlink(claudeSkillTarget, claudeEntry, "dir");
    result.created.push(claudeSkillPath);
    return;
  }

  const entry = await lstat(claudeEntry);
  if (
    entry.isSymbolicLink() &&
    (await readlink(claudeEntry)) === claudeSkillTarget
  )
    result.unchanged.push(claudeSkillPath);
  else result.skipped.push(claudeSkillPath);
}

function recordOnce(collection: string[], path: string): void {
  if (!collection.includes(path)) collection.push(path);
}
async function entrySnapshot(path: string): Promise<string> {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink()) return `symlink:${await readlink(path)}`;
    if (value.isFile())
      return `file:${(await readFile(path)).toString("base64")}`;
    if (value.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}
async function atomicReplaceConfig(
  path: string,
  expected: string,
  content: string,
): Promise<void> {
  if ((await readFile(path, "utf8")) !== expected)
    throw new Error(`${path} changed after confirmation`);
  await applyWrites(dirname(path), [{ path: basename(path), content }]);
}

async function desiredFiles(
  projectDirectory: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of templateNames) {
    let content = await readTemplate(name);
    if (name === "project.json") {
      content = content.replace('"__IDIOM_APP_NAME__"', () =>
        JSON.stringify(basename(projectDirectory)),
      );
    }
    const destination =
      name === "PRODUCT.md" || name === "DESIGN.md"
        ? name
        : join(".idiom", name);
    files.set(destination, content);
  }
  files.set(join(".idiom", ".gitignore"), "reports/\n/agent-hooks/\n");
  return files;
}

export async function initProject(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  yes?: boolean | undefined;
  systemLearningDependencies?: SystemLearningDependencies | undefined;
  flows?: boolean | undefined;
  surface?: string | undefined;
  generateFlows?: GenerateFlow | undefined;
  /** Test seam for the in-place upgrade of existing, differing skills. */
  skillUpgrade?: UpgradeDependencies | undefined;
  confirm?: Confirmation | undefined;
  write?: ((message: string) => void) | undefined;
  /** Detection, skips and opt-ins for the single wiring plan. */
  wiring?: WiringOptions | undefined;
  /** "report-only" detects and previews but never applies (MCP). */
  wiringApplication?: "allow" | "report-only" | undefined;
  /** Test seams: selection, PATH/Git lookups and the safe-write hook. */
  wiringDependencies?: WiringDependencies | undefined;
}): Promise<InitResult> {
  const projectDirectory = resolveProjectArgument(options.project, options.cwd);
  const result: InitResult = {
    projectDirectory,
    created: [],
    replaced: [],
    unchanged: [],
    skipped: [],
    autobuild: { kind: "not-detected" },
    briefInstruction: [],
    systemLearning: { kind: "not-detected" },
    flows: { kind: "not-requested" },
  };
  const confirm = options.confirm ?? defaultConfirmation;
  const write =
    options.write ??
    ((message: string) => {
      stdout.write(message);
    });
  const wiringOptions = options.wiring ?? {};
  const wire = async () => {
    result.wiring = await runWiring(
      projectDirectory,
      {
        ...wiringOptions,
        yes: options.yes,
        application: options.wiringApplication,
      },
      {
        ...options.wiringDependencies,
        ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
        interactive:
          options.yes !== true &&
          (options.confirm !== undefined || stdin.isTTY === true),
      },
      write,
    );
    result.autobuild = await autobuildProjection(
      result.wiring,
      options.yes !== true,
    );
    if (
      result.autobuild.kind === "applied" &&
      !result.replaced.includes("autobuild.toml")
    )
      result.replaced.push("autobuild.toml");
    result.briefInstruction = briefProjection(result.wiring);
  };
  if (wiringOptions.dryRun) {
    // Nothing is created: not even the project directory or scaffold.
    result.mode = "dry-run";
    await wire();
    return result;
  }
  if (wiringOptions.wire) {
    const project = await inspect(projectDirectory, ".idiom/project.json");
    if (project.kind !== "file")
      throw new Error(
        "idiom init --wire needs an initialized project (.idiom/project.json). Run idiom init first.",
      );
    result.mode = "wire";
    await wire();
    return result;
  }
  await mkdir(projectDirectory, { recursive: true });
  for (const directory of directoryNames) {
    await mkdir(join(projectDirectory, directory), { recursive: true });
  }

  for (const [relativePath, content] of await desiredFiles(projectDirectory)) {
    const file = join(projectDirectory, relativePath);
    let existing: string | undefined;
    try {
      existing = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (existing === undefined) {
      await writeFile(file, content, "utf8");
      result.created.push(relativePath);
    } else if (existing === content) {
      result.unchanged.push(relativePath);
    } else if (options.yes === true) {
      result.skipped.push(relativePath);
    } else if (
      await confirm({
        kind: "replace-scaffold-file",
        path: relativePath,
        prompt: `${relativePath} already exists and differs. Replace it? [y/N] `,
      })
    ) {
      await writeFile(file, content, "utf8");
      result.replaced.push(relativePath);
    } else {
      result.skipped.push(relativePath);
    }
  }
  const deferred: SkillName[] = [];
  await installSkills(projectDirectory, result, deferred);
  try {
    const files: Record<string, string> = {};
    for (const name of idiomSkillFileNames)
      files[name] = await readIdiomSkillFile(name);
    if (
      !result.skipped.includes(canonicalSkillFile) &&
      !deferred.includes("idiom")
    )
      await seedPristine(projectDirectory, "idiom", files, IDIOM_VERSION);
  } catch (error) {
    result.skillWarnings ??= [];
    recordOnce(
      result.skillWarnings,
      `Pristine records for idiom could not be seeded: ${sanitizeCritiqueDiagnostic(error)}`,
    );
  }
  const sources = await discoverSources(projectDirectory);
  if (sources.length) {
    if (options.yes || (!options.confirm && !stdin.isTTY)) {
      result.systemLearning = { kind: "available-noninteractive" };
      write(
        "Design-token sources detected. Run idiom system --learn to preview and confirm rules.\n",
      );
    } else if (
      !(await confirm({
        kind: "offer-system-learning",
        path: ".idiom/project.json",
        prompt:
          "Design-token sources detected. Learn the design system from code? [y/N] ",
      }))
    )
      result.systemLearning = { kind: "declined" };
    else {
      const prepared = await prepareSystemLearning(
        projectDirectory,
        options.systemLearningDependencies,
      );
      printSystemProposal(prepared, write);
      if (!prepared.draft.diff) result.systemLearning = { kind: "no-changes" };
      else if (
        await confirm({
          kind: "apply-system-learning",
          path: ".idiom/project.json",
          prompt: "Apply this learning? [y/N] ",
          diff: prepared.draft.diff,
        })
      ) {
        await applySystemDraft(
          join(projectDirectory, ".idiom", "project.json"),
          prepared.draft,
        );
        result.systemLearning = { kind: "applied" };
        write(
          "Applied design-token learning. Recapture before checking new rules.\n",
        );
      } else result.systemLearning = { kind: "declined" };
    }
  }
  const requested =
    options.flows === true ||
    (options.yes !== true &&
      (options.confirm !== undefined || stdin.isTTY === true) &&
      (await confirm({
        kind: "offer-flow-generation",
        path: ".idiom/flows/site.json",
        prompt:
          "Generate a site flow by discovering routes in the configured running local app? [y/N] ",
      })));
  if (requested) {
    const { project } = await validateProjectConfiguration({
      project: projectDirectory,
    });
    const generated = await (options.generateFlows ?? generateSiteFlow)({
      directory: projectDirectory,
      project,
      surface: options.surface,
    });
    let kind: "generated" | "unchanged" | "preserved" | "no-routes" =
      "no-routes";
    if (generated.content !== undefined) {
      const relativePath = ".idiom/flows/site.json";
      for (const directory of [".idiom", ".idiom/flows"]) {
        const entry = await lstat(join(projectDirectory, directory));
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new Error(
            `${directory} must be a regular directory for flow generation`,
          );
      }
      const file = join(projectDirectory, relativePath);
      const snapshot = await entrySnapshot(file);
      if (snapshot === "absent") {
        await writeFile(file, generated.content, {
          encoding: "utf8",
          flag: "wx",
        });
        result.created.push(relativePath);
        kind = "generated";
      } else if (!snapshot.startsWith("file:")) {
        result.skipped.push(relativePath);
        kind = "preserved";
      } else {
        const existing = await readFile(file, "utf8");
        if (existing === generated.content) {
          result.unchanged.push(relativePath);
          kind = "unchanged";
        } else if (
          options.yes !== true &&
          (await confirm({
            kind: "replace-scaffold-file",
            path: relativePath,
            prompt: `${relativePath} already exists and differs. Replace it? [y/N] `,
          }))
        ) {
          if ((await entrySnapshot(file)) !== snapshot)
            throw new Error(
              `${relativePath} changed after confirmation; rerun init`,
            );
          await atomicReplaceConfig(file, existing, generated.content);
          result.replaced.push(relativePath);
          kind = "generated";
        } else {
          result.skipped.push(relativePath);
          kind = "preserved";
        }
      }
    }
    result.flows = { ...generated, kind };
  } else if (options.yes !== true) result.flows = { kind: "declined" };
  await wire();
  // After wiring, so a gate wired (or a verifier migrated) in this run has its
  // verifier skill upgraded by the same rules as idiom upgrade.
  if (
    result.autobuild.kind === "applied" ||
    result.autobuild.kind === "already-wired"
  ) {
    try {
      if (
        (
          await inspect(
            projectDirectory,
            ".agents/skills/idiom-verify/SKILL.md",
          )
        ).kind === "file"
      )
        deferred.push("idiom-verify");
    } catch {
      /* Setup already reports protected verifier paths; retain that diagnostic. */
    }
  }
  if (deferred.length)
    try {
      // Same decision as idiom upgrade, minus the model: overlaps are left
      // untouched and reported, never replaced.
      result.skillUpgrade = await upgradeSkills(
        { projectDirectory, agent: false, skills: deferred },
        options.skillUpgrade ?? {},
      );
    } catch (error) {
      result.skillWarnings ??= [];
      recordOnce(
        result.skillWarnings,
        `Existing skills could not be upgraded: ${sanitizeCritiqueDiagnostic(error)}`,
      );
    }
  return result;
}

/** The gate row in the older outcome shape that MCP and scripts read. */
async function autobuildProjection(
  report: WiringReport,
  offered: boolean,
): Promise<AutobuildInitOutcome> {
  const row = report.proposals.find(
    (entry) => entry.surface === "autobuild-gate",
  );
  if (row === undefined || row.disposition === "unavailable")
    return { kind: "not-detected" };
  const diff = row.preview === undefined ? {} : { diff: row.preview };
  if (row.disposition === "protected")
    return {
      kind: "manual",
      reason: row.reason,
      addition: await readAutobuildTemplate(),
    };
  if (row.disposition === "unchanged") return { kind: "already-wired" };
  // Deselected at a prompt is a decline; under --yes it stays an offer.
  if (row.disposition === "skipped")
    return {
      kind:
        offered && (report.mode === "applied" || report.mode === "declined")
          ? "declined"
          : "available-noninteractive",
    };
  if (report.mode === "applied") return { kind: "applied", ...diff };
  if (report.mode === "declined") return { kind: "declined", ...diff };
  return { kind: "available-noninteractive", ...diff };
}

/** The Design QA rows in the older brief-instruction outcome shape. */
function briefProjection(report: WiringReport): BriefInstructionOutcome[] {
  const lines = [...DESIGN_QA_LINES];
  const outcomes: BriefInstructionOutcome[] = [];
  for (const row of report.proposals) {
    if (row.surface !== "agents" && row.surface !== "claude") continue;
    if (row.disposition === "unavailable" || row.disposition === "skipped")
      continue;
    if (row.disposition === "protected")
      outcomes.push({ kind: "unsafe", path: row.path, reason: row.reason });
    else if (row.disposition === "unchanged")
      outcomes.push({ kind: "present", path: row.path });
    else if (report.mode === "applied")
      outcomes.push({ kind: "added", path: row.path });
    else if (report.mode === "declined")
      outcomes.push({ kind: "declined", path: row.path });
    else outcomes.push({ kind: "available", path: row.path, lines });
  }
  return outcomes;
}

/** The last line of every init summary: the readiness check that marks setup done. */
export const INIT_NEXT_LINE = "Next: idiom init --validate";

/** The human summary `idiom init` prints after scaffolding; MCP reuses it. */
export function initSummaryLines(result: InitResult): string[] {
  const lines: string[] = [];
  lines.push(
    `Initialized ${result.projectDirectory}: ${result.created.length} created, ${result.replaced.length} replaced, ${result.unchanged.length} unchanged, ${result.skipped.length} preserved`,
  );
  if ("stateCount" in result.flows) {
    const outcome = result.flows;
    lines.push(
      outcome.kind === "no-routes"
        ? "No discoverable routes; no site flow written."
        : `Site flow ${outcome.kind}: .idiom/flows/site.json (${outcome.routeCount} routes, ${outcome.stateCount} candidate states, ${outcome.setup.length} setup-required routes).`,
    );
    for (const note of [
      ...outcome.warnings,
      ...outcome.todos,
      ...outcome.setup,
    ])
      lines.push(note);
    if (outcome.content !== undefined && outcome.stateCount === 0)
      lines.push("TODO-only flow: no concrete states are ready to capture.");
  }
  for (const file of result.skipped) lines.push(`Preserved existing ${file}`);
  for (const warning of result.skillWarnings ?? []) lines.push(warning);
  if (result.skillUpgrade) {
    lines.push(
      "Existing skills upgraded in place (same rules as idiom upgrade):",
      ...renderSkillSections(result.skillUpgrade),
    );
    for (const conflict of result.skillUpgrade.discoveryConflicts)
      lines.push(`protected: ${conflict.path} — ${conflict.reason}`);
    if (result.skillUpgrade.files.some((file) => file.action === "conflicted"))
      lines.push(
        "Conflicted skill files were left untouched; run idiom upgrade to resolve them (see the conflict above).",
      );
  }
  if (result.autobuild.kind === "available-noninteractive")
    lines.push(
      "Autobuild verification is available; rerun `idiom init` interactively to review and approve wiring.",
    );
  else if (result.autobuild.kind === "declined")
    lines.push("Autobuild wiring declined; no Autobuild files changed.");
  else if (result.autobuild.kind === "applied")
    lines.push("Wired Idiom verification into Autobuild.");
  else if (result.autobuild.kind === "already-wired")
    lines.push("Autobuild verification is already wired; no changes needed.");
  else if (result.autobuild.kind === "manual") {
    lines.push(
      `Autobuild wiring made no changes: ${result.autobuild.reason} Ordinary Idiom initialization still completed.`,
    );
    lines.push("Make this addition by hand:");
    lines.push(result.autobuild.addition);
  }
  if (result.wiring) lines.push(...wiringSummaryLines(result.wiring));
  if (result.mode === undefined) lines.push(INIT_NEXT_LINE);
  else
    lines.push(
      result.mode === "dry-run"
        ? "Dry run: nothing was created or changed."
        : "Wiring only: scaffold, skills and app setup were not touched. Rerun idiom init --wire to update wiring.",
    );
  return lines;
}
