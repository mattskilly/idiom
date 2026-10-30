import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ClaudeCodeCritiqueAdapter } from "../src/critique/claude-code.js";
import {
  CodexCritiqueAdapter,
  CodexCritiqueError,
  codexOutputSchema,
  stripNulls,
} from "../src/critique/codex.js";
import type {
  CritiqueProcessRequest,
  CritiqueProcessRunner,
} from "../src/critique/process.js";
import {
  MalformedCritiqueError,
  modelResponseJsonSchema,
} from "../src/critique/schema.js";
import type {
  CritiqueInput,
  ModelFindingCandidate,
  ScreenshotRef,
} from "../src/critique/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

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

/** The candidate as strict mode returns it: every optional field present. */
const strictCandidate = {
  ...candidate,
  colorScheme: null,
  section: null,
  citations: null,
  fix: null,
  focus: null,
  aspect: null,
};

async function input(
  directory?: string,
  options: { screenshotName?: string } = {},
): Promise<CritiqueInput> {
  const root = directory ?? (await scratch("idiom-codex-input-"));
  const readPath = join(root, options.screenshotName ?? "0.png");
  await writeFile(readPath, Buffer.from("png-0"));
  const screenshots: ScreenshotRef[] = [
    {
      label: "state-0/desktop",
      path: "state-0/desktop/screenshot.png",
      readPath,
      state: "state-0",
      viewport: "desktop",
    },
  ];
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

function argValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || value === undefined) throw new Error(`missing ${flag}`);
  return value;
}

/** A fake Codex that writes each queued response to the -o file. */
function codexRunner(
  responses: unknown[],
  observe?: (request: CritiqueProcessRequest) => Promise<void>,
): CritiqueProcessRunner & { requests: CritiqueProcessRequest[] } {
  const requests: CritiqueProcessRequest[] = [];
  const runner = vi.fn(async (request: CritiqueProcessRequest) => {
    requests.push(request);
    await observe?.(request);
    const response = responses[requests.length - 1];
    await writeFile(
      argValue(request.args, "-o"),
      typeof response === "string" ? response : JSON.stringify(response),
    );
    return { stdout: "", stderr: "", exitCode: 0, signal: null } as const;
  });
  return Object.assign(runner, { requests });
}

type Schema = Record<string, unknown>;

function walk(schema: unknown, visit: (node: Schema) => void): void {
  if (Array.isArray(schema)) {
    for (const item of schema) walk(item, visit);
    return;
  }
  if (schema === null || typeof schema !== "object") return;
  const node = schema as Schema;
  visit(node);
  for (const key of ["items", "anyOf"]) walk(node[key], visit);
  for (const key of ["properties", "$defs", "definitions"]) {
    const children = node[key];
    if (children !== null && typeof children === "object")
      for (const child of Object.values(children)) walk(child, visit);
  }
}

const STRICT_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "anyOf",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "format",
  "description",
  "$defs",
  "definitions",
  "$ref",
  "const",
]);

describe("codexOutputSchema", () => {
  const strict = codexOutputSchema(modelResponseJsonSchema);

  test("closes every object and requires every property", () => {
    let objects = 0;
    walk(strict, (node) => {
      if (node.properties === undefined) return;
      objects += 1;
      expect(node.required).toEqual(Object.keys(node.properties as Schema));
      expect(node.additionalProperties).toBe(false);
    });
    expect(objects).toBeGreaterThanOrEqual(5);
  });

  test("turns optional properties into null unions and keeps required ones", () => {
    const finding = (
      (strict.properties as Schema).findings as { items: Schema }
    ).items.properties as Record<string, Schema>;
    for (const key of [
      "colorScheme",
      "section",
      "citations",
      "fix",
      "focus",
      "aspect",
    ])
      expect(finding[key]?.anyOf).toContainEqual({ type: "null" });
    expect(finding.rule).toEqual({ type: "string" });
    const observations = (strict.properties as Record<string, Schema>)
      .decisionObservations;
    expect(observations?.anyOf).toContainEqual({ type: "null" });
    const branch = (observations?.anyOf as Schema[] | undefined)?.[0] as
      | { items: Schema }
      | undefined;
    const observation = branch?.items.properties as Record<string, Schema>;
    for (const key of ["choiceKey", "question", "screenshot", "candidates"])
      expect(observation[key]?.anyOf).toContainEqual({ type: "null" });
  });

  test("uses only strict-mode keywords with an object root", () => {
    expect(strict.type).toBe("object");
    expect(strict.anyOf).toBeUndefined();
    walk(strict, (node) => {
      for (const key of Object.keys(node))
        expect(STRICT_KEYWORDS, `unsupported keyword ${key}`).toContain(key);
    });
    const text = JSON.stringify(strict);
    expect(text).not.toContain("minLength");
    expect(text).not.toContain("maxLength");
    expect(text).not.toContain("$schema");
  });
});

