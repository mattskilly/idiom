import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import {
  findOptionalProjectDirectory,
  resolveProjectArgument,
} from "../project.js";
import { IDIOM_PACKAGE_ROOT, IDIOM_VERSION } from "../version.js";
import {
  detectInstall,
  type Environment,
  fetchLatestRelease,
  isNewer,
  PACKAGE_NAME,
  resolvedRoot,
  UPGRADE_CHECK_DEADLINE_MS,
  type UpdateCheckDependencies,
  updateCacheDirectory,
  updateCheckDisabled,
  updateCommand,
} from "./notice.js";

/**
 * The first step of `idiom upgrade`: replace a global npm or bun install with
 * the latest release, then hand off to a fresh process from the replaced
 * package, which merges skills with its own templates. A successful install
 * has one legal continuation — that fresh process — so this process never
 * merges skills after replacing itself.
 */

/** Set on the handed-off child: it merges skills and never self-updates again. */
export const SELF_UPDATE_HANDOFF_ENV = "IDIOM_SELF_UPDATE_HANDOFF";
/** The version the parent replaced, so the child can report `cli.from`. */
export const SELF_UPDATE_FROM_ENV = "IDIOM_SELF_UPDATE_FROM";
/** The install command the parent ran, so the child can report `cli.command`. */
export const SELF_UPDATE_COMMAND_ENV = "IDIOM_SELF_UPDATE_COMMAND";

export const SOURCE_UPDATE_COMMAND =
  "git pull && bun install --frozen-lockfile && bun run build";
export const DEPENDENCY_UPDATE_COMMAND = `npm install --save-dev --save-exact ${PACKAGE_NAME}@latest`;

export type CliUpdateOutcome =
  /** The package manager ran; reported by the handed-off child. */
  | "updated"
  /** `--dry-run` on npm or bun with a newer release. */
  | "would-update"
  /** Already the latest stable release. */
  | "current"
  /** An install kind Idiom does not update; `command` says what to run. */
  | "manual"
  /** `--no-self-update`. */
  | "skipped"
  /** An update-check off switch is set. */
  | "disabled"
  /** Offline, registry failure or timeout. */
  | "unchecked"
  /** The package manager failed, or the new binary reports the wrong version. */
  | "failed";

export type CliUpdate = {
  from: string;
  to: string | null;
  command: string | null;
  outcome: CliUpdateOutcome;
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/** Runs a command to completion with piped output (the package manager and the --version probe). */
export type CommandRunner = (
  argv: string[],
  options: { cwd: string; env: Environment },
) => Promise<CommandResult>;

/** Starts the replaced CLI attached to this terminal; resolves to its exit code (null = could not start). */
export type HandoffRunner = (
  argv: string[],
  options: { cwd: string; env: Environment },
) => Promise<number | null>;

export type SelfUpdateDependencies = UpdateCheckDependencies & {
  run?: CommandRunner | undefined;
  handoff?: HandoffRunner | undefined;
  /** Default `process.execPath`. */
  execPath?: string | undefined;
};

export type SelfUpdateOptions = {
  project?: string | undefined;
  cwd?: string | undefined;
  dryRun?: boolean | undefined;
  /** False for `--no-self-update`. */
  selfUpdate: boolean;
  /** The original arguments after `node idiom`, forwarded to the handoff. */
  args: string[];
  /** Text-mode output before a handoff; unset with `--json`. */
  write?: ((line: string) => void) | undefined;
};

export type SelfUpdateResult =
  | { kind: "continue"; cli: CliUpdate; lines: string[] }
  | { kind: "handoff"; exitCode: number }
  | { kind: "failed"; cli: CliUpdate; message: string };

export const runCommand: CommandRunner = ([command = "", ...args], options) =>
  new Promise((accept) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // npm and bun are .cmd shims on Windows, which need a shell; every
      // argument is a fixed token. The --version probe runs node by absolute
      // path, which may contain spaces, so it never goes through one.
      shell: process.platform === "win32" && !isAbsolute(command),
    });
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) =>
      accept({ exitCode: null, stdout, stderr: stderr || error.message }),
    );
    child.once("close", (code) => accept({ exitCode: code, stdout, stderr }));
  });

export const runHandoff: HandoffRunner = ([command = "", ...args], options) =>
  new Promise((accept) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", () => accept(null));
    child.once("exit", (code) => accept(code));
  });

async function projectDirectoryFor(
  project: string | undefined,
  cwd: string,
): Promise<string | undefined> {
  try {
    return await findOptionalProjectDirectory(
      resolveProjectArgument(project, cwd),
    );
  } catch {
    return undefined;
  }
}

function lastLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
}

