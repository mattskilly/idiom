import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { planAutobuildWiring } from "../autobuild/wiring.js";
import {
  type GenerateFlow,
  type Generation,
  generateSiteFlow,
} from "../flows/generate.js";
import { resolveProjectArgument } from "../project.js";
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
  readAutobuildVerifierSkillTemplate,
  readIdiomSkillFile,
  readTemplate,
  templateNames,
} from "../templates.js";
import { validateProjectConfiguration } from "../validation.js";

export type InitConfirmationRequest =
  | { kind: "offer-system-learning"; prompt: string; path: string }
  | {
      kind: "apply-system-learning";
      prompt: string;
      path: string;
      diff: string;
    }
  | { kind: "offer-flow-generation"; prompt: string; path: string }
  | {
      kind: "replace-scaffold-file";
      prompt: string;
      path: string;
    }
  | {
      kind: "offer-autobuild-wiring";
      prompt: string;
      path: string;
    }
  | {
      kind: "apply-autobuild-config";
      prompt: string;
      path: string;
      diff: string;
    }
  | {
      kind: "replace-autobuild-skill";
      prompt: string;
      path: string;
    };

export type Confirmation = (
  request: InitConfirmationRequest,
) => Promise<boolean>;

export type AutobuildInitOutcome =
  | { kind: "not-detected" }
  | { kind: "available-noninteractive" }
  | { kind: "declined" }
  | { kind: "applied" }
  | { kind: "already-wired" }
  | { kind: "manual"; reason: string; addition: string };

export type InitResult = {
  projectDirectory: string;
  created: string[];
  replaced: string[];
  unchanged: string[];
  skipped: string[];
  autobuild: AutobuildInitOutcome;
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
const autobuildFile = "autobuild.toml";
const autobuildSkillPath = join(".agents", "skills", "ab-verify-idiom");
const autobuildSkillFile = join(autobuildSkillPath, "SKILL.md");
const autobuildClaudeSkillPath = join(".claude", "skills", "ab-verify-idiom");
const autobuildClaudeSkillTarget = "../../.agents/skills/ab-verify-idiom";

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

async function installSkills(
  projectDirectory: string,
  result: InitResult,
): Promise<void> {
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
      canonicalOwned = await matchesTemplate(
        join(projectDirectory, canonicalSkillFile),
        await readIdiomSkillFile("SKILL.md"),
      );
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

async function defaultConfirmation(
  request: InitConfirmationRequest,
): Promise<boolean> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(request.prompt);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

type ManagedEntryState =
  | { kind: "absent" }
  | { kind: "exact" }
  | { kind: "replaceable" }
  | { kind: "unsafe"; reason: string };

type WiringPreparation = {
  configPath: string;
  configPlan: ReturnType<typeof planAutobuildWiring>;
  skillState: ManagedEntryState;
  claudeState: ManagedEntryState;
  snapshots: Map<string, string>;
  skillTemplate: string;
};

async function entrySnapshot(path: string): Promise<string> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) return `symlink:${await readlink(path)}`;
    if (entry.isFile())
      return `file:${(await readFile(path)).toString("base64")}`;
    if (entry.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

async function verifierSkillState(
  projectDirectory: string,
  template: string,
): Promise<ManagedEntryState> {
  const directory = join(projectDirectory, autobuildSkillPath);
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      return {
        kind: "unsafe",
        reason: `${autobuildSkillPath} is occupied by a foreign entry.`,
      };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    throw error;
  }

  const file = join(projectDirectory, autobuildSkillFile);
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink())
      return {
        kind: "unsafe",
        reason: `${autobuildSkillFile} is occupied by a foreign entry.`,
      };
    return (await readFile(file, "utf8")) === template
      ? { kind: "exact" }
      : { kind: "replaceable" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        kind: "unsafe",
        reason: `${autobuildSkillPath} is an unowned existing directory.`,
      };
    throw error;
  }
}

