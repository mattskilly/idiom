import { execFile, spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { initProject } from "../src/commands/init.js";
import { findingSchema } from "../src/schemas/finding.js";
import { commit, git } from "./baseline-support.js";
import { changedFixture } from "./changed-support.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, "..");
let temporaryDirectory: string;
let runtimeRoot: string;
let runtimeEntry: string;
let packedFiles: string[];
let originalVersion: string;
let buildCommit: string;

type Invocation = {
  code: number;
  stdout: string;
  stderr: string;
};

async function invoke(
  entry: string,
  args: string[],
  cwd = runtimeRoot,
  env = process.env,
): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [entry, ...args],
      { cwd, env },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        if (typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error.code, stdout, stderr });
      },
    );
  });
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(directory, path));
    }
  }
  await visit(directory);
  return files.sort();
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("could not allocate a port");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error === undefined ? accept() : reject(error))),
  );
  return address.port;
}

beforeAll(async () => {
  buildCommit = (
    await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repositoryRoot,
    })
  ).stdout.trim();
  temporaryDirectory = await mkdtemp(join(tmpdir(), "idiom-distribution-"));
  const tarball = join(temporaryDirectory, "idiom.tgz");
  const extractionDirectory = join(temporaryDirectory, "extracted");
  await mkdir(extractionDirectory);
  await execFileAsync(
    "bun",
    ["pm", "pack", "--ignore-scripts", "--filename", tarball],
    { cwd: repositoryRoot },
  );
  await execFileAsync("tar", ["-xzf", tarball, "-C", extractionDirectory]);
  runtimeRoot = join(extractionDirectory, "package");
  runtimeEntry = join(runtimeRoot, "dist", "cli.js");
  packedFiles = await listFiles(runtimeRoot);

  // The packed payload receives only package.json's declared runtime
  // dependencies, linked from the already-installed offline dependency tree.
  const packageMetadata = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string>; version: string };
  originalVersion = packageMetadata.version;
  for (const dependency of Object.keys(packageMetadata.dependencies)) {
    const destination = join(runtimeRoot, "node_modules", dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(
      join(repositoryRoot, "node_modules", dependency),
      destination,
    );
  }
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("the runtime entry is one self-contained file", async () => {
  // Releases commit only dist/cli.js, so a code-split bundle would import
  // chunks that a Git install never receives.
  const entry = await readFile(runtimeEntry, "utf8");
  expect(entry).not.toMatch(/(?:from|import\()\s*["']\.\.?\//);
});

test("minimal packed payload excludes repository-development inputs", async () => {
  // Bun's Git installer copies the checkout. This pack assertion proves that
  // the allowlisted runtime payload works without development files; it does
  // not claim that a Git install is pruned to this manifest.
  const files = packedFiles;
  expect(files).toContain("dist/cli.js");
  expect(files).toContain("templates/project.json");
  expect(files).toContain("templates/autobuild.idiom.toml");
  expect(files).toContain("templates/ab-verify-idiom/SKILL.md");
  expect(files).toContain("package.json");
  expect(files).toContain("README.md");
  expect(files).not.toContain("src/cli.ts");
  expect(files).not.toContain("test/distribution.test.ts");
  expect(files.some((file) => file.startsWith("docs/"))).toBe(false);
  expect(files.some((file) => file.startsWith("docs/images/"))).toBe(false);
  expect(files.some((file) => file.startsWith("examples/"))).toBe(false);
  expect(files.some((file) => file.startsWith("site/"))).toBe(false);
  expect(files).not.toContain("tsconfig.json");
  expect(files).not.toContain("tsup.config.ts");
  expect(files.some((file) => file.startsWith(".git/"))).toBe(false);
  expect(files).not.toContain(".git");
  expect(files).not.toContain("autobuild.toml");
  expect(files).not.toContain("bun.lock");
  const metadata = JSON.parse(
    await readFile(join(runtimeRoot, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  expect(metadata.dependencies).toHaveProperty("smol-toml");
  expect(await readFile(runtimeEntry, "utf8")).toMatch(
    /^#!\/usr\/bin\/env node/,
  );
});

test("packed runtime dependencies exclude hosted SDKs and retain deployment inputs", async () => {
  const metadata = JSON.parse(
    await readFile(join(runtimeRoot, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  for (const name of Object.keys(metadata.dependencies)) {
    expect(name.startsWith("@vercel/"), name).toBe(false);
    expect(name).not.toBe("botid");
  }
  expect(metadata.devDependencies).toMatchObject({
    "@vercel/blob": "2.8.2",
    "@vercel/functions": "3.10.4",
    "@vercel/sandbox": "3.9.0",
    botid: "1.5.11",
  });
});

test("packed discovery manifest and portable skill match their tracked sources", async () => {
  for (const file of [
    "server.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    "plugin.json",
    "mcp.json",
    "skills/idiom/SKILL.md",
    "skills/idiom/references/init.md",
  ]) {
    expect(packedFiles).toContain(file);
    expect(await readFile(join(runtimeRoot, file), "utf8")).toBe(
      await readFile(join(repositoryRoot, file), "utf8"),
    );
  }
  const manifest = JSON.parse(
    await readFile(join(runtimeRoot, "server.json"), "utf8"),
  );
  const metadata = JSON.parse(
    await readFile(join(runtimeRoot, "package.json"), "utf8"),
  );
  expect(manifest.version).toBe(originalVersion);
  expect(manifest.packages[0].version).toBe(originalVersion);
  expect(metadata.mcpName).toBe(manifest.name);
});

test("built CLI runs directly and through an installer-shaped link", async () => {
  const directVersion = await invoke(runtimeEntry, ["--version"]);
  expect(directVersion).toEqual({
    code: 0,
    stdout: `${originalVersion} (${buildCommit.slice(0, 7)})\n`,
    stderr: "",
  });

  const binDirectory = join(temporaryDirectory, "bin");
  const linkedEntry = join(binDirectory, "idiom");
  await mkdir(binDirectory);
  await symlink(runtimeEntry, linkedEntry);
  expect(await invoke(linkedEntry, ["--version"])).toEqual(directVersion);
  const linkedHelp = await invoke(linkedEntry, ["init", "--help"]);
  expect(linkedHelp.code).toBe(0);
  expect(linkedHelp.stdout).toContain("Usage: idiom init");
  expect(linkedHelp.stderr).toBe("");
  const quickHelp = await invoke(linkedEntry, ["quick", "--help"]);
  expect(quickHelp.code).toBe(0);
  expect(quickHelp.stdout).toContain("Usage: idiom quick");
  expect(quickHelp.stderr).toBe("");
}, 60_000);

test("built CLI reads version from its colocated package metadata", async () => {
  const packageFile = join(runtimeRoot, "package.json");
  const originalMetadata = await readFile(packageFile, "utf8");
  const metadata = JSON.parse(originalMetadata) as {
    version: string;
  };
  metadata.version = "9.8.7";
  await writeFile(packageFile, `${JSON.stringify(metadata, null, 2)}\n`);

  try {
    const result = await invoke(runtimeEntry, ["--version"]);
    expect(result).toEqual({
      code: 0,
      stdout: `9.8.7 (${buildCommit.slice(0, 7)})\n`,
      stderr: "",
    });
  } finally {
    await writeFile(packageFile, originalMetadata);
  }
}, 60_000);

test("packed version ignores application metadata, Git HEAD, runtime environment, and Git availability", async () => {
  const application = join(temporaryDirectory, "unrelated-version-application");
  const emptyPath = join(temporaryDirectory, "empty-path");
  await mkdir(application);
  await mkdir(emptyPath);
  await copyFile(
    join(repositoryRoot, "test/fixtures/version/package.json"),
    join(application, "package.json"),
  );
  await execFileAsync("git", ["init", "--quiet"], { cwd: application });
  await execFileAsync("git", ["add", "package.json"], { cwd: application });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Version Test",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: application },
  );
  const applicationCommit = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: application })
  ).stdout.trim();
  expect(applicationCommit).not.toBe(buildCommit);
  const result = await invoke(runtimeEntry, ["--version"], application, {
    ...process.env,
    PATH: emptyPath,
    IDIOM_BUILD_COMMIT: applicationCommit,
    __IDIOM_BUILD_COMMIT__: applicationCommit,
  });
  expect(result).toEqual({
    code: 0,
    stdout: `${originalVersion} (${buildCommit.slice(0, 7)})\n`,
    stderr: "",
  });
}, 60_000);

test("packed CLI completes documented init, validate, and capture outside the source checkout", async () => {
  const application = join(temporaryDirectory, "external-application");
  await mkdir(application);
  await execFileAsync("git", ["init", "--quiet"], { cwd: application });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: application,
  });
  await execFileAsync("git", ["config", "user.name", "Distribution Test"], {
    cwd: application,
  });

  const initialized = await invoke(
    runtimeEntry,
    ["init", "--yes"],
    application,
  );
  expect(initialized.code).toBe(0);
  expect(initialized.stdout).toContain("Initialized");

  const port = await freePort();
  await writeFile(
    join(application, "server.mjs"),
    `import { createServer } from "node:http";\nconst server = createServer((_request, response) => {\n  response.writeHead(200, { "content-type": "text/html" });\n  response.end("<!doctype html><title>Example</title><main><h1>Hello Idiom</h1></main>");\n});\nserver.listen(Number(process.env.PORT), "127.0.0.1");\nprocess.on("SIGTERM", () => server.close(() => process.exit(0)));\nprocess.on("SIGINT", () => server.close(() => process.exit(0)));\n`,
  );
  await writeFile(
    join(application, ".idiom", "project.json"),
    `${JSON.stringify(
      {
        version: 1,
        app: { name: "external-application", framework: "other" },
        server: {
          build: "node --check server.mjs",
          start: "node server.mjs",
          readyUrl: `http://127.0.0.1:${port}/`,
          port,
          env: { PORT: String(port) },
          startupTimeoutMs: 5_000,
        },
        viewports: [{ name: "desktop", width: 800, height: 600 }],
        colorSchemes: ["light"],
        capture: {
          timezoneId: "America/New_York",
          locale: "en-US",
          colorScheme: "light",
          reducedMotion: true,
          fullPage: true,
          settleMs: 0,
        },
        design: { productFile: "PRODUCT.md", designFile: "DESIGN.md" },
        model: {
          provider: "claude-code",
          model: "claude-sonnet-4-5",
          maxFindings: 5,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(application, ".idiom", "flows", "hello.json"),
    `${JSON.stringify(
      {
        id: "hello",
        title: "Hello",
        intent: ["Show the greeting"],
        setup: [],
        states: [
          {
            id: "home",
            description: "Greeting page",
            url: "/",
            expect: {
              status: 200,
              textPresent: ["Hello Idiom"],
              selectorPresent: ["h1"],
              selectorAbsent: [],
            },
            mask: [],
          },
        ],
        viewports: ["desktop"],
      },
      null,
      2,
    )}\n`,
  );
  await execFileAsync("git", ["add", "."], { cwd: application });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: application,
  });

  const validated = await invoke(
    runtimeEntry,
    ["validate", "hello"],
    application,
  );
  expect(validated.code).toBe(0);
  expect(validated.stdout).toContain(
    "Validated external-application: hello (color schemes: light)",
  );

  const captured = await invoke(
    runtimeEntry,
    ["capture", "hello"],
    application,
  );
  expect(captured.code).toBe(0);
  expect(captured.stdout).toContain(
    "Captured hello: 1 passed, 0 failed, 1 total",
  );
  const reportsDirectory = join(application, ".idiom", "reports");
  const reports = await readdir(reportsDirectory);
  expect(reports).toHaveLength(1);
  const report = join(reportsDirectory, reports[0] ?? "");
  expect(await listFiles(report)).toEqual(
    expect.arrayContaining([
      "baseline.md",
      "home/desktop/axe.json",
      "home/desktop/console.jsonl",
      "home/desktop/dom.html",
      "home/desktop/metadata.json",
      "home/desktop/observations.json",
      "home/desktop/screenshot.png",
    ]),
  );
}, 30_000);

test("packed CLI completes the zero-configuration quick path outside Git", async () => {
  const application = join(temporaryDirectory, "quick-external-application");
  await mkdir(application);
  const port = await freePort();
  const serverPath = join(application, "server.mjs");
  await writeFile(
    serverPath,
    `import { createServer } from "node:http";\nconst server = createServer((_request, response) => {\n  response.writeHead(200, { "content-type": "text/html" });\n  response.end("<!doctype html><title>Quick</title><main><h1>Quick result</h1><button>Continue</button></main>");\n});\nserver.listen(${port}, "127.0.0.1");\nprocess.on("SIGTERM", () => server.close(() => process.exit(0)));\n`,
  );
  const server = spawn(process.execPath, [serverPath], {
    cwd: application,
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolveExit) =>
    server.once("exit", () => resolveExit()),
  );
  try {
    const target = `http://127.0.0.1:${port}/`;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(target);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    expect(ready).toBe(true);
    const output = join(application, "quick-output");
    const reviewed = await invoke(
      runtimeEntry,
      ["quick", target, "--out", output],
      application,
    );
    expect(reviewed.code).toBe(0);
    expect(reviewed.stdout).toContain("Quick review:");
    expect(reviewed.stderr).toBe("");
    const files = await listFiles(output);
    expect(files).toEqual(
      expect.arrayContaining([
        "findings.json",
        "report.html",
        "report.md",
        "page-1/desktop/light/metadata.json",
        "page-1/desktop/dark/metadata.json",
        "page-1/mobile/light/metadata.json",
        "page-1/mobile/dark/metadata.json",
      ]),
    );
    const findings = JSON.parse(
      await readFile(join(output, "findings.json"), "utf8"),
    );
    for (const finding of findings) findingSchema.parse(finding);
    expect(await readFile(join(output, "report.md"), "utf8")).toContain(
      "## Quick-review limits",
    );
  } finally {
    if (server.exitCode === null) server.kill("SIGTERM");
    await exited;
  }
}, 30_000);

test.each(["legacy", "auto"] as const)(
  "packed Node MCP serves %s negotiation with runtime dependencies only",
  async (mode) => {
    const application = join(temporaryDirectory, `mcp-${mode}-application`);
    await mkdir(application);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [runtimeEntry, "mcp"],
      cwd: application,
      stderr: "pipe",
    });
    const client = new Client(
      { name: "packed-test", version: "1" },
      { versionNegotiation: { mode } },
    );
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.version).toBe(originalVersion);
      for (const file of ["plugin.json", ".claude-plugin/plugin.json"]) {
        const plugin = JSON.parse(
          await readFile(join(runtimeRoot, file), "utf8"),
        );
        expect(client.getServerVersion()?.version).toBe(plugin.version);
      }
      expect((await client.listTools()).tools).toHaveLength(15);
      const response = await client.callTool({
        name: "idiom_flows",
        arguments: {},
      });
      expect(response).toMatchObject({ isError: true });
      expect(JSON.stringify(response)).toContain("idiom init");
      const initialized = await client.callTool({
        name: "idiom_init",
        arguments: {},
      });
      expect(initialized.isError).not.toBe(true);
      expect(
        JSON.parse(
          await readFile(join(application, ".idiom/project.json"), "utf8"),
        ),
      ).toHaveProperty("version", 1);
      await expect(
        readFile(join(runtimeRoot, ".idiom/project.json")),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  },
  30000,
);

