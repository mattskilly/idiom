import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { snapshotSource } from "../src/capture/resolve.js";
import type { BrowserLauncher, TupleResult } from "../src/capture/types.js";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { instructionCommand } from "../src/commands/instruction.js";
import { ClaudeCodeCritiqueError } from "../src/critique/claude-code.js";
import type {
  CritiqueInput,
  ModelFindingCandidate,
} from "../src/critique/types.js";
import { appendDecision } from "../src/decisions/log.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { IDIOM_VERSION_DISPLAY } from "../src/version.js";

import { productionFixture } from "./production-support.js";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error === undefined ? accept() : reject(error))),
  );
  return address.port;
}

async function captureFixture(
  failed: boolean,
  maxFindings = 5,
  provider: "claude-code" | "anthropic" | "codex" = "anthropic",
  fallback?: { provider: "claude-code" | "anthropic" | "codex"; model: string },
) {
  const directory = await mkdtemp(join(tmpdir(), "idiom-cli-capture-"));
  temporaryDirectories.push(directory);
  await initProject({ project: directory, yes: true });
  const port = await freePort();
  const serverScript = join(
    import.meta.dirname,
    "fixtures",
    "capture",
    "server.mjs",
  );
  await writeFile(
    join(directory, ".idiom", "project.json"),
    JSON.stringify({
      version: 1,
      app: { name: "fixture", framework: "other" },
      server: {
        build: "node -e 0",
        start: `node ${JSON.stringify(serverScript)}`,
        readyUrl: `http://127.0.0.1:${port}/`,
        port,
        env: { PORT: String(port) },
        startupTimeoutMs: 5_000,
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: {},
      design: {},
      model: {
        provider,
        model: "unused",
        maxFindings,
        ...(fallback === undefined ? {} : { fallback }),
      },
    }),
  );
  await writeFile(
    join(directory, ".idiom", "flows", "fixture.json"),
    JSON.stringify({
      id: "fixture",
      title: "Fixture",
      intent: [],
      setup: [],
      states: [{ id: "state", description: "State", url: "/", expect: {} }],
    }),
  );
  const browserLauncher: BrowserLauncher = async () => ({
    version: "Mock Chromium",
    async capture(): Promise<TupleResult> {
      return {
        ok: true,
        status: 200,
        dom: "<html></html>",
        screenshot: Buffer.from("png"),
        console: [],
        axe: { violations: [] },
        observations: {
          version: 1,
          viewport: { width: 800, height: 600 },
          document: {
            scrollWidth: 800,
            scrollHeight: 600,
            clientWidth: 800,
            clientHeight: 600,
          },
          elements: [],
          headings: [{ selector: "h1", level: 1, text: "Fixture" }],
          tokens: { status: "not-configured" },
        },
        mismatches: failed
          ? [{ kind: "text-present", expected: "missing" }]
          : [],
        startedAt: "2026-08-14T12:00:00.000Z",
        endedAt: "2026-08-14T12:00:01.000Z",
      };
    },
    async close() {},
  });
  return { directory, browserLauncher };
}

function cliFinding(screenshots = ["state/desktop"]): ModelFindingCandidate {
  return {
    category: "hierarchy",
    severity: "major",
    confidence: 0.81,
    rule: "DESIGN.md: one dominant action",
    selectorHint: "main form",
    state: "state",
    viewport: "desktop",
    screenshots,
    references: [],
    explanation: "The secondary action competes with the primary action.",
    suggestedArea: "booking form actions",
    acceptance: ["The primary action is visually dominant."],
  };
}

function cliReviewedFinding(
  id: string,
  fingerprint: string,
  status: Finding["status"],
): Finding {
  return findingSchema.parse({
    id,
    fingerprint,
    createdAt: "2026-08-14T12:00:00.000Z",
    commit: "abc123",
    flow: "fixture",
    state: "state",
    viewport: "desktop",
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    rule: "idiom:target-size",
    evidence: { screenshots: ["state/desktop/screenshot.png"] },
    explanation: "The action is hard to activate.",
    acceptance: ["The action is at least 44 by 44 CSS pixels."],
    verification: { kind: "deterministic-check", check: "target-size" },
    status,
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("validate booking succeeds through the exact booking example path", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["node", "idiom", "validate", "booking"], {
    cwd: join(import.meta.dirname, "..", "examples", "booking"),
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  expect(code).toBe(0);
  expect(stdout.join("")).toContain("Validated booking: booking");
  expect(stderr).toEqual([]);
});

test("explore enforces generation state in its action while resolve dispatches without it", async () => {
  const errors: string[] = [];
  const generationCode = await run(
    ["node", "idiom", "explore", "fixture", "--question", "Why?"],
    { stderr: (message) => errors.push(message) },
  );
  expect(generationCode).toBe(1);
  expect(errors.join("")).toContain("explore generation requires --state");

  const directory = await mkdtemp(join(tmpdir(), "idiom-cli-explore-resolve-"));
  temporaryDirectories.push(directory);
  await initProject({ project: directory, yes: true });
  errors.length = 0;
  const resolveCode = await run(
    [
      "node",
      "idiom",
      "--project",
      directory,
      "explore",
      "resolve",
      "missing-run",
      "--none",
      "--reason",
      "No reusable rule.",
      "--yes",
    ],
    { stderr: (message) => errors.push(message) },
  );
  expect(resolveCode).toBe(1);
  expect(errors.join("")).toContain('unknown exploration run "missing-run"');
  expect(errors.join("")).not.toContain("requires --state");
});

test("explore resolve rejects mixed generation flags and incomplete flag matrices", async () => {
  const cases: Array<{ argv: string[]; message: string }> = [
    {
      argv: ["resolve", "run", "--candidate", "A", "--reason", "why"],
      message: "--yes is required",
    },
    {
      argv: ["resolve", "run", "--reason", "why", "--yes"],
      message: "provide exactly one",
    },
    {
      argv: [
        "resolve",
        "run",
        "--candidate",
        "A",
        "--none",
        "--reason",
        "why",
        "--yes",
      ],
      message: "provide exactly one",
    },
    {
      argv: [
        "--state",
        "ready",
        "resolve",
        "run",
        "--none",
        "--reason",
        "why",
        "--yes",
      ],
      message: "does not accept generation options",
    },
  ];
  for (const item of cases) {
    const errors: string[] = [];
    const code = await run(["node", "idiom", "explore", ...item.argv], {
      stderr: (message) => errors.push(message),
    });
    expect(code, item.argv.join(" ")).toBe(1);
    expect(errors.join(""), item.argv.join(" ")).toContain(item.message);
  }
});

test("the documented init command scaffolds a target repository", async () => {
  const parent = await mkdtemp(join(tmpdir(), "idiom-cli-init-"));
  temporaryDirectories.push(parent);
  const target = join(parent, "target-app");
  const stdout: string[] = [];
  const code = await run(
    ["node", "idiom", "init", "--project", target, "--yes"],
    {
      stdout: (message) => stdout.push(message),
      stderr: () => undefined,
    },
  );
  expect(code).toBe(0);
  expect(stdout.join("")).toContain("11 created");
  await expect(access(join(target, "PRODUCT.md"))).resolves.toBeUndefined();
  await expect(
    access(join(target, ".idiom", "project.json")),
  ).resolves.toBeUndefined();
});

test("interactive init emits the Autobuild diff before confirmation and write", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-cli-autobuild-"));
  temporaryDirectories.push(project);
  const config = join(project, "autobuild.toml");
  const original = '[verify]\nsteps = ["test"]\n';
  await writeFile(config, original);
  const events: string[] = [];

  const code = await run(["node", "idiom", "init", "--project", project], {
    stdout: (message) => events.push(`out:${message}`),
    stderr: () => undefined,
    confirm: async (request) => {
      if (request.kind === "offer-flow-generation") return false;
      events.push(`confirm:${request.kind}`);
      if (request.kind === "apply-autobuild-config")
        expect(await readFile(config, "utf8")).toBe(original);
      return true;
    },
  });

  expect(code).toBe(0);
  const diff = events.findIndex((event) =>
    event.includes("+++ b/autobuild.toml"),
  );
  const question = events.indexOf("confirm:apply-autobuild-config");
  const outcome = events.findIndex((event) =>
    event.includes("Wired Idiom verification into Autobuild"),
  );
  expect(diff).toBeGreaterThan(-1);
  expect(diff).toBeLessThan(question);
  expect(question).toBeLessThan(outcome);
  expect(await readFile(config, "utf8")).toContain('"test", "idiom"');
});

test("noninteractive init reports Autobuild availability without writing", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-cli-autobuild-yes-"));
  temporaryDirectories.push(project);
  const config = join(project, "autobuild.toml");
  await writeFile(config, "[project]\nname = 'x'\n");
  const stdout: string[] = [];
  const confirm = vi.fn(async () => true);

  const code = await run(
    ["node", "idiom", "init", "--project", project, "--yes"],
    { stdout: (message) => stdout.push(message), confirm },
  );

  expect(code).toBe(0);
  expect(stdout.join("")).toContain(
    "rerun `idiom init` interactively to review and approve wiring",
  );
  expect(confirm).not.toHaveBeenCalled();
  expect(await readFile(config, "utf8")).toBe("[project]\nname = 'x'\n");
});

test("unsafe Autobuild configuration prints manual guidance and exits zero", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-cli-autobuild-manual-"));
  temporaryDirectories.push(project);
  await writeFile(join(project, "autobuild.toml"), "invalid = [");
  const stdout: string[] = [];

  const code = await run(["node", "idiom", "init", "--project", project], {
    stdout: (message) => stdout.push(message),
    confirm: async (request) => request.kind !== "offer-flow-generation",
  });

  expect(code).toBe(0);
  expect(stdout.join("")).toContain("Autobuild wiring made no changes");
  expect(stdout.join("")).toContain("# Copy these entries");
  expect(stdout.join("")).toContain(
    "Ordinary Idiom initialization still completed",
  );
});

test("malformed manifests exit 1, name the field, and execute no setup or network calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-cli-"));
  temporaryDirectories.push(directory);
  await initProject({ project: directory, yes: true });
  const marker = join(directory, "setup-ran");
  const manifest = {
    id: "unsafe",
    title: "Unsafe",
    intent: ["Never execute setup while validating."],
    setup: [{ run: `touch ${marker}` }],
    states: [
      {
        id: "bad",
        description: "Bad",
        urlFrom: { source: "setup-stdout", pattern: "no-capture" },
        expect: {},
      },
    ],
  };
  await writeFile(
    join(directory, ".idiom", "flows", "unsafe.json"),
    JSON.stringify(manifest),
  );
  const fetch = vi.fn(() => {
    throw new Error("fetch must not be called");
  });
  vi.stubGlobal("fetch", fetch);
  const stderr: string[] = [];
  const code = await run(
    ["node", "idiom", "validate", "unsafe", "--project", directory],
    {
      stderr: (message) => stderr.push(message),
      stdout: () => undefined,
    },
  );
  expect(code).toBe(1);
  expect(stderr.join("")).toContain("states[0].urlFrom.pattern");
  expect(fetch).not.toHaveBeenCalled();
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["--version", "-V"])(
  "version uses Commander's standard option %s",
  async (flag) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await run(["node", "idiom", flag], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      }),
    ).toBe(0);
    expect(stdout.join("")).toBe(`${IDIOM_VERSION_DISPLAY}\n`);
    expect(stderr.join("")).toBe("");
  },
);

