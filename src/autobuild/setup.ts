import { mkdir, rm, rmdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { stdin, stdout } from "node:process";
import { parse, type TomlTable } from "smol-toml";
import { buildImportGraph } from "../changed/imports.js";
import { type Confirmation, defaultConfirmation } from "../confirmation.js";
import { discoverRoutes } from "../coverage/routes.js";
import { skillIdentity } from "../skills/merge.js";
import { planVerifierMigration } from "../skills/migrate-verifier.js";
import {
  type ApplyDependencies,
  applyWrites,
  inspect,
  unchanged,
} from "../skills/paths.js";
import {
  digest,
  loadPristine,
  manifestBytes,
  manifestPath,
  pristinePath,
} from "../skills/pristine.js";
import {
  readAutobuildFixSkillTemplate,
  readAutobuildTemplate,
  readAutobuildVerifierSkillTemplate,
} from "../templates.js";
import { validateProject } from "../validation.js";
import { IDIOM_VERSION } from "../version.js";
import {
  baselineFinalizeAddition,
  createAutobuildDiff,
  fixStepAddition,
  isValidAutobuildPath,
  planAutobuildWiring,
  planBaselineFinalize,
  planFixStep,
  renameVerifierReferences,
} from "./wiring.js";

export type AutobuildSetupOutcome =
  | {
      kind:
        | "not-detected"
        | "available-noninteractive"
        | "declined"
        | "applied"
        | "already-wired"
        | "skipped";
      diff?: string;
      migration?: string;
    }
  | { kind: "manual"; reason: string; addition: string };
export type SetupOptions = {
  projectDirectory: string;
  interactive?: boolean | undefined;
  dryRun?: boolean | undefined;
  /** Apply without prompting; the same preview is written first. */
  yes?: boolean | undefined;
  /** Leave this surface alone (--skip-wiring): nothing is read or written. */
  skip?: boolean | undefined;
  /** Runs under --yes just before the writes, while the tree is still as it was. */
  beforeApply?: (() => Promise<void>) | undefined;
  confirm?: Confirmation | undefined;
  write?: ((message: string) => void) | undefined;
  apply?: ApplyDependencies | undefined;
};
export type PreparedAutobuild = {
  legacyMigration?: boolean;
  candidate: string;
  preview: string;
  /** File/link changes beyond the autobuild.toml text diff. */
  extra: string;
  snapshots: Map<string, string>;
  apply?: (
    writes: import("../skills/paths.js").Write[],
    dependencies?: ApplyDependencies,
  ) => Promise<void>;
};
/** The skill the gate step runs in a configuration, when it is one of ours. */
function gateSkill(source: string): StepSkill {
  try {
    const verify = parse(source).verify as Record<string, unknown> | undefined;
    const step = verify?.["idiom-check"] as Record<string, unknown> | undefined;
    if (step?.skill === "idiom-fix") return "idiom-fix";
  } catch {
    /* The plan has already validated the candidate. */
  }
  return "idiom-verify";
}

/** Read-only preparation shared by init's single consent boundary and upgrade. */
export async function prepareAutobuild(
  root: string,
  source?: string,
  installs?: SkillInstalls,
): Promise<PreparedAutobuild | undefined> {
  const snapshots = new Map<string, string>();
  const config = await inspect(root, "autobuild.toml", snapshots);
  if (config.kind === "absent") return undefined;
  if (config.kind !== "file")
    throw new Error("autobuild.toml is not a regular file");
  const migration = await planVerifierMigration(root);
  const original = source ?? config.content;
  const plan = planAutobuildWiring(
    migration ? renameVerifierReferences(original) : original,
    await readAutobuildTemplate(),
  );
  if (plan.kind === "manual") throw new Error(plan.reason);
  const install = migration
    ? undefined
    : await prepareSkillInstall(root, gateSkill(plan.candidate), installs);
  for (const [path, token] of install?.snapshots ?? [])
    snapshots.set(path, token);
  return {
    candidate: plan.candidate,
    preview:
      createAutobuildDiff(original, plan.candidate) +
      (migration?.preview ?? "") +
      (install?.extra ?? ""),
    extra: (migration?.preview ?? "") + (install?.extra ?? ""),
    snapshots,
    ...(migration
      ? { apply: migration.apply }
      : install
        ? { apply: install.apply }
        : {}),
  };
}
export async function setupAutobuild(
  options: SetupOptions,
): Promise<AutobuildSetupOutcome> {
  if (options.skip) return { kind: "skipped" };
  const addition = await readAutobuildTemplate();
  try {
    const prepared = await prepareAutobuild(options.projectDirectory);
    if (!prepared) return { kind: "not-detected" };
    if (!prepared.preview) return { kind: "already-wired" };
    const preview = { diff: prepared.preview };
    // One write path for the prompt and for --yes, so the two cannot drift.
    const apply = async (): Promise<AutobuildSetupOutcome> => {
      await unchanged(options.projectDirectory, prepared.snapshots);
      const writes = [{ path: "autobuild.toml", content: prepared.candidate }];
      if (prepared.apply) await prepared.apply(writes, options.apply);
      else await applyWrites(options.projectDirectory, writes, options.apply);
      return { kind: "applied", ...preview };
    };
    if (options.dryRun) return { kind: "available-noninteractive", ...preview };
    if (options.yes) {
      // Only the caller's writer: never stdout, so --json stays one document.
      options.write?.(prepared.preview);
      await options.beforeApply?.();
      return await apply();
    }
    if (
      !(options.interactive ?? (options.confirm !== undefined || stdin.isTTY))
    )
      return { kind: "available-noninteractive", ...preview };
    const confirm = options.confirm ?? defaultConfirmation;
    if (
      !(await confirm({
        kind: "offer-autobuild-wiring",
        path: "autobuild.toml",
        prompt:
          "Autobuild is detected. Wire the Idiom UI gate and migrate any legacy verifier? [y/N] ",
      }))
    )
      return { kind: "declined" };
    (options.write ?? ((message) => stdout.write(message)))(prepared.preview);
    if (
      !(await confirm({
        kind: "apply-autobuild-config",
        path: "autobuild.toml",
        diff: prepared.preview,
        prompt: "Apply the configuration and file changes shown above? [y/N] ",
      }))
    )
      return { kind: "declined" };
    return await apply();
  } catch (error) {
    return { kind: "manual", reason: (error as Error).message, addition };
  }
}

/**
 * Offer the finalize step that advances the gate's baseline as builds land:
 * one yes/no, then the exact diff and a second confirmation, as for the gate.
 */
export async function setupBaselineAdvance(
  options: SetupOptions,
): Promise<AutobuildSetupOutcome> {
  if (options.skip) return { kind: "skipped" };
  try {
    const snapshots = new Map<string, string>();
    const config = await inspect(
      options.projectDirectory,
      "autobuild.toml",
      snapshots,
    );
    if (config.kind === "absent") return { kind: "not-detected" };
    if (config.kind !== "file")
      throw new Error("autobuild.toml is not a regular file");
    const { candidate } = planBaselineFinalize(config.content);
    const diff = createAutobuildDiff(config.content, candidate);
    if (!diff) return { kind: "already-wired" };
    const apply = async (): Promise<AutobuildSetupOutcome> => {
      await unchanged(options.projectDirectory, snapshots);
      await applyWrites(
        options.projectDirectory,
        [{ path: "autobuild.toml", content: candidate }],
        options.apply,
      );
      return { kind: "applied", diff };
    };
    if (options.dryRun) return { kind: "available-noninteractive", diff };
    if (options.yes) {
      options.write?.(diff);
      return await apply();
    }
    if (
      !(options.interactive ?? (options.confirm !== undefined || stdin.isTTY))
    )
      return { kind: "available-noninteractive", diff };
    const confirm = options.confirm ?? defaultConfirmation;
    if (
      !(await confirm({
        kind: "offer-baseline-advance",
        path: "autobuild.toml",
        prompt:
          "Autobuild is detected. Advance Idiom's baseline as each build finalizes? [y/N] ",
      }))
    )
      return { kind: "declined" };
    (options.write ?? ((message) => stdout.write(message)))(diff);
    if (
      !(await confirm({
        kind: "apply-autobuild-config",
        path: "autobuild.toml",
        diff,
        prompt: "Apply the configuration change shown above? [y/N] ",
      }))
    )
      return { kind: "declined" };
    return await apply();
  } catch (error) {
    return {
      kind: "manual",
      reason: `Autobuild configuration could not be edited safely: ${(error as Error).message}`,
      addition: baselineFinalizeAddition,
    };
  }
}

/**
 * Prepare the fix step: swap the gate's skill to `idiom-fix` (wiring the gate
 * first when absent) and install the skill. Read-only; throws with a reason
 * when the configuration is custom or cannot be edited safely.
 */
export async function prepareFixStep(
  root: string,
  source?: string,
  installs = new SkillInstalls(root),
): Promise<PreparedAutobuild | undefined> {
  const snapshots = new Map<string, string>();
  const config = await inspect(root, "autobuild.toml", snapshots);
  if (config.kind === "absent") return undefined;
  if (config.kind !== "file")
    throw new Error("autobuild.toml is not a regular file");
  const original = source ?? config.content;
  const plan = planFixStep(original, await readAutobuildTemplate());
  if (plan.kind === "manual") throw new Error(plan.reason);
  const extra = await installs.add("idiom-fix");
  for (const [path, token] of installs.snapshots) snapshots.set(path, token);
  return {
    candidate: plan.candidate,
    preview: createAutobuildDiff(original, plan.candidate) + extra,
    extra,
    snapshots,
    apply: installs.apply,
  };
}

/**
 * Offer the fix step: one yes/no, then the exact diff and a second
 * confirmation, as for the baseline finalize step.
 */
export async function setupFixStep(
  options: SetupOptions,
): Promise<AutobuildSetupOutcome> {
  if (options.skip) return { kind: "skipped" };
  try {
    const prepared = await prepareFixStep(options.projectDirectory);
    if (!prepared) return { kind: "not-detected" };
    if (!prepared.preview) return { kind: "already-wired" };
    const diff = prepared.preview;
    // --yes never applies it (it changes what builds do) and never prompts.
    if (
      options.dryRun ||
      options.yes ||
      !(options.interactive ?? (options.confirm !== undefined || stdin.isTTY))
    )
      return { kind: "available-noninteractive", diff };
    const confirm = options.confirm ?? defaultConfirmation;
    if (
      !(await confirm({
        kind: "offer-fix-step",
        path: "autobuild.toml",
        prompt:
          "Autobuild is detected. Have Idiom fix new major UI findings inside each build at verify time (up to 3 findings × 3 rounds)? [y/N] ",
      }))
    )
      return { kind: "declined" };
    (options.write ?? ((message) => stdout.write(message)))(diff);
    if (
      !(await confirm({
        kind: "apply-autobuild-config",
        path: "autobuild.toml",
        diff,
        prompt: "Apply the configuration and file changes shown above? [y/N] ",
      }))
    )
      return { kind: "declined" };
    await unchanged(options.projectDirectory, prepared.snapshots);
    await prepared.apply?.(
      [{ path: "autobuild.toml", content: prepared.candidate }],
      options.apply,
    );
    return { kind: "applied", diff };
  } catch (error) {
    return {
      kind: "manual",
      reason: (error as Error).message,
      addition: fixStepAddition(await readAutobuildTemplate()),
    };
  }
}

/** Finding verification is separate from the gate and requires explicit project opt-in. */
export async function setupOptionalVerifier(
  options: SetupOptions,
): Promise<void> {
  try {
    const prepared = await prepareOptionalVerifier(options);
    if (prepared) {
      (options.write ?? ((message) => stdout.write(message)))(prepared.preview);
      if (
        !(await (options.confirm ?? defaultConfirmation)({
          kind: "apply-autobuild-config",
          path: "autobuild.toml",
          diff: prepared.preview,
          prompt: "Apply this optional finding verifier setup? [y/N] ",
        }))
      )
        return;
      await unchanged(options.projectDirectory, prepared.snapshots);
      await prepared.apply?.(
        [{ path: "autobuild.toml", content: prepared.candidate }],
        options.apply,
      );
    }
  } catch (error) {
    (options.write ?? ((message: string) => stdout.write(message)))(
      `Optional finding verifier could not be installed: ${(error as Error).message}. Resolve the destination and rerun idiom init.\n`,
    );
  }
}
export async function prepareOptionalVerifier(
  options: SetupOptions & {
    selected?: boolean;
    source?: string;
    installs?: SkillInstalls;
  },
): Promise<PreparedAutobuild | undefined> {
  if (
    options.dryRun ||
    !(options.interactive ?? (options.confirm !== undefined || stdin.isTTY))
  )
    return;
  const root = options.projectDirectory;
  const snapshots = new Map<string, string>();
  const config = await inspect(root, "autobuild.toml", snapshots);
  if (config.kind !== "file") return;
  let document: TomlTable;
  try {
    document = parse(options.source ?? config.content);
  } catch {
    return;
  }
  const commands = document.commands as Record<string, unknown> | undefined;
  if (commands?.["idiom-verify"] !== undefined) return; // Retain prior flow, paths and step selection.
  const write = options.write ?? ((message: string) => stdout.write(message));
  const confirm = options.confirm ?? defaultConfirmation;
  let validated: Awaited<ReturnType<typeof validateProject>>;
  try {
    validated = await validateProject({ project: root });
  } catch (error) {
    write(
      `Optional finding verifier unavailable: ${(error as Error).message}. Configure flows and rerun idiom init.\n`,
    );
    return;
  }
  const flows = validated.flows.map(({ flow }) => flow.id).sort();
  if (!flows.length) {
    write(
      "No flows detected. Configure a flow and rerun idiom init for optional finding verification.\n",
    );
    return;
  }
  if (
    !options.selected &&
    !(await confirm({
      kind: "offer-idiom-tickets",
      path: "autobuild.toml",
      prompt:
        "Does this project use Idiom-originated tickets? Install optional finding verification for one flow? [y/N] ",
    }))
  )
    return;
  let selected: string | undefined;
  for (const flow of flows) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flow)) continue;
    if (
      await confirm({
        kind: "select-verifier-flow",
        path: "autobuild.toml",
        prompt: `Verify Idiom tickets for flow ${flow}? [y/N] `,
      })
    ) {
      selected = flow;
      break;
    }
  }
  if (!selected) return;
  let paths = validated.project.agent?.uiGlobs ?? [];
  if (!paths.length) {
    const routes = await discoverRoutes(root);
    const graph = await buildImportGraph(
      routes.map(({ source }) => join(root, source)),
      [],
    );
    if (routes.length && !graph.uncertainties.length)
      paths = [
        ...routes.map(({ source }) => source),
        ...[...graph.consumers.keys()].map((path) => relative(root, path)),
      ];
  }
  paths = [
    ...new Set([
      ...paths,
      ".idiom/**",
      validated.project.design.productFile,
      validated.project.design.designFile,
    ]),
  ];
  if (paths.length <= 3 || !paths.every(isValidAutobuildPath)) {
    paths = ["**"];
    write(
      'Optional verifier uses paths = ["**"] because narrower applicability could not be established.\n',
    );
  }
  const template = `[commands]\nidiom-verify = "idiom verify ${selected} --spec .ab/spec.md --out .ab/idiom"\n[verify.idiom]\nkind = "agent"\nskill = "idiom-verify"\npaths = ${JSON.stringify(paths)}\n`;
  const plan = planAutobuildWiring(options.source ?? config.content, template);
  if (plan.kind === "manual") {
    write(`${plan.reason}\n${template}`);
    return;
  }
  const install = await prepareSkillInstall(
    root,
    "idiom-verify",
    options.installs,
  );
  for (const [path, token] of install.snapshots) snapshots.set(path, token);
  return {
    candidate: plan.candidate,
    preview: plan.diff + install.extra,
    extra: install.extra,
    snapshots,
    apply: install.apply,
  };
}

