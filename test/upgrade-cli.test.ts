import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { renderUpgrade, upgradeCommand } from "../src/commands/upgrade.js";
import type { SelfUpdateDependencies } from "../src/update/self-update.js";
import {
  distribution,
  put,
  read,
  runUpgrade,
  skill,
  temporary,
  tree,
} from "./skill-support.js";

test("help exposes upgrade and all three flags", async () => {
  const stdout = vi.fn();
  expect(await run(["node", "idiom", "--help"], { stdout })).toBe(0);
  expect(stdout.mock.calls.flat().join("")).toContain("upgrade");
  stdout.mockClear();
  expect(await run(["node", "idiom", "upgrade", "--help"], { stdout })).toBe(0);
  const help = stdout.mock.calls.flat().join("");
  for (const option of ["--no-agent", "--dry-run", "--json"])
    expect(help).toContain(option);
});
test("JSON report is complete before exit 1 and no-agent never creates a model", async () => {
  const root = await temporary();
  await runUpgrade(root);
  await put(root, ".agents/skills/idiom/init.md", "local");
  const createResolver = vi.fn();
  const stdout = vi.fn();
  const stderr = vi.fn();
  expect(
    await run(
      ["node", "idiom", "--project", root, "upgrade", "--json", "--no-agent"],
      {
        stdout,
        stderr,
        upgrade: {
          distribution: distribution("2.0.0", {
            "SKILL.md": skill(),
            "init.md": "upstream",
          }),
          history: { schema: 1, releases: [] },
          createResolver,
        },
      },
    ),
  ).toBe(1);
  expect(stdout).toHaveBeenCalledOnce();
  const report = JSON.parse(stdout.mock.calls[0]?.[0] as string);
  expect(report.installedVersion).toBe("2.0.0");
  expect(report.previous).toEqual({ kind: "known", version: "1.0.0" });
  expect(report.files[1]).toMatchObject({
    action: "conflicted",
    needsResolution: true,
    pristinePath: ".agents/skills/.idiom-pristine/idiom/init.md",
    incomingPath: "/installed/templates/idiom/init.md",
  });
  expect(report.files[1].conflictText).toContain(">>>>>>> incoming 2.0.0");
  expect(report.skills).toMatchObject([
    { name: "idiom", outcome: "conflicted" },
  ]);
  expect(report.skills[0].files).toHaveLength(2);
  expect(stderr).not.toHaveBeenCalled();
  expect(createResolver).not.toHaveBeenCalled();
});
test("text output previews a conflict, labelled as not written to disk", async () => {
  const root = await temporary();
  await runUpgrade(root);
  await put(root, ".agents/skills/idiom/init.md", "local\n");
  const stdout = vi.fn();
  expect(
    await run(["node", "idiom", "--project", root, "upgrade", "--no-agent"], {
      stdout,
      upgrade: {
        distribution: distribution("2.0.0", {
          "SKILL.md": skill(),
          "init.md": "upstream\n",
        }),
        history: { schema: 1, releases: [] },
      },
    }),
  ).toBe(1);
  const text = stdout.mock.calls.flat().join("");
  expect(text).toContain("idiom: conflicted (1 file)\n  current:");
  expect(text).toContain(
    "    conflict (not written to disk; the live file is unchanged):\n      <<<<<<< local .agents/skills/idiom/init.md\n      local\n",
  );
  expect(text).toContain("      >>>>>>> incoming 2.0.0");
  expect(await read(root, ".agents/skills/idiom/init.md")).toBe("local\n");
});
test("the conflict preview stops at 80 lines and points to the three paths", async () => {
  const root = await temporary();
  const report = await runUpgrade(root, distribution("1.0.0"), {
    dryRun: true,
  });
  const target = report.skills[0]?.files[1];
  if (!target) throw new Error("missing file");
  target.action = "conflicted";
  target.incomingPath = "/installed/templates/idiom/init.md";
  target.conflictText = `${Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n")}\n`;
  const lines = renderUpgrade(report).split("\n");
  const start = lines.indexOf(
    "    conflict (not written to disk; the live file is unchanged):",
  );
  expect(lines.slice(start + 1, start + 81)).toEqual(
    Array.from({ length: 80 }, (_, index) => `      line ${index}`),
  );
  expect(lines[start + 81]).toBe(
    "      … 20 more lines not shown; compare .agents/skills/idiom/init.md, .agents/skills/.idiom-pristine/idiom/init.md and /installed/templates/idiom/init.md",
  );
});
test("dry-run resolves initialized ancestors and leaves a complete project tree untouched", async () => {
  const root = await temporary();
  await initProject({ project: root, yes: true });
  await mkdir(join(root, "nested/deep"), { recursive: true });
  const before = await tree(root);
  const createResolver = vi.fn();
  const stdout = vi.fn();
  expect(
    await run(["node", "idiom", "upgrade", "--dry-run", "--json"], {
      cwd: join(root, "nested/deep"),
      stdout,
      upgrade: { createResolver },
    }),
  ).toBe(0);
  expect(JSON.parse(stdout.mock.calls[0]?.[0] as string)).toMatchObject({
    projectDirectory: root,
    dryRun: true,
  });
  expect(await tree(root)).toEqual(before);
  expect(createResolver).not.toHaveBeenCalled();
});
test("explicit relative project wins and uninitialized fallback works without configuration", async () => {
  const root = await temporary();
  const nested = join(root, "project");
  await mkdir(nested);
  const report = await upgradeCommand(
    { project: "project", cwd: root, agent: false },
    {
      distribution: distribution("1.0.0"),
      history: { schema: 1, releases: [] },
    },
  );
  expect(report.projectDirectory).toBe(nested);
  expect(report.files.every((file) => file.action === "installed")).toBe(true);
  expect(renderUpgrade(report)).toContain("unknown → 1.0.0");
  expect(renderUpgrade(report).split("\n").slice(1, 4)).toEqual([
    "idiom: installed (2 files)",
    "  installed: .agents/skills/idiom/SKILL.md",
    "  installed: .agents/skills/idiom/init.md",
  ]);
  const stdout = vi.fn();
  expect(
    await run(["node", "idiom", "upgrade", "--no-agent"], {
      cwd: nested,
      stdout,
    }),
  ).toBe(0);
  expect(await read(nested, ".agents/skills/idiom/SKILL.md")).toContain(
    "name: idiom",
  );
});

