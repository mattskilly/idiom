import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parse, type TomlTable, type TomlValue } from "smol-toml";
import {
  gateCommand,
  isCompatibleIdiomCommand,
  planAutobuildWiring,
} from "../autobuild/wiring.js";
import {
  findOptionalProjectDirectory,
  resolveProjectArgument,
} from "../project.js";
import { type Entry, inspect } from "../skills/paths.js";
import { readAutobuildTemplate } from "../templates.js";
import {
  codexMcpAddCommand,
  isNewer,
  updateCommand,
} from "../update/notice.js";
import { IDIOM_VERSION } from "../version.js";
import {
  AUTOBUILD_SKILLS,
  type AutobuildSkill,
  autobuildSkillWriter,
} from "../wiring/autobuild-skills.js";
import { executableOnPath } from "../wiring/detect.js";
import { HOOK_COMMAND, huskyWriter } from "../wiring/hooks.js";
import { cursorWriter, instructionWriter } from "../wiring/instructions.js";
import { markers, sectionSpan } from "../wiring/sections.js";
import type { DetectionDependencies, Writer } from "../wiring/types.js";

export const SURFACE_STATUSES = [
  "wired",
  "missing",
  "stale",
  "not-applicable",
] as const;
export type SurfaceStatus = (typeof SURFACE_STATUSES)[number];
export const SURFACE_IDS = [
  "autobuild-gate",
  "autobuild-verifier",
  "autobuild-plan",
  "autobuild-implement",
  "autobuild-code-review",
  "github",
  "agents",
  "claude",
  "cursor",
  "claude-plugin",
  "codex-mcp",
  "git-hook",
] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];
export type SurfaceEntry = {
  id: SurfaceId;
  label: string;
  status: SurfaceStatus;
  path?: string | undefined;
  detail: string;
  /** The exact command or edit that fixes it; only on missing and stale. */
  fix?: string | undefined;
};
export type SurfacesReport = {
  root: string;
  initialized: boolean;
  notice?: string | undefined;
  ms: number;
  entries: SurfaceEntry[];
};
export type SurfaceDependencies = {
  home?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  executable?: ((path: string) => Promise<boolean>) | undefined;
};

const LABELS: Record<SurfaceId, string> = {
  "autobuild-gate": "Autobuild gate step",
  "autobuild-verifier": "Autobuild verifier step",
  "autobuild-plan": AUTOBUILD_SKILLS[0].label,
  "autobuild-implement": AUTOBUILD_SKILLS[1].label,
  "autobuild-code-review": AUTOBUILD_SKILLS[2].label,
  github: "GitHub workflow",
  agents: "Agent instruction (AGENTS.md)",
  claude: "Agent instruction (CLAUDE.md)",
  cursor: "Agent instruction (Cursor rule)",
  "claude-plugin": "Claude Code plugin hooks",
  "codex-mcp": "Codex MCP",
  "git-hook": "Git hook",
};
const WIRE = "idiom init --wire";
export const NOT_INITIALIZED_NOTICE =
  "No .idiom/project.json: Claude Code hooks and the Autobuild gate are inactive until you run idiom init.";
const WORKFLOW_READ_LIMIT = 256 * 1024;
const OLD_GATE_COMMAND = "idiom check --gate --fail-on major";

type Row = Omit<SurfaceEntry, "id" | "label">;
type Context = {
  root: string;
  initialized: boolean;
  home: string;
  environment: NodeJS.ProcessEnv;
  detection: DetectionDependencies;
};

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const words = (value: string) =>
  value
    .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
    .split(/[\t\n\f\r ]+/)
    .join(" ");
