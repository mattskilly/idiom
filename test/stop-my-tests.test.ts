import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Dependency-free Node tooling is not compiled by TypeScript.
import * as cleanup from "../scripts/stop-my-tests.mjs";
import { fixtureSpawnSpec } from "./support/fixture-server.js";

const {
  isVitest,
  parseLsofCwd,
  parseProcesses,
  stopMyTests,
  systemDependencies,
} = cleanup;

type Identity = {
  pid: number;
  ppid: number;
  uid: number;
  state: string;
  start: string;
  command: string;
};
const record = (pid: number, patch: Partial<Identity> = {}): Identity => ({
  pid,
  ppid: 2,
  uid: 501,
  state: "S",
  start: "Fri Nov  6 12:00:00 2026",
  command: "node (vitest)",
  ...patch,
});
function harness(records: Identity[] = [record(10)]) {
  const signals: number[] = [];
  const messages: string[] = [];
  let time = 0;
  const dependencies = {
    pid: 100,
    uid: 501,
    platform: "darwin",
    root: vi.fn(async () => "/work/a"),
    prepare: vi.fn(async () => {}),
    snapshot: vi.fn(async () =>
      records.some((p) => p.pid === 100)
        ? records
        : [...records, record(100, { ppid: 1 })],
    ),
    inspect: vi.fn(async (pid: number) =>
      signals.includes(pid) ? undefined : records.find((p) => p.pid === pid),
    ),
    cwd: vi.fn(async (_pid: number): Promise<string | undefined> => "/work/a"),
    signal: vi.fn((pid: number) => {
      signals.push(pid);
    }),
    sleep: vi.fn(async (ms: number) => {
      time += ms;
    }),
    now: () => time,
    report: (message: string) => messages.push(message),
  };
  return { dependencies, signals, messages };
}

describe("Vitest identity and process inspection", () => {
  test.each([
    "node (vitest)",
    "node (vitest 12)",
    "node /work/node_modules/vitest/vitest.mjs run",
    "/usr/local/bin/node /work/node_modules/.bin/vitest",
    'node "/work with spaces/node_modules/vitest/vitest.mjs" run',
    "node node_modules/vitest/vitest.mjs",
    '"/a path/bin/node" node_modules/.bin/vitest',
  ])("recognizes %s", (command) => expect(isVitest(command)).toBe(true));
  test.each([
    "bun run test",
    "sh -c 'node (vitest)'",
    "grep vitest",
    "vim vitest.mjs",
    "node scripts/stop-my-tests.mjs",
    "node /work/vitest/app.mjs",
    "node app.js --name vitest",
    "node /work/node_modules/vitest/other.mjs",
    "node /work/node_modules/vitest/vitest.mjs.bak",
    "node (vitest foo)",
    "echo node /work/node_modules/.bin/vitest",
    "bun /work/node_modules/.bin/vitest",
    "node /work/fake-node_modules/.bin/vitest",
  ])("rejects %s", (command) => expect(isVitest(command)).toBe(false));
  test("parses fixed ps fields including space-padded dates", () => {
    expect(
      parseProcesses(
        " 10 501 2 S Fri Nov  6 12:00:00 2026 node (vitest)\ninvalid",
      ),
    ).toEqual([record(10)]);
    expect(
      parseProcesses("-10 501 2 S Fri Nov  6 12:00:00 2026 node (vitest)"),
    ).toEqual([]);
  });
  test("parses NUL lsof records without splitting cwd on whitespace", () => {
    expect(parseLsofCwd("p10\0\nn/work with spaces/a\nline\0\n", 10)).toBe(
      "/work with spaces/a\nline",
    );
    for (const output of [
      "p11\0n/work/a\0",
      "p10\0n/work/a\0n/work/b\0",
      "p10\0nrelative\0",
      "",
    ]) {
      expect(parseLsofCwd(output, 10)).toBeUndefined();
    }
  });
});

