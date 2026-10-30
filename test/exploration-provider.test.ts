import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ClaudeCodeRunRequest } from "../src/critique/claude-code.js";
import {
  AnthropicExplorationAdapter,
  type AnthropicExplorationClient,
} from "../src/explore/anthropic.js";
import { ClaudeCodeExplorationAdapter } from "../src/explore/claude-code.js";
import { createExplorationAdapter } from "../src/explore/provider.js";
import type {
  CandidateRequest,
  RefinementRequest,
} from "../src/explore/types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function candidate(label: string, references = ["reference:Known"]) {
  return {
    label,
    direction: `Direction ${label}`,
    choiceKey: `choice-${label}`,
    rule: `Rule ${label}`,
    reason: `Reason ${label}`,
    category: "hierarchy" as const,
    repair: `Repair ${label}`,
    references,
    edits: [{ path: "src/app.tsx", oldText: "old", newText: label }],
  };
}

async function request(
  referenceLabels: string[] = ["reference:Known", "anti-reference:Avoid"],
): Promise<CandidateRequest> {
  const root = await mkdtemp(join(tmpdir(), "idiom-explore-provider-"));
  directories.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.tsx"), "old");
  return {
    context: {
      projectDirectory: "/must/not/reach/preflight",
      project: {} as CandidateRequest["context"]["project"],
      flow: {
        id: "flow",
        intent: [],
        states: [],
      } as unknown as CandidateRequest["context"]["flow"],
      state: { id: "state" } as CandidateRequest["context"]["state"],
      question: "Make hierarchy clear",
      productMd: "Product",
      designMd: "Design",
      rulings: [],
      references: referenceLabels.map((label, index) => ({
        label,
        polarity:
          index === 0 ? ("reference" as const) : ("anti-reference" as const),
        kind: "text" as const,
        content: `Contents for ${label}`,
      })),
      tuples: [],
    },
    evidence: {
      mirrorRoot: root,
      readablePaths: [join(root, "src", "app.tsx")],
      baselineTuples: [],
      runDirectory: root,
    },
  };
}

async function refinementRequest(): Promise<RefinementRequest> {
  const { context, evidence } = await request();
  return {
    context,
    evidence,
    candidate: candidate("A"),
    instruction: "Make the hierarchy tighter",
  };
}

test("Claude preflight is tool-free, safe, and contains no product path", async () => {
  const calls: ClaudeCodeRunRequest[] = [];
  const adapter = new ClaudeCodeExplorationAdapter({
    model: "model",
    runner: vi.fn(async (call) => {
      calls.push(call);
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          structured_output: { available: true },
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }),
  });
  await adapter.preflight();
  expect(calls[0]?.args).toContain("--safe-mode");
  expect(calls[0]?.args).not.toContain("--add-dir");
  expect(
    calls[0]?.args.slice((calls[0]?.args.indexOf("--tools") ?? -2) + 1)[0],
  ).toBe("");
  expect(calls[0]?.stdin).not.toContain("/must/not/reach/preflight");
});

test("Claude generation repairs nonconforming labels once with actionable issues", async () => {
  const input = await request();
  const calls: ClaudeCodeRunRequest[] = [];
  const outputs = [
    {
      candidates: [
        candidate("Direction one"),
        candidate("Direction two"),
        candidate("Direction three"),
      ],
    },
    { candidates: [candidate("A"), candidate("B"), candidate("C")] },
  ];
  const adapter = new ClaudeCodeExplorationAdapter({
    model: "model",
    runner: vi.fn(async (call) => {
      calls.push(call);
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          structured_output: outputs.shift(),
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }),
  });
  await expect(adapter.proposeCandidates(input)).resolves.toHaveLength(3);
  expect(calls).toHaveLength(2);
  const mirror = await realpath(input.evidence.mirrorRoot);
  expect(calls.every((call) => call.cwd === mirror)).toBe(true);
  expect(calls[0]?.args).toContain("Read,Glob,Grep");
  expect(calls[0]?.args).toContain("dontAsk");
  expect(calls[0]?.args).not.toContain("--add-dir");
  expect(calls[1]?.stdin).toContain(
    'received ["Direction one","Direction two","Direction three"]',
  );
  const schemaArgument =
    calls[0]?.args[(calls[0]?.args.indexOf("--json-schema") ?? -2) + 1];
  const schema = JSON.parse(schemaArgument ?? "null");
  expect(
    schema.properties.candidates.items.properties.references,
  ).toMatchObject({
    minItems: 1,
    items: {
      enum: ["reference:Known", "anti-reference:Avoid"],
    },
  });
  expect(calls[0]?.stdin).toContain('"reference:Known"');
  expect(calls[0]?.stdin).toContain('"anti-reference:Avoid"');
  expect(calls[0]?.stdin).toContain("DESIGN.md");
  expect(calls[0]?.stdin).toContain("not citation labels");
});