test("tickets reports lifecycle and consolidated records as already resolved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-cli-tickets-"));
  temporaryDirectories.push(directory);
  await initProject({ project: directory, yes: true });
  const checkpointed = cliReviewedFinding(
    "IDM-run-0001",
    "checkpointed-fingerprint",
    "verified-fixed",
  );
  const consolidated = cliReviewedFinding(
    "IDM-run-0002",
    "consolidated-fingerprint",
    "open",
  );
  const runDirectory = join(
    directory,
    ".idiom",
    "reports",
    "2026-08-14T12-00-00-000Z",
  );
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "findings.json"),
    `${JSON.stringify([checkpointed, consolidated])}\n`,
  );
  const consolidatedPath = join(
    directory,
    ".autobuild",
    "tickets",
    "done",
    "combined.md",
  );
  await mkdir(join(directory, ".autobuild", "tickets", "done"), {
    recursive: true,
  });
  await writeFile(
    consolidatedPath,
    `# Combined\n\n\`\`\`idiom:finding\n${JSON.stringify(consolidated)}\n\`\`\`\n`,
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await run(["node", "idiom", "tickets", "--project", directory], {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });

  expect(code).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("")).toContain(
    "Tickets: 0 created, 0 already emitted, 2 already resolved, 0 conflict(s), 0 ineligible",
  );
  expect(stdout.join("")).toContain(
    "finding-1: already resolved (verified-fixed lifecycle checkpoint)",
  );
  expect(stdout.join("")).toContain(
    `finding-2: already resolved as ticketed in done — ${consolidatedPath}`,
  );
});