describe("cleanup ownership and signalling seam", () => {
  test("selects only same-user positive non-ancestor Vitest PIDs at the exact root", async () => {
    const h = harness([
      record(10),
      record(11),
      record(12),
      record(13),
      record(14),
      record(15),
      record(16, { uid: 999 }),
      record(17, { command: "node app.js --vitest" }),
      record(18, { state: "Z" }),
      record(0),
      record(1),
      record(-10),
      record(10.5),
      record(Number.NaN),
      record(100, { ppid: 99 }),
      record(99, { ppid: 98 }),
      record(98, { ppid: 1 }),
    ]);
    const cwds = new Map<number, string | undefined>([
      [10, "/work/a"],
      [11, "/work/b"],
      [12, "/work"],
      [13, "/work/a/child"],
      [14, "/work/ab"],
      [15, undefined],
    ]);
    h.dependencies.cwd.mockImplementation(async (pid) => cwds.get(pid));
    expect(await stopMyTests([], h.dependencies)).toBe(0);
    expect(h.signals).toEqual([10]);
    expect(h.dependencies.cwd.mock.calls.map(([pid]) => pid)).toEqual([
      10, 11, 12, 13, 14, 15, 10,
    ]);
    expect(h.messages).toContain("Stopped PID 10.");
  });
  test("dry run lists selected PIDs and never signals", async () => {
    const h = harness();
    expect(await stopMyTests(["--dry-run"], h.dependencies)).toBe(0);
    expect(h.signals).toEqual([]);
    expect(h.messages).toContain("Selected PID 10 (dry run).");
    expect(h.dependencies.inspect).not.toHaveBeenCalled();
  });
  test("no matches succeeds without cwd inspection", async () => {
    const h = harness([]);
    expect(await stopMyTests([], h.dependencies)).toBe(0);
    expect(h.dependencies.cwd).not.toHaveBeenCalled();
  });
  test("refuses an incomplete ancestor chain", async () => {
    const h = harness([record(10), record(100, { ppid: 99 })]);
    await expect(stopMyTests([], h.dependencies)).rejects.toThrow(
      "ancestor chain",
    );
    expect(h.signals).toEqual([]);
    expect(h.dependencies.cwd).not.toHaveBeenCalled();
  });
  test.each([
    undefined,
    record(10, { start: "new start" }),
    record(10, { uid: 999 }),
    record(10, { command: "node app.js" }),
    record(10, { state: "Z" }),
  ])("skips vanished or changed identity %j", async (current) => {
    const h = harness();
    h.dependencies.inspect.mockResolvedValue(current);
    expect(await stopMyTests([], h.dependencies)).toBe(0);
    expect(h.signals).toEqual([]);
  });
  test.each(["/work/b", undefined])(
    "skips changed/unreadable cwd %s",
    async (cwd) => {
      const h = harness();
      h.dependencies.cwd
        .mockResolvedValueOnce("/work/a")
        .mockResolvedValueOnce(cwd);
      expect(await stopMyTests([], h.dependencies)).toBe(0);
      expect(h.signals).toEqual([]);
    },
  );
  test.each(["root", "prepare", "snapshot", "cwd"] as const)(
    "refuses inspection failure at %s before signals",
    async (method) => {
      const h = harness([record(10), record(11)]);
      if (method === "cwd")
        h.dependencies.cwd
          .mockResolvedValueOnce("/work/a")
          .mockRejectedValueOnce(new Error("missing inspection tool"));
      else
        h.dependencies[method].mockRejectedValue(
          new Error("inspection unavailable"),
        );
      await expect(stopMyTests([], h.dependencies)).rejects.toThrow();
      expect(h.signals).toEqual([]);
    },
  );
  test.each(["EPERM", "ESRCH"])(
    "handles SIGTERM failure %s without widening cleanup",
    async (code) => {
      const h = harness();
      h.dependencies.signal.mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      expect(await stopMyTests([], h.dependencies)).toBe(
        code === "ESRCH" ? 0 : 1,
      );
      expect(h.dependencies.signal.mock.calls).toEqual([[10]]);
    },
  );
  test("reports a surviving process after a bounded wait; never escalates", async () => {
    const h = harness();
    h.dependencies.inspect.mockResolvedValue(record(10));
    expect(await stopMyTests([], h.dependencies)).toBe(1);
    expect(h.signals).toEqual([10]);
    expect(h.dependencies.now()).toBe(3_000);
    expect(h.messages.join("\n")).toContain("Surviving PID 10");
  });
  test.each([["/work/b"], ["--pid", "10"], ["--dry-run", "--dry-run"]])(
    "rejects arbitrary arguments %j",
    async (...args) => {
      const h = harness();
      expect(await stopMyTests(args, h.dependencies)).toBe(1);
      expect(h.dependencies.root).not.toHaveBeenCalled();
    },
  );
});

const execute = promisify(execFile);
const helper = resolve("scripts/stop-my-tests.mjs");