const runsIdiomCheck = (text: string) => /\bidiom check\b/.test(text);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
/** The file's text, or undefined when absent or not a regular file. */
async function readOutside(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    return stat.isFile() ? await readFile(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}
async function same(left: string, right: string): Promise<boolean> {
  const real = async (path: string) => {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  };
  return (await real(left)) === (await real(right));
}

/** The root `idiom init --wire` would use: the project, else the Git worktree. */
async function surfaceRoot(start: string): Promise<{
  root: string;
  initialized: boolean;
}> {
  try {
    const project = await findOptionalProjectDirectory(start);
    if (project !== undefined) return { root: project, initialized: true };
  } catch {
    /* An unreadable ancestor reads as not initialized. */
  }
  let current = start;
  while (true) {
    if (await exists(join(current, ".git")))
      return { root: current, initialized: false };
    const parent = dirname(current);
    if (parent === current) return { root: start, initialized: false };
    current = parent;
  }
}

// ── Autobuild ────────────────────────────────────────────────────────────

type Autobuild =
  | { kind: "absent" }
  | { kind: "unreadable"; problem: string }
  | { kind: "parsed"; source: string; document: TomlTable };

async function readAutobuild(root: string): Promise<Autobuild> {
  let entry: Entry;
  try {
    entry = await inspect(root, "autobuild.toml");
  } catch (error) {
    return { kind: "unreadable", problem: message(error) };
  }
  if (entry.kind === "absent") return { kind: "absent" };
  if (entry.kind !== "file")
    return {
      kind: "unreadable",
      problem: "autobuild.toml is not a regular file",
    };
  try {
    return {
      kind: "parsed",
      source: entry.content,
      document: parse(entry.content),
    };
  } catch (error) {
    return {
      kind: "unreadable",
      problem: `autobuild.toml does not parse: ${message(error).split("\n")[0]}`,
    };
  }
}

async function autobuildGate(autobuild: Autobuild): Promise<Row> {
  const path = "autobuild.toml";
  if (autobuild.kind === "absent")
    return { status: "not-applicable", detail: "no autobuild.toml" };
  if (autobuild.kind === "unreadable")
    return {
      status: "stale",
      path,
      detail: autobuild.problem,
      fix: `fix autobuild.toml so it parses, then ${WIRE}`,
    };
  const plan = planAutobuildWiring(
    autobuild.source,
    await readAutobuildTemplate(),
  );
  if (plan.kind === "ready" && plan.complete)
    return {
      status: "wired",
      path,
      detail: `[verify.idiom-check] runs \`${gateCommand}\``,
    };
  const { commands, verify } = autobuild.document;
  const command = isTable(commands) ? commands["idiom-check"] : undefined;
  const step = isTable(verify) ? verify["idiom-check"] : undefined;
  const steps = isTable(verify) ? verify.steps : undefined;
  const listed = Array.isArray(steps) && steps.includes("idiom-check");
  if (command === undefined && step === undefined && !listed)
    return {
      status: "missing",
      path,
      detail: "no idiom-check step in [verify]",
      fix: `${WIRE} (accept the Autobuild gate at the prompt)`,
    };
  const detail =
    step !== undefined && !listed
      ? "[verify.idiom-check] is defined but not in [verify].steps, so it never runs"
      : step === undefined && listed
        ? "idiom-check is in [verify].steps but [verify.idiom-check] is not defined"
        : step === undefined
          ? "[commands].idiom-check is set but no [verify.idiom-check] step runs it"
          : typeof command === "string" && words(command) === OLD_GATE_COMMAND
            ? `old template: \`${OLD_GATE_COMMAND}\` without --deferred warn, so busy hosts fail the build`
            : isTable(step) && step.paths !== undefined
              ? "old template: [verify.idiom-check].paths can skip UI changes"
              : plan.kind === "manual"
                ? manualReason(plan.reason)
                : `${WIRE} would still change the gate`;
  return {
    status: "stale",
    path,
    detail,
    fix:
      plan.kind === "manual"
        ? "edit autobuild.toml by hand (idiom init --wire cannot change it safely)"
        : `${WIRE} (accept the Autobuild gate at the prompt)`,
  };
}

const manualReason = (reason: string) =>
  reason.replace(/^Autobuild configuration could not be edited safely: /, "");

/** Segments before the first wildcard segment; empty when the glob starts with one. */
function staticPrefix(glob: string): string {
  const segments: string[] = [];
  for (const segment of glob.split("/")) {
    if (/[*?]/.test(segment)) break;
    segments.push(segment);
  }
  return segments.join("/");
}

async function autobuildVerifier(
  autobuild: Autobuild,
  root: string,
): Promise<Row> {
  const path = "autobuild.toml";
  if (autobuild.kind === "absent")
    return { status: "not-applicable", detail: "no autobuild.toml" };
  if (autobuild.kind === "unreadable")
    return {
      status: "not-applicable",
      detail: "autobuild.toml could not be read",
    };
  const { commands, verify } = autobuild.document;
  const named = isTable(verify)
    ? Object.entries(verify).filter(
        (pair): pair is [string, TomlTable] =>
          pair[0] !== "steps" && isTable(pair[1]),
      )
    : [];
  const legacySkill = (
    await inspect(root, ".agents/skills/ab-verify-idiom").catch(() => ({
      kind: "absent" as const,
    }))
  ).kind;
  if (
    named.some(([, step]) => step.skill === "ab-verify-idiom") ||
    legacySkill !== "absent"
  )
    return {
      status: "stale",
      path,
      detail: "legacy ab-verify-idiom verifier (old template)",
      fix: "idiom upgrade",
    };
  const found = named.find(
    ([name, step]) =>
      name !== "idiom-check" &&
      step.kind === "agent" &&
      step.skill === "idiom-verify",
  );
  if (found === undefined)
    return {
      status: "missing",
      path,
      detail: "optional finding verifier for Idiom-originated tickets",
      fix: `${WIRE} (accept the finding verifier at the prompt)`,
    };
  const [name, step] = found;
  const steps = isTable(verify) ? verify.steps : undefined;
  if (!Array.isArray(steps) || !steps.includes(name))
    return {
      status: "stale",
      path,
      detail: `[verify.${name}] is defined but not in [verify].steps, so it never runs`,
      fix: `add "${name}" to [verify].steps in autobuild.toml`,
    };
  const command = isTable(commands) ? commands["idiom-verify"] : undefined;
  if (!isCompatibleIdiomCommand(command))
    return {
      status: "stale",
      path,
      detail:
        "[commands].idiom-verify is not `idiom verify <flow> --spec .ab/spec.md --out .ab/idiom`",
      fix: "set [commands].idiom-verify to `idiom verify <flow> --spec .ab/spec.md --out .ab/idiom` in autobuild.toml",
    };
  const flow = words(command as string).split(" ")[2] ?? "";
  const manifest = await inspect(root, `.idiom/flows/${flow}.json`).catch(
    () => ({ kind: "absent" as const }),
  );
  if (manifest.kind !== "file")
    return {
      status: "stale",
      path,
      detail: `flow ${flow} does not exist, so every build skips verification`,
      fix: "set [commands].idiom-verify to an existing flow in autobuild.toml",
    };
  const globs = Array.isArray(step.paths)
    ? step.paths.filter((glob): glob is string => typeof glob === "string")
    : [];
  for (const glob of globs) {
    const prefix = staticPrefix(glob);
    if (prefix === "") continue;
    const target = await inspect(root, prefix).catch(() => ({
      kind: "absent" as const,
    }));
    if (target.kind === "absent")
      return {
        status: "stale",
        path,
        detail: `paths never match: ${glob}`,
        fix: `edit [verify.${name}].paths in autobuild.toml`,
      };
  }
  return {
    status: "wired",
    path,
    detail: `[verify.${name}] verifies flow ${flow}`,
  };
}

// ── GitHub ───────────────────────────────────────────────────────────────

const PIN_PATTERNS = [
  /mattskilly\/idiom@v?(\d+\.\d+\.\d+)\b/g,
  /@mattskilly\/idiom@v?(\d+\.\d+\.\d+)\b/g,
  /mattskilly-idiom-(\d+\.\d+\.\d+)\.tgz/g,
  /version:\s*["']?v?(\d+\.\d+\.\d+)\b/g,
];
/** The first pinned Idiom version older than this one, with its offset. */
function oldPin(text: string): { pin: string; index: number } | undefined {
  for (const pattern of PIN_PATTERNS)
    for (const match of text.matchAll(pattern)) {
      const pin = match[1] ?? "";
      if (isNewer(IDIOM_VERSION, pin)) return { pin, index: match.index };
    }
  return undefined;
}
const usesIdiom = (text: string) =>
  text.includes("mattskilly/idiom@") || runsIdiomCheck(text);

async function github(root: string): Promise<Row> {
  const directory = ".github/workflows";
  const entry = await inspect(root, directory);
  if (entry.kind === "absent")
    return { status: "not-applicable", detail: "no .github/workflows" };
  if (entry.kind !== "directory")
    return {
      status: "stale",
      path: directory,
      detail: ".github/workflows is not a directory",
      fix: `check ${directory} by hand`,
    };
  const files: string[] = [];
  let stale: Row | undefined;
  const names = (await readdir(join(root, directory)))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  for (const name of names) {
    const path = `${directory}/${name}`;
    const stat = await lstat(join(root, path));
    if (!stat.isFile() || stat.size > WORKFLOW_READ_LIMIT) continue;
    const file = await inspect(root, path);
    if (file.kind !== "file" || !usesIdiom(file.content)) continue;
    files.push(path);
    const old = oldPin(file.content);
    if (old === undefined || stale !== undefined) continue;
    let managed = false;
    try {
      const span = sectionSpan(file.content, markers("github"));
      managed =
        span !== undefined && old.index >= span.start && old.index < span.end;
    } catch {
      /* Malformed markers: treated as hand-written. */
    }
    stale = {
      status: "stale",
      path,
      detail: `${path} pins Idiom ${old.pin} (current ${IDIOM_VERSION})`,
      fix: managed ? WIRE : `change ${old.pin} to ${IDIOM_VERSION} in ${path}`,
    };
  }
  if (stale !== undefined) return stale;
  if (files.length === 0)
    return {
      status: "missing",
      path: `${directory}/idiom.yml`,
      detail: "no workflow runs Idiom",
      fix: WIRE,
    };
  return {
    status: "wired",
    path: files[0],
    detail: `runs in ${files.join(", ")}`,
  };
}

// ── Agent instructions ───────────────────────────────────────────────────

function instructionRow(
  path: string,
  entry: Entry,
  writer: (source: string) => Writer,
  unmanagedFix: string,
): Row {
  if (entry.kind === "absent")
    return { status: "missing", path, detail: `no ${path}`, fix: WIRE };
  if (entry.kind !== "file")
    return {
      status: "stale",
      path,
      detail: `${path} is protected (${entry.kind}); init leaves it alone`,
      fix: `replace ${path} with a regular file, then ${WIRE}`,
    };
  const source = entry.content;
  if (source.includes(markers("design-qa", "html")[0])) {
    try {
      return writer(source).candidate === source
        ? { status: "wired", path, detail: "current Design QA section" }
        : {
            status: "stale",
            path,
            detail: "older Design QA section",
            fix: WIRE,
          };
    } catch (error) {
      return {
        status: "stale",
        path,
        detail: message(error),
        fix: unmanagedFix,
      };
    }
  }
  if (source.includes("idiom check") || source.includes("idiom brief triage"))
    return {
      status: "stale",
      path,
      detail: `unmanaged Idiom text; ${WIRE} adds the current section`,
      fix: unmanagedFix,
    };
  return {
    status: "missing",
    path,
    detail: "no Design QA section",
    fix: unmanagedFix,
  };
}

async function agentInstructions(
  root: string,
): Promise<Record<"agents" | "claude" | "cursor", Row>> {
  const guarded = async (path: string, row: (entry: Entry) => Row) => {
    try {
      return row(await inspect(root, path));
    } catch (error) {
      return unreadable(path, error);
    }
  };
  const agents = await guarded("AGENTS.md", (entry) =>
    instructionRow("AGENTS.md", entry, instructionWriter, WIRE),
  );
  const claude = await guarded("CLAUDE.md", (entry): Row => {
    if (entry.kind === "absent")
      return { status: "not-applicable", detail: "no CLAUDE.md" };
    if (
      entry.kind === "symlink" &&
      resolve(root, entry.target) === resolve(root, "AGENTS.md")
    )
      return {
        ...agents,
        path: "CLAUDE.md",
        detail: `alias of AGENTS.md: ${agents.detail}`,
      };
    return instructionRow("CLAUDE.md", entry, instructionWriter, WIRE);
  });
  const rule = ".cursor/rules/idiom.mdc";
  const cursor = await guarded(".cursor", (entry) =>
    entry.kind === "absent"
      ? { status: "not-applicable", detail: "no .cursor directory" }
      : { status: "missing", detail: "" },
  );
  return {
    agents,
    claude,
    cursor:
      cursor.status === "missing"
        ? await guarded(rule, (entry) =>
            instructionRow(
              rule,
              entry,
              cursorWriter,
              // init cannot adopt an unmarked rule file.
              `move ${rule} aside, then ${WIRE}`,
            ),
          )
        : cursor,
  };
}

// ── Claude Code plugin ───────────────────────────────────────────────────

type PluginInstall = { key: string; version?: string; scope: string };

async function readJson(path: string): Promise<unknown> {
  const text = await readOutside(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Unknown shapes read as not installed rather than failing doctor. */
async function installedPlugin(
  config: string,
  root: string,
): Promise<PluginInstall | undefined> {
  const installed = await readJson(
    join(config, "plugins", "installed_plugins.json"),
  );
  if (!isObject(installed) || !isObject(installed.plugins)) return undefined;
  for (const [key, installs] of Object.entries(installed.plugins)) {
    if (key.split("@")[0] !== "idiom" || !Array.isArray(installs)) continue;
    for (const install of installs) {
      if (!isObject(install) || typeof install.scope !== "string") continue;
      const applies =
        install.scope === "user" ||
        (typeof install.projectPath === "string" &&
          (await same(install.projectPath, root)));
      if (applies)
        return {
          key,
          scope: install.scope,
          ...(typeof install.version === "string"
            ? { version: install.version }
            : {}),
        };
    }
  }
  return undefined;
}

async function pluginEnabled(
  config: string,
  root: string,
  key: string,
): Promise<boolean> {
  let enabled = true;
  for (const path of [
    join(config, "settings.json"),
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
  ]) {
    const settings = await readJson(path);
    const value = isObject(settings)
      ? isObject(settings.enabledPlugins)
        ? settings.enabledPlugins[key]
        : undefined
      : undefined;
    if (typeof value === "boolean") enabled = value;
  }
  return enabled;
}

async function claudePlugin(context: Context): Promise<Row> {
  const config =
    context.environment.CLAUDE_CONFIG_DIR?.trim() ||
    join(context.home, ".claude");
  const install = await installedPlugin(config, context.root);
  if (install === undefined) {
    if (
      !(await executableOnPath("claude", context.detection)) &&
      !(await exists(config))
    )
      return { status: "not-applicable", detail: "Claude Code not found" };
    return {
      status: "missing",
      detail: "the Idiom plugin is not installed for this project",
      fix: "claude plugin marketplace add mattskilly/idiom && claude plugin install idiom@idiom",
    };
  }
  if (!(await pluginEnabled(config, context.root, install.key)))
    return {
      status: "missing",
      detail: `${install.key} is installed but disabled`,
      fix: `claude plugin enable ${install.key}`,
    };
  if (!context.initialized)
    return {
      status: "missing",
      detail: "installed, but inactive: no .idiom/project.json",
      fix: "idiom init",
    };
  const project = await readJson(join(context.root, ".idiom", "project.json"));
  if (
    isObject(project) &&
    isObject(project.agent) &&
    project.agent.hooks === false
  )
    return {
      status: "missing",
      path: ".idiom/project.json",
      detail: "hooks turned off by agent.hooks: false",
      fix: "set agent.hooks to true in .idiom/project.json",
    };
  if (install.version !== undefined && isNewer(IDIOM_VERSION, install.version))
    return {
      status: "stale",
      detail: `installed ${install.version} (current ${IDIOM_VERSION})`,
      fix: updateCommand("claude-plugin", IDIOM_VERSION),
    };
  return {
    status: "wired",
    detail: `installed ${install.version ?? "(unknown version)"} (${install.scope}), enabled, agent.hooks on`,
  };
}

// ── Codex MCP ────────────────────────────────────────────────────────────

const CODEX_PINS = [
  /mattskilly-idiom-(\d+\.\d+\.\d+)\.tgz/,
  /@mattskilly\/idiom@v?(\d+\.\d+\.\d+)\b/,
];

async function codexMcp(context: Context): Promise<Row> {
  const codexHome =
    context.environment.CODEX_HOME?.trim() || join(context.home, ".codex");
  const fix = codexMcpAddCommand(IDIOM_VERSION);
  // The project file is consulted first: it overrides the user's.
  for (const [path, shown] of [
    [join(context.root, ".codex", "config.toml"), ".codex/config.toml"],
    [join(codexHome, "config.toml"), "~/.codex/config.toml"],
  ] as const) {
    const text = await readOutside(path);
    if (text === undefined) continue;
    let document: TomlTable;
    try {
      document = parse(text);
    } catch (error) {
      return {
        status: "stale",
        path: shown,
        detail: `${shown} does not parse: ${message(error).split("\n")[0]}`,
        fix: `check ${path} by hand`,
      };
    }
    const servers = document.mcp_servers;
    const server = isTable(servers) ? servers.idiom : undefined;
    if (!isTable(server)) continue;
    const parts = [
      server.command,
      ...(Array.isArray(server.args) ? server.args : []),
      server.url,
    ].filter((part): part is string => typeof part === "string");
    const joined = parts.join(" ");
    for (const pattern of CODEX_PINS) {
      const pin = pattern.exec(joined)?.[1];
      if (pin !== undefined && isNewer(IDIOM_VERSION, pin))
        return {
          status: "stale",
          path: shown,
          detail: `${shown} runs Idiom ${pin} (current ${IDIOM_VERSION})`,
          fix,
        };
    }
    return {
      status: "wired",
      path: shown,
      detail: `mcp_servers.idiom in ${shown}`,
    };
  }
  if (
    !(await executableOnPath("codex", context.detection)) &&
    !(await exists(codexHome))
  )
    return { status: "not-applicable", detail: "Codex not found" };
  return {
    status: "missing",
    detail: "no mcp_servers.idiom in Codex config",
    fix,
  };
}

// ── Git hook ─────────────────────────────────────────────────────────────

async function gitHook(root: string): Promise<Row> {
  const husky = (await inspect(root, ".husky")).kind !== "absent";
  const lefthook = await inspect(root, "lefthook.yml");
  if (!husky && lefthook.kind === "absent")
    return { status: "not-applicable", detail: "no husky or lefthook" };
  const rows: Row[] = [];
  if (husky) {
    const path = ".husky/pre-push";
    const hook = await inspect(root, path);
    if (hook.kind === "file") {
      const source = hook.content;
      const span = sectionSpan(source, markers("husky"));
      if (span !== undefined) {
        const current =
          huskyWriter(source).candidate === source ||
          source
            .slice(span.start, span.end)
            .includes(`${HOOK_COMMAND} || exit $?`);
        rows.push(
          current
            ? { status: "wired", path, detail: `pre-push runs ${HOOK_COMMAND}` }
            : {
                status: "stale",
                path,
                detail: "older Idiom pre-push block",
                fix: WIRE,
              },
        );
      } else if (runsIdiomCheck(source))
        rows.push({
          status: "wired",
          path,
          detail: "pre-push runs idiom check (hand-written)",
        });
    }
  }
  if (lefthook.kind === "file") {
    const path = "lefthook.yml";
    const source = lefthook.content;
    const span = sectionSpan(source, markers("lefthook"));
    if (span !== undefined)
      rows.push(
        source.slice(span.start, span.end).includes(HOOK_COMMAND)
          ? { status: "wired", path, detail: `pre-push runs ${HOOK_COMMAND}` }
          : {
              status: "stale",
              path,
              detail: "older Idiom pre-push command",
              fix: WIRE,
            },
      );
    else if (runsIdiomCheck(source))
      rows.push({
        status: "wired",
        path,
        detail: "pre-push runs idiom check (hand-written)",
      });
  }
  const wired = rows.find((row) => row.status === "wired");
  const stale = rows.find((row) => row.status === "stale");
  if (stale !== undefined) return stale;
  if (wired !== undefined) return wired;
  return {
    status: "missing",
    path: husky ? ".husky/pre-push" : "lefthook.yml",
    detail: "no pre-push hook runs idiom check",
    fix:
      husky && lefthook.kind !== "absent"
        ? `${WIRE} --git-hook --skip-wiring lefthook`
        : `${WIRE} --git-hook`,
  };
}

/** Skill health is independent of autobuild.toml and unrelated local prose. */
async function autobuildSkill(
  root: string,
  target: AutobuildSkill,
): Promise<Row> {
  const path = target.path;
  try {
    const state = await inspect(root, path);
    if (state.kind === "absent")
      return {
        status: "not-applicable",
        path,
        detail: `${target.identity} not installed`,
      };
    if (state.kind !== "file")
      throw new Error(`Protected ${path}: ${state.kind}`);
    const candidate = autobuildSkillWriter(state.content, target).candidate;
    const span = sectionSpan(state.content, markers(target.surface, "html"));
    if (!span || candidate !== state.content)
      return {
        status: span ? "stale" : "missing",
        path,
        detail: span ? "older Idiom skill section" : "no Idiom skill section",
        fix: `${WIRE} (select and accept ${target.surface})`,
      };
    return { status: "wired", path, detail: "current Idiom skill section" };
  } catch (error) {
    return {
      status: "stale",
      path,
      detail: message(error),
      fix: `repair ${path} by hand, then run ${WIRE} and select ${target.surface}`,
    };
  }
}

// ── Report ───────────────────────────────────────────────────────────────

function unreadable(path: string, error: unknown): Row {
  return {
    status: "stale",
    path,
    detail: `could not read: ${message(error)}`,
    fix: `check ${path} by hand`,
  };
}

/**
 * Where Idiom is wired, read-only: no network, no processes, only a bounded
 * set of file reads. Each surface catches its own errors.
 */
export async function inspectSurfaces(
  options: {
    project?: string | undefined;
    cwd?: string | undefined;
    dependencies?: SurfaceDependencies | undefined;
  } = {},
): Promise<SurfacesReport> {
  const started = performance.now();
  const dependencies = options.dependencies ?? {};
  const { root, initialized } = await surfaceRoot(
    resolveProjectArgument(options.project, options.cwd),
  );
  const environment = dependencies.environment ?? process.env;
  const context: Context = {
    root,
    initialized,
    home: dependencies.home ?? homedir(),
    environment,
    detection: {
      environment,
      ...(dependencies.platform === undefined
        ? {}
        : { platform: dependencies.platform }),
      ...(dependencies.executable === undefined
        ? {}
        : { executable: dependencies.executable }),
    },
  };
  const guard = async (path: string, work: () => Promise<Row>) => {
    try {
      return await work();
    } catch (error) {
      return unreadable(path, error);
    }
  };
  const autobuild = await readAutobuild(root);
  const [gate, verifier, workflow, instructions, plugin, codex, hook] =
    await Promise.all([
      guard("autobuild.toml", () => autobuildGate(autobuild)),
      guard("autobuild.toml", () => autobuildVerifier(autobuild, root)),
      guard(".github/workflows", () => github(root)),
      agentInstructions(root),
      guard("Claude Code settings", () => claudePlugin(context)),
      guard("Codex config", () => codexMcp(context)),
      guard(".husky/pre-push", () => gitHook(root)),
    ]);
  const [planSkill, implementSkill, reviewSkill] = await Promise.all([
    autobuildSkill(root, AUTOBUILD_SKILLS[0]),
    autobuildSkill(root, AUTOBUILD_SKILLS[1]),
    autobuildSkill(root, AUTOBUILD_SKILLS[2]),
  ]);
  const rows: Record<SurfaceId, Row> = {
    "autobuild-plan": planSkill,
    "autobuild-implement": implementSkill,
    "autobuild-code-review": reviewSkill,
    "autobuild-gate": gate,
    "autobuild-verifier": verifier,
    github: workflow,
    ...instructions,
    "claude-plugin": plugin,
    "codex-mcp": codex,
    "git-hook": hook,
  };
  return {
    root,
    initialized,
    ...(initialized ? {} : { notice: NOT_INITIALIZED_NOTICE }),
    ms: Math.round(performance.now() - started),
    entries: SURFACE_IDS.map((id) => {
      const row = rows[id];
      const fixed = row.status === "missing" || row.status === "stale";
      return {
        id,
        label: LABELS[id],
        status: row.status,
        ...(row.path === undefined ? {} : { path: row.path }),
        detail: row.detail,
        ...(fixed && row.fix !== undefined ? { fix: row.fix } : {}),
      };
    }),
  };
}

const MARK: Record<SurfaceStatus, string> = {
  wired: "✓",
  missing: "✗",
  stale: "!",
  "not-applicable": "–",
};
const WORD: Record<SurfaceStatus, string> = {
  wired: "wired",
  missing: "missing",
  stale: "stale",
  "not-applicable": "not applicable",
};

export function renderSurfaces(report: SurfacesReport): string[] {
  const status = Math.max(...Object.values(WORD).map((word) => word.length));
  const label = Math.max(...report.entries.map((entry) => entry.label.length));
  const lines = ["Where Idiom runs:"];
  if (report.notice !== undefined) lines.push(`  ! ${report.notice}`);
  for (const entry of report.entries) {
    lines.push(
      `  ${MARK[entry.status]} ${WORD[entry.status].padEnd(status)}  ${entry.label.padEnd(label)}  ${entry.detail}`.trimEnd(),
    );
    if (entry.fix !== undefined)
      lines.push(`    ${"".padEnd(status)}  fix: ${entry.fix}`);
  }
  return lines;
}