async function installAt(...segments: string[]): Promise<string> {
  const root = join(await temporary(), ...segments);
  await mkdir(root, { recursive: true });
  return root;
}

function selfUpdateSeams(
  packageRoot: string,
  overrides: Partial<SelfUpdateDependencies> = {},
) {
  return {
    env: {},
    now: () => 1_000_000_000,
    packageRoot,
    currentVersion: "0.18.0",
    fetch: vi.fn(
      async () =>
        new Response(JSON.stringify({ version: "0.19.0" }), { status: 200 }),
    ),
    setTimer: () => () => {},
    run: vi.fn(async (argv: string[]) => ({
      exitCode: 0,
      stdout: argv.includes("--version") ? "0.19.0 (abc1234)\n" : "",
      stderr: "",
    })),
    handoff: vi.fn(async () => 0 as number | null),
    execPath: "/usr/local/bin/node",
    ...overrides,
  } satisfies SelfUpdateDependencies;
}

const skillsOnly = () => ({
  distribution: distribution("2.0.0"),
  history: { schema: 1 as const, releases: [] },
});

test("help lists --no-self-update", async () => {
  const stdout = vi.fn();
  expect(await run(["node", "idiom", "upgrade", "--help"], { stdout })).toBe(0);
  expect(stdout.mock.calls.flat().join("")).toContain("--no-self-update");
});

