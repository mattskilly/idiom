import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { type UpdateTimer, updateCommand } from "../src/update/notice.js";
import {
  type CommandResult,
  type SelfUpdateDependencies,
  type SelfUpdateOptions,
  selfUpdate,
} from "../src/update/self-update.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3 }),
      ),
  );
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-self-update-"));
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
const bunGlobal = () =>
  packageAt(
    ".bun",
    "install",
    "global",
    "node_modules",
    "@mattskilly",
    "idiom",
  );

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
const EXEC = "/usr/local/bin/node";
const ARGS = ["--project", "site", "upgrade", "--no-agent"];

function registry(version = "0.19.0") {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ version }), { status: 200 }),
  );
}

const ok = (stdout = ""): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

/** A runner whose install succeeds and whose --version reports `version`. */
function runner(version = "0.19.0", install: CommandResult = ok()) {
  return vi.fn(async (argv: string[]) =>
    argv.includes("--version")
      ? ok(`${version} (abc1234) · interface 1\n`)
      : install,
  );
}

async function setup(overrides: Partial<SelfUpdateDependencies> = {}) {
  const dependencies = {
    env: {},
    now: () => 1_000_000_000,
    cacheDirectory: join(await temporary(), "cache"),
    packageRoot: await npmGlobal(),
    currentVersion: "0.18.0",
    fetch: registry(),
    setTimer: () => () => {},
    run: runner(),
    handoff: vi.fn(async () => 0 as number | null),
    execPath: EXEC,
    ...overrides,
  };
  return dependencies as typeof dependencies & {
    fetch: ReturnType<typeof registry>;
    run: ReturnType<typeof runner>;
  };
}

const options = (
  overrides: Partial<SelfUpdateOptions> = {},
): SelfUpdateOptions => ({
  cwd: "/work",
  selfUpdate: true,
  args: ARGS,
  ...overrides,
});

for (const [kind, root, install] of [
  ["npm", npmGlobal, ["npm", "install", "-g"]],
  ["bun", bunGlobal, ["bun", "add", "-g"]],
] as const) {
  test(`a ${kind} global install updates, checks the version and hands off`, async () => {
    const packageRoot = await root();
    const deps = await setup({ packageRoot, env: { PATH: "/bin" } });
    const write = vi.fn();
    const result = await selfUpdate(options({ write }), deps);
    const command = [...install, "@mattskilly/idiom@0.19.0"];
    // The root as detection resolved it (macOS tmp is a symlink).
    const entry = join(realpathSync(packageRoot), "dist", "cli.js");
    expect(result).toEqual({ kind: "handoff", exitCode: 0 });
    expect(deps.run.mock.calls).toEqual([
      [command, { cwd: "/work", env: { PATH: "/bin" } }],
      [
        [EXEC, entry, "--version"],
        { cwd: "/work", env: { PATH: "/bin", IDIOM_NO_UPDATE_CHECK: "1" } },
      ],
    ]);
    expect(deps.handoff).toHaveBeenCalledWith([EXEC, entry, ...ARGS], {
      cwd: "/work",
      env: {
        PATH: "/bin",
        IDIOM_SELF_UPDATE_HANDOFF: "1",
        IDIOM_SELF_UPDATE_FROM: "0.18.0",
        IDIOM_SELF_UPDATE_COMMAND: command.join(" "),
      },
    });
    expect(write).toHaveBeenCalledWith(
      `Updated the Idiom CLI 0.18.0 → 0.19.0 (ran: ${command.join(" ")}).`,
    );
  });
}

test("the handed-off child's exit code passes through", async () => {
  const deps = await setup({ handoff: vi.fn(async () => 1) });
  await expect(selfUpdate(options(), deps)).resolves.toEqual({
    kind: "handoff",
    exitCode: 1,
  });
});

test("the handed-off child never self-updates again and reports the update", async () => {
  const deps = await setup({
    currentVersion: "0.19.0",
    env: {
      IDIOM_SELF_UPDATE_HANDOFF: "1",
      IDIOM_SELF_UPDATE_FROM: "0.18.0",
      IDIOM_SELF_UPDATE_COMMAND: "npm install -g @mattskilly/idiom@0.19.0",
    },
  });
  await expect(selfUpdate(options(), deps)).resolves.toEqual({
    kind: "continue",
    cli: {
      from: "0.18.0",
      to: "0.19.0",
      command: "npm install -g @mattskilly/idiom@0.19.0",
      outcome: "updated",
    },
    lines: [],
  });
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.run).not.toHaveBeenCalled();
  expect(deps.handoff).not.toHaveBeenCalled();
});

