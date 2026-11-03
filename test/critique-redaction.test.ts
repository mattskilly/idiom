import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AnthropicCritiqueAdapter,
  type MessageClient,
  requireAnthropicApiKey,
} from "../src/critique/anthropic.js";
import {
  ClaudeCodeCritiqueAdapter,
  ClaudeCodeCritiqueError,
} from "../src/critique/claude-code.js";
import { sanitizeCritiqueDiagnostic } from "../src/critique/process.js";
import {
  claudeCodeDegradationReason,
  describeCritiqueFailure,
  safeDegradationReason,
} from "../src/critique/provider.js";
import {
  MISSING_ANTHROPIC_API_KEY_MESSAGE,
  redactCredentials,
} from "../src/critique/redact.js";
import type { CritiqueInput } from "../src/critique/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const FALLBACK_CLAUSE =
  "ANTHROPIC_API_KEY is not set for the explicit direct-API fallback, or configure model.fallback";

const credentials: Array<{ name: string; text: string; secret: string }> = [
  {
    name: "Anthropic key",
    text: "failed with sk-ant-api03-abcDEF123_secret",
    secret: "abcDEF123_secret",
  },
  {
    name: "project key",
    text: "token sk-proj-ABCDEFGHIJKLMNOPQRSTUV123 rejected",
    secret: "ABCDEFGHIJKLMNOPQRSTUV123",
  },
  { name: "api_key=", text: "400 api_key=hunter2-value", secret: "hunter2" },
  { name: "API-KEY:", text: "API-KEY: hunter2-value bad", secret: "hunter2" },
  {
    name: "access_token=",
    text: "access_token=tok.en-value expired",
    secret: "tok.en-value",
  },
  {
    name: "authorization bearer",
    text: "authorization: Bearer abc.def-ghi denied",
    secret: "abc.def-ghi",
  },
  { name: "bare bearer", text: "bearer abc.def-ghi denied", secret: "abc.def" },
];

const equivalenceInputs = [
  ...credentials.map(({ text }) => text),
  MISSING_ANTHROPIC_API_KEY_MESSAGE,
  "upstream   said:\n\tapi_key=hunter2-value   and\n\nbearer xyz-123  again",
];

async function input(): Promise<CritiqueInput> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-redaction-"));
  directories.push(directory);
  const readPath = join(directory, "0.png");
  await writeFile(readPath, Buffer.from("png-0"));
  return {
    flow: "booking",
    intent: ["Booking is obvious in one screen."],
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

async function anthropicFailure(
  text: string,
  path: "initial" | "repair",
): Promise<Error> {
  const create = vi.fn(async () => {
    if (path === "repair" && create.mock.calls.length === 1) {
      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "not json" }],
      };
    }
    throw new Error(text);
  });
  const client: MessageClient = { messages: { create } };
  const adapter = new AnthropicCritiqueAdapter({ model: "m", client });
  const error = await adapter.critique(await input()).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("shared credential redaction policy", () => {
  test.each(credentials)("redacts $name", ({ text, secret }) => {
    const redacted = redactCredentials(text);
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain(secret);
  });

  test("leaves the missing-configuration diagnostics readable", () => {
    expect(redactCredentials(MISSING_ANTHROPIC_API_KEY_MESSAGE)).toBe(
      MISSING_ANTHROPIC_API_KEY_MESSAGE,
    );
    expect(redactCredentials(FALLBACK_CLAUSE)).toBe(FALLBACK_CLAUSE);
    expect(redactCredentials("api_key is not set")).toBe("api_key is not set");
    expect(redactCredentials("api_key=abc is not set")).toBe(
      "[redacted] is not set",
    );
  });

  test("is idempotent", () => {
    for (const text of equivalenceInputs) {
      const once = redactCredentials(text);
      expect(redactCredentials(once)).toBe(once);
    }
  });
});

describe("model-review degradation callers share one sanitizer", () => {
  test.each(equivalenceInputs)("renders %j identically", async (text) => {
    const expected = sanitizeCritiqueDiagnostic(new Error(text));
    expect(safeDegradationReason(new Error(text))).toBe(expected);
    expect(describeCritiqueFailure(new Error(text), {})).toBe(expected);

    const initial = await anthropicFailure(text, "initial");
    expect(initial.message).toBe(`Anthropic model "m" failed: ${expected}`);
    const repair = await anthropicFailure(text, "repair");
    expect(repair.message).toBe(
      `Anthropic model "m" repair failed: ${expected}`,
    );
    for (const error of [initial, repair]) {
      expect(describeCritiqueFailure(error, {})).toBe(
        safeDegradationReason(error),
      );
    }

    const adapter = new ClaudeCodeCritiqueAdapter({
      model: "sonnet",
      projectDirectory: tmpdir(),
      environment: {},
      runner: async () => ({
        stdout: "",
        stderr: text,
        exitCode: 1,
        signal: null,
      }),
    });
    const cliError = await adapter.critique(await input()).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(cliError).toBeInstanceOf(ClaudeCodeCritiqueError);
    expect(claudeCodeDegradationReason(cliError, {})).toContain(expected);
  });

  test.each(credentials)(
    "keeps $name out of every rendering",
    async ({ text, secret }) => {
      const rendered = [
        safeDegradationReason(new Error(text)),
        describeCritiqueFailure(await anthropicFailure(text, "initial"), {}),
        describeCritiqueFailure(await anthropicFailure(text, "repair"), {}),
        claudeCodeDegradationReason(new ClaudeCodeCritiqueError(text), {}),
        claudeCodeDegradationReason(
          new ClaudeCodeCritiqueError(text, { kind: "execution" }),
          {},
        ),
      ];
      for (const reason of rendered) expect(reason).not.toContain(secret);
    },
  );
});

describe("missing-configuration diagnostic", () => {
  test("stays readable through every rendering path", () => {
    let missing: unknown;
    try {
      requireAnthropicApiKey({});
    } catch (error) {
      missing = error;
    }
    expect(missing).toBeInstanceOf(Error);
    expect((missing as Error).message).toBe("ANTHROPIC_API_KEY is not set");
    expect(describeCritiqueFailure(missing, {})).toBe(
      "ANTHROPIC_API_KEY is not set",
    );
    expect(
      claudeCodeDegradationReason(new ClaudeCodeCritiqueError("x"), {}),
    ).toContain(
      "ANTHROPIC_API_KEY is not set for the explicit direct-API fallback",
    );
  });
});
