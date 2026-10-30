import type { CritiqueProvider } from "../schemas/project.js";
import { AnthropicCritiqueAdapter } from "./anthropic.js";
import {
  ClaudeCodeCritiqueAdapter,
  ClaudeCodeCritiqueError,
} from "./claude-code.js";
import { CodexCritiqueAdapter, CodexCritiqueError } from "./codex.js";
import {
  type CritiqueProcessRunner,
  sanitizeCritiqueDiagnostic,
} from "./process.js";
import type {
  CritiqueAdapter,
  CritiqueInput,
  CritiqueResult,
  ModelFindingCandidate,
} from "./types.js";

export type { CritiqueProvider };

/** A critique adapter, or an injected one that returns bare candidates. */
export type CritiqueAdapterLike =
  | CritiqueAdapter
  | {
      critique(
        input: CritiqueInput,
      ): Promise<CritiqueResult | ModelFindingCandidate[]>;
    };

export type CritiqueModelConfig = {
  provider: CritiqueProvider;
  model: string;
  fallback?: { provider: CritiqueProvider; model: string } | undefined;
};

/** A switch from a failed primary provider to the configured fallback. */
export type CritiqueFallbackEvent = {
  from: CritiqueProvider;
  to: CritiqueProvider;
  reason: string;
};

const MAX_DEGRADATION_REASON_LENGTH = 600;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function assertNever(value: never): never {
  throw new Error(`unknown critique provider ${JSON.stringify(value)}`);
}

/** The one place a provider name becomes an adapter. */
export function createProviderCritiqueAdapter(options: {
  provider: CritiqueProvider;
  model: string;
  projectDirectory: string;
  environment?: NodeJS.ProcessEnv | undefined;
  claudeCodeRunner?: CritiqueProcessRunner | undefined;
  codexRunner?: CritiqueProcessRunner | undefined;
}): CritiqueAdapter {
  switch (options.provider) {
    case "claude-code":
      return new ClaudeCodeCritiqueAdapter({
        model: options.model,
        projectDirectory: options.projectDirectory,
        environment: options.environment,
        runner: options.claudeCodeRunner,
      });
    case "anthropic":
      return new AnthropicCritiqueAdapter({
        model: options.model,
        environment: options.environment,
      });
    case "codex":
      return new CodexCritiqueAdapter({
        model: options.model,
        projectDirectory: options.projectDirectory,
        environment: options.environment,
        runner: options.codexRunner,
      });
    default:
      return assertNever(options.provider);
  }
}

export class CritiqueFallbackError extends Error {
  constructor(message: string) {
    super(sanitizeCritiqueDiagnostic(message, MAX_DEGRADATION_REASON_LENGTH));
    this.name = "CritiqueFallbackError";
  }
}

/**
 * Calls the primary provider until it first fails, then the fallback for the
 * rest of its life, so a capped primary costs one attempt per run.
 */
export class FallbackCritiqueAdapter {
  readonly primary: {
    provider: CritiqueProvider;
    adapter: CritiqueAdapterLike;
  };
  readonly fallback: {
    provider: CritiqueProvider;
    adapter: CritiqueAdapterLike;
  };
  private readonly describeFailure: (error: unknown) => string;
  private readonly onFallback:
    | ((event: CritiqueFallbackEvent) => void)
    | undefined;
  private primaryReason: string | undefined;

  constructor(options: {
    primary: { provider: CritiqueProvider; adapter: CritiqueAdapterLike };
    fallback: { provider: CritiqueProvider; adapter: CritiqueAdapterLike };
    describeFailure: (error: unknown) => string;
    onFallback?: ((event: CritiqueFallbackEvent) => void) | undefined;
  }) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.describeFailure = options.describeFailure;
    this.onFallback = options.onFallback;
  }

  async critique(
    input: CritiqueInput,
  ): Promise<CritiqueResult | ModelFindingCandidate[]> {
    if (this.primaryReason === undefined) {
      try {
        return await this.primary.adapter.critique(input);
      } catch (error) {
        this.primaryReason = this.describeFailure(error);
        this.onFallback?.({
          from: this.primary.provider,
          to: this.fallback.provider,
          reason: this.primaryReason,
        });
      }
    }
    try {
      return await this.fallback.adapter.critique(input);
    } catch (error) {
      // Both reasons share the degradation bound.
      const half = Math.floor(MAX_DEGRADATION_REASON_LENGTH / 2) - 30;
      throw new CritiqueFallbackError(
        `${this.primary.provider} failed: ${truncate(this.primaryReason, half)}; fallback ${this.fallback.provider} failed: ${truncate(this.describeFailure(error), half)}`,
      );
    }
  }
}

