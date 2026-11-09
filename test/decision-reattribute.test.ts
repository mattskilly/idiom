import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readGit } from "../src/changed/git.js";
import { run } from "../src/cli.js";
import { decideCommand } from "../src/commands/decide.js";
import { resolveAcknowledgement } from "../src/decisions/acknowledgements.js";
import { lineHash } from "../src/decisions/attribution.js";
import {
  readAcknowledgements,
  readDecisionLog,
  readDecisionLogEntries,
  readRawDecisionLog,
  ruleRejection,
} from "../src/decisions/log.js";
import { readDecisions } from "../src/decisions/read.js";
import { reattributeDecisions } from "../src/decisions/reattribute.js";
import {
  attributionCorrectionSchema,
  decisionSchema,
} from "../src/schemas/decision.js";
import { findingSchema } from "../src/schemas/finding.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(git = true) {
  const root = await mkdtemp(join(tmpdir(), "idiom-reattribute-"));
  directories.push(root);
  await mkdir(join(root, ".idiom"));
  // No valid project config or stored reports are necessary for correction mode.
  await writeFile(join(root, ".idiom/project.json"), "{}");
  const commits: string[] = [];
  if (git) {
    await readGit(root, ["init", "-q"]);
    for (let index = 0; index < 3; index++) {
      await readGit(root, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        `commit ${index}`,
      ]);
      commits.push((await readGit(root, ["rev-parse", "HEAD"])).trim());
    }
  }
  return { root, commits, path: join(root, ".idiom/decisions.jsonl") };
}
const original = (commit: string, decision = "accept") => ({
  at: "2026-08-14T12:00:00.000Z",
  commit,
  findingId: "one",
  fingerprint: "shared",
  decision,
  scope: "rule",
  actor: "human",
});

test("real observed-commit range: exclusive from, inclusive to, abbreviations, duplicates and byte-preserving idempotency", async () => {
  const f = await fixture();
  const [from, middle, to] = f.commits as [string, string, string];
  const first = original(middle);
  const last = original(to, "reject");
  const future = { ...original(to), decision: "future-kind" };
  const bytes = [
    JSON.stringify(original(from)),
    "",
    JSON.stringify(future),
    JSON.stringify(first),
    JSON.stringify(first),
    JSON.stringify(last),
    JSON.stringify(original(middle.slice(0, 8))),
    JSON.stringify(original("unknown")),
  ].join("\r\n");
  await writeFile(f.path, bytes);
  const options = {
    projectDirectory: f.root,
    range: `${from}..${to}`,
    actor: "agent" as const,
    note: "historical build",
  };
  expect(await reattributeDecisions(options)).toMatchObject({ corrected: 4 });
  const after = await readFile(f.path, "utf8");
  expect(after.startsWith(bytes)).toBe(true);
  const raw = await readRawDecisionLog(f.root);
  expect(
    raw
      .filter((entry) => entry.record.decision === "reattribute")
      .map(
        (entry) =>
          entry.record.decision === "reattribute" && entry.record.target.line,
      ),
  ).toEqual([4, 5, 6, 7]);
  const effective = await readDecisionLog(f.root);
  expect(effective.map((entry) => entry.actor)).toEqual([
    "human",
    "agent",
    "agent",
    "agent",
    "agent",
    "human",
  ]);
  expect(effective.map((entry) => entry.decision)).toEqual([
    "accept",
    "accept",
    "accept",
    "reject",
    "accept",
    "accept",
  ]);
  expect(await readDecisions(f.root)).toEqual(effective);
  expect(await reattributeDecisions(options)).toMatchObject({ corrected: 0 });
  expect(await readFile(f.path, "utf8")).toBe(after);
  expect(
    await reattributeDecisions({ ...options, actor: "human" }),
  ).toMatchObject({ corrected: 4 });
  expect(
    (await readDecisionLog(f.root)).every(
      (entry) => entry.actor === "human" && entry.agent === undefined,
    ),
  ).toBe(true);
  // Correct only the old acceptance; its position must not defeat a newer rejection.
  await writeFile(
    f.path,
    `${JSON.stringify(first)}\n${JSON.stringify(last)}\n`,
  );
  await reattributeDecisions({ ...options, range: `${from}..${middle}` });
  const ordered = await readDecisionLog(f.root);
  expect(ruleRejection(["shared"], ordered)?.decision).toBe("reject");
  expect(ordered.map((entry) => entry.actor)).toEqual(["agent", "human"]);
});

