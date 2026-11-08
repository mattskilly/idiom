import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { gateCommand, planAutobuildWiring } from "../src/autobuild/wiring.js";
import {
  inspectSurfaces,
  NOT_INITIALIZED_NOTICE,
  renderSurfaces,
  type SurfaceDependencies,
  type SurfaceEntry,
  type SurfaceId,
  type SurfacesReport,
} from "../src/doctor/surfaces.js";
import { readAutobuildTemplate } from "../src/templates.js";
import { codexMcpAddCommand, updateCommand } from "../src/update/notice.js";
import { IDIOM_VERSION } from "../src/version.js";
import {
  AUTOBUILD_SKILLS,
  autobuildSkillWriter,
} from "../src/wiring/autobuild-skills.js";
import { githubWriter } from "../src/wiring/github.js";
import { huskyWriter, lefthookWriter } from "../src/wiring/hooks.js";
import { cursorWriter, instructionWriter } from "../src/wiring/instructions.js";
import { markedBlock, markers, sectionSpan } from "../src/wiring/sections.js";

// Every test uses a temporary repository and a fake home, so nothing reads
// the developer's real ~/.claude or ~/.codex.

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

type Fixture = {
  root: string;
  home: string;
  write(path: string, content: string): Promise<void>;
  inspect(): Promise<SurfacesReport>;
  entry(id: SurfaceId): Promise<SurfaceEntry>;
};

