import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run as runCli } from "../src/cli.js";
import { escalationsCommand } from "../src/commands/escalations.js";
import { GUIDANCE_MARKER } from "../src/escalations/guidance.js";
import {
  escalationAnswerLogPath,
  readEscalationAnswers,
} from "../src/escalations/log.js";
import { escalationLockPath } from "../src/escalations/run.js";
import {
  type AbBuild,
  abOnPath,
  ERROR_RULING,
  FILTER_RULING,
  FOOTER_REJECTION,
  fakeAb,
  fixtureBuilds,
  precedentProject,
  QUESTIONS,
  stubAbBin,
} from "./escalations-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const NOW = new Date("2026-11-15T12:00:00.000Z");

async function setup(builds: AbBuild[] = fixtureBuilds()) {
  const project = await precedentProject(directories);
  const ab = fakeAb(builds);
  const environment = {
    PATH: await abOnPath(directories),
    AB_STORE: "/tmp/store",
    AB_BUILD: "idiom-escalation-precedent",
    AB_PHASE: "implement@1",
    AB_SESSION: "s_1",
  };
  const command = (options: { answer?: boolean; history?: boolean } = {}) =>
    escalationsCommand({
      project,
      ...options,
      dependencies: { exec: ab.exec, environment, now: () => NOW },
    });
  return { project, ab, environment, command };
}

/** Every `ab` argv is a read or a non-blank guidance answer; nothing else. */
function expectOnlySafeCalls(calls: Array<{ args: string[] }>) {
  for (const { args } of calls) {
    expect(args).not.toContain("abort");
    expect(args).not.toContain("--dismiss");
    expect(args).not.toContain("--revise-spec");
    expect(args).not.toContain("--revise-spec-from-ticket");
    if (args[0] === "answer") {
      expect(args).toHaveLength(3);
      expect(args[2]?.trim()).not.toBe("");
    } else
      expect(
        args.join(" ") === "builds --json" ||
          (args[0] === "build" && args[1] === "status"),
      ).toBe(true);
  }
}

test("the fixture store: answers exactly the two settled, summarises two, ignores one", async () => {
  const { project, ab, command } = await setup();

  // Without --answer: listed, nothing sent, nothing written.
  const listed = await command();
  if (listed.kind !== "pass") throw new Error("expected a pass");
  console.log(`--- idiom escalations (list) ---\n${listed.text}`);
  expect(ab.answers()).toEqual([]);
  expect(await readEscalationAnswers(project)).toEqual([]);
  expect(
    Object.fromEntries(
      listed.pass.items.map((item) => [item.build, item.verdict]),
    ),
  ).toEqual({
    "booking-filter": "decisive",
    "confirm-footer": "decisive",
    "form-errors": "open",
    "calendar-empty": "open",
    lockfile: "not-design",
  });
  expect(listed.text).toMatch(/run with --answer to answer it/);

  const result = await command({ answer: true });
  if (result.kind !== "pass") throw new Error("expected a pass");
  console.log(`--- idiom escalations --answer ---\n${result.text}`);
  const answers = ab.answers();
  expect(answers.map((call) => call.args[1])).toEqual([
    "booking-filter",
    "confirm-footer",
  ]);
  const [filter, footer] = answers.map((call) => call.args[2] ?? "");
  expect(filter).toBe(
    [
      GUIDANCE_MARKER,
      `Recorded ruling ruling-1 in DESIGN.md says: "${FILTER_RULING}"`,
      "Follow it. If it does not apply to this case, escalate again and say why; a person will answer.",
    ].join("\n"),
  );
  expect(footer).toContain(
    `The director rejected this before (.idiom/decisions.jsonl line 2, finding IDM-footer-primary): "${FOOTER_REJECTION}"`,
  );

  const byBuild = Object.fromEntries(
    result.pass.items.map((item) => [item.build, item]),
  );
  expect(byBuild["form-errors"]).toMatchObject({
    verdict: "open",
    reason: expect.stringMatching(/^conflicting precedent: /),
  });
  expect(byBuild["form-errors"]?.summary).toMatch(
    /^form-errors \[esc_errors1\] \(implement\) asks: Should form error messages show inline under the field or in a toast\? Closest precedent: .+ \(score 0\.\d\d; shares .+\) — ".+"\. Left open: conflicting precedent: .+\.$/,
  );
  expect(
    byBuild["form-errors"]?.matches.map((match) => match.text).sort(),
  ).toEqual([ERROR_RULING, expect.stringContaining("toast")].sort());
  expect(byBuild["calendar-empty"]).toMatchObject({
    verdict: "open",
    reason: "no precedent",
    summary: `calendar-empty [esc_empty1] (implement) asks: ${QUESTIONS.empty} No recorded precedent matches. Left open: no precedent.`,
  });
  expect(byBuild.lockfile).toMatchObject({ verdict: "not-design" });
  expect(byBuild.lockfile?.summary).toBeUndefined();
  console.log(
    `--- summaries ---\n${result.pass.items
      .flatMap((item) => (item.summary === undefined ? [] : [item.summary]))
      .join("\n")}`,
  );

  // Two history records, listed newest first.
  const history = await readEscalationAnswers(project);
  expect(history).toHaveLength(2);
  expect(history[0]).toMatchObject({
    version: 1,
    at: NOW.toISOString(),
    build: "booking-filter",
    escalation: "esc_filter1",
    phase: "implement",
    question: QUESTIONS.filter,
    guidance: filter,
    precedent: {
      kind: "ruling",
      id: "ruling-1",
      where: "DESIGN.md (recorded ruling ruling-1)",
      text: FILTER_RULING,
    },
    actor: "idiom",
  });
  expect(history[1]?.precedent).toMatchObject({
    kind: "decision",
    id: "IDM-footer-primary",
    stance: "rejected",
    where: ".idiom/decisions.jsonl line 2",
  });
  const listing = await command({ history: true });
  console.log(`--- idiom escalations --history ---\n${listing.text}`);
  expect(listing.text).toMatch(
    /booking-filter \[esc_filter1\]\n {2}precedent: ruling ruling-1 in DESIGN\.md \(recorded ruling ruling-1\)\n {2}asked: .+\n {2}overrule: answer the build again or revise the precedent/,
  );

  // The ambient build identity never reaches ab; the store does.
  for (const call of ab.calls) {
    expect(call.env.AB_BUILD).toBeUndefined();
    expect(call.env.AB_PHASE).toBeUndefined();
    expect(call.env.AB_SESSION).toBeUndefined();
    expect(call.env.AB_STORE).toBe("/tmp/store");
  }
  expectOnlySafeCalls(ab.calls);
});

