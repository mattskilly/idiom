import { resolve } from "node:path";
import { parse } from "smol-toml";
import {
  prepareAutobuild,
  prepareFixStep,
  prepareOptionalVerifier,
  SkillInstalls,
} from "../autobuild/setup.js";
import {
  baselineCommand,
  createAutobuildDiff,
  planBaselineFinalize,
} from "../autobuild/wiring.js";
import { scheduleFor } from "../nightly/schedule.js";
import { inspect, type Write } from "../skills/paths.js";
import { AUTOBUILD_SKILLS, autobuildSkillWriter } from "./autobuild-skills.js";
import { detectWiring } from "./detect.js";
import { githubWriter } from "./github.js";
import { HOOK_COMMAND, huskyWriter, lefthookWriter } from "./hooks.js";
import { cursorWriter, instructionWriter } from "./instructions.js";
import { LANDING_REASON, landingWriter } from "./landing.js";
import { markers } from "./sections.js";
import {
  type Proposal,
  WIRING_SURFACES,
  type WiringDependencies,
  type WiringDetection,
  type WiringOptions,
  type WiringPlan,
  type WiringSelection,
  type WiringSurface,
  type Writer,
} from "./types.js";

export const FIX_STEP_REASON =
  "Fix new major UI findings inside the build at verify time (idiom-fix skill; up to 3 findings × 3 rounds; unfixed ones fail with a short summary).";

export function validateWiringOptions(options: WiringOptions): void {
  for (const id of options.skipWiring ?? [])
    if (!(WIRING_SURFACES as readonly string[]).includes(id))
      throw new Error(
        `Unknown wiring surface ${JSON.stringify(id)}. Choose: ${WIRING_SURFACES.join(", ")}`,
      );
  if (options.nightly && options.skipWiring?.includes("github"))
    throw new Error("--nightly conflicts with --skip-wiring github");
  if (options.advanceBaseline && options.skipWiring?.includes("github"))
    throw new Error("--advance-baseline conflicts with --skip-wiring github");
  if (options.designReview && options.skipWiring?.includes("autobuild-landing"))
    throw new Error(
      "--design-review conflicts with --skip-wiring autobuild-landing",
    );
}

const found = (detection: WiringDetection, path: string) =>
  detection.signals[path]?.detected === true;

function managed(
  detection: WiringDetection,
  path: string,
  name: string,
  format: "html" | "hash" = "hash",
): boolean {
  const entry = detection.signals[path]?.entry;
  return (
    entry?.kind === "file" && entry.content.includes(markers(name, format)[0])
  );
}

/**
 * Safe instruction targets and a detected workflow start selected. Hooks,
 * nightly and the landing rule need an explicit opt-in, or an earlier managed
 * install to keep updating. The UI gate is offered at a prompt and applied by
 * `idiom init --wire --yes`; a plain scaffold `--yes` never selects it.
 * Installed phase skills follow the same rule, or refresh when already managed.
 */
