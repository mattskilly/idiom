import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../src/cli.js";
import { RUN_FAILURE_EXIT_CODE } from "../src/errors.js";
import { createIdiomMcpServer } from "../src/mcp/server.js";
import {
  CODEX_MCP_CLIENT,
  checkForUpdate,
  createUpdateNoticeSession,
  detectInstall,
  isNewer,
  readCachedUpdate,
  registryLatestUrl,
  UPDATE_CHECK_FAILURE_TTL_MS,
  UPDATE_CHECK_TTL_MS,
  type UpdateCheckDependencies,
  type UpdateCheckOptions,
  type UpdateNoticeSession,
  type UpdateTimer,
  updateCommand,
} from "../src/update/notice.js";
import { IDIOM_PACKAGE_ROOT } from "../src/version.js";
import { mcpClient } from "./mcp-support.js";

const directories: string[] = [];
const sessions: UpdateNoticeSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  // Every cache write has settled before its directory is removed.
  await Promise.all(sessions.splice(0).map((session) => session.settled()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3 }),
      ),
  );
});

/** A scheduler fired by hand, so no test waits on wall time. */
function manualTimer() {
  const callbacks: Array<() => void> = [];
  const setTimer: UpdateTimer = (callback) => {
    callbacks.push(callback);
    return () => {
      const index = callbacks.indexOf(callback);
      if (index >= 0) callbacks.splice(index, 1);
    };
  };
  return {
    setTimer,
    get pending() {
      return callbacks.length;
    },
    fire() {
      for (const callback of callbacks.splice(0)) callback();
    },
  };
}

async function noticeSession(
  options: Parameters<typeof createUpdateNoticeSession>[0],
) {
  const created = await createUpdateNoticeSession(options);
  sessions.push(created);
  return created;
}

async function temporary(prefix = "idiom-update-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function packageAt(...segments: string[]): Promise<string> {
  const root = join(await temporary(), ...segments);
  await mkdir(root, { recursive: true });
  return root;
}

const npmGlobal = () =>
  packageAt("lib", "node_modules", "@mattskilly", "idiom");

async function npxInstall(spec: string): Promise<string> {
  const root = await packageAt(
    "_npx",
    "0a1b2c",
    "node_modules",
    "@mattskilly",
    "idiom",
  );
  await writeFile(
    join(root, "..", "..", "..", "package.json"),
    JSON.stringify({ dependencies: { "@mattskilly/idiom": spec } }),
  );
  return root;
}

const RELEASE =
  "https://github.com/mattskilly/idiom/releases/download/v0.18.0/mattskilly-idiom-0.18.0.tgz";

function registry(version: unknown = "0.19.0") {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ version }), { status: 200 }),
  );
}

async function dependencies(
  overrides: Partial<UpdateCheckOptions> = {},
): Promise<UpdateCheckOptions & { fetch: ReturnType<typeof registry> }> {
  return {
    env: {},
    now: () => 1_000_000_000,
    cacheDirectory: join(await temporary(), "cache"),
    packageRoot: await npmGlobal(),
    currentVersion: "0.18.0",
    fetch: registry(),
    setTimer: manualTimer().setTimer,
    ...overrides,
  } as UpdateCheckOptions & { fetch: ReturnType<typeof registry> };
}

const NPM_COMMAND = "idiom upgrade";
const NOTICE = `Idiom 0.19.0 is available (you have 0.18.0). Update: ${NPM_COMMAND}`;

test("a newer stable release gives the notice for the install kind", async () => {
  const deps = await dependencies();
  await expect(checkForUpdate(deps)).resolves.toEqual({
    current: "0.18.0",
    latest: "0.19.0",
    command: NPM_COMMAND,
  });
  expect(deps.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = deps.fetch.mock.calls[0] ?? [];
  expect(url).toBe("https://registry.npmjs.org/@mattskilly%2fidiom/latest");
  expect(init?.method).toBe("GET");
  expect(init?.body).toBeUndefined();
  const headers = (init?.headers ?? {}) as Record<string, string>;
  expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
  expect(headers["user-agent"]).toBe(
    `idiom/0.18.0 (node ${process.version}; ${process.platform})`,
  );
});

test.each([
  ["0.18.0", "equal"],
  ["0.17.9", "older"],
  ["0.20.0-rc.1", "prerelease"],
  ["not-a-version", "invalid"],
])("latest %s (%s) gives no notice", async (latest) => {
  const deps = await dependencies({ fetch: registry(latest) });
  await expect(checkForUpdate(deps)).resolves.toBeUndefined();
});

test("version comparison", () => {
  expect(isNewer("0.18.0", "0.18.0-rc.2")).toBe(true);
  expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("0.19.0+build.1", "0.18.0")).toBe(true);
  expect(isNewer("0.18.0-rc.3", "0.18.0-rc.2")).toBe(false);
  expect(isNewer("0.19.0", "garbage")).toBe(false);
});

