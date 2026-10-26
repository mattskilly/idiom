import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { critiquePrompt } from "./prompt.js";
import {
  MalformedCritiqueError,
  modelResponseJsonSchema,
  parseModelResponse,
} from "./schema.js";
import type {
  CritiqueAdapter,
  CritiqueInput,
  CritiqueResult,
} from "./types.js";
import { critiqueResult } from "./types.js";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export type ClaudeCodeRunRequest = {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  stdin: string;
};

export type ClaudeCodeRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type ClaudeCodeRunner = (
  request: ClaudeCodeRunRequest,
) => Promise<ClaudeCodeRunResult>;

export function sanitizeCritiqueDiagnostic(
  value: unknown,
  limit = 500,
): string {
  const source = value instanceof Error ? value.message : String(value);
  return source
    .replace(
      /sk-ant-[A-Za-z0-9._~+/-]+|(?:api[_ -]?key(?!\s+is\s+not\s+set\b)|access[_ -]?token|authorization|bearer)(?:[=: ]+)(?:bearer[ ]+)?[A-Za-z0-9._~+/-]+/gi,
      "[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, limit));
}

export class ClaudeCodeCritiqueError extends Error {
  readonly detail: string;

  constructor(detail: unknown) {
    const safeDetail =
      sanitizeCritiqueDiagnostic(detail) || "unknown Claude Code failure";
    super(
      `Claude Code CLI is unavailable or not authenticated; install or update Claude Code and run \`claude auth login\`: ${safeDetail}`,
    );
    this.name = "ClaudeCodeCritiqueError";
    this.detail = safeDetail;
  }
}

export const runClaudeCode: ClaudeCodeRunner = (request) =>
  new Promise((accept, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputFailure: Error | undefined;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const collect =
      (target: Buffer[], stream: "stdout" | "stderr") =>
      (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stream === "stdout") stdoutBytes += buffer.byteLength;
        else stderrBytes += buffer.byteLength;
        if (
          stdoutBytes > MAX_PROCESS_OUTPUT_BYTES ||
          stderrBytes > MAX_PROCESS_OUTPUT_BYTES
        ) {
          outputFailure = new Error(
            `Claude Code ${stream} exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes`,
          );
          child.kill("SIGKILL");
          return;
        }
        target.push(buffer);
      };

    child.once("error", fail);
    child.stdout.on("data", collect(stdout, "stdout"));
    child.stderr.on("data", collect(stderr, "stderr"));
    child.stdin.once("error", fail);
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (outputFailure !== undefined) {
        reject(outputFailure);
        return;
      }
      accept({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
      });
    });
    child.stdin.end(request.stdin);
  });

function pathManifest(input: CritiqueInput, projectDirectory: string) {
  return [
    ...input.screenshots.map((screenshot) => ({
      label: screenshot.label,
      kind: "captured-screenshot",
      state: screenshot.state,
      viewport: screenshot.viewport,
      path: resolve(projectDirectory, screenshot.readPath),
    })),
    ...input.references.flatMap((reference) =>
      reference.kind === "image"
        ? [
            {
              label: reference.label,
              kind: reference.polarity,
              path: resolve(projectDirectory, reference.readPath),
            },
          ]
        : [],
    ),
    ...(input.crops ?? []).map((crop) => ({
      label: crop.label,
      kind: "zoomed-crop",
      magnifies: crop.screenshot,
      state: crop.state,
      viewport: crop.viewport,
      path: resolve(projectDirectory, crop.readPath),
    })),
    ...(input.designImages ?? []).map((design) => ({
      label: design.label,
      kind: "intended-design-image",
      designFor: design.designFor,
      state: design.state,
      viewport: design.viewport,
      path: resolve(projectDirectory, design.readPath),
    })),
  ];
}

function completePrompt(
  input: CritiqueInput,
  projectDirectory: string,
): string {
  return [
    critiquePrompt(input, input.screenshots),
    "## Readable image path manifest",
    JSON.stringify(pathManifest(input, projectDirectory), null, 2),
    "Use the Read tool to inspect every path above. Cite captured screenshot labels exactly as written; paths are evidence transport only and must not appear as screenshot citations.",
  ].join("\n\n");
}

