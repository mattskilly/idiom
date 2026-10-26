import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CheckTuple } from "../src/checks/types.js";
import {
  AnthropicCritiqueAdapter,
  AnthropicCritiqueError,
  type AnthropicRequest,
  type MessageClient,
} from "../src/critique/anthropic.js";
import {
  ClaudeCodeCritiqueAdapter,
  ClaudeCodeCritiqueError,
  type ClaudeCodeRunner,
  type ClaudeCodeRunRequest,
} from "../src/critique/claude-code.js";
import {
  buildCritiqueContext,
  tupleDesignImages,
} from "../src/critique/context.js";
import { critiquePrompt } from "../src/critique/prompt.js";
import {
  MalformedCritiqueError,
  modelResponseJsonSchema,
  parseModelResponse,
} from "../src/critique/schema.js";
import type {
  CritiqueInput,
  CropRef,
  DesignImageRef,
  ModelFindingCandidate,
  ScreenshotRef,
} from "../src/critique/types.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

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

function response(findings: ModelFindingCandidate[], split = false) {
  const source = JSON.stringify({ findings });
  return {
    content: split
      ? [
          { type: "text", text: source.slice(0, 12) },
          { type: "tool_use", id: "ignored" },
          { type: "text", text: source.slice(12) },
        ]
      : [{ type: "text", text: source }],
  };
}

function critiqueResult(findings: ModelFindingCandidate[]) {
  return {
    findings,
    decisionObservations: [],
    discardedDecisionObservations: 0,
  };
}

async function input(count = 1): Promise<CritiqueInput> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-critique-"));
  directories.push(directory);
  const screenshots: ScreenshotRef[] = [];
  for (let index = 0; index < count; index += 1) {
    const state = `state-${Math.floor(index / 2)}`;
    const viewport = index % 2 === 0 ? "desktop" : "mobile";
    const readPath = join(directory, `${index}.png`);
    await writeFile(readPath, Buffer.from(`png-${index}`));
    screenshots.push({
      label: `${state}/${viewport}`,
      path: `${state}/${viewport}/screenshot.png`,
      readPath,
      state,
      viewport,
    });
  }
  return {
    flow: "booking",
    intent: ["Booking is obvious in one screen."],
    screenshots,
    domExcerpts: [],
    productMd: "Serve recipients quickly.",
    designMd: "Keep one dominant action.",
    references: [],
    priorDecisions: [],
    deterministicFindings: [],
    modelCandidateAllowance: 5,
    decisionObservationAllowance: 3,
    rulingResolutions: [],
  };
}

function client(
  implementation: (request: AnthropicRequest) => Promise<unknown>,
): MessageClient {
  return { messages: { create: vi.fn(implementation) } };
}

