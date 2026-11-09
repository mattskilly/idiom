import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { afterEach, expect, test, vi } from "vitest";
import {
  baselineGapDiagnostic,
  captureCompleteness,
} from "../src/baseline/record.js";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { CaptureInterrupted } from "../src/capture/ownership.js";
import { runCapture } from "../src/capture/run.js";
import {
  completeRunNames,
  RunLifecycle,
  recoverInterruptedRun,
  runOwnerGone,
} from "../src/capture/run-lifecycle.js";
import { type RunRecord, runRecordSchema } from "../src/capture/run-record.js";
import {
  captureLaunchOptions,
  scrollbarLaunchOptions,
} from "../src/capture/scrollbars.js";
import type { BrowserSession, BrowserTuple } from "../src/capture/types.js";
import { freePort } from "./doctor-support.js";
import { fixtureCommand } from "./support/fixture-server.js";
import { toggleFlow, toggleProject } from "./toggle-support.js";

// A killed run leaves a visible record of what it finished. A graceful
// interrupt says so at once; a hard kill is reported by the next command.

const CLI = join(import.meta.dirname, "..", "build", "cli.js");
const SERVER = join(
  import.meta.dirname,
  "fixtures",
  "interrupted-capture",
  "server.mjs",
);
const directories: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function heldProject() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-interrupted-test-"));
  const scratch = await mkdtemp(join(tmpdir(), "idiom-interrupted-hold-"));
  directories.push(directory, scratch);
  const hold = join(scratch, "hold");
  await writeFile(hold, "");
  const port = await freePort();
  await mkdir(join(directory, ".idiom", "flows"), { recursive: true });
  await writeFile(
    join(directory, ".idiom", "project.json"),
    JSON.stringify({
      version: 1,
      app: { name: "held", framework: "other" },
      server: {
        build: "node -e 0",
        start: `HOLD_FILE='${hold}' ${fixtureCommand(SERVER)}`,
        readyUrl: `http://127.0.0.1:${port}/`,
        port,
        fixedPort: true,
        env: { PORT: String(port) },
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: { settleMs: 0, concurrency: 1 },
      design: {},
      model: { provider: "anthropic", model: "unused" },
    }),
  );
  await writeFile(
    join(directory, ".idiom", "flows", "home.json"),
    JSON.stringify({
      id: "home",
      title: "Home",
      intent: [],
      setup: [],
      states: [
        { id: "home", description: "Home", url: "/", expect: {} },
        { id: "held", description: "Held", url: "/held", expect: {} },
      ],
    }),
  );
  await writeFile(join(directory, ".gitignore"), ".idiom/reports/\n");
  const git = promisify(execFile);
  await git("git", ["init", "--quiet"], { cwd: directory });
  await git("git", ["add", "."], { cwd: directory });
  await git(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: directory },
  );
  return { directory, hold };
}

function cli(directory: string, args: string[]) {
  const child = spawn(
    process.execPath,
    [CLI, "--project", directory, ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  cleanups.push(() => child.kill("SIGKILL"));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<number | null>((accept) =>
    child.once("close", accept),
  );
  return {
    child,
    finished: async () => ({
      code: await closed,
      stdout,
      stderr: () => stderr,
    }),
    stderr: () => stderr,
  };
}

async function runDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(join(directory, ".idiom", "reports"))).filter(
      (name) => !name.startsWith("."),
    );
  } catch {
    return [];
  }
}

async function record(run: string): Promise<RunRecord> {
  return runRecordSchema.parse(
    JSON.parse(await readFile(join(run, "run.json"), "utf8")),
  );
}

async function committedRun(directory: string): Promise<string | undefined> {
  const [name] = await runDirectories(directory);
  if (name === undefined) return undefined;
  const run = join(directory, ".idiom", "reports", name);
  try {
    const current = await record(run);
    if ((current.completedTuples?.length ?? 0) > 0) return run;
  } catch {
    // The record is replaced atomically, but may not exist yet.
  }
  return undefined;
}

/**
 * Polls the visible ledger until a tuple commits or the CLI exits; the test
 * timeout is the only bound. Never assumes how long a capture takes.
 */
