import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { requireAnthropicApiKey } from "../critique/anthropic.js";
import { runClaudeCode } from "../critique/claude-code.js";
import { codexOutputSchema, stripNulls } from "../critique/codex.js";
import {
  type CritiqueProcessRunner,
  formatCritiqueTimeout,
  runCritiqueProcess,
  sanitizeCritiqueDiagnostic,
} from "../critique/process.js";
import { subscriptionAuthEnvironment } from "../critique/subscription-environment.js";
import { IdiomError } from "../errors.js";
import { briefTriageJsonSchema } from "../schemas/brief.js";
import type { CritiqueProvider } from "../schemas/project.js";

/** Triage is one small text call: no tools, no capture, no repair round. */
export const TRIAGE_TIMEOUT_MS = 90_000;
export const TRIAGE_MAX_TOKENS = 2_000;
const STDERR_TAIL_LENGTH = 440;

export type TriageInvoker = (prompt: string) => Promise<unknown>;

export type TriageClient = {
  messages: {
    create(
      request: MessageCreateParamsNonStreaming,
      options: { signal: AbortSignal },
    ): Promise<unknown>;
  };
};

export type TriageModel = {
  provider: CritiqueProvider;
  model: string;
  fallback?: { provider: CritiqueProvider; model: string } | undefined;
};

export type TriageFallback = { from: string; to: string; reason: string };

export type TriageInvokerOptions = {
  model: TriageModel;
  projectDirectory: string;
  environment?: NodeJS.ProcessEnv | undefined;
  claudeCodeRunner?: CritiqueProcessRunner | undefined;
  codexRunner?: CritiqueProcessRunner | undefined;
  createClient?: ((apiKey: string) => TriageClient) | undefined;
  timeoutMs?: number | undefined;
  tempDirectory?: string | undefined;
  onFallback?: ((fallback: TriageFallback) => void) | undefined;
};

type Call = {
  provider: CritiqueProvider;
  model: string;
  prompt: string;
  signal: AbortSignal;
};

async function claudeCode(
  call: Call,
  options: TriageInvokerOptions,
): Promise<unknown> {
  const result = await (options.claudeCodeRunner ?? runClaudeCode)({
    executable: "claude",
    args: [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(briefTriageJsonSchema),
      "--model",
      call.model,
      "--safe-mode",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--no-chrome",
    ],
    cwd: options.projectDirectory,
    environment: subscriptionAuthEnvironment({
      ...(options.environment ?? process.env),
    }),
    stdin: call.prompt,
    signal: call.signal,
  });
  if (result.exitCode !== 0 || result.signal !== null)
    throw new Error(
      "Claude Code triage unavailable or not authenticated; run claude auth login",
    );
  const envelope = JSON.parse(result.stdout);
  if (
    envelope?.type !== "result" ||
    envelope.subtype !== "success" ||
    envelope.is_error === true ||
    !("structured_output" in envelope)
  )
    throw new Error("Claude Code returned no successful structured result");
  return envelope.structured_output;
}

async function anthropic(
  call: Call,
  options: TriageInvokerOptions,
): Promise<unknown> {
  const key = requireAnthropicApiKey({
    ...(options.environment ?? process.env),
  });
  const client =
    options.createClient?.(key) ??
    new Anthropic({ apiKey: key, maxRetries: 0 });
  const response = await client.messages.create(
    {
      model: call.model,
      max_tokens: TRIAGE_MAX_TOKENS,
      messages: [{ role: "user", content: call.prompt }],
      output_config: {
        format: { type: "json_schema", schema: briefTriageJsonSchema },
      },
    },
    { signal: call.signal },
  );
  if (!response || typeof response !== "object")
    throw new Error("Empty Anthropic response");
  const result = response as { stop_reason?: unknown; content?: unknown };
  if (result.stop_reason !== "end_turn" || !Array.isArray(result.content))
    throw new Error("Anthropic triage refused, truncated, or incomplete");
  const blocks = result.content as { type?: string; text?: string }[];
  if (blocks.some((block) => block.type !== "text"))
    throw new Error("Unexpected Anthropic triage content");
  return JSON.parse(blocks.map((block) => block.text ?? "").join(""));
}

