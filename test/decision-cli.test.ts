import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { readDecisionLog } from "../src/decisions/log.js";
import { decisionSchema } from "../src/schemas/decision.js";
import { findingSchema } from "../src/schemas/finding.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function finding(
  id: string,
  fingerprint = `${id}-fingerprint`,
  commit = "abc123",
) {
  return findingSchema.parse({
    id,
    fingerprint,
    createdAt: "2026-08-14T12:00:00.000Z",
    commit,
    flow: "booking",
    state: "ready",
    viewport: "mobile",
    layer: "deterministic",
    category: "missing-state",
    severity: "blocker",
    confidence: 1,
    rule: "idiom:tuple-failure:navigation",
    evidence: { screenshots: [] },
    explanation: "The state did not render.",
    acceptance: ["The state completes capture without a navigation failure."],
    verification: { kind: "deterministic-check", check: "missing-state" },
    status: "open",
  });
}

async function catalogFixture(findings = [finding("IDM-run-0001")]) {
  const directory = await mkdtemp(join(tmpdir(), "idiom-decision-cli-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  const runDirectory = join(directory, ".idiom", "reports", "run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "findings.json"),
    `${JSON.stringify(findings)}\n`,
  );
  return directory;
}

test("non-interactive decisions validate their full flag shape before append", async () => {
  const directory = await catalogFixture();
  const stderr: string[] = [];
  const invalid = [
    ["--finding", "IDM-run-0001"],
    ["--finding", "IDM-run-0001", "--accept", "--reject"],
    ["--accept"],
    ["--finding", "IDM-run-0001", "--accept", "--scope", "instance"],
    ["--finding", "IDM-run-0001", "--accept", "--scope", "rule"],
    ["--finding", "IDM-run-0001", "--reject", "--reason", "   "],
    ["--finding", "missing", "--reject"],
    ["--finding", "IDM-run-0001", "--reject", "--scope", "all"],
  ];
  for (const flags of invalid) {
    expect(
      await run(["node", "idiom", "decide", "--project", directory, ...flags], {
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
      }),
    ).toBe(1);
  }
  expect(stderr.join("\n")).toContain("--scope applies only to --reject");
  expect(await readDecisionLog(directory)).toEqual([]);

  const stdout: string[] = [];
  expect(
    await run(
      [
        "node",
        "idiom",
        "decide",
        "--project",
        directory,
        "--finding",
        "IDM-run-0001",
        "--accept",
        "--reason",
        " Worth fixing ",
      ],
      {
        stdout: (message) => stdout.push(message),
        stderr: () => undefined,
        decide: { now: () => new Date("2026-08-15T12:00:00.000Z") },
      },
    ),
  ).toBe(0);
  expect(stdout.join("")).toContain("1 accepted");
  expect(await readDecisionLog(directory)).toEqual([
    decisionSchema.parse({
      at: "2026-08-15T12:00:00.000Z",
      commit: "abc123",
      findingId: "finding-1",
      fingerprint: "IDM-run-0001-fingerprint",
      decision: "accept",
      scope: "instance",
      reason: "Worth fixing",
      actor: "human",
    }),
  ]);
});

test("interactive mode walks only newest undecided findings and supports skip and quit", async () => {
  const records = [
    finding("IDM-run-0001"),
    finding("IDM-run-0002"),
    finding("IDM-run-0003"),
    finding("IDM-run-0004"),
  ];
  const directory = await catalogFixture(records);
  const prompt = vi
    .fn()
    .mockResolvedValueOnce({ action: "accept", reason: "Worth fixing" })
    .mockResolvedValueOnce({ action: "reject", scope: "rule", reason: "Known" })
    .mockResolvedValueOnce({ action: "skip" })
    .mockResolvedValueOnce({ action: "quit" });
  const output: string[] = [];
  expect(
    await run(["node", "idiom", "decide", "--project", directory], {
      stdout: (message) => output.push(message),
      stderr: () => undefined,
      decide: { prompt, now: () => new Date("2026-08-15T12:00:00.000Z") },
    }),
  ).toBe(0);
  expect(prompt).toHaveBeenCalledTimes(4);
  expect(prompt.mock.calls.map(([record]) => record.finding.id)).toEqual([
    "finding-1",
    "finding-2",
    "finding-3",
    "finding-4",
  ]);
  expect(output.join("")).toContain("1 accepted, 1 rejected, 1 skipped");
  expect(
    (await readDecisionLog(directory)).map((decision) => decision.findingId),
  ).toEqual(["finding-1", "finding-2"]);
});

