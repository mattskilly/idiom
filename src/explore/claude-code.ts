import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type ClaudeCodeRunner,
  type ClaudeCodeRunResult,
  runClaudeCode,
  sanitizeCritiqueDiagnostic,
} from "../critique/claude-code.js";
import { IdiomError } from "../errors.js";
import {
  parseCandidatesWithRepair,
  parseRefinementWithRepair,
} from "./output.js";
import { candidatePrompt, refinementPrompt } from "./prompt.js";
import {
  explorationCandidatesJsonSchema,
  explorationRefinementJsonSchema,
} from "./schema.js";
import type {
  CandidateRequest,
  ExplorationAdapter,
  RefinementRequest,
} from "./types.js";

function structuredOutput(source: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(source.trim());
  } catch (error) {
    throw new IdiomError(
      `Claude Code returned malformed JSON: ${sanitizeCritiqueDiagnostic(error)}`,
    );
  }
  if (envelope === null || typeof envelope !== "object")
    throw new IdiomError("Claude Code returned no result envelope");
  const result = envelope as Record<string, unknown>;
  if (
    result.type !== "result" ||
    result.subtype !== "success" ||
    result.is_error === true
  )
    throw new IdiomError(
      "Claude Code returned a non-success exploration result",
    );
  if (!("structured_output" in result))
    throw new IdiomError(
      "Claude Code returned no structured_output; install a version supporting --json-schema",
    );
  return result.structured_output;
}

async function canonicalReadablePaths(
  root: string,
  paths: string[],
): Promise<string[]> {
  const realRoot = await realpath(root);
  const output: string[] = [];
  for (const item of paths) {
    const realEntry = await realpath(resolve(item));
    const escaped = relative(realRoot, realEntry);
    if (
      escaped === "" ||
      isAbsolute(escaped) ||
      escaped === ".." ||
      escaped.startsWith(`..${sep}`)
    )
      throw new IdiomError(
        `exploration readable path escapes the source mirror: ${item}`,
      );
    output.push(realEntry);
  }
  return output;
}

export class ClaudeCodeExplorationAdapter implements ExplorationAdapter {
  readonly model: string;
  readonly runner: ClaudeCodeRunner;
  readonly environment: NodeJS.ProcessEnv;

  constructor(options: {
    model: string;
    runner?: ClaudeCodeRunner | undefined;
    environment?: NodeJS.ProcessEnv | undefined;
  }) {
    this.model = options.model;
    this.runner = options.runner ?? runClaudeCode;
    this.environment = { ...(options.environment ?? process.env) };
    delete this.environment.ANTHROPIC_API_KEY;
  }

  private async invoke(options: {
    cwd: string;
    stdin: string;
    schema: unknown;
    tools: string;
  }): Promise<unknown> {
    let result: ClaudeCodeRunResult;
    try {
      result = await this.runner({
        executable: "claude",
        args: [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(options.schema),
          "--model",
          this.model,
          "--safe-mode",
          "--tools",
          options.tools,
          "--permission-mode",
          "dontAsk",
          "--no-session-persistence",
          "--no-chrome",
        ],
        cwd: options.cwd,
        environment: this.environment,
        stdin: options.stdin,
      });
    } catch (error) {
      throw new IdiomError(
        `exploration requires an available authenticated Claude Code CLI; install or update Claude Code and run \`claude auth login\`: ${sanitizeCritiqueDiagnostic(error)}`,
      );
    }
    if (result.exitCode !== 0 || result.signal !== null)
      throw new IdiomError(
        `exploration provider failed (${result.signal ?? `exit ${String(result.exitCode)}`}): ${sanitizeCritiqueDiagnostic(result.stderr)}`,
      );
    return structuredOutput(result.stdout);
  }

  async preflight(): Promise<void> {
    await this.invoke({
      cwd: tmpdir(),
      stdin: 'Return {"available":true} if you can answer this request.',
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["available"],
        properties: { available: { const: true } },
      },
      tools: "",
    });
  }

  async proposeCandidates(input: CandidateRequest) {
    const permittedReferenceLabels = input.context.references.map(
      (reference) => reference.label,
    );
    const schema = explorationCandidatesJsonSchema(permittedReferenceLabels);
    const readablePaths = await canonicalReadablePaths(
      input.evidence.mirrorRoot,
      input.evidence.readablePaths,
    );
    const prompt = candidatePrompt({
      ...input,
      evidence: { ...input.evidence, readablePaths },
    });
    const value = await this.invoke({
      cwd: await realpath(input.evidence.mirrorRoot),
      stdin: prompt,
      schema,
      tools: "Read,Glob,Grep",
    });
    return parseCandidatesWithRepair({
      evidence: input.evidence,
      initial: value,
      permittedReferenceLabels,
      repair: async (issues) =>
        this.invoke({
          cwd: await realpath(input.evidence.mirrorRoot),
          stdin: `${prompt}\n\nRejected structured output:\n${JSON.stringify(value)}\n\nValidation issues:\n${issues.join("\n")}\nReturn a complete replacement batch.`,
          schema,
          tools: "Read,Glob,Grep",
        }),
    });
  }

  async refineCandidate(input: RefinementRequest) {
    const permittedReferenceLabels = input.context.references.map(
      (reference) => reference.label,
    );
    const schema = explorationRefinementJsonSchema(permittedReferenceLabels);
    const readablePaths = await canonicalReadablePaths(
      input.evidence.mirrorRoot,
      input.evidence.readablePaths,
    );
    const prompt = refinementPrompt({
      ...input,
      evidence: { ...input.evidence, readablePaths },
    });
    const value = await this.invoke({
      cwd: await realpath(input.evidence.mirrorRoot),
      stdin: prompt,
      schema,
      tools: "Read,Glob,Grep",
    });
    return parseRefinementWithRepair({
      evidence: input.evidence,
      initial: value,
      permittedReferenceLabels,
      repair: async (issues) =>
        this.invoke({
          cwd: await realpath(input.evidence.mirrorRoot),
          stdin: `${prompt}\n\nRejected structured output:\n${JSON.stringify(value)}\n\nValidation issues:\n${issues.join("\n")}\nReturn a complete replacement refinement.`,
          schema,
          tools: "Read,Glob,Grep",
        }),
    });
  }
}