test("a fetch that never answers settles at the deadline", async () => {
  const timer = manualTimer();
  let aborted = false;
  const deps = await dependencies({
    setTimer: timer.setTimer,
    fetch: vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    ) as unknown as ReturnType<typeof registry>,
  });
  const result = checkForUpdate(deps);
  await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalled());
  expect(timer.pending).toBe(1);
  timer.fire();
  await expect(result).resolves.toBeUndefined();
  expect(aborted).toBe(true);
  // The backoff write settled before the check did.
  expect(await readdir(deps.cacheDirectory as string)).toEqual([
    "update-check.json",
  ]);
  await expect(checkForUpdate(deps)).resolves.toBeUndefined();
  expect(deps.fetch).toHaveBeenCalledTimes(1);
});

test("a fetch that ignores its abort signal still settles at the deadline", async () => {
  const timer = manualTimer();
  const deps = await dependencies({
    setTimer: timer.setTimer,
    fetch: vi.fn(
      () => new Promise<Response>(() => {}),
    ) as unknown as ReturnType<typeof registry>,
  });
  const result = checkForUpdate(deps);
  await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalled());
  timer.fire();
  await expect(result).resolves.toBeUndefined();
  expect(await readdir(deps.cacheDirectory as string)).toEqual([
    "update-check.json",
  ]);
});

test("an answered check cancels its deadline", async () => {
  const timer = manualTimer();
  const deps = await dependencies({ setTimer: timer.setTimer });
  await expect(checkForUpdate(deps)).resolves.toBeDefined();
  expect(timer.pending).toBe(0);
});

test.each([
  [
    "a rejected fetch",
    async () => {
      throw new Error("offline");
    },
  ],
  ["a non-2xx status", async () => new Response("{}", { status: 503 })],
  ["a non-JSON body", async () => new Response("<html>", { status: 200 })],
  ["a missing version", async () => new Response("{}", { status: 200 })],
  [
    "a non-string version",
    async () => new Response('{"version":19}', { status: 200 }),
  ],
])("%s gives no notice", async (_label, fetcher) => {
  const deps = await dependencies({
    fetch: vi.fn(fetcher) as unknown as ReturnType<typeof registry>,
  });
  await expect(checkForUpdate(deps)).resolves.toBeUndefined();
});

test("a fresh cache answers without the network and expires after a day", async () => {
  let now = 1_000_000_000;
  const deps = await dependencies({ now: () => now });
  expect(await checkForUpdate(deps)).toBeDefined();
  now += UPDATE_CHECK_TTL_MS - 1;
  expect(await checkForUpdate(deps)).toMatchObject({ latest: "0.19.0" });
  expect(deps.fetch).toHaveBeenCalledTimes(1);
  now += 1;
  expect(await checkForUpdate(deps)).toBeDefined();
  expect(deps.fetch).toHaveBeenCalledTimes(2);
});

