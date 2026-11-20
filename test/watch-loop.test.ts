import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import type { ClusterInputs } from "../src/commands/check.js";
import { initProject } from "../src/commands/init.js";
import { fileNightly } from "../src/nightly/file.js";
import { ledgerPath, readLedger } from "../src/nightly/ledger.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import {
  renderWatchEvent,
  runWatch,
  type WatchEvent,
  type WatchOptions,
} from "../src/watch/loop.js";
import type { GateStepResult, WatchSteps } from "../src/watch/merge.js";
import type { Merge } from "../src/watch/merges.js";
import {
  readWatchState,
  watchDirectory,
  watchStatePath,
} from "../src/watch/state.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function repository() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-watch-")),
  );
  directories.push(directory);
  const git = async (...args: string[]) =>
    (
      await exec(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: directory },
      )
    ).stdout.trim();
  const commit = async (message: string) => {
    await writeFile(join(directory, "change.txt"), `${message}\n`);
    await git("add", "-A");
    await git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  await initProject({ project: directory, yes: true, write: () => {} });
  await writeFile(join(directory, ".gitignore"), ".idiom/reports/\n");
  await writeFile(
    join(directory, ".idiom/flows/site.json"),
    JSON.stringify({
      id: "site",
      title: "Site",
      intent: [],
      setup: [],
      states: [{ id: "home", description: "Home", url: "/", expect: {} }],
    }),
  );
  await git("init", "--quiet", "--initial-branch=main");
  const initial = await commit("initial");
  return { directory, git, commit, initial };
}

type Call = { step: keyof WatchSteps; commit?: string; parent?: string };

/** Steps that record their calls; each may be overridden. */
function fakeSteps(
  calls: Call[],
  overrides: Partial<WatchSteps> = {},
): Partial<WatchSteps> {
  return {
    prepare: async (merge) => {
      calls.push({ step: "prepare", commit: merge.commit });
      return { treeProject: "/nowhere" };
    },
    gate: async (merge) => {
      calls.push({ step: "gate", commit: merge.commit, parent: merge.parent });
      return clean();
    },
    file: async () => {
      calls.push({ step: "file" });
      return [];
    },
    advance: async (merge) => {
      calls.push({ step: "advance", commit: merge.commit });
      return { status: "advanced", flows: ["site"] };
    },
    harvest: async () => {
      calls.push({ step: "harvest" });
      return { status: "unavailable", reason: "no ab" };
    },
    ...overrides,
  };
}

const clean = (): GateStepResult => ({
  gate: { status: "clean", newFindings: 0, eligible: 0 },
  inputs: [],
});

function watch(
  directory: string,
  options: Partial<WatchOptions> & {
    steps: Partial<WatchSteps>;
    events?: WatchEvent[];
  },
) {
  const events = options.events ?? [];
  const { steps, events: _events, ...rest } = options;
  return runWatch({
    project: directory,
    cwd: directory,
    tracker: "directory",
    once: true,
    log: (event) => events.push(event),
    ...rest,
    dependencies: {
      steps,
      environment: { ...process.env, PATH: "/usr/bin:/bin" },
      ...rest.dependencies,
    },
  });
}

async function state(directory: string) {
  return readWatchState(watchStatePath(await watchDirectory(directory)));
}

test("first start begins at the tip; --since replays from a commit", async () => {
  const repo = await repository();
  const calls: Call[] = [];
  const events: WatchEvent[] = [];
  const first = await watch(repo.directory, {
    steps: fakeSteps(calls),
    events,
  });
  expect(first.processed).toEqual([]);
  expect(calls).toEqual([]);
  expect(events.map((event) => event.event)).toEqual(["start"]);
  expect((await state(repo.directory))?.cursor).toBe(repo.initial);

  const other = await repository();
  const a = await other.commit("a");
  const b = await other.commit("b");
  const replay: Call[] = [];
  const result = await watch(other.directory, {
    since: other.initial,
    steps: fakeSteps(replay),
  });
  expect(result.processed.map((outcome) => outcome.commit)).toEqual([a, b]);
  // --since only seeds a first start.
  const ignored: WatchEvent[] = [];
  await watch(other.directory, {
    since: other.initial,
    steps: fakeSteps(replay),
    events: ignored,
  });
  expect(ignored.map((event) => event.event)).toEqual(["since-ignored"]);
});

