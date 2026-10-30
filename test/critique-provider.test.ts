import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AnthropicCritiqueAdapter } from "../src/critique/anthropic.js";
import {
  ClaudeCodeCritiqueAdapter,
  ClaudeCodeCritiqueError,
} from "../src/critique/claude-code.js";
import {
  CodexCritiqueAdapter,
  CodexCritiqueError,
} from "../src/critique/codex.js";
import type { CritiqueProcessRequest } from "../src/critique/process.js";
import {
  CritiqueFallbackError,
  type CritiqueFallbackEvent,
  createCritiqueAdapter,
  createProviderCritiqueAdapter,
  describeCritiqueFailure,
  FallbackCritiqueAdapter,
} from "../src/critique/provider.js";
import type {
  CritiqueInput,
  ModelFindingCandidate,
} from "../src/critique/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const candidate: ModelFindingCandidate = {
  category: "hierarchy",
  severity: "major",
  confidence: 0.82,
  rule: "DESIGN.md: keep the primary action visually dominant",
  selectorHint: "main form",
  state: "state-0",
  viewport: "desktop",
  screenshots: ["state-0/desktop"],
  references: [],
  explanation: "The secondary action has equal emphasis.",
  suggestedArea: "booking action group",
  acceptance: ["The primary action is visually dominant."],
};

const empty = {
  findings: [],
  decisionObservations: [],
  discardedDecisionObservations: 0,
};

async function input(): Promise<CritiqueInput> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-provider-"));
  directories.push(directory);
  const readPath = join(directory, "0.png");
  await writeFile(readPath, "png");
  return {
    flow: "booking",
    intent: [],
    screenshots: [
      {
        label: "state-0/desktop",
        path: "state-0/desktop/screenshot.png",
        readPath,
        state: "state-0",
        viewport: "desktop",
      },
    ],
    domExcerpts: [],
    productMd: "",
    designMd: "",
    references: [],
    priorDecisions: [],
    deterministicFindings: [],
    modelCandidateAllowance: 2,
    decisionObservationAllowance: 0,
    rulingResolutions: [],
  };
}

describe("createProviderCritiqueAdapter", () => {
  test.each([
    ["claude-code", ClaudeCodeCritiqueAdapter],
    ["anthropic", AnthropicCritiqueAdapter],
    ["codex", CodexCritiqueAdapter],
  ] as const)("maps %s to its adapter", (provider, adapterClass) => {
    expect(
      createProviderCritiqueAdapter({
        provider,
        model: "m",
        projectDirectory: process.cwd(),
        environment: { ANTHROPIC_API_KEY: "test-key" },
      }),
    ).toBeInstanceOf(adapterClass);
  });
});

describe("createCritiqueAdapter", () => {
  test("returns the bare primary without a fallback", () => {
    const primary = { critique: vi.fn() };
    const build = vi.fn(() => primary);
    expect(
      createCritiqueAdapter({
        model: { provider: "codex", model: "m" },
        environment: {},
        build,
      }),
    ).toBe(primary);
    expect(build).toHaveBeenCalledTimes(1);
  });

  test("builds each provider with its own model, only when it is called", async () => {
    const build = vi.fn(({ provider }: { provider: string }) => {
      if (provider === "anthropic")
        throw new Error("ANTHROPIC_API_KEY is not set");
      return { critique: async () => empty };
    });
    const events: CritiqueFallbackEvent[] = [];
    const adapter = createCritiqueAdapter({
      model: {
        provider: "anthropic",
        model: "sonnet",
        fallback: { provider: "codex", model: "gpt" },
      },
      environment: {},
      build,
      onFallback: (event) => events.push(event),
    });
    expect(adapter).toBeInstanceOf(FallbackCritiqueAdapter);
    expect(build).not.toHaveBeenCalled();
    await expect(adapter.critique(await input())).resolves.toBe(empty);
    expect(build.mock.calls).toEqual([
      [{ provider: "anthropic", model: "sonnet" }],
      [{ provider: "codex", model: "gpt" }],
    ]);
    expect(events).toEqual([
      {
        from: "anthropic",
        to: "codex",
        reason: "ANTHROPIC_API_KEY is not set",
      },
    ]);
  });
});

