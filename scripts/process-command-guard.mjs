#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const alternative =
  "Stop only processes you started, by PID (kill <pid>), or use node scripts/stop-my-tests.mjs for verified local Vitest cleanup.";

export function prohibitedCommand(command) {
  // Deliberately conservative, including literal mentions. This is a habit
  // guard, not a parser or a sandbox for arbitrary shell expansion.
  return /(?:^|[^\w-])(?:pkill|killall)(?=$|[^\w-])/.test(
    command.replace(/\\\r?\n/g, ""),
  );
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${reason} ${alternative}`,
    },
  };
}

export function classifyPayload(payload) {
  if (
    payload?.hook_event_name !== "PreToolUse" ||
    payload?.tool_name !== "Bash"
  )
    return undefined;
  const command = payload.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "")
    return deny("Invalid Bash hook input: expected a nonempty command string.");
  if (prohibitedCommand(command))
    return deny(
      "Name/pattern process cleanup is forbidden: it can kill another worktree's tests on this shared host.",
    );
  // Silence preserves the provider's normal permission evaluation.
  return undefined;
}

export function guardInput(input) {
  try {
    return classifyPayload(JSON.parse(input));
  } catch {
    return deny("Invalid hook input: expected JSON.");
  }
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(await realpath(process.argv[1]).catch(() => "")).href
) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const response = guardInput(input);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}
