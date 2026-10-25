import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import {
  appendDecision,
  decisionViews,
  isFingerprintSuppressed,
  readDecisionLog,
} from "../src/decisions/log.js";
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
