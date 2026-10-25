import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { requireAnthropicApiKey } from "../critique/anthropic.js";
import { sanitizeCritiqueDiagnostic } from "../critique/claude-code.js";
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

export type AnthropicExplorationClient = {
  messages: { create(request: Record<string, unknown>): Promise<unknown> };
};

const MAX_TURNS = 12;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_IMAGES = 20;
const MAX_ENCODED_IMAGE_BYTES = 20 * 1024 * 1024;

function blocks(response: unknown): Array<Record<string, unknown>> {
  if (response === null || typeof response !== "object") return [];
  const content = (response as { content?: unknown }).content;
  return Array.isArray(content)
    ? content.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object",
      )
    : [];
}

function jsonOutput(response: unknown): unknown {
  const content = blocks(response);
  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  if (text.trim() === "")
    throw new IdiomError("Anthropic returned no structured exploration output");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new IdiomError(
      `Anthropic returned malformed exploration JSON: ${sanitizeCritiqueDiagnostic(error)}`,
    );
  }
}

async function contained(root: string, requested: string): Promise<string> {
  if (
    isAbsolute(requested) ||
    requested.includes("\\") ||
    requested.split("/").includes("..")
  )
    throw new IdiomError("provider requested an unsafe source path");
  const realRoot = await realpath(root);
  const target = await realpath(resolve(realRoot, requested));
  const escaped = relative(realRoot, target);
  if (
    escaped === "" ||
    isAbsolute(escaped) ||
    escaped === ".." ||
    escaped.startsWith(`..${sep}`)
  )
    throw new IdiomError(
      "provider requested a source path outside the exploration mirror",
    );
  return target;
}

async function mirrorManifest(
  root: string,
  paths: string[],
): Promise<{ absolute: string[]; relative: string[] }> {
  const realRoot = await realpath(root);
  const absolute: string[] = [];
  const relativePaths: string[] = [];
  for (const path of paths) {
    const realEntry = await realpath(resolve(path));
    const escaped = relative(realRoot, realEntry);
    if (
      escaped === "" ||
      isAbsolute(escaped) ||
      escaped === ".." ||
      escaped.startsWith(`..${sep}`)
    )
      throw new IdiomError(
        `exploration readable path escapes the source mirror: ${path}`,
      );
    absolute.push(realEntry);
    relativePaths.push(escaped.split(sep).join("/"));
  }
  return { absolute, relative: relativePaths };
}

export class AnthropicExplorationAdapter implements ExplorationAdapter {
  readonly model: string;
  readonly client: AnthropicExplorationClient;

  constructor(options: {
    model: string;
    environment?: NodeJS.ProcessEnv | undefined;
    client?: AnthropicExplorationClient | undefined;
  }) {
    this.model = options.model;
    const apiKey = requireAnthropicApiKey(options.environment ?? process.env);
    this.client =
      options.client ??
      (new Anthropic({ apiKey }) as unknown as AnthropicExplorationClient);
  }

