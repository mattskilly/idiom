import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { learnCommand } from "../src/commands/learn.js";
import { learnCoveredCommand } from "../src/commands/learn-misses.js";
import {
  appendDecision,
  knownDecisionTypes,
  readAcknowledgements,
  readDecisionLog,
  readDecisionLogEntries,
} from "../src/decisions/log.js";
import { readDecisions } from "../src/decisions/read.js";
import { readLearnedLog } from "../src/learn/misses.js";
import { withRecordNotes } from "../src/records/unknown.js";
import {
  acknowledgementSchema,
  attributionCorrectionSchema,
  decisionSchema,
  rulingDecisionSchema,
} from "../src/schemas/decision.js";
import { findingSchema } from "../src/schemas/finding.js";
import { studioProject } from "./stored-run-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const at = "2026-11-06T12:00:00.000Z";
const accept = {
  at,
  commit: "abc123",
  findingId: "finding-1",
  fingerprint: "fp-1",
  decision: "accept",
  scope: "instance",
  actor: "human",
};
const acknowledge = {
  at,
  commit: "abc123",
  findingId: "finding-2",
  fingerprint: "fp-2",
  decision: "acknowledge",
  reference: "ABC-1",
  evidence: { severity: "major", category: "contrast" },
  actor: "human",
};
const reject = { ...accept, findingId: "finding-3", decision: "reject" };
const escalate = { ...accept, decision: "escalate", owner: "design" };
const defer = { ...accept, findingId: "finding-9", decision: "defer" };

const learned = {
  version: 1,
  id: "learned-1",
  recordedAt: at,
  flow: "studio-lab",
  state: "editor",
  observation: "the dots should be 8px",
  kind: "component",
  target: { file: ".idiom/project.json", selector: ".dot" },
  entry: { width: 8, height: 8 },
};
const motion = { ...learned, id: "learned-2", kind: "motion", extra: true };

async function temp() {
  const project = await mkdtemp(join(tmpdir(), "idiom-records-"));
  directories.push(project);
  await mkdir(join(project, ".idiom"));
  return project;
}

const jsonl = (records: unknown[]) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

async function decisionsFile(project: string, content: string) {
  await writeFile(join(project, ".idiom", "decisions.jsonl"), content);
}
async function learnedFile(project: string, content: string) {
  await writeFile(join(project, ".idiom", "learned.jsonl"), content);
}

async function collect<T>(read: () => Promise<T>) {
  const notes: string[] = [];
  const result = await withRecordNotes(read, (line) => notes.push(line));
  return { result, notes };
}

const decisionNote = (count: number, types: string) =>
  `Skipped ${count} decision record${count === 1 ? "" : "s"} written by a newer Idiom (types: ${types}). Upgrade to use them.`;

test("the known decision types are exactly the schema's", () => {
  expect([...knownDecisionTypes].sort()).toEqual(
    [
      rulingDecisionSchema.shape.decision.value,
      attributionCorrectionSchema.shape.decision.value,
      ...decisionSchema.shape.decision.options,
      ...acknowledgementSchema.shape.decision.options,
    ].sort(),
  );
});

test("every decision reader skips unknown types, keeps known lines in order, and notes once", async () => {
  const project = await temp();
  await decisionsFile(
    project,
    jsonl([escalate, accept, escalate, acknowledge, defer, reject]),
  );
  const readers = {
    entries: () => readDecisionLogEntries(project),
    judgments: () => readDecisionLog(project),
    acknowledgements: () => readAcknowledgements(project),
    context: () => readDecisions(project),
  };
  const expected = {
    entries: ["accept", "acknowledge", "reject"],
    judgments: ["accept", "reject"],
    acknowledgements: ["acknowledge"],
    context: ["accept", "reject"],
  };
  for (const [name, read] of Object.entries(readers)) {
    const { result, notes } = await collect(read);
    expect(result.map((entry) => entry.decision)).toEqual(
      expected[name as keyof typeof expected],
    );
    expect(notes).toEqual([decisionNote(3, "defer, escalate")]);
  }
  // Several reads in one command are still one note with the same count.
  const twice = await collect(async () => {
    await readDecisionLog(project);
    await readDecisions(project);
    return readAcknowledgements(project);
  });
  expect(twice.notes).toEqual([decisionNote(3, "defer, escalate")]);
});

test("the learned reader skips unknown kinds in strict and lenient modes", async () => {
  const project = await temp();
  await learnedFile(
    project,
    jsonl([learned, motion, { ...learned, id: "learned-3" }]),
  );
  for (const strict of [true, false]) {
    const { result, notes } = await collect(() =>
      readLearnedLog(project, { strict }),
    );
    expect(result.map((entry) => entry.id)).toEqual(["learned-1", "learned-3"]);
    expect(notes).toEqual([
      "Skipped 1 learned record written by a newer Idiom (types: motion). Upgrade to use them.",
    ]);
  }
});

test("two families make two notes, decisions first", async () => {
  const project = await temp();
  await decisionsFile(project, jsonl([defer]));
  await learnedFile(project, jsonl([motion]));
  const { notes } = await collect(async () => {
    await readLearnedLog(project);
    return readDecisionLog(project);
  });
  expect(notes).toEqual([
    decisionNote(1, "defer"),
    "Skipped 1 learned record written by a newer Idiom (types: motion). Upgrade to use them.",
  ]);
});

