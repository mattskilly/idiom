import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { DecisionObservation } from "../schemas/ruling.js";
import {
  CLAUDE_CODE_MAX_SESSION_DOM_CHARS,
  CLAUDE_CODE_MAX_SESSION_IMAGE_BYTES,
  CLAUDE_CODE_MAX_SESSION_IMAGES,
  type ClaudeCodeSession,
  type ClaudeCodeSessionLimits,
  claudeCodeSessionLimits,
  fitsOneSession,
  formatMegabytes,
  type ImageReference,
  planClaudeCodeSessions,
} from "./claude-code-sessions.js";
import {
  type CritiqueProcessRequest,
  type CritiqueProcessResult,
  type CritiqueProcessRunner,
  CritiqueProcessTimeoutError,
  formatCritiqueTimeout,
  runCritiqueProcess,
  sanitizeCritiqueDiagnostic,
} from "./process.js";
import { critiquePrompt } from "./prompt.js";
import { modelResponseJsonSchema } from "./schema.js";
import { critiqueWithRepair } from "./structured.js";
import { subscriptionAuthEnvironment } from "./subscription-environment.js";
import type {
  CritiqueAdapter,
  CritiqueInput,
  CritiqueResult,
  CropRef,
  DesignImageRef,
  ModelFindingCandidate,
  ScreenshotRef,
} from "./types.js";
import { critiqueResult } from "./types.js";

export type ClaudeCodeRunRequest = CritiqueProcessRequest;
export type ClaudeCodeRunResult = CritiqueProcessResult;
export type ClaudeCodeRunner = CritiqueProcessRunner;
export {
  CLAUDE_CODE_MAX_SESSION_DOM_CHARS,
  CLAUDE_CODE_MAX_SESSION_IMAGE_BYTES,
  CLAUDE_CODE_MAX_SESSION_IMAGES,
  CritiqueProcessTimeoutError,
  sanitizeCritiqueDiagnostic,
};

/**
 * Wall-clock bound on one `claude -p` invocation. It matches the Anthropic
 * SDK's default request timeout, which bounds the direct-API path, and leaves
 * room for a long session (one Read turn per screenshot). The bound is per
 * session: a capture split across sessions gets it once per session, and each
 * session's semantic repair round is a separate invocation with its own bound.
 */
export const CLAUDE_CODE_CRITIQUE_TIMEOUT_MS = 10 * 60 * 1000;

export type ClaudeCodeFailureKind = "unavailable" | "execution" | "timeout";

export class ClaudeCodeCritiqueError extends Error {
  readonly detail: string;
  /** Set when the session was stopped for exceeding its wall-clock bound. */
  readonly timeoutMs: number | undefined;
  /**
   * `execution` means the CLI ran and reported a failed session; `unavailable`
   * covers a missing CLI, an authentication failure, or output with no result
   * envelope.
   */
  readonly kind: ClaudeCodeFailureKind;

  constructor(
    detail: unknown,
    options?: {
      timeoutMs?: number | undefined;
      kind?: "unavailable" | "execution" | undefined;
    },
  ) {
    const safeDetail =
      sanitizeCritiqueDiagnostic(detail) || "unknown Claude Code failure";
    const timeoutMs = options?.timeoutMs;
    const kind: ClaudeCodeFailureKind =
      timeoutMs === undefined ? (options?.kind ?? "unavailable") : "timeout";
    super(
      timeoutMs !== undefined
        ? `Claude Code critique did not finish within ${formatCritiqueTimeout(timeoutMs)} and was stopped`
        : kind === "execution"
          ? `Claude Code ran but the critique session failed: ${safeDetail}`
          : `Claude Code CLI is unavailable or not authenticated; install or update Claude Code and run \`claude auth login\`: ${safeDetail}`,
    );
    this.name = "ClaudeCodeCritiqueError";
    this.detail = safeDetail;
    this.timeoutMs = timeoutMs;
    this.kind = kind;
  }
}

/**
 * Every captured screenshot was left out by the per-session evidence budget,
 * so there is nothing for a session to review.
 */
export class ClaudeCodeEvidenceBudgetError extends Error {
  constructor(options: {
    limits: ClaudeCodeSessionLimits;
    omittedScreenshots: number;
  }) {
    super(
      `Claude Code critique evidence exceeds the per-session budget (${options.limits.images} images, ${formatMegabytes(options.limits.imageBytes)} of images, ${options.limits.domChars.toLocaleString("en-US")} DOM characters): all ${options.omittedScreenshots} captured screenshot${options.omittedScreenshots === 1 ? " was" : "s were"} omitted`,
    );
    this.name = "ClaudeCodeEvidenceBudgetError";
  }
}

export const runClaudeCode: ClaudeCodeRunner = runCritiqueProcess;

