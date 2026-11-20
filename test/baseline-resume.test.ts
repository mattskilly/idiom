import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  composeResumedRun,
  findResumableRun,
  type ResumeCurrent,
  resumePlan,
  resumeRefusal,
} from "../src/baseline/resume.js";
import { baselinePath, readBaselineFile } from "../src/baseline/store.js";
import { createArtifactWorkspace } from "../src/capture/artifacts.js";
import { type RunRecord, runRecordSchema } from "../src/capture/run-record.js";
import {
  baselineRecordCommand,
  renderBaselineRecord,
  renderBaselineTiming,
} from "../src/commands/baseline.js";
import { loadRunTuples } from "../src/review/artifacts.js";
import { flowSchema } from "../src/schemas/flow.js";
import { validateProject } from "../src/validation.js";
import { freePort } from "./doctor-support.js";
import { fixtureCommand } from "./support/fixture-server.js";

const SERVER = join(
  import.meta.dirname,
  "fixtures",
  "baseline-resume",
  "server.mjs",
);
const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function temporary(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
async function git(cwd: string, ...args: string[]) {
  return (
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
      { cwd },
    )
  ).stdout.trim();
}

type FixtureState = { id: string; url: string; missing?: boolean };
async function fixtureProject(options: {
  states: FixtureState[];
  probe?: boolean;
  stateMaxMinutes?: number;
  slowMs?: number;
}) {
  const directory = await temporary("idiom-resume-test-");
  const port = await freePort();
  await mkdir(join(directory, ".idiom", "flows"), { recursive: true });
  await writeFile(
    join(directory, ".idiom", "project.json"),
    JSON.stringify(
      {
        version: 1,
        app: { name: "resume", framework: "other" },
        server: {
          build: "node -e 0",
          start: fixtureCommand(SERVER),
          readyUrl: `http://127.0.0.1:${port}/`,
          port,
          fixedPort: true,
          env: { PORT: String(port), SLOW_MS: String(options.slowMs ?? 0) },
        },
        viewports: [{ name: "desktop", width: 800, height: 600 }],
        colorSchemes: ["light", "dark"],
        capture: {
          settleMs: 0,
          concurrency: 2,
          ...(options.stateMaxMinutes === undefined
            ? {}
            : { stateMaxMinutes: options.stateMaxMinutes }),
        },
        checks: { probe: { enabled: options.probe ?? true } },
        design: {},
        model: { provider: "anthropic", model: "unused" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(directory, ".idiom", "flows", "home.json"),
    JSON.stringify({
      id: "home",
      title: "Home",
      intent: [],
      setup: [],
      states: options.states.map((state) => ({
        id: state.id,
        description: state.id,
        url: state.url,
        expect: state.missing ? { selectorPresent: ["#missing"] } : {},
      })),
    }),
  );
  await writeFile(join(directory, ".gitignore"), ".idiom/reports/\n");
  await git(directory, "init", "--quiet", "-b", "main");
  await git(directory, "add", ".");
  await git(directory, "commit", "--quiet", "-m", "fixture");
  return directory;
}

/** Abort the capture once `count` checkpoints of the given kind committed. */
function interruptAfter(count: number, kind: "final" | "any") {
  const controller = new AbortController();
  let seen = 0;
  const create: typeof createArtifactWorkspace = async (options) => {
    const workspace = await createArtifactWorkspace(options);
    const lifecycle = workspace.lifecycle;
    if (lifecycle !== undefined) {
      const checkpoint = lifecycle.checkpoint.bind(lifecycle);
      lifecycle.checkpoint = async (coordinate, timing, commit, options) => {
        await checkpoint(coordinate, timing, commit, options);
        if (kind === "any" || options?.final === true) {
          seen += 1;
          if (seen === count) controller.abort(new Error("test interrupt"));
        }
      };
    }
    return workspace;
  };
  return {
    capture: { signal: controller.signal, createArtifactWorkspace: create },
  };
}

async function runs(project: string): Promise<RunRecord[]> {
  const reports = join(project, ".idiom", "reports");
  const records: RunRecord[] = [];
  for (const name of await readdir(reports)) {
    if (name.startsWith(".")) continue;
    try {
      records.push(
        runRecordSchema.parse(
          JSON.parse(await readFile(join(reports, name, "run.json"), "utf8")),
        ),
      );
    } catch {
      // Not a run.
    }
  }
  return records.sort((a, b) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
  );
}

async function baselineTuples(directory: string) {
  const file = await readBaselineFile(baselinePath(directory, "home"));
  const record = file?.records.at(-1);
  if (record === undefined) throw new Error(`no baseline in ${directory}`);
  return {
    commit: record.commit,
    tuples: [...record.tuples]
      .map((tuple) => ({
        ...tuple,
        findings: [...tuple.findings].sort((a, b) =>
          a.fingerprint.localeCompare(b.fingerprint),
        ),
      }))
      .sort((a, b) =>
        `${a.state}/${a.viewport}/${a.colorScheme}`.localeCompare(
          `${b.state}/${b.viewport}/${b.colorScheme}`,
        ),
      ),
  };
}

async function coverage(project: string, runId: string) {
  const validated = await validateProject({ project, flow: "home" });
  const flow = validated.flows[0]?.flow;
  if (flow === undefined) throw new Error("no flow");
  const loaded = await loadRunTuples(
    validated,
    flow,
    join(project, ".idiom", "reports", runId),
  );
  return {
    expected: loaded.expectedTupleKeys,
    collapsed: loaded.collapsedTupleKeys,
    tuples: loaded.tuples
      .map(
        (tuple) =>
          `${tuple.state}/${tuple.viewport}/${tuple.colorScheme}:${tuple.failure?.stage ?? "ok"}:${tuple.screenshotPath === undefined ? "no-shot" : "shot"}`,
      )
      .sort(),
  };
}

const STATES: FixtureState[] = [
  { id: "home", url: "/", missing: true },
  { id: "account", url: "/account" },
  { id: "billing", url: "/billing" },
  { id: "settings", url: "/settings", missing: true },
];

test("an interrupted capture resumed with --resume records the baseline an uninterrupted one does", async () => {
  const project = await fixtureProject({ states: STATES });
  const outside = await temporary("idiom-resume-baselines-");
  const uninterruptedOut = join(outside, "uninterrupted");
  const resumedOut = join(outside, "resumed");

  const uninterrupted = await baselineRecordCommand({
    project,
    flow: "home",
    out: uninterruptedOut,
  });
  const expected = await baselineTuples(uninterruptedOut);
  // Findings in an early and a late state, so both sides of the cut count.
  const withFindings = expected.tuples
    .filter((tuple) => tuple.findings.length > 0)
    .map((tuple) => tuple.state);
  expect(withFindings).toEqual(expect.arrayContaining(["home", "settings"]));
  expect(renderBaselineTiming(uninterrupted)).toContain("Slowest tuples:");
  const [first] = await runs(project);
  if (first?.runId === undefined) throw new Error("no uninterrupted run");
  const checks = JSON.parse(
    await readFile(
      join(project, ".idiom", "reports", first.runId, "checks-timings.json"),
      "utf8",
    ),
  ) as { tuples?: unknown[] };
  expect(checks.tuples).toHaveLength(8);
  expect(first.timings.tuples[0]?.steps).toMatchObject({
    capture: expect.any(Number),
    artifacts: expect.any(Number),
    secretScan: expect.any(Number),
  });

  // Stop after three tuples' evidence is final: some states are kept,
  // the rest are captured again.
  const failure = await baselineRecordCommand({
    project,
    flow: "home",
    out: join(outside, "never"),
    dependencies: interruptAfter(3, "final"),
  }).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  expect(failure?.message).toContain(
    "continue with: idiom baseline record home --resume",
  );
  const interrupted = (await runs(project)).at(-1);
  expect(interrupted).toMatchObject({ status: "interrupted" });
  expect(interrupted?.finalTuples).toHaveLength(3);

  // A capture setting committed since is refused with the reason; going
  // back to the captured commit makes the run resumable again.
  const config = join(project, ".idiom", "project.json");
  const original = await readFile(config, "utf8");
  await writeFile(config, original.replace('"settleMs": 0', '"settleMs": 5'));
  await git(project, "commit", "--quiet", "-am", "slower settle");
  const head = await git(project, "rev-parse", "HEAD");
  await expect(
    baselineRecordCommand({ project, flow: "home", resume: true }),
  ).rejects.toThrow(
    `cannot resume run ${interrupted?.runId}: it captured ${interrupted?.source.commit.slice(0, 12)} but HEAD is ${head.slice(0, 12)}; run idiom baseline record home for a fresh capture`,
  );
  await git(project, "reset", "--quiet", "--hard", "HEAD~1");

  const resumed = await baselineRecordCommand({
    project,
    flow: "home",
    resume: true,
    out: resumedOut,
  });
  expect(resumed.resumed).toEqual({
    from: interrupted?.runId,
    carried: 3,
    captured: 5,
  });
  expect(renderBaselineRecord(resumed)).toMatch(
    /^Resumed run \S+: kept 3 tuple\(s\), captured 5\./,
  );
  expect(await baselineTuples(resumedOut)).toEqual(expected);
  expect(resumed.findingCount).toBe(uninterrupted.findingCount);
  expect(resumed.tupleCount).toBe(uninterrupted.tupleCount);

  const composed = (await runs(project)).find(
    (record) => record.resumedFrom !== undefined,
  );
  expect(composed).toMatchObject({
    status: "complete",
    selected: first.selected,
    resumedFrom: [interrupted?.runId, expect.any(String)],
  });
  expect(await coverage(project, composed?.runId ?? "")).toEqual(
    await coverage(project, first.runId),
  );
  // The hidden partial run is gone; only real runs remain.
  expect(
    (await readdir(join(project, ".idiom", "reports"))).filter((name) =>
      name.startsWith(".resume-"),
    ),
  ).toEqual([]);
  // The newest run is complete now: nothing is left to resume.
  await expect(
    baselineRecordCommand({ project, flow: "home", resume: true }),
  ).rejects.toThrow("nothing to resume");
  await expect(
    baselineRecordCommand({
      project,
      flow: "home",
      resume: true,
      latest: true,
    }),
  ).rejects.toThrow("--resume cannot be combined with --from or --latest");
}, 300_000);

test("a capture interrupted before any tuple is final recaptures everything on resume", async () => {
  const project = await fixtureProject({ states: STATES.slice(0, 2) });
  const outside = await temporary("idiom-resume-baselines-");
  await baselineRecordCommand({
    project,
    flow: "home",
    out: join(outside, "uninterrupted"),
  });
  // Four pre-probe checkpoints: every tuple completed, none final.
  await expect(
    baselineRecordCommand({
      project,
      flow: "home",
      dependencies: interruptAfter(4, "any"),
    }),
  ).rejects.toThrow();
  const interrupted = (await runs(project)).at(-1);
  expect(interrupted?.completedTuples?.length ?? 0).toBeGreaterThan(0);
  expect(interrupted?.finalTuples ?? []).toEqual([]);
  const resumed = await baselineRecordCommand({
    project,
    flow: "home",
    resume: true,
    out: join(outside, "resumed"),
  });
  expect(resumed.resumed).toMatchObject({ carried: 0, captured: 4 });
  expect(await baselineTuples(join(outside, "resumed"))).toEqual(
    await baselineTuples(join(outside, "uninterrupted")),
  );
}, 240_000);

test("a state over capture.stateMaxMinutes fails alone and the others record", async () => {
  const project = await fixtureProject({
    states: [
      { id: "home", url: "/" },
      { id: "slow", url: "/slow" },
    ],
    probe: false,
    // 15 seconds, far above a healthy state's; the slow page answers after 120.
    stateMaxMinutes: 0.25,
    slowMs: 120_000,
  });
  const out = join(await temporary("idiom-resume-baselines-"), "budget");
  const result = await baselineRecordCommand({ project, flow: "home", out });
  expect(result.stateBudgetFailures).toEqual([
    {
      state: "slow",
      tuples: 2,
      message: expect.stringMatching(
        /^state slow exceeded capture\.stateMaxMinutes=0\.25 during capture$/,
      ),
    },
  ]);
  expect(renderBaselineRecord(result)).toContain(
    "State slow exceeded capture.stateMaxMinutes=0.25 during capture; its 2 tuple(s) were not recorded.",
  );
  const recorded = await baselineTuples(out);
  expect(recorded.tuples.map((tuple) => tuple.state)).toEqual(["home", "home"]);
}, 180_000);

// Unit coverage of the resume decisions, on hand-built records.

const coordinate = (
  state: string,
  colorScheme: "light" | "dark" = "light",
  viewport = "desktop",
) => ({ state, viewport, colorScheme });
function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const selected = overrides.selected ?? [coordinate("a"), coordinate("b")];
  return runRecordSchema.parse({
    version: 1,
    status: "interrupted",
    runId: "2026-11-16T00-00-00-000Z",
    owner: { pid: 1 },
    startedAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:01.000Z",
    completedTuples: [],
    finalTuples: [],
    interruption: { reason: "capture-failed" },
    captureSettingsIdentity: "a".repeat(64),
    idiomVersion: "1.0.0",
    production: false,
    toggleIdentity: "b".repeat(64),
    flow: "home",
    source: { commit: "c".repeat(40), dirty: false },
    declared: selected,
    selected,
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    probe: {
      policy: "once-per-state",
      fallback: false,
      intended: [],
      executed: [],
    },
    timings: {
      build: { status: "skipped", ms: 0 },
      start: { status: "skipped", ms: 0 },
      tuples: selected.map((tuple) => ({
        ...tuple,
        total: { status: "measured", ms: 1 },
        probe: { status: "skipped", ms: 0 },
      })),
      probe: { status: "skipped", ms: 0 },
      checks: { status: "skipped", ms: 0 },
    },
    ...overrides,
  });
}
const current = (overrides: Partial<ResumeCurrent> = {}): ResumeCurrent => ({
  commit: "c".repeat(40),
  dirty: false,
  captureSettingsIdentity: "a".repeat(64),
  idiomVersion: "1.0.0",
  production: false,
  toggleIdentity: "b".repeat(64),
  selected: [coordinate("a"), coordinate("b")],
  ...overrides,
});

test("resume refuses each mismatch with its own reason", () => {
  expect(resumeRefusal(record(), current())).toBeUndefined();
  const cases: Array<[RunRecord, ResumeCurrent, string]> = [
    [
      record({ captureSettingsIdentity: undefined }),
      current(),
      "it predates resumable captures (no capture settings identity recorded)",
    ],
    [
      record(),
      current({ commit: "d".repeat(40) }),
      "it captured cccccccccccc but HEAD is dddddddddddd",
    ],
    [
      record({ source: { commit: "c".repeat(40), dirty: true } }),
      current(),
      "its captured tree was dirty",
    ],
    [record(), current({ dirty: true }), "the working tree is dirty"],
    [
      record(),
      current({ idiomVersion: "1.1.0" }),
      "it was captured by Idiom 1.0.0, this is 1.1.0",
    ],
    [
      record({ production: true }),
      current(),
      "it was a production capture and this one is not",
    ],
    [
      record(),
      current({ production: true }),
      "this is a production capture and it was not",
    ],
    [
      record(),
      current({ captureSettingsIdentity: "e".repeat(64) }),
      "the capture configuration changed since it ran (capture settings identity differs)",
    ],
    [
      record(),
      current({ toggleIdentity: "f".repeat(64) }),
      "the flow's toggle declarations changed",
    ],
    [
      record(),
      current({ selected: [coordinate("a"), coordinate("c")] }),
      "the flow's selected tuples changed (added: c/desktop/light; removed: b/desktop/light)",
    ],
  ];
  for (const [stored, now, reason] of cases)
    expect(resumeRefusal(stored, now)).toBe(reason);
});

async function storedRun(
  reports: string,
  stored: RunRecord,
  tuples: Array<{
    coordinate: ReturnType<typeof coordinate>;
    failure?: { stage: string; message: string };
    layoutRepresentative?: string;
  }>,
) {
  const directory = join(reports, stored.runId ?? "run");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "run.json"), JSON.stringify(stored));
  for (const tuple of tuples) {
    const base = join(
      directory,
      tuple.coordinate.state,
      tuple.coordinate.viewport,
      tuple.coordinate.colorScheme,
    );
    await mkdir(base, { recursive: true });
    await writeFile(
      join(base, "metadata.json"),
      JSON.stringify({
        failure: tuple.failure ?? null,
        expectations: { passed: tuple.failure === undefined },
        colorSchemeAxis: true,
        ...(tuple.layoutRepresentative === undefined
          ? {}
          : { layoutRepresentative: tuple.layoutRepresentative }),
      }),
    );
  }
  return { directory, record: stored };
}

