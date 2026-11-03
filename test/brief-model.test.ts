import { writeFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import {
  createTriageInvoker,
  TRIAGE_MAX_TOKENS,
  TRIAGE_TIMEOUT_MS,
} from "../src/brief/model.js";
import type { CritiqueProcessRequest } from "../src/critique/process.js";
import { briefTriageJsonSchema } from "../src/schemas/brief.js";

const answer = {
  verdict: "design decision",
  reason: "adds a control",
  questions: ["how big is it?"],
};

function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0, signal: null };
}

test("triage is bounded to 90 seconds and 2,000 output tokens", () => {
  expect(TRIAGE_TIMEOUT_MS).toBe(90_000);
  expect(TRIAGE_MAX_TOKENS).toBe(2_000);
});

test("claude-code runs tool-free with the triage schema and the prompt on stdin", async () => {
  const runner = vi.fn(async (_request: CritiqueProcessRequest) =>
    ok(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: answer,
      }),
    ),
  );
  const invoke = createTriageInvoker({
    model: { provider: "claude-code", model: "claude-sonnet-5-5" },
    projectDirectory: "/project",
    environment: { ANTHROPIC_API_KEY: "sk-ant-secret", PATH: "/bin" },
    claudeCodeRunner: runner,
  });
  expect(await invoke("the prompt")).toEqual(answer);
  const request = runner.mock.calls[0]?.[0] as CritiqueProcessRequest;
  expect(request.executable).toBe("claude");
  expect(request.args).toEqual([
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(briefTriageJsonSchema),
    "--model",
    "claude-sonnet-5-5",
    "--safe-mode",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--no-chrome",
  ]);
  expect(request.stdin).toBe("the prompt");
  expect(request.environment.ANTHROPIC_API_KEY).toBeUndefined();
  expect(request.environment.PATH).toBe("/bin");
});

test("codex writes a strict schema, reads the final message and strips nulls", async () => {
  const runner = vi.fn(async (request: CritiqueProcessRequest) => {
    const message = request.args[request.args.indexOf("-o") + 1] as string;
    await writeFile(message, JSON.stringify({ ...answer, extra: null }));
    return ok("");
  });
  const invoke = createTriageInvoker({
    model: { provider: "codex", model: "gpt-5.5" },
    projectDirectory: "/project",
    environment: { ANTHROPIC_API_KEY: "sk-ant-secret" },
    codexRunner: runner,
  });
  expect(await invoke("the prompt")).toEqual(answer);
  const request = runner.mock.calls[0]?.[0] as CritiqueProcessRequest;
  expect(request.executable).toBe("codex");
  expect(request.args.slice(0, 2)).toEqual(["exec", "--skip-git-repo-check"]);
  expect(request.args).toContain("--output-schema");
  expect(request.args).toContain("-o");
  expect(request.args).not.toContain("--image");
  expect(request.stdin).toBe("the prompt");
  expect(request.environment.ANTHROPIC_API_KEY).toBeUndefined();
});

test("anthropic asks for json_schema output within the token budget", async () => {
  const create = vi.fn(async () => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(answer) }],
  }));
  const invoke = createTriageInvoker({
    model: { provider: "anthropic", model: "claude-sonnet-5-5" },
    projectDirectory: "/project",
    environment: { ANTHROPIC_API_KEY: "sk-ant-key" },
    createClient: () => ({ messages: { create } }),
  });
  expect(await invoke("the prompt")).toEqual(answer);
  const [request] = create.mock.calls[0] as unknown as [
    {
      max_tokens: number;
      output_config: { format: { type: string; schema: unknown } };
      messages: unknown;
    },
  ];
  expect(request.max_tokens).toBe(2_000);
  expect(request.output_config.format.type).toBe("json_schema");
  expect(request.output_config.format.schema).toBe(briefTriageJsonSchema);
  expect(request.messages).toEqual([{ role: "user", content: "the prompt" }]);
});

test("the configured fallback is used, visibly, after the primary fails", async () => {
  const onFallback = vi.fn();
  const create = vi.fn(async () => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(answer) }],
  }));
  const invoke = createTriageInvoker({
    model: {
      provider: "claude-code",
      model: "claude-sonnet-5-5",
      fallback: { provider: "anthropic", model: "claude-haiku-5-5" },
    },
    projectDirectory: "/project",
    environment: { ANTHROPIC_API_KEY: "sk-ant-key" },
    claudeCodeRunner: async () => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
      signal: null,
    }),
    createClient: () => ({ messages: { create } }),
    onFallback,
  });
  expect(await invoke("the prompt")).toEqual(answer);
  expect(onFallback).toHaveBeenCalledOnce();
  expect(onFallback.mock.calls[0]?.[0]).toMatchObject({
    from: "claude-code",
    to: "anthropic",
  });
  expect(onFallback.mock.calls[0]?.[0].reason).toMatch(/not authenticated/);
});

test("a provider that never answers is stopped at the deadline", async () => {
  let aborted = false;
  const invoke = createTriageInvoker({
    model: { provider: "claude-code", model: "claude-sonnet-5-5" },
    projectDirectory: "/project",
    environment: {},
    timeoutMs: 20,
    claudeCodeRunner: (request) =>
      new Promise((_, reject) =>
        request.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }),
      ),
  });
  await expect(invoke("the prompt")).rejects.toThrow(
    "triage did not finish within 20 ms",
  );
  expect(aborted).toBe(true);
});