test("instruction requires one finding and writes only its rendered text", async () => {
  const missingOut: string[] = [];
  const missingErr: string[] = [];
  const missingCode = await run(["node", "idiom", "instruction"], {
    stdout: (message) => missingOut.push(message),
    stderr: (message) => missingErr.push(message),
  });
  expect(missingCode).toBe(1);
  expect(missingOut).toEqual([]);
  expect(missingErr.join("")).toContain("required option '--finding <id>'");

  const directory = await mkdtemp(join(tmpdir(), "idiom-cli-instruction-"));
  temporaryDirectories.push(directory);
  await initProject({ project: directory, yes: true });
  const accepted = cliReviewedFinding(
    "IDM-instruction-0001",
    "instruction-fingerprint",
    "open",
  );
  const rejected = cliReviewedFinding(
    "IDM-instruction-0002",
    "rejected-instruction-fingerprint",
    "open",
  );
  const runDirectory = join(
    directory,
    ".idiom",
    "reports",
    "2026-08-14T12-00-00-000Z",
  );
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "findings.json"),
    `${JSON.stringify([accepted, rejected])}\n`,
  );
  await appendDecision({
    projectDirectory: directory,
    finding: accepted,
    decision: "accept",
    scope: "instance",
  });
  await appendDecision({
    projectDirectory: directory,
    finding: rejected,
    decision: "reject",
    scope: "instance",
  });
  const expected = await instructionCommand({
    project: directory,
    findingId: accepted.id,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "instruction",
      "--finding",
      accepted.id,
      "--project",
      directory,
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  );
  expect(code).toBe(0);
  expect(stdout.join("")).toBe(expected);
  expect(stderr).toEqual([]);

  const rejectedOut: string[] = [];
  const rejectedErr: string[] = [];
  const rejectedCode = await run(
    [
      "node",
      "idiom",
      "instruction",
      "--finding",
      rejected.id,
      "--project",
      directory,
    ],
    {
      stdout: (message) => rejectedOut.push(message),
      stderr: (message) => rejectedErr.push(message),
    },
  );
  expect(rejectedCode).toBe(1);
  expect(rejectedOut).toEqual([]);
  expect(rejectedErr.join("")).toContain("is rejected");
});

async function fingerprintTree(root: string): Promise<string> {
  const entries: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) entries.push(`${path}->link`);
      else if (entry.isDirectory()) await walk(path);
      else entries.push(`${path}:${await readFile(path, "utf8")}`);
    }
  };
  await walk(root);
  return entries.join("\n");
}

test("context writes only to stdout, resolves upward, and mutates nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-cli-context-"));
  temporaryDirectories.push(directory);
  await initProject({ project: directory, yes: true });
  await writeFile(
    join(directory, ".idiom", "flows", "fixture.json"),
    JSON.stringify({
      id: "fixture",
      title: "Fixture",
      intent: [],
      setup: [],
      states: [{ id: "state", description: "State", url: "/", expect: {} }],
    }),
  );
  const nested = join(directory, "apps", "web", "src");
  await mkdir(nested, { recursive: true });
  const fetch = vi.fn(() => {
    throw new Error("context must never reach the network");
  });
  vi.stubGlobal("fetch", fetch);
  const before = await fingerprintTree(directory);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    ["node", "idiom", "context", "fixture", "--project", nested],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      context: { gitTopology: async () => undefined },
    },
  );

  expect(code).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("")).toContain("# Design brief");
  expect(stdout.join("")).toContain("Scope: flow fixture");
  expect(stdout.join("")).toContain("## Standing prohibitions");
  expect(stdout.join("").endsWith("\n")).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(await fingerprintTree(directory)).toBe(before);
});

test("context without a flow succeeds and degrades outside a Git checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-cli-context-"));
  temporaryDirectories.push(directory);
  await initProject({ project: directory, yes: true });
  const stdout: string[] = [];
  const stderr: string[] = [];

  // No dependency injection here: the real topology query runs, fails outside a
  // repository, and must degrade rather than fail the brief.
  const code = await run(["node", "idiom", "context", "--project", directory], {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });

  expect(code).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("")).toContain("Scope: project-wide");
});

test("context reports an unknown flow without reading unrelated manifests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-cli-context-"));
  temporaryDirectories.push(directory);
  await initProject({ project: directory, yes: true });
  await writeFile(join(directory, ".idiom", "flows", "broken.json"), "{ nope");
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await run(
    ["node", "idiom", "context", "typo", "--project", directory],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      context: { gitTopology: async () => undefined },
    },
  );

  expect(code).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr.join("")).toContain(".idiom/flows/typo.json: file not found");
  expect(stderr.join("")).not.toContain("broken.json");
});

test("subcommand help and option errors return without exiting the host process", async () => {
  const helpOutput: string[] = [];
  const helpErrors: string[] = [];
  await expect(
    run(["node", "idiom", "validate", "--help"], {
      stdout: (message) => helpOutput.push(message),
      stderr: (message) => helpErrors.push(message),
    }),
  ).resolves.toBe(0);
  expect(helpOutput.join("")).toContain("Usage: idiom validate");
  expect(helpErrors).toEqual([]);

  const errorOutput: string[] = [];
  const errorMessages: string[] = [];
  await expect(
    run(["node", "idiom", "validate", "booking", "--badopt"], {
      stdout: (message) => errorOutput.push(message),
      stderr: (message) => errorMessages.push(message),
    }),
  ).resolves.toBe(1);
  expect(errorOutput).toEqual([]);
  expect(errorMessages.join("")).toContain("unknown option '--badopt'");
});

