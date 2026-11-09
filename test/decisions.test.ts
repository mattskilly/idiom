import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import {
  appendAcknowledgement,
  appendDecision,
  decisionViews,
  isFingerprintSuppressed,
  readAcknowledgements,
  readDecisionLog,
  readDecisionLogEntries,
  ruleRejection,
} from "../src/decisions/log.js";
import { readDecisions } from "../src/decisions/read.js";
import { fileFormats } from "../src/interface/surfaces.js";
import { lineageDecision } from "../src/review/lifecycle.js";
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

function finding(id = "IDM-run-0001", fingerprint = "fingerprint") {
  return findingSchema.parse({
    id,
    fingerprint,
    createdAt: "2026-08-14T12:00:00.000Z",
    commit: "abc123",
    flow: "booking",
    state: "ready",
    viewport: "phone",
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    rule: "idiom:target-size",
    evidence: { screenshots: [] },
    explanation: "The target is too small.",
    acceptance: ["The target is at least 44 by 44 CSS pixels."],
    verification: { kind: "deterministic-check", check: "target-size" },
    status: "open",
  });
}

async function project() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-decisions-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  return directory;
}

test("decision log appends schema-valid records without rewriting earlier bytes", async () => {
  const directory = await project();
  const path = join(directory, ".idiom", "decisions.jsonl");
  const first = decisionSchema.parse({
    at: "2026-08-14T12:00:00.000Z",
    commit: "old",
    findingId: "IDM-old-0001",
    fingerprint: "old-fingerprint",
    decision: "reject",
    scope: "instance",
    actor: "human",
  });
  const original = JSON.stringify(first);
  await writeFile(path, original);
  const appended = await appendDecision({
    attribution: { actor: "human" },
    projectDirectory: directory,
    finding: finding(),
    decision: "accept",
    scope: "instance",
    reason: "Ship the repair",
    now: () => new Date("2026-08-15T10:30:00.000Z"),
  });
  expect((await readFile(path, "utf8")).startsWith(original)).toBe(true);
  expect(appended.record).toEqual(
    decisionSchema.parse({
      at: "2026-08-15T10:30:00.000Z",
      commit: "abc123",
      findingId: "IDM-run-0001",
      fingerprint: "fingerprint",
      decision: "accept",
      scope: "instance",
      reason: "Ship the repair",
      actor: "human",
    }),
  );
  expect(await readDecisionLog(directory)).toEqual([first, appended.record]);
});

test("latest decision views separate finding judgment from standing rule memory", () => {
  const records = [
    {
      at: "2026-08-14T12:00:00.000Z",
      commit: "a",
      findingId: "one",
      fingerprint: "shared",
      decision: "reject",
      scope: "rule",
      actor: "human",
    },
    {
      at: "2026-08-14T13:00:00.000Z",
      commit: "b",
      findingId: "two",
      fingerprint: "shared",
      decision: "accept",
      scope: "rule",
      actor: "human",
    },
    {
      at: "2026-08-14T14:00:00.000Z",
      commit: "c",
      findingId: "one",
      fingerprint: "other",
      decision: "accept",
      scope: "instance",
      actor: "human",
    },
  ].map((record) => decisionSchema.parse(record));
  const views = decisionViews(records);
  expect(views.byFindingId.get("one")).toEqual(records[2]);
  expect(views.byFindingId.get("two")).toEqual(records[1]);
  expect(isFingerprintSuppressed("shared", views)).toBe(false);
  expect(views.ruleDecisions).toEqual([records[0], records[1]]);
  expect(
    isFingerprintSuppressed("shared", decisionViews(records.slice(0, 1))),
  ).toBe(true);
});

test("ruleRejection returns the latest rule rejection across identities", () => {
  const record = (
    fingerprint: string,
    decision: "accept" | "reject",
    scope: "instance" | "rule",
    at: string,
  ) =>
    decisionSchema.parse({
      at,
      commit: "a",
      findingId: "one",
      fingerprint,
      decision,
      scope,
      actor: "human",
    });
  const reject = record("fp", "reject", "rule", "2026-08-14T12:00:00.000Z");
  const accept = record("fp", "accept", "rule", "2026-08-14T13:00:00.000Z");
  const laterReject = record(
    "fp",
    "reject",
    "rule",
    "2026-08-14T14:00:00.000Z",
  );

  expect(ruleRejection(["fp"], [reject])).toBe(reject);
  expect(ruleRejection(["fp"], [])).toBeUndefined();
  expect(
    ruleRejection(
      ["fp"],
      [record("fp", "reject", "instance", "2026-08-14T12:00:00.000Z")],
    ),
  ).toBeUndefined();
  expect(ruleRejection(["fp"], [reject, accept])).toBeUndefined();
  expect(ruleRejection(["fp"], [accept, laterReject])).toBe(laterReject);
  expect(ruleRejection(["other"], [reject])).toBeUndefined();

  const aliasReject = record(
    "alias",
    "reject",
    "rule",
    "2026-08-14T15:00:00.000Z",
  );
  expect(ruleRejection(["fp", "alias"], [reject, accept, aliasReject])).toBe(
    aliasReject,
  );
  const aliasAccept = record(
    "alias",
    "accept",
    "rule",
    "2026-08-14T15:00:00.000Z",
  );
  expect(
    ruleRejection(["fp", "alias"], [laterReject, aliasAccept]),
  ).toBeUndefined();
});