async function verifierClaudeState(
  projectDirectory: string,
): Promise<ManagedEntryState> {
  const path = join(projectDirectory, autobuildClaudeSkillPath);
  try {
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() &&
      (await readlink(path)) === autobuildClaudeSkillTarget
    )
      return { kind: "exact" };
    return {
      kind: "unsafe",
      reason: `${autobuildClaudeSkillPath} is occupied by a foreign entry.`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    throw error;
  }
}

async function prepareWiring(
  projectDirectory: string,
): Promise<WiringPreparation | undefined> {
  const configPath = join(projectDirectory, autobuildFile);
  const manualAddition = await readAutobuildTemplate();
  let configSource: string;
  try {
    const entry = await lstat(configPath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return {
        configPath,
        configPlan: {
          kind: "manual",
          original: "",
          candidate: "",
          diff: "",
          complete: false,
          manualAddition,
          reason: `${autobuildFile} is not a regular file.`,
        },
        skillState: { kind: "absent" },
        claudeState: { kind: "absent" },
        snapshots: new Map([[configPath, await entrySnapshot(configPath)]]),
        skillTemplate: await readAutobuildVerifierSkillTemplate(),
      };
    }
    configSource = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const skillTemplate = await readAutobuildVerifierSkillTemplate();
  const skillState = await verifierSkillState(projectDirectory, skillTemplate);
  const claudeState = await verifierClaudeState(projectDirectory);
  const paths = [
    configPath,
    join(projectDirectory, autobuildSkillPath),
    join(projectDirectory, autobuildSkillFile),
    join(projectDirectory, autobuildClaudeSkillPath),
  ];
  const snapshots = new Map<string, string>();
  for (const path of paths) snapshots.set(path, await entrySnapshot(path));
  return {
    configPath,
    configPlan: planAutobuildWiring(configSource, manualAddition),
    skillState,
    claudeState,
    snapshots,
    skillTemplate,
  };
}

function wiringUnsafe(preparation: WiringPreparation): string | undefined {
  if (preparation.configPlan.kind === "manual")
    return preparation.configPlan.reason;
  if (preparation.skillState.kind === "unsafe")
    return preparation.skillState.reason;
  if (preparation.claudeState.kind === "unsafe")
    return preparation.claudeState.reason;
  return undefined;
}

function wiringComplete(preparation: WiringPreparation): boolean {
  return (
    preparation.configPlan.kind === "ready" &&
    preparation.configPlan.complete &&
    preparation.skillState.kind === "exact" &&
    preparation.claudeState.kind === "exact"
  );
}

async function snapshotsUnchanged(
  snapshots: Map<string, string>,
): Promise<boolean> {
  for (const [path, snapshot] of snapshots)
    if ((await entrySnapshot(path)) !== snapshot) return false;
  return true;
}

function recordOnce(collection: string[], path: string): void {
  if (!collection.includes(path)) collection.push(path);
}

async function atomicReplaceConfig(
  path: string,
  expected: string,
  content: string,
): Promise<void> {
  if ((await readFile(path, "utf8")) !== expected)
    throw new Error(`${path} changed after confirmation; rerun init`);
  const entry = await lstat(path);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.idiom-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await chmod(temporary, entry.mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function applyWiring(
  projectDirectory: string,
  preparation: WiringPreparation,
  result: InitResult,
): Promise<void> {
  if (preparation.skillState.kind === "absent") {
    await mkdir(join(projectDirectory, autobuildSkillPath), {
      recursive: true,
    });
    await writeFile(
      join(projectDirectory, autobuildSkillFile),
      preparation.skillTemplate,
      "utf8",
    );
    recordOnce(result.created, autobuildSkillFile);
  } else if (preparation.skillState.kind === "replaceable") {
    await writeFile(
      join(projectDirectory, autobuildSkillFile),
      preparation.skillTemplate,
      "utf8",
    );
    recordOnce(result.replaced, autobuildSkillFile);
  } else recordOnce(result.unchanged, autobuildSkillFile);

  if (preparation.claudeState.kind === "absent") {
    const path = join(projectDirectory, autobuildClaudeSkillPath);
    await mkdir(dirname(path), { recursive: true });
    await symlink(autobuildClaudeSkillTarget, path, "dir");
    recordOnce(result.created, autobuildClaudeSkillPath);
  } else recordOnce(result.unchanged, autobuildClaudeSkillPath);

  if (
    preparation.configPlan.kind === "ready" &&
    preparation.configPlan.candidate !== preparation.configPlan.original
  ) {
    await atomicReplaceConfig(
      preparation.configPath,
      preparation.configPlan.original,
      preparation.configPlan.candidate,
    );
    recordOnce(result.replaced, autobuildFile);
  } else recordOnce(result.unchanged, autobuildFile);
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
  files.set(join(".idiom", ".gitignore"), "reports/\n");
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
  confirm?: Confirmation | undefined;
  write?: ((message: string) => void) | undefined;
}): Promise<InitResult> {
  const projectDirectory = resolveProjectArgument(options.project, options.cwd);
  const result: InitResult = {
    projectDirectory,
    created: [],
    replaced: [],
    unchanged: [],
    skipped: [],
    autobuild: { kind: "not-detected" },
    systemLearning: { kind: "not-detected" },
    flows: { kind: "not-requested" },
  };
  await mkdir(projectDirectory, { recursive: true });
  const confirm = options.confirm ?? defaultConfirmation;
  const write =
    options.write ??
    ((message: string) => {
      stdout.write(message);
    });
  const wiring = await prepareWiring(projectDirectory);
  let wiringApproved = false;
  if (wiring !== undefined) {
    if (wiringComplete(wiring)) {
      result.autobuild = { kind: "already-wired" };
      recordOnce(result.unchanged, autobuildFile);
      recordOnce(result.unchanged, autobuildSkillFile);
      recordOnce(result.unchanged, autobuildClaudeSkillPath);
    } else if (options.yes === true)
      result.autobuild = { kind: "available-noninteractive" };
    else if (
      !(await confirm({
        kind: "offer-autobuild-wiring",
        path: autobuildFile,
        prompt:
          "Autobuild is detected. Wire Idiom verification into this repository? [y/N] ",
      }))
    )
      result.autobuild = { kind: "declined" };
    else {
      const unsafe = wiringUnsafe(wiring);
      if (unsafe !== undefined) {
        if (wiring.configPlan.kind === "manual")
          recordOnce(result.skipped, autobuildFile);
        if (wiring.skillState.kind === "unsafe")
          recordOnce(result.skipped, autobuildSkillFile);
        if (wiring.claudeState.kind === "unsafe")
          recordOnce(result.skipped, autobuildClaudeSkillPath);
        result.autobuild = {
          kind: "manual",
          reason: unsafe,
          addition: wiring.configPlan.manualAddition,
        };
      } else {
        let decisionsApproved = true;
        if (
          wiring.configPlan.kind === "ready" &&
          wiring.configPlan.candidate !== wiring.configPlan.original
        ) {
          write(wiring.configPlan.diff);
          decisionsApproved = await confirm({
            kind: "apply-autobuild-config",
            path: autobuildFile,
            prompt:
              "Apply the Autobuild configuration change shown above? [y/N] ",
            diff: wiring.configPlan.diff,
          });
        }
        if (decisionsApproved && wiring.skillState.kind === "replaceable")
          decisionsApproved = await confirm({
            kind: "replace-autobuild-skill",
            path: autobuildSkillFile,
            prompt: `${autobuildSkillFile} already exists and differs. Replace it? [y/N] `,
          });
        if (decisionsApproved) wiringApproved = true;
        else result.autobuild = { kind: "declined" };
      }
    }
  }
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
  await installSkills(projectDirectory, result);
  if (wiringApproved && wiring !== undefined) {
    if (!(await snapshotsUnchanged(wiring.snapshots))) {
      result.autobuild = {
        kind: "manual",
        reason:
          "An Autobuild wiring destination changed after it was previewed; rerun init before applying it.",
        addition: wiring.configPlan.manualAddition,
      };
    } else {
      await applyWiring(projectDirectory, wiring, result);
      result.autobuild = { kind: "applied" };
    }
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
  return result;
}
