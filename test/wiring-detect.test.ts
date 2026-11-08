import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AUTOBUILD_SKILLS } from "../src/wiring/autobuild-skills.js";
import {
  detectWiring,
  executableOnPath,
  SIGNAL_PATHS,
  wiringFacts,
} from "../src/wiring/detect.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function temporary(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-wiring-detect-")),
  );
  directories.push(directory);
  return directory;
}
const noGit = async () => {
  throw new Error("not a git repository");
};
const isolated = { git: noGit, environment: { PATH: "" } };

test("no signals: nothing detected, agents absent, branch unknown", async () => {
  const root = await temporary();
  const detection = await detectWiring(root, isolated);
  for (const path of SIGNAL_PATHS)
    expect(detection.signals[path]?.detected).toBe(false);
  expect(detection.agents).toEqual({ claude: false, codex: false });
  expect(detection.defaultBranch).toBeUndefined();
  expect(detection.branchReason).toContain("No local remote default-branch");
  expect(detection.setup).toBeUndefined();
  expect(detection.setupReason).toContain("Cannot determine dependency setup");
  expect(wiringFacts(detection).found).toEqual([]);
});

test("every requested signal is detected alone and together", async () => {
  const signals: Array<[string, (root: string) => Promise<void>]> = [
    ["autobuild.toml", (r) => writeFile(join(r, "autobuild.toml"), "")],
    [
      ".github/workflows",
      async (r) => {
        await mkdir(join(r, ".github/workflows"), { recursive: true });
      },
    ],
    [".husky", (r) => mkdir(join(r, ".husky"))],
    ["lefthook.yml", (r) => writeFile(join(r, "lefthook.yml"), "")],
    ["AGENTS.md", (r) => writeFile(join(r, "AGENTS.md"), "")],
    ["CLAUDE.md", (r) => writeFile(join(r, "CLAUDE.md"), "")],
    [".cursor", (r) => mkdir(join(r, ".cursor"))],
  ];
  const all = await temporary();
  for (const [path, make] of signals) {
    const alone = await temporary();
    await make(alone);
    const detection = await detectWiring(alone, isolated);
    expect(wiringFacts(detection).found).toEqual([path]);
    await make(all);
  }
  const together = wiringFacts(await detectWiring(all, isolated)).found;
  expect(together.sort()).toEqual(signals.map(([path]) => path).sort());
});

test("unsafe path types are detected as protected, not absent", async () => {
  const root = await temporary();
  const outside = await temporary();
  await writeFile(join(outside, "AGENTS.md"), "foreign");
  await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
  await symlink(outside, join(root, ".github"));
  const detection = await detectWiring(root, isolated);
  expect(detection.signals["AGENTS.md"]?.detected).toBe(true);
  expect(detection.signals[".github/workflows"]?.detected).toBe(true);
  expect(wiringFacts(detection).found).toEqual([
    ".github/workflows (protected)",
    "AGENTS.md (protected)",
    ".github/workflows/idiom.yml (protected)",
  ]);
});

test("PATH lookup never runs the executable and honors platform rules", async () => {
  const seen: string[] = [];
  const executable = async (path: string) => {
    seen.push(path);
    return path === "/opt/bin/claude";
  };
  expect(
    await executableOnPath("claude", {
      environment: { PATH: "/usr/bin::/opt/bin" },
      platform: "linux",
      executable,
    }),
  ).toBe(true);
  expect(seen).toEqual(["/usr/bin/claude", "/opt/bin/claude"]);
  const windows: string[] = [];
  expect(
    await executableOnPath("codex", {
      environment: { Path: "C:\\tools;D:\\bin", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      executable: async (path) => {
        windows.push(path);
        return path === "D:\\bin\\codex.CMD";
      },
    }),
  ).toBe(true);
  expect(windows).toEqual([
    "C:\\tools\\codex.EXE",
    "C:\\tools\\codex.CMD",
    "D:\\bin\\codex.EXE",
    "D:\\bin\\codex.CMD",
  ]);
  const root = await temporary();
  const detection = await detectWiring(root, {
    git: noGit,
    environment: { PATH: "/opt/bin" },
    platform: "linux",
    executable,
  });
  expect(detection.agents).toEqual({ claude: true, codex: false });
});

test("the default branch comes only from a local remote HEAD", async () => {
  const root = await temporary();
  const calls: string[][] = [];
  const detection = await detectWiring(root, {
    environment: { PATH: "" },
    git: async (_root, args) => {
      calls.push(args);
      if (args[0] === "for-each-ref")
        return "refs/remotes/upstream/HEAD\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/feature\n";
      return args[2] === "refs/remotes/origin/HEAD"
        ? "refs/remotes/origin/trunk\n"
        : "refs/remotes/upstream/main\n";
    },
  });
  expect(detection.defaultBranch).toBe("trunk");
  expect(detection.branchReason).toContain("refs/remotes/origin/HEAD");
  // Read-only queries only: no fetch, no current-branch guess.
  expect(calls.map((args) => args[0])).toEqual([
    "for-each-ref",
    "symbolic-ref",
  ]);
});

test("dependency setup follows lockfiles and packageManager", async () => {
  const cases: Array<[Record<string, string>, string, string?]> = [
    [{ "package.json": "{}", "bun.lock": "" }, "bun install --frozen-lockfile"],
    [
      {
        "package.json": '{"packageManager":"pnpm@9.1.0"}',
        "pnpm-lock.yaml": "",
      },
      "pnpm install --frozen-lockfile",
      "9.1.0",
    ],
    [
      { "package.json": '{"packageManager":"yarn@4.2.1"}', "yarn.lock": "" },
      "yarn install --immutable",
      "4.2.1",
    ],
    [
      { "package.json": "{}", "yarn.lock": "" },
      "yarn install --frozen-lockfile",
    ],
    [{ "package.json": "{}", "package-lock.json": "{}" }, "npm ci"],
    [{ "package.json": "{}" }, "npm install"],
  ];
  for (const [files, command, version] of cases) {
    const root = await temporary();
    for (const [name, content] of Object.entries(files))
      await writeFile(join(root, name), content);
    const { setup } = await detectWiring(root, isolated);
    expect(setup?.command).toBe(command);
    expect(setup?.version).toBe(version);
  }
  const unsupported = await temporary();
  await writeFile(
    join(unsupported, "package.json"),
    '{"packageManager":"deno@2.0.0"}',
  );
  const detection = await detectWiring(unsupported, isolated);
  expect(detection.setup).toBeUndefined();
  expect(detection.setupReason).toContain("unsupported packageManager");
});

test("canonical phase skills are detected independently of config and missing roles", async () => {
  const root = await temporary();
  for (const target of AUTOBUILD_SKILLS) {
    await mkdir(join(root, target.path, ".."), { recursive: true });
    await writeFile(
      join(root, target.path),
      `---\nname: ${target.identity}\n---\nBody\n`,
    );
    const detection = await detectWiring(root, isolated);
    expect(detection.signals[target.path]?.entry?.kind).toBe("file");
    expect(detection.signals["autobuild.toml"]?.detected).toBe(false);
  }
  expect(wiringFacts(await detectWiring(root, isolated)).found).toEqual(
    AUTOBUILD_SKILLS.map((target) => target.path),
  );
});
