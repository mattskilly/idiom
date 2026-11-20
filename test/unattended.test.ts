import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { renderDoctorReport } from "../src/commands/doctor.js";
import { RunFailure, UnattendedFailure } from "../src/errors.js";
import {
  type Condition,
  clearedScopes,
  conditionLine,
  conditionTitle,
  fromBaseline,
  fromBrokenCoverage,
  fromGateComparison,
  fromRunFailure,
} from "../src/unattended/condition.js";
import { conditionMarker, reportConditions } from "../src/unattended/file.js";
import {
  conditionStorePath,
  openConditions,
  readConditions,
  recordConditions,
} from "../src/unattended/store.js";
import { memoryTracker } from "./unattended-support.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-unattended-"));
  directories.push(directory);
  return directory;
}

const serverTimeout = () =>
  new RunFailure({
    stage: "server",
    cause: "server-timeout",
    headline: "server failed to start: http://127.0.0.1:3107/ never answered",
    hint: "raise server.startupTimeoutMs",
    detail: "line one\nline two",
  });

const expectation = (state = "ready"): Condition =>
  fromBrokenCoverage({
    mode: "nightly",
    flow: "studio",
    broken: [
      {
        state,
        viewport: "phone",
        colorScheme: "light",
        mismatches: [{ kind: "text-present", expected: "Book now" }],
      },
    ],
  })[0] as Condition;

test("each builder maps its signal to a key, a subcause and one actionable line", () => {
  const app = fromRunFailure(serverTimeout(), {
    mode: "nightly",
    flow: "studio",
  });
  expect(app).toMatchObject({
    key: "app-start",
    cause: "app-start",
    subcause: "server-timeout",
    flows: ["studio"],
  });
  expect(conditionLine(app as Condition)).toBe(
    "idiom nightly: app-start: studio: server failed to start: http://127.0.0.1:3107/ never answered — fix: raise server.startupTimeoutMs; diagnose with idiom doctor studio",
  );
  expect(conditionTitle(app as Condition)).toBe(
    "Idiom cannot run studio: server failed to start: http://127.0.0.1:3107/ never answered",
  );

  const missing = fromRunFailure(
    new RunFailure({
      stage: "preflight",
      cause: "baseline-missing",
      headline: 'no recorded baseline for "studio" reachable from HEAD',
      hint: "record one",
    }),
    { mode: "gate", flow: "studio" },
  );
  expect(conditionLine(missing as Condition)).toBe(
    'idiom gate: baseline: studio: no recorded baseline for "studio" reachable from HEAD — fix: idiom baseline record studio on a clean main and commit .idiom/baselines',
  );

  const stale = fromBaseline({
    mode: "nightly",
    flow: "studio",
    baseline: { stale: { reason: "checks configuration changed" } },
  });
  expect(stale).toMatchObject({
    key: "baseline:studio",
    subcause: "baseline-stale",
  });
  expect(conditionLine(stale as Condition)).toContain(
    "— fix: idiom baseline advance studio (or baseline record) on main and commit it",
  );
  expect(
    fromBaseline({
      mode: "nightly",
      flow: "studio",
      baseline: { coversNone: true },
    }),
  ).toMatchObject({ subcause: "baseline-uncovered" });
  expect(
    fromBaseline({ mode: "nightly", flow: "studio", baseline: {} }),
  ).toBeUndefined();

  expect(
    fromGateComparison({
      flow: "studio",
      comparison: { mode: "none", base: "abcdef0123456789" },
    }),
  ).toMatchObject({ key: "baseline:studio", subcause: "baseline-missing" });
  expect(
    fromGateComparison({
      flow: "studio",
      comparison: { mode: "fallback", base: "abcdef0123456789" },
    }),
  ).toBeUndefined();

  const broken = fromBrokenCoverage({
    mode: "gate",
    flow: "studio",
    flowFile: ".idiom/flows/studio.json",
    broken: [
      {
        state: "ready",
        viewport: "phone",
        colorScheme: "light",
        mismatches: [{ kind: "selector-present", expected: "#book" }],
      },
      {
        state: "ready",
        viewport: "desktop",
        colorScheme: "dark",
        mismatches: [{ kind: "selector-present", expected: "#book" }],
      },
      {
        state: "done",
        viewport: "phone",
        colorScheme: "light",
        mismatches: [{ kind: "status", expected: 200, actual: 500 }],
      },
    ],
  });
  expect(broken.map((condition) => condition.key)).toEqual([
    "expectation:studio/ready",
    "expectation:studio/done",
  ]);
  expect(broken[0]?.coordinates).toEqual(["phone/light", "desktop/dark"]);
  expect(conditionLine(broken[0] as Condition)).toBe(
    `idiom gate: expectation: studio/ready: expect no longer matches at phone/light, desktop/dark: selector-present "#book" — fix: fix the app, or update the state's steps/expect in .idiom/flows/studio.json; confirm with idiom capture studio --states ready`,
  );
});