async function committed(
  directory: string,
  child: ChildProcess,
  stderr: () => string,
) {
  while (child.exitCode === null && child.signalCode === null) {
    const run = await committedRun(directory);
    if (run !== undefined) return run;
    await delay(50);
  }
  const run = await committedRun(directory);
  if (run !== undefined) return run;
  throw new Error(`the capture never committed a tuple: ${stderr()}`);
}

for (const signal of ["SIGTERM", "SIGINT"] as const)
  test(`${signal} keeps the finished tuple and prints the interrupted line`, async () => {
    const { directory } = await heldProject();
    const capture = cli(directory, ["capture", "home"]);
    const run = await committed(directory, capture.child, capture.stderr);
    const running = await record(run);
    expect(running).toMatchObject({
      status: "running",
      runId: running.runId,
      selected: [
        { state: "home", viewport: "desktop", colorScheme: "light" },
        { state: "held", viewport: "desktop", colorScheme: "light" },
      ],
      completedTuples: [
        { state: "home", viewport: "desktop", colorScheme: "light" },
      ],
    });
    expect(running.source.commit).toMatch(/^[0-9a-f]{40}$/);
    capture.child.kill(signal);
    const result = await capture.finished();
    expect(result.code).not.toBe(0);
    const interrupted = await record(run);
    expect(interrupted).toMatchObject({
      status: "interrupted",
      interruption: { reason: "signal", signal },
      completedTuples: [
        { state: "home", viewport: "desktop", colorScheme: "light" },
      ],
    });
    await access(join(run, "home", "desktop", "screenshot.png"));
    await access(join(run, "home", "desktop", "dom.html"));
    await expect(access(join(run, "held", "desktop"))).rejects.toThrow();
    const line = `Interrupted: run ${interrupted.runId} kept 1 of 2 tuples (unverified).`;
    expect(result.stderr().split(line).length - 1).toBe(1);
    // An interrupted run is never a capture a reader can consume.
    expect(
      await completeRunNames(join(directory, ".idiom", "reports")),
    ).toEqual([]);
  }, 90_000);

test("capture browsers leave SIGINT and SIGTERM to Idiom's interrupt", async () => {
  // Playwright's handlers would race the interrupt record; on SIGINT they
  // call process.exit(130) before run.json is sealed.
  expect(captureLaunchOptions).toMatchObject({
    ...scrollbarLaunchOptions,
    handleSIGINT: false,
    handleSIGTERM: false,
  });
  expect(captureLaunchOptions).not.toHaveProperty("handleSIGHUP");
  const launch = vi
    .spyOn(chromium, "launch")
    .mockRejectedValue(new Error("no browser in this test"));
  try {
    await expect(createBrowserLauncher()()).rejects.toThrow(
      "no browser in this test",
    );
    expect(launch).toHaveBeenCalledWith(captureLaunchOptions);
  } finally {
    launch.mockRestore();
  }
});

test("a SIGKILLed run is reported once by the next check", async () => {
  const { directory, hold } = await heldProject();
  const capture = cli(directory, ["capture", "home"]);
  const run = await committed(directory, capture.child, capture.stderr);
  capture.child.kill("SIGKILL");
  await capture.finished();
  const orphan = await record(run);
  expect(orphan.status).toBe("running");
  await access(join(run, "home", "desktop", "screenshot.png"));

  await rm(hold);
  const check = cli(directory, ["check", "home"]);
  const checked = await check.finished();
  const notice = `Run ${orphan.runId} was interrupted (process gone) after 1 of 2 tuples.`;
  expect(checked.stderr().split(notice).length - 1, checked.stderr()).toBe(1);
  expect(checked.stderr()).toContain("Stopped a leftover application server");
  expect(await record(run)).toMatchObject({
    status: "interrupted",
    interruption: { reason: "process-gone" },
    completedTuples: [
      { state: "home", viewport: "desktop", colorScheme: "light" },
    ],
  });
  // Reaping the dead server does not erase the kept evidence.
  await access(join(run, "home", "desktop", "screenshot.png"));

  const again = await cli(directory, ["check", "home"]).finished();
  expect(again.stderr()).not.toContain("was interrupted");
}, 120_000);