/** The Autobuild step skills wiring installs on demand. */
export type StepSkill = "idiom-verify" | "idiom-fix";

const stepSkillTemplate = (skill: StepSkill) =>
  skill === "idiom-fix"
    ? readAutobuildFixSkillTemplate()
    : readAutobuildVerifierSkillTemplate();

/**
 * One transaction that installs any number of step skills: the canonical
 * file, its `.claude/skills` link and its pristine seed, sharing one pristine
 * manifest write. Edited or custom destinations are never touched.
 */
export class SkillInstalls {
  readonly snapshots = new Map<string, string>();
  private readonly writes: import("../skills/paths.js").Write[] = [];
  private readonly links: Array<{ link: string; target: string }> = [];
  private readonly prepared = new Set<StepSkill>();
  private manifest: import("../skills/types.js").PristineManifest | undefined;
  private seeded = false;
  constructor(private readonly root: string) {}

  get empty(): boolean {
    return this.writes.length === 0 && this.links.length === 0;
  }

  /** Prepare one skill; returns the file/link lines it adds to a preview. */
  async add(skill: StepSkill): Promise<string> {
    if (this.prepared.has(skill)) return "";
    const root = this.root;
    const snapshots = this.snapshots;
    const directory = `.agents/skills/${skill}`;
    const main = `${directory}/SKILL.md`;
    const link = `.claude/skills/${skill}`;
    const target = `../../.agents/skills/${skill}`;
    const label = skill === "idiom-fix" ? "fix-step skill" : "verifier";
    const parent = await inspect(root, directory, snapshots);
    const local = await inspect(root, main, snapshots);
    if (parent.kind !== "absent" && parent.kind !== "directory")
      throw new Error(`Protected ${label} destination: ${directory}`);
    if (
      local.kind !== "absent" &&
      (local.kind !== "file" || skillIdentity(local.content) !== skill)
    )
      throw new Error(`Protected ${label} destination: ${main}`);
    if (local.kind === "absent" && parent.kind !== "absent")
      throw new Error(`Occupied ${label} directory: ${directory}`);
    const discovery = await inspect(root, link, snapshots);
    if (
      discovery.kind !== "absent" &&
      !(discovery.kind === "symlink" && discovery.target === target)
    )
      throw new Error(`Protected ${label} discovery: ${link}`);
    const content = await stepSkillTemplate(skill);
    let extra = "";
    if (local.kind === "absent") {
      this.writes.push({ path: main, content });
      extra += `Create ${main}\n`;
      this.manifest ??= await loadPristine(root, snapshots);
      const key = `${skill}/SKILL.md`;
      const baseline = await inspect(root, pristinePath(key), snapshots);
      if (this.manifest.files[key] || baseline.kind !== "absent")
        throw new Error(
          `${skill === "idiom-fix" ? "Fix-step" : "Verifier"} pristine destination is already occupied`,
        );
      this.manifest.files[key] = {
        version: IDIOM_VERSION,
        digest: digest(content),
      };
      this.writes.push({ path: pristinePath(key), content });
      this.seeded = true;
      extra += `Seed ${pristinePath(key)} and ${manifestPath}\n`;
    }
    if (discovery.kind === "absent") {
      this.links.push({ link, target });
      extra += `Create ${link} → ${target}\n`;
    }
    this.prepared.add(skill);
    return extra;
  }

