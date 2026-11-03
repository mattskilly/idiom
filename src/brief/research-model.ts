import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeCode } from "../critique/claude-code.js";
import { codexOutputSchema, stripNulls } from "../critique/codex.js";
import {
  type CritiqueProcessRunner,
  runCritiqueProcess,
  sanitizeCritiqueDiagnostic,
} from "../critique/process.js";
import { subscriptionAuthEnvironment } from "../critique/subscription-environment.js";
import {
  briefOptionsAnswerJsonSchema,
  briefResearchAnswerJsonSchema,
} from "../schemas/brief.js";
import type { CritiqueProvider } from "../schemas/project.js";
import type { TriageModel } from "./model.js";

const STDERR_TAIL_LENGTH = 440;

export type ResearchStage = "research" | "options";

/** The providers whose Idiom adapter can search the web. */
export type ResearchProvider = Exclude<CritiqueProvider, "anthropic">;

export type ResearchCall = {
  stage: ResearchStage;
  provider: ResearchProvider;
  model: string;
  prompt: string;
  signal: AbortSignal;
  /** Web searches allowed for this research question. */
  maxSearches: number;
};

/** Each figure is present only when the provider exposed it. */
export type ResearchUsage = {
  turns?: number | undefined;
  searches?: number | undefined;
  tokens?: { input: number; output: number } | undefined;
};

export type ResearchCallResult = ResearchUsage & { answer: unknown };

export type ResearchCaller = (
  call: ResearchCall,
) => Promise<ResearchCallResult>;

/**
 * A call that stopped without an answer. `bound`: the turn or search cap was
 * reached; `unavailable`: the CLI is missing or not signed in; `execution`:
 * it ran but returned no usable result.
 */
export class ResearchStop extends Error {
  readonly kind: "bound" | "unavailable" | "execution";
  readonly usage: ResearchUsage;

  constructor(
    kind: ResearchStop["kind"],
    message: string,
    usage: ResearchUsage = {},
  ) {
    super(message);
    this.name = "ResearchStop";
    this.kind = kind;
    this.usage = usage;
  }
}

export type ResearchCallerOptions = {
  projectDirectory: string;
  environment?: NodeJS.ProcessEnv | undefined;
  claudeCodeRunner?: CritiqueProcessRunner | undefined;
  codexRunner?: CritiqueProcessRunner | undefined;
  tempDirectory?: string | undefined;
};

/** A search and a fetch per allowed search, plus the answer. */
export function claudeResearchMaxTurns(maxSearches: number): number {
  return 2 * maxSearches + 2;
}

/** `model.provider`, then `model.fallback`, keeping only providers with web access. */
export function researchCapableProviders(
  model: TriageModel,
): Array<{ provider: ResearchProvider; model: string }> {
  const candidates = [
    { provider: model.provider, model: model.model },
    ...(model.fallback === undefined ? [] : [model.fallback]),
  ];
  return candidates.flatMap((candidate) =>
    candidate.provider === "anthropic"
      ? []
      : [{ provider: candidate.provider, model: candidate.model }],
  );
}