function lifecycleRecord(): RunRecord {
  const tuples = ["a", "b", "c"].map((state) => ({
    state,
    viewport: "desktop",
    colorScheme: "light" as const,
  }));
  return runRecordSchema.parse({
    version: 1,
    status: "running",
    runId: "2026-11-06T00-00-00Z",
    owner: { pid: 999_999, start: "gone" },
    startedAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
    completedTuples: [],
    flow: "f",
    source: { commit: "a".repeat(40), dirty: false },
    declared: tuples,
    selected: tuples,
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    probe: {
      policy: "once-per-state",
      fallback: false,
      intended: [],
      executed: [],
    },
    timings: {
      build: { status: "unavailable", ms: 0 },
      start: { status: "unavailable", ms: 0 },
      probe: { status: "unavailable", ms: 0 },
      checks: { status: "unavailable", ms: 0 },
      tuples: tuples.map((tuple) => ({
        ...tuple,
        total: { status: "unavailable", ms: 0 },
        probe: { status: "unavailable", ms: 0 },
      })),
    },
    capture: { reducedMotion: true },
  });
}

async function lifecycleDirectory(initial = lifecycleRecord()) {
  const root = await mkdtemp(join(tmpdir(), "idiom-lifecycle-test-"));
  directories.push(root);
  const directory = join(root, initial.runId as string);
  await mkdir(directory);
  await writeFile(join(directory, "run.json"), JSON.stringify(initial));
  return { root, directory };
}

test("checkpoints count coordinates once, in selected order, and stop after interruption", async () => {
  const initial = lifecycleRecord();
  const { directory } = await lifecycleDirectory(initial);
  const lifecycle = new RunLifecycle(directory, structuredClone(initial));
  const [a, b, c] = initial.selected as [
    RunRecord["selected"][number],
    RunRecord["selected"][number],
    RunRecord["selected"][number],
  ];
  // Out-of-order lanes and a retried coordinate.
  await Promise.all([
    lifecycle.checkpoint(c, undefined, async () => delay(20)),
    lifecycle.checkpoint(a, undefined, async () => undefined),
    lifecycle.checkpoint(c, undefined, async () => undefined),
  ]);
  expect((await record(directory)).completedTuples).toEqual([a, c]);
  const messages: string[] = [];
  const late = lifecycle.checkpoint(b, undefined, async () => delay(30));
  await lifecycle.interrupt({ reason: "signal", signal: "SIGTERM" }, (m) =>
    messages.push(m),
  );
  await late;
  // The already-started commit was joined; nothing after sealing counts.
  await lifecycle.checkpoint(b, undefined, async () => undefined);
  const final = await record(directory);
  expect(final.status).toBe("interrupted");
  expect(final.completedTuples).toEqual([a, b, c]);
  expect(messages).toEqual([
    `Interrupted: run ${initial.runId} kept 3 of 3 tuples (unverified).`,
  ]);
  await expect(
    lifecycle.complete(final, async () => undefined),
  ).rejects.toThrow("interrupted");
});

test("an aborted publication never commits a complete record", async () => {
  const initial = lifecycleRecord();
  const { directory } = await lifecycleDirectory(initial);
  const lifecycle = new RunLifecycle(directory, structuredClone(initial));
  const controller = new AbortController();
  await expect(
    lifecycle.complete(
      initial,
      async () => {
        controller.abort(new Error("stop"));
      },
      controller.signal,
    ),
  ).rejects.toThrow("stop");
  expect((await record(directory)).status).toBe("running");
});

test("recovery treats a vanished pid or a reused pid as gone, and uncertainty as live", async () => {
  const owner = { pid: 4242, start: "Mon Nov  3 10:00:00 2026" };
  expect(await runOwnerGone(owner, { exists: () => false })).toBe(true);
  expect(
    await runOwnerGone(owner, {
      exists: () => true,
      inspect: async () => ({ start: "Tue Nov  4 10:00:00 2026", args: "" }),
    }),
  ).toBe(true);
  expect(
    await runOwnerGone(owner, {
      exists: () => true,
      inspect: async () => ({ start: owner.start, args: "" }),
    }),
  ).toBe(false);
  expect(
    await runOwnerGone(owner, {
      exists: () => true,
      inspect: async () => undefined,
    }),
  ).toBe(false);
  expect(await runOwnerGone(owner, { exists: () => undefined })).toBe(false);
  expect(
    await runOwnerGone(owner, {
      exists: () => true,
      inspect: async () => {
        throw new Error("ps failed");
      },
    }),
  ).toBe(false);
});