test("--json reports the CLI step next to the skill merge", async () => {
  const root = await temporary();
  const npx = await installAt(
    "_npx",
    "0a1b2c",
    "node_modules",
    "@mattskilly",
    "idiom",
  );
  await writeFile(
    join(npx, "..", "..", "..", "package.json"),
    JSON.stringify({ dependencies: { "@mattskilly/idiom": "^0.18.0" } }),
  );
  for (const [flags, cli] of [
    [
      [],
      {
        from: "0.18.0",
        to: "0.19.0",
        command: "npx -y @mattskilly/idiom@latest upgrade",
        outcome: "manual",
      },
    ],
    [
      ["--no-self-update"],
      { from: "0.18.0", to: null, command: null, outcome: "skipped" },
    ],
  ] as const) {
    const stdout = vi.fn();
    const seams = selfUpdateSeams(npx, {
      cacheDirectory: join(root, "cache"),
    });
    expect(
      await run(
        [
          "node",
          "idiom",
          "--project",
          root,
          "upgrade",
          "--json",
          "--no-agent",
          ...flags,
        ],
        { stdout, selfUpdate: seams, upgrade: skillsOnly() },
      ),
    ).toBe(0);
    expect(stdout).toHaveBeenCalledOnce();
    const report = JSON.parse(stdout.mock.calls[0]?.[0] as string);
    expect(report.cli).toEqual(cli);
    expect(report.installedVersion).toBe("2.0.0");
    expect(report.files.length).toBeGreaterThan(0);
    expect(seams.run).not.toHaveBeenCalled();
  }
});

test("a failed CLI update exits non-zero before any skill change", async () => {
  const root = await temporary();
  await initProject({ project: root, yes: true });
  const before = await tree(root);
  const npm = await installAt("lib", "node_modules", "@mattskilly", "idiom");
  for (const json of [false, true]) {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const createResolver = vi.fn();
    const seams = selfUpdateSeams(npm, {
      cacheDirectory: join(await temporary(), "cache"),
      run: vi.fn(async () => ({
        exitCode: 243,
        stdout: "",
        stderr: "npm error code EACCES",
      })),
    });
    const code = await run(
      [
        "node",
        "idiom",
        "--project",
        root,
        "upgrade",
        ...(json ? ["--json"] : []),
      ],
      {
        stdout,
        stderr,
        selfUpdate: seams,
        upgrade: { ...skillsOnly(), createResolver },
      },
    );
    expect(code).not.toBe(0);
    expect(stderr.mock.calls.flat().join("")).toContain(
      "npm install -g @mattskilly/idiom@0.19.0 exited 243: npm error code EACCES",
    );
    if (json) {
      expect(stdout).toHaveBeenCalledOnce();
      expect(JSON.parse(stdout.mock.calls[0]?.[0] as string).cli).toMatchObject(
        {
          command: "npm install -g @mattskilly/idiom@0.19.0",
          outcome: "failed",
        },
      );
    } else expect(stdout).not.toHaveBeenCalled();
    expect(seams.handoff).not.toHaveBeenCalled();
    expect(createResolver).not.toHaveBeenCalled();
    expect(await tree(root)).toEqual(before);
  }
});

test("a successful update hands off and passes the child's exit code through", async () => {
  const root = await temporary();
  await initProject({ project: root, yes: true });
  const before = await tree(root);
  const npm = await installAt("lib", "node_modules", "@mattskilly", "idiom");
  const stdout = vi.fn();
  const handoff = vi.fn(async (_argv: string[]) => 3);
  const seams = selfUpdateSeams(npm, {
    cacheDirectory: join(await temporary(), "cache"),
    handoff,
  });
  expect(
    await run(["node", "idiom", "--project", root, "upgrade", "--json"], {
      stdout,
      selfUpdate: seams,
      upgrade: skillsOnly(),
    }),
  ).toBe(3);
  // With --json the child's document is the only stdout.
  expect(stdout).not.toHaveBeenCalled();
  expect(handoff.mock.calls[0]?.[0].slice(2)).toEqual([
    "--project",
    root,
    "upgrade",
    "--json",
  ]);
  expect(await tree(root)).toEqual(before);
});