test("a condition line is one line even when the failure detail is not; other run failures are not conditions", () => {
  const app = fromRunFailure(
    new RunFailure({
      stage: "server",
      cause: "server-exited",
      headline: "server failed to start:\nexited 1",
      hint: "check\nthe command",
    }),
    { mode: "verify", flow: "studio" },
  ) as Condition;
  const line = conditionLine(app);
  expect(line).not.toContain("\n");
  expect(line.split(" — fix: ")).toHaveLength(2);
  for (const cause of ["browser-launch", "tree-dirty", "invalid-config"])
    expect(
      fromRunFailure(
        new RunFailure({ stage: "preflight", cause, headline: "x", hint: "y" }),
        { mode: "nightly", flow: "studio" },
      ),
    ).toBeUndefined();
  expect(
    fromRunFailure(new Error("plain"), { mode: "nightly", flow: "studio" }),
  ).toBeUndefined();
  const failure = new UnattendedFailure([
    { key: app.key, cause: app.cause, line },
  ]);
  expect(failure).toBeInstanceOf(RunFailure);
  expect(failure.failureJson()).toMatchObject({
    stage: "server",
    cause: "unattended-app-start",
    conditions: [{ key: "app-start", cause: "app-start", line }],
  });
});

test("cleared scopes cover only states captured cleanly, at the coordinates that ran", () => {
  const scopes = clearedScopes({
    flow: "studio",
    legacyColorScheme: "light",
    baselineUsable: true,
    summary: {
      coverage: {
        states: ["ready", "done", "error"],
        failedTuples: [{ state: "error", viewport: "phone" }],
      },
      scope: {
        selected: [
          { state: "ready", viewport: "phone", colorScheme: "light" },
          { state: "done", viewport: "phone" },
          { state: "error", viewport: "phone" },
        ],
      },
      brokenCoverage: [
        {
          state: "done",
          viewport: "phone",
          colorScheme: "light",
          mismatches: [{ kind: "text-present", expected: "x" }],
        },
      ],
    },
  });
  expect(scopes).toEqual([
    { key: "baseline:studio" },
    { key: "expectation:studio/ready", coordinates: ["phone/light"] },
  ]);
});

test("the store upserts runs and resolves only scopes a run fully covered", async () => {
  const directory = await temporary();
  const path = join(directory, ".idiom/reports/conditions.json");
  const now = (day: number) => new Date(Date.UTC(2026, 10, day));
  const ready = expectation("ready");
  const done = expectation("done");
  await recordConditions({
    path,
    mode: "nightly",
    observed: [ready, done],
    cleared: [],
    now: now(1),
  });
  const second = await recordConditions({
    path,
    mode: "gate",
    observed: [ready],
    // The gate re-captured done at a different viewport only: not covered.
    cleared: [
      { key: "expectation:studio/done", coordinates: ["desktop/light"] },
    ],
    now: now(2),
  });
  expect(second.observed[0]).toMatchObject({
    key: "expectation:studio/ready",
    runs: 2,
    firstSeen: now(1).toISOString(),
    lastSeen: now(2).toISOString(),
    mode: "gate",
  });
  expect(second.resolved).toEqual([]);
  expect((await openConditions(path)).map((entry) => entry.key)).toEqual([
    "expectation:studio/ready",
    "expectation:studio/done",
  ]);
  // A run that never saw done at all clears nothing either.
  await recordConditions({
    path,
    mode: "nightly",
    observed: [],
    cleared: [{ key: "baseline:studio" }],
    now: now(3),
  });
  expect(await openConditions(path)).toHaveLength(2);
  const third = await recordConditions({
    path,
    mode: "nightly",
    observed: [ready],
    cleared: [{ key: "expectation:studio/done", coordinates: ["phone/light"] }],
    now: now(4),
  });
  expect(third.resolved.map((entry) => entry.key)).toEqual([
    "expectation:studio/done",
  ]);
  expect((await openConditions(path)).map((entry) => entry.key)).toEqual([
    "expectation:studio/ready",
  ]);
  // It recurs: a fresh first-seen and run count.
  const again = await recordConditions({
    path,
    mode: "nightly",
    observed: [done],
    cleared: [],
    now: now(5),
  });
  expect(again.observed[0]).toMatchObject({
    runs: 1,
    firstSeen: now(5).toISOString(),
  });
});