test("a scripted rule rejection round-trips through review suppression", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-suppression-cli-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  await writeFile(
    join(directory, ".idiom", "flows", "booking.json"),
    JSON.stringify({
      id: "booking",
      title: "Booking",
      intent: [],
      setup: [],
      viewports: ["mobile"],
      states: [{ id: "ready", description: "Ready", url: "/", expect: {} }],
    }),
  );
  const runId = "2026-08-14T12-00-00-000Z";
  const tuple = join(directory, ".idiom", "reports", runId, "ready", "mobile");
  await mkdir(tuple, { recursive: true });
  await writeFile(
    join(tuple, "metadata.json"),
    JSON.stringify({
      source: { commit: "abc123" },
      flow: { id: "booking" },
      state: { id: "ready" },
      viewport: { name: "mobile", width: 390, height: 844 },
      timestamps: { startedAt: "2026-08-14T12:00:00.000Z" },
      expectations: { mismatches: [] },
      failure: { stage: "navigation", message: "connection refused" },
    }),
  );
  const args = [
    "node",
    "idiom",
    "review",
    "booking",
    "--project",
    directory,
    "--from",
    runId,
  ];
  expect(
    await run(args, { stdout: () => undefined, stderr: () => undefined }),
  ).toBe(0);
  const path = join(directory, ".idiom", "reports", runId, "findings.json");
  const [produced] = JSON.parse(await readFile(path, "utf8"));
  expect(produced).toBeDefined();
  expect(
    await run(
      [
        "node",
        "idiom",
        "decide",
        "--project",
        directory,
        "--finding",
        produced.id,
        "--reject",
        "--scope",
        "rule",
        "--reason",
        "Expected in this environment",
      ],
      { stdout: () => undefined, stderr: () => undefined },
    ),
  ).toBe(0);
  const [decision] = await readDecisionLog(directory);
  expect(decisionSchema.parse(decision)).toMatchObject({
    scope: "rule",
    reason: "Expected in this environment",
  });
  expect(
    await run(args, { stdout: () => undefined, stderr: () => undefined }),
  ).toBe(0);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([]);
  expect(await readFile(join(dirname(path), "report.md"), "utf8")).toContain(
    "Suppressed by prior decision",
  );
});

test("an instance decision does not hide a re-observation on a later commit", async () => {
  const first = finding("IDM-run-0001", "stable-fingerprint", "abc123");
  const directory = await catalogFixture([first]);
  expect(
    await run(
      [
        "node",
        "idiom",
        "decide",
        "--project",
        directory,
        "--finding",
        first.id,
        "--reject",
        "--scope",
        "instance",
      ],
      { stdout: () => undefined, stderr: () => undefined },
    ),
  ).toBe(0);

  const second = finding("IDM-run-0001", "stable-fingerprint", "def456");
  const secondRun = join(directory, ".idiom", "reports", "run-2");
  await mkdir(secondRun, { recursive: true });
  await writeFile(
    join(secondRun, "findings.json"),
    `${JSON.stringify([second])}\n`,
  );
  const prompt = vi.fn().mockResolvedValue({ action: "skip" });
  expect(
    await run(["node", "idiom", "decide", "--project", directory], {
      stdout: () => undefined,
      stderr: () => undefined,
      decide: { prompt },
    }),
  ).toBe(0);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(prompt.mock.calls[0]?.[0].finding.commit).toBe("def456");
});

async function decide(
  directory: string,
  flags: string[],
  now = "2026-11-06T12:00:00.000Z",
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    ["node", "idiom", "decide", "--project", directory, ...flags],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      decide: { now: () => new Date(now) },
    },
  );
  return { code, out: stdout.join("\n"), err: stderr.join("\n") };
}

