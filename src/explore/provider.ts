import type { ClaudeCodeRunner } from "../critique/claude-code.js";
import type { Project } from "../schemas/project.js";
import {
  AnthropicExplorationAdapter,
  type AnthropicExplorationClient,
} from "./anthropic.js";
import { ClaudeCodeExplorationAdapter } from "./claude-code.js";
import type { ExplorationAdapter } from "./types.js";

export function createExplorationAdapter(options: {
  model: Project["model"];
  environment?: NodeJS.ProcessEnv | undefined;
  claudeCodeRunner?: ClaudeCodeRunner | undefined;
  anthropicClient?: AnthropicExplorationClient | undefined;
}): ExplorationAdapter {
  return options.model.provider === "claude-code"
    ? new ClaudeCodeExplorationAdapter({
        model: options.model.model,
        environment: options.environment,
        runner: options.claudeCodeRunner,
      })
    : new AnthropicExplorationAdapter({
        model: options.model.model,
        environment: options.environment,
        client: options.anthropicClient,
      });
}
