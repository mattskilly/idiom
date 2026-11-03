import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  CritiqueProcessTimeoutError,
  formatCritiqueTimeout,
  runCritiqueProcess,
} from "../src/critique/process.js";

const directories: string[] = [];
const strays: number[] = [];

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-critique-process-"));
  directories.push(directory);
  return directory;
}

function nodeRequest(script: string, timeoutMs: number, stdin = "") {
  return {
    executable: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    environment: process.env,
    stdin,
    label: "Claude Code",
    timeoutMs,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(pid: number, budgetMs = 2000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

describe("runCritiqueProcess wall-clock bound", () => {
  test("formats the bound for failure wording", () => {
    expect(formatCritiqueTimeout(600_000)).toBe("10 minutes");
    expect(formatCritiqueTimeout(60_000)).toBe("1 minute");
    expect(formatCritiqueTimeout(1500)).toBe("2 seconds");
    expect(formatCritiqueTimeout(1000)).toBe("1 second");
    expect(formatCritiqueTimeout(500)).toBe("500 ms");
  });

  test("kills a child that ignores SIGTERM and rejects with a timeout", async () => {
    const directory = await scratch();
    const pidFile = join(directory, "child.pid");
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const started = Date.now();
    const failure = await runCritiqueProcess(nodeRequest(script, 1500)).catch(
      (error: unknown) => error,
    );
    expect(Date.now() - started).toBeLessThan(6000);
    expect(failure).toBeInstanceOf(CritiqueProcessTimeoutError);
    expect((failure as CritiqueProcessTimeoutError).timeoutMs).toBe(1500);
    expect(String(failure)).toContain("Claude Code did not finish within");
    const pid = Number(await readFile(pidFile, "utf8"));
    strays.push(pid);
    expect(await waitForExit(pid)).toBe(true);
  });

  test("settles even when a grandchild keeps the pipes open", async () => {
    const directory = await scratch();
    const pidFile = join(directory, "grandchild.pid");
    const script = [
      'const { spawn } = require("node:child_process");',
      `const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });`,
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const started = Date.now();
    const failure = await runCritiqueProcess(nodeRequest(script, 1000)).catch(
      (error: unknown) => error,
    );
    try {
      expect(failure).toBeInstanceOf(CritiqueProcessTimeoutError);
      expect(Date.now() - started).toBeLessThan(6000);
    } finally {
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (pid > 0) strays.push(pid);
    }
  });

  test("a normal completion resolves unchanged under a bound", async () => {
    const script =
      'process.stdin.on("data", (chunk) => process.stdout.write(chunk));';
    await expect(
      runCritiqueProcess(nodeRequest(script, 10_000, "echoed input")),
    ).resolves.toEqual({
      stdout: "echoed input",
      stderr: "",
      exitCode: 0,
      signal: null,
    });
  });
});

test("onStdout sees stdout as it streams, multi-byte characters whole", async () => {
  const chunks: string[] = [];
  const script =
    'const b = Buffer.from("pin 📌\\n"); process.stdout.write(b.subarray(0, 6)); setTimeout(() => process.stdout.write(b.subarray(6)), 50);';
  const result = await runCritiqueProcess({
    ...nodeRequest(script, 10_000),
    onStdout: (chunk) => chunks.push(chunk),
  });
  expect(result.stdout).toBe("pin 📌\n");
  expect(chunks.join("")).toBe("pin 📌\n");
  expect(chunks.every((chunk) => !chunk.includes("�"))).toBe(true);
});
