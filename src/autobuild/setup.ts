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
  readAutobuildTemplate,
  readAutobuildVerifierSkillTemplate,
} from "../templates.js";
import { validateProject } from "../validation.js";
import { IDIOM_VERSION } from "../version.js";
import {
  createAutobuildDiff,
  isValidAutobuildPath,
  planAutobuildWiring,
  renameVerifierReferences,
} from "./wiring.js";

export type AutobuildSetupOutcome =
  | {
      kind:
        | "not-detected"
        | "available-noninteractive"
        | "declined"
        | "applied"
        | "already-wired";
      diff?: string;
      migration?: string;
    }
  | { kind: "manual"; reason: string; addition: string };
export type SetupOptions = {
  projectDirectory: string;
  interactive?: boolean | undefined;
  dryRun?: boolean | undefined;
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
/** Read-only preparation shared by init's single consent boundary and upgrade. */
export async function prepareAutobuild(
  root: string,
  source?: string,
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
  const install = migration ? undefined : await prepareVerifierInstall(root);
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
  const addition = await readAutobuildTemplate();
  try {
    const prepared = await prepareAutobuild(options.projectDirectory);
    if (!prepared) return { kind: "not-detected" };
    if (!prepared.preview) return { kind: "already-wired" };
    const preview = { diff: prepared.preview };
    if (
      options.dryRun ||
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
    await unchanged(options.projectDirectory, prepared.snapshots);
    const writes = [{ path: "autobuild.toml", content: prepared.candidate }];
    if (prepared.apply) await prepared.apply(writes, options.apply);
    else await applyWrites(options.projectDirectory, writes, options.apply);
    return { kind: "applied", ...preview };
  } catch (error) {
    return { kind: "manual", reason: (error as Error).message, addition };
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
  options: SetupOptions & { selected?: boolean; source?: string },
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
  const install = await prepareVerifierInstall(root);
  for (const [path, token] of install.snapshots) snapshots.set(path, token);
  return {
    candidate: plan.candidate,
    preview: plan.diff + install.extra,
    extra: install.extra,
    snapshots,
    apply: install.apply,
  };
}

/** Prepare the one shared skill without touching edited/custom destinations. */
async function prepareVerifierInstall(root: string) {
  const snapshots = new Map<string, string>();
  const main = ".agents/skills/idiom-verify/SKILL.md";
  const directory = ".agents/skills/idiom-verify";
  const link = ".claude/skills/idiom-verify";
  const target = "../../.agents/skills/idiom-verify";
  const parent = await inspect(root, directory, snapshots);
  const local = await inspect(root, main, snapshots);
  if (parent.kind !== "absent" && parent.kind !== "directory")
    throw new Error(`Protected verifier destination: ${directory}`);
  if (
    local.kind !== "absent" &&
    (local.kind !== "file" || skillIdentity(local.content) !== "idiom-verify")
  )
    throw new Error(`Protected verifier destination: ${main}`);
  if (local.kind === "absent" && parent.kind !== "absent")
    throw new Error(`Occupied verifier directory: ${directory}`);
  const discovery = await inspect(root, link, snapshots);
  if (
    discovery.kind !== "absent" &&
    !(discovery.kind === "symlink" && discovery.target === target)
  )
    throw new Error(`Protected verifier discovery: ${link}`);
  const content = await readAutobuildVerifierSkillTemplate();
  const writes: import("../skills/paths.js").Write[] = [];
  let extra = "";
  if (local.kind === "absent") {
    writes.push({ path: main, content });
    extra += `Create ${main}\n`;
    const manifest = await loadPristine(root, snapshots);
    const key = "idiom-verify/SKILL.md";
    const baseline = await inspect(root, pristinePath(key), snapshots);
    if (manifest.files[key] || baseline.kind !== "absent")
      throw new Error("Verifier pristine destination is already occupied");
    manifest.files[key] = { version: IDIOM_VERSION, digest: digest(content) };
    writes.push(
      { path: pristinePath(key), content },
      { path: manifestPath, content: manifestBytes(manifest) },
    );
    extra += `Seed ${pristinePath(key)} and ${manifestPath}\n`;
  }
  if (discovery.kind === "absent") extra += `Create ${link} → ${target}\n`;
  return {
    extra,
    snapshots,
    async apply(
      configWrites: import("../skills/paths.js").Write[],
      dependencies?: ApplyDependencies,
    ) {
      await unchanged(root, snapshots);
      const created: string[] = [];
      let linked = false;
      try {
        if (discovery.kind === "absent") {
          for (const path of [".claude", ".claude/skills"])
            if ((await inspect(root, path)).kind === "absent") {
              await mkdir(join(root, path));
              created.push(path);
            }
          await symlink(target, join(root, link), "dir");
          linked = true;
        }
        await applyWrites(root, [...writes, ...configWrites], dependencies);
      } catch (error) {
        if (linked) await rm(join(root, link));
        for (const path of created.reverse()) await rmdir(join(root, path));
        throw error;
      }
    },
  };
}
