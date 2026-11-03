import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CritiqueProcessTimeoutError,
  runClaudeCode,
} from "../src/critique/claude-code.js";

// Every adapter test injects a fake runner; these drive the production
// `runClaudeCode` against real local node children, so no Claude Code
// install, credentials, or network are involved.
function helper(
  script: string,
  stdin = "",
  extra: { args?: string[]; label?: string; maxStderrBytes?: number } = {},
) {
  return {
    executable: process.execPath,
    args: ["-e", script],
    cwd: tmpdir(),
    environment: process.env,
    stdin,
    // Safety net so a regression fails instead of hanging the suite.
    timeoutMs: 20_000,
    ...extra,
  };
}

async function settle<T>(
  promise: Promise<T>,
): Promise<{ value?: T; error?: unknown; elapsedMs: number }> {
  const started = Date.now();
  try {
    const value = await promise;
    return { value, elapsedMs: Date.now() - started };
  } catch (error) {
    return { error, elapsedMs: Date.now() - started };
  }
}

const idle = "setInterval(() => {}, 1000);";

describe("runClaudeCode against real child processes", () => {
  test("delivers large multi-chunk stdin whole", async () => {
    const input = `${"y".repeat(4 * 1024 * 1024)}END\n📌`;
    const script = [
      "const chunks = [];",
      "process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => {",
      "  const all = Buffer.concat(chunks);",
      "  process.stdout.write(JSON.stringify({",
      "    bytes: all.length,",
      "    tail: all.subarray(all.length - 8).toString('utf8'),",
      "  }));",
      "});",
    ].join("\n");

    const result = await runClaudeCode(helper(script, input));

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    const parsed = JSON.parse(result.stdout) as { bytes: number; tail: string };
    expect(parsed.bytes).toBe(Buffer.byteLength(input));
    expect(parsed.tail.endsWith("END\n📌")).toBe(true);
  });

  test("returns stdout and stderr from a normal exit", async () => {
    const script =
      "process.stdout.write('out-line\\n'); process.stderr.write('warn-line\\n');";

    await expect(runClaudeCode(helper(script))).resolves.toEqual({
      stdout: "out-line\n",
      stderr: "warn-line\n",
      exitCode: 0,
      signal: null,
    });
  });

  test("passes arguments verbatim, without a shell", async () => {
    const script =
      "process.stdout.write(JSON.stringify(process.argv.slice(1)));";
    const result = await runClaudeCode(
      helper(script, "", { args: ["-e", script, "--", "a b", "$HOME"] }),
    );

    expect(JSON.parse(result.stdout)).toEqual(["a b", "$HOME"]);
  });

  test("resolves a nonzero exit with its output for the caller to inspect", async () => {
    const script =
      "process.stdout.write('partial'); process.stderr.write('boom'); process.exit(7);";

    await expect(runClaudeCode(helper(script))).resolves.toEqual({
      stdout: "partial",
      stderr: "boom",
      exitCode: 7,
      signal: null,
    });
  });

  test("resolves a signalled exit with the signal", async () => {
    const script =
      "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);";

    await expect(runClaudeCode(helper(script))).resolves.toEqual({
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: "SIGTERM",
    });
  });

  test("rejects with ENOENT when the executable does not exist", async () => {
    const missing = join(
      tmpdir(),
      `idiom-no-such-claude-${process.pid}-${Date.now()}`,
    );
    const outcome = await settle(
      runClaudeCode({ ...helper(""), executable: missing, args: [] }),
    );

    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  test("kills a child whose stdout exceeds the 1 MiB ceiling", async () => {
    const script = `process.stdout.write('a'.repeat(2 * 1024 * 1024)); ${idle}`;
    const outcome = await settle(runClaudeCode(helper(script)));

    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).not.toBeInstanceOf(CritiqueProcessTimeoutError);
    expect((outcome.error as Error).message).toBe(
      "Claude Code stdout exceeded 1048576 bytes",
    );
    expect(outcome.elapsedMs).toBeLessThan(10_000);
  });

  test("names the configured tool in the overflow failure", async () => {
    const script = `process.stdout.write('a'.repeat(2 * 1024 * 1024)); ${idle}`;
    const outcome = await settle(
      runClaudeCode(helper(script, "", { label: "Codex" })),
    );

    expect((outcome.error as Error).message).toBe(
      "Codex stdout exceeded 1048576 bytes",
    );
  });

  test("kills a child whose stderr exceeds its budget", async () => {
    const script = `process.stderr.write('e'.repeat(100)); ${idle}`;
    const outcome = await settle(
      runClaudeCode(helper(script, "", { maxStderrBytes: 10 })),
    );

    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).not.toBeInstanceOf(CritiqueProcessTimeoutError);
    expect((outcome.error as Error).message).toBe(
      "Claude Code stderr exceeded 10 bytes",
    );
    expect(outcome.elapsedMs).toBeLessThan(10_000);
  });

  test("reports an ordinary exit when the child leaves small input unread", async () => {
    const script = "process.stdout.write('bye'); process.exit(3);";

    await expect(
      runClaudeCode(helper(script, "unread input")),
    ).resolves.toEqual({
      stdout: "bye",
      stderr: "",
      exitCode: 3,
      signal: null,
    });
  });

  test("settles promptly when the child exits before reading input larger than the pipe", async () => {
    const script = "process.stdout.write('bye'); process.exit(3);";
    const outcome = await settle(
      runClaudeCode(helper(script, "x".repeat(8 * 1024 * 1024))),
    );

    // Pins today's behavior: the stdin write fails with EPIPE and the runner
    // rejects rather than reporting exit 3. A deliberate change to the runner
    // should update this.
    expect(outcome.elapsedMs).toBeLessThan(10_000);
    expect((outcome.error as NodeJS.ErrnoException).code).toBe("EPIPE");
  });
});