test("two concurrent recoverers produce one notice, and a stale lock is reclaimed", async () => {
  const { root, directory } = await lifecycleDirectory();
  const messages: string[] = [];
  const deps = {
    exists: (pid: number) => pid === process.pid,
    diagnostic: (message: string) => messages.push(message),
  };
  await Promise.all([
    recoverInterruptedRun(directory, deps),
    recoverInterruptedRun(directory, deps),
  ]);
  expect(messages).toEqual([
    "Run 2026-11-06T00-00-00Z was interrupted (process gone) after 0 of 3 tuples.",
  ]);
  await recoverInterruptedRun(directory, deps);
  expect(messages).toHaveLength(1);

  const second = join(root, "second");
  await mkdir(second);
  await writeFile(
    join(second, "run.json"),
    JSON.stringify({ ...lifecycleRecord(), runId: "second" }),
  );
  await mkdir(join(second, ".recovery-lock"));
  await writeFile(
    join(second, ".recovery-lock", "owner.json"),
    JSON.stringify({ pid: 999_998 }),
  );
  await recoverInterruptedRun(second, deps);
  expect(messages.at(-1)).toBe(
    "Run second was interrupted (process gone) after 0 of 3 tuples.",
  );
  await expect(access(join(second, ".recovery-lock"))).rejects.toThrow();
});

test("concurrent recoverers never fail on lock release and leave no lock", async () => {
  // A contender's reclaim claim can land inside the holder's lock between the
  // release's directory read and its rmdir; release must never fail on it.
  for (let round = 0; round < 40; round++) {
    const { directory } = await lifecycleDirectory();
    const messages: string[] = [];
    const deps = {
      exists: (pid: number) => pid === process.pid,
      diagnostic: (message: string) => messages.push(message),
    };
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => recoverInterruptedRun(directory, deps)),
    );
    expect(
      settled.filter((result) => result.status === "rejected"),
      `round ${round}`,
    ).toEqual([]);
    expect(messages, `round ${round}`).toHaveLength(1);
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".recovery-lock"),
      ),
      `round ${round}`,
    ).toEqual([]);
  }
});

test("readers skip running and interrupted runs even with complete-looking files, and keep legacy runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "idiom-lifecycle-readers-"));
  directories.push(root);
  const live = { ...lifecycleRecord(), owner: { pid: process.pid } };
  for (const [name, value] of [
    ["2026-11-06T01-00-00Z", live],
    ["2026-11-06T02-00-00Z", { ...live, status: "interrupted" }],
  ] as const) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "run.json"), JSON.stringify(value));
    await writeFile(join(root, name, "baseline.md"), "# decoy\n");
    await writeFile(join(root, name, "findings.json"), "[]");
  }
  await mkdir(join(root, "2026-11-05T00-00-00Z"));
  await writeFile(join(root, "2026-11-05T00-00-00Z", "baseline.md"), "# ok\n");
  // An unrecognised status is never consumed; a record with no status that
  // fails validation reaches its reader, which reports it as invalid.
  await mkdir(join(root, "2026-11-04T00-00-00Z"));
  await writeFile(
    join(root, "2026-11-04T00-00-00Z", "run.json"),
    JSON.stringify({ status: "paused" }),
  );
  await mkdir(join(root, "2026-11-03T00-00-00Z"));
  await writeFile(join(root, "2026-11-03T00-00-00Z", "run.json"), "{broken");
  expect(await completeRunNames(root)).toEqual([
    "2026-11-05T00-00-00Z",
    "2026-11-03T00-00-00Z",
  ]);
  const { storedRunsNewestFirst, loadCaptureRun } = await import(
    "../src/review/artifacts.js"
  );
  expect(await storedRunsNewestFirst(root)).toEqual([
    "2026-11-05T00-00-00Z",
    "2026-11-03T00-00-00Z",
  ]);
  await expect(
    loadCaptureRun({
      runDirectory: join(root, "2026-11-06T02-00-00Z"),
      expectedFlow: "f",
    }),
  ).rejects.toThrow("is interrupted; retained evidence is unverified");
});

