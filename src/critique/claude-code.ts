import { resolve } from "node:path";
import {
  type CritiqueProcessRequest,
  type CritiqueProcessResult,
  type CritiqueProcessRunner,
  runCritiqueProcess,
  sanitizeCritiqueDiagnostic,
} from "./process.js";
import { critiquePrompt } from "./prompt.js";
import { modelResponseJsonSchema } from "./schema.js";
import { critiqueWithRepair } from "./structured.js";
import type {
  CritiqueAdapter,
  CritiqueInput,
  CritiqueResult,
} from "./types.js";
import { critiqueResult } from "./types.js";

export type ClaudeCodeRunRequest = CritiqueProcessRequest;
export type ClaudeCodeRunResult = CritiqueProcessResult;
export type ClaudeCodeRunner = CritiqueProcessRunner;
export { sanitizeCritiqueDiagnostic };

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

export const runClaudeCode: ClaudeCodeRunner = runCritiqueProcess;

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
    return critiqueWithRepair({
      input,
      prompt: completePrompt(input, this.projectDirectory),
      invoke: (prompt) => this.invoke(prompt),
    });
  }
}
