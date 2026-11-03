import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  OPTIONS_ANSWER_RULES,
  researchAnswerRules,
  runBriefResearch,
} from "../src/brief/research.js";
import {
  type ResearchCall,
  type ResearchCallResult,
  ResearchStop,
} from "../src/brief/research-model.js";
import { readBriefRubric } from "../src/brief/rubric.js";
import { storeResearchedBrief } from "../src/brief/store.js";
import { storedBriefSchema } from "../src/schemas/brief.js";
import { briefSettings } from "../src/schemas/project.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/brief/pinned-group-brief.json", import.meta.url),
    "utf8",
  ),
);
const { request, research: _research, ...optionsAnswer } = fixture;
const questions = ["How large is the pin?", "How does it behave on touch?"];
const triage = {
  verdict: "design decision",
  reason: "adds a per-tile control",
  questions,
};
const findings = (claim: string, verified = "read") => ({
  findings: [{ claim, source: "https://example.com/a", verified }],
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

type Handler = (
  call: ResearchCall,
  index: number,
) => Promise<ResearchCallResult>;

function caller(handler: Handler) {
  let index = 0;
  return vi.fn((call: ResearchCall) => handler(call, index++));
}

/** Research answers by question, then the options answer. */
function scripted(
  answers: Array<ResearchCallResult | (() => Promise<ResearchCallResult>)>,
) {
  return caller(async (_call, index) => {
    const answer = answers[index];
    if (answer === undefined) throw new Error(`unexpected call ${index}`);
    return typeof answer === "function" ? answer() : answer;
  });
}

async function run(
  call: ReturnType<typeof caller>,
  overrides: Partial<Parameters<typeof runBriefResearch>[0]> = {},
) {
  return runBriefResearch({
    request,
    rubric: await readBriefRubric(),
    context: { references: [] },
    triageInvoke: async () => triage,
    call,
    providers: [{ provider: "claude-code", model: "claude-sonnet-5-5" }],
    settings: { researchBudgetMs: 900_000, researchMaxSearches: 5 },
    ...overrides,
  });
}

async function store(result: Awaited<ReturnType<typeof run>>) {
  if (result.kind === "no-decision") throw new Error("nothing to store");
  const projectDirectory = await mkdtemp(join(tmpdir(), "idiom-research-"));
  directories.push(projectDirectory);
  const recorded = await storeResearchedBrief({
    projectDirectory,
    brief: result.brief,
    researchRun: result.researchRun,
    now: new Date("2026-10-31T10:00:00Z"),
    rubricVersion: 1,
    settings: briefSettings(undefined),
  });
  return {
    recorded,
    json: JSON.parse(await readFile(recorded.jsonPath, "utf8")),
    markdown: await readFile(recorded.markdownPath, "utf8"),
  };
}

test("success: one research call per question, one options call, a stored brief", async () => {
  const call = scripted([
    {
      answer: findings("Pins are 16px."),
      turns: 4,
      tokens: { input: 100, output: 10 },
    },
    {
      answer: findings("Touch shows the pin."),
      turns: 3,
      tokens: { input: 50, output: 5 },
    },
    { answer: optionsAnswer, turns: 1 },
  ]);
  let now = 1_000;
  const result = await run(call, { clock: () => (now += 30_000) });
  expect(result.kind).toBe("complete");
  if (result.kind !== "complete") return;
  expect(call).toHaveBeenCalledTimes(3);
  expect(call.mock.calls.map(([c]) => c.stage)).toEqual([
    "research",
    "research",
    "options",
  ]);
  expect(call.mock.calls[0]?.[0].prompt).toContain(questions[0]);
  expect(call.mock.calls[0]?.[0].prompt).toContain(researchAnswerRules(5)[0]);
  expect(call.mock.calls[2]?.[0].prompt).toContain(OPTIONS_ANSWER_RULES[1]);
  expect(call.mock.calls[2]?.[0].prompt).toContain("Pins are 16px.");
  expect(result.brief.research.map((r) => r.question)).toEqual(questions);
  expect(result.researchRun).toEqual({
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    budgetMs: 900_000,
    durationMs: 30_000,
    calls: 3,
    turns: 8,
    tokens: { input: 150, output: 15 },
  });
  const { json, markdown } = await store(result);
  expect(storedBriefSchema.safeParse(json).success).toBe(true);
  expect(json.status).toBe("proposed");
  expect(json.triage).toEqual(triage);
  expect(markdown).toContain(
    "Research run: claude-code claude-sonnet-5-5, 30s, 3 calls, 8 turns, 150 input / 15 output tokens (budget 15 minutes).",
  );
  expect(markdown).not.toContain("research incomplete");
});

test("invalid then valid: one retry per stage, carrying the issues", async () => {
  const call = scripted([
    { answer: { findings: [] } },
    { answer: findings("Pins are 16px.") },
    { answer: findings("Touch shows the pin.") },
    {
      answer: {
        ...optionsAnswer,
        options: optionsAnswer.options.map((option: { kind: string }) => ({
          ...option,
          kind: "dont-build",
        })),
      },
    },
    { answer: optionsAnswer },
  ]);
  const result = await run(call);
  expect(result.kind).toBe("complete");
  expect(call).toHaveBeenCalledTimes(5);
  const retry = call.mock.calls[1]?.[0].prompt ?? "";
  expect(retry).toContain("# Your previous answer was rejected:");
  expect(retry).toContain('findings: use "nothing found"');
  expect(call.mock.calls[4]?.[0].prompt).toContain(
    'options: exactly one option must be kind "dont-build"',
  );
  await store(result);
});

test("invalid twice fails the run and stores nothing", async () => {
  const call = scripted([
    { answer: findings("Pins are 16px.") },
    { answer: { findings: [] } },
    { answer: { findings: "unknown" } },
  ]);
  await expect(run(call)).rejects.toThrow(
    /brief research failed: research returned an invalid answer twice/,
  );
  expect(call).toHaveBeenCalledTimes(3);
});

test("timeout: keeps the finished question, guesses nothing, and aborts the call", async () => {
  let aborted = false;
  const call = caller(async (c, index) => {
    if (index === 0) return { answer: findings("Pins are 16px.") };
    return new Promise((_, reject) =>
      c.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }),
    );
  });
  const result = await run(call, {
    settings: { researchBudgetMs: 50, researchMaxSearches: 5 },
  });
  expect(aborted).toBe(true);
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.every(([c]) => c.stage === "research")).toBe(true);
  expect(result.kind).toBe("incomplete");
  if (result.kind !== "incomplete") return;
  expect(result.brief.research.map((r) => r.question)).toEqual([questions[0]]);
  expect(result.brief.options).toBeUndefined();
  expect(result.brief.status).toBe("proposed");
  expect(result.brief.title).toBe(request);
  expect(result.researchRun.incomplete).toEqual({
    stage: "research",
    note: "Research incomplete: the 50 ms research budget ran out; unresearched questions are listed and no options were guessed.",
    unresearched: [questions[1]],
  });
  const { json, markdown } = await store(result);
  expect(storedBriefSchema.safeParse(json).success).toBe(true);
  expect(markdown).toContain(
    "Status: proposed · research incomplete · rubric v1",
  );
  expect(markdown).toContain(`> Not researched: ${questions[1]}`);
  expect(markdown).toContain("Not reached: research incomplete.");
  expect(markdown).toContain(
    `### ${questions[1]}\n\n- Not researched (research incomplete).`,
  );
});