test("concurrent recordConditions calls lose no entry", async () => {
  const directory = await temporary();
  const path = join(directory, ".idiom/reports/conditions.json");
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      recordConditions({
        path,
        mode: "gate",
        observed: [expectation(`s${index}`)],
        cleared: [],
        now: new Date(),
      }),
    ),
  );
  expect(await readConditions(path)).toHaveLength(12);
});

test("in a linked worktree the store is the primary checkout's", async () => {
  const primary = await temporary();
  const git = (cwd: string, ...args: string[]) =>
    exec("git", args, { cwd }).then(({ stdout }) => stdout.trim());
  await git(primary, "init", "--quiet", "--initial-branch=main");
  await mkdir(join(primary, "app", ".idiom"), { recursive: true });
  await writeFile(join(primary, "app", ".idiom", "project.json"), "{}");
  await git(primary, "add", ".");
  await git(
    primary,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "-m",
    "init",
  );
  const linked = join(await temporary(), "linked");
  await git(primary, "worktree", "add", "--quiet", linked);
  const real = (await git(primary, "rev-parse", "--show-toplevel")).trim();
  expect(
    await conditionStorePath({ projectDirectory: join(linked, "app") }),
  ).toBe(join(real, "app", ".idiom", "reports", "conditions.json"));
  expect(
    await conditionStorePath({ projectDirectory: join(primary, "app") }),
  ).toBe(join(primary, "app", ".idiom", "reports", "conditions.json"));
  // Not a Git checkout: the project's own store.
  const plain = await temporary();
  expect(await conditionStorePath({ projectDirectory: plain })).toBe(
    join(plain, ".idiom", "reports", "conditions.json"),
  );
});

test("one ticket per distinct cause across runs, recovered by marker, cleared once and never moved", async () => {
  const project = await temporary();
  const { tracker, tickets, calls } = memoryTracker();
  const app = fromRunFailure(serverTimeout(), {
    mode: "nightly",
    flow: "studio",
  }) as Condition;
  const report = (
    observed: Condition[],
    cleared: Array<{ key: string }> = [],
    day = 1,
  ) =>
    reportConditions({
      mode: "nightly",
      projectDirectory: project,
      observed,
      cleared,
      tracker,
      now: new Date(Date.UTC(2026, 10, day)),
    });
  const first = await report([app]);
  expect(first.outcomes).toEqual([
    { key: "app-start", ticket: "file-1", kind: "created" },
  ]);
  expect(first.conditions).toEqual([
    { key: "app-start", cause: "app-start", line: conditionLine(app) },
  ]);
  const second = await report([app], [], 2);
  expect(second.outcomes[0]).toMatchObject({
    ticket: "file-1",
    kind: "updated",
  });
  // The local store is lost (a fresh worktree): the marker still finds it.
  await rm(join(project, ".idiom"), { recursive: true, force: true });
  const third = await report([app], [], 3);
  expect(third.outcomes[0]).toMatchObject({
    ticket: "file-1",
    kind: "updated",
  });
  expect(tickets).toHaveLength(1);
  expect(tickets[0]?.state).toBe("triage");
  expect(tickets[0]?.labels).toEqual(["idiom", "idiom-condition"]);
  expect(tickets[0]?.title).toMatch(/^Idiom cannot run studio: /);
  expect(tickets[0]?.body).toContain(conditionMarker("app-start"));
  expect(tickets[0]?.body).toContain("- Fix: raise server.startupTimeoutMs");
  // A second, distinct cause is its own ticket.
  await report([app, expectation()], [], 4);
  expect(tickets.map((ticket) => ticket.ref.id)).toEqual(["file-1", "file-2"]);
  // An unchanged body is not rewritten.
  const same = await reportConditions({
    mode: "nightly",
    projectDirectory: project,
    observed: [expectation()],
    cleared: [],
    tracker,
    now: new Date(Date.UTC(2026, 10, 4)),
  });
  expect(same.outcomes[0]?.kind).toBe("updated");
  // Cleared once: one Cleared: line, the ticket stays in triage.
  const cleared = await report([], [{ key: "app-start" }], 5);
  expect(cleared.outcomes).toEqual([
    { key: "app-start", ticket: "file-1", kind: "cleared" },
  ]);
  expect(tickets[0]?.body).toMatch(/Cleared: 2026-11-05 by idiom nightly\n$/);
  expect(tickets[0]?.state).toBe("triage");
  await report([], [{ key: "app-start" }], 6);
  expect(tickets[0]?.body.match(/Cleared:/g)).toHaveLength(1);
  expect(calls).not.toContain("move");
});