test("a failed install stops before the version check and the handoff", async () => {
  const deps = await setup({
    run: runner("0.19.0", {
      exitCode: 1,
      stdout: "",
      stderr: "npm warn something\nnpm error code EACCES\n",
    }),
  });
  const result = await selfUpdate(options(), deps);
  expect(result).toMatchObject({
    kind: "failed",
    cli: {
      from: "0.18.0",
      to: "0.19.0",
      command: "npm install -g @mattskilly/idiom@0.19.0",
      outcome: "failed",
    },
  });
  expect(result.kind === "failed" && result.message).toBe(
    "Idiom CLI update failed: npm install -g @mattskilly/idiom@0.19.0 exited 1: npm error code EACCES. Your installed Idiom 0.18.0 was left as it was and no skills were changed.",
  );
  expect(deps.run).toHaveBeenCalledOnce();
  expect(deps.handoff).not.toHaveBeenCalled();
});

test("a package manager that cannot start or throws is a failure", async () => {
  for (const run of [
    vi.fn(async () => ({ exitCode: null, stdout: "", stderr: "" })),
    vi.fn(async () => {
      throw new Error("spawn npm ENOENT");
    }),
  ]) {
    const deps = await setup({ run });
    const result = await selfUpdate(options(), deps);
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.message).toContain(
      "npm install -g @mattskilly/idiom@0.19.0 exited without starting",
    );
    expect(deps.handoff).not.toHaveBeenCalled();
  }
});

test("a replaced CLI reporting the wrong version stops before the handoff", async () => {
  const deps = await setup({ run: runner("0.18.0") });
  const result = await selfUpdate(options(), deps);
  expect(result.kind).toBe("failed");
  expect(result.kind === "failed" && result.message).toBe(
    "npm install -g @mattskilly/idiom@0.19.0 finished, but the installed idiom reports 0.18.0, expected 0.19.0. No skills were changed. To return to your previous version: npm install -g @mattskilly/idiom@0.18.0",
  );
  expect(deps.handoff).not.toHaveBeenCalled();
});

test("a replaced CLI that cannot report a version is a mismatch", async () => {
  const deps = await setup({
    packageRoot: await bunGlobal(),
    run: vi.fn(async (argv: string[]) =>
      argv.includes("--version")
        ? { exitCode: 1, stdout: "", stderr: "Cannot find module" }
        : ok(),
    ),
  });
  const result = await selfUpdate(options(), deps);
  expect(result.kind === "failed" && result.message).toContain(
    "reports no version, expected 0.19.0. No skills were changed. To return to your previous version: bun add -g @mattskilly/idiom@0.18.0",
  );
  expect(deps.handoff).not.toHaveBeenCalled();
});

test("a handoff that cannot start is a failure", async () => {
  const deps = await setup({ handoff: vi.fn(async () => null) });
  const result = await selfUpdate(options(), deps);
  expect(result).toMatchObject({
    kind: "failed",
    cli: { outcome: "failed" },
    message:
      "Updated the Idiom CLI to 0.19.0 but could not start it to merge skills. Run idiom upgrade again.",
  });
});

test("npx, bunx and plugin installs name their command and never install", async () => {
  const bunx = await packageAt(
    ".bun",
    "install",
    "cache",
    "@mattskilly",
    "idiom@0.18.0@@@1",
  );
  const cases = [
    [await npxInstall("^0.18.0"), {}, "npx"],
    [bunx, {}, "bunx"],
    [
      await npxInstall(RELEASE),
      { CLAUDE_PLUGIN_ROOT: "/plugins/idiom" },
      "claude-plugin",
    ],
  ] as const;
  for (const [packageRoot, env, kind] of cases) {
    const deps = await setup({ packageRoot, env });
    const command = updateCommand(kind, "0.19.0");
    await expect(selfUpdate(options(), deps)).resolves.toEqual({
      kind: "continue",
      cli: { from: "0.18.0", to: "0.19.0", command, outcome: "manual" },
      lines: [
        `Idiom 0.19.0 is available (you have 0.18.0). This install is updated outside idiom upgrade: ${command}. Merging skills with the installed 0.18.0.`,
      ],
    });
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.handoff).not.toHaveBeenCalled();
  }
});