test("malformed logs are line-numbered and cannot be extended", async () => {
  const directory = await project();
  const path = join(directory, ".idiom", "decisions.jsonl");
  await writeFile(path, '{"decision":"reject"}\nnot-json\n');
  await expect(readDecisionLog(directory)).rejects.toThrow(/line 1/);
  await expect(
    appendDecision({
      projectDirectory: directory,
      finding: finding(),
      decision: "reject",
      scope: "rule",
    }),
  ).rejects.toThrow(/line 1/);
  expect(await readFile(path, "utf8")).toBe(
    '{"decision":"reject"}\nnot-json\n',
  );
});

test("acknowledgement lines round-trip, and judgment readers return judgments only", async () => {
  const directory = await project();
  const judged = await appendDecision({
    attribution: { actor: "human" },
    projectDirectory: directory,
    finding: finding("finding-2", "other"),
    decision: "reject",
    scope: "instance",
    now: () => new Date("2026-11-06T10:00:00.000Z"),
  });
  const acknowledged = await appendAcknowledgement({
    attribution: { actor: "human" },
    projectDirectory: directory,
    finding: { ...finding(), id: "finding-1" },
    kind: "acknowledge",
    reference: "ABC-123",
    note: "Tracked in Jira",
    evidence: {
      severity: "major",
      rule: "idiom:target-size",
      category: "target-size",
    },
    now: () => new Date("2026-11-06T11:00:00.000Z"),
  });
  const removed = await appendAcknowledgement({
    attribution: { actor: "human" },
    projectDirectory: directory,
    finding: { ...finding(), id: "finding-1" },
    kind: "unacknowledge",
    reference: "ABC-123",
    now: () => new Date("2026-11-06T12:00:00.000Z"),
  });
  expect(await readDecisionLogEntries(directory)).toEqual([
    judged.record,
    acknowledged.record,
    removed.record,
  ]);
  expect(await readDecisionLog(directory)).toEqual([judged.record]);
  expect(await readDecisions(directory)).toEqual([judged.record]);
  expect(await readAcknowledgements(directory)).toEqual([
    acknowledged.record,
    removed.record,
  ]);
  // A lineage with only an acknowledgement has no judgment.
  expect(
    lineageDecision(
      {
        ids: ["finding-1"],
        fingerprints: ["fingerprint"],
      } as Parameters<typeof lineageDecision>[0],
      await readDecisionLog(directory),
    ),
  ).toBeUndefined();
  const surface = fileFormats.find((candidate) => candidate.id === "decisions");
  expect(surface?.schema?.safeParse(judged.record).success).toBe(true);
  expect(surface?.schema?.safeParse(acknowledged.record).success).toBe(true);
});

test("malformed acknowledgement lines are line-numbered by their own shape", async () => {
  const directory = await project();
  const path = join(directory, ".idiom", "decisions.jsonl");
  const base = {
    at: "2026-11-06T12:00:00.000Z",
    commit: "abc123",
    findingId: "finding-1",
    fingerprint: "fingerprint",
    actor: "human",
  };
  for (const [line, message] of [
    [
      {
        ...base,
        decision: "acknowledge",
        evidence: { severity: "major", category: "contrast" },
      },
      "reference",
    ],
    [{ ...base, decision: "acknowledge", reference: "ABC-1" }, "evidence"],
    [
      {
        ...base,
        decision: "acknowledge",
        reference: "ABC-1",
        until: "2026-02-30",
        evidence: { severity: "major", category: "contrast" },
      },
      "until",
    ],
  ] as const) {
    await writeFile(path, `${JSON.stringify(line)}\n`);
    await expect(readDecisionLog(directory)).rejects.toThrow(
      new RegExp(`line 1: .*${message}`),
    );
    await expect(readDecisions(directory)).rejects.toThrow(
      new RegExp(`decisions.jsonl:1: .*${message}`),
    );
  }
});
