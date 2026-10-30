import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import {
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

/** Codex streams progress to stderr; a healthy long run must not overflow. */
const MAX_CODEX_STDERR_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_LENGTH = 440;

export class CodexCritiqueError extends Error {
  readonly detail: string;

  constructor(detail: unknown) {
    const safeDetail =
      sanitizeCritiqueDiagnostic(detail) || "unknown Codex failure";
    super(
      `Codex CLI is unavailable or not authenticated; install or update Codex and run \`codex login\`: ${safeDetail}`,
    );
    this.name = "CodexCritiqueError";
    this.detail = safeDetail;
  }
}

type JsonSchema = Record<string, unknown>;

const STRIPPED_KEYWORDS = new Set(["$schema", "minLength", "maxLength"]);

function isSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!isSchema(schema)) return schema;
  const output: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    if (key === "properties" && isSchema(value)) continue;
    if (key === "required") continue;
    if (key === "items" || key === "anyOf") output[key] = strictSchema(value);
    else if ((key === "$defs" || key === "definitions") && isSchema(value))
      output[key] = Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, strictSchema(item)]),
      );
    else output[key] = value;
  }
  if (isSchema(schema.properties)) {
    const required = new Set(
      Array.isArray(schema.required) ? (schema.required as string[]) : [],
    );
    output.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => {
        const strict = strictSchema(property);
        return [
          name,
          required.has(name) ? strict : { anyOf: [strict, { type: "null" }] },
        ];
      }),
    );
    output.required = Object.keys(schema.properties);
    output.additionalProperties = false;
  }
  return output;
}

/**
 * Codex sends `--output-schema` in OpenAI strict mode: every property is
 * required (optional ones become null unions), every object is closed, and
 * string length keywords are unsupported. Local validation still enforces
 * the original constraints.
 */
export function codexOutputSchema(schema: JsonSchema): JsonSchema {
  return strictSchema(schema) as JsonSchema;
}

/** Null means absent in the strict transport; drop it before validation. */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, stripNulls(item)]),
  );
}

function imageManifest(input: CritiqueInput, projectDirectory: string) {
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
  ].map((entry, index) => ({ ...entry, attachment: index + 1 }));
}

function completePrompt(
  input: CritiqueInput,
  manifest: ReturnType<typeof imageManifest>,
): string {
  return [
    critiquePrompt(input, input.screenshots),
    "## Attached image manifest",
    JSON.stringify(manifest, null, 2),
    "Images are attached in manifest order; attachment n is the n-th attached image. Cite captured screenshot labels exactly as written; attachment numbers and paths are evidence transport only and must not appear as screenshot citations.",
  ].join("\n\n");
}

export class CodexCritiqueAdapter implements CritiqueAdapter {
  readonly model: string;
  readonly projectDirectory: string;
  readonly runner: CritiqueProcessRunner;
  readonly environment: NodeJS.ProcessEnv;
  readonly tempDirectory: string;

  constructor(options: {
    model: string;
    projectDirectory: string;
    runner?: CritiqueProcessRunner | undefined;
    environment?: NodeJS.ProcessEnv | undefined;
    tempDirectory?: string | undefined;
  }) {
    this.model = options.model;
    this.projectDirectory = resolve(options.projectDirectory);
    this.runner = options.runner ?? runCritiqueProcess;
    this.environment = { ...(options.environment ?? process.env) };
    delete this.environment.ANTHROPIC_API_KEY;
    this.tempDirectory = options.tempDirectory ?? tmpdir();
  }

  private async invoke(prompt: string, images: string[]): Promise<unknown> {
    const directory = await mkdtemp(join(this.tempDirectory, "idiom-codex-"));
    try {
      const schemaPath = join(directory, "schema.json");
      const messagePath = join(directory, "last-message.json");
      await writeFile(
        schemaPath,
        JSON.stringify(codexOutputSchema(modelResponseJsonSchema)),
      );
      // --image splits its value on commas; attach a copy instead.
      const attached = await Promise.all(
        images.map(async (image, index) => {
          if (!image.includes(",")) return image;
          const copy = join(directory, `image-${index + 1}${extname(image)}`);
          await copyFile(image, copy);
          return copy;
        }),
      );
      let result: CritiqueProcessResult;
      try {
        result = await this.runner({
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
            this.projectDirectory,
            "--model",
            this.model,
            "--output-schema",
            schemaPath,
            "-o",
            messagePath,
            // One flag per image and no positional prompt: the prompt is stdin.
            ...attached.flatMap((image) => ["--image", image]),
          ],
          cwd: this.projectDirectory,
          environment: this.environment,
          stdin: prompt,
          label: "Codex",
          maxStderrBytes: MAX_CODEX_STDERR_BYTES,
        });
      } catch (error) {
        throw new CodexCritiqueError(error);
      }
      if (result.exitCode !== 0 || result.signal !== null) {
        const status =
          result.signal === null
            ? `exit ${String(result.exitCode)}`
            : `signal ${result.signal}`;
        // Redact before cutting so no key is split; the tail holds the error.
        const stderr = sanitizeCritiqueDiagnostic(
          result.stderr,
          Number.POSITIVE_INFINITY,
        ).slice(-STDERR_TAIL_LENGTH);
        throw new CodexCritiqueError(
          `${status}${stderr === "" ? "" : `: ${stderr}`}`,
        );
      }
      let message: string;
      try {
        message = await readFile(messagePath, "utf8");
      } catch {
        message = "";
      }
      if (message.trim() === "")
        throw new CodexCritiqueError("Codex returned no final message");
      try {
        return stripNulls(JSON.parse(message));
      } catch (error) {
        throw new CodexCritiqueError(
          `Codex returned a malformed final message: ${sanitizeCritiqueDiagnostic(error)}`,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async critique(input: CritiqueInput): Promise<CritiqueResult> {
    if (input.screenshots.length === 0) return critiqueResult({ findings: [] });
    const manifest = imageManifest(input, this.projectDirectory);
    const images = manifest.map((entry) => entry.path);
    return critiqueWithRepair({
      input,
      prompt: completePrompt(input, manifest),
      invoke: (prompt) => this.invoke(prompt, images),
    });
  }
}
