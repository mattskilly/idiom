import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_PROVIDER_EXECUTABLES,
  type CliCritiqueProvider,
} from "../critique/executables.js";
import {
  type CritiqueProcessRunner,
  runCritiqueProcess,
  sanitizeCritiqueDiagnostic,
} from "../critique/process.js";

/** A coding agent `idiom init` can hand setup to: a CLI critique provider. */
export type SetupAgent = CliCritiqueProvider;

export const SETUP_AGENTS: readonly SetupAgent[] = ["claude-code", "codex"];

export const SETUP_AGENT_LABELS: Record<SetupAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** Set in a launched setup agent's environment so a nested init never re-offers. */
export const SETUP_AGENT_ENV = "IDIOM_SETUP_AGENT";

export type AgentProbe = { agent: SetupAgent; usable: boolean; reason: string };

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

function firstLine(value: string): string {
  return sanitizeCritiqueDiagnostic(value.trim().split("\n")[0] ?? "", 200);
}

async function probeOne(
  agent: SetupAgent,
  options: {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    runner: CritiqueProcessRunner;
    timeoutMs: number;
  },
): Promise<AgentProbe> {
  const executable = CLI_PROVIDER_EXECUTABLES[agent];
  try {
    const result = await options.runner({
      executable,
      args: ["--version"],
      cwd: options.cwd,
      environment: options.environment,
      stdin: "",
      label: SETUP_AGENT_LABELS[agent],
      timeoutMs: options.timeoutMs,
    });
    if (result.exitCode === 0)
      return {
        agent,
        usable: true,
        reason: firstLine(result.stdout) || `${executable} --version passed`,
      };
    const detail = firstLine(result.stderr) || firstLine(result.stdout);
    return {
      agent,
      usable: false,
      reason: `${executable} --version exited ${result.exitCode ?? result.signal}${detail === "" ? "" : `: ${detail}`}`,
    };
  } catch (error) {
    return {
      agent,
      usable: false,
      reason:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `${executable} not found on PATH`
          : sanitizeCritiqueDiagnostic(error, 200),
    };
  }
}

/** Whether each agent's CLI runs here, through critique's process transport. */
export async function probeSetupAgents(options: {
  order: readonly SetupAgent[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  runner?: CritiqueProcessRunner | undefined;
  timeoutMs?: number | undefined;
}): Promise<AgentProbe[]> {
  const settings = {
    cwd: options.cwd,
    environment: options.environment,
    runner: options.runner ?? runCritiqueProcess,
    timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  };
  return Promise.all(options.order.map((agent) => probeOne(agent, settings)));
}

function isSetupAgent(value: unknown): value is SetupAgent {
  return SETUP_AGENTS.includes(value as SetupAgent);
}

/** Agents in preference order: the project's configured critique provider first. */
export async function setupAgentOrder(
  projectDirectory: string,
): Promise<SetupAgent[]> {
  let preferred: SetupAgent | undefined;
  try {
    const project = JSON.parse(
      await readFile(join(projectDirectory, ".idiom", "project.json"), "utf8"),
    ) as {
      model?: { provider?: unknown; fallback?: { provider?: unknown } };
    };
    const provider = project.model?.provider;
    const fallback = project.model?.fallback?.provider;
    preferred = isSetupAgent(provider)
      ? provider
      : isSetupAgent(fallback)
        ? fallback
        : undefined;
  } catch {
    preferred = undefined;
  }
  return preferred === undefined
    ? [...SETUP_AGENTS]
    : [preferred, ...SETUP_AGENTS.filter((agent) => agent !== preferred)];
}

export type SetupAgentLauncher = (request: {
  agent: SetupAgent;
  prompt: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}) => Promise<number | null>;

/**
 * Starts the agent's interactive session with the prompt as its first
 * message (`claude "<prompt>"`, `codex "<prompt>"`), attached to this terminal.
 */
export const launchSetupAgent: SetupAgentLauncher = (request) =>
  new Promise((accept) => {
    const child = spawn(
      CLI_PROVIDER_EXECUTABLES[request.agent],
      [request.prompt],
      {
        cwd: request.cwd,
        env: { ...request.environment, [SETUP_AGENT_ENV]: "1" },
        stdio: "inherit",
        shell: false,
      },
    );
    child.once("error", () => accept(null));
    child.once("exit", (code) => accept(code));
  });