function pathManifest(
  evidence: {
    screenshots: ScreenshotRef[];
    references: ImageReference[];
    crops: CropRef[];
    designImages: DesignImageRef[];
  },
  projectDirectory: string,
) {
  return [
    ...evidence.screenshots.map((screenshot) => ({
      label: screenshot.label,
      kind: "captured-screenshot",
      state: screenshot.state,
      viewport: screenshot.viewport,
      path: resolve(projectDirectory, screenshot.readPath),
    })),
    ...evidence.references.map((reference) => ({
      label: reference.label,
      kind: reference.polarity,
      path: resolve(projectDirectory, reference.readPath),
    })),
    ...evidence.crops.map((crop) => ({
      label: crop.label,
      kind: "zoomed-crop",
      magnifies: crop.screenshot,
      state: crop.state,
      viewport: crop.viewport,
      path: resolve(projectDirectory, crop.readPath),
    })),
    ...evidence.designImages.map((design) => ({
      label: design.label,
      kind: "intended-design-image",
      designFor: design.designFor,
      state: design.state,
      viewport: design.viewport,
      path: resolve(projectDirectory, design.readPath),
    })),
  ];
}

const readInstruction =
  "Use the Read tool to inspect every path above. Cite captured screenshot labels exactly as written; paths are evidence transport only and must not appear as screenshot citations.";

function imageReferences(input: CritiqueInput): ImageReference[] {
  return input.references.filter(
    (reference): reference is ImageReference => reference.kind === "image",
  );
}

function completePrompt(
  input: CritiqueInput,
  projectDirectory: string,
): string {
  return [
    critiquePrompt(input, input.screenshots),
    "## Readable image path manifest",
    JSON.stringify(
      pathManifest(
        {
          screenshots: input.screenshots,
          references: imageReferences(input),
          crops: input.crops ?? [],
          designImages: input.designImages ?? [],
        },
        projectDirectory,
      ),
      null,
      2,
    ),
    readInstruction,
  ].join("\n\n");
}

/** The input one bounded session sees: its own DOM excerpts and geometry. */
function sessionInput(
  input: CritiqueInput,
  session: ClaudeCodeSession,
): CritiqueInput {
  const labels = new Set(session.screenshots.map((item) => item.label));
  return {
    ...input,
    domExcerpts: session.domExcerpts,
    ...(input.geometry === undefined
      ? {}
      : {
          geometry: input.geometry.filter((surface) =>
            labels.has(surface.label),
          ),
        }),
  };
}

function sessionPrompt(
  input: CritiqueInput,
  session: ClaudeCodeSession,
  index: number,
  count: number,
  projectDirectory: string,
): string {
  return [
    critiquePrompt(
      sessionInput(input, session),
      session.screenshots,
      session.references,
      session.crops,
      session.designImages,
    ),
    "## Readable image path manifest",
    JSON.stringify(pathManifest(session, projectDirectory), null, 2),
    `This is session ${index + 1} of ${count}; only the images above are visible in this session.`,
    readInstruction,
  ].join("\n\n");
}

/**
 * Diagnostic text the CLI uses when it is not signed in. The result envelope
 * carries no structured authentication flag, so this is matched against the
 * envelope's own diagnostic; anything it misses is reported as an execution
 * failure rather than falsely asserted to be an authentication problem.
 */
export const CLAUDE_CODE_AUTH_FAILURE =
  /not logged in|please run \/login|\/login\b|not authenticated|authentication[_ ]failed|invalid api key|oauth token (?:has )?expired|\b401\b/i;

interface ResultEnvelope {
  record: Record<string, unknown>;
  failed: boolean;
  diagnostic: string;
  auth: boolean;
}

/**
 * Reads a `--output-format json` result envelope. `subtype: "success"` alone
 * never means success: an unauthenticated session reports it alongside
 * `is_error: true`. The diagnostic is built only from typed string fields.
 */
function readResultEnvelope(source: string): ResultEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.trim());
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "result") return undefined;
  const failed = record.is_error === true || record.subtype !== "success";
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((item): item is string => typeof item === "string")
    : [];
  const diagnostic = [
    typeof record.subtype === "string" && record.subtype !== "success"
      ? record.subtype
      : "",
    typeof record.result === "string" ? record.result.trim() : "",
    errors.join("; "),
  ]
    .filter((part) => part !== "")
    .join(": ");
  return {
    record,
    failed,
    diagnostic,
    auth: failed && CLAUDE_CODE_AUTH_FAILURE.test(diagnostic),
  };
}

function structuredOutput(source: string): unknown {
  try {
    JSON.parse(source.trim());
  } catch (error) {
    throw new ClaudeCodeCritiqueError(
      `Claude Code returned a malformed JSON envelope: ${sanitizeCritiqueDiagnostic(error)}`,
    );
  }
  const envelope = readResultEnvelope(source);
  if (envelope === undefined)
    throw new ClaudeCodeCritiqueError(
      "Claude Code returned no result envelope",
    );
  if (envelope.failed)
    throw new ClaudeCodeCritiqueError(
      `Claude Code returned an error result: ${envelope.diagnostic === "" ? "non-success result" : envelope.diagnostic}`,
      { kind: envelope.auth ? "unavailable" : "execution" },
    );
  if (!("structured_output" in envelope.record))
    throw new ClaudeCodeCritiqueError(
      "Claude Code returned no structured_output; install a version that supports --json-schema",
    );
  return envelope.record.structured_output;
}