test("findResumableRun takes the flow's newest run and only if it was interrupted", async () => {
  const reports = await temporary("idiom-resume-reports-");
  await expect(findResumableRun(reports, "home")).rejects.toThrow(
    "no interrupted capture of home to resume",
  );
  await storedRun(
    reports,
    record({ runId: "older", updatedAt: "2026-11-16T00:00:01.000Z" }),
    [],
  );
  await storedRun(
    reports,
    record({
      runId: "other-flow",
      flow: "other",
      updatedAt: "2026-11-16T02:00:00.000Z",
    }),
    [],
  );
  // A hidden partial run is never a candidate.
  await storedRun(
    reports,
    record({ runId: ".resume-partial", updatedAt: "2026-11-16T03:00:00.000Z" }),
    [],
  );
  expect((await findResumableRun(reports, "home")).record.runId).toBe("older");
  const complete = record({
    runId: "newer",
    status: "complete",
    updatedAt: "2026-11-16T01:00:00.000Z",
    completedTuples: [coordinate("a"), coordinate("b")],
  });
  await storedRun(reports, complete, []);
  await expect(findResumableRun(reports, "home")).rejects.toThrow(
    "nothing to resume: the newest capture of home (newer) completed",
  );
});

test("resume keeps final tuples only, never a state over its budget, and whole toggle groups", async () => {
  const reports = await temporary("idiom-resume-reports-");
  const plain = flowSchema.parse({
    id: "home",
    title: "Home",
    intent: [],
    setup: [],
    states: ["a", "b", "c"].map((id) => ({
      id,
      description: id,
      url: `/${id}`,
      expect: {},
    })),
  });
  const selected = [coordinate("a"), coordinate("b"), coordinate("c")];
  const stored = await storedRun(
    reports,
    record({
      selected,
      declared: selected,
      completedTuples: selected,
      finalTuples: [coordinate("a"), coordinate("b")],
    }),
    [
      { coordinate: coordinate("a") },
      {
        coordinate: coordinate("b"),
        failure: { stage: "state-budget", message: "state b exceeded" },
      },
      { coordinate: coordinate("c") },
    ],
  );
  const plan = await resumePlan(stored, plain);
  expect(plan.carried).toEqual([coordinate("a")]);
  expect(plan.remaining).toEqual([coordinate("b"), coordinate("c")]);

  // Toggles: editor's combinations form one group per viewport and scheme.
  const toggled = flowSchema.parse({
    id: "home",
    title: "Home",
    intent: [],
    setup: [],
    states: [{ id: "editor", description: "Editor", url: "/", expect: {} }],
    toggles: {
      drawer: { closed: [], open: [{ action: "click", selector: "#d" }] },
    },
    toggleRegions: [".drawer"],
  });
  const ids = toggled.states
    .filter((state) => "combination" in state && state.combination)
    .map((state) => state.id);
  expect(ids.length).toBe(2);
  const both = ids.flatMap((id) => [
    coordinate(id, "light"),
    coordinate(id, "dark"),
  ]);
  const second = await storedRun(
    await temporary("idiom-resume-reports-"),
    record({
      selected: both,
      declared: both,
      completedTuples: both,
      // The light group is whole; the dark group lost its second member.
      finalTuples: [
        coordinate(ids[0] ?? "", "light"),
        coordinate(ids[1] ?? "", "light"),
        coordinate(ids[0] ?? "", "dark"),
      ],
    }),
    both.map((tuple) => ({ coordinate: tuple })),
  );
  const grouped = await resumePlan(second, toggled);
  expect(grouped.carried).toEqual([
    coordinate(ids[0] ?? "", "light"),
    coordinate(ids[1] ?? "", "light"),
  ]);
});