test("packed plugin resolves the existing skill and adjacent init guide and validates with Claude", async () => {
  expect(packedFiles).toContain(".claude-plugin/plugin.json");
  const manifest = JSON.parse(
    await readFile(join(runtimeRoot, ".claude-plugin/plugin.json"), "utf8"),
  );
  expect(manifest.mcpServers.idiom).toEqual({
    type: "stdio",
    command: "npx",
    args: [
      "-y",
      `--package=https://github.com/mattskilly/idiom/releases/download/v${originalVersion}/mattskilly-idiom-${originalVersion}.tgz`,
      "idiom",
      "mcp",
    ],
  });
  const portableMcp = JSON.parse(
    await readFile(join(runtimeRoot, "mcp.json"), "utf8"),
  );
  expect(portableMcp.mcpServers.idiom).toEqual(manifest.mcpServers.idiom);
  const codexCatalog = JSON.parse(
    await readFile(
      join(runtimeRoot, ".agents/plugins/marketplace.json"),
      "utf8",
    ),
  );
  expect(codexCatalog.plugins[0].source).toEqual({
    source: "local",
    path: "./",
  });
  const portable = JSON.parse(
    await readFile(
      join(runtimeRoot, codexCatalog.plugins[0].source.path, "plugin.json"),
      "utf8",
    ),
  );
  expect(portable.version).toBe(originalVersion);
  expect(portable.extensions["com.openai"].hooks).toEqual({ hooks: {} });
  // Both plugins load the portable skill through default skills/ discovery.
  expect(manifest.skills).toBeUndefined();
  expect(portable.skills).toBeUndefined();
  for (const file of [
    "hooks/hooks.json",
    "hooks/lib.mjs",
    "hooks/post-tool-use.mjs",
    "hooks/stop.mjs",
  ])
    expect(packedFiles).toContain(file);
  const hookConfig = JSON.parse(
    await readFile(join(runtimeRoot, "hooks/hooks.json"), "utf8"),
  );
  expect(manifest.hooks).toBeUndefined();
  expect(hookConfig.hooks.PostToolUse[0].matcher).toBe(
    "^(Edit|Write|MultiEdit)$",
  );
  const application = join(temporaryDirectory, "hook application with spaces");
  await mkdir(application);
  expect(
    (await invoke(runtimeEntry, ["init", "--yes"], application)).code,
  ).toBe(0);
  await writeFile(
    join(application, "Page.tsx"),
    "export const Page = 'packed';",
  );
  const runHook = async (entry: string, input: object) => {
    const { stdout, stderr } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [join(runtimeRoot, `hooks/${entry}.mjs`)],
        { cwd: application },
        (error, stdout, stderr) =>
          error ? reject(error) : resolve({ stdout, stderr }),
      );
      child.stdin?.end(
        JSON.stringify({ cwd: application, session_id: "packed", ...input }),
      );
    });
    expect(stderr).toBe("");
    return stdout ? JSON.parse(stdout) : undefined;
  };
  expect(hookConfig.hooks.PostToolUse[0].hooks[0].command).toBe(
    `node "\${CLAUDE_PLUGIN_ROOT}/hooks/post-tool-use.mjs"`,
  );
  expect(hookConfig.hooks.Stop[0].hooks[0].command).toBe(
    `node "\${CLAUDE_PLUGIN_ROOT}/hooks/stop.mjs"`,
  );
  expect(
    (
      await runHook("post-tool-use", {
        tool_name: "Write",
        tool_input: { file_path: "Page.tsx" },
      })
    ).hookSpecificOutput.additionalContext,
  ).toContain("Page.tsx");
  expect((await runHook("stop", {})).decision).toBe("block");
  expect(await runHook("stop", {})).toBeUndefined();
  const packedSkills = packedFiles.filter((file) =>
    /^skills\/[^/]+\/SKILL\.md$/.test(file),
  );
  expect(packedSkills).toEqual(["skills/idiom/SKILL.md"]);
  expect(
    await readFile(join(runtimeRoot, "skills/idiom/SKILL.md"), "utf8"),
  ).toMatch(/^---\nname: idiom\n[\s\S]*prefer MCP tools/);
  expect(
    await readFile(
      join(runtimeRoot, "skills/idiom/references/init.md"),
      "utf8",
    ),
  ).toContain("idiom init");
  const validation = await execFileAsync(
    "claude",
    ["plugin", "validate", runtimeRoot],
    { timeout: 45000 },
  );
  expect(validation.stdout).toContain("Validation passed");
  const marketplaceValidation = await execFileAsync(
    "claude",
    [
      "plugin",
      "validate",
      join(runtimeRoot, ".claude-plugin/marketplace.json"),
    ],
    { timeout: 45000 },
  );
  expect(marketplaceValidation.stdout).toContain("Validation passed");
}, 60000);

