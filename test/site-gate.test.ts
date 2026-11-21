import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
// @ts-expect-error The site gate is a dependency-free Node module.
import { runSiteAdvance, runSiteGate } from "../scripts/site-gate.mjs";

const cli = "/x/dist/cli.js";

async function trackedProject() {
  const root = await mkdtemp(join(tmpdir(), "site-gate-dirty-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "--quiet"]);
  await mkdir(join(root, ".idiom"));
  const decisions = join(root, ".idiom/decisions.jsonl");
  const registry = join(root, ".idiom/finding-names.json");
  const original = '{"reason":"committed decision"}\n';
  await writeFile(decisions, original);
  await writeFile(registry, "{}\n");
  git(["add", ".idiom"]);
  git([
    "-c",
    "user.name=Site gate test",
    "-c",
    "user.email=site-gate@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Initial registry and decisions",
  ]);
  return { root, git, decisions, registry, original };
}

function harness(statuses: number[], restoreStatus = 0) {
  const cleanup = vi.fn(async () => {});
  const calls: { command: string; args: string[] }[] = [];
  const lines: string[] = [];
  const queue = [...statuses];
  const run = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "git")
      return { status: args[0] === "checkout" ? restoreStatus : 0 };
    return { status: queue.shift() ?? 0 };
  });
  return {
    cleanup,
    calls,
    lines,
    gateCalls: () => calls.filter((call) => call.command !== "git"),
    restoreCalls: () => calls.filter((call) => call.args[0] === "checkout"),
    options: {
      build: async () => ({ cli, cleanup }),
      run,
      log: (line: string) => lines.push(line),
    },
  };
}

