import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import {
  appendDecision,
  appendDecisionBatch,
  readDecisionLog,
  readDecisionLogEntries,
  readRawDecisionLog,
} from "../src/decisions/log.js";
import { pendingDecisions, pendingForRun } from "../src/decisions/pending.js";
import { decisionQuestion } from "../src/decisions/question.js";
import { readDecisions } from "../src/decisions/read.js";
import { rulingAnswer } from "../src/rulings/answer.js";
import { writeUnruledDecisions } from "../src/rulings/artifacts.js";
import { readEffectiveLaw } from "../src/rulings/effective.js";
import { appendRuling } from "../src/rulings/law.js";
import {
  referenceQuestion,
  unruledQuestion,
} from "./decision-escalation-support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "idiom-escalation-"));
  roots.push(root);
  await initProject({ project: root, yes: true });
  const runDirectory = join(root, ".idiom/reports/run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "findings.json"),
    JSON.stringify([referenceQuestion()]),
  );
  await writeUnruledDecisions(runDirectory, [unruledQuestion()]);
  return {
    root,
    runDirectory,
    options: {
      projectDirectory: root,
      designPath: join(root, "DESIGN.md"),
      runDirectory,
      flow: "site",
      findings: [referenceQuestion()],
      unruledDecisionsPath: join(runDirectory, "unruled-decisions.json"),
    },
  };
}
async function cli(root: string, flags: string[]) {
  const out: string[] = [],
    err: string[] = [];
  const status = await run(
    ["node", "idiom", "--project", root, "decide", ...flags],
    { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
  );
  return { status, out: out.join("\n"), err: err.join("\n") };
}

test("only explicit sources project, with crops, citations, coordinates and safe commands", async () => {
  const f = await fixture();
  const findings = [
    referenceQuestion(),
    { ...referenceQuestion(), id: "finding-phone", viewport: "phone" },
    { ...referenceQuestion(), colorScheme: "dark" as const },
  ];
  const questions = await pendingForRun({ ...f.options, findings });
  expect(questions.map((q) => q.kind)).toEqual([
    "reference-conflict",
    "reference-conflict",
    "unruled",
  ]);
  expect(questions[0]?.coordinates).toHaveLength(2);
  expect(questions[0]?.findingIds).toEqual(["finding-1", "finding-phone"]);
  expect(questions[0]?.evidence).toContain(
    join(f.runDirectory, "crops/card.png"),
  );
  expect(questions[2]?.evidence).toContain(
    join(f.runDirectory, "ready/wide/screenshot.png"),
  );
  const plain = {
    ...referenceQuestion(),
    evidence: { screenshots: [] },
    category: "brief-mismatch" as const,
  };
  const ordinary = { ...referenceQuestion(), rule: "idiom:design-drift" };
  expect(
    await pendingForRun({
      ...f.options,
      findings: [plain, ordinary],
      unruledDecisionsPath: undefined,
    }),
  ).toEqual([]);
  const drift = referenceQuestion().evidence.designDrift;
  if (!drift) throw new Error("missing fixture evidence");
  const missingCrop = await pendingForRun({
    ...f.options,
    findings: [
      {
        ...referenceQuestion(),
        evidence: {
          ...referenceQuestion().evidence,
          designDrift: {
            ...drift,
            crops: [],
          },
        },
      },
    ],
    unruledDecisionsPath: undefined,
  });
  expect(missingCrop[0]?.missingCropEvidence).toBe(true);
  expect(decisionQuestion(missingCrop)).toContain("Crop evidence: unavailable");
});

test("pending listing is read-only, supports legacy missing files, and rejects malformed present artifacts", async () => {
  const f = await fixture();
  const before = await readFile(join(f.root, ".idiom/decisions.jsonl"), "utf8");
  const response = await cli(f.root, ["--pending", "--json"]);
  expect(response.status, response.err).toBe(0);
  expect(JSON.parse(response.out)).toMatchObject({
    interfaceVersion: 1,
    decisionNeeded: [{ kind: "reference-conflict" }, { kind: "unruled" }],
  });
  expect(await readFile(join(f.root, ".idiom/decisions.jsonl"), "utf8")).toBe(
    before,
  );
  for (const flags of [
    ["--pending", "--list"],
    ["--pending", "--reason", "why"],
    ["--pending", "--build", "x"],
    ["--pending", "--accept"],
  ])
    expect((await cli(f.root, flags)).status).toBe(1);
  await rm(f.options.unruledDecisionsPath);
  expect(await pendingForRun(f.options)).toHaveLength(1);
  await writeFile(f.options.unruledDecisionsPath, "{}");
  await expect(pendingForRun(f.options)).rejects.toThrow(
    "invalid unruled decisions",
  );
});

test("reference answers remember provenance, exact replay is a no-op, conflicting replay fails", async () => {
  const f = await fixture();
  const args = [
    "--finding",
    "finding-1",
    "--choose",
    "prototype",
    "--reason",
    "Use the prototype",
    "--build",
    "build-1",
    "--escalation",
    "esc-1",
  ];
  expect((await cli(f.root, args)).status).toBe(0);
  const path = join(f.root, ".idiom/decisions.jsonl");
  const bytes = await readFile(path, "utf8");
  expect((await cli(f.root, args)).status).toBe(0);
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect(
    (
      await cli(
        f.root,
        args.map((v) => (v === "prototype" ? "Designer’s 'reference'" : v)),
      )
    ).status,
  ).toBe(1);
  expect((await readDecisionLog(f.root))[0]?.provenance).toEqual({
    build: "build-1",
    escalation: "esc-1",
  });
  expect((await pendingForRun(f.options)).map((q) => q.kind)).toEqual([
    "unruled",
  ]);
  // An ordinary later human choice remains possible.
  expect(
    (
      await cli(f.root, [
        "--finding",
        "finding-1",
        "--choose",
        "Designer’s 'reference'",
      ])
    ).status,
  ).toBe(0);
});

test.each([
  ["--candidate", "1"],
  ["--no-rule"],
  ["--wording", "Use strong selection."],
])(
  "ruling answer %j affects effective law, never judgments, and isn't asked twice",
  async (...mode) => {
    const f = await fixture();
    const args = [
      "--decision",
      "ruling-1",
      ...mode,
      "--reason",
      "Human decision",
      "--build",
      "build-1",
      "--escalation",
      "esc-1",
    ];
    const designBefore = await readFile(f.options.designPath, "utf8");
    const response = await cli(f.root, args);
    expect(response.status, response.err).toBe(0);
    const before = await readFile(
      join(f.root, ".idiom/decisions.jsonl"),
      "utf8",
    );
    expect((await cli(f.root, args)).status).toBe(0);
    expect(await readFile(join(f.root, ".idiom/decisions.jsonl"), "utf8")).toBe(
      before,
    );
    expect(await readDecisionLog(f.root)).toEqual([]);
    expect(await readDecisions(f.root)).toEqual([]);
    expect((await readDecisionLogEntries(f.root))[0]).toMatchObject({
      decision: "ruling",
      reason: "Human decision",
      provenance: { build: "build-1" },
    });
    expect(
      (await readEffectiveLaw(f.options.designPath, f.root)).resolutions,
    ).toHaveLength(1);
    expect(
      (await pendingDecisions({ project: f.root })).every(
        (q) => q.kind !== "unruled",
      ),
    ).toBe(true);
    expect(await readFile(f.options.designPath, "utf8")).toBe(designBefore);
    const invalid = await cli(
      f.root,
      args.map((v) => (v === "Human decision" ? "Changed reason" : v)),
    );
    expect(invalid.status).toBe(1);
    expect(invalid.err).toContain("conflicting answer");
  },
);

test("ruling input requires an explicit reason, valid mode and stored candidate", async () => {
  const f = await fixture();
  for (const flags of [
    ["--candidate", "1"],
    ["--candidate", "8", "--reason", "why"],
    ["--drift", "--reason", "why"],
    ["--no-rule", "--candidate", "1", "--reason", "why"],
    ["--no-rule", "--reason", "  "],
  ])
    expect(
      (await cli(f.root, ["--decision", "ruling-1", ...flags])).status,
    ).toBe(1);
  expect(await readDecisionLogEntries(f.root)).toEqual([]);
});

test("effective law reads state memory with source prose; equivalent law dedupes and conflicts fail", async () => {
  const f = await fixture();
  await cli(f.root, [
    "--decision",
    "ruling-1",
    "--candidate",
    "1",
    "--reason",
    "why",
  ]);
  const resolution = rulingAnswer(
    unruledQuestion(),
    { candidate: "1" },
    "2026-11-07T00:00:00.000Z",
  );
  await writeFile(
    f.options.designPath,
    appendRuling("Source design prose.", resolution),
  );
  const law = await readEffectiveLaw(f.options.designPath, f.root);
  expect(law.prose).toBe("Source design prose.");
  expect(law.resolutions).toHaveLength(1);
  await writeFile(
    f.options.designPath,
    appendRuling("Source prose.", {
      ...resolution,
      wording: "Different answer.",
    }),
  );
  await expect(readEffectiveLaw(f.options.designPath, f.root)).rejects.toThrow(
    "conflicting ruling",
  );
});

test("a rejected or acknowledged question is not pending", async () => {
  const f = await fixture();
  await appendDecision({
    projectDirectory: f.root,
    finding: referenceQuestion(),
    decision: "reject",
    scope: "rule",
  });
  expect(
    (await pendingDecisions({ project: f.root })).every(
      (q) => q.kind !== "reference-conflict",
    ),
  ).toBe(true);
});

test("shared escalation text fixture includes multiple questions, citations and shell-quoted names", async () => {
  const f = await fixture();
  const questions = await pendingForRun(f.options);
  const text = decisionQuestion(questions).replaceAll(
    f.runDirectory,
    "/PROJECT/.idiom/reports/run",
  );
  await expect(text).toMatchFileSnapshot(
    join(import.meta.dirname, "fixtures/decision-escalation/questions.md"),
  );
});

test("an acknowledged reference is absent; accepting without choosing leaves the question open", async () => {
  const f = await fixture();
  expect(
    (await cli(f.root, ["--finding", "finding-1", "--accept"])).status,
  ).toBe(0);
  expect(
    (await pendingDecisions({ project: f.root })).some(
      (q) => q.kind === "reference-conflict",
    ),
  ).toBe(true);
  expect(
    (await cli(f.root, ["--finding", "finding-1", "--ack", "EXTERNAL-123"]))
      .status,
  ).toBe(0);
  expect(
    (await pendingDecisions({ project: f.root })).some(
      (q) => q.kind === "reference-conflict",
    ),
  ).toBe(false);
});

test("a stale chosen reference cannot hide a newly observed conflict", async () => {
  const f = await fixture();
  await cli(f.root, ["--finding", "finding-1", "--choose", "prototype"]);
  const finding = referenceQuestion();
  const marker = finding.evidence.designDrift?.designDecision;
  if (!marker) throw new Error("missing marker");
  marker.references[1] = {
    ...(marker.references[1] as (typeof marker.references)[number]),
    name: "new-prototype",
  };
  await writeFile(
    join(f.runDirectory, "findings.json"),
    JSON.stringify([finding]),
  );
  expect(
    (await pendingDecisions({ project: f.root })).some(
      (q) => q.kind === "reference-conflict",
    ),
  ).toBe(true);
});

test("current checkout wins a run collision; otherwise newest observation wins across checkouts", async () => {
  const { readGit } = await import("../src/changed/git.js");
  const f = await fixture();
  const git = (...args: string[]) => readGit(f.root, args);
  await git("init", "--quiet", "--initial-branch=main");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const worktree = await mkdtemp(join(tmpdir(), "idiom-pending-worktree-"));
  roots.push(worktree);
  await git("worktree", "add", "--quiet", "-b", "topic", worktree);
  const ownRun = join(worktree, ".idiom/reports/run");
  await mkdir(ownRun, { recursive: true });
  await writeUnruledDecisions(ownRun, [
    { ...unruledQuestion(), question: "Current checkout question?" },
  ]);
  const own = await pendingDecisions({ project: worktree });
  expect(own.map((q) => q.question)).toEqual(["Current checkout question?"]);
  const newestRun = join(f.root, ".idiom/reports/z-newer");
  await mkdir(newestRun, { recursive: true });
  await writeUnruledDecisions(newestRun, [
    { ...unruledQuestion(), question: "Newest primary question?" },
  ]);
  expect(
    (await pendingDecisions({ project: worktree })).find(
      (q) => q.kind === "unruled",
    )?.question,
  ).toBe("Newest primary question?");
  // A later partial run without a question does not resolve older coordinates.
  const partialRun = join(worktree, ".idiom/reports/zz-partial");
  await mkdir(partialRun, { recursive: true });
  await writeFile(join(partialRun, "findings.json"), "[]");
  expect(
    (await pendingDecisions({ project: worktree })).find(
      (q) => q.kind === "unruled",
    )?.question,
  ).toBe("Newest primary question?");
});

test("reattribution and changing transports keep identical ruling/reference retries idempotent", async () => {
  for (const mode of [
    ["--finding", "finding-1", "--choose", "prototype"],
    ["--decision", "ruling-1", "--candidate", "1"],
  ]) {
    const f = await fixture();
    const args = [
      ...mode,
      "--reason",
      "Approved answer",
      "--build",
      "external-build",
      "--escalation",
      "same-answer",
      "--actor",
      "human",
    ];
    expect((await cli(f.root, args)).status).toBe(0);
    const first = (await readRawDecisionLog(f.root))[0];
    if (!first || first.record.decision === "reattribute")
      throw new Error("missing original answer");
    await appendDecisionBatch(f.root, [
      {
        decision: "reattribute",
        at: new Date().toISOString(),
        commit: first.record.commit,
        findingId: first.record.findingId,
        fingerprint: first.record.fingerprint,
        target: first.source,
        actor: "agent",
        agent: "mcp",
        note: "correct transport",
      },
    ]);
    const path = join(f.root, ".idiom/decisions.jsonl");
    const corrected = await readFile(path, "utf8");
    expect((await cli(f.root, args)).status).toBe(0);
    expect(await readFile(path, "utf8")).toBe(corrected);
    expect(
      (
        await cli(
          f.root,
          args.map((value) =>
            value === "Approved answer" ? "Changed answer" : value,
          ),
        )
      ).status,
    ).toBe(1);
    expect((await readDecisionLogEntries(f.root))[0]).toMatchObject({
      actor: "agent",
      agent: "mcp",
    });
  }
});