test("capture parses --project/--out and prints its published report", async () => {
  const fixture = await captureFixture(false);
  const invokingDirectory = await mkdtemp(join(tmpdir(), "idiom-cli-invoke-"));
  temporaryDirectories.push(invokingDirectory);
  const out = join(fixture.directory, "custom-output");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "capture",
      "fixture",
      "--project",
      fixture.directory,
      "--out",
      out,
    ],
    {
      cwd: invokingDirectory,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      capture: {
        browserLauncher: fixture.browserLauncher,
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "abc123", dirty: false }),
      },
    },
  );
  expect(code).toBe(0);
  expect(stdout.join("")).toContain("Captured fixture: 1 passed, 0 failed");
  expect(stdout.join("")).toContain(join(out, "baseline.md"));
  for (const artifact of [
    "baseline.md",
    "run.json",
    "state/desktop/screenshot.png",
  ]) {
    await expect(access(join(out, artifact))).resolves.toBeUndefined();
  }
  expect(stderr.join("")).toMatch(
    /Timings:[\s\S]*build:[\s\S]*start:[\s\S]*capture[\s\S]*probe[\s\S]*checks:/,
  );
});

test.each(["injected", "process"])(
  "capture resolves relative --out from the %s cwd when --project selects another directory",
  async (cwdSource) => {
    const fixture = await captureFixture(false);
    const invokingDirectory = await mkdtemp(
      join(tmpdir(), "idiom-cli-invoke-"),
    );
    temporaryDirectories.push(invokingDirectory);
    const relativeOut =
      cwdSource === "injected" ? "nested/baseline" : "baseline";
    const out = join(invokingDirectory, relativeOut);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const snapshot = vi.fn<typeof snapshotSource>(async () => ({
      commit: "abc123",
      dirty: false,
    }));
    const cwdSpy =
      cwdSource === "process"
        ? vi.spyOn(process, "cwd").mockReturnValue(invokingDirectory)
        : undefined;
    try {
      const code = await run(
        [
          "node",
          "idiom",
          "capture",
          "fixture",
          "--project",
          fixture.directory,
          "--out",
          relativeOut,
        ],
        {
          ...(cwdSource === "injected" ? { cwd: invokingDirectory } : {}),
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
          capture: {
            browserLauncher: fixture.browserLauncher,
            inheritedEnvironment: { PATH: process.env.PATH },
            snapshotSource: snapshot,
          },
        },
      );
      expect(code, stderr.join("")).toBe(0);
      for (const artifact of [
        "baseline.md",
        "run.json",
        "state/desktop/screenshot.png",
      ]) {
        await expect(access(join(out, artifact))).resolves.toBeUndefined();
      }
      expect(stdout.join("")).toContain(join(out, "baseline.md"));
      await expect(
        access(join(fixture.directory, relativeOut)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(snapshot).toHaveBeenCalledWith(
        fixture.directory,
        expect.objectContaining({
          explicitOutputPath: out,
          excludedPaths: expect.arrayContaining([out]),
        }),
      );
    } finally {
      cwdSpy?.mockRestore();
    }
  },
);

test("capture keeps default output under the selected project with a distinct cwd", async () => {
  const fixture = await captureFixture(false);
  const invokingDirectory = await mkdtemp(join(tmpdir(), "idiom-cli-invoke-"));
  temporaryDirectories.push(invokingDirectory);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const timestamp = "2026-08-14T12-00-00-000Z";
  const out = join(fixture.directory, ".idiom", "reports", timestamp);
  const code = await run(
    ["node", "idiom", "capture", "fixture", "--project", fixture.directory],
    {
      cwd: invokingDirectory,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      capture: {
        browserLauncher: fixture.browserLauncher,
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        now: () => new Date("2026-08-14T12:00:00.000Z"),
      },
    },
  );
  expect(code, stderr.join("")).toBe(0);
  expect(stdout.join("")).toContain(join(out, "baseline.md"));
  for (const artifact of [
    "baseline.md",
    "run.json",
    "state/desktop/screenshot.png",
  ]) {
    await expect(access(join(out, artifact))).resolves.toBeUndefined();
  }
  expect(await readdir(invokingDirectory)).toEqual([]);
});

test("capture refuses an existing relative --out in the invoking directory", async () => {
  const fixture = await captureFixture(false);
  const invokingDirectory = await mkdtemp(join(tmpdir(), "idiom-cli-invoke-"));
  temporaryDirectories.push(invokingDirectory);
  const relativeOut = "baseline";
  const out = join(invokingDirectory, relativeOut);
  await mkdir(out);
  const sentinel = Buffer.from("existing output must survive\n");
  await writeFile(join(out, "sentinel.txt"), sentinel);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "capture",
      "fixture",
      "--project",
      fixture.directory,
      "--out",
      relativeOut,
    ],
    {
      cwd: invokingDirectory,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      capture: {
        browserLauncher: fixture.browserLauncher,
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "abc123", dirty: false }),
      },
    },
  );
  expect(code).toBe(1);
  expect(stderr.join("")).toContain(
    `capture output already exists and will not be overwritten: ${out}`,
  );
  expect(await readFile(join(out, "sentinel.txt"))).toEqual(sentinel);
  expect(await readdir(out)).toEqual(["sentinel.txt"]);
  expect(stdout).toEqual([]);
  await expect(
    access(join(fixture.directory, relativeOut)),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("verify parses its required options and reports the distinct no-findings outcome", async () => {
  const fixture = await captureFixture(false);
  const spec = join(fixture.directory, "spec.md");
  const out = join(fixture.directory, ".idiom", "reports", "verify-empty");
  await writeFile(spec, "# No findings\n");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "verify",
      "fixture",
      "--project",
      fixture.directory,
      "--spec",
      spec,
      "--out",
      out,
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      verify: {
        capture: {
          browserLauncher: async () => {
            throw new Error("no-findings verify must not launch a browser");
          },
        },
      },
    },
  );
  expect(code).toBe(0);
  expect(stdout.join("")).toContain(
    "Verified fixture: no-findings (0 finding(s))",
  );
  expect(stdout.join("")).toContain(join(out, "before-after.md"));
  expect(stderr).toEqual([]);
});

test("capture publishes aggregate failures before exiting 1", async () => {
  const fixture = await captureFixture(true);
  const out = join(fixture.directory, "failed-output");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "capture",
      "fixture",
      "--project",
      fixture.directory,
      "--out",
      out,
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      capture: {
        browserLauncher: fixture.browserLauncher,
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "abc123", dirty: false }),
      },
    },
  );
  expect(code).toBe(1);
  expect(stdout.join("")).toContain("1 failed");
  expect(stderr.join("")).toContain("capture completed with 1 failed tuple");
  await expect(access(join(out, "baseline.md"))).resolves.toBeUndefined();
});