test("the handed-off child merges skills and reports the update", async () => {
  const root = await temporary();
  const npm = await installAt("lib", "node_modules", "@mattskilly", "idiom");
  const stdout = vi.fn();
  const seams = selfUpdateSeams(npm, {
    currentVersion: "0.19.0",
    env: {
      IDIOM_SELF_UPDATE_HANDOFF: "1",
      IDIOM_SELF_UPDATE_FROM: "0.18.0",
      IDIOM_SELF_UPDATE_COMMAND: "npm install -g @mattskilly/idiom@0.19.0",
    },
  });
  expect(
    await run(
      ["node", "idiom", "--project", root, "upgrade", "--json", "--no-agent"],
      {
        stdout,
        selfUpdate: seams,
        upgrade: skillsOnly(),
      },
    ),
  ).toBe(0);
  const report = JSON.parse(stdout.mock.calls[0]?.[0] as string);
  expect(report.cli).toEqual({
    from: "0.18.0",
    to: "0.19.0",
    command: "npm install -g @mattskilly/idiom@0.19.0",
    outcome: "updated",
  });
  expect(
    report.files.every(
      (file: { action: string }) => file.action === "installed",
    ),
  ).toBe(true);
  expect(seams.fetch).not.toHaveBeenCalled();
  expect(seams.handoff).not.toHaveBeenCalled();
});

test.each(["json", "dry-run", "decline", "accept"])(
  "real upgrade CLI %s handles gate previews without implicit consent",
  async (mode) => {
    const root = await temporary();
    await initProject({ project: root, yes: true });
    const original = "[verify]\nsteps=[]\n";
    await put(root, "autobuild.toml", original);
    const before = await tree(root);
    let stdout = "";
    const confirm = vi.fn(
      async (
        _request: import("../src/confirmation.js").InitConfirmationRequest,
      ) => mode === "accept",
    );
    expect(
      await run(
        [
          "node",
          "idiom",
          "upgrade",
          "--project",
          root,
          "--no-self-update",
          "--no-agent",
          ...(mode === "json" ? ["--json"] : []),
          ...(mode === "dry-run" ? ["--dry-run"] : []),
        ],
        {
          stdout: (value) => {
            stdout += value;
          },
          stderr: () => {},
          confirm,
        },
      ),
    ).toBe(0);
    if (mode === "accept") {
      expect(await read(root, "autobuild.toml")).toContain("--deferred warn");
      expect(stdout).toContain("+++ b/autobuild.toml");
      confirm.mockClear();
      await run(
        [
          "node",
          "idiom",
          "upgrade",
          "--project",
          root,
          "--no-self-update",
          "--no-agent",
        ],
        { stdout: () => {}, stderr: () => {}, confirm },
      );
      expect(
        confirm.mock.calls.some(
          ([request]) => request?.kind === "offer-autobuild-wiring",
        ),
      ).toBe(false);
    } else {
      expect(await tree(root)).toEqual(before);
      if (mode === "json")
        expect(JSON.parse(stdout).autobuild).toMatchObject({
          kind: "available-noninteractive",
          diff: expect.stringContaining("idiom-check"),
        });
      if (mode === "json" || mode === "dry-run")
        expect(confirm).not.toHaveBeenCalled();
    }
    // The agent gate recipe needs the shared verifier skill; only consent installs it.
    const skill = (await tree(root))[".agents/skills/idiom-verify/SKILL.md"];
    if (mode === "accept") expect(skill).toContain("name: idiom-verify");
    else expect(skill).toBeUndefined();
  },
);