export class ClaudeCodeCritiqueAdapter implements CritiqueAdapter {
  readonly model: string;
  readonly projectDirectory: string;
  readonly runner: ClaudeCodeRunner;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly statImage: (path: string) => Promise<number>;
  readonly limits: ClaudeCodeSessionLimits;

  constructor(options: {
    model: string;
    projectDirectory: string;
    runner?: ClaudeCodeRunner | undefined;
    environment?: NodeJS.ProcessEnv | undefined;
    timeoutMs?: number | undefined;
    /** Reads one image's on-disk size in bytes; the path is absolute. */
    statImage?: ((path: string) => Promise<number>) | undefined;
    /** Per-session evidence budget; defaults to the documented limits. */
    limits?: ClaudeCodeSessionLimits | undefined;
  }) {
    this.model = options.model;
    this.projectDirectory = resolve(options.projectDirectory);
    this.runner = options.runner ?? runClaudeCode;
    this.timeoutMs = options.timeoutMs ?? CLAUDE_CODE_CRITIQUE_TIMEOUT_MS;
    this.statImage =
      options.statImage ?? (async (path) => (await stat(path)).size);
    this.limits = options.limits ?? claudeCodeSessionLimits;
    this.environment = subscriptionAuthEnvironment(
      options.environment ?? process.env,
    );
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
        label: "Claude Code",
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof CritiqueProcessTimeoutError)
        throw new ClaudeCodeCritiqueError(error, {
          timeoutMs: error.timeoutMs,
        });
      throw new ClaudeCodeCritiqueError(error);
    }
    if (result.signal === null && result.exitCode !== 0) {
      const envelope = readResultEnvelope(result.stdout);
      if (envelope !== undefined) {
        const stderr = result.stderr.trim();
        throw new ClaudeCodeCritiqueError(
          `exit ${String(result.exitCode)}: ${envelope.diagnostic === "" ? "non-success result" : envelope.diagnostic}${stderr === "" ? "" : ` (stderr: ${stderr})`}`,
          { kind: envelope.auth ? "unavailable" : "execution" },
        );
      }
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

  private async imageSizes(input: CritiqueInput): Promise<Map<string, number>> {
    const paths = [
      ...new Set(
        [
          ...input.screenshots,
          ...imageReferences(input),
          ...(input.crops ?? []),
          ...(input.designImages ?? []),
        ].map((item) => item.readPath),
      ),
    ];
    const sizes = await Promise.all(
      paths.map((path) => this.statImage(resolve(this.projectDirectory, path))),
    );
    return new Map(paths.map((path, index) => [path, sizes[index] ?? 0]));
  }

  async critique(input: CritiqueInput): Promise<CritiqueResult> {
    if (input.screenshots.length === 0) return critiqueResult({ findings: [] });
    const sizes = await this.imageSizes(input);
    if (fitsOneSession(input, sizes, this.limits))
      return critiqueWithRepair({
        input,
        prompt: completePrompt(input, this.projectDirectory),
        invoke: (prompt) => this.invoke(prompt),
      });
    const { sessions, omitted } = planClaudeCodeSessions(
      input,
      sizes,
      this.limits,
    );
    if (sessions.length === 0)
      throw new ClaudeCodeEvidenceBudgetError({
        limits: this.limits,
        omittedScreenshots: input.screenshots.length,
      });
    const textReferences = input.references.filter(
      (reference) => reference.kind === "text",
    );
    const findings: ModelFindingCandidate[] = [];
    const decisionObservations: DecisionObservation[] = [];
    let discardedDecisionObservations = 0;
    // Sequential and all-or-nothing: any failing session throws, so partial
    // sessions are never published.
    for (const [index, session] of sessions.entries()) {
      const result = await critiqueWithRepair({
        input,
        prompt: sessionPrompt(
          input,
          session,
          index,
          sessions.length,
          this.projectDirectory,
        ),
        invoke: (prompt) => this.invoke(prompt),
        visible: {
          screenshots: session.screenshots,
          references: [...session.references, ...textReferences],
          designImages: session.designImages,
        },
      });
      findings.push(...result.findings);
      decisionObservations.push(...result.decisionObservations);
      discardedDecisionObservations += result.discardedDecisionObservations;
    }
    return critiqueResult({
      findings,
      decisionObservations,
      discardedDecisionObservations,
      evidenceLimits: {
        provider: "claude-code",
        limits: { ...this.limits },
        sessions: sessions.length,
        omitted,
      },
    });
  }
}
