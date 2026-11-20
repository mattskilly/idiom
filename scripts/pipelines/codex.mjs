// Codex with the published skill and the documented `codex mcp add` line,
// each run verbatim, then a headless `codex exec` session.

import { join } from "node:path";
import { TASK_PROMPT } from "../check-pipelines-lib.mjs";
import { cachedPluginVersion, INSTALL_DOC, runAgentSetup } from "./agent.mjs";

export function run(context) {
  return runAgentSetup(context, {
    id: "codex",
    tool: "codex",
    keyVariables: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    signalsKind: "codex",
    reminderRequired: false,
    substitutions: [],
    async install({ context, home, step, docs, evidence }) {
      const drift = [];
      for (const [index, line] of docs.codex.lines.entries())
        await step(`install-${index + 1}`, line.split(" "), {
          cwd: home.root,
          doc: `${INSTALL_DOC} (${line})`,
        });
      if (docs.codex.urlVersion !== context.idiomVersion)
        drift.push({
          step: "install-3",
          doc: INSTALL_DOC,
          expected: `codex mcp add names the measured release v${context.idiomVersion}`,
          found: `the documented package URL names v${docs.codex.urlVersion}`,
        });
      const list = await step("mcp-list", ["codex", "mcp", "list"], {
        cwd: home.root,
        quiet: true,
      });
      evidence.mcpList = list.stdout.trim().slice(0, 800);
      evidence.mcpVersion = docs.codex.urlVersion;
      return {
        installedVersion: await cachedPluginVersion(
          join(home.env.CODEX_HOME, "plugins", "cache", "idiom", "idiom"),
        ),
        drift,
      };
    },
    async auth({ home, step }) {
      const status = await step("auth-status", ["codex", "login", "status"], {
        cwd: home.root,
        quiet: true,
        expect: () => true,
      });
      return {
        loggedIn: status.code === 0,
        detail: (status.stdout + status.stderr).trim().split("\n")[0] ?? "",
      };
    },
    session: ({ repo }) => [
      "codex",
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      repo,
      TASK_PROMPT,
    ],
  });
}