describe("Anthropic critique adapter", () => {
  test.each(["claude-3-haiku-20240307", "claude-sonnet-4-5-20250929"])(
    "uses only baseline Messages fields for %s",
    async (model) => {
      const requests: AnthropicRequest[] = [];
      const adapter = new AnthropicCritiqueAdapter({
        model,
        client: client(async (request) => {
          requests.push(request);
          return response([candidate], true);
        }),
      });
      await expect(adapter.critique(await input())).resolves.toEqual(
        critiqueResult([candidate]),
      );
      expect(requests).toHaveLength(1);
      expect(Object.keys(requests[0] ?? {}).sort()).toEqual([
        "max_tokens",
        "messages",
        "model",
      ]);
      expect(requests[0]?.model).toBe(model);
      expect(requests[0]?.max_tokens).toBe(16_000);
      const requestRecord = requests[0] as unknown as Record<string, unknown>;
      for (const key of [
        "temperature",
        "top_p",
        "top_k",
        "output_config",
        "thinking",
        "effort",
        "tools",
        "betas",
      ])
        expect(requestRecord).not.toHaveProperty(key);
      const content = requests[0]?.messages[0]?.content;
      expect(Array.isArray(content)).toBe(true);
      if (!Array.isArray(content)) throw new Error("expected content blocks");
      expect(content[0]).toMatchObject({
        type: "text",
        text: "Image 1 — state-0/desktop",
      });
      expect(content[1]).toMatchObject({
        type: "image",
        source: { type: "base64", media_type: "image/png" },
      });
      expect(content.at(-1)).toMatchObject({ type: "text" });
    },
  );

  test("batches the 28-screen flow stably below the image limit", async () => {
    const requests: AnthropicRequest[] = [];
    const adapter = new AnthropicCritiqueAdapter({
      model: "configured-model",
      client: client(async (request) => {
        requests.push(request);
        return response([]);
      }),
    });
    await expect(adapter.critique(await input(28))).resolves.toEqual(
      critiqueResult([]),
    );
    expect(requests).toHaveLength(2);
    expect(
      requests.map((request) => {
        const content = request.messages[0]?.content;
        return Array.isArray(content)
          ? content.filter((block) => block.type === "image").length
          : 0;
      }),
    ).toEqual([20, 8]);
    for (const request of requests) {
      const content = request.messages[0]?.content;
      if (!Array.isArray(content)) throw new Error("expected content blocks");
      for (const [index, block] of content.entries()) {
        if (block.type !== "image") continue;
        expect(content[index - 1]).toMatchObject({
          type: "text",
          text: expect.stringMatching(/^Image \d+ — /),
        });
      }
      const prompt = content.at(-1);
      expect(prompt).toMatchObject({ type: "text" });
      if (prompt?.type !== "text") throw new Error("expected prompt");
      expect(prompt.text).toContain("PRODUCT.md");
      expect(prompt.text).toContain("Standing human rejections");
      expect(prompt.text).toContain("Do not emit a numeric or aggregate");
    }
  });

  test("transports managed reference pixels, notes, provenance, and exact citations", async () => {
    const critiqueInput = await input();
    const directory = dirname(critiqueInput.screenshots[0]?.readPath ?? "");
    const referencePath = join(directory, "managed.png");
    await writeFile(referencePath, "managed reference");
    critiqueInput.references.push({
      label: "anti-reference:booking-widget",
      polarity: "anti-reference",
      kind: "image",
      readPath: referencePath,
      mediaType: "image/png",
      note: "Avoid glossy booking-widget chrome.",
      sourceKind: "file",
      source: "fixtures/widget.png",
    });
    const cited = {
      ...candidate,
      category: "reference-mismatch" as const,
      references: ["anti-reference:booking-widget"],
    };
    const requests: AnthropicRequest[] = [];
    const adapter = new AnthropicCritiqueAdapter({
      model: "configured-model",
      client: client(async (request) => {
        requests.push(request);
        return response([cited]);
      }),
    });
    await expect(adapter.critique(critiqueInput)).resolves.toEqual(
      critiqueResult([cited]),
    );
    const content = requests[0]?.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected content blocks");
    expect(content).toHaveLength(5);
    expect(content[2]).toMatchObject({
      type: "text",
      text: "Image 2 — anti-reference:booking-widget",
    });
    const prompt = content.at(-1);
    if (prompt?.type !== "text") throw new Error("expected prompt");
    expect(prompt.text).toContain("Avoid glossy booking-widget chrome.");
    expect(prompt.text).toContain("fixtures/widget.png");
  });

  test("retries one malformed response with the original multimodal request", async () => {
    const requests: AnthropicRequest[] = [];
    const adapter = new AnthropicCritiqueAdapter({
      model: "configured-model",
      client: client(async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { content: [{ type: "text", text: "not json" }] }
          : response([candidate]);
      }),
    });
    await expect(adapter.critique(await input())).resolves.toEqual(
      critiqueResult([candidate]),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    const original = requests[1]?.messages[0]?.content;
    expect(Array.isArray(original) && original[0]?.type).toBe("text");
    expect(Array.isArray(original) && original[1]?.type).toBe("image");
  });

  test("repairs an empty text response without an empty assistant turn", async () => {
    const requests: AnthropicRequest[] = [];
    const adapter = new AnthropicCritiqueAdapter({
      model: "configured-model",
      client: client(async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { content: [{ type: "thinking", thinking: "unfinished" }] }
          : response([candidate]);
      }),
    });
    await expect(adapter.critique(await input())).resolves.toEqual(
      critiqueResult([candidate]),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.map((message) => message.role)).toEqual([
      "user",
    ]);
    const retryContent = requests[1]?.messages[0]?.content;
    expect(Array.isArray(retryContent)).toBe(true);
    if (!Array.isArray(retryContent)) throw new Error("expected retry blocks");
    expect(retryContent.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("Validation issues:"),
    });
  });

  test("rejects an image above the 10 MB base64 limit before transport", async () => {
    const critiqueInput = await input();
    const screenshot = critiqueInput.screenshots[0];
    if (screenshot === undefined) throw new Error("missing screenshot fixture");
    await writeFile(screenshot.readPath, Buffer.alloc(8 * 1024 * 1024));
    const create = vi.fn(async () => response([]));
    const adapter = new AnthropicCritiqueAdapter({
      model: "configured-model",
      client: { messages: { create } },
    });
    await expect(adapter.critique(critiqueInput)).rejects.toThrow(
      /state-0\/desktop.*exceeds the model request budget/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  test("rejects a PNG above 8000px before transport", async () => {
    const critiqueInput = await input();
    const screenshot = critiqueInput.screenshots[0];
    if (screenshot === undefined) throw new Error("missing screenshot fixture");
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(800, 16);
    png.writeUInt32BE(8_001, 20);
    await writeFile(screenshot.readPath, png);
    const create = vi.fn(async () => response([]));
    const adapter = new AnthropicCritiqueAdapter({
      model: "configured-model",
      client: { messages: { create } },
    });
    await expect(adapter.critique(critiqueInput)).rejects.toThrow(
      /state-0\/desktop.*800x8001px.*8000x8000px/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  test("a second invalid response throws the typed malformed-output error", async () => {
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: "```json\n{}\n```" }],
    }));
    const adapter = new AnthropicCritiqueAdapter({
      model: "configured-model",
      client: { messages: { create } },
    });
    await expect(adapter.critique(await input())).rejects.toBeInstanceOf(
      MalformedCritiqueError,
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  test("reads credentials only from the injected environment and sanitizes provider errors", async () => {
    expect(
      () =>
        new AnthropicCritiqueAdapter({
          model: "configured-model",
          environment: {},
        }),
    ).toThrow(AnthropicCritiqueError);
    const adapter = new AnthropicCritiqueAdapter({
      model: "bad-model",
      client: client(async () => {
        throw new Error("400 unsupported image; api_key=sk-ant-secret-value");
      }),
    });
    await expect(adapter.critique(await input())).rejects.toThrow(
      /bad-model.*400 unsupported image.*\[redacted\]/,
    );
    await expect(adapter.critique(await input())).rejects.not.toThrow(
      /secret-value/,
    );
  });
});

function cliResult(structured_output: unknown) {
  return {
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output,
    }),
    stderr: "",
    exitCode: 0,
    signal: null,
  } as const;
}

