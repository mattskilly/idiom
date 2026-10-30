import { expect, test, vi } from "vitest";
import { runClaudeCode } from "../src/critique/claude-code.js";
import { mergeText } from "../src/skills/merge.js";
import {
  createResolver,
  type ResolveInput,
  type ResolverClient,
} from "../src/skills/resolver.js";
import { temporary } from "./skill-support.js";

async function input(): Promise<ResolveInput> {
  return {
    projectDirectory: await temporary(),
    path: ".agents/skills/idiom/init.md",
    base: "base\n",
    local: "local\n",
    incoming: "upstream\n",
    merge: await mergeText("base\n", "local\n", "upstream\n"),
  };
}
const proposal = {
  decision: "resolve",
  replacements: [{ id: "hunk-1", text: "local\n" }],
  reason: "preserve local",
};
const configuration = (provider: "claude-code" | "anthropic") => async () => ({
  project: { model: { provider, model: "configured-model" } },
});
test("Claude Code uses configured model, schema and tool-free subscription transport with key removed", async () => {
  const runner = vi.fn(async (request) => {
    expect(request.executable).toBe("claude");
    expect(request.args).toContain("--safe-mode");
    expect(request.args).toContain("--no-session-persistence");
    expect(request.args[request.args.indexOf("--tools") + 1]).toBe("");
    expect(request.args[request.args.indexOf("--model") + 1]).toBe(
      "configured-model",
    );
    expect(
      JSON.parse(request.args[request.args.indexOf("--json-schema") + 1]),
    ).toMatchObject({ additionalProperties: false });
    expect(request.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(request.stdin).toContain("untrusted data");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        structured_output: proposal,
      }),
      stderr: "",
      exitCode: 0,
      signal: null,
    };
  });
  const createClient = vi.fn();
  expect(
    await createResolver({
      configuration: configuration("claude-code"),
      runner,
      createClient,
      environment: {
        ANTHROPIC_API_KEY: "never-pass-me",
        PATH: process.env.PATH,
      },
    })(await input()),
  ).toEqual(proposal);
  expect(runner).toHaveBeenCalledOnce();
  expect(createClient).not.toHaveBeenCalled();
});
test.each([
  "non-success",
  "missing-output",
  "malformed",
  "exit",
  "signal",
  "unavailable",
])("Claude Code %s safely fails without provider fallback", async (mode) => {
  const createClient = vi.fn();
  const resolver = createResolver({
    configuration: configuration("claude-code"),
    createClient,
    runner: async () => {
      if (mode === "unavailable")
        throw new Error("api key=secret-token unavailable");
      return {
        stdout:
          mode === "malformed"
            ? "```json\n{}"
            : JSON.stringify({
                type: "result",
                subtype: mode === "non-success" ? "error_max_turns" : "success",
                ...(mode === "missing-output"
                  ? {}
                  : { structured_output: proposal }),
              }),
        stderr: "private raw output",
        exitCode: mode === "exit" ? 1 : 0,
        signal: mode === "signal" ? "SIGTERM" : null,
      };
    },
  });
  await expect(resolver(await input())).rejects.toThrow();
  expect(createClient).not.toHaveBeenCalled();
});
test("Anthropic request uses schema, exact model, key and cancellation, with no tools", async () => {
  const create = vi.fn<ResolverClient["messages"]["create"]>(
    async (request, options) => {
      expect(request.model).toBe("configured-model");
      expect(request.output_config?.format?.type).toBe("json_schema");
      expect(request.tools).toBeUndefined();
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(proposal) }],
      };
    },
  );
  const createClient = vi.fn((key) => {
    expect(key).toBe("test-key");
    return { messages: { create } };
  });
  const runner = vi.fn();
  expect(
    await createResolver({
      configuration: configuration("anthropic"),
      createClient,
      runner,
      environment: { ANTHROPIC_API_KEY: "test-key" },
    })(await input()),
  ).toEqual(proposal);
  expect(create).toHaveBeenCalledOnce();
  expect(runner).not.toHaveBeenCalled();
});
test("explicit Anthropic requires a key even when client factory is injected", async () => {
  const createClient = vi.fn();
  await expect(
    createResolver({
      configuration: configuration("anthropic"),
      createClient,
      environment: {},
    })(await input()),
  ).rejects.toThrow("ANTHROPIC_API_KEY is not set");
  expect(createClient).not.toHaveBeenCalled();
});
test.each([
  "refusal",
  "max_tokens",
  "malformed",
  "extra-field",
  "missing-field",
  "empty",
  "throws",
])("Anthropic %s fails safely", async (mode) => {
  const resolver = createResolver({
    configuration: configuration("anthropic"),
    environment: { ANTHROPIC_API_KEY: "test" },
    createClient: () => ({
      messages: {
        create: async () => {
          if (mode === "throws")
            throw new Error("Authorization: Bearer private-token");
          const result =
            mode === "extra-field"
              ? { ...proposal, extra: true }
              : mode === "missing-field"
                ? { decision: "resolve" }
                : proposal;
          return {
            stop_reason: ["refusal", "max_tokens"].includes(mode)
              ? mode
              : "end_turn",
            content: [
              {
                type: "text",
                text:
                  mode === "malformed"
                    ? "no json"
                    : mode === "empty"
                      ? ""
                      : JSON.stringify(result),
              },
            ],
          };
        },
      },
    }),
  });
  await expect(resolver(await input())).rejects.toThrow();
});
test.each(["claude-code", "anthropic"] as const)(
  "%s timeout aborts the underlying transport",
  async (provider) => {
    let aborted = false;
    const wait = (signal: AbortSignal | undefined) =>
      new Promise<never>((_accept, reject) =>
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      );
    const resolver = createResolver({
      configuration: configuration(provider),
      timeoutMs: 10,
      environment: { ANTHROPIC_API_KEY: "key" },
      runner: (request) => wait(request.signal),
      createClient: () => ({
        messages: { create: (_request, options) => wait(options.signal) },
      }),
    });
    await expect(resolver(await input())).rejects.toThrow("timed out");
    expect(aborted).toBe(true);
  },
);
test("shared Claude runner kills and joins an aborted real child", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await expect(
      runClaudeCode({
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: await temporary(),
        environment: process.env,
        stdin: "",
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  } finally {
    clearTimeout(timer);
  }
});

test("default project configuration routes resolution to Claude Code without a key or flow files", async () => {
  const request = await input();
  const { readTemplate } = await import("../src/templates.js");
  const { put } = await import("./skill-support.js");
  await put(
    request.projectDirectory,
    ".idiom/project.json",
    await readTemplate("project.json"),
  );
  const runner = vi.fn(async (invocation) => {
    expect(invocation.environment.ANTHROPIC_API_KEY).toBeUndefined();
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        structured_output: proposal,
      }),
      stderr: "",
      exitCode: 0,
      signal: null,
    };
  });
  expect(await createResolver({ runner, environment: {} })(request)).toEqual(
    proposal,
  );
  expect(runner).toHaveBeenCalledOnce();
});