test("source checkouts and unidentified installs never reach the network", async () => {
  const source = await temporary();
  await mkdir(join(source, "src"));
  await writeFile(join(source, "src", "cli.ts"), "");
  const cases = [
    [
      source,
      "git pull && bun install --frozen-lockfile && bun run build",
      "source checkout",
    ],
    [
      await temporary(),
      "npm install --save-dev --save-exact @mattskilly/idiom@latest",
      "could not tell how it was installed",
    ],
  ] as const;
  for (const [packageRoot, command, phrase] of cases) {
    const deps = await setup({ packageRoot });
    const result = await selfUpdate(options(), deps);
    expect(result).toMatchObject({
      kind: "continue",
      cli: { from: "0.18.0", to: null, command, outcome: "manual" },
    });
    expect(result.kind === "continue" && result.lines.join("")).toContain(
      phrase,
    );
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.handoff).not.toHaveBeenCalled();
  }
});

test("--no-self-update skips the CLI step silently", async () => {
  const deps = await setup();
  await expect(
    selfUpdate(options({ selfUpdate: false }), deps),
  ).resolves.toEqual({
    kind: "continue",
    cli: { from: "0.18.0", to: null, command: null, outcome: "skipped" },
    lines: [],
  });
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.run).not.toHaveBeenCalled();
});

test("--dry-run reports the install it would run and changes nothing", async () => {
  const deps = await setup({ packageRoot: await bunGlobal() });
  await expect(selfUpdate(options({ dryRun: true }), deps)).resolves.toEqual({
    kind: "continue",
    cli: {
      from: "0.18.0",
      to: "0.19.0",
      command: "bun add -g @mattskilly/idiom@0.19.0",
      outcome: "would-update",
    },
    lines: [
      "Would update the Idiom CLI 0.18.0 → 0.19.0 with: bun add -g @mattskilly/idiom@0.19.0, then merge 0.19.0's skills. The skill report below uses the installed 0.18.0 templates.",
    ],
  });
  expect(deps.run).not.toHaveBeenCalled();
  expect(deps.handoff).not.toHaveBeenCalled();
});

test("offline, a timeout or a current release merges skills with one line", async () => {
  const rejected = await setup({
    fetch: vi.fn(async () => {
      throw new Error("offline");
    }) as never,
  });
  const unchecked = {
    kind: "continue",
    cli: { from: "0.18.0", to: null, command: null, outcome: "unchecked" },
    lines: [
      "Could not check for a newer Idiom CLI (offline or the registry did not answer); merging skills with the installed 0.18.0.",
    ],
  };
  await expect(selfUpdate(options(), rejected)).resolves.toEqual(unchecked);

  const callbacks: Array<() => void> = [];
  const setTimer: UpdateTimer = (callback) => {
    callbacks.push(callback);
    return () => {};
  };
  const hanging = await setup({
    setTimer,
    fetch: vi.fn(() => new Promise<Response>(() => {})) as never,
  });
  const pending = selfUpdate(options(), hanging);
  await vi.waitFor(() => expect(callbacks).toHaveLength(1));
  for (const callback of callbacks) callback();
  await expect(pending).resolves.toEqual(unchecked);

  const current = await setup({ fetch: registry("0.18.0") });
  await expect(selfUpdate(options(), current)).resolves.toEqual({
    kind: "continue",
    cli: { from: "0.18.0", to: "0.18.0", command: null, outcome: "current" },
    lines: ["Idiom CLI 0.18.0 is the latest release."],
  });
  for (const deps of [rejected, hanging, current])
    expect(deps.run).not.toHaveBeenCalled();
});

test("the registry read waits the upgrade deadline, not the notice's", async () => {
  const setTimer = vi.fn<UpdateTimer>(() => () => {});
  await selfUpdate(options(), await setup({ setTimer }));
  expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 10_000);
});

test("an update-check off switch makes no request", async () => {
  for (const env of [{ IDIOM_NO_UPDATE_CHECK: "1" }, { CI: "true" }]) {
    const deps = await setup({ env });
    const result = await selfUpdate(options(), deps);
    expect(result).toMatchObject({
      kind: "continue",
      cli: { outcome: "disabled", to: null, command: null },
    });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  }
});