test("review emits deterministic outputs and replays --from without capture", async () => {
  const fixture = await captureFixture(true);
  const stdout: string[] = [];
  const commonCapture = {
    browserLauncher: fixture.browserLauncher,
    inheritedEnvironment: { PATH: process.env.PATH },
    snapshotSource: async () => ({ commit: "abc123", dirty: false }),
    now: () => new Date("2026-08-14T12:00:00.000Z"),
  };
  expect(
    await run(
      [
        "node",
        "idiom",
        "review",
        "fixture",
        "--deterministic-only",
        "--project",
        fixture.directory,
      ],
      {
        stdout: (message) => stdout.push(message),
        stderr: () => undefined,
        review: { capture: commonCapture },
      },
    ),
  ).toBe(0);
  expect(stdout.join("")).toContain("finding(s)");
  const runs = await readdir(join(fixture.directory, ".idiom", "reports"));
  const runId = "2026-08-14T12-00-00-000Z";
  expect(runs).toContain(runId);
  const runDirectory = join(fixture.directory, ".idiom", "reports", runId);
  const findings = JSON.parse(
    await readFile(join(runDirectory, "findings.json"), "utf8"),
  );
  await expect(
    access(join(runDirectory, "report.html")),
  ).resolves.toBeUndefined();
  expect(
    findings.some(
      (finding: { category: string }) => finding.category === "missing-state",
    ),
  ).toBe(true);

  const captureSentinel = vi.fn(async () => {
    throw new Error("browser must not launch for --from");
  });
  expect(
    await run(
      [
        "node",
        "idiom",
        "review",
        "fixture",
        "--from",
        runId,
        "--project",
        fixture.directory,
      ],
      {
        stdout: () => undefined,
        stderr: () => undefined,
        review: {
          environment: {},
          capture: {
            browserLauncher: captureSentinel,
            snapshotSource: async () => {
              throw new Error("Git must not run for --from");
            },
          },
        },
      },
    ),
  ).toBe(0);
  expect(captureSentinel).not.toHaveBeenCalled();
});

test("full review publishes fake model findings with layer labels", async () => {
  const fixture = await captureFixture(false);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const critique = vi.fn(async () => [
    {
      category: "hierarchy" as const,
      severity: "major" as const,
      confidence: 0.81,
      rule: "DESIGN.md: one dominant action",
      selectorHint: "main form",
      state: "state",
      viewport: "desktop",
      screenshots: ["state/desktop"],
      references: [],
      explanation: "The secondary action competes with the primary action.",
      suggestedArea: "booking form actions",
      acceptance: ["The primary action is visually dominant."],
    },
  ]);
  const code = await run(
    ["node", "idiom", "review", "fixture", "--project", fixture.directory],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      review: {
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
          now: () => new Date("2026-08-14T13:00:00.000Z"),
        },
        critique: { critique },
      },
    },
  );
  expect(code).toBe(0);
  expect(critique).toHaveBeenCalledTimes(1);
  expect(stderr).toEqual([]);
  const runDirectory = join(
    fixture.directory,
    ".idiom",
    "reports",
    "2026-08-14T13-00-00-000Z",
  );
  const findings = JSON.parse(
    await readFile(join(runDirectory, "findings.json"), "utf8"),
  ) as Array<{ layer: string; confidence: number }>;
  expect(findings).toMatchObject([{ layer: "model", confidence: 0.81 }]);
  const report = await readFile(join(runDirectory, "report.md"), "utf8");
  expect(report).toContain("# Full review: fixture");
  expect(report).toContain("Layer: model · Confidence: 0.81");
  expect(report.toLowerCase()).not.toContain("score");
  expect(stdout.join("")).toContain("1 finding(s)");
});