test("corrections validate physical line, hash, identity and ordinary-earlier targets before append", async () => {
  const f = await fixture();
  const [from, to] = f.commits as [string, string];
  const line = JSON.stringify(original(to));
  const correction = {
    at: "2026-11-07T12:00:00.000Z",
    commit: to,
    findingId: "one",
    fingerprint: "shared",
    decision: "reattribute",
    target: { line: 1, sha256: lineHash(line) },
    actor: "agent",
    note: "fix",
  };
  for (const changed of [
    { ...correction, target: { ...correction.target, line: 2 } },
    { ...correction, target: { ...correction.target, sha256: "0".repeat(64) } },
    { ...correction, commit: from },
    { ...correction, findingId: "wrong" },
    { ...correction, fingerprint: "wrong" },
    { ...correction, note: " " },
    { ...correction, actor: "robot" },
  ]) {
    const bytes = `${line}\n${JSON.stringify(changed)}\n`;
    await writeFile(f.path, bytes);
    await expect(
      reattributeDecisions({
        projectDirectory: f.root,
        range: `${from}..${to}`,
        actor: "agent",
        note: "fix",
      }),
    ).rejects.toThrow(/line 2/);
    await expect(readDecisions(f.root)).rejects.toThrow(/decisions.jsonl:2/);
    expect(await readFile(f.path, "utf8")).toBe(bytes);
  }
  await writeFile(
    f.path,
    `${line}\n${JSON.stringify(correction)}\n${JSON.stringify({ ...correction, target: { line: 2, sha256: lineHash(JSON.stringify(correction)) } })}\n`,
  );
  await expect(readDecisionLogEntries(f.root)).rejects.toThrow(/line 3/);
  await writeFile(f.path, `${line}\n{broken`);
  await expect(
    reattributeDecisions({
      projectDirectory: f.root,
      range: `${from}..${to}`,
      actor: "agent",
      note: "fix",
    }),
  ).rejects.toThrow(/line 2/);
});

test("last correction wins and clears agent label, while choices and acknowledgement expiry keep original semantics", async () => {
  const f = await fixture();
  const [from, to] = f.commits as [string, string];
  const choice = {
    ...original(to),
    scope: "instance",
    designChoice: {
      flow: "shop",
      state: "cart",
      decisionKey: "radius",
      reference: "prototype",
    },
  };
  const ack = {
    ...original(to),
    scope: undefined,
    decision: "acknowledge",
    reference: "BUG-1",
    until: "2026-10-01",
    evidence: { severity: "major", category: "target-size" },
  };
  await writeFile(
    f.path,
    [choice, ack].map((entry) => JSON.stringify(entry)).join("\n"),
  );
  const options = {
    projectDirectory: f.root,
    range: `${from}..${to}`,
    actor: "agent" as const,
    note: "fix",
  };
  expect((await reattributeDecisions(options)).corrected).toBe(2);
  expect((await readDecisionLog(f.root))[0]?.designChoice).toEqual(
    choice.designChoice,
  );
  const entries = await readAcknowledgements(f.root);
  const finding = findingSchema.parse({
    id: "one",
    fingerprint: "shared",
    commit: to,
    createdAt: choice.at,
    flow: "shop",
    state: "cart",
    viewport: "phone",
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    evidence: { screenshots: [] },
    explanation: "small",
    acceptance: [],
    verification: { kind: "deterministic-check", check: "target-size" },
    status: "open",
  });
  expect(
    await resolveAcknowledgement({
      target: { id: "one", ids: ["one"], fingerprints: ["shared"] },
      finding,
      entries,
      ticketState: async () => undefined,
      now: new Date("2026-11-07T12:00:00Z"),
    }),
  ).toMatchObject({ kind: "lapsed", lapse: { reason: "expired" } });
  const raw = await readRawDecisionLog(f.root);
  const target = raw[0];
  if (!target) throw new Error("missing original");
  const correction = attributionCorrectionSchema.parse({
    at: choice.at,
    commit: to,
    findingId: "one",
    fingerprint: "shared",
    decision: "reattribute",
    target: target.source,
    actor: "agent",
    agent: "old-build",
    note: "identified",
  });
  await writeFile(
    f.path,
    `${await readFile(f.path, "utf8")}${JSON.stringify(correction)}\n`,
  );
  expect((await readDecisionLog(f.root))[0]?.agent).toBe("old-build");
  await reattributeDecisions({ ...options, actor: "human" });
  expect((await readDecisionLog(f.root))[0]).toMatchObject({
    actor: "human",
    designChoice: choice.designChoice,
  });
  expect((await readDecisionLog(f.root))[0]?.agent).toBeUndefined();
});