function structuredOutput(source: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(source.trim());
  } catch (error) {
    throw new ClaudeCodeCritiqueError(
      `Claude Code returned a malformed JSON envelope: ${sanitizeCritiqueDiagnostic(error)}`,
    );
  }
  if (envelope === null || typeof envelope !== "object")
    throw new ClaudeCodeCritiqueError(
      "Claude Code returned no result envelope",
    );
  const result = envelope as Record<string, unknown>;
  if (
    result.type !== "result" ||
    result.subtype !== "success" ||
    result.is_error === true
  )
    throw new ClaudeCodeCritiqueError(
      `Claude Code returned a non-success result${typeof result.subtype === "string" ? ` (${result.subtype})` : ""}`,
    );
  if (!("structured_output" in result))
    throw new ClaudeCodeCritiqueError(
      "Claude Code returned no structured_output; install a version that supports --json-schema",
    );
  return result.structured_output;
}

export class ClaudeCodeCritiqueAdapter implements CritiqueAdapter {
  readonly model: string;
  readonly projectDirectory: string;
  readonly runner: ClaudeCodeRunner;
  readonly environment: NodeJS.ProcessEnv;

  constructor(options: {
    model: string;
    projectDirectory: string;
    runner?: ClaudeCodeRunner | undefined;
    environment?: NodeJS.ProcessEnv | undefined;
  }) {
    this.model = options.model;
    this.projectDirectory = resolve(options.projectDirectory);
    this.runner = options.runner ?? runClaudeCode;
    this.environment = { ...(options.environment ?? process.env) };
    delete this.environment.ANTHROPIC_API_KEY;
  }

  private async invoke(stdin: string): Promise<unknown> {
    let result: ClaudeCodeRunResult;
    try {
      result = await this.runner({
        executable: "claude",
        args: [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(modelResponseJsonSchema),
          "--model",
          this.model,
          "--safe-mode",
          "--tools",
          "Read",
          "--permission-mode",
          "dontAsk",
          "--no-session-persistence",
          "--no-chrome",
        ],
        cwd: this.projectDirectory,
        environment: this.environment,
        stdin,
      });
    } catch (error) {
      throw new ClaudeCodeCritiqueError(error);
    }
    if (result.exitCode !== 0 || result.signal !== null) {
      const status =
        result.signal === null
          ? `exit ${String(result.exitCode)}`
          : `signal ${result.signal}`;
      throw new ClaudeCodeCritiqueError(
        `${status}${result.stderr.trim() === "" ? "" : `: ${result.stderr}`}`,
      );
    }
    return structuredOutput(result.stdout);
  }

  async critique(input: CritiqueInput): Promise<CritiqueResult> {
    if (input.screenshots.length === 0) return critiqueResult({ findings: [] });
    const prompt = completePrompt(input, this.projectDirectory);
    const first = await this.invoke(prompt);
    try {
      return parseModelResponse(
        JSON.stringify(first),
        input.screenshots,
        input.references,
        input.screenshots,
        input.designMd,
        input.spec !== undefined,
        input.page,
        input.designImages,
      );
    } catch (error) {
      if (!(error instanceof MalformedCritiqueError)) throw error;
      const repairPrompt = [
        prompt,
        "## Rejected structured output",
        JSON.stringify(first, null, 2),
        "## Local validation issues",
        error.issues.join("\n"),
        "Return a complete replacement batch that fixes every issue. Re-read the same evidence; do not return a patch or explanation.",
      ].join("\n\n");
      const repaired = await this.invoke(repairPrompt);
      return parseModelResponse(
        JSON.stringify(repaired),
        input.screenshots,
        input.references,
        input.screenshots,
        input.designMd,
        input.spec !== undefined,
        input.page,
        input.designImages,
      );
    }
  }
}