describe("Claude Code critique adapter", () => {
  test("uses the structured-output, read-only CLI contract without inheriting the API key", async () => {
    const critiqueInput = await input();
    const screenshot = critiqueInput.screenshots[0];
    if (screenshot === undefined) throw new Error("missing screenshot fixture");
    const referencePath = join(
      dirname(screenshot.readPath),
      "reference image;$(ignored).png",
    );
    await writeFile(referencePath, "reference");
    critiqueInput.references.push({
      label: "reference:checkout shell",
      polarity: "reference",
      kind: "image",
      readPath: referencePath,
      mediaType: "image/png",
      note: "Follow the dense editorial type scale.",
      sourceKind: "url",
      source: "https://example.test/editorial",
      capturedAt: "2026-08-16T12:00:00.000Z",
      viewport: { name: "desktop", width: 1440, height: 900 },
    });
    critiqueInput.references.push({
      label: "anti-reference:saas-chrome.txt",
      polarity: "anti-reference",
      kind: "text",
      content: "Avoid booking-widget chrome.",
    });
    const requests: ClaudeCodeRunRequest[] = [];
    const runner: ClaudeCodeRunner = vi.fn(async (request) => {
      requests.push(request);
      return cliResult({ findings: [candidate] });
    });
    const adapter = new ClaudeCodeCritiqueAdapter({
      model: "model;$(ignored)",
      projectDirectory: dirname(referencePath),
      environment: {
        PATH: "/example/bin",
        ANTHROPIC_API_KEY: "sk-ant-must-not-pass",
      },
      runner,
    });
    await expect(adapter.critique(critiqueInput)).resolves.toEqual(
      critiqueResult([candidate]),
    );
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.executable).toBe("claude");
    expect(request?.environment.PATH).toBe("/example/bin");
    expect(request?.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(request?.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(modelResponseJsonSchema),
      "--model",
      "model;$(ignored)",
      "--safe-mode",
      "--tools",
      "Read",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--no-chrome",
    ]);
    expect(request?.stdin).toContain("PRODUCT.md");
    expect(request?.stdin).toContain("state-0/desktop");
    expect(request?.stdin).toContain("reference:checkout shell");
    expect(request?.stdin).toContain("Follow the dense editorial type scale.");
    expect(request?.stdin).toContain("https://example.test/editorial");
    expect(request?.stdin).toContain("anti-reference:saas-chrome.txt");
    expect(request?.stdin).toContain("equally binding judgment context");
    expect(request?.stdin).toContain(referencePath);
    expect(request?.stdin).toContain("no more than 5 model candidate findings");
    expect(request?.stdin).toContain(
      "Already evaluated deterministic findings",
    );
  });

  test.each([
    ["unknown screenshot", { ...candidate, screenshots: ["unknown/mobile"] }],
    ["mismatched tuple", { ...candidate, viewport: "mobile" }],
    [
      "rating prose",
      { ...candidate, explanation: "The overall design rating is seven." },
    ],
  ])(
    "repairs one locally invalid %s response statelessly",
    async (_label, invalid) => {
      const requests: ClaudeCodeRunRequest[] = [];
      const runner: ClaudeCodeRunner = vi.fn(async (request) => {
        requests.push(request);
        return requests.length === 1
          ? cliResult({ findings: [invalid] })
          : cliResult({ findings: [candidate] });
      });
      const adapter = new ClaudeCodeCritiqueAdapter({
        model: "configured",
        projectDirectory: process.cwd(),
        runner,
      });
      await expect(adapter.critique(await input())).resolves.toEqual(
        critiqueResult([candidate]),
      );
      expect(requests).toHaveLength(2);
      expect(requests[1]?.stdin).toContain("## Rejected structured output");
      expect(requests[1]?.stdin).toContain("## Local validation issues");
      expect(requests[1]?.stdin).toContain("PRODUCT.md");
      expect(requests[1]?.stdin).toContain(
        JSON.stringify({ findings: [invalid] }, null, 2),
      );
    },
  );

  test("stops after two semantic failures without returning partial findings", async () => {
    const runner = vi.fn(async () =>
      cliResult({ findings: [{ ...candidate, screenshots: ["unknown"] }] }),
    );
    const adapter = new ClaudeCodeCritiqueAdapter({
      model: "configured",
      projectDirectory: process.cwd(),
      runner,
    });
    await expect(adapter.critique(await input())).rejects.toBeInstanceOf(
      MalformedCritiqueError,
    );
    expect(runner).toHaveBeenCalledTimes(2);
  });

  test.each([
    [
      "missing executable",
      async () => Promise.reject(new Error("spawn claude ENOENT")),
    ],
    [
      "nonzero auth failure",
      async () => ({
        stdout: "",
        stderr: "not logged in; api_key=sk-ant-secret-value",
        exitCode: 1,
        signal: null,
      }),
    ],
    [
      "signal failure",
      async () => ({
        stdout: "",
        stderr: "terminated",
        exitCode: null,
        signal: "SIGTERM" as const,
      }),
    ],
    [
      "malformed envelope",
      async () => ({
        stdout: "not json",
        stderr: "",
        exitCode: 0,
        signal: null,
      }),
    ],
    [
      "error envelope",
      async () => ({
        stdout: JSON.stringify({
          type: "result",
          subtype: "error",
          is_error: true,
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      }),
    ],
    [
      "missing structured output",
      async () => ({
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      }),
    ],
  ])(
    "turns %s into a sanitized typed failure",
    async (_label, implementation) => {
      const adapter = new ClaudeCodeCritiqueAdapter({
        model: "configured",
        projectDirectory: process.cwd(),
        runner: implementation,
      });
      const failure = await adapter
        .critique(await input())
        .catch((error) => error);
      expect(failure).toBeInstanceOf(ClaudeCodeCritiqueError);
      expect(String(failure)).toContain("claude auth login");
      expect(String(failure)).not.toContain("secret-value");
    },
  );

  test("redacts bare API and OAuth tokens from Claude Code diagnostics", async () => {
    const adapter = new ClaudeCodeCritiqueAdapter({
      model: "configured",
      projectDirectory: process.cwd(),
      runner: async () => ({
        stdout: "",
        stderr:
          "request failed with key sk-ant-api03-LIVEKEY123; authorization: Bearer sk-ant-oat01-LIVETOKEN456",
        exitCode: 1,
        signal: null,
      }),
    });
    const failure = await adapter
      .critique(await input())
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ClaudeCodeCritiqueError);
    expect(String(failure)).toContain("[redacted]");
    expect(String(failure)).not.toContain("LIVEKEY123");
    expect(String(failure)).not.toContain("LIVETOKEN456");
    expect(String(failure)).not.toContain("sk-ant-");
  });

  test("does not invoke Claude Code when there are no captured screenshots", async () => {
    const runner = vi.fn(async () => cliResult({ findings: [] }));
    const adapter = new ClaudeCodeCritiqueAdapter({
      model: "configured",
      projectDirectory: process.cwd(),
      runner,
    });
    await expect(adapter.critique(await input(0))).resolves.toEqual(
      critiqueResult([]),
    );
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("model response validation", () => {
  const screenshot: ScreenshotRef = {
    label: "state-0/desktop",
    path: "state-0/desktop/screenshot.png",
    readPath: "/unused",
    state: "state-0",
    viewport: "desktop",
  };

  test("accepts strict schema-valid candidates", () => {
    expect(
      parseModelResponse(JSON.stringify({ findings: [candidate] }), [
        screenshot,
      ]),
    ).toEqual(critiqueResult([candidate]));
  });

  test("accepts exact known reference labels and requires them for reference mismatch", () => {
    const reference = {
      label: "reference:editorial-density",
      polarity: "reference" as const,
      kind: "text" as const,
      content: "Use this density.",
    };
    const cited = {
      ...candidate,
      category: "reference-mismatch" as const,
      references: [reference.label],
    };
    expect(
      parseModelResponse(
        JSON.stringify({ findings: [cited] }),
        [screenshot],
        [reference],
      ),
    ).toEqual(critiqueResult([cited]));
    expect(() =>
      parseModelResponse(
        JSON.stringify({
          findings: [{ ...cited, references: ["reference:unknown"] }],
        }),
        [screenshot],
        [reference],
      ),
    ).toThrow(/unknown label/);
    expect(() =>
      parseModelResponse(
        JSON.stringify({ findings: [{ ...cited, references: [] }] }),
        [screenshot],
        [reference],
      ),
    ).toThrow(/requires at least one exact reference label/);
  });

  test("exports the strict response shape as draft-07 JSON Schema", () => {
    const schema = modelResponseJsonSchema as Record<string, unknown>;
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["findings"]);
    expect(JSON.stringify(schema)).toContain('"exclusiveMaximum":1');
  });

  test.each([
    ["unknown screenshot", { ...candidate, screenshots: ["missing/mobile"] }],
    ["cross tuple", { ...candidate, viewport: "mobile" }],
    ["confidence one", { ...candidate, confidence: 1 }],
    ["empty guidance", { ...candidate, rule: "" }],
    [
      "numeric design rating",
      { ...candidate, explanation: "Overall design score: 7/10." },
    ],
  ])("rejects %s", (_label, invalid) => {
    expect(() =>
      parseModelResponse(JSON.stringify({ findings: [invalid] }), [screenshot]),
    ).toThrow(MalformedCritiqueError);
  });

  test("rejects surrounding prose and fences", () => {
    expect(() => parseModelResponse("Here is JSON: {}", [screenshot])).toThrow(
      MalformedCritiqueError,
    );
    expect(() => parseModelResponse("```json\n{}\n```", [screenshot])).toThrow(
      MalformedCritiqueError,
    );
  });
});

test("critique context loads declared guidance, sorted references, and bounded body DOM", async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), "idiom-context-"));
  directories.push(projectDirectory);
  const runDirectory = join(projectDirectory, ".idiom", "reports", "run");
  const tupleDirectory = join(runDirectory, "state", "desktop");
  const confirmedTupleDirectory = join(runDirectory, "confirmed", "desktop");
  await mkdir(join(projectDirectory, ".idiom", "references"), {
    recursive: true,
  });
  await mkdir(join(projectDirectory, ".idiom", "anti-references"), {
    recursive: true,
  });
  await mkdir(tupleDirectory, { recursive: true });
  await mkdir(confirmedTupleDirectory, { recursive: true });
  await mkdir(
    join(projectDirectory, ".idiom", "references", "managed-density"),
  );
  // Staging remnant killed between the image and reference.json writes.
  await mkdir(
    join(projectDirectory, ".idiom", "references", ".editorial-density-Ab3xY"),
  );
  await Promise.all([
    writeFile(
      join(
        projectDirectory,
        ".idiom",
        "references",
        ".editorial-density-Ab3xY",
        "image.png",
      ),
      "interrupted png",
    ),
    writeFile(join(projectDirectory, "PRODUCT.md"), "Product intent"),
    writeFile(join(projectDirectory, "DESIGN.md"), "Design language"),
    writeFile(join(projectDirectory, ".idiom", "references", "b.md"), "B"),
    writeFile(join(projectDirectory, ".idiom", "references", "a.png"), "png"),
    writeFile(
      join(
        projectDirectory,
        ".idiom",
        "references",
        "managed-density",
        "image.png",
      ),
      "managed png",
    ),
    writeFile(
      join(
        projectDirectory,
        ".idiom",
        "references",
        "managed-density",
        "reference.json",
      ),
      JSON.stringify({
        version: 1,
        name: "managed-density",
        note: "Use the compact density.",
        image: "image.png",
        mediaType: "image/png",
        sourceKind: "url",
        source: "https://example.test/reference",
        capturedAt: "2026-08-16T12:00:00.000Z",
        viewport: { name: "desktop", width: 800, height: 600 },
      }),
    ),
    writeFile(
      join(projectDirectory, ".idiom", "anti-references", "z.txt"),
      "Avoid Z",
    ),
    writeFile(join(tupleDirectory, "screenshot.png"), "png"),
    writeFile(join(confirmedTupleDirectory, "screenshot.png"), "png"),
    writeFile(
      join(tupleDirectory, "dom.html"),
      `<html><head>ignore</head><body><main>${"content".repeat(500)}</main><script>ignore()</script></body></html>`,
    ),
    writeFile(
      join(confirmedTupleDirectory, "dom.html"),
      "<html><body><main>Confirmed</main></body></html>",
    ),
  ]);
  const context = await buildCritiqueContext({
    projectDirectory,
    runDirectory,
    project: projectSchema.parse({
      version: 1,
      app: { name: "fixture", framework: "other" },
      server: {
        build: "true",
        start: "true",
        readyUrl: "http://127.0.0.1:1",
        port: 1,
        env: {},
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: {},
      design: {},
      model: { provider: "anthropic", model: "configured" },
    }),
    flow: flowSchema.parse({
      id: "booking",
      title: "Booking",
      intent: ["Book quickly"],
      setup: [],
      states: [
        { id: "state", description: "State", url: "/", expect: {} },
        {
          id: "confirmed",
          description: "Confirmed",
          url: "/confirmed",
          expect: {},
        },
      ],
    }),
    tuples: [
      {
        flow: "booking",
        state: "state",
        viewport: "desktop",
        width: 800,
        height: 600,
        metadataPath: "state/desktop/metadata.json",
        screenshotPath: "state/desktop/screenshot.png",
        artifactPaths: ["state/desktop/dom.html"],
        commit: "abc123",
        createdAt: "2026-08-14T12:00:00.000Z",
        console: [],
        mismatches: [],
      },
      {
        flow: "booking",
        state: "confirmed",
        viewport: "desktop",
        width: 800,
        height: 600,
        metadataPath: "confirmed/desktop/metadata.json",
        screenshotPath: "confirmed/desktop/screenshot.png",
        artifactPaths: ["confirmed/desktop/dom.html"],
        commit: "abc123",
        createdAt: "2026-08-14T12:00:00.000Z",
        console: [],
        mismatches: [],
      },
    ],
    priorDecisions: [],
    deterministicFindings: [],
    modelCandidateAllowance: 5,
  });
  expect(context.productMd).toBe("Product intent");
  expect(context.designMd).toBe("Design language");
  expect(context.decisionObservationAllowance).toBe(6);
  expect(context.rulingResolutions).toEqual([]);
  expect(context.references.map((reference) => reference.label)).toEqual([
    "reference:a.png",
    "reference:b.md",
    "reference:managed-density",
    "anti-reference:z.txt",
  ]);
  expect(
    context.references.find(
      (reference) => reference.label === "reference:managed-density",
    ),
  ).toMatchObject({
    kind: "image",
    note: "Use the compact density.",
    source: "https://example.test/reference",
    capturedAt: "2026-08-16T12:00:00.000Z",
  });
  expect(context.domExcerpts[0]?.content.length).toBeLessThanOrEqual(2_040);
  expect(context.domExcerpts[0]?.content).not.toContain("ignore()");
  expect(context.domExcerpts[0]?.content).not.toContain("<head>");
  expect(context.screenshots[0]).toMatchObject({
    label: "state/desktop",
    path: "state/desktop/screenshot.png",
  });
});

