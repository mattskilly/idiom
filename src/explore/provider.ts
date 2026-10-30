import type { ClaudeCodeRunner } from "../critique/claude-code.js";
import { IdiomError } from "../errors.js";
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
  const provider = options.model.provider;
  switch (provider) {
    case "claude-code":
      return new ClaudeCodeExplorationAdapter({
        model: options.model.model,
        environment: options.environment,
        runner: options.claudeCodeRunner,
      });
    case "anthropic":
      return new AnthropicExplorationAdapter({
        model: options.model.model,
        environment: options.environment,
        client: options.anthropicClient,
      });
    case "codex":
      throw new IdiomError(
        'idiom explore supports model.provider "claude-code" or "anthropic"; Codex exploration is not available yet',
      );
    default: {
      const unknown: never = provider;
      throw new IdiomError(`unknown model.provider ${JSON.stringify(unknown)}`);
    }
  }
}