/**
 * Builds on first use, so a provider that cannot even be constructed (the
 * direct API without a key) fails its call and lets the other one run.
 */
function deferredAdapter(
  build: () => CritiqueAdapterLike,
): CritiqueAdapterLike {
  let adapter: CritiqueAdapterLike | undefined;
  return {
    critique: (input) => {
      adapter ??= build();
      return adapter.critique(input);
    },
  };
}

/** The configured provider's adapter, wrapped when a fallback is set. */
export function createCritiqueAdapter(options: {
  model: CritiqueModelConfig;
  environment: NodeJS.ProcessEnv;
  build: (provider: {
    provider: CritiqueProvider;
    model: string;
  }) => CritiqueAdapterLike;
  onFallback?: ((event: CritiqueFallbackEvent) => void) | undefined;
}): CritiqueAdapterLike {
  const primary = {
    provider: options.model.provider,
    model: options.model.model,
  };
  const fallback = options.model.fallback;
  if (fallback === undefined) return options.build(primary);
  return new FallbackCritiqueAdapter({
    primary: {
      provider: primary.provider,
      adapter: deferredAdapter(() => options.build(primary)),
    },
    fallback: {
      provider: fallback.provider,
      adapter: deferredAdapter(() => options.build(fallback)),
    },
    describeFailure: (error) =>
      describeCritiqueFailure(error, options.environment),
    onFallback: options.onFallback,
  });
}

function safeDegradationDetail(error: unknown, limit: number): string {
  return sanitizeCritiqueDiagnostic(error, limit);
}

export function safeDegradationReason(error: unknown): string {
  return safeDegradationDetail(error, MAX_DEGRADATION_REASON_LENGTH);
}

function cliDegradationReason(
  cliClause: string,
  detailSource: unknown,
  tailClauses: string[],
): string {
  const separator = "; ";
  const detailPrefix = "diagnostic: ";
  const detailBudget =
    MAX_DEGRADATION_REASON_LENGTH -
    cliClause.length -
    tailClauses.reduce((sum, clause) => sum + clause.length, 0) -
    separator.length * (tailClauses.length + 1) -
    detailPrefix.length;
  const detail = safeDegradationDetail(detailSource, detailBudget);
  return [
    cliClause,
    ...(detail === "" ? [] : [`${detailPrefix}${detail}`]),
    ...tailClauses,
  ].join(separator);
}

export function claudeCodeDegradationReason(
  error: unknown,
  environment: NodeJS.ProcessEnv,
): string {
  const fallbackClause =
    environment.ANTHROPIC_API_KEY === undefined ||
    environment.ANTHROPIC_API_KEY.trim() === ""
      ? "ANTHROPIC_API_KEY is not set for the explicit direct-API fallback, or configure model.fallback"
      : 'select model.provider: "anthropic" to use the explicit direct-API fallback, or configure model.fallback';
  return cliDegradationReason(
    "Claude Code CLI is unavailable or not authenticated; install or update Claude Code and run `claude auth login`",
    error instanceof ClaudeCodeCritiqueError ? error.detail : error,
    [fallbackClause],
  );
}

export function codexDegradationReason(error: unknown): string {
  return cliDegradationReason(
    "Codex CLI is unavailable or not authenticated; install or update Codex and run `codex login`",
    error instanceof CodexCritiqueError ? error.detail : error,
    [],
  );
}

/** Failure wording chosen by the error's own class, never by configuration. */
export function describeCritiqueFailure(
  error: unknown,
  environment: NodeJS.ProcessEnv,
): string {
  if (error instanceof ClaudeCodeCritiqueError)
    return claudeCodeDegradationReason(error, environment);
  if (error instanceof CodexCritiqueError) return codexDegradationReason(error);
  return safeDegradationReason(error);
}