test("the composed run rebuilds combinations.json from both runs, with or without an early copy", async () => {
  const toggled = flowSchema.parse({
    id: "home",
    title: "Home",
    intent: [],
    setup: [],
    states: [{ id: "editor", description: "Editor", url: "/", expect: {} }],
    toggles: {
      drawer: { closed: [], open: [{ action: "click", selector: "#d" }] },
    },
    toggleRegions: [".drawer"],
  });
  const [closed, open] = toggled.states
    .filter((state) => "combination" in state && state.combination)
    .map((state) => state.id);
  if (closed === undefined || open === undefined) throw new Error("states");
  const all = [
    coordinate(closed, "light"),
    coordinate(open, "light"),
    coordinate(closed, "dark"),
    coordinate(open, "dark"),
  ];
  const label = (id: string) =>
    (
      toggled.states.find((state) => state.id === id) as {
        combination?: { label: string };
      }
    ).combination?.label ?? "";
  const collapsedEntry = (scheme: "light" | "dark") => ({
    state: open,
    viewport: "desktop",
    colorScheme: scheme,
    colorSchemeAxis: true,
    combination: label(open),
    sameAs: { state: closed, combination: label(closed) },
  });
  for (const early of [true, false]) {
    const reports = await temporary("idiom-resume-reports-");
    const interrupted = await storedRun(
      reports,
      record({
        runId: "interrupted",
        selected: all,
        declared: all,
        completedTuples: all,
        finalTuples: all.slice(0, 2),
      }),
      [
        { coordinate: all[0] ?? coordinate("x") },
        { coordinate: all[1] ?? coordinate("x"), layoutRepresentative: closed },
      ],
    );
    if (early)
      await writeFile(
        join(interrupted.directory, "combinations.json"),
        JSON.stringify({
          version: 1,
          evidence: "per-combination",
          captured: 2,
          collapsed: [collapsedEntry("light"), collapsedEntry("dark")],
          notes: ["a note"],
        }),
      );
    const remaining = all.slice(2);
    const partialRecord = record({
      runId: "partial",
      status: "complete",
      selected: remaining,
      declared: all,
      completedTuples: remaining,
      finalTuples: remaining,
    });
    const partial = await storedRun(reports, partialRecord, [
      { coordinate: all[2] ?? coordinate("x") },
      { coordinate: all[3] ?? coordinate("x"), layoutRepresentative: closed },
    ]);
    await writeFile(
      join(partial.directory, "combinations.json"),
      JSON.stringify({
        version: 1,
        evidence: "per-combination",
        captured: 1,
        collapsed: [collapsedEntry("dark")],
        notes: ["a note"],
      }),
    );
    await writeFile(join(partial.directory, "server.log"), "log\n");
    const composed = await composeResumedRun({
      reports,
      flow: toggled,
      interrupted,
      partial,
      carried: all.slice(0, 2),
    });
    const combinations = JSON.parse(
      await readFile(join(composed.directory, "combinations.json"), "utf8"),
    );
    expect(combinations).toMatchObject({
      captured: 2,
      collapsed: [collapsedEntry("light"), collapsedEntry("dark")],
      notes: early ? ["a note"] : ["a note"],
    });
    expect(await readFile(join(composed.directory, "server.log"), "utf8")).toBe(
      "log\n",
    );
    expect(composed.record).toMatchObject({
      status: "complete",
      selected: all,
      resumedFrom: ["interrupted", "partial"],
    });
  }
});