test("built stdio keeps setup stdout off the wire and cleans children after cancellation and EOF", async () => {
  const project = join(temporaryDirectory, "stdio project with spaces");
  await initProject({ project, yes: true });
  const flow = {
    id: "slow",
    title: "Slow",
    intent: [],
    setup: [{ run: "node setup.mjs", env: {} }],
    states: [{ id: "page", description: "Page", url: "/", expect: {} }],
  };
  await writeFile(
    join(project, ".idiom/flows/slow.json"),
    JSON.stringify(flow),
  );
  await writeFile(
    join(project, "setup.mjs"),
    "import {writeFileSync} from 'node:fs'; console.log('setup output must be captured'); writeFileSync('setup.pid',String(process.pid)); setInterval(()=>{},1000);",
  );
  await git(project, "init", "-q", "-b", "main");
  await commit(project, "stdio fixture");
  const child = spawn(
    process.execPath,
    [runtimeEntry, "mcp", "--project", project],
    { cwd: temporaryDirectory, stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines: string[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    lines.push(...parts.filter(Boolean));
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  const send = (value: object) =>
    child.stdin.write(`${JSON.stringify(value)}\n`);
  const response = (id: number) =>
    vi.waitFor(
      () => {
        const line = lines
          .map((line) => JSON.parse(line) as { id?: number; result?: unknown })
          .find((line) => line.id === id);
        expect(line, stderr).toBeDefined();
        return line;
      },
      { timeout: 10000 },
    );
  const runningPid = async () => {
    let pid = 0;
    await vi.waitFor(
      async () => {
        pid = Number(await readFile(join(project, "setup.pid"), "utf8"));
        expect(pid).toBeGreaterThan(0);
      },
      { timeout: 10000 },
    );
    return pid;
  };
  const gone = async (pid: number) =>
    vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow();
      },
      { timeout: 7000 },
    );
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "wire-test", version: "1" },
      },
    });
    await response(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "idiom_check",
        arguments: { flow: "slow", all: true },
        _meta: { progressToken: "capture" },
      },
    });
    const firstPid = await runningPid();
    send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2, reason: "cancel test" },
    });
    await gone(firstPid);
    send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    await response(3);
    await rm(join(project, "setup.pid"));
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "idiom_check", arguments: { flow: "slow", all: true } },
    });
    const secondPid = await runningPid();
    child.stdin.end();
    await expect(
      Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("stdio did not exit")),
            8000,
          ).unref(),
        ),
      ]),
    ).resolves.toBe(0);
    await gone(secondPid);
    await expect(
      readFile(join(project, ".idiom/agent-hooks/state.json")),
    ).rejects.toThrow();
    expect(buffer).toBe("");
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines)
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    expect(lines.join("\n")).not.toContain("setup output must be captured");
  } finally {
    child.kill("SIGTERM");
    child.stdin.destroy();
  }
}, 40000);