test("a triage that outlasts the budget fails without storing", async () => {
  const call = scripted([]);
  await expect(
    run(call, {
      settings: { researchBudgetMs: 20, researchMaxSearches: 5 },
      triageInvoke: () => new Promise(() => undefined),
    }),
  ).rejects.toThrow(
    "research did not start: triage did not finish within 20 ms",
  );
  expect(call).not.toHaveBeenCalled();
});

test("bound stop: the question is unresearched, options still run on the rest", async () => {
  const call = scripted([
    () =>
      Promise.reject(
        new ResearchStop("bound", "Codex passed the 5-search bound", {
          searches: 6,
        }),
      ),
    { answer: findings("Touch shows the pin."), searches: 2 },
    { answer: optionsAnswer },
  ]);
  const result = await run(call);
  expect(result.kind).toBe("incomplete");
  if (result.kind !== "incomplete") return;
  expect(result.brief.options).toHaveLength(4);
  expect(result.researchRun.searches).toBe(8);
  expect(result.researchRun.incomplete).toEqual({
    stage: "research",
    note: "Research incomplete: the search bound (5 per question) stopped research on 1 question; the options rest on partial research.",
    unresearched: [questions[0]],
  });
  const { json } = await store(result);
  expect(storedBriefSchema.safeParse(json).success).toBe(true);
});

test("no design decision: no research call and nothing to store", async () => {
  const call = scripted([]);
  const result = await run(call, {
    triageInvoke: async () => ({
      verdict: "no design decision",
      reason: "a copy fix",
      questions: [],
    }),
  });
  expect(result.kind).toBe("no-decision");
  expect(call).not.toHaveBeenCalled();
});

test("labels are kept exactly as the provider returned them", async () => {
  const call = scripted([
    { answer: findings("Pins are 16px.", "read") },
    { answer: findings("I tapped the pin.", "hands-on") },
    { answer: optionsAnswer },
  ]);
  const result = await run(call);
  if (result.kind === "no-decision") throw new Error("expected a brief");
  expect(result.brief.research.map((r) => r.findings)).toEqual([
    findings("Pins are 16px.", "read").findings,
    findings("I tapped the pin.", "hands-on").findings,
  ]);
});

test("fallback: an unavailable primary switches once, visibly, for the rest of the run", async () => {
  const onFallback = vi.fn();
  const call = caller(async (c) => {
    if (c.provider === "claude-code")
      throw new ResearchStop("unavailable", "Claude Code not authenticated");
    return c.stage === "research"
      ? { answer: findings("Pins are 16px.") }
      : { answer: optionsAnswer };
  });
  const result = await run(call, {
    providers: [
      { provider: "claude-code", model: "claude-sonnet-5-5" },
      { provider: "codex", model: "gpt-5.5" },
    ],
    onFallback,
  });
  expect(result.kind).toBe("complete");
  expect(onFallback).toHaveBeenCalledOnce();
  expect(onFallback.mock.calls[0]?.[0]).toMatchObject({
    from: "claude-code",
    to: "codex",
  });
  expect(call.mock.calls.map(([c]) => c.provider)).toEqual([
    "claude-code",
    "codex",
    "codex",
    "codex",
  ]);
  if (result.kind === "complete")
    expect(result.researchRun).toMatchObject({ provider: "codex", calls: 4 });
});

test("a provider failure with no fallback fails the run", async () => {
  const call = caller(async () => {
    throw new ResearchStop("execution", "no structured result");
  });
  await expect(run(call)).rejects.toThrow(
    "brief research failed: research via claude-code failed: no structured result",
  );
});