test("Claude repairs design-law citations and canonicalizes enum casing", async () => {
  const input = await request();
  const calls: ClaudeCodeRunRequest[] = [];
  const designCitation = "DESIGN.md: Timezone lines are a pattern";
  const outputs = [
    {
      candidates: [
        candidate("A", [designCitation]),
        candidate("B"),
        candidate("C"),
      ],
    },
    {
      candidates: [
        candidate("A", ["REFERENCE:KNOWN"]),
        candidate("B"),
        candidate("C"),
      ],
    },
  ];
  const adapter = new ClaudeCodeExplorationAdapter({
    model: "model",
    runner: vi.fn(async (call) => {
      calls.push(call);
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          structured_output: outputs.shift(),
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }),
  });

  const candidates = await adapter.proposeCandidates(input);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.stdin).toContain(designCitation);
  expect(calls[1]?.stdin).toContain("reference:Known");
  expect(calls[1]?.stdin).toContain("anti-reference:Avoid");
  expect(candidates[0]?.references).toEqual(["reference:Known"]);
});

test("Claude accepts citation capitalization drift without spending repair", async () => {
  const input = await request();
  const runner = vi.fn(async () => ({
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      structured_output: {
        candidates: [
          candidate("A", ["REFERENCE:KNOWN"]),
          candidate("B"),
          candidate("C"),
        ],
      },
    }),
    stderr: "",
    exitCode: 0,
    signal: null,
  }));
  const adapter = new ClaudeCodeExplorationAdapter({ model: "model", runner });
  const candidates = await adapter.proposeCandidates(input);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(candidates[0]?.references).toEqual(["reference:Known"]);
});

test("Claude empty-catalog requests require empty citation lists locally", async () => {
  const input = await request([]);
  const calls: ClaudeCodeRunRequest[] = [];
  const adapter = new ClaudeCodeExplorationAdapter({
    model: "model",
    runner: vi.fn(async (call) => {
      calls.push(call);
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          structured_output: {
            candidates: [
              candidate("A", []),
              candidate("B", []),
              candidate("C", []),
            ],
          },
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }),
  });
  await expect(adapter.proposeCandidates(input)).resolves.toHaveLength(3);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.stdin).toContain("There are no managed references");
  expect(calls[0]?.stdin).toContain("must be exactly []");
  const schemaArgument =
    calls[0]?.args[(calls[0]?.args.indexOf("--json-schema") ?? -2) + 1];
  expect(schemaArgument).not.toContain("maxItems");
});

test("Claude refinement uses the same one-repair lifecycle", async () => {
  const input = await refinementRequest();
  const calls: ClaudeCodeRunRequest[] = [];
  const outputs = [
    { refinement: { direction: "incomplete" } },
    {
      refinement: {
        direction: "Tighter A",
        choiceKey: "choice-a-tight",
        rule: "Prefer tighter hierarchy.",
        reason: "It scans clearly.",
        category: "hierarchy",
        repair: "Tighten the hierarchy.",
        references: ["reference:Known"],
        edits: [{ path: "src/app.tsx", oldText: "A", newText: "AA" }],
      },
    },
  ];
  const adapter = new ClaudeCodeExplorationAdapter({
    model: "model",
    runner: vi.fn(async (call) => {
      calls.push(call);
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          structured_output: outputs.shift(),
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }),
  });

  await expect(adapter.refineCandidate(input)).resolves.toMatchObject({
    direction: "Tighter A",
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.stdin).toContain("choiceKey: Invalid input");
  const refinementSchemaArgument =
    calls[0]?.args[(calls[0]?.args.indexOf("--json-schema") ?? -2) + 1];
  const refinementSchema = JSON.parse(refinementSchemaArgument ?? "null");
  expect(
    refinementSchema.properties.refinement.properties.references,
  ).toMatchObject({
    minItems: 1,
    items: {
      enum: ["reference:Known", "anti-reference:Avoid"],
    },
  });
});

test("exhausted refinement repair preserves both attempts and sanitizes the error", async () => {
  const input = await refinementRequest();
  const rejected = {
    refinement: { "sk-ant-provider-secret": "untrusted" },
  };
  const calls: ClaudeCodeRunRequest[] = [];
  const adapter = new ClaudeCodeExplorationAdapter({
    model: "model",
    runner: vi.fn(async (call) => {
      calls.push(call);
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          structured_output: rejected,
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }),
  });
  const artifact = join(
    input.evidence.runDirectory,
    "provider-output",
    "refinement-rejected.json",
  );

  const failure: unknown = await adapter
    .refineCandidate(input)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  const message = failure instanceof Error ? failure.message : "";
  expect(message).toContain(`rejected output preserved at ${artifact}`);
  expect(message).toContain("[redacted]");
  expect(message).not.toContain("sk-ant-provider-secret");
  expect(calls).toHaveLength(2);
  const evidence = await readFile(artifact, "utf8");
  expect(evidence).toContain("sk-ant-provider-secret");
  expect(JSON.parse(evidence).attempts).toHaveLength(2);
});

function forbiddenAnthropicArrayKeyword(
  value: unknown,
  path = "schema",
): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if ("maxItems" in record) return `${path}.maxItems`;
  if ("minItems" in record && record.minItems !== 0 && record.minItems !== 1)
    return `${path}.minItems`;
  for (const [key, child] of Object.entries(record)) {
    const issue = forbiddenAnthropicArrayKeyword(child, `${path}.${key}`);
    if (issue !== undefined) return issue;
  }
  return undefined;
}