test("idempotent: an escalation Idiom answered is never answered again", async () => {
  const { ab, command } = await setup();
  ab.state.keepOpen = true;
  await command({ answer: true });
  expect(ab.answers()).toHaveLength(2);
  const again = await command({ answer: true });
  if (again.kind !== "pass") throw new Error("expected a pass");
  expect(ab.answers()).toHaveLength(2);
  expect(
    again.pass.items
      .filter((item) => item.verdict === "answered-before")
      .map((item) => item.build),
  ).toEqual(["booking-filter", "confirm-footer"]);
});

test("a paused build is listed and summarised but never answered", async () => {
  const { ab, command } = await setup([
    {
      slug: "paused-filter",
      status: "paused",
      escalations: [{ id: "esc_p1", question: QUESTIONS.filter }],
    },
  ]);
  const result = await command({ answer: true });
  if (result.kind !== "pass") throw new Error("expected a pass");
  expect(ab.answers()).toEqual([]);
  expect(result.pass.items).toEqual([
    expect.objectContaining({
      build: "paused-filter",
      verdict: "open",
      reason: "build is paused",
      summary: expect.stringContaining("Left open: build is paused."),
    }),
  ]);
});

test("a build with two open escalations is not answered", async () => {
  const { ab, command } = await setup([
    {
      slug: "two-questions",
      status: "blocked",
      escalations: [
        { id: "esc_t1", question: QUESTIONS.filter },
        { id: "esc_t2", question: QUESTIONS.lockfile },
      ],
    },
  ]);
  const result = await command({ answer: true });
  if (result.kind !== "pass") throw new Error("expected a pass");
  expect(ab.answers()).toEqual([]);
  expect(result.pass.items.map((item) => [item.verdict, item.reason])).toEqual([
    ["open", "build has 2 open escalations"],
    ["not-design", undefined],
  ]);
});

test("a new escalation on a build Idiom already answered is left for a person", async () => {
  const builds = fixtureBuilds().slice(0, 1);
  const { ab, command } = await setup(builds);
  await command({ answer: true });
  expect(ab.answers()).toHaveLength(1);
  // The agent pushes back with another design question on the same build.
  const [build] = ab.state.builds;
  if (build === undefined) throw new Error("no build");
  build.status = "blocked";
  build.escalations = [{ id: "esc_filter2", question: QUESTIONS.filter }];
  const result = await command({ answer: true });
  if (result.kind !== "pass") throw new Error("expected a pass");
  expect(ab.answers()).toHaveLength(1);
  expect(result.pass.items[0]).toMatchObject({
    verdict: "open",
    reason: "Idiom already answered an escalation on this build",
  });
});

test("stall and policy escalations are never design, whatever their text", async () => {
  const { ab, command } = await setup([
    {
      slug: "stalled",
      status: "blocked",
      escalations: [
        { id: "esc_s1", source: "stall", question: QUESTIONS.filter },
      ],
    },
    {
      slug: "guarded",
      status: "blocked",
      escalations: [
        { id: "esc_g1", source: "policy", question: QUESTIONS.footer },
      ],
    },
  ]);
  const result = await command({ answer: true });
  if (result.kind !== "pass") throw new Error("expected a pass");
  expect(result.pass.items.map((item) => item.verdict)).toEqual([
    "not-design",
    "not-design",
  ]);
  expect(ab.answers()).toEqual([]);
});