describe("FallbackCritiqueAdapter", () => {
  function adapters(
    primary: () => Promise<unknown>,
    fallback: () => Promise<unknown>,
  ) {
    const events: CritiqueFallbackEvent[] = [];
    const primaryCritique = vi.fn(primary);
    const fallbackCritique = vi.fn(fallback);
    const adapter = createCritiqueAdapter({
      model: {
        provider: "claude-code",
        model: "sonnet",
        fallback: { provider: "codex", model: "gpt" },
      },
      environment: {},
      build: ({ provider }) =>
        ({
          critique: provider === "codex" ? fallbackCritique : primaryCritique,
        }) as never,
      onFallback: (event) => events.push(event),
    });
    return { adapter, events, primaryCritique, fallbackCritique };
  }

  test("never calls the fallback while the primary succeeds", async () => {
    const run = adapters(
      async () => empty,
      async () => {
        throw new Error("unused");
      },
    );
    await expect(run.adapter.critique(await input())).resolves.toBe(empty);
    expect(run.fallbackCritique).not.toHaveBeenCalled();
    expect(run.events).toEqual([]);
  });

  test("switches once, visibly, and stays on the fallback", async () => {
    const run = adapters(
      async () => {
        throw new ClaudeCodeCritiqueError("usage limit reached");
      },
      async () => empty,
    );
    await expect(run.adapter.critique(await input())).resolves.toBe(empty);
    await expect(run.adapter.critique(await input())).resolves.toBe(empty);
    expect(run.primaryCritique).toHaveBeenCalledTimes(1);
    expect(run.fallbackCritique).toHaveBeenCalledTimes(2);
    expect(run.events).toHaveLength(1);
    expect(run.events[0]).toMatchObject({ from: "claude-code", to: "codex" });
    expect(run.events[0]?.reason).toContain("claude auth login");
    expect(run.events[0]?.reason).toContain("usage limit reached");
  });

  test("names both providers and both reasons when both fail", async () => {
    const run = adapters(
      async () => {
        throw new ClaudeCodeCritiqueError("api_key=sk-ant-secret-one");
      },
      async () => {
        throw new CodexCritiqueError(
          "401 sk-proj-ABCDEFGHIJKLMNOPQRSTUVsecret",
        );
      },
    );
    const failure = await run.adapter
      .critique(await input())
      .catch((error) => error);
    expect(failure).toBeInstanceOf(CritiqueFallbackError);
    expect(failure.message).toMatch(/^claude-code failed: Claude Code CLI/);
    expect(failure.message).toContain("; fallback codex failed: Codex CLI");
    expect(failure.message).not.toContain("secret");
    expect(failure.message.length).toBeLessThanOrEqual(600);
  });
});

describe("describeCritiqueFailure", () => {
  test("picks the wording from the error class", () => {
    const claude = describeCritiqueFailure(
      new ClaudeCodeCritiqueError("x"),
      {},
    );
    expect(claude).toContain("claude auth login");
    expect(claude).toContain("ANTHROPIC_API_KEY is not set");
    expect(claude).toContain("model.fallback");
    const codex = describeCritiqueFailure(new CodexCritiqueError("x"), {});
    expect(codex).toContain("codex login");
    expect(codex).toContain("diagnostic: x");
    expect(describeCritiqueFailure(new Error("plain failure"), {})).toBe(
      "plain failure",
    );
  });
});

test("Claude and Codex share the prompt contract and treat an over-cap batch alike", async () => {
  const overCap = {
    findings: [
      candidate,
      { ...candidate, selectorHint: "header" },
      { ...candidate, selectorHint: "footer" },
    ],
  };
  const critiqueInput = await input();
  const claudeRequests: CritiqueProcessRequest[] = [];
  const claude = createProviderCritiqueAdapter({
    provider: "claude-code",
    model: "m",
    projectDirectory: process.cwd(),
    claudeCodeRunner: async (request) => {
      claudeRequests.push(request);
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: overCap,
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    },
  });
  const codexRequests: CritiqueProcessRequest[] = [];
  const codex = createProviderCritiqueAdapter({
    provider: "codex",
    model: "m",
    projectDirectory: process.cwd(),
    codexRunner: async (request) => {
      codexRequests.push(request);
      await writeFile(
        request.args[request.args.indexOf("-o") + 1] ?? "",
        JSON.stringify(overCap),
      );
      return { stdout: "", stderr: "", exitCode: 0, signal: null };
    },
  });
  const fromClaude = await claude.critique(critiqueInput);
  const fromCodex = await codex.critique(critiqueInput);
  // The cap is asked for in the shared prompt and enforced downstream by
  // finding selection, so both providers pass the batch through unchanged.
  expect(fromCodex).toEqual(fromClaude);
  expect(fromCodex.findings).toHaveLength(3);
  const shared = claudeRequests[0]?.stdin.split(
    "\n\n## Readable image path manifest",
  )[0];
  expect(shared).toContain("no more than 2 model candidate findings");
  expect(
    codexRequests[0]?.stdin.split("\n\n## Attached image manifest")[0],
  ).toBe(shared);
});