async function logLines(directory: string) {
  const source = await readFile(
    join(directory, ".idiom", "decisions.jsonl"),
    "utf8",
  ).catch(() => "");
  return source
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("--ack records an acknowledgement that is not a judgment, by positional or --finding", async () => {
  const directory = await catalogFixture();
  const acked = await decide(directory, [
    "IDM-run-0001",
    "--ack",
    " ABC-123 ",
    "--note",
    "Tracked in Jira",
    "--until",
    "2026-12-01",
  ]);
  expect(acked.code).toBe(0);
  expect(acked.out).toContain(
    "Acknowledged finding-1 for ABC-123 until 2026-12-01. It stays in reports and no longer counts toward --fail-on or as new",
  );
  expect(await logLines(directory)).toEqual([
    {
      at: "2026-11-06T12:00:00.000Z",
      commit: "abc123",
      findingId: "finding-1",
      fingerprint: "IDM-run-0001-fingerprint",
      decision: "acknowledge",
      reference: "ABC-123",
      until: "2026-12-01",
      note: "Tracked in Jira",
      evidence: {
        severity: "blocker",
        rule: "idiom:tuple-failure:navigation",
        category: "missing-state",
      },
      actor: "human",
    },
  ]);
  // Judgment readers never see it.
  expect(await readDecisionLog(directory)).toEqual([]);
  expect(
    (await decide(directory, ["--finding", "finding-1", "--ack", "ABC-124"]))
      .code,
  ).toBe(0);
  const conflict = await decide(directory, [
    "finding-1",
    "--finding",
    "finding-2",
    "--ack",
    "ABC-1",
  ]);
  expect(conflict.code).toBe(1);
  expect(conflict.err).toContain("disagree");
  expect(await logLines(directory)).toHaveLength(2);
});

test("acknowledgement flags validate their full shape before any append", async () => {
  const directory = await catalogFixture();
  const cases: Array<[string[], string]> = [
    [["finding-1", "--ack", "A-1", "--unack"], "only one of --ack or --unack"],
    [["finding-1", "--ack", "A-1", "--accept"], "records no judgment"],
    [["finding-1", "--ack", "A-1", "--reject"], "records no judgment"],
    [["finding-1", "--ack", "A-1", "--choose", "x"], "records no judgment"],
    [
      ["finding-1", "--ack", "A-1", "--scope", "rule"],
      "--scope does not apply",
    ],
    [
      ["finding-1", "--ack", "A-1", "--reason", "x"],
      "--ack records a note with --note, not --reason",
    ],
    [
      ["--group", "group-1", "--ack", "A-1"],
      "--ack applies to one --finding, not a --group",
    ],
    [["finding-1", "--note", "x"], "--note applies only to --ack"],
    [["finding-1", "--until", "2026-12-01"], "--until applies only to --ack"],
    [["finding-1", "--unack", "--note", "x"], "--note applies only to --ack"],
    [["finding-1", "--ack", "A-1", "--note", "  "], "--note must not be blank"],
    [["finding-1", "--ack", "   "], "--ack needs a reference"],
    [["finding-1", "--ack", "A\nB"], "single line"],
    [
      ["finding-1", "--ack", "A-1", "--until", "2026-02-30"],
      "--until expects a date",
    ],
    [
      ["finding-1", "--ack", "A-1", "--until", "2026-11-05"],
      "--until must be today or later (got 2026-11-05)",
    ],
    [["--ack", "A-1"], "--ack requires a finding id"],
    [["--list", "--ack", "A-1"], "--list cannot be combined"],
    [["finding-1", "--unack"], "finding-1 has no acknowledgement to remove"],
    [["missing", "--ack", "A-1"], "unknown finding id"],
  ];
  for (const [flags, message] of cases) {
    const result = await decide(directory, flags);
    expect(result.code, flags.join(" ")).toBe(1);
    expect(result.err, flags.join(" ")).toContain(message);
  }
  expect(await logLines(directory)).toEqual([]);
});

test("--unack removes an acknowledgement and --list shows its state", async () => {
  const directory = await catalogFixture();
  expect(
    (
      await decide(directory, [
        "finding-1",
        "--ack",
        "ABC-123",
        "--until",
        "2026-12-01",
      ])
    ).code,
  ).toBe(0);
  const active = await decide(directory, ["--list"]);
  expect(active.out).toContain(
    "  Acknowledgement: ABC-123 (active until 2026-12-01)",
  );
  expect(active.out).toContain("  Decision: none");
  const expired = await decide(
    directory,
    ["--list"],
    "2026-12-02T00:00:00.000Z",
  );
  expect(expired.out).toContain(
    "  Acknowledgement: ABC-123 (lapsed — finding-1 was acknowledged for ABC-123 until 2026-12-01, which has passed; it counts again.)",
  );
  const removed = await decide(directory, ["finding-1", "--unack"]);
  expect(removed.code).toBe(0);
  expect(removed.out).toContain(
    "Removed the acknowledgement on finding-1 (ABC-123); it counts again",
  );
  expect((await logLines(directory)).at(-1)).toMatchObject({
    decision: "unacknowledge",
    reference: "ABC-123",
  });
  expect((await decide(directory, ["--list"])).out).toContain(
    "(lapsed — finding-1 was acknowledged for ABC-123 and unacknowledged on 2026-11-06; it counts again.)",
  );
  // A second removal has nothing to remove.
  expect((await decide(directory, ["finding-1", "--unack"])).err).toContain(
    "has no acknowledgement to remove",
  );
});

test("--list without acknowledgements prints no acknowledgement line", async () => {
  const directory = await catalogFixture();
  expect((await decide(directory, ["--list"])).out).not.toContain(
    "Acknowledgement:",
  );
});
