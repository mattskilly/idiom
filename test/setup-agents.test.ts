import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type CritiqueProcessRequest,
  type CritiqueProcessRunner,
  CritiqueProcessTimeoutError,
} from "../src/critique/process.js";
import { CLI_PROVIDER_EXECUTABLES } from "../src/critique/provider.js";
import { probeSetupAgents, setupAgentOrder } from "../src/setup/agents.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-setup-agents-"));
  directories.push(directory);
  return directory;
}

test("setup agents are the CLI critique providers and spawn their executables", () => {
  expect(CLI_PROVIDER_EXECUTABLES).toEqual({
    "claude-code": "claude",
    codex: "codex",
  });
});

test("probes run --version through the injected runner and keep the requested order", async () => {
  const requests: CritiqueProcessRequest[] = [];
  const runner: CritiqueProcessRunner = async (request) => {
    requests.push(request);
    return request.executable === "codex"
      ? {
          stdout: "codex-cli 1.2.3\nmore",
          stderr: "",
          exitCode: 0,
          signal: null,
        }
      : { stdout: "", stderr: "bad install\n", exitCode: 2, signal: null };
  };
  const probes = await probeSetupAgents({
    order: ["codex", "claude-code"],
    cwd: "/project",
    environment: { PATH: "/bin" },
    runner,
  });
  expect(probes).toEqual([
    { agent: "codex", usable: true, reason: "codex-cli 1.2.3" },
    {
      agent: "claude-code",
      usable: false,
      reason: "claude --version exited 2: bad install",
    },
  ]);
  expect(requests.map((request) => request.args)).toEqual([
    ["--version"],
    ["--version"],
  ]);
  expect(requests[0]).toMatchObject({
    cwd: "/project",
    stdin: "",
    environment: { PATH: "/bin" },
    label: "Codex",
  });
  expect(requests[0]?.timeoutMs).toBeGreaterThan(0);
});

test("a missing binary and a timed-out probe are not usable", async () => {
  const runner: CritiqueProcessRunner = async (request) => {
    if (request.executable === "claude")
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    throw new CritiqueProcessTimeoutError("Codex", 10);
  };
  const probes = await probeSetupAgents({
    order: ["claude-code", "codex"],
    cwd: "/project",
    environment: {},
    runner,
    timeoutMs: 10,
  });
  expect(probes[0]).toEqual({
    agent: "claude-code",
    usable: false,
    reason: "claude not found on PATH",
  });
  expect(probes[1]?.usable).toBe(false);
  expect(probes[1]?.reason).toContain("Codex did not finish within");
});

test("preference follows the configured critique provider", async () => {
  const directory = await temporary();
  expect(await setupAgentOrder(directory)).toEqual(["claude-code", "codex"]);
  await mkdir(join(directory, ".idiom"));
  const projectFile = join(directory, ".idiom", "project.json");
  await writeFile(projectFile, "{ not json");
  expect(await setupAgentOrder(directory)).toEqual(["claude-code", "codex"]);
  await writeFile(
    projectFile,
    JSON.stringify({ model: { provider: "codex", model: "x" } }),
  );
  expect(await setupAgentOrder(directory)).toEqual(["codex", "claude-code"]);
  await writeFile(
    projectFile,
    JSON.stringify({
      model: {
        provider: "anthropic",
        model: "x",
        fallback: { provider: "codex", model: "y" },
      },
    }),
  );
  expect(await setupAgentOrder(directory)).toEqual(["codex", "claude-code"]);
  await writeFile(
    projectFile,
    JSON.stringify({ model: { provider: "claude-code", model: "x" } }),
  );
  expect(await setupAgentOrder(directory)).toEqual(["claude-code", "codex"]);
});

test.skipIf(process.platform === "win32")(
  "injected binaries on PATH: a working CLI is usable, a failing or missing one is not",
  async () => {
    const bin = await temporary();
    await writeFile(
      join(bin, "claude"),
      "#!/bin/sh\necho '2.1.0 (Claude Code)'\nexit 0\n",
    );
    await writeFile(join(bin, "codex"), "#!/bin/sh\necho broken >&2\nexit 1\n");
    await chmod(join(bin, "claude"), 0o755);
    await chmod(join(bin, "codex"), 0o755);
    const probes = await probeSetupAgents({
      order: ["claude-code", "codex"],
      cwd: bin,
      environment: { PATH: bin },
    });
    expect(probes).toEqual([
      { agent: "claude-code", usable: true, reason: "2.1.0 (Claude Code)" },
      {
        agent: "codex",
        usable: false,
        reason: "codex --version exited 1: broken",
      },
    ]);

    const empty = await temporary();
    const missing = await probeSetupAgents({
      order: ["claude-code"],
      cwd: empty,
      environment: { PATH: empty },
    });
    expect(missing).toEqual([
      {
        agent: "claude-code",
        usable: false,
        reason: "claude not found on PATH",
      },
    ]);
  },
);