test("packed changed checking loads the runtime TypeScript parser with runtime dependencies only", async () => {
  const f = await changedFixture();
  try {
    await f.write(
      "app/uncovered/page.tsx",
      "export default function Page() { return <main />; }",
    );
    const response = await invoke(
      runtimeEntry,
      ["check", "--changed", "--json"],
      f.directory,
    );
    expect(response.code, response.stderr).toBe(0);
    const output = JSON.parse(response.stdout);
    expect(output.selection.files[0]).toMatchObject({
      path: "app/uncovered/page.tsx",
      kind: "route",
      routes: ["/uncovered"],
    });
    expect(output.checkedStates).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("ordinary packed commands do not load the changed-check parser", async () => {
  const parser = join(runtimeRoot, "node_modules/typescript");
  const hidden = `${parser}.hidden`;
  await rename(parser, hidden);
  try {
    const response = await invoke(
      runtimeEntry,
      ["--version"],
      temporaryDirectory,
    );
    expect(response.code, response.stderr).toBe(0);
    expect(response.stdout).toContain(originalVersion);
  } finally {
    await rename(hidden, parser);
  }
});

test("packed Node CLI ships offline history and upgrades project skills without Autobuild", async () => {
  expect(packedFiles).toContain("templates/skill-history/catalog.json");
  const project = join(temporaryDirectory, "skill-upgrade-project");
  await mkdir(project);
  expect(
    (await invoke(runtimeEntry, ["--project", project, "init", "--yes"])).code,
  ).toBe(0);
  const pristine = join(project, ".agents/skills/.idiom-pristine");
  const provenance = JSON.parse(
    await readFile(join(pristine, "manifest.json"), "utf8"),
  );
  expect(provenance.files["idiom/SKILL.md"].version).toBe(originalVersion);
  const local = join(project, ".agents/skills/idiom/SKILL.md");
  const baseline = await readFile(local, "utf8");
  await writeFile(local, `${baseline}\nRepository customization.\n`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await invoke(runtimeEntry, [
      "--project",
      project,
      "upgrade",
      "--json",
      "--no-agent",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      installedVersion: originalVersion,
      files: [{ action: "current" }, { action: "current" }],
    });
    expect(await readFile(local, "utf8")).toBe(
      `${baseline}\nRepository customization.\n`,
    );
    expect(await readFile(join(pristine, "idiom/SKILL.md"), "utf8")).toBe(
      baseline,
    );
  }
  const { files } = JSON.parse(
    await readFile(
      join(runtimeRoot, "templates/skill-history/catalog.json"),
      "utf8",
    ),
  ).releases[0];
  const legacy = join(temporaryDirectory, "skill-upgrade-legacy");
  await mkdir(join(legacy, ".agents/skills/idiom"), { recursive: true });
  for (const [key, hash] of Object.entries(files))
    await copyFile(
      join(runtimeRoot, `templates/skill-history/blobs/${hash}.md`),
      join(legacy, `.agents/skills/${key}`),
    );
  const upgraded = await invoke(runtimeEntry, [
    "--project",
    legacy,
    "upgrade",
    "--json",
    "--no-agent",
  ]);
  expect(upgraded.code).toBe(0);
  expect(
    JSON.parse(upgraded.stdout).files.some(
      (file: { action: string }) => file.action === "adopted",
    ),
  ).toBe(true);
});
