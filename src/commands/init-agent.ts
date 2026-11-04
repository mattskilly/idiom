import type { CritiqueProcessRunner } from "../critique/process.js";
import {
  type AgentProbe,
  launchSetupAgent,
  probeSetupAgents,
  SETUP_AGENT_ENV,
  SETUP_AGENT_LABELS,
  type SetupAgent,
  type SetupAgentLauncher,
  setupAgentOrder,
} from "../setup/agents.js";
import { collectSetupFacts } from "../setup/facts.js";
import { delimitedSetupPrompt, setupPrompt } from "../setup/prompt.js";
import type { Confirmation } from "./init.js";

export type AgentSetupOutcome =
  /** --no-agent, or init running inside a launched setup agent. */
  | { kind: "skipped" }
  | { kind: "launched"; agent: SetupAgent; exitCode: number | null }
  | {
      kind: "printed";
      reason: "declined" | "none-usable" | "noninteractive";
      probes: AgentProbe[];
    }
  /** --agent named an agent whose CLI does not run here. */
  | { kind: "unavailable"; agent: SetupAgent; reason: string };

export const AGENT_SETUP_SKIPPED_LINE =
  "Agent-led setup skipped; idiom init --print-setup-prompt prints the setup prompt.";

export const AGENT_SETUP_PRINT_LEAD =
  "Recommended next step: paste this prompt into your coding agent (Claude Code, Codex or another), or run idiom init --agent claude-code|codex.";

/**
 * After scaffolding, hands the rest of setup to the user's coding agent:
 * launches it with consent (or with --agent), otherwise prints the prompt.
 */
export async function offerAgentSetup(options: {
  projectDirectory: string;
  /** --agent X, --no-agent (false), or neither (undefined). */
  agent: SetupAgent | false | undefined;
  yes: boolean;
  interactive: boolean;
  confirm: Confirmation;
  write: (line: string) => void;
  environment: NodeJS.ProcessEnv;
  probe?: CritiqueProcessRunner | undefined;
  launch?: SetupAgentLauncher | undefined;
}): Promise<AgentSetupOutcome> {
  const { projectDirectory, write, environment } = options;
  if (options.agent === false) {
    write(AGENT_SETUP_SKIPPED_LINE);
    return { kind: "skipped" };
  }
  if (options.agent === undefined && environment[SETUP_AGENT_ENV] === "1")
    return { kind: "skipped" };
  const printPrompt = async () => {
    const prompt = setupPrompt(await collectSetupFacts(projectDirectory));
    write(AGENT_SETUP_PRINT_LEAD);
    for (const line of delimitedSetupPrompt(prompt)) write(line);
  };
  const launch = async (agent: SetupAgent): Promise<AgentSetupOutcome> => {
    const prompt = setupPrompt(await collectSetupFacts(projectDirectory));
    const label = SETUP_AGENT_LABELS[agent];
    write(`Launching ${label} for setup…`);
    const exitCode = await (options.launch ?? launchSetupAgent)({
      agent,
      prompt,
      cwd: projectDirectory,
      environment,
    });
    write(
      `${label} exited (${exitCode ?? "no exit code"}). Confirm setup with: idiom init --validate`,
    );
    return { kind: "launched", agent, exitCode };
  };
  const probe = (order: readonly SetupAgent[]) =>
    probeSetupAgents({
      order,
      cwd: projectDirectory,
      environment,
      runner: options.probe,
    });

  if (options.agent !== undefined) {
    const [result] = await probe([options.agent]);
    if (result?.usable === true) return launch(options.agent);
    const reason = result?.reason ?? "not usable";
    write(`${SETUP_AGENT_LABELS[options.agent]} is not usable: ${reason}`);
    await printPrompt();
    return { kind: "unavailable", agent: options.agent, reason };
  }
  if (options.yes || !options.interactive) {
    await printPrompt();
    return { kind: "printed", reason: "noninteractive", probes: [] };
  }
  const probes = await probe(await setupAgentOrder(projectDirectory));
  const usable = probes.find((result) => result.usable);
  if (usable === undefined) {
    for (const result of probes)
      write(`${SETUP_AGENT_LABELS[result.agent]}: ${result.reason}`);
    await printPrompt();
    return { kind: "printed", reason: "none-usable", probes };
  }
  const accepted = await options.confirm({
    kind: "offer-agent-setup",
    path: ".idiom/project.json",
    prompt: `Hand the rest of setup to ${SETUP_AGENT_LABELS[usable.agent]} now? It will configure the server, seed data and a first flow, then run idiom init --validate. [y/N] `,
  });
  if (accepted) return launch(usable.agent);
  await printPrompt();
  return { kind: "printed", reason: "declined", probes };
}