test("the default Claude Code provider publishes screenshot-citing findings without an API key", async () => {
  const fixture = await captureFixture(false, 5, "claude-code");
  const requests: Array<{ stdin: string; environment: NodeJS.ProcessEnv }> = [];
  const code = await run(
    ["node", "idiom", "review", "fixture", "--project", fixture.directory],
    {
      stdout: () => undefined,
      stderr: () => undefined,
      review: {
        environment: {},
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
          now: () => new Date("2026-08-14T13:10:00.000Z"),
        },
        claudeCodeRunner: async (request) => {
          requests.push(request);
          return {
            stdout: JSON.stringify({
              type: "result",
              subtype: "success",
              is_error: false,
              structured_output: {
                findings: [
                  {
                    category: "hierarchy",
                    severity: "major",
                    confidence: 0.81,
                    rule: "DESIGN.md: one dominant action",
                    selectorHint: "main form",
                    state: "state",
                    viewport: "desktop",
                    screenshots: ["state/desktop"],
                    references: [],
                    explanation:
                      "The secondary action competes with the primary action.",
                    suggestedArea: "booking form actions",
                    acceptance: ["The primary action is visually dominant."],
                  },
                ],
              },
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        },
      },
    },
  );
  expect(code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.stdin).toContain("state/desktop");
  expect(requests[0]?.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
  const findings = JSON.parse(
    await readFile(
      join(
        fixture.directory,
        ".idiom",
        "reports",
        "2026-08-14T13-10-00-000Z",
        "findings.json",
      ),
      "utf8",
    ),
  ) as Array<{ layer: string; evidence: { screenshots: string[] } }>;
  expect(findings).toMatchObject([
    {
      layer: "model",
      evidence: { screenshots: ["state/desktop/screenshot.png"] },
    },
  ]);
});

test.each([
  ["successful", true],
  ["failed", false],
] as const)(
  "Claude Code semantic repair is atomic when the retry is %s",
  async (_label, repairSucceeds) => {
    const fixture = await captureFixture(false, 5, "claude-code");
    const stderr: string[] = [];
    let attempts = 0;
    const code = await run(
      ["node", "idiom", "review", "fixture", "--project", fixture.directory],
      {
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
        review: {
          environment: {},
          capture: {
            browserLauncher: fixture.browserLauncher,
            inheritedEnvironment: { PATH: process.env.PATH },
            snapshotSource: async () => ({ commit: "abc123", dirty: false }),
          },
          claudeCodeRunner: async () => {
            attempts += 1;
            const finding =
              attempts === 1 || !repairSucceeds
                ? cliFinding(["unknown/mobile"])
                : cliFinding();
            return {
              stdout: JSON.stringify({
                type: "result",
                subtype: "success",
                is_error: false,
                structured_output: { findings: [finding] },
              }),
              stderr: "",
              exitCode: 0,
              signal: null,
            };
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(attempts).toBe(2);
    const reports = await readdir(join(fixture.directory, ".idiom", "reports"));
    const runDirectory = join(
      fixture.directory,
      ".idiom",
      "reports",
      reports[0] ?? "",
    );
    const findings = JSON.parse(
      await readFile(join(runDirectory, "findings.json"), "utf8"),
    ) as Array<{ layer: string }>;
    const report = await readFile(join(runDirectory, "report.md"), "utf8");
    if (repairSucceeds) {
      expect(findings).toMatchObject([{ layer: "model" }]);
      expect(report).toContain("# Full review: fixture");
      expect(stderr).toEqual([]);
    } else {
      expect(findings).toEqual([]);
      expect(report).toContain("# Degraded review: fixture");
      expect(stderr.join("")).toContain("malformed model critique");
      expect(stderr.join("")).not.toContain("Claude Code CLI is unavailable");
      expect(stderr.join("")).not.toContain("ANTHROPIC_API_KEY");
      expect(report).not.toContain("Claude Code CLI is unavailable");
      expect(report).not.toContain("ANTHROPIC\\_API\\_KEY");
    }
  },
);

test("local critique-context failures are not reported as Claude Code auth failures", async () => {
  const fixture = await captureFixture(false, 5, "claude-code");
  await rm(join(fixture.directory, "DESIGN.md"));
  const stderr: string[] = [];
  const runner = vi.fn(async () => {
    throw new Error("runner must not be constructed or called");
  });
  const code = await run(
    ["node", "idiom", "review", "fixture", "--project", fixture.directory],
    {
      stdout: () => undefined,
      stderr: (message) => stderr.push(message),
      review: {
        environment: {},
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        },
        claudeCodeRunner: runner,
      },
    },
  );
  expect(code).toBe(0);
  expect(runner).not.toHaveBeenCalled();
  expect(stderr.join("")).toContain("DESIGN.md");
  expect(stderr.join("")).not.toContain("Claude Code CLI is unavailable");
  expect(stderr.join("")).not.toContain("ANTHROPIC_API_KEY");
});

test("provider factory receives legacy Anthropic routing context", async () => {
  const fixture = await captureFixture(false);
  const factory = vi.fn(() => ({ critique: async () => [] }));
  const code = await run(
    ["node", "idiom", "review", "fixture", "--project", fixture.directory],
    {
      stdout: () => undefined,
      stderr: () => undefined,
      review: {
        environment: { ANTHROPIC_API_KEY: "injected" },
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        },
        createCritiqueAdapter: factory,
      },
    },
  );
  expect(code).toBe(0);
  expect(factory).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "anthropic",
      model: "unused",
      projectDirectory: fixture.directory,
    }),
  );
});

test("a failing primary falls back, visibly, to the configured provider", async () => {
  const fixture = await captureFixture(false, 5, "claude-code", {
    provider: "codex",
    model: "gpt-configured",
  });
  const stderr: string[] = [];
  const failing = vi.fn(async () => {
    throw new ClaudeCodeCritiqueError("usage limit reached");
  });
  const succeeding = vi.fn(async () => []);
  const factory = vi.fn((options: { provider: string }) => ({
    critique: options.provider === "codex" ? succeeding : failing,
  }));
  const code = await run(
    [
      "node",
      "idiom",
      "review",
      "fixture",
      "--project",
      fixture.directory,
      "--json",
    ],
    {
      stdout: () => undefined,
      stderr: (message) => stderr.push(message),
      review: {
        environment: {},
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        },
        createCritiqueAdapter: factory,
      },
    },
  );
  expect(code).toBe(0);
  expect(failing).toHaveBeenCalledTimes(1);
  expect(succeeding).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "codex", model: "gpt-configured" }),
  );
  expect(stderr.join("")).toContain(
    "Warning: Model critique used fallback provider codex after claude-code failed: Claude Code CLI is unavailable",
  );
  expect(stderr.join("")).not.toContain("Model critique degraded");
  const reports = await readdir(join(fixture.directory, ".idiom", "reports"));
  const runDirectory = join(
    fixture.directory,
    ".idiom",
    "reports",
    reports[0] ?? "",
  );
  const report = await readFile(join(runDirectory, "report.md"), "utf8");
  expect(report).toContain("# Full review: fixture");
  expect(report).toContain(
    "Model layer: Model layer completed using fallback provider codex after claude-code failed",
  );
  const html = await readFile(join(runDirectory, "report.html"), "utf8");
  expect(html).toContain(
    "Model layer completed using fallback provider codex after claude-code failed",
  );
});

test("without a fallback a failing primary still degrades", async () => {
  const fixture = await captureFixture(false, 5, "codex");
  const stderr: string[] = [];
  const code = await run(
    ["node", "idiom", "review", "fixture", "--project", fixture.directory],
    {
      stdout: () => undefined,
      stderr: (message) => stderr.push(message),
      review: {
        environment: {},
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        },
        codexRunner: async () => ({
          stdout: "",
          stderr: "not logged in",
          exitCode: 1,
          signal: null,
        }),
      },
    },
  );
  expect(code).toBe(0);
  expect(stderr.join("")).toContain(
    "Warning: Model critique degraded: Codex CLI is unavailable or not authenticated; install or update Codex and run `codex login`; diagnostic: exit 1: not logged in",
  );
  expect(stderr.join("")).not.toContain("fallback provider");
});