  /** Create the links, then write the skill files with the config writes. */
  readonly apply = async (
    configWrites: import("../skills/paths.js").Write[],
    dependencies?: ApplyDependencies,
  ): Promise<void> => {
    const root = this.root;
    await unchanged(root, this.snapshots);
    const created: string[] = [];
    const linked: string[] = [];
    const writes = [...this.writes];
    if (this.seeded && this.manifest !== undefined)
      writes.push({
        path: manifestPath,
        content: manifestBytes(this.manifest),
      });
    try {
      for (const { link, target } of this.links) {
        for (const path of [".claude", ".claude/skills"])
          if ((await inspect(root, path)).kind === "absent") {
            await mkdir(join(root, path));
            created.push(path);
          }
        await symlink(target, join(root, link), "dir");
        linked.push(link);
      }
      await applyWrites(root, [...writes, ...configWrites], dependencies);
    } catch (error) {
      for (const link of linked.reverse()) await rm(join(root, link));
      for (const path of created.reverse()) await rmdir(join(root, path));
      throw error;
    }
  };
}

/** Prepare one step skill without touching edited/custom destinations. */
export async function prepareSkillInstall(
  root: string,
  skill: StepSkill,
  installs = new SkillInstalls(root),
) {
  const extra = await installs.add(skill);
  return { extra, snapshots: installs.snapshots, apply: installs.apply };
}
