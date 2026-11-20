// Claude Code with only the published plugin: the documented slash commands
// run as their `claude plugin` shell equivalents, then a headless session.

import { join } from "node:path";
import {
  claudeShellEquivalents,
  TASK_PROMPT,
} from "../check-pipelines-lib.mjs";
import { cachedPluginVersion, INSTALL_DOC, runAgentSetup } from "./agent.mjs";

export function run(context) {
  return runAgentSetup(context, {
    id: "claude-code",
    tool: "claude",
    keyVariables: ["ANTHROPIC_API_KEY"],
    signalsKind: "claude-code",
    reminderRequired: true,
    substitutions: [
      "the documented /plugin slash commands run as their `claude plugin` shell equivalents (no interactive session)",
    ],
    async install({ home, step, docs, evidence }) {
      const argvs = claudeShellEquivalents(docs.claude.lines);
      for (const [index, argv] of argvs.entries())
        await step(`install-${index + 1}`, argv, {
          cwd: home.root,
          doc: `${INSTALL_DOC} (${docs.claude.lines[index]})`,
        });
      const list = await step("plugin-list", ["claude", "plugin", "list"], {
        cwd: home.root,
        quiet: true,
      });
      evidence.pluginList = list.stdout.trim().slice(0, 800);
      return {
        installedVersion: await cachedPluginVersion(
          join(
            home.env.CLAUDE_CONFIG_DIR,
            "plugins",
            "cache",
            "idiom",
            "idiom",
          ),
        ),
      };
    },
    async auth({ home, step }) {
      const status = await step("auth-status", ["claude", "auth", "status"], {
        cwd: home.root,
        quiet: true,
        expect: () => true,
      });
      try {
        const parsed = JSON.parse(status.stdout);
        return {
          loggedIn: parsed.loggedIn === true,
          detail: `authMethod ${parsed.authMethod ?? "unknown"}`,
        };
      } catch {
        return { loggedIn: status.code === 0, detail: `exit ${status.code}` };
      }
    },
    session: () => [
      "claude",
      "-p",
      TASK_PROMPT,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-hook-events",
      "--permission-mode",
      "bypassPermissions",
    ],
  });
}