test("Claude Code failure preserves both fixed prerequisites after sanitizing a long diagnostic", async () => {
  const fixture = await captureFixture(false, 5, "claude-code");
  const stderr: string[] = [];
  const code = await run(
    ["node", "idiom", "review", "fixture", "--project", fixture.directory],
    {
      stdout: () => undefined,
      stderr: (message) => stderr.push(message),
      review: {
        environment: {},
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        },
        claudeCodeRunner: async () => ({
          stdout: "",
          stderr: `authorization: Bearer sk-ant-oat01-super-secret\nbare sk-ant-api03-other-secret\n${"diagnostic ".repeat(200)}`,
          exitCode: 1,
          signal: null,
        }),
      },
    },
  );
  expect(code).toBe(0);
  const warning = stderr.join("");
  expect(warning).toContain(
    "Claude Code CLI is unavailable or not authenticated",
  );
  expect(warning).toContain("claude auth login");
  expect(warning).toContain("ANTHROPIC_API_KEY is not set");
  expect(warning).not.toContain("super-secret");
  expect(warning).not.toContain("other-secret");
  expect(
    warning.replace(/^Warning: Model critique degraded: /, "").trim().length,
  ).toBeLessThanOrEqual(600);
  const reports = await readdir(join(fixture.directory, ".idiom", "reports"));
  const report = await readFile(
    join(fixture.directory, ".idiom", "reports", reports[0] ?? "", "report.md"),
    "utf8",
  );
  expect(report).toContain(
    "Claude Code CLI is unavailable or not authenticated",
  );
  expect(report).toContain("ANTHROPIC\\_API\\_KEY is not set");
  expect(report).not.toContain("super-secret");
  expect(report).not.toContain("other-secret");
});

test("Claude Code failure with an API key explains the explicit provider switch", async () => {
  const fixture = await captureFixture(false, 5, "claude-code");
  const stderr: string[] = [];
  const code = await run(
    ["node", "idiom", "review", "fixture", "--project", fixture.directory],
    {
      stdout: () => undefined,
      stderr: (message) => stderr.push(message),
      review: {
        environment: { ANTHROPIC_API_KEY: "available-only-to-direct-provider" },
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        },
        claudeCodeRunner: async (request) => {
          expect(request.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
          return {
            stdout: "",
            stderr: "not authenticated",
            exitCode: 1,
            signal: null,
          };
        },
      },
    },
  );
  expect(code).toBe(0);
  expect(stderr.join("")).toContain(
    'select model.provider: "anthropic" to use the explicit direct-API fallback',
  );
  expect(stderr.join("")).not.toContain("ANTHROPIC_API_KEY is not set");
  expect(stderr.join("")).not.toContain("available-only-to-direct-provider");
});

test("deterministic-only bypasses the critique adapter completely", async () => {
  const fixture = await captureFixture(false, 5, "claude-code");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const critique = vi.fn(async () => {
    throw new Error("adapter must not run");
  });
  const factory = vi.fn(() => ({ critique }));
  const code = await run(
    [
      "node",
      "idiom",
      "review",
      "fixture",
      "--deterministic-only",
      "--project",
      fixture.directory,
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      review: {
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        },
        createCritiqueAdapter: factory,
      },
    },
  );
  expect(code).toBe(0);
  expect(critique).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
  expect(stdout.join("")).toContain("Reviewed fixture:");
  expect(stderr).toEqual([]);
  const reports = await readdir(join(fixture.directory, ".idiom", "reports"));
  const report = await readFile(
    join(fixture.directory, ".idiom", "reports", reports[0] ?? "", "report.md"),
    "utf8",
  );
  expect(report).toContain("# Deterministic-only review: fixture");
  expect(report).toContain(
    "Model layer: skipped by choice (`--deterministic-only`).",
  );
  expect(report).not.toContain("# Degraded review:");
});

test.each([
  [
    "missing credential",
    undefined,
    "ANTHROPIC_API_KEY is not set",
    "ANTHROPIC\\_API\\_KEY is not set",
  ],
  [
    "network rejection",
    new Error("network unavailable"),
    "network unavailable",
    "network unavailable",
  ],
  [
    "malformed response",
    "malformed-output",
    "malformed model critique",
    "malformed model critique",
  ],
])(
  "%s degrades visibly to deterministic artifacts",
  async (_label, failure, expectedCause, expectedReportCause) => {
    const fixture = await captureFixture(true);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const review = {
      capture: {
        browserLauncher: fixture.browserLauncher,
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "abc123", dirty: false }),
      },
      environment: {},
      ...(failure === undefined
        ? {}
        : {
            critique: {
              critique: async () => {
                if (failure === "malformed-output")
                  return [{ category: "invalid" }] as never;
                throw failure;
              },
            },
          }),
    };
    const code = await run(
      ["node", "idiom", "review", "fixture", "--project", fixture.directory],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        review,
      },
    );
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("Reviewed fixture:");
    expect(stderr.join("")).toContain("Warning: Model critique degraded");
    expect(stderr.join("")).toContain(expectedCause);
    const reports = await readdir(join(fixture.directory, ".idiom", "reports"));
    const report = await readFile(
      join(
        fixture.directory,
        ".idiom",
        "reports",
        reports[0] ?? "",
        "report.md",
      ),
      "utf8",
    );
    expect(report).toContain("# Degraded review: fixture");
    expect(report).toContain("Model layer did not run");
    expect(report).toContain(expectedReportCause);
    expect(report).not.toContain("# Full review:");
    const findings = JSON.parse(
      await readFile(
        join(
          fixture.directory,
          ".idiom",
          "reports",
          reports[0] ?? "",
          "findings.json",
        ),
        "utf8",
      ),
    ) as Array<{ layer: string }>;
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.layer === "deterministic")).toBe(
      true,
    );
  },
);

test("cap-saturated built-in review degrades only for the missing credential", async () => {
  const fixture = await captureFixture(true, 1);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    ["node", "idiom", "review", "fixture", "--project", fixture.directory],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      review: {
        environment: {},
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        },
      },
    },
  );
  expect(code).toBe(0);
  expect(stdout.join("")).toContain("Reviewed fixture: 1 finding(s)");
  expect(stderr.join("")).toContain("ANTHROPIC_API_KEY is not set");
  expect(stderr.join("")).not.toContain("configured finding cap");
  const reports = await readdir(join(fixture.directory, ".idiom", "reports"));
  const report = await readFile(
    join(fixture.directory, ".idiom", "reports", reports[0] ?? "", "report.md"),
    "utf8",
  );
  expect(report).toContain("# Degraded review: fixture");
  expect(report).toContain("ANTHROPIC\\_API\\_KEY is not set");
  expect(report).not.toContain("configured finding cap");
  expect(report).not.toContain("# Full review:");
});

