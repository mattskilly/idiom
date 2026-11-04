import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { type ProgramDependencies, run } from "../src/cli.js";
import {
  AGENT_SETUP_PRINT_LEAD,
  AGENT_SETUP_SKIPPED_LINE,
} from "../src/commands/init-agent.js";
import type { CritiqueProcessRunner } from "../src/critique/process.js";
import type { SetupAgentLauncher } from "../src/setup/agents.js";
import { SETUP_PROMPT_BEGIN, SETUP_PROMPT_END } from "../src/setup/prompt.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-init-agent-cli-"));
  directories.push(directory);
  return directory;
}

const usableProbe = vi.fn<CritiqueProcessRunner>(async (request) => ({
  stdout: `${request.executable} 1.0.0`,
  stderr: "",
  exitCode: 0,
  signal: null,
}));

async function init(
  args: string[],
  dependencies: Partial<ProgramDependencies> = {},
) {
  const project = await temporary();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const launch = vi.fn<SetupAgentLauncher>(async () => 0);
  const probe = vi.fn<CritiqueProcessRunner>(usableProbe);
  const code = await run(
    ["node", "idiom", "init", "--project", project, ...args],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      setupAgent: { probe, launch, environment: {} },
      ...dependencies,
    },
  );
  return {
    code,
    project,
    lines: stdout.join("").trimEnd().split("\n"),
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    launch,
    probe,
  };
}

test("--print-setup-prompt prints only the prompt and creates nothing", async () => {
  const result = await init(["--print-setup-prompt"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.startsWith("# Set up Idiom in this repository")).toBe(
    true,
  );
  expect(result.stdout).not.toContain("Initialized");
  expect(result.stdout).not.toContain(SETUP_PROMPT_BEGIN);
  expect(result.stdout).toContain("idiom init --validate");
  expect(await readdir(result.project)).toEqual([]);
  expect(result.probe).not.toHaveBeenCalled();
  expect(result.launch).not.toHaveBeenCalled();
});

test.each([
  [["--print-setup-prompt", "--yes"]],
  [["--print-setup-prompt", "--flows"]],
  [["--print-setup-prompt", "--surface", "web"]],
  [["--print-setup-prompt", "--agent", "codex"]],
  [["--print-setup-prompt", "--no-agent"]],
  [["--print-setup-prompt", "--flow", "home"]],
  [["--print-setup-prompt", "--json"]],
])("%j is rejected", async (args) => {
  const result = await init(args);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "--print-setup-prompt cannot be combined with other init options",
  );
  expect(await readdir(result.project)).toEqual([]);
});

test.each([
  [["--validate", "--agent", "codex"]],
  [["--validate", "--no-agent"]],
  [["--validate", "--print-setup-prompt"]],
])("%j is rejected", async (args) => {
  const result = await init(args);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "--validate cannot be combined with --yes, --flows, --surface, --agent, --no-agent or --print-setup-prompt",
  );
});

test("--agent accepts only claude-code or codex", async () => {
  const result = await init(["--agent", "bogus"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("claude-code");
  expect(result.stderr).toContain("codex");
  expect(await readdir(result.project)).toEqual([]);
  expect(result.launch).not.toHaveBeenCalled();
});

test("init --yes ends with the delimited prompt and never probes", async () => {
  const result = await init(["--yes"]);
  expect(result.code).toBe(0);
  const next = result.lines.indexOf("Next: idiom init --validate");
  expect(next).toBeGreaterThan(0);
  expect(result.lines[next + 1]).toBe(AGENT_SETUP_PRINT_LEAD);
  expect(result.lines[next + 2]).toBe(SETUP_PROMPT_BEGIN);
  expect(result.lines.at(-1)).toBe(SETUP_PROMPT_END);
  expect(result.probe).not.toHaveBeenCalled();
  expect(result.launch).not.toHaveBeenCalled();
});

test("init --yes --no-agent prints only the skip hint after the summary", async () => {
  const result = await init(["--yes", "--no-agent"]);
  expect(result.code).toBe(0);
  expect(result.lines.slice(-2)).toEqual([
    "Next: idiom init --validate",
    AGENT_SETUP_SKIPPED_LINE,
  ]);
  expect(result.probe).not.toHaveBeenCalled();
});

test("--agent claude-code with a usable probe launches the injected agent in the project", async () => {
  const result = await init(["--yes", "--agent", "claude-code"]);
  expect(result.code).toBe(0);
  expect(result.probe).toHaveBeenCalledTimes(1);
  expect(result.launch).toHaveBeenCalledTimes(1);
  const request = result.launch.mock.calls[0]?.[0];
  expect(request?.agent).toBe("claude-code");
  expect(request?.cwd).toBe(result.project);
  expect(request?.prompt).toContain("## Finish line");
  expect(result.stdout).not.toContain(SETUP_PROMPT_BEGIN);
});

test("--agent codex that is not usable prints the prompt, then exits 1", async () => {
  const result = await init(["--yes", "--agent", "codex"], {
    setupAgent: {
      environment: {},
      probe: async () => {
        throw Object.assign(new Error("spawn codex ENOENT"), {
          code: "ENOENT",
        });
      },
      launch: async () => {
        throw new Error("must not launch");
      },
    },
  });
  expect(result.code).toBe(1);
  expect(result.stdout).toContain(
    "Codex is not usable: codex not found on PATH",
  );
  expect(result.lines.at(-1)).toBe(SETUP_PROMPT_END);
  expect(result.stderr).toContain("--agent codex: codex not found on PATH");
  expect(await readdir(result.project)).toContain("PRODUCT.md");
});

test("an interactive init offers the first usable agent and launches on consent", async () => {
  const confirm = vi.fn(
    async (request: { kind: string }) => request.kind === "offer-agent-setup",
  );
  const result = await init([], { confirm });
  expect(result.code).toBe(0);
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "offer-agent-setup" }),
  );
  expect(result.launch.mock.calls[0]?.[0].agent).toBe("claude-code");
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.skipIf(process.platform === "win32")(
  "init --agent leaves no probe or agent process running once it resolves",
  async () => {
    const bin = await temporary();
    const pids = join(bin, "pids");
    // Records each invocation's pid; the "session" outlives a moment so a
    // non-awaited launch would still be running when init returns.
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\necho $$ >> "${pids}"\nif [ "$1" = "--version" ]; then echo '2.1.0 (Claude Code)'; exit 0; fi\n/bin/sleep 0.3\nexit 0\n`,
    );
    await chmod(join(bin, "claude"), 0o755);
    const result = await init(["--yes", "--agent", "claude-code"], {
      setupAgent: {
        environment: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Claude Code exited (0)");
    const started = (await readFile(pids, "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    expect(started).toHaveLength(2);
    expect(started.filter(alive)).toEqual([]);
  },
);