async function exited(child: ChildProcess, timeout = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((accept, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      accept();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("child did not exit"));
    }, timeout);
    child.once("exit", onExit);
  });
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "real temporary worktree cleanup",
  () => {
    test("dry run preserves all children; nested symlink invocation stops only A's Vitest", async () => {
      const root = await mkdtemp(join(tmpdir(), "stop my tests "));
      const children: ChildProcess[] = [];
      try {
        const a = join(root, "work A");
        const b = join(root, "work B");
        const git = (args: string[], cwd = root) =>
          execFileSync("git", args, { cwd, encoding: "utf8" });
        git(["init", "--quiet", a]);
        git(
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "fixture",
          ],
          a,
        );
        git(["worktree", "add", "--quiet", "--detach", b], a);
        const nested = join(a, "nested directory");
        await mkdir(nested);
        const link = join(root, "symlink A");
        await symlink(a, link);
        const fixture = join(root, "inert-child.cjs");
        await writeFile(
          fixture,
          `process.title = process.argv[2];
process.send('ready');
setInterval(() => {}, 1000);
`,
        );
        const start = async (cwd: string, title: string) => {
          const spec = fixtureSpawnSpec(fixture, { cwd, args: [title] });
          const child = spawn(spec.command, spec.args, {
            ...spec.options,
            stdio: ["pipe", "ignore", "pipe", "ipc"],
          });
          children.push(child);
          child.stderr?.resume();
          await new Promise<void>((accept, reject) => {
            const cleanup = () => {
              clearTimeout(timer);
              child.off("error", fail);
              child.off("exit", fail);
              child.off("message", ready);
            };
            const fail = () => {
              cleanup();
              reject(new Error("fixture failed before readiness"));
            };
            const ready = (message: unknown) => {
              if (message === "ready") {
                cleanup();
                accept();
              }
            };
            const timer = setTimeout(fail, 5_000);
            child.on("message", ready);
            child.once("error", fail);
            child.once("exit", fail);
          });
          return child;
        };
        const own = await start(a, "node (vitest 1)");
        const sibling = await start(b, "node (vitest 2)");
        const unrelated = await start(a, "node (unrelated)");
        const subdirectory = await start(nested, "node (vitest 3)");
        const from = join(link, "nested directory");
        const deps = systemDependencies();
        expect(await realpath(a)).toBe(await realpath(link));
        expect(await deps.cwd(own.pid)).toBe(await realpath(a));
        const dry = await execute(process.execPath, [helper, "--dry-run"], {
          cwd: from,
          timeout: 20_000,
        });
        expect(dry.stdout).toContain(`Selected PID ${own.pid} (dry run)`);
        for (const child of children) {
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
          process.kill(child.pid as number, 0);
        }
        const stopped = await execute(process.execPath, [helper], {
          cwd: from,
          timeout: 20_000,
        });
        expect(stopped.stdout).toContain(`Stopped PID ${own.pid}`);
        await exited(own);
        for (const child of [sibling, unrelated, subdirectory]) {
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
          process.kill(child.pid as number, 0);
        }
        const empty = await execute(process.execPath, [helper], {
          cwd: a,
          timeout: 20_000,
        });
        expect(empty.stdout).toContain("No confirmed Vitest processes");
      } finally {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            try {
              await exited(child);
            } catch {
              child.kill("SIGKILL");
              await exited(child);
            }
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    });
    test("real CLI refuses non-Git cwd and unknown arguments", async () => {
      const root = await mkdtemp(join(tmpdir(), "no-git-cleanup-"));
      try {
        await expect(
          execute(process.execPath, [helper], { cwd: root }),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining("Git worktree root"),
        });
        await expect(
          execute(process.execPath, [helper, "--pid", "1"], { cwd: root }),
        ).rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining("Usage:"),
        });
        const help = await execute(process.execPath, [helper, "--help"], {
          cwd: root,
        });
        expect(help.stdout).toContain("no forced cleanup");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    test("system inspection refuses missing tools and unsupported platforms", async () => {
      // Run the real dependency implementation in an isolated child. No helper
      // selection/signalling happens; PATH and platform never change in Vitest.
      const moduleUrl = new URL("../scripts/stop-my-tests.mjs", import.meta.url)
        .href;
      const program = `import { systemDependencies } from ${JSON.stringify(moduleUrl)};
Object.defineProperty(process, 'platform', { value: process.argv[1] });
await systemDependencies().prepare();`;
      await expect(
        execute(process.execPath, [
          "--input-type=module",
          "-e",
          program,
          "win32",
        ]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("only macOS and Linux"),
      });
      await expect(
        execute(
          process.execPath,
          ["--input-type=module", "-e", program, "darwin"],
          { env: { ...process.env, PATH: "/no-tools-here" } },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("install lsof"),
      });
    });
  },
);