test("merges run oldest first, one at a time, first-parent only, each step in order", async () => {
  const repo = await repository();
  await watch(repo.directory, { steps: fakeSteps([]) });
  const a = await repo.commit("a");
  await repo.git("checkout", "--quiet", "-b", "feature");
  const f1 = await repo.commit("feature 1");
  const f2 = await repo.commit("feature 2");
  await repo.git("checkout", "--quiet", "main");
  await repo.git(
    "merge",
    "--quiet",
    "--no-ff",
    "-m",
    "Merge feature",
    "feature",
  );
  const merge = await repo.git("rev-parse", "HEAD");
  const c = await repo.commit("c");

  const calls: Call[] = [];
  let running = 0;
  let peak = 0;
  const result = await watch(repo.directory, {
    steps: fakeSteps(calls, {
      gate: async (item: Merge) => {
        running += 1;
        peak = Math.max(peak, running);
        calls.push({ step: "gate", commit: item.commit, parent: item.parent });
        await new Promise((done) => setTimeout(done, 20));
        running -= 1;
        return clean();
      },
    }),
  });
  expect(peak).toBe(1);
  expect(result.processed.map((outcome) => outcome.commit)).toEqual([
    a,
    merge,
    c,
  ]);
  const gates = calls.filter((call) => call.step === "gate");
  expect(gates).toEqual([
    { step: "gate", commit: a, parent: repo.initial },
    { step: "gate", commit: merge, parent: a },
    { step: "gate", commit: c, parent: merge },
  ]);
  expect(calls.map((call) => call.commit)).not.toContain(f1);
  expect(calls.map((call) => call.commit)).not.toContain(f2);
  // Clean merges skip filing.
  expect(calls.slice(0, 4).map((call) => call.step)).toEqual([
    "prepare",
    "gate",
    "advance",
    "harvest",
  ]);
  expect((await state(repo.directory))?.cursor).toBe(c);
});