test("cap-saturated review still invokes an injected critique adapter", async () => {
  const fixture = await captureFixture(true, 1, "claude-code");
  const stderr: string[] = [];
  const critique = vi.fn(async (_input: CritiqueInput) => [cliFinding()]);
  const factory = vi.fn(() => ({ critique }));
  const code = await run(
    ["node", "idiom", "review", "fixture", "--project", fixture.directory],
    {
      stdout: () => undefined,
      stderr: (message) => stderr.push(message),
      review: {
        capture: {
          browserLauncher: fixture.browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        },
        createCritiqueAdapter: factory,
      },
    },
  );
  expect(code).toBe(0);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(critique).toHaveBeenCalledTimes(1);
  expect(critique.mock.calls[0]?.[0]).toMatchObject({
    modelCandidateAllowance: 1,
    deterministicFindings: [
      expect.objectContaining({ layer: "deterministic" }),
    ],
  });
  expect(stderr).toEqual([]);
  const reports = await readdir(join(fixture.directory, ".idiom", "reports"));
  const report = await readFile(
    join(fixture.directory, ".idiom", "reports", reports[0] ?? "", "report.md"),
    "utf8",
  );
  expect(report).toContain("# Full review: fixture");
  expect(report).not.toContain("configured finding cap");
  expect(report).not.toContain("ANTHROPIC\\_API\\_KEY");
});

test("capture/check --prod and flow defaults persist a build that review/check can replay", async () => {
  const f = await productionFixture();
  temporaryDirectories.push(f.directory);
  const { browserLauncher } = await captureFixture(false);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const invoke = (args: string[], replay = false) =>
    run(["node", "idiom", ...args, "--project", f.directory], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      capture: {
        browserLauncher,
        inheritedEnvironment: { PATH: process.env.PATH },
      },
      review: {
        capture: {
          browserLauncher: replay
            ? async () => {
                throw new Error("must not rebuild or launch a browser");
              }
            : browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
        },
      },
    });
  expect(
    await invoke(["capture", "fixture", "--prod"]),
    stderr.join("\n"),
  ).toBe(0);
  const runs = await readdir(join(f.directory, ".idiom", "reports"));
  const runId = runs[0];
  if (runId === undefined) throw new Error("no capture published");
  expect(
    await invoke(["check", "--all", "fixture", "--prod", "--json"]),
    stderr.join("\n"),
  ).toBe(0);
  expect(JSON.parse(stdout.at(-1) ?? "")).toMatchObject({
    build: { kind: "production", id: "fixture-production-id" },
  });
  expect(
    await invoke(["check", "--all", "fixture", "--from", runId], true),
  ).toBe(0);
  expect(stdout.at(-1)).toContain("Production build: fixture-production-id");
  expect(
    await invoke(
      ["review", "fixture", "--from", runId, "--deterministic-only"],
      true,
    ),
  ).toBe(0);
  expect(stdout.at(-1)).toContain("production build fixture-production-id");
  expect(
    await readFile(
      join(f.directory, ".idiom", "reports", runId, "report.md"),
      "utf8",
    ),
  ).toContain("Production build: `fixture-production-id`");
  expect(
    await readFile(
      join(f.directory, ".idiom", "reports", runId, "report.html"),
      "utf8",
    ),
  ).toContain("Production build: fixture-production-id");
  expect(
    (await f.audit()).filter((entry) => entry.phase === "build"),
  ).toHaveLength(2);
  for (const selection of [["--from", runId], ["--latest"]]) {
    expect(
      await invoke(["check", "--all", "fixture", "--prod", ...selection], true),
    ).toBe(1);
    expect(stderr.at(-1)).toContain(
      "--prod cannot be combined with --from or --latest",
    );
  }
  await writeFile(
    join(f.directory, ".idiom", "flows", "fixture.json"),
    JSON.stringify({ ...f.flow, server: "production" }),
  );
  expect(
    await invoke(["check", "--all", "fixture", "--json"]),
    stderr.join("\n"),
  ).toBe(0);
  expect(JSON.parse(stdout.at(-1) ?? "")).toMatchObject({
    build: { kind: "production" },
  });
  expect(
    (await f.audit()).filter((entry) => entry.phase === "build"),
  ).toHaveLength(3);
});

test.each(["capture", "check"])(
  "%s --prod without configuration shows the block to add",
  async (command) => {
    const f = await captureFixture(false);
    const errors: string[] = [];
    expect(
      await run(
        [
          "node",
          "idiom",
          command,
          "fixture",
          "--prod",
          "--project",
          f.directory,
        ],
        { stdout: () => {}, stderr: (message) => errors.push(message) },
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(
      /server.production.*"build".*"start".*"distDir".*"env"/s,
    );
    expect(await readdir(join(f.directory, ".idiom", "reports"))).toEqual([]);
  },
);

test("tickets --cluster preserves repeated finding selection and reports grouped ticket paths", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-cli-clusters-"));
  temporaryDirectories.push(project);
  await initProject({ project, yes: true });
  const findings = [1, 2, 3].map((index) =>
    cliReviewedFinding(`finding-${index}`, `cluster-cli-${index}`, "open"),
  );
  const report = join(project, ".idiom/reports/2026-10-23T12-00-00-000Z");
  await mkdir(report, { recursive: true });
  await writeFile(join(report, "findings.json"), JSON.stringify(findings));
  for (const finding of findings)
    await appendDecision({
      projectDirectory: project,
      finding,
      decision: "accept",
      scope: "instance",
    });
  const output: string[] = [];
  const errors: string[] = [];
  const argv = [
    "node",
    "idiom",
    "tickets",
    "--project",
    project,
    "--cluster",
    "--finding",
    "finding-1",
    "--finding",
    "finding-3",
    "--out",
    join(project, "proposals"),
  ];
  expect(
    await run(argv, {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    }),
  ).toBe(0);
  expect(errors).toEqual([]);
  expect(output.join("\n")).toContain("Tickets: 2 created");
  expect(output.join("\n")).toContain("finding-1: created");
  expect(output.join("\n")).toContain("finding-3: created");
  expect(output.join("\n")).not.toContain("finding-2:");
  expect(await readdir(join(project, "proposals/triage"))).toHaveLength(2);
  output.length = 0;
  expect(
    await run(argv, {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    }),
  ).toBe(0);
  expect(output.join("\n")).toContain("Tickets: 0 created");
});