async function fixture(
  options: {
    initialized?: boolean;
    project?: object;
    environment?: NodeJS.ProcessEnv;
    executables?: string[];
  } = {},
): Promise<Fixture> {
  const root = await temporary("idiom-surfaces-");
  const home = await temporary("idiom-surfaces-home-");
  await mkdir(join(root, ".git"));
  const write = async (path: string, content: string) => {
    const target = join(
      path.startsWith("~/") ? home : root,
      path.replace(/^~\//, ""),
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  if (options.initialized !== false)
    await write(".idiom/project.json", JSON.stringify(options.project ?? {}));
  const dependencies: SurfaceDependencies = {
    home,
    environment: { PATH: "/bin", ...options.environment },
    platform: "linux",
    executable: async (path) =>
      (options.executables ?? []).some((name) => path === `/bin/${name}`),
  };
  const inspect = () => inspectSurfaces({ cwd: root, dependencies });
  return {
    root,
    home,
    write,
    inspect,
    entry: async (id) => {
      const found = (await inspect()).entries.find((entry) => entry.id === id);
      if (found === undefined) throw new Error(`no ${id}`);
      return found;
    },
  };
}

const BASE_TOML = `[commands]
test = "bun test"

[verify]
steps = ["test"]

[verify.test]
kind = "check"
command = "test"
`;
const WIRE = "idiom init --wire";

// ── Autobuild gate ───────────────────────────────────────────────────────

test("autobuild gate: not applicable without autobuild.toml", async () => {
  const f = await fixture();
  expect(await f.entry("autobuild-gate")).toMatchObject({
    status: "not-applicable",
    detail: "no autobuild.toml",
  });
  expect((await f.entry("autobuild-gate")).fix).toBeUndefined();
});

test("autobuild gate: missing, wired from the shipped template, unparseable", async () => {
  const f = await fixture();
  await f.write("autobuild.toml", BASE_TOML);
  expect(await f.entry("autobuild-gate")).toMatchObject({
    status: "missing",
    fix: `${WIRE} (accept the Autobuild gate at the prompt)`,
  });

  const plan = planAutobuildWiring(BASE_TOML, await readAutobuildTemplate());
  await f.write("autobuild.toml", plan.candidate);
  expect(await f.entry("autobuild-gate")).toMatchObject({
    status: "wired",
    path: "autobuild.toml",
    detail: `[verify.idiom-check] runs \`${gateCommand}\``,
  });

  await f.write("autobuild.toml", "[commands\n");
  const broken = await f.entry("autobuild-gate");
  expect(broken.status).toBe("stale");
  expect(broken.detail).toMatch(/^autobuild\.toml does not parse/);
  expect(await f.entry("autobuild-verifier")).toMatchObject({
    status: "not-applicable",
    detail: "autobuild.toml could not be read",
  });
});

test("autobuild gate: stale when not in steps, on the old command, or path-gated", async () => {
  const f = await fixture();
  const step = `
[verify.idiom-check]
kind = "check"
command = "idiom-check"
`;
  await f.write(
    "autobuild.toml",
    `${BASE_TOML.replace('test = "bun test"', `test = "bun test"\nidiom-check = "${gateCommand}"`)}${step}`,
  );
  expect(await f.entry("autobuild-gate")).toMatchObject({
    status: "stale",
    detail:
      "[verify.idiom-check] is defined but not in [verify].steps, so it never runs",
    fix: `${WIRE} (accept the Autobuild gate at the prompt)`,
  });

  const listed = BASE_TOML.replace(
    'steps = ["test"]',
    'steps = ["test", "idiom-check"]',
  );
  await f.write(
    "autobuild.toml",
    `${listed.replace('test = "bun test"', 'test = "bun test"\nidiom-check = "idiom check --gate --fail-on major"')}${step}`,
  );
  expect((await f.entry("autobuild-gate")).detail).toMatch(
    /^old template: .* busy hosts fail the build$/,
  );

  await f.write(
    "autobuild.toml",
    `${listed.replace('test = "bun test"', `test = "bun test"\nidiom-check = "${gateCommand}"`)}${step}paths = ["apps/web/**"]\n`,
  );
  expect(await f.entry("autobuild-gate")).toMatchObject({
    status: "stale",
    detail: "old template: [verify.idiom-check].paths can skip UI changes",
  });
});

test("autobuild gate: a foreign idiom-check command needs a hand edit", async () => {
  const f = await fixture();
  await f.write(
    "autobuild.toml",
    `[commands]\nidiom-check = "node scripts/gate.mjs"\n\n[verify]\nsteps = ["idiom-check"]\n\n[verify.idiom-check]\nkind = "check"\ncommand = "idiom-check"\n`,
  );
  const entry = await f.entry("autobuild-gate");
  expect(entry.status).toBe("stale");
  expect(entry.detail).toMatch(/owned by a different or incompatible command/);
  expect(entry.fix).toMatch(/^edit autobuild\.toml by hand/);
});

// ── Autobuild verifier ───────────────────────────────────────────────────

const verifierToml = (options: {
  flow?: string;
  paths?: string[];
  listed?: boolean;
  skill?: string;
}) => `[commands]
idiom-verify = "idiom verify ${options.flow ?? "home"} --spec .ab/spec.md --out .ab/idiom"

[verify]
steps = [${options.listed === false ? "" : '"idiom"'}]

[verify.idiom]
kind = "agent"
skill = "${options.skill ?? "idiom-verify"}"
paths = ${JSON.stringify(options.paths ?? [".idiom/**", "src/**"])}
`;

test("autobuild verifier: not applicable, missing, wired", async () => {
  const f = await fixture();
  expect((await f.entry("autobuild-verifier")).status).toBe("not-applicable");
  await f.write("autobuild.toml", BASE_TOML);
  expect(await f.entry("autobuild-verifier")).toMatchObject({
    status: "missing",
    fix: `${WIRE} (accept the finding verifier at the prompt)`,
  });
  await f.write("autobuild.toml", verifierToml({}));
  await f.write(".idiom/flows/home.json", "{}");
  await f.write("src/app.tsx", "");
  expect(await f.entry("autobuild-verifier")).toMatchObject({
    status: "wired",
    detail: "[verify.idiom] verifies flow home",
  });
});

test("autobuild verifier: stale for the legacy skill, a missing flow, dead paths, or never running", async () => {
  const f = await fixture();
  await f.write(".idiom/flows/home.json", "{}");
  await f.write("src/app.tsx", "");

  // The literal old template.
  await f.write(
    "autobuild.toml",
    verifierToml({
      skill: "ab-verify-idiom",
      paths: ["apps/web/**", "packages/design/**"],
    }),
  );
  expect(await f.entry("autobuild-verifier")).toMatchObject({
    status: "stale",
    detail: "legacy ab-verify-idiom verifier (old template)",
    fix: "idiom upgrade",
  });

  await f.write("autobuild.toml", verifierToml({ flow: "booking" }));
  expect(await f.entry("autobuild-verifier")).toMatchObject({
    status: "stale",
    detail: "flow booking does not exist, so every build skips verification",
    fix: "set [commands].idiom-verify to an existing flow in autobuild.toml",
  });

  await f.write(
    "autobuild.toml",
    verifierToml({ paths: ["src/**", "apps/web/**", "**"] }),
  );
  expect(await f.entry("autobuild-verifier")).toMatchObject({
    status: "stale",
    detail: "paths never match: apps/web/**",
    fix: "edit [verify.idiom].paths in autobuild.toml",
  });

  await f.write("autobuild.toml", verifierToml({ listed: false }));
  expect(await f.entry("autobuild-verifier")).toMatchObject({
    status: "stale",
    detail:
      "[verify.idiom] is defined but not in [verify].steps, so it never runs",
  });
});

// ── GitHub ───────────────────────────────────────────────────────────────

const workflow = () =>
  githubWriter(
    "",
    {
      signals: {},
      agents: { claude: false, codex: false },
      branchReason: "",
      setup: { manager: "npm", command: "npm ci" },
    },
    false,
  ).candidate;

test("github: not applicable, missing, wired from the writer", async () => {
  const f = await fixture();
  expect((await f.entry("github")).status).toBe("not-applicable");
  await f.write(
    ".github/workflows/ci.yml",
    "jobs:\n  test:\n    run: npm test\n",
  );
  expect(await f.entry("github")).toMatchObject({
    status: "missing",
    detail: "no workflow runs Idiom",
    fix: WIRE,
  });
  await f.write(".github/workflows/idiom.yml", workflow());
  expect(await f.entry("github")).toMatchObject({
    status: "wired",
    path: ".github/workflows/idiom.yml",
  });
});

test("github: an old pin is stale; the fix depends on who owns the line", async () => {
  const f = await fixture();
  await f.write(
    ".github/workflows/idiom.yml",
    workflow().replace("mattskilly/idiom@main", "mattskilly/idiom@v0.1.0"),
  );
  expect(await f.entry("github")).toMatchObject({
    status: "stale",
    detail: `.github/workflows/idiom.yml pins Idiom 0.1.0 (current ${IDIOM_VERSION})`,
    fix: WIRE,
  });

  await rm(join(f.root, ".github/workflows/idiom.yml"));
  await f.write(
    ".github/workflows/ci.yml",
    "jobs:\n  ui:\n    steps:\n      - run: npx @mattskilly/idiom@0.1.0 check home\n",
  );
  expect(await f.entry("github")).toMatchObject({
    status: "stale",
    fix: `change 0.1.0 to ${IDIOM_VERSION} in .github/workflows/ci.yml`,
  });
});

// ── Agent instructions ───────────────────────────────────────────────────

test("agent instructions: missing, wired, older section, unmanaged text", async () => {
  const f = await fixture();
  expect(await f.entry("agents")).toMatchObject({
    status: "missing",
    detail: "no AGENTS.md",
    fix: WIRE,
  });
  await f.write("AGENTS.md", "# Repo\n\nUse tabs.\n");
  expect((await f.entry("agents")).detail).toBe("no Design QA section");

  const wired = instructionWriter("# Repo\n").candidate;
  await f.write("AGENTS.md", wired);
  expect(await f.entry("agents")).toMatchObject({
    status: "wired",
    detail: "current Design QA section",
  });

  await f.write(
    "AGENTS.md",
    wired.replace(
      "After changing UI, run `idiom check --changed`.",
      "After changing UI, run `idiom check`.",
    ),
  );
  expect(await f.entry("agents")).toMatchObject({
    status: "stale",
    detail: "older Design QA section",
    fix: WIRE,
  });

  await f.write("AGENTS.md", "# Repo\n\nRun idiom check after UI work.\n");
  expect(await f.entry("agents")).toMatchObject({
    status: "stale",
    detail: `unmanaged Idiom text; ${WIRE} adds the current section`,
  });
});

test("CLAUDE.md: not applicable when absent, its own status, or mirrors an AGENTS.md alias", async () => {
  const f = await fixture();
  expect((await f.entry("claude")).status).toBe("not-applicable");
  await f.write("CLAUDE.md", instructionWriter("").candidate);
  expect((await f.entry("claude")).status).toBe("wired");

  await rm(join(f.root, "CLAUDE.md"));
  await f.write("AGENTS.md", "# Repo\n");
  await symlink("AGENTS.md", join(f.root, "CLAUDE.md"));
  expect(await f.entry("claude")).toMatchObject({
    status: "missing",
    path: "CLAUDE.md",
    detail: "alias of AGENTS.md: no Design QA section",
    fix: WIRE,
  });
});

test("cursor rule: not applicable, missing, wired, unmanaged", async () => {
  const f = await fixture();
  expect((await f.entry("cursor")).status).toBe("not-applicable");
  await mkdir(join(f.root, ".cursor"));
  expect(await f.entry("cursor")).toMatchObject({
    status: "missing",
    fix: WIRE,
  });
  await f.write(".cursor/rules/idiom.mdc", cursorWriter("").candidate);
  expect((await f.entry("cursor")).status).toBe("wired");
  await f.write(".cursor/rules/idiom.mdc", "Run idiom check after UI work.\n");
  expect(await f.entry("cursor")).toMatchObject({
    status: "stale",
    fix: `move .cursor/rules/idiom.mdc aside, then ${WIRE}`,
  });
});

// ── Claude Code plugin ───────────────────────────────────────────────────

const installed = (installs: object[]) =>
  JSON.stringify({ version: 2, plugins: { "idiom@idiom": installs } });
const userInstall = (version = IDIOM_VERSION) => ({
  scope: "user",
  version,
  installPath: "/cache/idiom",
});

test("claude plugin: not applicable without Claude Code, missing when not installed", async () => {
  const f = await fixture();
  expect(await f.entry("claude-plugin")).toMatchObject({
    status: "not-applicable",
  });
  const onPath = await fixture({ executables: ["claude"] });
  expect(await onPath.entry("claude-plugin")).toMatchObject({
    status: "missing",
    fix: "claude plugin marketplace add mattskilly/idiom && claude plugin install idiom@idiom",
  });
});

test("claude plugin: wired for a user install, and for a project install of this root only", async () => {
  const f = await fixture();
  await f.write(
    "~/.claude/plugins/installed_plugins.json",
    installed([userInstall()]),
  );
  expect(await f.entry("claude-plugin")).toMatchObject({
    status: "wired",
    detail: `installed ${IDIOM_VERSION} (user), enabled, agent.hooks on`,
  });

  await f.write(
    "~/.claude/plugins/installed_plugins.json",
    installed([
      { scope: "project", projectPath: "/elsewhere", version: IDIOM_VERSION },
    ]),
  );
  expect((await f.entry("claude-plugin")).status).toBe("missing");

  await f.write(
    "~/.claude/plugins/installed_plugins.json",
    installed([
      { scope: "project", projectPath: f.root, version: IDIOM_VERSION },
    ]),
  );
  expect((await f.entry("claude-plugin")).detail).toMatch(/\(project\)/);
});

test("claude plugin: CLAUDE_CONFIG_DIR is where the install is read", async () => {
  const config = await temporary("idiom-claude-config-");
  const f = await fixture({ environment: { CLAUDE_CONFIG_DIR: config } });
  await mkdir(join(config, "plugins"));
  await writeFile(
    join(config, "plugins", "installed_plugins.json"),
    installed([userInstall()]),
  );
  expect((await f.entry("claude-plugin")).status).toBe("wired");
});

test("claude plugin: missing when disabled, hooks off, or not initialized; stale when old", async () => {
  const f = await fixture();
  await f.write(
    "~/.claude/plugins/installed_plugins.json",
    installed([userInstall()]),
  );
  await f.write(
    "~/.claude/settings.json",
    JSON.stringify({ enabledPlugins: { "idiom@idiom": true } }),
  );
  await f.write(
    ".claude/settings.local.json",
    JSON.stringify({ enabledPlugins: { "idiom@idiom": false } }),
  );
  expect(await f.entry("claude-plugin")).toMatchObject({
    status: "missing",
    detail: "idiom@idiom is installed but disabled",
    fix: "claude plugin enable idiom@idiom",
  });
  await rm(join(f.root, ".claude/settings.local.json"));

  await f.write(
    ".idiom/project.json",
    JSON.stringify({ agent: { hooks: false } }),
  );
  expect(await f.entry("claude-plugin")).toMatchObject({
    status: "missing",
    detail: "hooks turned off by agent.hooks: false",
    fix: "set agent.hooks to true in .idiom/project.json",
  });

  await f.write(".idiom/project.json", "{}");
  await f.write(
    "~/.claude/plugins/installed_plugins.json",
    installed([userInstall("0.1.0")]),
  );
  expect(await f.entry("claude-plugin")).toMatchObject({
    status: "stale",
    fix: updateCommand("claude-plugin", IDIOM_VERSION),
  });

  const fresh = await fixture({ initialized: false });
  await fresh.write(
    "~/.claude/plugins/installed_plugins.json",
    installed([userInstall()]),
  );
  expect(await fresh.entry("claude-plugin")).toMatchObject({
    status: "missing",
    detail: "installed, but inactive: no .idiom/project.json",
    fix: "idiom init",
  });
});

// ── Codex MCP ────────────────────────────────────────────────────────────

test("codex mcp: not applicable, missing, stale, wired", async () => {
  const f = await fixture();
  expect((await f.entry("codex-mcp")).status).toBe("not-applicable");
  await mkdir(join(f.home, ".codex"));
  expect(await f.entry("codex-mcp")).toMatchObject({
    status: "missing",
    fix: codexMcpAddCommand(IDIOM_VERSION),
  });

  await f.write(
    "~/.codex/config.toml",
    `[mcp_servers.idiom]\ncommand = "npx"\nargs = ["-y", "--package=https://github.com/mattskilly/idiom/releases/download/v0.1.0/mattskilly-idiom-0.1.0.tgz", "idiom", "mcp"]\n`,
  );
  expect(await f.entry("codex-mcp")).toMatchObject({
    status: "stale",
    detail: `~/.codex/config.toml runs Idiom 0.1.0 (current ${IDIOM_VERSION})`,
    fix: codexMcpAddCommand(IDIOM_VERSION),
  });

  await f.write(
    "~/.codex/config.toml",
    `[mcp_servers.idiom]\ncommand = "idiom"\nargs = ["mcp"]\n`,
  );
  expect(await f.entry("codex-mcp")).toMatchObject({
    status: "wired",
    detail: "mcp_servers.idiom in ~/.codex/config.toml",
  });

  const project = await fixture();
  await project.write(
    ".codex/config.toml",
    `[mcp_servers.idiom]\ncommand = "idiom"\nargs = ["mcp"]\n`,
  );
  expect(await project.entry("codex-mcp")).toMatchObject({
    status: "wired",
    path: ".codex/config.toml",
  });
});

test("codex-plugin update command still composes the MCP line", () => {
  expect(updateCommand("codex-plugin", "1.2.3")).toBe(
    `codex plugin marketplace upgrade idiom && codex plugin add idiom@idiom && ${codexMcpAddCommand("1.2.3")}`,
  );
  expect(codexMcpAddCommand("1.2.3")).toBe(
    "codex mcp add idiom -- npx -y --package=https://github.com/mattskilly/idiom/releases/download/v1.2.3/mattskilly-idiom-1.2.3.tgz idiom mcp",
  );
});

// ── Git hook ─────────────────────────────────────────────────────────────

test("git hook: not applicable, missing, wired for husky and lefthook, stale block", async () => {
  const f = await fixture();
  expect((await f.entry("git-hook")).status).toBe("not-applicable");
  await mkdir(join(f.root, ".husky"));
  expect(await f.entry("git-hook")).toMatchObject({
    status: "missing",
    fix: `${WIRE} --git-hook`,
  });
  await f.write(".husky/pre-push", huskyWriter("").candidate);
  expect(await f.entry("git-hook")).toMatchObject({
    status: "wired",
    path: ".husky/pre-push",
  });
  await f.write(
    ".husky/pre-push",
    `${markedBlock("husky", "idiom check --gate --fail-on major || exit $?")}\n`,
  );
  expect(await f.entry("git-hook")).toMatchObject({
    status: "stale",
    detail: "older Idiom pre-push block",
    fix: WIRE,
  });

  const lefthook = await fixture();
  await lefthook.write("lefthook.yml", lefthookWriter("").candidate);
  expect(await lefthook.entry("git-hook")).toMatchObject({
    status: "wired",
    path: "lefthook.yml",
  });
});

test("git hook: with both managers the fix picks husky", async () => {
  const f = await fixture();
  await mkdir(join(f.root, ".husky"));
  await f.write("lefthook.yml", "pre-commit:\n  commands: {}\n");
  expect((await f.entry("git-hook")).fix).toBe(
    `${WIRE} --git-hook --skip-wiring lefthook`,
  );
});

// ── Report ───────────────────────────────────────────────────────────────

test("not initialized: the notice says hooks and gates are inactive", async () => {
  const f = await fixture({ initialized: false });
  const report = await f.inspect();
  expect(report.initialized).toBe(false);
  expect(report.root).toBe(f.root);
  expect(report.notice).toBe(NOT_INITIALIZED_NOTICE);
  expect(renderSurfaces(report).slice(0, 2)).toEqual([
    "Where Idiom runs:",
    `  ! ${NOT_INITIALIZED_NOTICE}`,
  ]);
  const initialized = await (await fixture()).inspect();
  expect(initialized.notice).toBeUndefined();
});

test("one unreadable surface does not hide the others", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "AGENTS.md"));
  const report = await f.inspect();
  expect(report.entries.map((entry) => entry.id)).toEqual([
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
  ]);
  expect(report.entries.find((entry) => entry.id === "agents")).toMatchObject({
    status: "stale",
    detail: "AGENTS.md is protected (directory); init leaves it alone",
  });
  expect(report.entries.find((entry) => entry.id === "github")?.status).toBe(
    "not-applicable",
  );
});

