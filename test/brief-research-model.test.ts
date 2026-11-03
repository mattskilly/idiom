import { writeFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import {
  claudeResearchMaxTurns,
  codexEventCounter,
  createResearchCaller,
  type ResearchCall,
  ResearchStop,
  researchCapableProviders,
} from "../src/brief/research-model.js";
import type { CritiqueProcessRequest } from "../src/critique/process.js";
import {
  briefOptionsAnswerJsonSchema,
  briefResearchAnswerJsonSchema,
} from "../src/schemas/brief.js";

const findings = {
  findings: [
    {
      claim: "Pins sit in the corner.",
      source: "https://a.test/",
      verified: "read",
    },
  ],
};

function call(overrides: Partial<ResearchCall> = {}): ResearchCall {
  return {
    stage: "research",
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    prompt: "the prompt",
    signal: new AbortController().signal,
    maxSearches: 5,
    ...overrides,
  };
}

function ok(stdout: string, exitCode = 0) {
  return { stdout, stderr: "", exitCode, signal: null };
}

function envelope(fields: Record<string, unknown>) {
  return JSON.stringify({ type: "result", is_error: false, ...fields });
}

test("claude-code research allows web search and fetch within the turn bound", async () => {
  const runner = vi.fn(async (_request: CritiqueProcessRequest) =>
    ok(
      envelope({
        subtype: "success",
        structured_output: findings,
        num_turns: 7,
        usage: { input_tokens: 1200, output_tokens: 300 },
      }),
    ),
  );
  const caller = createResearchCaller({
    projectDirectory: "/project",
    environment: {
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_BASE_URL: "https://proxy.test",
      PATH: "/bin",
    },
    claudeCodeRunner: runner,
  });
  expect(await caller(call())).toEqual({
    answer: findings,
    turns: 7,
    tokens: { input: 1200, output: 300 },
  });
  const request = runner.mock.calls[0]?.[0] as CritiqueProcessRequest;
  expect(claudeResearchMaxTurns(5)).toBe(12);
  expect(request.args).toEqual([
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(briefResearchAnswerJsonSchema),
    "--model",
    "claude-sonnet-5-5",
    "--safe-mode",
    "--tools",
    "WebSearch,WebFetch",
    "--allowedTools",
    "WebSearch,WebFetch",
    "--permission-mode",
    "dontAsk",
    "--max-turns",
    "12",
    "--no-session-persistence",
    "--no-chrome",
  ]);
  expect(request.stdin).toBe("the prompt");
  expect(request.environment.ANTHROPIC_API_KEY).toBeUndefined();
  expect(request.environment.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(request.environment.PATH).toBe("/bin");
});

test("claude-code options run tool-free in two turns, and leave out figures it did not report", async () => {
  const runner = vi.fn(async (_request: CritiqueProcessRequest) =>
    ok(envelope({ subtype: "success", structured_output: { title: "x" } })),
  );
  const caller = createResearchCaller({
    projectDirectory: "/project",
    environment: {},
    claudeCodeRunner: runner,
  });
  const result = await caller(call({ stage: "options" }));
  expect(result).toEqual({
    answer: { title: "x" },
    turns: undefined,
    tokens: undefined,
  });
  const args =
    (runner.mock.calls[0]?.[0] as CritiqueProcessRequest)?.args ?? [];
  expect(args[args.indexOf("--json-schema") + 1]).toBe(
    JSON.stringify(briefOptionsAnswerJsonSchema),
  );
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args).not.toContain("--allowedTools");
  expect(args[args.indexOf("--max-turns") + 1]).toBe("2");
});

test("claude-code's turn limit is a bound stop even with a non-zero exit", async () => {
  const caller = createResearchCaller({
    projectDirectory: "/project",
    environment: {},
    claudeCodeRunner: async () =>
      ok(
        envelope({
          subtype: "error_max_turns",
          is_error: true,
          num_turns: 12,
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        1,
      ),
  });
  const error = await caller(call()).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ResearchStop);
  expect(error).toMatchObject({
    kind: "bound",
    usage: { turns: 12, tokens: { input: 10, output: 2 } },
  });
});

test("claude-code with no envelope and a failed exit is unavailable", async () => {
  const caller = createResearchCaller({
    projectDirectory: "/project",
    environment: {},
    claudeCodeRunner: async () => ok("", 1),
  });
  await expect(caller(call())).rejects.toMatchObject({
    kind: "unavailable",
    message: expect.stringMatching(/claude auth login/),
  });
});

function codexStub(
  lines: string[],
  answer: unknown,
  chunking: (line: string) => string[] = (line) => [line],
) {
  return vi.fn(async (request: CritiqueProcessRequest) => {
    for (const line of lines)
      for (const chunk of chunking(`${line}\n`)) {
        if (request.signal?.aborted)
          throw new Error("Codex invocation aborted");
        request.onStdout?.(chunk);
      }
    if (request.signal?.aborted) throw new Error("Codex invocation aborted");
    const message = request.args[request.args.indexOf("-o") + 1] as string;
    await writeFile(message, JSON.stringify(answer));
    return ok("");
  });
}

const turn = (input: number, output: number) =>
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: input,
      cached_input_tokens: 0,
      output_tokens: output,
    },
  });