async function codex(
  call: Call,
  options: TriageInvokerOptions,
): Promise<unknown> {
  const runner = options.codexRunner ?? runCritiqueProcess;
  const environment = { ...(options.environment ?? process.env) };
  delete environment.ANTHROPIC_API_KEY;
  const directory = await mkdtemp(
    join(options.tempDirectory ?? tmpdir(), "idiom-brief-"),
  );
  try {
    const schemaPath = join(directory, "schema.json");
    const messagePath = join(directory, "last-message.json");
    await writeFile(
      schemaPath,
      JSON.stringify(codexOutputSchema(briefTriageJsonSchema)),
    );
    const result = await runner({
      executable: "codex",
      args: [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "-C",
        options.projectDirectory,
        "--model",
        call.model,
        "--output-schema",
        schemaPath,
        "-o",
        messagePath,
      ],
      cwd: options.projectDirectory,
      environment,
      stdin: call.prompt,
      signal: call.signal,
      label: "Codex",
    });
    if (result.exitCode !== 0 || result.signal !== null) {
      const status =
        result.signal === null
          ? `exit ${String(result.exitCode)}`
          : `signal ${result.signal}`;
      const stderr = sanitizeCritiqueDiagnostic(
        result.stderr,
        Number.POSITIVE_INFINITY,
      ).slice(-STDERR_TAIL_LENGTH);
      throw new Error(
        `Codex CLI is unavailable or not authenticated; run \`codex login\`: ${status}${stderr === "" ? "" : `: ${stderr}`}`,
      );
    }
    let message: string;
    try {
      message = await readFile(messagePath, "utf8");
    } catch {
      message = "";
    }
    if (message.trim() === "")
      throw new Error("Codex returned no final message");
    return stripNulls(JSON.parse(message));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function callProvider(
  call: Call,
  options: TriageInvokerOptions,
): Promise<unknown> {
  if (call.provider === "claude-code") return claudeCode(call, options);
  if (call.provider === "anthropic") return anthropic(call, options);
  return codex(call, options);
}

/**
 * One bounded structured call to the configured review provider, with the
 * configured fallback tried once, visibly, when the primary fails. The whole
 * call — fallback included — shares one deadline.
 */
export function createTriageInvoker(
  options: TriageInvokerOptions,
): TriageInvoker {
  const timeoutMs = options.timeoutMs ?? TRIAGE_TIMEOUT_MS;
  return async (prompt) => {
    const controller = new AbortController();
    const timeoutMessage = `triage did not finish within ${formatCritiqueTimeout(timeoutMs)}`;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new IdiomError(timeoutMessage));
      }, timeoutMs);
    });
    const attempt = async (provider: CritiqueProvider, model: string) => {
      try {
        return await callProvider(
          { provider, model, prompt, signal: controller.signal },
          options,
        );
      } catch (error) {
        if (controller.signal.aborted) throw new IdiomError(timeoutMessage);
        throw new IdiomError(
          `triage via ${provider} failed: ${sanitizeCritiqueDiagnostic(error)}`,
        );
      }
    };
    const work = (async () => {
      const { model } = options;
      try {
        return await attempt(model.provider, model.model);
      } catch (error) {
        if (model.fallback === undefined || controller.signal.aborted)
          throw error;
        options.onFallback?.({
          from: model.provider,
          to: model.fallback.provider,
          reason: sanitizeCritiqueDiagnostic(
            error instanceof Error ? error.message : error,
          ),
        });
        return await attempt(model.fallback.provider, model.fallback.model);
      }
    })();
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      work.catch(() => undefined);
    }
  };
}