test("stripNulls drops null keys at every depth and keeps arrays", () => {
  expect(
    stripNulls({
      a: null,
      b: [1, null, { c: null, d: "kept" }],
      e: { f: null, g: { h: null, i: 0 } },
    }),
  ).toEqual({ b: [1, null, { d: "kept" }], e: { g: { i: 0 } } });
});

describe("Codex critique adapter", () => {
  test("drives read-only codex exec with every image attached in manifest order", async () => {
    const project = await scratch("idiom-codex-project-");
    const critiqueInput = await input(project);
    const screenshot = critiqueInput.screenshots[0];
    if (screenshot === undefined) throw new Error("missing screenshot");
    // Project-relative paths resolve against the project directory.
    await writeFile(join(project, "reference.png"), "reference");
    await writeFile(join(project, "crop.png"), "crop");
    await writeFile(join(project, "design.png"), "design");
    critiqueInput.references.push(
      {
        label: "reference:checkout shell",
        polarity: "reference",
        kind: "image",
        readPath: "reference.png",
        mediaType: "image/png",
        sourceKind: "file",
        source: "reference.png",
      },
      {
        label: "anti-reference:saas-chrome.txt",
        polarity: "anti-reference",
        kind: "text",
        content: "Avoid booking-widget chrome.",
      },
    );
    critiqueInput.crops = [
      {
        label: "state-0/desktop/crop-1",
        screenshot: "state-0/desktop",
        path: "crop.png",
        readPath: "crop.png",
        state: "state-0",
        viewport: "desktop",
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
    ];
    critiqueInput.designImages = [
      {
        label: "state-0/desktop/design",
        designFor: "state-0/desktop",
        path: "design.png",
        readPath: "design.png",
        state: "state-0",
        viewport: "desktop",
        offset: 0,
        regions: [],
      },
    ];
    let schemaDuringCall: unknown;
    const runner = codexRunner([{ findings: [strictCandidate] }], async (r) => {
      schemaDuringCall = JSON.parse(
        await readFile(argValue(r.args, "--output-schema"), "utf8"),
      );
    });
    const adapter = new CodexCritiqueAdapter({
      model: "gpt-configured",
      projectDirectory: project,
      environment: { PATH: "/example/bin", ANTHROPIC_API_KEY: "sk-ant-nope" },
      runner,
    });
    await expect(adapter.critique(critiqueInput)).resolves.toEqual({
      findings: [candidate],
      decisionObservations: [],
      discardedDecisionObservations: 0,
    });
    const request = runner.requests[0];
    if (request === undefined) throw new Error("no request");
    expect(request.executable).toBe("codex");
    expect(request.cwd).toBe(project);
    expect(request.environment.PATH).toBe("/example/bin");
    expect(request.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    const tmp = dirname(argValue(request.args, "-o"));
    expect(request.args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-C",
      project,
      "--model",
      "gpt-configured",
      "--output-schema",
      join(tmp, "schema.json"),
      "-o",
      join(tmp, "last-message.json"),
      "--image",
      screenshot.readPath,
      "--image",
      join(project, "reference.png"),
      "--image",
      join(project, "crop.png"),
      "--image",
      join(project, "design.png"),
    ]);
    expect(schemaDuringCall).toEqual(
      codexOutputSchema(modelResponseJsonSchema),
    );
    expect(request.stdin).toContain("## Attached image manifest");
    expect(request.stdin).toContain('"attachment": 4');
    expect(request.stdin).toContain("anti-reference:saas-chrome.txt");
    expect(request.stdin).toContain("Avoid booking-widget chrome.");
    expect(request.label).toBe("Codex");
    await expect(access(tmp)).rejects.toThrow();
  });

  test("returns what the Claude adapter returns for the same response", async () => {
    const critiqueInput = await input();
    const claude = new ClaudeCodeCritiqueAdapter({
      model: "m",
      projectDirectory: process.cwd(),
      runner: async () => ({
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { findings: [candidate] },
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      }),
    });
    const codex = new CodexCritiqueAdapter({
      model: "m",
      projectDirectory: process.cwd(),
      runner: codexRunner([{ findings: [strictCandidate] }]),
    });
    expect(await codex.critique(critiqueInput)).toEqual(
      await claude.critique(critiqueInput),
    );
  });

  test("repairs one locally invalid response, then gives up", async () => {
    const invalid = { ...strictCandidate, screenshots: ["unknown/mobile"] };
    const repaired = codexRunner([
      { findings: [invalid] },
      { findings: [strictCandidate] },
    ]);
    await expect(
      new CodexCritiqueAdapter({
        model: "m",
        projectDirectory: process.cwd(),
        runner: repaired,
      }).critique(await input()),
    ).resolves.toMatchObject({ findings: [candidate] });
    expect(repaired.requests).toHaveLength(2);
    expect(repaired.requests[1]?.stdin).toContain(
      "## Rejected structured output",
    );
    expect(repaired.requests[1]?.stdin).toContain("## Local validation issues");

    const broken = codexRunner([
      { findings: [invalid] },
      { findings: [invalid] },
    ]);
    await expect(
      new CodexCritiqueAdapter({
        model: "m",
        projectDirectory: process.cwd(),
        runner: broken,
      }).critique(await input()),
    ).rejects.toBeInstanceOf(MalformedCritiqueError);
    expect(broken.requests).toHaveLength(2);
  });

  test.each([
    [
      "missing executable",
      async () => Promise.reject(new Error("spawn codex ENOENT")),
    ],
    [
      "nonzero auth failure",
      async () => ({
        stdout: "",
        stderr: `${"progress\n".repeat(500)}401 Unauthorized: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXsecret`,
        exitCode: 1,
        signal: null,
      }),
    ],
    [
      "missing final message",
      async () => ({ stdout: "", stderr: "", exitCode: 0, signal: null }),
    ],
    [
      "malformed final message",
      async (request: CritiqueProcessRequest) => {
        await writeFile(argValue(request.args, "-o"), "not json");
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      },
    ],
  ] as const)(
    "turns %s into a sanitized typed failure",
    async (_label, implementation) => {
      const failure = await new CodexCritiqueAdapter({
        model: "m",
        projectDirectory: process.cwd(),
        runner: implementation as CritiqueProcessRunner,
      })
        .critique(await input())
        .catch((error) => error);
      expect(failure).toBeInstanceOf(CodexCritiqueError);
      expect(String(failure)).toContain("codex login");
      expect(String(failure)).not.toContain("secret");
    },
  );

  test("keeps the tail of noisy stderr, redacted", async () => {
    const failure = await new CodexCritiqueAdapter({
      model: "m",
      projectDirectory: process.cwd(),
      runner: async () => ({
        stdout: "",
        stderr: `${"progress\n".repeat(500)}401 Unauthorized: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXsecret`,
        exitCode: 1,
        signal: null,
      }),
    })
      .critique(await input())
      .catch((error) => error);
    expect(failure.detail).toContain("exit 1");
    expect(failure.detail).toContain("401 Unauthorized: [redacted]");
  });

  test("zero screenshots run nothing", async () => {
    const runner = codexRunner([]);
    const critiqueInput = await input();
    critiqueInput.screenshots = [];
    await expect(
      new CodexCritiqueAdapter({
        model: "m",
        projectDirectory: process.cwd(),
        runner,
      }).critique(critiqueInput),
    ).resolves.toEqual({
      findings: [],
      decisionObservations: [],
      discardedDecisionObservations: 0,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  test("attaches a copy of an image whose path contains a comma", async () => {
    const critiqueInput = await input(undefined, {
      screenshotName: "a,b.png",
    });
    const runner = codexRunner([{ findings: [] }], async (request) => {
      const image = argValue(request.args, "--image");
      expect(image).not.toContain(",");
      expect(isAbsolute(image)).toBe(true);
      expect(dirname(image)).toBe(dirname(argValue(request.args, "-o")));
      expect(await readFile(image, "utf8")).toBe("png-0");
    });
    await new CodexCritiqueAdapter({
      model: "m",
      projectDirectory: process.cwd(),
      runner,
    }).critique(critiqueInput);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
