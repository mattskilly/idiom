import type { CritiqueProvider } from "../schemas/project.js";

/** The critique providers that run a local agent CLI rather than an API. */
export type CliCritiqueProvider = Exclude<CritiqueProvider, "anthropic">;

/** The executable each CLI provider spawns; critique and setup share it. */
export const CLI_PROVIDER_EXECUTABLES: Record<CliCritiqueProvider, string> = {
  "claude-code": "claude",
  codex: "codex",
};