test("a rebuilt production build is refused", async () => {
  const reports = await temporary("idiom-resume-reports-");
  const plain = flowSchema.parse({
    id: "home",
    title: "Home",
    intent: [],
    setup: [],
    states: [{ id: "a", description: "a", url: "/", expect: {} }],
  });
  const interrupted = await storedRun(
    reports,
    record({
      runId: "interrupted",
      production: true,
      selected: [coordinate("a"), coordinate("b")],
      finalTuples: [coordinate("a")],
    }),
    [{ coordinate: coordinate("a") }],
  );
  await writeFile(
    join(interrupted.directory, "build.json"),
    JSON.stringify({ kind: "production", id: "old" }),
  );
  const partial = await storedRun(
    reports,
    record({
      runId: "partial",
      status: "complete",
      production: true,
      selected: [coordinate("b")],
      declared: [coordinate("a"), coordinate("b")],
      completedTuples: [coordinate("b")],
    }),
    [{ coordinate: coordinate("b") }],
  );
  await writeFile(
    join(partial.directory, "build.json"),
    JSON.stringify({ kind: "production", id: "new" }),
  );
  await expect(
    composeResumedRun({
      reports,
      flow: plain,
      interrupted,
      partial,
      carried: [coordinate("a")],
    }),
  ).rejects.toThrow(
    "cannot resume run interrupted: the production build was rebuilt (old → new)",
  );
});