describe("sweep inputs", () => {
  async function withCrops(count: number): Promise<CritiqueInput> {
    const base = await input(count);
    const crops: CropRef[] = [];
    for (const screenshot of base.screenshots) {
      const readPath = `${screenshot.readPath}.zoom.png`;
      await writeFile(readPath, Buffer.from(`crop-${screenshot.label}`));
      crops.push({
        label: `${screenshot.label} zoom 1`,
        screenshot: screenshot.label,
        path: `${screenshot.state}/${screenshot.viewport}/sweep-crops/01.png`,
        readPath,
        state: screenshot.state,
        viewport: screenshot.viewport,
        rect: { x: 0, y: 0, width: 100, height: 40 },
      });
    }
    return { ...base, crops };
  }

  test("the prompt is unchanged without sweep inputs", async () => {
    const plain = await input(2);
    const prompt = critiquePrompt(plain, plain.screenshots);
    expect(
      critiquePrompt(
        { ...plain, crops: [], geometry: undefined, spec: undefined },
        plain.screenshots,
      ),
    ).toBe(prompt);
    expect(prompt).not.toContain("zoomed-crop");
    expect(prompt).not.toContain("Measured geometry");
    expect(prompt).not.toContain("spec-mismatch");
  });

  test("the prompt lists crops, geometry and the spec when present", async () => {
    const sweep = {
      ...(await withCrops(1)),
      geometry: [
        {
          label: "state-0/desktop",
          state: "state-0",
          viewport: "desktop",
          rows: [
            {
              selector: "#dot",
              role: "generic",
              name: "",
              size: "16×16",
              radius: "full",
            },
          ],
          omittedRows: 0,
          components: [],
        },
      ],
      spec: { file: "SPECS.md", content: "Dots are 8px." },
    };
    const prompt = critiquePrompt(sweep, sweep.screenshots);
    expect(prompt).toContain('"kind": "zoomed-crop"');
    expect(prompt).toContain('"magnifies": "state-0/desktop"');
    expect(prompt).toContain("## Measured geometry");
    expect(prompt).toContain('"size": "16×16"');
    expect(prompt).toContain("## Design spec (SPECS.md)\nDots are 8px.");
    expect(prompt).toContain("reference-mismatch, or spec-mismatch");
    expect(prompt).toContain("never a crop label");
  });

  test("the Anthropic adapter sends each state's crops beside its screenshots", async () => {
    const requests: AnthropicRequest[] = [];
    const adapter = new AnthropicCritiqueAdapter({
      model: "claude-sonnet-4-5-20250929",
      client: client(async (request) => {
        requests.push(request);
        return response([]);
      }),
    });
    await adapter.critique(await withCrops(4));
    const labels = requests.map((request) => {
      const content = request.messages[0]?.content;
      return Array.isArray(content)
        ? content.flatMap((block) =>
            block.type === "text" && block.text.startsWith("Image ")
              ? [block.text.replace(/^Image \d+ — /, "")]
              : [],
          )
        : [];
    });
    expect(labels).toEqual([
      [
        "state-0/desktop",
        "state-0/mobile",
        "state-0/desktop zoom 1",
        "state-0/mobile zoom 1",
        "state-1/desktop",
        "state-1/mobile",
        "state-1/desktop zoom 1",
        "state-1/mobile zoom 1",
      ],
    ]);
  });

  test("the Claude Code manifest lists crops as zoomed-crop paths", async () => {
    const critiqueInput = await withCrops(1);
    const prompts: string[] = [];
    const adapter = new ClaudeCodeCritiqueAdapter({
      model: "sonnet",
      projectDirectory: dirname(critiqueInput.screenshots[0]?.readPath ?? ""),
      runner: async (request) => {
        prompts.push(request.stdin);
        return cliResult({ findings: [] });
      },
    });
    await adapter.critique(critiqueInput);
    const manifest = prompts[0]?.split(
      "## Readable image path manifest\n\n",
    )[1];
    expect(manifest).toContain('"kind": "zoomed-crop"');
    expect(manifest).toContain(critiqueInput.crops?.[0]?.readPath ?? "missing");
  });

  test("spec-mismatch is rejected unless a spec was supplied", async () => {
    const critiqueInput = await input();
    const finding = { ...candidate, category: "spec-mismatch" as const };
    const source = JSON.stringify({ findings: [finding] });
    expect(() => parseModelResponse(source, critiqueInput.screenshots)).toThrow(
      /spec-mismatch requires a configured design spec/,
    );
    expect(
      parseModelResponse(
        source,
        critiqueInput.screenshots,
        [],
        critiqueInput.screenshots,
        "",
        true,
      ).findings,
    ).toEqual([finding]);
  });
});