test("the baseline gap line counts and lists failed tuples in selected order", () => {
  const selected = Array.from({ length: 120 }, (_, index) => ({
    state: `s${index}`,
    viewport: "desktop",
    colorScheme: "light" as const,
  }));
  const failedStates = new Set(["s7", "s40", "s99"]);
  const loaded = {
    record: { selected } as unknown as RunRecord,
    expectedTupleKeys: [],
    tuples: selected.map((tuple) => ({
      ...tuple,
      ...(failedStates.has(tuple.state)
        ? { failure: { stage: "navigation", message: "timed out" } }
        : { screenshotPath: `${tuple.state}.png` }),
    })),
  } as unknown as Parameters<typeof captureCompleteness>[0];
  const { failures, total } = captureCompleteness(loaded, "light");
  expect(baselineGapDiagnostic(failures, total).message).toBe(
    "Baseline not recorded: 3 of 120 tuples failed (s7/desktop/light, s40/desktop/light, s99/desktop/light). Findings for the other 117 are above.",
  );
});

test("an interrupt after a collapsed tuple keeps its representative's own artifacts", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "idiom-interrupted-collapse-"),
  );
  directories.push(directory);
  const project = await toggleProject();
  project.capture.concurrency = 1;
  const flow = toggleFlow();
  const controller = new AbortController();
  let collapsedSettled: BrowserTuple | undefined;
  const browser: BrowserSession = {
    version: "fake",
    close: async () => {},
    measure: async () => "same layout",
    capture: async (tuple) => {
      // The lane checkpoints a settled tuple before it starts the next one.
      if (collapsedSettled !== undefined) {
        controller.abort(new CaptureInterrupted("SIGTERM"));
        throw new Error("interrupted");
      }
      if (tuple.reuseScreenshot !== undefined) collapsedSettled = tuple;
      const { width, height } = tuple.viewport;
      return {
        ok: true,
        status: 200,
        dom: `<html><body>${tuple.state.id}</body></html>`,
        screenshot: Buffer.from(`png ${tuple.state.id}`),
        console: [],
        axe: { violations: [] },
        mismatches: [],
        observations: {
          version: 1,
          viewport: { width, height },
          document: {
            scrollWidth: width,
            scrollHeight: height,
            clientWidth: width,
            clientHeight: height,
          },
          elements: [],
          headings: [{ selector: "h1", level: 1, text: tuple.state.id }],
          tokens: { status: "not-configured" },
        },
        startedAt: "2026-11-06T00:00:00.000Z",
        endedAt: "2026-11-06T00:00:01.000Z",
      };
    },
  };
  await expect(
    runCapture({
      projectDirectory: directory,
      project,
      flow,
      out: join(directory, "run"),
      dependencies: {
        browserLauncher: async () => browser,
        snapshotSource: async () => ({ commit: "fixture", dirty: false }),
        inheritedEnvironment: { PATH: process.env.PATH },
        signal: controller.signal,
      },
    }),
  ).rejects.toThrow();
  if (collapsedSettled === undefined) throw Error("no collapsed tuple");
  const run = join(directory, "run");
  const current = await record(run);
  expect(current.status).toBe("interrupted");
  const collapsedDirectory = join(
    run,
    collapsedSettled.state.id,
    collapsedSettled.viewport.name,
  );
  const representative = JSON.parse(
    await readFile(join(collapsedDirectory, "metadata.json"), "utf8"),
  ).layoutRepresentative as string;
  expect(
    current.completedTuples?.some(
      (tuple) =>
        tuple.state === representative &&
        tuple.viewport === collapsedSettled?.viewport.name,
    ),
  ).toBe(true);
  const representativeDirectory = join(
    run,
    representative,
    collapsedSettled.viewport.name,
  );
  expect(
    await readFile(join(representativeDirectory, "dom.html"), "utf8"),
  ).toContain(`<body>${representative}</body>`);
  expect(
    await readFile(join(representativeDirectory, "observations.json"), "utf8"),
  ).toContain(representative);
  expect(
    await readFile(join(representativeDirectory, "observations.json"), "utf8"),
  ).not.toContain(collapsedSettled.state.id);
  expect(
    JSON.parse(
      await readFile(join(representativeDirectory, "metadata.json"), "utf8"),
    ).state.id,
  ).toBe(representative);
  expect(
    await readFile(join(representativeDirectory, "screenshot.png"), "utf8"),
  ).toBe(`png ${representative}`);
}, 60_000);