test("a stop mid-merge keeps its cursor; the restart redoes only that merge, once", async () => {
  const repo = await repository();
  await watch(repo.directory, { steps: fakeSteps([]) });
  await repo.commit("m1");
  const m2 = await repo.commit("m2");
  const done: Call[] = [];
  await watch(repo.directory, { steps: fakeSteps(done) });
  expect(done.filter((call) => call.step === "gate")).toHaveLength(2);
  expect((await state(repo.directory))?.cursor).toBe(m2);

  const m3 = await repo.commit("m3");
  const controller = new AbortController();
  const events: WatchEvent[] = [];
  const stopped = await watch(repo.directory, {
    signal: controller.signal,
    events,
    steps: fakeSteps([], {
      gate: async () => {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    }),
  });
  expect(stopped.stopped).toBe(true);
  const interrupted = await state(repo.directory);
  expect(interrupted?.cursor).toBe(m2);
  expect(interrupted?.inFlight?.commit).toBe(m3);
  expect(renderWatchEvent(events.at(-1) as WatchEvent)).toMatch(
    new RegExp(`stopped; ${m3.slice(0, 12)} will be redone$`),
  );

  const redo: Call[] = [];
  const resumed: WatchEvent[] = [];
  await watch(repo.directory, { steps: fakeSteps(redo), events: resumed });
  expect(
    redo.filter((call) => call.step === "gate").map((call) => call.commit),
  ).toEqual([m3]);
  expect(resumed.map((event) => event.event)).toEqual(["resume", "merge"]);
  expect((await state(repo.directory))?.inFlight).toBeUndefined();

  const again: Call[] = [];
  const quiet: WatchEvent[] = [];
  await watch(repo.directory, { steps: fakeSteps(again), events: quiet });
  expect(again).toEqual([]);
  expect(quiet.filter((event) => event.event === "merge")).toEqual([]);
});

test("rewritten history resets the cursor to the tip without processing", async () => {
  const repo = await repository();
  await repo.commit("a");
  await watch(repo.directory, { steps: fakeSteps([]) });
  await repo.git("reset", "--quiet", "--hard", repo.initial);
  const b = await repo.commit("b instead");
  const calls: Call[] = [];
  const events: WatchEvent[] = [];
  await watch(repo.directory, { steps: fakeSteps(calls), events });
  expect(calls).toEqual([]);
  expect(events.map((event) => event.event)).toEqual(["rewritten"]);
  expect((await state(repo.directory))?.cursor).toBe(b);
});

test("a failing merge is retried once, then recorded; the next merge still runs; harvest never fails a merge", async () => {
  const repo = await repository();
  await watch(repo.directory, { steps: fakeSteps([]) });
  const bad = await repo.commit("bad");
  const good = await repo.commit("good");
  const calls: Call[] = [];
  const events: WatchEvent[] = [];
  const result = await watch(repo.directory, {
    events,
    steps: fakeSteps(calls, {
      gate: async (merge) => {
        calls.push({ step: "gate", commit: merge.commit });
        if (merge.commit === bad) throw new Error("port 3000 is busy");
        return clean();
      },
      harvest: async () => {
        throw new Error("gh exploded");
      },
    }),
  });
  expect(
    calls.filter((call) => call.step === "gate").map((call) => call.commit),
  ).toEqual([bad, bad, good]);
  expect(events.map((event) => event.event)).toEqual([
    "retry",
    "merge",
    "merge",
  ]);
  expect(result.processed[0]).toMatchObject({
    commit: bad,
    error: "port 3000 is busy",
  });
  expect(result.processed[1]).toMatchObject({
    commit: good,
    harvest: { status: "error", reason: "gh exploded" },
  });
  expect(result.processed[1]?.error).toBeUndefined();
});

test("only a clean or skipped gate advances the baseline", async () => {
  const repo = await repository();
  await watch(repo.directory, { steps: fakeSteps([]) });
  const statuses = ["findings", "clean", "skipped", "deferred"] as const;
  const commits: string[] = [];
  for (const status of statuses) commits.push(await repo.commit(status));
  const advanced: string[] = [];
  const result = await watch(repo.directory, {
    steps: fakeSteps([], {
      gate: async (merge) => ({
        gate: {
          status: statuses[commits.indexOf(merge.commit)] ?? "clean",
          newFindings: 0,
          eligible: 0,
        },
        inputs: [],
      }),
      advance: async (merge) => {
        advanced.push(merge.commit);
        return { status: "advanced", flows: ["site"] };
      },
    }),
  });
  expect(advanced).toEqual([commits[1], commits[2]]);
  expect(result.processed.map((outcome) => outcome.baseline.status)).toEqual([
    "not-advanced",
    "advanced",
    "advanced",
    "not-advanced",
  ]);
});

test("a second watcher fails fast on the lock; aborting the first releases it", async () => {
  const repo = await repository();
  const controller = new AbortController();
  let sleeping: () => void = () => {};
  const asleep = new Promise<void>((done) => {
    sleeping = done;
  });
  const first = watch(repo.directory, {
    once: false,
    signal: controller.signal,
    steps: fakeSteps([]),
    dependencies: {
      sleep: (_ms, signal) =>
        new Promise((done) => {
          sleeping();
          signal.addEventListener("abort", () => done(), { once: true });
        }),
    },
  });
  await asleep;
  await expect(watch(repo.directory, { steps: fakeSteps([]) })).rejects.toThrow(
    /another idiom watch holds .*watch\.lock/,
  );
  controller.abort();
  const result = await first;
  expect(result.stopped).toBe(true);
  await expect(
    watch(repo.directory, { steps: fakeSteps([]) }),
  ).resolves.toMatchObject({ stopped: false });
});

test("one log line per finished merge, and the JSON form parses", async () => {
  const repo = await repository();
  await watch(repo.directory, { steps: fakeSteps([]) });
  const a = await repo.commit("Merge feature-2");
  const events: WatchEvent[] = [];
  await watch(repo.directory, {
    events,
    steps: fakeSteps([], {
      gate: async () => ({
        gate: { status: "findings", newFindings: 1, eligible: 1 },
        inputs: [
          { records: [], rootCauses: new Map(), issueScores: new Map() },
        ],
      }),
    }),
  });
  const merges = events.filter((event) => event.event === "merge");
  expect(merges).toHaveLength(1);
  const line = renderWatchEvent(merges[0] as WatchEvent);
  expect(line).toContain(a.slice(0, 12));
  expect(line).toContain('"Merge feature-2"');
  expect(line).toContain("gate: 1 new (1 at threshold)");
  expect(line).toContain("baseline: not advanced (findings)");
  expect(line).toContain("harvest: unavailable (no ab)");
  expect(line.split("\n")).toHaveLength(1);
  const parsed = JSON.parse(renderWatchEvent(merges[0] as WatchEvent, true));
  expect(parsed).toMatchObject({ event: "merge", commit: a });
});

function finding(index: number): Finding {
  return findingSchema.parse({
    id: `finding-${index}`,
    fingerprint: `fingerprint-${index}`,
    createdAt: "2026-11-15T03:17:00.000Z",
    commit: "def5678def5678",
    flow: "site",
    state: "home",
    viewport: "wide",
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    evidence: { screenshots: [`home/wide/crops/${index}.png`], artifacts: [] },
    explanation: `Action ${index} is too small.`,
    acceptance: ["Actions are at least 44 by 44 CSS pixels."],
    verification: {
      kind: "deterministic-check",
      check: "target-size",
      params: { selector: `#action-${index}` },
    },
    status: "open",
  });
}

async function storedInputs(
  project: string,
  runId: string,
  findings: Finding[],
): Promise<ClusterInputs> {
  const runDirectory = join(project, ".idiom/reports", runId);
  for (const item of findings)
    for (const screenshot of item.evidence.screenshots) {
      await mkdir(dirname(join(runDirectory, screenshot)), { recursive: true });
      await writeFile(join(runDirectory, screenshot), "png");
    }
  await writeFile(
    join(runDirectory, "findings.json"),
    JSON.stringify(findings),
  );
  return {
    records: findings.map((item) => ({
      finding: item,
      runId,
      runDirectory,
      findingsPath: join(runDirectory, "findings.json"),
    })),
    rootCauses: new Map(),
    issueScores: new Map(),
  };
}

test("a redo after filing, and a later merge seeing the same finding, file nothing twice", async () => {
  const repo = await repository();
  await watch(repo.directory, { steps: fakeSteps([]) });
  const m1 = await repo.commit("regression");
  const m2 = await repo.commit("still there");
  const regressed = finding(1);
  const realFile: WatchSteps["file"] = async (inputs, context) =>
    (
      await fileNightly({
        project: repo.directory,
        cwd: repo.directory,
        ledgerPath: context.filing.ledgerPath,
        inputs,
        severity: context.filing.severity,
        labels: context.filing.labels,
        sink: context.filing.sink.sink,
      })
    ).outcomes;
  const gate =
    (runId: string): WatchSteps["gate"] =>
    async () => ({
      gate: { status: "findings", newFindings: 1, eligible: 1 },
      inputs: [await storedInputs(repo.directory, runId, [regressed])],
    });

  // Filed, then stopped before the cursor moved.
  const controller = new AbortController();
  await watch(repo.directory, {
    signal: controller.signal,
    steps: fakeSteps([], {
      gate: gate("run-1"),
      file: realFile,
      harvest: async () => {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    }),
  });
  expect((await state(repo.directory))?.inFlight?.commit).toBe(m1);
  const ledger = await readLedger(ledgerPath(repo.directory));
  expect(ledger.entries).toHaveLength(1);
  const filed = ledger.entries[0]?.ticket;

  const result = await watch(repo.directory, {
    steps: fakeSteps([], { gate: gate("run-2"), file: realFile }),
  });
  expect(result.processed.map((outcome) => outcome.commit)).toEqual([m1, m2]);
  for (const outcome of result.processed)
    expect(outcome.tickets).toEqual([
      expect.objectContaining({
        kind: expect.stringMatching(/^(unchanged|updated)$/),
        ticket: filed,
      }),
    ]);
  expect((await readLedger(ledgerPath(repo.directory))).entries).toHaveLength(
    1,
  );
  expect(
    (await readFile(join(repo.directory, filed as string), "utf8")).length,
  ).toBeGreaterThan(0);
});

async function enableEscalations(directory: string) {
  const path = join(directory, ".idiom", "project.json");
  const project = JSON.parse(await readFile(path, "utf8"));
  await writeFile(
    path,
    JSON.stringify({ ...project, escalations: { watch: true } }, null, 2),
  );
}

const quietPass = async () => ({
  status: "read" as const,
  items: [],
  answered: [],
  warnings: [],
});

test("escalations: never run unless escalations.watch is on", async () => {
  const repo = await repository();
  let calls = 0;
  await watch(repo.directory, {
    steps: fakeSteps([]),
    dependencies: {
      escalations: async () => {
        calls += 1;
        return quietPass();
      },
    },
  });
  expect(calls).toBe(0);
});

test("escalations: one pass per loop pass, also when nothing is pending; answers are logged, quiet passes are not", async () => {
  const repo = await repository();
  await enableEscalations(repo.directory);
  const inputs: unknown[] = [];
  const events: WatchEvent[] = [];
  // Nothing pending: the first start still runs one pass.
  await watch(repo.directory, {
    steps: fakeSteps([]),
    events,
    dependencies: {
      escalations: async (input) => {
        inputs.push(input);
        return quietPass();
      },
    },
  });
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({
    projectDirectory: repo.directory,
    designFile: "DESIGN.md",
  });
  expect(events.some((event) => event.event === "escalations")).toBe(false);

  await repo.commit("Merge feature-1");
  const answered: WatchEvent[] = [];
  let passes = 0;
  await watch(repo.directory, {
    steps: fakeSteps([]),
    events: answered,
    dependencies: {
      escalations: async () => {
        passes += 1;
        return {
          ...(await quietPass()),
          answered: [
            {
              version: 1 as const,
              at: "2026-11-15T12:00:00.000Z",
              build: "booking-filter",
              escalation: "esc_1",
              phase: "implement",
              question: "Dropdown or segmented control?",
              guidance: "Idiom precedent answer: …",
              precedent: {
                kind: "ruling" as const,
                id: "ruling-1",
                where: "DESIGN.md (recorded ruling ruling-1)",
                text: "Use a segmented control.",
                score: 0.6,
                sharedTerms: ["segmented", "control"],
              },
              actor: "idiom" as const,
            },
          ],
        };
      },
    },
  });
  expect(passes).toBe(1);
  const logged = answered.filter((event) => event.event === "escalations");
  expect(logged).toHaveLength(1);
  // It runs after the pending merge was processed.
  expect(answered.map((event) => event.event)).toEqual([
    "merge",
    "escalations",
  ]);
  expect(renderWatchEvent(logged[0] as WatchEvent)).toMatch(
    /escalations: answered 1 \(booking-filter esc_1\); 0 left open/,
  );
});

test("escalations: a failing pass is logged once per streak and never stops watch", async () => {
  const repo = await repository();
  await enableEscalations(repo.directory);
  const controller = new AbortController();
  const events: WatchEvent[] = [];
  let passes = 0;
  let sleeps = 0;
  const result = await watch(repo.directory, {
    once: false,
    signal: controller.signal,
    steps: fakeSteps([]),
    events,
    dependencies: {
      escalations: async () => {
        passes += 1;
        throw new Error("ab exploded");
      },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 3) controller.abort();
      },
    },
  });
  expect(result.stopped).toBe(true);
  expect(passes).toBe(3);
  const failures = events.filter((event) => event.event === "escalations");
  expect(failures).toHaveLength(1);
  expect(renderWatchEvent(failures[0] as WatchEvent)).toMatch(
    /escalations not answered: ab exploded/,
  );
});