function schemaFor(stage: ResearchStage) {
  return stage === "research"
    ? briefResearchAnswerJsonSchema
    : briefOptionsAnswerJsonSchema;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function claudeUsage(envelope: Record<string, unknown>): ResearchUsage {
  const usage = envelope.usage as Record<string, unknown> | undefined;
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  return {
    turns: count(envelope.num_turns),
    tokens:
      input === undefined || output === undefined
        ? undefined
        : { input, output },
  };
}

export async function claudeCodeResearch(
  call: ResearchCall,
  options: ResearchCallerOptions,
): Promise<ResearchCallResult> {
  const tools =
    call.stage === "research"
      ? [
          "--tools",
          "WebSearch,WebFetch",
          "--allowedTools",
          "WebSearch,WebFetch",
        ]
      : ["--tools", ""];
  const maxTurns =
    call.stage === "research" ? claudeResearchMaxTurns(call.maxSearches) : 2;
  const result = await (options.claudeCodeRunner ?? runClaudeCode)({
    executable: "claude",
    args: [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schemaFor(call.stage)),
      "--model",
      call.model,
      "--safe-mode",
      ...tools,
      "--permission-mode",
      "dontAsk",
      "--max-turns",
      String(maxTurns),
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
  // The envelope comes first: a turn-limit stop exits non-zero with one.
  let envelope: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      envelope = parsed as Record<string, unknown>;
  } catch {
    envelope = undefined;
  }
  if (envelope?.type === "result") {
    const usage = claudeUsage(envelope);
    if (envelope.subtype === "error_max_turns")
      throw new ResearchStop(
        "bound",
        `Claude Code reached the ${maxTurns}-turn bound`,
        usage,
      );
    if (
      envelope.subtype === "success" &&
      envelope.is_error !== true &&
      "structured_output" in envelope
    )
      return { ...usage, answer: envelope.structured_output };
  }
  if (
    envelope === undefined &&
    (result.exitCode !== 0 || result.signal !== null)
  )
    throw new ResearchStop(
      "unavailable",
      "Claude Code research unavailable or not authenticated; run claude auth login",
    );
  throw new ResearchStop(
    "execution",
    "Claude Code returned no successful structured result",
  );
}

/** Counts what `codex exec --json` streams: turns, token usage, web searches. */
export function codexEventCounter(onSearch: (searches: number) => void) {
  let pending = "";
  const usage = {
    events: 0,
    turns: 0,
    searches: 0,
    input: 0,
    output: 0,
    sawUsage: false,
  };
  const handle = (line: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event === null || typeof event !== "object") return;
    usage.events += 1;
    if (event.type === "turn.completed") {
      usage.turns += 1;
      const tokens = event.usage as Record<string, unknown> | undefined;
      const input = count(tokens?.input_tokens);
      const output = count(tokens?.output_tokens);
      if (input !== undefined && output !== undefined) {
        usage.input += input;
        usage.output += output;
        usage.sawUsage = true;
      }
    }
    const item = event.item as Record<string, unknown> | undefined;
    if (
      event.type === "item.completed" &&
      typeof item?.type === "string" &&
      /web_?search/i.test(item.type)
    ) {
      usage.searches += 1;
      onSearch(usage.searches);
    }
  };
  return {
    write(chunk: string) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") handle(line);
    },
    usage(): ResearchUsage {
      if (pending.trim() !== "") handle(pending);
      pending = "";
      // No events at all: the stream exposed nothing, which is not zero.
      if (usage.events === 0) return {};
      return {
        turns: usage.turns,
        searches: usage.searches,
        tokens: usage.sawUsage
          ? { input: usage.input, output: usage.output }
          : undefined,
      };
    },
  };
}

export async function codexResearch(
  call: ResearchCall,
  options: ResearchCallerOptions,
): Promise<ResearchCallResult> {
  const runner = options.codexRunner ?? runCritiqueProcess;
  const environment = { ...(options.environment ?? process.env) };
  delete environment.ANTHROPIC_API_KEY;
  // One controller per call, so the search bound stops only this call.
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (call.signal.aborted) controller.abort();
  else call.signal.addEventListener("abort", forward, { once: true });
  let bounded = false;
  const counter = codexEventCounter((searches) => {
    if (call.stage === "research" && searches > call.maxSearches) {
      bounded = true;
      controller.abort();
    }
  });
  const directory = await mkdtemp(
    join(options.tempDirectory ?? tmpdir(), "idiom-brief-research-"),
  );
  try {
    const schemaPath = join(directory, "schema.json");
    const messagePath = join(directory, "last-message.json");
    await writeFile(
      schemaPath,
      JSON.stringify(codexOutputSchema(schemaFor(call.stage))),
    );
    let result: Awaited<ReturnType<CritiqueProcessRunner>>;
    try {
      result = await runner({
        executable: "codex",
        args: [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          "-c",
          `web_search="${call.stage === "research" ? "live" : "disabled"}"`,
          "--json",
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
        signal: controller.signal,
        label: "Codex",
        onStdout: (chunk) => counter.write(chunk),
      });
    } catch (error) {
      if (bounded)
        throw new ResearchStop(
          "bound",
          `Codex passed the ${call.maxSearches}-search bound`,
          counter.usage(),
        );
      throw error;
    }
    const usage = counter.usage();
    if (bounded)
      throw new ResearchStop(
        "bound",
        `Codex passed the ${call.maxSearches}-search bound`,
        usage,
      );
    if (result.exitCode !== 0 || result.signal !== null) {
      const status =
        result.signal === null
          ? `exit ${String(result.exitCode)}`
          : `signal ${result.signal}`;
      const stderr = sanitizeCritiqueDiagnostic(
        result.stderr,
        Number.POSITIVE_INFINITY,
      ).slice(-STDERR_TAIL_LENGTH);
      throw new ResearchStop(
        "unavailable",
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
      throw new ResearchStop("execution", "Codex returned no final message");
    let answer: unknown;
    try {
      answer = stripNulls(JSON.parse(message));
    } catch {
      // Not JSON: local validation rejects it and the retry says why.
      answer = message;
    }
    // Searches are a research figure; the options call has web search off.
    return call.stage === "research"
      ? { ...usage, answer }
      : { turns: usage.turns, tokens: usage.tokens, answer };
  } finally {
    call.signal.removeEventListener("abort", forward);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Routes each call to its provider; fallback and deadlines belong to the run. */
export function createResearchCaller(
  options: ResearchCallerOptions,
): ResearchCaller {
  return (call) =>
    call.provider === "claude-code"
      ? claudeCodeResearch(call, options)
      : codexResearch(call, options);
}