test("a failed ab answer leaves the escalation open with a warning and no history", async () => {
  const { project, ab, command } = await setup(fixtureBuilds().slice(0, 1));
  ab.state.failAnswer = "build booking-filter is not blocked";
  const result = await command({ answer: true });
  if (result.kind !== "pass") throw new Error("expected a pass");
  expect(ab.answers()).toHaveLength(1);
  expect(result.warnings).toEqual([
    "ab answer booking-filter failed: build booking-filter is not blocked",
  ]);
  expect(result.pass.items[0]).toMatchObject({
    verdict: "open",
    reason:
      "ab answer booking-filter failed: build booking-filter is not blocked",
  });
  expect(await readEscalationAnswers(project)).toEqual([]);
});

test("ab missing is a clear error; --history with --answer is a usage error", async () => {
  const project = await precedentProject(directories);
  await expect(
    escalationsCommand({
      project,
      dependencies: { environment: { PATH: "/nonexistent" } },
    }),
  ).rejects.toThrow(
    "idiom escalations needs the autobuild CLI (ab) on PATH: ab is not installed",
  );
  await expect(
    escalationsCommand({ project, answer: true, history: true }),
  ).rejects.toThrow("--history cannot be combined with --answer");
});

test("a pass holding the lock makes a second fail fast", async () => {
  const { project, ab, command } = await setup();
  await writeFile(
    escalationLockPath(project),
    JSON.stringify({
      token: "other",
      pid: process.pid,
      hostname: (await import("node:os")).hostname(),
      startedAt: new Date().toISOString(),
      description: "answering autobuild escalations",
    }),
  );
  await expect(command({ answer: true })).rejects.toThrow(
    /another idiom escalations pass/,
  );
  expect(ab.answers()).toEqual([]);
});

test("a bad history line is an error naming file:line", async () => {
  const { project, command } = await setup();
  await writeFile(escalationAnswerLogPath(project), "{}\n");
  await expect(command({ history: true })).rejects.toThrow(
    /\.idiom\/escalation-answers\.jsonl:1 /,
  );
});

test("CLI: a stub ab on PATH answers the two settled escalations; --json and --history", async () => {
  const project = await precedentProject(directories);
  const stub = await stubAbBin(directories, fixtureBuilds());
  const environment = {
    PATH: `${stub.bin}:${process.env.PATH ?? ""}`,
    AB_BUILD: "idiom-escalation-precedent",
    AB_PHASE: "implement@1",
    AB_SESSION: "s_1",
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    [
      "node",
      "idiom",
      "escalations",
      "--project",
      project,
      "--answer",
      "--json",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      escalations: { environment, now: () => NOW },
    },
  );
  expect(stderr.join("")).toBe("");
  expect(code).toBe(0);
  const payload = JSON.parse(stdout.join(""));
  expect(
    payload.answered.map((record: { build: string }) => record.build),
  ).toEqual(["booking-filter", "confirm-footer"]);
  expect(payload.escalations).toHaveLength(5);
  const sent = (await readFile(stub.answers, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) => JSON.parse(line) as { args: string[]; build: string | null },
    );
  expect(sent.map((line) => line.args[1])).toEqual([
    "booking-filter",
    "confirm-footer",
  ]);
  for (const line of sent) {
    expect(line.build).toBeNull();
    expect(line.args[2]?.startsWith(GUIDANCE_MARKER)).toBe(true);
  }
  console.log(
    `--- answers sent through the stub ab ---\n${sent.map((line) => `ab answer ${line.args[1]}\n${line.args[2]}`).join("\n\n")}`,
  );

  // A second run finds nothing open: the stub closed both.
  const again: string[] = [];
  await runCli(
    ["node", "idiom", "escalations", "--project", project, "--answer"],
    {
      stdout: (message) => again.push(message),
      stderr: () => {},
      escalations: { environment, now: () => NOW },
    },
  );
  expect(again.join("")).toMatch(/3 open escalations on 3 builds: 0 answered/);
  expect(
    (await readFile(stub.answers, "utf8")).trim().split("\n"),
  ).toHaveLength(2);

  const history: string[] = [];
  await runCli(
    [
      "node",
      "idiom",
      "escalations",
      "--project",
      project,
      "--history",
      "--json",
    ],
    { stdout: (message) => history.push(message), stderr: () => {} },
  );
  expect(
    JSON.parse(history.join("")).history.map(
      (record: { escalation: string }) => record.escalation,
    ),
  ).toEqual(["esc_footer1", "esc_filter1"]);
});