export function defaultSelection(
  detection: WiringDetection,
  options: WiringOptions,
): WiringSelection {
  validateWiringOptions(options);
  const selected: WiringSurface[] = ["agents"];
  if (found(detection, "CLAUDE.md")) selected.push("claude");
  if (found(detection, ".cursor")) selected.push("cursor");
  if (found(detection, ".github/workflows")) selected.push("github");
  const hooks = (["husky", "lefthook"] as const).filter(
    (id) =>
      found(detection, id === "husky" ? ".husky" : "lefthook.yml") &&
      !options.skipWiring?.includes(id),
  );
  if (options.gitHook && hooks.length === 1)
    selected.push(hooks[0] as WiringSurface);
  if (managed(detection, ".husky/pre-push", "husky")) selected.push("husky");
  if (managed(detection, "lefthook.yml", "lefthook")) selected.push("lefthook");
  if (
    options.designReview ||
    managed(detection, "autobuild.toml", "autobuild-landing")
  )
    selected.push("autobuild-landing");
  if (found(detection, "autobuild.toml") && options.offerGate)
    selected.push("autobuild-gate");
  const autobuild = detection.signals["autobuild.toml"]?.entry;
  // The fix step changes what a build's verify step does, so init offers it
  // default off; it stays selected once a project runs it.
  if (
    autobuild?.kind === "file" &&
    /^\s*skill\s*=\s*"idiom-fix"/m.test(autobuild.content)
  )
    selected.push("autobuild-fix");
  if (
    found(detection, "autobuild.toml") &&
    (options.offerGate ||
      (autobuild?.kind === "file" &&
        /^\s*\[finalize\.idiom-baseline\]/m.test(autobuild.content)))
  )
    selected.push("autobuild-baseline");
  for (const target of AUTOBUILD_SKILLS)
    if (
      found(detection, target.path) &&
      (options.offerAutobuildSkills ||
        managed(detection, target.path, target.surface, "html"))
    )
      selected.push(target.surface);
  const workflow = detection.signals[".github/workflows/idiom.yml"]?.entry;
  const nightly =
    options.nightly === true ||
    (workflow?.kind === "file" &&
      managed(detection, ".github/workflows/idiom.yml", "github") &&
      /^\s+schedule:/m.test(workflow.content));
  const advanceBaseline =
    options.advanceBaseline === true ||
    (workflow?.kind === "file" &&
      managed(detection, ".github/workflows/idiom.yml", "github") &&
      workflow.content.includes("idiom baseline advance"));
  return {
    selected: [...new Set(selected)].filter(
      (id) => !options.skipWiring?.includes(id),
    ),
    nightly,
    advanceBaseline,
  };
}

