import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { InitConfirmationRequest } from "../src/commands/init.js";
import {
  AGENT_SETUP_PRINT_LEAD,
  AGENT_SETUP_SKIPPED_LINE,
  offerAgentSetup,
} from "../src/commands/init-agent.js";
import type {
  CritiqueProcessRequest,
  CritiqueProcessRunner,
} from "../src/critique/process.js";
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
  const directory = await mkdtemp(join(tmpdir(), "idiom-init-agent-"));
  directories.push(directory);
  return directory;
}

/** A probe runner where only the named executables pass `--version`. */
function probeRunner(usable: string[]) {
  return vi.fn<CritiqueProcessRunner>(async (request) =>
    usable.includes(request.executable)
      ? {
          stdout: `${request.executable} 1.0.0`,
          stderr: "",
          exitCode: 0,
          signal: null,
        }
      : Promise.reject(
          Object.assign(new Error(`spawn ${request.executable} ENOENT`), {
            code: "ENOENT",
          }),
        ),
  );
}

async function offer(
  overrides: Partial<Parameters<typeof offerAgentSetup>[0]> & {
    usable?: string[];
    answer?: boolean;
  } = {},
) {
  const projectDirectory = overrides.projectDirectory ?? (await temporary());
  const lines: string[] = [];
  const probe = probeRunner(overrides.usable ?? []);
  const launch = vi.fn<SetupAgentLauncher>(async () => 0);
  const confirm = vi.fn(
    async (_request: InitConfirmationRequest) => overrides.answer ?? false,
  );
  const outcome = await offerAgentSetup({
    projectDirectory,
    agent: undefined,
    yes: false,
    interactive: true,
    confirm,
    write: (line) => lines.push(line),
    environment: {},
    probe,
    launch,
    ...overrides,
  });
  return { outcome, lines, probe, launch, confirm, projectDirectory };
}

function printedPrompt(lines: string[]): boolean {
  const begin = lines.indexOf(SETUP_PROMPT_BEGIN);
  return (
    begin > 0 &&
    lines[begin - 1] === AGENT_SETUP_PRINT_LEAD &&
    lines[begin + 1]?.startsWith("# Set up Idiom in this repository") ===
      true &&
    lines[begin + 2] === SETUP_PROMPT_END
  );
}

const executables = (probe: ReturnType<typeof probeRunner>) =>
  probe.mock.calls.map(
    ([request]: [CritiqueProcessRequest]) => request.executable,
  );

test("--no-agent never probes, asks or launches, and prints one hint line", async () => {
  const run = await offer({ agent: false, usable: ["claude", "codex"] });
  expect(run.outcome).toEqual({ kind: "skipped" });
  expect(run.lines).toEqual([AGENT_SETUP_SKIPPED_LINE]);
  expect(run.probe).not.toHaveBeenCalled();
  expect(run.confirm).not.toHaveBeenCalled();
  expect(run.launch).not.toHaveBeenCalled();
});

test("inside a launched setup agent, init does not offer again", async () => {
  const run = await offer({
    environment: { IDIOM_SETUP_AGENT: "1" },
    usable: ["claude"],
  });
  expect(run.outcome).toEqual({ kind: "skipped" });
  expect(run.lines).toEqual([]);
  expect(run.probe).not.toHaveBeenCalled();
  expect(run.launch).not.toHaveBeenCalled();
});

test.each([
  { yes: false, interactive: true },
  { yes: true, interactive: false },
])(
  "--agent codex, usable, launches without asking (yes: $yes)",
  async ({ yes, interactive }) => {
    const run = await offer({
      agent: "codex",
      yes,
      interactive,
      usable: ["codex"],
      environment: { PATH: "/bin" },
    });
    expect(run.outcome).toEqual({
      kind: "launched",
      agent: "codex",
      exitCode: 0,
    });
    expect(executables(run.probe)).toEqual(["codex"]);
    expect(run.confirm).not.toHaveBeenCalled();
    expect(run.launch).toHaveBeenCalledTimes(1);
    const request = run.launch.mock.calls[0]?.[0];
    expect(request?.agent).toBe("codex");
    expect(request?.cwd).toBe(run.projectDirectory);
    expect(request?.environment).toEqual({ PATH: "/bin" });
    expect(request?.prompt.startsWith("# Set up Idiom")).toBe(true);
    expect(run.lines.at(-1)).toBe(
      "Codex exited (0). Confirm setup with: idiom init --validate",
    );
    expect(printedPrompt(run.lines)).toBe(false);
  },
);