const search = JSON.stringify({
  type: "item.completed",
  item: { id: "item_1", type: "web_search", query: "pin" },
});

test("codex research turns live web search on and sums streamed usage", async () => {
  const runner = codexStub([search, search, turn(900, 100), turn(50, 20)], {
    findings: "nothing found",
    extra: null,
  });
  const caller = createResearchCaller({
    projectDirectory: "/project",
    environment: { ANTHROPIC_API_KEY: "sk-ant-secret" },
    codexRunner: runner,
  });
  expect(await caller(call({ provider: "codex", model: "gpt-5.5" }))).toEqual({
    answer: { findings: "nothing found" },
    turns: 2,
    searches: 2,
    tokens: { input: 950, output: 120 },
  });
  const request = runner.mock.calls[0]?.[0] as CritiqueProcessRequest;
  expect(request.executable).toBe("codex");
  expect(request.args.slice(0, 2)).toEqual(["exec", "--skip-git-repo-check"]);
  expect(request.args).toContain('web_search="live"');
  expect(request.args[request.args.indexOf("-c") + 1]).toBe(
    'web_search="live"',
  );
  expect(request.args).toContain("--json");
  expect(request.environment.ANTHROPIC_API_KEY).toBeUndefined();
});

test("codex options turn web search off and report no search count", async () => {
  const runner = codexStub([turn(10, 5)], { title: "x" });
  const caller = createResearchCaller({
    projectDirectory: "/project",
    environment: {},
    codexRunner: runner,
  });
  expect(
    await caller(
      call({ stage: "options", provider: "codex", model: "gpt-5.5" }),
    ),
  ).toEqual({
    answer: { title: "x" },
    turns: 1,
    tokens: { input: 10, output: 5 },
  });
  const args =
    (runner.mock.calls[0]?.[0] as CritiqueProcessRequest)?.args ?? [];
  expect(args).toContain('web_search="disabled"');
  expect(args).not.toContain('web_search="live"');
});

test("codex past the search bound is aborted as a bound stop", async () => {
  const runner = codexStub(Array(6).fill(search), findings);
  const caller = createResearchCaller({
    projectDirectory: "/project",
    environment: {},
    codexRunner: runner,
  });
  await expect(
    caller(call({ provider: "codex", model: "gpt-5.5", maxSearches: 5 })),
  ).rejects.toMatchObject({ kind: "bound", usage: { searches: 6 } });
  expect(runner.mock.calls[0]?.[0].signal?.aborted).toBe(true);
});

test("a JSONL line split across chunks still counts", () => {
  const seen: number[] = [];
  const counter = codexEventCounter((searches) => seen.push(searches));
  counter.write(search.slice(0, 20));
  counter.write(`${search.slice(20)}\n${turn(3, 4).slice(0, 5)}`);
  counter.write(`${turn(3, 4).slice(5)}\n`);
  expect(seen).toEqual([1]);
  expect(counter.usage()).toEqual({
    turns: 1,
    searches: 1,
    tokens: { input: 3, output: 4 },
  });
  expect(codexEventCounter(() => undefined).usage()).toEqual({});
});

test("codex failing to start is unavailable", async () => {
  const caller = createResearchCaller({
    projectDirectory: "/project",
    environment: {},
    codexRunner: async () => ({
      stdout: "",
      stderr: "not logged in",
      exitCode: 1,
      signal: null,
    }),
  });
  await expect(
    caller(call({ provider: "codex", model: "gpt-5.5" })),
  ).rejects.toMatchObject({
    kind: "unavailable",
    message: expect.stringMatching(/codex login.*not logged in/),
  });
});

test("only claude-code and codex can research, in configured order", () => {
  expect(
    researchCapableProviders({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      fallback: { provider: "codex", model: "gpt-5.5" },
    }),
  ).toEqual([{ provider: "codex", model: "gpt-5.5" }]);
  expect(
    researchCapableProviders({ provider: "anthropic", model: "m" }),
  ).toEqual([]);
});
