import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error Dependency-free Node tooling is not compiled by TypeScript.
import * as guard from "../scripts/process-command-guard.mjs";

const { classifyPayload, guardInput, prohibitedCommand } = guard;

const script = resolve("scripts/process-command-guard.mjs");
const payload = (command: unknown) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});
const unsafe = [
  "pkill -f vitest",
  'pkill -f "bun run test"',
  "killall node",
  "bun run build && pkill -f vitest",
  "pkill vitest && echo done",
  "echo done; killall node",
  "pkill vitest; echo done",
  "echo done || pkill vitest",
  "killall node || echo done",
  "echo x | pkill vitest",
  "pkill vitest | cat",
  "echo x\nkillall node",
  "(pkill -f vitest)",
  "echo $(pkill vitest)",
  "/usr/bin/pkill vitest",
  "/usr/bin/killall node",
  "env pkill vitest",
  "command pkill vitest",
  "sudo killall node",
  "sh -c 'pkill -f vitest'",
  'bash -c "killall node"',
  "'pkill' vitest",
  '"/usr/bin/pkill" vitest',
  "pki\\\nll vitest",
  "kill\\\r\nall node",
  // Literal mentions intentionally receive conservative denials.
  "echo 'do not use pkill'",
  "rg killall docs",
];
const safe = [
  "kill 12345",
  "kill -TERM 12345",
  "bun run build",
  "bun run test",
  "node scripts/stop-my-tests.mjs",
  "node scripts/stop-my-tests.mjs --dry-run",
  "my_pkill_helper",
  "pkillable",
  "killall_helper",
  "my-killall-helper",
];

function assertDenied(output: string) {
  const result = JSON.parse(output);
  expect(result).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: expect.any(String),
    },
  });
  expect(result.hookSpecificOutput.permissionDecisionReason).toContain(
    "kill <pid>",
  );
  expect(result.hookSpecificOutput.permissionDecisionReason).toContain(
    "node scripts/stop-my-tests.mjs",
  );
}

describe("process command guard", () => {
  test.each(unsafe)("denies complete command text: %s", (command) => {
    expect(prohibitedCommand(command)).toBe(true);
    expect(
      classifyPayload(payload(command))?.hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });
  test.each(safe)("preserves normal permissions: %s", (command) => {
    expect(prohibitedCommand(command)).toBe(false);
    expect(classifyPayload(payload(command))).toBeUndefined();
  });
  test("ignores unrelated events and tools", () => {
    for (const input of [
      { ...payload("pkill vitest"), tool_name: "Read" },
      { ...payload("pkill vitest"), hook_event_name: "PostToolUse" },
      {},
      null,
    ])
      expect(classifyPayload(input)).toBeUndefined();
  });
  test.each([
    {},
    { command: null },
    { command: 123 },
    { command: "" },
    { command: "  " },
  ])("denies invalid Bash command %j", (tool_input) => {
    expect(
      classifyPayload({ ...payload(""), tool_input })?.hookSpecificOutput
        .permissionDecisionReason,
    ).toContain("Invalid Bash");
  });
  test("actual entrypoint emits valid denial JSON, exits zero and allows silently", () => {
    for (const input of [
      ...unsafe.map((command) => JSON.stringify(payload(command))),
      "not json",
      "",
      JSON.stringify({ ...payload(""), tool_input: {} }),
    ]) {
      const result = spawnSync(process.execPath, [script], {
        input,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      assertDenied(result.stdout);
    }
    for (const input of [
      ...safe.map((c) => payload(c)),
      { tool_name: "Read" },
    ]) {
      const result = spawnSync(process.execPath, [script], {
        input: JSON.stringify(input),
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(guardInput("{")?.hookSpecificOutput.permissionDecision).toBe("deny");
  });
  test.each([".claude/settings.json", ".codex/hooks.json"])(
    "%s wires a synchronous guard that works from nested paths with spaces",
    async (path) => {
      const config = JSON.parse(await readFile(resolve(path), "utf8"));
      const group = config.hooks.PreToolUse.find(
        (g: { matcher: string }) => g.matcher === "^Bash$",
      );
      expect(group).toBeDefined();
      expect(group.hooks).toHaveLength(1);
      const handler = group.hooks[0];
      expect(handler.type).toBe("command");
      expect(handler.async ?? false).toBe(false);
      expect(handler.timeout).toBe(5);
      const root = await mkdtemp(join(tmpdir(), "process guard checkout "));
      try {
        execFileSync("git", ["init", "--quiet", root]);
        await mkdir(join(root, "scripts"));
        const nested = join(root, "nested directory");
        await mkdir(nested);
        await writeFile(
          join(root, "scripts/process-command-guard.mjs"),
          await readFile(script),
        );
        for (const cwd of [root, nested]) {
          for (const [command, denied] of [
            ["pkill -f vitest", true],
            ["kill 12345", false],
          ] as const) {
            // The unsafe sample is stdin only, never evaluated as shell code.
            const result = spawnSync("/bin/sh", ["-c", handler.command], {
              cwd,
              input: JSON.stringify(payload(command)),
              encoding: "utf8",
              env: { ...process.env, CLAUDE_PROJECT_DIR: root },
            });
            expect(result.status, result.stderr).toBe(0);
            if (denied) assertDenied(result.stdout);
            else expect(result.stdout).toBe("");
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