test("malformed lines, invalid known types and missing identity still fail", async () => {
  const project = await temp();
  const { fingerprint: _, ...anonymous } = escalate;
  const failing = [
    ["not json", "line 2"],
    [JSON.stringify({ ...accept, scope: "galaxy" }), "scope"],
    [JSON.stringify(anonymous), "line 2"],
    [JSON.stringify({ ...accept, decision: 7 }), "line 2"],
    [JSON.stringify([escalate]), "line 2"],
  ] as const;
  for (const [line, message] of failing) {
    await decisionsFile(project, `${JSON.stringify(accept)}\n${line}\n`);
    await expect(readDecisionLogEntries(project)).rejects.toThrow(message);
    await expect(readDecisions(project)).rejects.toThrow(
      ".idiom/decisions.jsonl:2",
    );
  }
  for (const line of [
    "not json",
    JSON.stringify({ ...motion, version: 2 }),
    JSON.stringify({ ...motion, id: "motion-1" }),
    JSON.stringify({ ...learned, target: 7 }),
  ]) {
    await learnedFile(project, `${JSON.stringify(learned)}\n${line}\n`);
    await expect(readLearnedLog(project, { strict: true })).rejects.toThrow(
      "invalid .idiom/learned.jsonl line 2",
    );
    expect(await readLearnedLog(project)).toHaveLength(1);
  }
});

function finding(id: string) {
  return findingSchema.parse({
    id,
    fingerprint: `${id}-fingerprint`,
    createdAt: at,
    commit: "abc123",
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

async function catalog() {
  const project = await mkdtemp(join(tmpdir(), "idiom-records-cli-"));
  directories.push(project);
  await initProject({ project, yes: true });
  const runDirectory = join(project, ".idiom", "reports", "run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "findings.json"),
    `${JSON.stringify([finding("IDM-run-0001"), finding("IDM-run-0002")])}\n`,
  );
  return project;
}

async function decide(project: string, flags: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    ["node", "idiom", "decide", "--project", project, ...flags],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      decide: { now: () => new Date(at) },
    },
  );
  return { code, out: stdout.join(""), err: stderr };
}

// Unknown lines, one with CRLF and the last without a trailing newline.
const seeded = `${JSON.stringify(escalate)}\r\n${JSON.stringify({ ...accept, findingId: "finding-7" })}\n${JSON.stringify(defer)}`;

test("every decision-writing command keeps skipped lines byte for byte", async () => {
  const project = await catalog();
  const path = join(project, ".idiom", "decisions.jsonl");
  await decisionsFile(project, seeded);
  const writes = [
    ["IDM-run-0001", "--accept"],
    [
      "--finding",
      "IDM-run-0002",
      "--reject",
      "--scope",
      "rule",
      "--reason",
      "x",
    ],
    ["IDM-run-0001", "--ack", "ABC-9"],
    ["IDM-run-0001", "--unack"],
  ];
  let before = await readFile(path, "utf8");
  for (const flags of writes) {
    const result = await decide(project, flags);
    expect(result.code, result.err.join("")).toBe(0);
    expect(result.err.join("\n")).toContain(decisionNote(2, "defer, escalate"));
    const after = await readFile(path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
    before = after;
  }
  expect(before.startsWith(seeded)).toBe(true);
  await withRecordNotes(
    () =>
      appendDecision({
        projectDirectory: project,
        finding: finding("IDM-run-0001"),
        decision: "accept",
        scope: "instance",
        designChoice: {
          flow: "booking",
          state: "ready",
          decisionKey: "palette",
          reference: "design/a.png",
        },
      }),
    () => undefined,
  );
  expect((await readFile(path, "utf8")).startsWith(before)).toBe(true);
  // Re-running init leaves the log alone.
  await initProject({ project, yes: true });
  expect((await readFile(path, "utf8")).startsWith(before)).toBe(true);
  expect((await readDecisionLogEntries(project)).length).toBe(6);
});

test("a read-only command prints the exact note once and keeps its exit code", async () => {
  const project = await catalog();
  await decisionsFile(project, jsonl([escalate, accept, escalate, defer]));
  const listed = await decide(project, ["--list"]);
  expect(listed.code).toBe(0);
  expect(
    listed.err.filter((line) => line.includes("written by a newer Idiom")),
  ).toEqual([`${decisionNote(3, "defer, escalate")}\n`]);
  // A failing command still notes the skip, after its error.
  const failed = await decide(project, ["--finding", "missing", "--reject"]);
  expect(failed.code).toBe(1);
  expect(failed.err.at(-1)).toBe(`${decisionNote(3, "defer, escalate")}\n`);
});

test("learn and learn --covered keep skipped learned lines byte for byte", async () => {
  const { project } = await studioProject(directories);
  const path = join(project, ".idiom", "learned.jsonl");
  const unknown = JSON.stringify(motion);
  const seededLearned = `${JSON.stringify(learned)}\r\n${unknown}\n${JSON.stringify({ ...learned, id: "learned-3" })}`;
  await learnedFile(project, seededLearned);
  const result = await withRecordNotes(
    () =>
      learnCommand({
        project,
        state: "editor",
        observation: "the pills should be 8px",
        selectors: [".pill"],
        yes: true,
      }),
    () => undefined,
  );
  expect(result).toMatchObject({ id: "learned-4" });
  const afterLearn = await readFile(path, "utf8");
  expect(afterLearn.startsWith(seededLearned)).toBe(true);

  await learnCoveredCommand({ project, id: "learned-3", by: "fixtures/dots" });
  const before = afterLearn.split("\n");
  const after = (await readFile(path, "utf8")).split("\n");
  expect(after).toHaveLength(before.length);
  for (const [index, line] of after.entries())
    if (index !== 2) expect(line).toBe(before[index]);
  expect(JSON.parse(after[2] ?? "")).toMatchObject({
    id: "learned-3",
    covered: { by: "fixtures/dots" },
  });
  await expect(
    learnCoveredCommand({ project, id: "learned-2", by: "x" }),
  ).rejects.toThrow("learned-2 was written by a newer Idiom");
});