test("invalid/non-Git/empty ranges fail without writing, valid zero matches return zero", async () => {
  const f = await fixture();
  const [from, to] = f.commits as [string, string];
  await writeFile(f.path, JSON.stringify(original(from)));
  const options = {
    projectDirectory: f.root,
    actor: "agent" as const,
    note: "fix",
  };
  for (const range of [
    "HEAD",
    "..HEAD",
    "HEAD..",
    "HEAD...HEAD",
    "a..b..c",
    "missing..HEAD",
    "--help..HEAD",
  ])
    await expect(reattributeDecisions({ ...options, range })).rejects.toThrow();
  expect(
    (await reattributeDecisions({ ...options, range: `${from}..${to}` }))
      .corrected,
  ).toBe(0);
  const nonGit = await fixture(false);
  await expect(
    reattributeDecisions({
      ...options,
      projectDirectory: nonGit.root,
      range: "HEAD~1..HEAD",
    }),
  ).rejects.toThrow(/Git project/);
});

test("standalone CLI mode validates requirements and every conflicting flag before reading reports", async () => {
  const f = await fixture();
  const [from, to] = f.commits as [string, string];
  const options = {
    project: f.root,
    reattribute: `${from}..${to}`,
    actor: "agent" as const,
    note: "fix",
  };
  await expect(decideCommand({ ...options, actor: undefined })).rejects.toThrow(
    /explicit --actor/,
  );
  await expect(decideCommand({ ...options, note: " " })).rejects.toThrow(
    /nonblank --note/,
  );
  for (const conflict of [
    { finding: "one" },
    { group: "g" },
    { accept: true },
    { reject: true },
    { choose: "p" },
    { scope: "rule" as const },
    { pending: true },
    { list: true },
    { decision: "r" },
    { build: "b" },
    { escalation: "e" },
    { reason: "r" },
    { ack: "x" },
    { unack: true },
    { until: "2026-12-01" },
    { candidate: 1 },
    { wording: "x" },
    { noRule: true },
    { addStep: true },
    { token: "x" },
    { drift: true },
  ])
    await expect(decideCommand({ ...options, ...conflict })).rejects.toThrow(
      /cannot be combined/,
    );
  const out: string[] = [];
  expect(
    await run(
      [
        "node",
        "idiom",
        "--project",
        f.root,
        "decide",
        "--reattribute",
        `${from}..${to}`,
        "--actor",
        "agent",
        "--note",
        "fix",
      ],
      { stdout: (s) => out.push(s), stderr: (s) => out.push(s) },
    ),
  ).toBe(0);
  expect(out.join("\n")).toContain("0 corrected");
  expect(
    decisionSchema.parse({ ...original(to), actor: "legacy-robot" }).actor,
  ).toBe("legacy-robot");
  expect(
    decisionSchema.parse({ ...original(to), actor: undefined }).actor,
  ).toBe("human");
});