describe("site gate", () => {
  test.each([
    [[0], 0, 1],
    [[1], 1, 1],
    [[2], 2, 1],
    [[3, 0], 0, 2],
    [[3, 1], 1, 2],
    [[3, 2], 2, 2],
  ])(
    "statuses %j end in %i after %i gate runs",
    async (statuses, final, runs) => {
      const gate = harness(statuses);
      expect(await runSiteGate(gate.options)).toBe(final);
      expect(gate.gateCalls()).toHaveLength(runs);
      expect(gate.cleanup).toHaveBeenCalledOnce();
      expect(gate.restoreCalls()).toEqual([
        {
          command: "git",
          args: ["checkout", "--", ".idiom/finding-names.json"],
        },
      ]);
    },
  );

  test("runs the shipped recipe with this checkout's CLI", async () => {
    const gate = harness([0]);
    await runSiteGate(gate.options);
    expect(gate.gateCalls()[0]).toEqual({
      command: process.execPath,
      args: [cli, "check", "--gate", "--fail-on", "major"],
    });
  });

  test("passes with a warning when the retry defers too", async () => {
    const gate = harness([3, 3]);
    expect(await runSiteGate(gate.options)).toBe(0);
    expect(gate.gateCalls()).toHaveLength(2);
    expect(gate.lines.join("\n")).toMatch(/retrying once/);
    expect(gate.lines.join("\n")).toMatch(
      /^warning: idiom-check deferred twice/m,
    );
  });

  test("a CLI build failure is a setup failure with no gate run", async () => {
    const gate = harness([0]);
    const status = await runSiteGate({
      ...gate.options,
      build: async () => {
        throw new Error("tsup failed");
      },
    });
    expect(status).toBe(2);
    expect(gate.gateCalls()).toEqual([]);
    expect(gate.restoreCalls()).toEqual([]);
    expect(gate.lines.join("\n")).toMatch(/could not build the CLI/);
  });

  test("a failed restore turns a pass into a failure", async () => {
    const gate = harness([0], 1);
    expect(await runSiteGate(gate.options)).toBe(1);
    expect(gate.lines.join("\n")).toMatch(/could not restore/);
  });

  test("a failed restore keeps a failing status as it is", async () => {
    const gate = harness([1], 1);
    expect(await runSiteGate(gate.options)).toBe(1);
  });

  test("a failed preflight Git command refuses before building or restoring", async () => {
    const gate = harness([0]);
    const build = vi.fn(gate.options.build);
    expect(
      await runSiteGate({
        ...gate.options,
        build,
        run: async () => ({ status: 128 }),
      }),
    ).toBe(2);
    expect(build).not.toHaveBeenCalled();
    expect(gate.lines.join("\n")).toMatch(/could not check/);
    expect(gate.cleanup).not.toHaveBeenCalled();
  });

  test.each(["unstaged", "staged", "index differs but worktree matches HEAD"])(
    "preserves pre-existing %s decisions and refuses before building",
    async (state) => {
      const { root, git, decisions, original } = await trackedProject();
      try {
        const edited = '{"reason":"new decision must survive"}\n';
        await writeFile(decisions, edited);
        if (state !== "unstaged") git(["add", ".idiom/decisions.jsonl"]);
        if (state === "index differs but worktree matches HEAD")
          await writeFile(decisions, original);
        const before = await readFile(decisions, "utf8");
        const indexBefore = git(["show", ":.idiom/decisions.jsonl"]);
        const statusBefore = git(["status", "--porcelain"]);
        const build = vi.fn();
        const log = vi.fn();
        const run = vi.fn(async (command: string, args: string[]) => ({
          status: spawnSync(command, args, { cwd: root }).status,
        }));

        expect(await runSiteGate({ build, run, log })).toBe(2);
        expect(build).not.toHaveBeenCalled();
        expect(run.mock.calls.every(([command]) => command === "git")).toBe(
          true,
        );
        expect(run.mock.calls.some(([, args]) => args[0] === "checkout")).toBe(
          false,
        );
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("commit or stash"),
        );
        expect(await readFile(decisions, "utf8")).toBe(before);
        expect(git(["show", ":.idiom/decisions.jsonl"])).toBe(indexBefore);
        expect(git(["status", "--porcelain"])).toBe(statusBefore);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("a clean run restores its registry without reverting other edits made during the run", async () => {
    const { root, git, decisions, registry } = await trackedProject();
    const gate = harness([0]);
    try {
      const edited = '{"reason":"decision recorded while the gate runs"}\n';
      const run = async (command: string, args: string[]) => {
        if (command === process.execPath) {
          await writeFile(registry, '{"newFinding":"finding-1"}\n');
          await writeFile(decisions, edited);
          return { status: 0 };
        }
        return { status: spawnSync(command, args, { cwd: root }).status };
      };
      expect(await runSiteGate({ ...gate.options, run })).toBe(0);
      expect(gate.cleanup).toHaveBeenCalledOnce();
      expect(await readFile(registry, "utf8")).toBe("{}\n");
      expect(await readFile(decisions, "utf8")).toBe(edited);
      expect(git(["diff", "--name-only"])).toBe(".idiom/decisions.jsonl\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("idiom-advance", () => {
  const advance = (statuses: number[], build?: () => Promise<unknown>) => {
    const h = harness(statuses);
    return {
      ...h,
      result: runSiteAdvance({
        ...h.options,
        ...(build === undefined ? {} : { build }),
      }),
    };
  };

  test("advances the main tip, then this build's head, with this checkout's CLI", async () => {
    const h = advance([0, 0]);
    expect(await h.result).toBe(0);
    expect(h.gateCalls()).toEqual([
      {
        command: process.execPath,
        args: [cli, "baseline", "advance", "--fetch"],
      },
      {
        command: process.execPath,
        args: [cli, "baseline", "advance", "--target", "HEAD"],
      },
    ]);
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  test("still advances the head when the main tip fails, and reports the first failure", async () => {
    const h = advance([1, 2]);
    expect(await h.result).toBe(1);
    expect(h.gateCalls()).toHaveLength(2);
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  test("reports a head failure after a main-tip success", async () => {
    expect(await advance([0, 2]).result).toBe(2);
  });

  test("a CLI build failure runs nothing", async () => {
    const h = advance([], async () => {
      throw new Error("tsup exited with 1");
    });
    expect(await h.result).toBe(2);
    expect(h.gateCalls()).toEqual([]);
    expect(h.restoreCalls()).toEqual([]);
    expect(h.lines.join("\n")).toContain("could not build the CLI");
  });

  test("restores the finding-name registry once, after both advances", async () => {
    const h = advance([0, 0]);
    expect(await h.result).toBe(0);
    expect(h.restoreCalls()).toEqual([
      { command: "git", args: ["checkout", "--", ".idiom/finding-names.json"] },
    ]);
    expect(h.calls.at(-1)?.args[0]).toBe("checkout");
  });

  test("a failed restore fails an otherwise passing advance", async () => {
    const h = harness([0, 0], 1);
    expect(await runSiteAdvance(h.options)).toBe(1);
    expect(h.lines.join("\n")).toContain(
      "idiom-advance: could not restore tracked .idiom/finding-names.json",
    );
  });

  test("leaves the worktree clean after the CLI rewrites the registry", async () => {
    const { root, git, registry } = await trackedProject();
    const h = harness([0, 0]);
    try {
      const run = async (command: string, args: string[]) => {
        if (command === process.execPath) {
          await writeFile(registry, '{"newFinding":"finding-1"}\n');
          return { status: 0 };
        }
        return { status: spawnSync(command, args, { cwd: root }).status };
      };
      expect(await runSiteAdvance({ ...h.options, run })).toBe(0);
      expect(await readFile(registry, "utf8")).toBe("{}\n");
      expect(git(["status", "--porcelain"])).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses pre-existing tracked .idiom edits before building", async () => {
    const { root, git, decisions } = await trackedProject();
    try {
      const edited = '{"reason":"new decision must survive"}\n';
      await writeFile(decisions, edited);
      const build = vi.fn();
      const log = vi.fn();
      const run = vi.fn(async (command: string, args: string[]) => ({
        status: spawnSync(command, args, { cwd: root }).status,
      }));
      expect(await runSiteAdvance({ build, run, log })).toBe(2);
      expect(build).not.toHaveBeenCalled();
      expect(run.mock.calls.some(([, args]) => args[0] === "checkout")).toBe(
        false,
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("idiom-advance: commit or stash"),
      );
      expect(await readFile(decisions, "utf8")).toBe(edited);
      expect(git(["diff", "--name-only"])).toBe(".idiom/decisions.jsonl\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