test("a failed probe backs off for an hour, then retries", async () => {
  let now = 1_000_000_000;
  let fail = true;
  const fetcher = vi.fn(async () =>
    fail
      ? new Response("", { status: 500 })
      : new Response('{"version":"0.19.0"}', { status: 200 }),
  );
  const deps = await dependencies({
    now: () => now,
    fetch: fetcher as unknown as ReturnType<typeof registry>,
  });
  expect(await checkForUpdate(deps)).toBeUndefined();
  fail = false;
  now += UPDATE_CHECK_FAILURE_TTL_MS - 1;
  expect(await checkForUpdate(deps)).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += 1;
  expect(await checkForUpdate(deps)).toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("a different registry misses the cache", async () => {
  const deps = await dependencies();
  await checkForUpdate(deps);
  await checkForUpdate({
    ...deps,
    env: { NPM_CONFIG_REGISTRY: "https://r.example/npm/" },
  });
  expect(deps.fetch).toHaveBeenCalledTimes(2);
  expect(deps.fetch.mock.calls[1]?.[0]).toBe(
    "https://r.example/npm/@mattskilly%2fidiom/latest",
  );
});

test("a cached latest is compared with the version now running", async () => {
  const deps = await dependencies();
  await checkForUpdate(deps);
  await expect(
    checkForUpdate({ ...deps, currentVersion: "0.19.0" }),
  ).resolves.toBeUndefined();
  expect(deps.fetch).toHaveBeenCalledTimes(1);
});

test("an unwritable cache directory still gives the notice", async () => {
  const blocker = join(await temporary(), "file");
  await writeFile(blocker, "");
  const deps = await dependencies({ cacheDirectory: join(blocker, "cache") });
  await expect(checkForUpdate(deps)).resolves.toMatchObject({
    latest: "0.19.0",
  });
});

test.each([
  [{ IDIOM_NO_UPDATE_CHECK: "1" }],
  [{ NO_UPDATE_NOTIFIER: "1" }],
  [{ CI: "true" }],
])("off switch %o makes no request and writes no cache", async (env) => {
  const deps = await dependencies({ env });
  await expect(checkForUpdate(deps)).resolves.toBeUndefined();
  expect(deps.fetch).not.toHaveBeenCalled();
  await expect(readdir(deps.cacheDirectory as string)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("CI=false and IDIOM_NO_UPDATE_CHECK=0 do not turn the check off", async () => {
  const deps = await dependencies({
    env: { CI: "false", IDIOM_NO_UPDATE_CHECK: "0" },
  });
  await expect(checkForUpdate(deps)).resolves.toBeDefined();
});

test('"updateCheck": false in the project turns the check off', async () => {
  const project = await temporary();
  await mkdir(join(project, ".idiom"));
  await writeFile(
    join(project, ".idiom", "project.json"),
    JSON.stringify({ updateCheck: false }),
  );
  const deps = await dependencies();
  await expect(
    checkForUpdate({ ...deps, cwd: join(project) }),
  ).resolves.toBeUndefined();
  expect(deps.fetch).not.toHaveBeenCalled();
  await expect(readdir(deps.cacheDirectory as string)).rejects.toMatchObject({
    code: "ENOENT",
  });
  // An unreadable project file is not an off switch.
  await writeFile(join(project, ".idiom", "project.json"), "{");
  await expect(
    checkForUpdate({ ...deps, cwd: project }),
  ).resolves.toBeDefined();
});

test("source checkouts and unidentified installs never check", async () => {
  const withCli = await temporary();
  await mkdir(join(withCli, "src"));
  await writeFile(join(withCli, "src", "cli.ts"), "");
  const withGit = await temporary();
  await mkdir(join(withGit, ".git"));
  const local = await packageAt("app", "node_modules", "@mattskilly", "idiom");
  expect(detectInstall(IDIOM_PACKAGE_ROOT, {})).toBe("source");
  for (const packageRoot of [withCli, withGit, local]) {
    const deps = await dependencies({ packageRoot });
    await expect(checkForUpdate(deps)).resolves.toBeUndefined();
    expect(deps.fetch).not.toHaveBeenCalled();
  }
  expect(detectInstall(local, {})).toBe("unknown");
});

test("each install kind names its exact update command", async () => {
  const bun = await packageAt(
    ".bun",
    "install",
    "global",
    "node_modules",
    "@mattskilly",
    "idiom",
  );
  const windows = await packageAt(
    "AppData",
    "Roaming",
    "npm",
    "node_modules",
    "@mattskilly",
    "idiom",
  );
  const npx = await npxInstall("^0.18.0");
  const plugin = await npxInstall(RELEASE);
  const bunxTemp = await packageAt(
    "bunx-501-@mattskilly",
    "idiom@latest",
    "node_modules",
    "@mattskilly",
    "idiom",
  );
  const bunxCache = await packageAt(
    ".bun",
    "install",
    "cache",
    "@mattskilly",
    "idiom@0.18.0@@@1",
  );
  const codex = { name: CODEX_MCP_CLIENT };
  const codexCommand =
    "codex plugin marketplace upgrade idiom && codex plugin add idiom@idiom && codex mcp add idiom -- npx -y --package=https://github.com/mattskilly/idiom/releases/download/v0.19.0/mattskilly-idiom-0.19.0.tgz idiom mcp";
  const claudeCommand =
    "claude plugin marketplace update idiom && claude plugin update idiom@idiom";
  const cases = [
    [await npmGlobal(), {}, undefined, "npm-global", NPM_COMMAND],
    [windows, {}, undefined, "npm-global", NPM_COMMAND],
    [bun, {}, undefined, "bun-global", "idiom upgrade"],
    [npx, {}, undefined, "npx", "npx -y @mattskilly/idiom@latest upgrade"],
    // A hand-run `npx --package=<tarball> idiom` is an npx install.
    [plugin, {}, undefined, "npx", "npx -y @mattskilly/idiom@latest upgrade"],
    [plugin, {}, codex, "codex-plugin", codexCommand],
    [
      plugin,
      { CLAUDE_PLUGIN_ROOT: "/plugins/idiom" },
      undefined,
      "claude-plugin",
      claudeCommand,
    ],
    // The Claude marker wins over the client name.
    [
      plugin,
      { CLAUDE_PLUGIN_ROOT: "/plugins/idiom" },
      codex,
      "claude-plugin",
      claudeCommand,
    ],
    [bunxTemp, {}, undefined, "bunx", "bunx @mattskilly/idiom@latest upgrade"],
    [bunxCache, {}, undefined, "bunx", "bunx @mattskilly/idiom@latest upgrade"],
  ] as const;
  for (const [packageRoot, env, client, kind, command] of cases) {
    expect(detectInstall(packageRoot, env, client)).toBe(kind);
    const deps = await dependencies({ packageRoot, env, client });
    await expect(checkForUpdate(deps)).resolves.toEqual({
      current: "0.18.0",
      latest: "0.19.0",
      command,
    });
  }
  expect(updateCommand("npm-global", "1.0.0")).toBe(NPM_COMMAND);
});

test("the registry honours NPM_CONFIG_REGISTRY and npm's lowercase export", () => {
  expect(registryLatestUrl({})).toBe(
    "https://registry.npmjs.org/@mattskilly%2fidiom/latest",
  );
  expect(
    registryLatestUrl({ NPM_CONFIG_REGISTRY: " https://r.example/npm/ " }),
  ).toBe("https://r.example/npm/@mattskilly%2fidiom/latest");
  expect(registryLatestUrl({ npm_config_registry: "https://l.example" })).toBe(
    "https://l.example/@mattskilly%2fidiom/latest",
  );
});

test("the check never writes to stdout or stderr", async () => {
  const out = vi.spyOn(process.stdout, "write");
  const err = vi.spyOn(process.stderr, "write");
  const deps = await dependencies();
  await checkForUpdate(deps);
  await checkForUpdate({ ...deps, fetch: registry("garbage"), now: () => 0 });
  await readCachedUpdate(deps);
  expect(out).not.toHaveBeenCalled();
  expect(err).not.toHaveBeenCalled();
});

// CLI surfaces. `doctor` in an empty directory fails fast with a RunFailure,
// so it exercises JSON, the human line and failure ordering without a server.

async function cli(argv: string[], updateCheck: UpdateCheckDependencies) {
  const cwd = await temporary("idiom-update-cli-");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["node", "idiom", ...argv], {
    cwd,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    updateCheck,
  });
  return { code, cwd, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("doctor --json carries update only when a newer version exists", async () => {
  const newer = await cli(["doctor", "--json"], await dependencies());
  expect(newer.code).toBe(RUN_FAILURE_EXIT_CODE);
  expect(JSON.parse(newer.stdout).update).toEqual({
    current: "0.18.0",
    latest: "0.19.0",
    command: NPM_COMMAND,
  });
  expect(newer.stderr).not.toContain("is available");

  const same = await cli(
    ["doctor", "--json"],
    await dependencies({ fetch: registry("0.18.0") }),
  );
  expect(JSON.parse(same.stdout)).not.toHaveProperty("update");
});

test("a failing command prints the notice last, after Fix:, keeping its exit code", async () => {
  const result = await cli(["doctor"], await dependencies());
  expect(result.code).toBe(RUN_FAILURE_EXIT_CODE);
  const lines = result.stderr.trimEnd().split("\n");
  expect(lines.at(-1)).toBe(NOTICE);
  expect(lines.at(-2)).toMatch(/^Fix: /);
  expect(result.stdout).not.toContain("is available");
});

test("--version prints the version on stdout and the notice on stderr", async () => {
  const result = await cli(["--version"], await dependencies());
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("is available");
  expect(result.stderr).toBe(`${NOTICE}\n`);
});

test("--help never checks", async () => {
  const deps = await dependencies();
  await cli(["--help"], deps);
  expect(deps.fetch).not.toHaveBeenCalled();
});

test("init --yes prints the notice after its summary", async () => {
  const result = await cli(["init", "--yes"], await dependencies());
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("created");
  expect(result.stderr).toBe(`${NOTICE}\n`);
});

test("commands outside the notice set never check", async () => {
  const deps = await dependencies();
  const result = await cli(["validate"], deps);
  expect(result.code).toBe(1);
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(result.stderr).not.toContain("is available");
});

// MCP surfaces.

async function emptyProject(): Promise<string> {
  return temporary("idiom-update-mcp-");
}

async function doctorCall(session: Awaited<ReturnType<typeof mcpClient>>) {
  const response = (await session.client.callTool({
    name: "idiom_doctor",
    arguments: {},
  })) as {
    content: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
  return {
    texts: response.content.map((item) => item.text ?? ""),
    update: response.structuredContent?.update,
  };
}

test("a cached newer version rides the initialize instructions, once", async () => {
  const deps = await dependencies();
  await checkForUpdate(deps);
  deps.fetch.mockClear();
  const project = await emptyProject();
  const update = await noticeSession({ ...deps, cwd: project });
  const session = await mcpClient({ project, update });
  try {
    expect(session.client.getInstructions()).toBe(NOTICE);
    const call = await doctorCall(session);
    expect(call.texts).not.toContain(NOTICE);
    expect(call.update).toBeUndefined();
    expect(deps.fetch).not.toHaveBeenCalled();
  } finally {
    await session.close();
    await update.settled();
  }
});

test("on a cold cache the first idiom_doctor result carries the notice, once", async () => {
  const deps = await dependencies();
  const project = await emptyProject();
  const update = await noticeSession({ ...deps, cwd: project });
  const session = await mcpClient({ project, update });
  try {
    expect(session.client.getInstructions()).toBeUndefined();
    const first = await doctorCall(session);
    expect(first.texts.at(-1)).toBe(NOTICE);
    expect(first.update).toEqual({
      current: "0.18.0",
      latest: "0.19.0",
      command: NPM_COMMAND,
    });
    const second = await doctorCall(session);
    expect(second.texts).not.toContain(NOTICE);
    expect(second.update).toBeUndefined();
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  } finally {
    await session.close();
    await update.settled();
  }
});

test("an off switch keeps MCP silent and offline", async () => {
  const deps = await dependencies({ env: { IDIOM_NO_UPDATE_CHECK: "1" } });
  const project = await emptyProject();
  const update = await noticeSession({ ...deps, cwd: project });
  const session = await mcpClient({ project, update });
  try {
    expect(session.client.getInstructions()).toBeUndefined();
    const call = await doctorCall(session);
    expect(call.update).toBeUndefined();
    expect(deps.fetch).not.toHaveBeenCalled();
  } finally {
    await session.close();
    await update.settled();
  }
});

test("a notifying MCP session never writes to process stdout", async () => {
  const out = vi.spyOn(process.stdout, "write");
  const deps = await dependencies();
  const project = await emptyProject();
  const update = await noticeSession({ ...deps, cwd: project });
  const session = await mcpClient({ project, update });
  try {
    await doctorCall(session);
    await doctorCall(session);
  } finally {
    await session.close();
    await update.settled();
  }
  expect(out).not.toHaveBeenCalled();
});

test("an ambiguous tarball install withholds instructions and gives the npx command", async () => {
  const deps = await dependencies({ packageRoot: await npxInstall(RELEASE) });
  await checkForUpdate(deps);
  const project = await emptyProject();
  const update = await noticeSession({ ...deps, cwd: project });
  const session = await mcpClient({ project, update });
  try {
    expect(session.client.getInstructions()).toBeUndefined();
    const first = await doctorCall(session);
    expect(first.update).toMatchObject({
      command: "npx -y @mattskilly/idiom@latest upgrade",
    });
    const second = await doctorCall(session);
    expect(second.update).toBeUndefined();
  } finally {
    await session.close();
    await update.settled();
  }
});

test("a Codex client on a tarball install gets the Codex command", async () => {
  const out = vi.spyOn(process.stdout, "write");
  const deps = await dependencies({ packageRoot: await npxInstall(RELEASE) });
  const project = await emptyProject();
  const update = await noticeSession({ ...deps, cwd: project });
  // One server for the whole session, as over stdio, so it sees clientInfo.
  const server = createIdiomMcpServer({ project, update });
  const client = new Client({ name: CODEX_MCP_CLIENT, version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const session = {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  } as Awaited<ReturnType<typeof mcpClient>>;
  try {
    expect(session.client.getInstructions()).toBeUndefined();
    const first = await doctorCall(session);
    expect(first.update).toMatchObject({
      command: expect.stringMatching(/^codex plugin marketplace upgrade idiom/),
    });
  } finally {
    await session.close();
    await update.settled();
  }
  expect(out).not.toHaveBeenCalled();
});

test("a cold-cache session settles with its cache written", async () => {
  const deps = await dependencies();
  const update = await noticeSession({ ...deps, cwd: await emptyProject() });
  await update.settled();
  expect(await readdir(deps.cacheDirectory as string)).toEqual([
    "update-check.json",
  ]);
});