describe("intended design image critique", () => {
  async function withDesign(count = 2): Promise<CritiqueInput> {
    const base = await input(count);
    const designImages: DesignImageRef[] = [];
    for (const screenshot of base.screenshots.slice(0, 1)) {
      const readPath = `${screenshot.readPath}.design.png`;
      await writeFile(readPath, Buffer.from(`design-${screenshot.label}`));
      designImages.push({
        label: `${screenshot.label}/design`,
        designFor: screenshot.label,
        path: `${screenshot.state}/${screenshot.viewport}/design/screenshot.png`,
        readPath,
        state: screenshot.state,
        viewport: screenshot.viewport,
        offset: 0,
        regions: [
          {
            id: "region-1",
            rect: { x: 40, y: 160, width: 360, height: 160 },
            elements: ["div.card"],
          },
        ],
      });
    }
    return { ...base, designImages };
  }
  const drift: ModelFindingCandidate = {
    ...candidate,
    category: "design-drift",
    selectorHint: "div.card",
    references: ["state-0/desktop/design"],
    explanation: "The card has square corners; the design rounds them.",
  };

  test("tuples carry design images only for usable image designs", () => {
    const tuple = (kind: "image" | "file") =>
      ({
        flow: "f",
        state: "home",
        viewport: "desktop",
        width: 400,
        height: 400,
        metadataPath: "home/desktop/metadata.json",
        screenshotPath: "home/desktop/screenshot.png",
        artifactPaths: [],
        commit: "c",
        createdAt: "2026-10-25T00:00:00.000Z",
        observations: {
          version: 2,
          viewport: { width: 400, height: 400 },
          elements: [],
        },
        console: [],
        mismatches: [],
        design: {
          descriptor: {
            resolved: { kind },
            status: "captured",
            coordinate: {},
          },
          screenshotPath: "home/desktop/design/screenshot.png",
          regions: {
            version: 1,
            offset: 3,
            compared: { top: 0, height: 400 },
            uncompared: [],
            regions: [],
            omitted: 0,
          },
        },
      }) as unknown as CheckTuple;
    const images = tupleDesignImages([tuple("image"), tuple("file")], "/run");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      label: "home/desktop/design",
      designFor: "home/desktop",
      readPath: "/run/home/desktop/design/screenshot.png",
      offset: 3,
    });
  });

  test("the prompt offers design-drift only when design images exist", async () => {
    const plain = await input(2);
    expect(critiquePrompt(plain, plain.screenshots)).not.toContain(
      "design-drift",
    );
    const designed = await withDesign();
    const prompt = critiquePrompt(designed, designed.screenshots);
    expect(prompt).toContain('"kind": "intended-design-image"');
    expect(prompt).toContain('"designFor": "state-0/desktop"');
    expect(prompt).toContain("## Intended design image comparison");
    expect(prompt).toContain('"div.card"');
    expect(prompt).toContain("or design-drift");
    expect(prompt).toContain("Treat the listed regions as leads, not proof.");
  });

  test("design-drift findings must cite the design image and name an element", async () => {
    const { screenshots, designImages } = await withDesign();
    const parse = (finding: ModelFindingCandidate, images = designImages) =>
      parseModelResponse(
        JSON.stringify({ findings: [finding] }),
        screenshots,
        [],
        screenshots,
        "",
        false,
        undefined,
        images,
      );
    expect(parse(drift).findings).toEqual([drift]);
    expect(() => parse({ ...drift, references: [] })).toThrow(
      /must cite the design image/,
    );
    expect(() => parse(drift, [])).toThrow(/requires an intended design image/);
    expect(() => parse({ ...drift, selectorHint: "body" })).toThrow(
      /name the departing element/,
    );
    expect(() =>
      parse({
        ...drift,
        state: "state-0",
        viewport: "mobile",
        screenshots: ["state-0/mobile"],
      }),
    ).toThrow(/requires an intended design image/);
    // Design labels are citable only by design-drift findings.
    expect(() =>
      parse({ ...candidate, references: ["state-0/desktop/design"] }),
    ).toThrow(/unknown label/);
  });

  test("the Anthropic adapter sends a design image beside its screenshot", async () => {
    const requests: AnthropicRequest[] = [];
    const adapter = new AnthropicCritiqueAdapter({
      model: "claude-sonnet-4-5-20250929",
      client: client(async (request) => {
        requests.push(request);
        return response([drift]);
      }),
    });
    const result = await adapter.critique(await withDesign());
    expect(result.findings).toEqual([drift]);
    const content = requests[0]?.messages[0]?.content;
    const labels = Array.isArray(content)
      ? content.flatMap((block) =>
          block.type === "text" && block.text.startsWith("Image ")
            ? [block.text.replace(/^Image \d+ — /, "")]
            : [],
        )
      : [];
    expect(labels).toEqual([
      "state-0/desktop",
      "state-0/mobile",
      "state-0/desktop/design",
    ]);
  });

  test("the Claude Code manifest lists design image paths", async () => {
    const critiqueInput = await withDesign();
    const prompts: string[] = [];
    const adapter = new ClaudeCodeCritiqueAdapter({
      model: "sonnet",
      projectDirectory: dirname(critiqueInput.screenshots[0]?.readPath ?? ""),
      runner: async (request) => {
        prompts.push(request.stdin);
        return cliResult({ findings: [drift] });
      },
    });
    expect((await adapter.critique(critiqueInput)).findings).toEqual([drift]);
    const manifest = prompts[0]?.split(
      "## Readable image path manifest\n\n",
    )[1];
    expect(manifest).toContain('"kind": "intended-design-image"');
    expect(manifest).toContain(
      critiqueInput.designImages?.[0]?.readPath ?? "missing",
    );
  });
});