test("--agent codex, not usable, prints the reason and the delimited prompt", async () => {
  const run = await offer({ agent: "codex", usable: ["claude"] });
  expect(run.outcome).toEqual({
    kind: "unavailable",
    agent: "codex",
    reason: "codex not found on PATH",
  });
  expect(run.lines[0]).toBe("Codex is not usable: codex not found on PATH");
  expect(printedPrompt(run.lines)).toBe(true);
  expect(executables(run.probe)).toEqual(["codex"]);
  expect(run.launch).not.toHaveBeenCalled();
});

test("interactive, usable, consent given: launches the first usable agent with the prompt", async () => {
  const run = await offer({ usable: ["claude", "codex"], answer: true });
  expect(run.outcome).toEqual({
    kind: "launched",
    agent: "claude-code",
    exitCode: 0,
  });
  expect(run.confirm).toHaveBeenCalledTimes(1);
  const request = run.confirm.mock.calls[0]?.[0];
  expect(request).toEqual({
    kind: "offer-agent-setup",
    path: ".idiom/project.json",
    prompt:
      "Hand the rest of setup to Claude Code now? It will configure the server, seed data and a first flow, then run idiom init --validate. [y/N] ",
  });
  expect(run.launch.mock.calls[0]?.[0]).toMatchObject({
    agent: "claude-code",
    cwd: run.projectDirectory,
  });
  expect(printedPrompt(run.lines)).toBe(false);
});

test("interactive, consent declined: prints the prompt", async () => {
  const run = await offer({ usable: ["codex"], answer: false });
  expect(run.outcome).toMatchObject({ kind: "printed", reason: "declined" });
  expect(run.confirm.mock.calls[0]?.[0].prompt).toContain("to Codex now?");
  expect(run.launch).not.toHaveBeenCalled();
  expect(printedPrompt(run.lines)).toBe(true);
});

test("interactive, none usable: one reason line per probe, then the prompt", async () => {
  const run = await offer({ usable: [] });
  expect(run.outcome).toMatchObject({
    kind: "printed",
    reason: "none-usable",
  });
  expect(run.lines.slice(0, 2)).toEqual([
    "Claude Code: claude not found on PATH",
    "Codex: codex not found on PATH",
  ]);
  expect(run.confirm).not.toHaveBeenCalled();
  expect(run.launch).not.toHaveBeenCalled();
  expect(printedPrompt(run.lines)).toBe(true);
});

test.each([
  { yes: true, interactive: true },
  { yes: false, interactive: false },
])(
  "without --agent, --yes or a non-interactive run never probes or launches (yes: $yes)",
  async ({ yes, interactive }) => {
    const run = await offer({ yes, interactive, usable: ["claude", "codex"] });
    expect(run.outcome).toEqual({
      kind: "printed",
      reason: "noninteractive",
      probes: [],
    });
    expect(run.probe).not.toHaveBeenCalled();
    expect(run.confirm).not.toHaveBeenCalled();
    expect(run.launch).not.toHaveBeenCalled();
    expect(printedPrompt(run.lines)).toBe(true);
  },
);

test("preference: Claude Code first by default, Codex first when it is the configured provider", async () => {
  const byDefault = await offer({ usable: ["claude", "codex"], answer: true });
  expect(executables(byDefault.probe)).toEqual(["claude", "codex"]);
  expect(byDefault.outcome).toMatchObject({ agent: "claude-code" });

  const projectDirectory = await temporary();
  await mkdir(join(projectDirectory, ".idiom"));
  await writeFile(
    join(projectDirectory, ".idiom", "project.json"),
    JSON.stringify({ model: { provider: "codex", model: "x" } }),
  );
  const configured = await offer({
    projectDirectory,
    usable: ["claude", "codex"],
    answer: true,
  });
  expect(executables(configured.probe)).toEqual(["codex", "claude"]);
  expect(configured.outcome).toMatchObject({ agent: "codex" });
});