test("Anthropic generation repairs design-law citations within its supported structured-output subset", async () => {
  const input = await request();
  const calls: Array<Record<string, unknown>> = [];
  let generation = 0;
  const designCitation = "DESIGN.md: Timezone lines are a pattern";
  const client: AnthropicExplorationClient = {
    messages: {
      create: vi.fn(async (request) => {
        calls.push(request);
        if (!("tools" in request))
          return { content: [{ type: "text", text: '{"available":true}' }] };
        generation += 1;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                candidates:
                  generation === 1
                    ? [
                        candidate("A", [designCitation]),
                        candidate("B"),
                        candidate("C"),
                      ]
                    : [candidate("A"), candidate("B"), candidate("C")],
              }),
            },
          ],
        };
      }),
    },
  };
  const adapter = new AnthropicExplorationAdapter({
    model: "claude-test",
    environment: { ANTHROPIC_API_KEY: "test-key" },
    client,
  });
  await adapter.preflight();
  await expect(adapter.proposeCandidates(input)).resolves.toHaveLength(3);
  expect(calls).toHaveLength(3);
  const generationRequest = calls[1] as {
    tools: Array<{ name: string; strict: boolean; input_schema: unknown }>;
    output_config: { format: { schema: unknown } };
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  expect(
    generationRequest.tools.map((tool) => [tool.name, tool.strict]),
  ).toEqual([
    ["read_file", true],
    ["search_files", true],
  ]);
  expect(
    forbiddenAnthropicArrayKeyword(
      generationRequest.output_config.format.schema,
    ),
  ).toBeUndefined();
  expect(
    forbiddenAnthropicArrayKeyword(
      generationRequest.tools.find((tool) => tool.name === "search_files")
        ?.input_schema,
    ),
  ).toBeUndefined();
  const prompt = generationRequest.messages[0]?.content[0]?.text;
  expect(prompt).toContain("Return exactly three candidates");
  expect(prompt).toContain('"reference:Known"');
  expect(prompt).toContain('"anti-reference:Avoid"');
  expect(prompt).not.toContain(input.evidence.mirrorRoot);
  const generationSchema = generationRequest.output_config.format.schema as {
    properties: {
      candidates: { items: { properties: { references: unknown } } };
    };
  };
  expect(
    generationSchema.properties.candidates.items.properties.references,
  ).toMatchObject({
    minItems: 1,
    items: {
      enum: ["reference:Known", "anti-reference:Avoid"],
    },
  });
  const repair = calls[2] as {
    output_config: { format: { schema: unknown } };
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  expect(repair.messages[0]?.content[0]?.text).toContain(designCitation);
  expect(repair.messages[0]?.content[0]?.text).toContain("reference:Known");
  expect(repair.messages[0]?.content[0]?.text).toContain(
    "anti-reference:Avoid",
  );
  expect(repair.output_config.format.schema).toEqual(
    generationRequest.output_config.format.schema,
  );
});

test("Codex is rejected explicitly instead of falling into the Anthropic adapter", () => {
  const anthropicClient = { messages: { create: vi.fn() } };
  expect(() =>
    createExplorationAdapter({
      model: { provider: "codex", model: "gpt", maxFindings: 5 },
      environment: { ANTHROPIC_API_KEY: "present" },
      anthropicClient: anthropicClient as never,
    }),
  ).toThrow(
    'idiom explore supports model.provider "claude-code" or "anthropic"; Codex exploration is not available yet',
  );
  expect(anthropicClient.messages.create).not.toHaveBeenCalled();
});