async function snapshot(root: string): Promise<string[]> {
  const rows: string[] = [];
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, name);
    const info = await stat(path);
    rows.push(
      `${name} ${info.mtimeMs} ${info.isFile() ? (await readFile(path)).toString("base64") : "dir"}`,
    );
  }
  return rows;
}

test("read-only, offline and under a second with every surface wired", async () => {
  const f = await fixture({ executables: ["claude", "codex"] });
  const plan = planAutobuildWiring(BASE_TOML, await readAutobuildTemplate());
  await f.write("autobuild.toml", plan.candidate);
  await f.write(".github/workflows/idiom.yml", workflow());
  await f.write("AGENTS.md", instructionWriter("").candidate);
  await f.write("CLAUDE.md", instructionWriter("").candidate);
  await f.write(".cursor/rules/idiom.mdc", cursorWriter("").candidate);
  await f.write(".husky/pre-push", huskyWriter("").candidate);
  await f.write(
    "~/.claude/plugins/installed_plugins.json",
    installed([userInstall()]),
  );
  await f.write(
    "~/.codex/config.toml",
    `[mcp_servers.idiom]\ncommand = "idiom"\nargs = ["mcp"]\n`,
  );
  const fetch = vi.fn(() => {
    throw new Error("no network");
  });
  vi.stubGlobal("fetch", fetch);
  const before = [await snapshot(f.root), await snapshot(f.home)];
  const started = performance.now();
  const report = await f.inspect();
  const wall = performance.now() - started;
  expect(
    Object.fromEntries(report.entries.map((e) => [e.id, e.status])),
  ).toEqual({
    "autobuild-gate": "wired",
    "autobuild-verifier": "missing",
    "autobuild-plan": "not-applicable",
    "autobuild-implement": "not-applicable",
    "autobuild-code-review": "not-applicable",
    github: "wired",
    agents: "wired",
    claude: "wired",
    cursor: "wired",
    "claude-plugin": "wired",
    "codex-mcp": "wired",
    "git-hook": "wired",
  });
  expect(report.ms).toBeLessThan(1000);
  expect(wall).toBeLessThan(1000);
  expect(fetch).not.toHaveBeenCalled();
  expect([await snapshot(f.root), await snapshot(f.home)]).toEqual(before);
});