test("no triage state or a failing tracker still returns the conditions", async () => {
  const project = await temporary();
  const bare = memoryTracker({ triage: [] });
  const noTriage = await reportConditions({
    mode: "gate",
    projectDirectory: project,
    observed: [expectation()],
    cleared: [],
    tracker: bare.tracker,
  });
  expect(noTriage.conditions).toHaveLength(1);
  expect(noTriage.outcomes[0]?.kind).toBe("skipped");
  expect(noTriage.messages[0]).toMatch(/could not file .*triage role/);
  const failing = memoryTracker({ failCreate: true });
  const errored = await reportConditions({
    mode: "gate",
    projectDirectory: project,
    observed: [expectation("other")],
    cleared: [],
    tracker: failing.tracker,
  });
  expect(errored.conditions).toHaveLength(1);
  expect(errored.outcomes[0]).toMatchObject({
    kind: "error",
    message: "tracker unavailable",
  });
  // Both are recorded for doctor regardless.
  expect(await openConditions(errored.storePath)).toHaveLength(2);
});

test("tracker off files nothing; ab runs without the build session's identity", async () => {
  const project = await temporary();
  await writeFile(join(project, "autobuild.toml"), "[commands]\n");
  const off = await reportConditions({
    mode: "gate",
    projectDirectory: project,
    observed: [expectation()],
    cleared: [],
    environment: { IDIOM_UNATTENDED_TRACKER: "off" },
  });
  expect(off.outcomes).toEqual([
    { key: "expectation:studio/ready", kind: "skipped" },
  ]);
  const bin = await temporary();
  const log = join(bin, "env.jsonl");
  await writeFile(
    join(bin, "ab"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ verb: process.argv[3], build: process.env.AB_BUILD ?? null, phase: process.env.AB_PHASE ?? null, session: process.env.AB_SESSION ?? null }) + "\\n");
if (process.argv[3] === "states") process.stdout.write(JSON.stringify([{ name: "triage", roles: ["triage"] }]));
else if (process.argv[3] === "list") process.stdout.write("[]");
else process.stdout.write(JSON.stringify({ ref: { id: "file-9" }, resolved: false, labels: [], body: "" }));
`,
    { mode: 0o755 },
  );
  const filed = await reportConditions({
    mode: "gate",
    projectDirectory: project,
    observed: [expectation()],
    cleared: [],
    environment: {
      PATH: `${bin}:/usr/bin:/bin`,
      IDIOM_UNATTENDED_TRACKER: "autobuild",
      AB_BUILD: "some-build",
      AB_PHASE: "verify",
      AB_SESSION: "s-1",
    },
  });
  expect(filed.outcomes).toEqual([
    { key: "expectation:studio/ready", ticket: "file-9", kind: "created" },
  ]);
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.map((call) => call.verb)).toEqual(["states", "list", "create"]);
  for (const call of calls)
    expect(call).toMatchObject({ build: null, phase: null, session: null });
});

test("doctor lists each open condition with its ticket and history", () => {
  const text = renderDoctorReport({
    ok: true,
    steps: [{ id: "node", status: "pass", ms: 1, detail: "Node 22" }],
    conditions: [
      {
        key: "app-start",
        cause: "app-start",
        line: "idiom nightly: app-start: studio: server failed to start — fix: x",
        mode: "nightly",
        firstSeen: "2026-11-01T03:17:00.000Z",
        lastSeen: "2026-11-03T03:17:00.000Z",
        runs: 3,
        ticket: "file-1",
      },
    ],
  });
  expect(text).toContain("idiom doctor project: ok; 1 open condition(s)");
  expect(text).toContain("Open conditions (1):");
  expect(text).toContain(
    "  idiom nightly: app-start: studio: server failed to start — fix: x",
  );
  expect(text).toContain(
    "ticket file-1; seen 3× since 2026-11-01, last 2026-11-03 by nightly",
  );
  expect(
    renderDoctorReport({
      ok: true,
      steps: [{ id: "node", status: "pass", ms: 1 }],
    }),
  ).toContain("No open conditions from unattended runs.");
});