export async function selfUpdate(
  options: SelfUpdateOptions,
  dependencies: SelfUpdateDependencies = {},
): Promise<SelfUpdateResult> {
  const env = dependencies.env ?? process.env;
  const current = dependencies.currentVersion ?? IDIOM_VERSION;
  const cwd = options.cwd ?? process.cwd();
  const root = resolvedRoot(dependencies.packageRoot ?? IDIOM_PACKAGE_ROOT);
  const proceed = (cli: CliUpdate, ...lines: string[]): SelfUpdateResult => ({
    kind: "continue",
    cli,
    lines,
  });

  if (env[SELF_UPDATE_HANDOFF_ENV] === "1")
    return proceed({
      from: env[SELF_UPDATE_FROM_ENV] ?? current,
      to: current,
      command: env[SELF_UPDATE_COMMAND_ENV] ?? null,
      outcome: "updated",
    });
  if (!options.selfUpdate)
    return proceed({
      from: current,
      to: null,
      command: null,
      outcome: "skipped",
    });

  const kind = detectInstall(root, env);
  if (kind === "source")
    return proceed(
      {
        from: current,
        to: null,
        command: SOURCE_UPDATE_COMMAND,
        outcome: "manual",
      },
      `Idiom is running from a source checkout, so the CLI was not updated. To update it: ${SOURCE_UPDATE_COMMAND}, then run idiom upgrade again.`,
    );
  if (kind === "unknown")
    return proceed(
      {
        from: current,
        to: null,
        command: DEPENDENCY_UPDATE_COMMAND,
        outcome: "manual",
      },
      `Idiom could not tell how it was installed, so the CLI was not updated. Update it with the package manager that installed it (for a project dependency: ${DEPENDENCY_UPDATE_COMMAND}), then run idiom upgrade again.`,
    );

  if (
    await updateCheckDisabled(
      env,
      await projectDirectoryFor(options.project, cwd),
    )
  )
    return proceed(
      { from: current, to: null, command: null, outcome: "disabled" },
      `The Idiom CLI update check is turned off (IDIOM_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER, CI or "updateCheck": false); merging skills with the installed ${current}.`,
    );

  const latest = await fetchLatestRelease({
    env,
    current,
    cacheDirectory: dependencies.cacheDirectory ?? updateCacheDirectory(env),
    now: (dependencies.now ?? Date.now)(),
    fetch: dependencies.fetch,
    setTimer: dependencies.setTimer,
    deadlineMs: dependencies.deadlineMs ?? UPGRADE_CHECK_DEADLINE_MS,
  });
  if (latest === undefined)
    return proceed(
      { from: current, to: null, command: null, outcome: "unchecked" },
      `Could not check for a newer Idiom CLI (offline or the registry did not answer); merging skills with the installed ${current}.`,
    );
  if (!isNewer(latest, current))
    return proceed(
      { from: current, to: latest, command: null, outcome: "current" },
      `Idiom CLI ${current} is the latest release.`,
    );

  if (kind !== "npm-global" && kind !== "bun-global") {
    const command = updateCommand(kind, latest);
    return proceed(
      { from: current, to: latest, command, outcome: "manual" },
      `Idiom ${latest} is available (you have ${current}). This install is updated outside idiom upgrade: ${command}. Merging skills with the installed ${current}.`,
    );
  }

  const install =
    kind === "npm-global" ? ["npm", "install", "-g"] : ["bun", "add", "-g"];
  const argv = [...install, `${PACKAGE_NAME}@${latest}`];
  const commandText = argv.join(" ");
  const cli = (outcome: CliUpdateOutcome): CliUpdate => ({
    from: current,
    to: latest,
    command: commandText,
    outcome,
  });
  if (options.dryRun === true)
    return proceed(
      cli("would-update"),
      `Would update the Idiom CLI ${current} → ${latest} with: ${commandText}, then merge ${latest}'s skills. The skill report below uses the installed ${current} templates.`,
    );

  const failed = (message: string): SelfUpdateResult => ({
    kind: "failed",
    cli: cli("failed"),
    message,
  });
  const run = dependencies.run ?? runCommand;
  let installed: CommandResult;
  try {
    installed = await run(argv, { cwd, env });
  } catch (error) {
    installed = {
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  if (installed.exitCode !== 0) {
    const output =
      lastLine(installed.stderr) ?? lastLine(installed.stdout) ?? "(no output)";
    return failed(
      `Idiom CLI update failed: ${commandText} exited ${installed.exitCode ?? "without starting"}: ${output}. Your installed Idiom ${current} was left as it was and no skills were changed.`,
    );
  }

  // Run the replaced package directly: an `idiom` earlier on PATH may be a
  // different install, and this is the file the handoff starts.
  const execPath = dependencies.execPath ?? process.execPath;
  const entry = join(root, "dist", "cli.js");
  let reported: string | undefined;
  try {
    const probe = await run([execPath, entry, "--version"], {
      cwd,
      env: { ...env, IDIOM_NO_UPDATE_CHECK: "1" },
    });
    if (probe.exitCode === 0) reported = probe.stdout.trim().split(/\s+/)[0];
  } catch {}
  if (reported !== latest)
    return failed(
      `${commandText} finished, but the installed idiom reports ${reported || "no version"}, expected ${latest}. No skills were changed. To return to your previous version: ${install.join(" ")} ${PACKAGE_NAME}@${current}`,
    );

  options.write?.(
    `Updated the Idiom CLI ${current} → ${latest} (ran: ${commandText}).`,
  );
  const exitCode = await (dependencies.handoff ?? runHandoff)(
    [execPath, entry, ...options.args],
    {
      cwd,
      env: {
        ...env,
        [SELF_UPDATE_HANDOFF_ENV]: "1",
        [SELF_UPDATE_FROM_ENV]: current,
        [SELF_UPDATE_COMMAND_ENV]: commandText,
      },
    },
  );
  if (exitCode === null)
    return failed(
      `Updated the Idiom CLI to ${latest} but could not start it to merge skills. Run idiom upgrade again.`,
    );
  return { kind: "handoff", exitCode };
}