  async preflight(): Promise<void> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 64,
        messages: [{ role: "user", content: "Return available=true." }],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["available"],
              properties: { available: { const: true } },
            },
          },
        },
      });
    } catch (error) {
      throw new IdiomError(
        `exploration requires Anthropic model access for ${JSON.stringify(this.model)}: ${sanitizeCritiqueDiagnostic(error)}`,
      );
    }
  }

  private async invoke(options: {
    root: string;
    prompt: string;
    schema: unknown;
    readablePaths: string[];
  }): Promise<unknown> {
    const tools = [
      {
        name: "read_file",
        description: "Read one UTF-8 file from the exploration source mirror.",
        strict: true,
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string" } },
        },
      },
      {
        name: "search_files",
        description: "Search mirror text files for a literal string.",
        strict: true,
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["query", "paths"],
          properties: {
            query: { type: "string" },
            // Keep the wire schema within Anthropic's supported strict subset;
            // the handler below owns the at-most-20 operational bound.
            paths: { type: "array", items: { type: "string" } },
          },
        },
      },
    ];
    const imagePaths = options.readablePaths.filter(
      (path) =>
        path.includes(`${sep}.idiom-explore-evidence${sep}`) &&
        /\.(?:png|jpe?g|webp|gif)$/i.test(path),
    );
    if (imagePaths.length > MAX_IMAGES)
      throw new IdiomError(
        `exploration image count exceeds the provider limit of ${MAX_IMAGES}`,
      );
    let encodedBytes = 0;
    const imageBlocks: Array<Record<string, unknown>> = [];
    for (const path of imagePaths) {
      const source = await readFile(path);
      const data = source.toString("base64");
      encodedBytes += Buffer.byteLength(data);
      if (encodedBytes > MAX_ENCODED_IMAGE_BYTES)
        throw new IdiomError(
          "exploration images exceed the direct-provider request budget",
        );
      const extension = path.toLowerCase().split(".").at(-1);
      const mediaType =
        extension === "png"
          ? "image/png"
          : extension === "webp"
            ? "image/webp"
            : extension === "gif"
              ? "image/gif"
              : "image/jpeg";
      imageBlocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      });
    }
    const messages: Array<Record<string, unknown>> = [
      {
        role: "user",
        content: [{ type: "text", text: options.prompt }, ...imageBlocks],
      },
    ];
    let totalBytes = 0;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      let response: unknown;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: 16_000,
          messages,
          tools,
          output_config: {
            format: { type: "json_schema", schema: options.schema },
          },
        });
      } catch (error) {
        throw new IdiomError(
          `Anthropic exploration failed: ${sanitizeCritiqueDiagnostic(error)}`,
        );
      }
      const content = blocks(response);
      const uses = content.filter((block) => block.type === "tool_use");
      if (uses.length === 0) return jsonOutput(response);
      messages.push({ role: "assistant", content });
      const results: Array<Record<string, unknown>> = [];
      for (const use of uses) {
        const input = use.input as Record<string, unknown> | undefined;
        let result: string;
        try {
          if (use.name === "read_file" && typeof input?.path === "string") {
            const source = await readFile(
              await contained(options.root, input.path),
            );
            if (source.byteLength > MAX_FILE_BYTES)
              throw new IdiomError(
                "requested file exceeds the exploration read limit",
              );
            totalBytes += source.byteLength;
            result = source.toString("utf8");
          } else if (
            use.name === "search_files" &&
            typeof input?.query === "string" &&
            Array.isArray(input.paths)
          ) {
            const matches: string[] = [];
            for (const item of input.paths.slice(0, 20)) {
              if (typeof item !== "string") continue;
              const source = await readFile(
                await contained(options.root, item),
              );
              if (source.byteLength > MAX_FILE_BYTES) continue;
              totalBytes += source.byteLength;
              const text = source.toString("utf8");
              if (text.includes(input.query)) matches.push(item);
            }
            result = JSON.stringify(matches);
          } else
            throw new IdiomError(
              "unknown or malformed exploration tool request",
            );
          if (totalBytes > MAX_TOTAL_BYTES)
            throw new IdiomError("exploration source read budget exceeded");
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: result,
          });
        } catch (error) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: sanitizeCritiqueDiagnostic(error),
          });
        }
      }
      messages.push({ role: "user", content: results });
    }
    throw new IdiomError(
      "Anthropic exploration exceeded the bounded source-tool turn limit",
    );
  }

  async proposeCandidates(input: CandidateRequest) {
    const permittedReferenceLabels = input.context.references.map(
      (reference) => reference.label,
    );
    const manifest = await mirrorManifest(
      input.evidence.mirrorRoot,
      input.evidence.readablePaths,
    );
    const prompt = candidatePrompt({
      ...input,
      evidence: { ...input.evidence, readablePaths: manifest.relative },
    });
    const request = {
      root: input.evidence.mirrorRoot,
      prompt,
      schema: explorationCandidatesJsonSchema(permittedReferenceLabels),
      readablePaths: manifest.absolute,
    };
    const value = await this.invoke(request);
    return parseCandidatesWithRepair({
      evidence: input.evidence,
      initial: value,
      permittedReferenceLabels,
      repair: async (issues) =>
        this.invoke({
          ...request,
          prompt: `${prompt}\n\nRejected output:\n${JSON.stringify(value)}\n\nIssues:\n${issues.join("\n")}\nReturn a complete replacement batch.`,
        }),
    });
  }

  async refineCandidate(input: RefinementRequest) {
    const permittedReferenceLabels = input.context.references.map(
      (reference) => reference.label,
    );
    const manifest = await mirrorManifest(
      input.evidence.mirrorRoot,
      input.evidence.readablePaths,
    );
    const prompt = refinementPrompt({
      ...input,
      evidence: { ...input.evidence, readablePaths: manifest.relative },
    });
    const request = {
      root: input.evidence.mirrorRoot,
      prompt,
      schema: explorationRefinementJsonSchema(permittedReferenceLabels),
      readablePaths: manifest.absolute,
    };
    const value = await this.invoke(request);
    return parseRefinementWithRepair({
      evidence: input.evidence,
      initial: value,
      permittedReferenceLabels,
      repair: async (issues) =>
        this.invoke({
          ...request,
          prompt: `${prompt}\n\nRejected output:\n${JSON.stringify(value)}\n\nIssues:\n${issues.join("\n")}\nReturn a complete replacement refinement.`,
        }),
    });
  }
}