/** Read-only: every surface's candidate is computed, nothing is written. */
export async function planWiring(
  root: string,
  options: WiringOptions,
  dependencies: WiringDependencies = {},
  selection?: WiringSelection,
): Promise<WiringPlan> {
  validateWiringOptions(options);
  const detection = await detectWiring(root, dependencies);
  const choices = selection ?? defaultSelection(detection, options);
  for (const id of choices.selected)
    if (!(WIRING_SURFACES as readonly string[]).includes(id))
      throw new Error(`Unknown selected wiring surface: ${id}`);
  const snapshots = new Map<string, string>();
  const proposals: Proposal[] = [];
  const writes = new Map<string, Write>();
  const plan: WiringPlan = { detection, proposals, writes: [], snapshots };
  const skipped = (surface: WiringSurface) =>
    options.skipWiring?.includes(surface) === true;
  const chosen = (surface: WiringSurface) =>
    !skipped(surface) && choices.selected.includes(surface);

  async function offer(
    surface: WiringSurface,
    path: string,
    available: boolean,
    reason: string,
    writer: (source: string) => Writer | Promise<Writer>,
    optional = false,
    existingOnly = false,
  ) {
    const row: Proposal = {
      surface,
      path,
      selected: chosen(surface),
      disposition: "skipped",
      reason,
    };
    proposals.push(row);
    if (skipped(surface)) {
      row.reason = "Individually skipped; left unchanged.";
      return;
    }
    if (!available) {
      row.disposition = "unavailable";
      return;
    }
    if (!row.selected && !existingOnly) {
      row.reason = `${optional ? "Default off; select it explicitly. " : "Not selected. "}${reason}`;
      return;
    }
    try {
      const state = await inspect(root, path, snapshots);
      if (
        (existingOnly && state.kind !== "file") ||
        (state.kind !== "absent" && state.kind !== "file")
      )
        throw new Error(`Protected ${path}: ${state.kind}`);
      const source =
        writes.get(path)?.content ??
        (state.kind === "file" ? state.content : "");
      const result = await writer(source);
      if (!row.selected) {
        row.reason = `Default off; select it explicitly. ${reason}`;
        return;
      }
      const diff = createAutobuildDiff(source, result.candidate, path);
      const extra = result.extra ?? "";
      row.reason = result.reason ?? reason;
      if (diff || extra) row.preview = diff + extra;
      row.disposition =
        !diff && !extra
          ? "unchanged"
          : state.kind === "absent" && !writes.has(path)
            ? "create"
            : "update";
      if (result.candidate !== source)
        writes.set(path, {
          path,
          content: result.candidate,
          ...(surface === "husky" && state.kind === "absent"
            ? { mode: 0o755 }
            : {}),
        });
    } catch (error) {
      row.disposition = "protected";
      row.reason =
        (error as Error).message +
        (existingOnly
          ? " Repair the path or skill by hand, then rerun idiom init --wire."
          : "");
    }
  }

  await offer(
    "agents",
    "AGENTS.md",
    true,
    "Portable Design QA instructions for coding agents.",
    instructionWriter,
  );
  const claude = detection.signals["CLAUDE.md"]?.entry;
  if (
    claude?.kind === "symlink" &&
    resolve(root, claude.target) === resolve(root, "AGENTS.md")
  ) {
    // Only this root-to-root alias is followed; AGENTS.md carries the section.
    const row: Proposal = {
      surface: "claude",
      path: "CLAUDE.md",
      selected: chosen("claude"),
      disposition: "unchanged",
      reason: "CLAUDE.md → AGENTS.md is covered by the AGENTS.md section.",
    };
    proposals.push(row);
    if (!row.selected || skipped("agents")) {
      row.disposition = "skipped";
      row.reason = "Alias left unchanged (it or AGENTS.md is skipped).";
    } else {
      await inspect(root, "CLAUDE.md", snapshots);
      const target = proposals.find((entry) => entry.surface === "agents");
      if (target?.disposition === "protected") {
        row.disposition = "protected";
        row.reason = `Alias target is protected: ${target.reason}`;
      }
    }
  } else
    await offer(
      "claude",
      "CLAUDE.md",
      found(detection, "CLAUDE.md"),
      "Existing Claude instructions receive Design QA too.",
      instructionWriter,
    );
  await offer(
    "cursor",
    ".cursor/rules/idiom.mdc",
    found(detection, ".cursor"),
    "Cursor alwaysApply Design QA rule.",
    cursorWriter,
  );
  await offer(
    "github",
    ".github/workflows/idiom.yml",
    found(detection, ".github/workflows"),
    choices.advanceBaseline === true
      ? "PR comparison, full default-branch checks, and a job that advances the committed baseline on every push to the default branch."
      : "PR comparison and full default-branch checks.",
    (source) =>
      githubWriter(
        source,
        detection,
        choices.nightly,
        choices.advanceBaseline === true,
      ),
  );
  await offer(
    "husky",
    ".husky/pre-push",
    found(detection, ".husky"),
    `Pre-push: ${HOOK_COMMAND}`,
    huskyWriter,
    true,
  );
  await offer(
    "lefthook",
    "lefthook.yml",
    found(detection, "lefthook.yml"),
    `Pre-push: ${HOOK_COMMAND}`,
    lefthookWriter,
    true,
  );
  const hasAutobuild = found(detection, "autobuild.toml");
  // Integration adapters only prepare; the single final confirmation applies.
  // Every step skill they install shares one transaction.
  const installs = new SkillInstalls(root);
  let migrating = false;
  await offer(
    "autobuild-gate",
    "autobuild.toml",
    hasAutobuild,
    "The Idiom UI gate in Autobuild verify steps (offered at a prompt and applied by idiom init --wire --yes).",
    async (source) => {
      const prepared = await prepareAutobuild(root, source, installs);
      if (!prepared) throw new Error("Autobuild not detected");
      for (const [path, snapshot] of prepared.snapshots)
        snapshots.set(path, snapshot);
      if (prepared.apply) {
        plan.apply = prepared.apply;
        migrating = prepared.legacyMigration === true;
      }
      return {
        candidate: prepared.candidate,
        extra: prepared.extra,
        reason: prepared.preview
          ? "Wire the Idiom UI gate into Autobuild verify steps."
          : "Gate already wired.",
      };
    },
    true,
  );
  const gate = proposals.at(-1);
  if (
    gate?.disposition === "skipped" &&
    !skipped("autobuild-gate") &&
    hasAutobuild
  ) {
    // Not offered (for example under a scaffold --yes), but an existing gate is reported.
    try {
      const prepared = await prepareAutobuild(root);
      if (prepared && !prepared.preview) {
        gate.disposition = "unchanged";
        gate.reason = "Gate already wired.";
      }
    } catch {
      /* Left as offered; a selected run reports why it cannot be wired. */
    }
  }
  await offer(
    "autobuild-fix",
    "autobuild.toml",
    hasAutobuild,
    FIX_STEP_REASON,
    async (source) => {
      if (migrating)
        throw new Error(
          "The legacy verifier migration is pending; apply it, then rerun idiom init --wire.",
        );
      const prepared = await prepareFixStep(root, source, installs);
      if (!prepared) throw new Error("Autobuild not detected");
      for (const [path, snapshot] of prepared.snapshots)
        snapshots.set(path, snapshot);
      if (prepared.apply && !installs.empty) plan.apply = prepared.apply;
      return {
        candidate: prepared.candidate,
        extra: prepared.extra,
        reason: prepared.preview ? FIX_STEP_REASON : "Fix step already wired.",
      };
    },
    true,
  );
  await offer(
    "autobuild-baseline",
    "autobuild.toml",
    hasAutobuild,
    `Advance the gate's baseline as each build finalizes (${baselineCommand}; failures are recorded, never block the PR).`,
    (source) => ({ candidate: planBaselineFinalize(source).candidate }),
    true,
  );
  await offer(
    "autobuild-verifier",
    "autobuild.toml",
    hasAutobuild,
    "Optional finding verifier for Idiom-originated tickets (asks for one flow).",
    async (source) => {
      const commands = parse(source).commands as
        | Record<string, unknown>
        | undefined;
      if (commands?.["idiom-verify"] !== undefined)
        return {
          candidate: source,
          reason: "Existing finding-verifier flow and paths retained.",
        };
      if (migrating)
        throw new Error(
          "The legacy verifier migration is pending; apply it, then rerun idiom init --wire.",
        );
      const messages: string[] = [];
      const prepared = await prepareOptionalVerifier({
        projectDirectory: root,
        source,
        selected: true,
        installs,
        interactive: dependencies.interactive === true,
        ...(dependencies.confirm ? { confirm: dependencies.confirm } : {}),
        write: (message) => messages.push(message.trim()),
      });
      if (!prepared)
        throw new Error(
          messages.join(" ") ||
            "No verifier flow selected; rerun idiom init --wire at a prompt.",
        );
      for (const [path, snapshot] of prepared.snapshots)
        snapshots.set(path, snapshot);
      if (prepared.apply) plan.apply = prepared.apply;
      return {
        candidate: prepared.candidate,
        extra: prepared.extra,
        reason: ["Optional finding verifier.", ...messages].join(" "),
      };
    },
    true,
  );
  await offer(
    "autobuild-landing",
    "autobuild.toml",
    hasAutobuild,
    LANDING_REASON,
    landingWriter,
    true,
  );
  for (const target of AUTOBUILD_SKILLS)
    await offer(
      target.surface,
      target.path,
      found(detection, target.path),
      `${target.label}: short Idiom instructions (offered at a prompt and applied by idiom init --wire --yes).`,
      (source) => autobuildSkillWriter(source, target),
      true,
      true,
    );
  plan.writes = [...writes.values()];
  plan.schedule = {
    cron: (
      await scheduleFor({
        kind: "cron",
        root,
        environment: dependencies.environment,
      })
    ).text,
    launchd: "idiom nightly --print-schedule launchd",
  };
  return plan;
}