test("rendering: marks, padded columns, fix lines only on missing and stale", () => {
  const report: SurfacesReport = {
    root: "/app",
    initialized: true,
    ms: 3,
    entries: [
      {
        id: "autobuild-gate",
        label: "Autobuild gate step",
        status: "wired",
        path: "autobuild.toml",
        detail: "runs",
      },
      {
        id: "github",
        label: "GitHub workflow",
        status: "missing",
        detail: "no workflow runs Idiom",
        fix: WIRE,
      },
      {
        id: "git-hook",
        label: "Git hook",
        status: "stale",
        detail: "older Idiom pre-push block",
        fix: WIRE,
      },
      {
        id: "codex-mcp",
        label: "Codex MCP",
        status: "not-applicable",
        detail: "Codex not found",
      },
    ],
  };
  expect(renderSurfaces(report)).toEqual([
    "Where Idiom runs:",
    "  ✓ wired           Autobuild gate step  runs",
    "  ✗ missing         GitHub workflow      no workflow runs Idiom",
    "                    fix: idiom init --wire",
    "  ! stale           Git hook             older Idiom pre-push block",
    "                    fix: idiom init --wire",
    "  – not applicable  Codex MCP            Codex not found",
  ]);
});

for (const target of AUTOBUILD_SKILLS) {
  test(`${target.surface}: absent, missing, current, old, removed, malformed and invalid`, async () => {
    const f = await fixture();
    expect((await f.entry(target.surface)).status).toBe("not-applicable");
    const source = await readFile(
      new URL(
        `./fixtures/autobuild-skills/${target.identity}.md`,
        import.meta.url,
      ),
      "utf8",
    );
    await f.write(target.path, source);
    expect(await f.entry(target.surface)).toMatchObject({
      status: "missing",
      fix: `${WIRE} (select and accept ${target.surface})`,
    });
    const current = autobuildSkillWriter(source, target).candidate;
    await f.write(
      target.path,
      `${current}\nUnrelated local edits mention idiom.\n`,
    );
    expect((await f.entry(target.surface)).status).toBe("wired");
    await f.write("autobuild.toml", "[broken");
    expect((await f.entry(target.surface)).status).toBe("wired");
    expect(renderSurfaces(await f.inspect()).join("\n")).toContain(
      target.label,
    );
    await f.write(target.path, current.replace("## Idiom", "## Old Idiom"));
    expect(await f.entry(target.surface)).toMatchObject({
      status: "stale",
      fix: `${WIRE} (select and accept ${target.surface})`,
    });
    const span = sectionSpan(current, markers(target.surface, "html"));
    if (!span) throw new Error("Expected managed section");
    await f.write(
      target.path,
      current.slice(0, span.start) + current.slice(span.end + 1),
    );
    expect((await f.entry(target.surface)).status).toBe("missing");
    for (const broken of [
      source + markers(target.surface, "html")[0],
      source.replace(target.identity, "wrong"),
    ]) {
      await f.write(target.path, broken);
      expect(await f.entry(target.surface)).toMatchObject({
        status: "stale",
        fix: expect.stringContaining("by hand"),
      });
    }
    await rm(join(f.root, target.path));
    await symlink(join(f.home, "foreign"), join(f.root, target.path));
    expect(await f.entry(target.surface)).toMatchObject({
      status: "stale",
      detail: expect.stringContaining("Protected"),
    });
    await rm(join(f.root, dirname(target.path)), { recursive: true });
    await symlink(f.home, join(f.root, dirname(target.path)));
    expect(await f.entry(target.surface)).toMatchObject({
      status: "stale",
      detail: expect.stringContaining("Protected ancestor"),
    });
  });
}

test("mixed phase skill states remain independent", async () => {
  const f = await fixture();
  for (const [index, target] of AUTOBUILD_SKILLS.entries()) {
    const source = await readFile(
      new URL(
        `./fixtures/autobuild-skills/${target.identity}.md`,
        import.meta.url,
      ),
      "utf8",
    );
    await f.write(
      target.path,
      index === 0
        ? source
        : autobuildSkillWriter(source, target).candidate.replace(
            "## Idiom",
            index === 1 ? "## Idiom" : "## Old Idiom",
          ),
    );
  }
  const report = await f.inspect();
  expect(
    AUTOBUILD_SKILLS.map(
      (target) => report.entries.find((e) => e.id === target.surface)?.status,
    ),
  ).toEqual(["missing", "wired", "stale"]);
});
