import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { learnHarvestCommand } from "../src/commands/learn-harvest.js";
import { IdiomError } from "../src/errors.js";
import {
  AMBIENT_AB_IDENTITY,
  harvestEnvironment,
} from "../src/learn/harvest-sources.js";
import { learnedEntrySchema } from "../src/schemas/learned.js";
import {
  fakeExec,
  harvestFixture,
  NEW_ANSWER,
  PR_COMMENT,
  pathWith,
  type Responses,
  UI_SENTENCE,
  unauthenticated,
} from "./harvest-support.js";
import { studioProject } from "./stored-run-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const clock = () => new Date("2026-11-12T12:00:00.000Z");

async function setup(tools: Array<"ab" | "gh"> = ["ab", "gh"]) {
  const { project } = await studioProject(directories, [
    "editor",
    "time-picker",
  ]);
  let responses: Responses = harvestFixture();
  const fake = fakeExec(() => responses);
  const environment = {
    PATH: await pathWith(directories, tools),
    AB_STORE: "/tmp/store",
    AB_BUILD: "idiom-harvest-ui",
    AB_PHASE: "finalize@1",
    AB_SESSION: "s_1",
    AB_BUILD_RUNNER_OPTIONS: "{}",
    AB_DISPATCH_CHILD_OPTIONS: "{}",
  };
  const harvest = (options: { since?: string; dryRun?: boolean } = {}) =>
    learnHarvestCommand({
      project,
      ...options,
      dependencies: {
        clock,
        harvest: { exec: fake.exec, environment },
      },
    });
  return {
    project,
    harvest,
    calls: fake.calls,
    serve: (next: Responses) => {
      responses = next;
    },
  };
}

async function records(project: string) {
  const text = await readFile(
    join(project, ".idiom", "learned.jsonl"),
    "utf8",
  ).catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => learnedEntrySchema.parse(JSON.parse(line)));
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

test("UI corrections become attributed open records; non-UI, bot and machine text is ignored", async () => {
  const { project, harvest } = await setup();
  const files = [
    "DESIGN.md",
    ".idiom/project.json",
    ".idiom/ruling-names.json",
  ];
  const before = await Promise.all(
    files.map((file) => readFile(join(project, file), "utf8")),
  );
  const result = await harvest();
  expect(result.recorded).toHaveLength(2);
  expect(result.ignored).toBe(2);
  expect(result.duplicates).toBe(0);
  expect(result.sources).toMatchObject({
    autobuild: { status: "read", recorded: 1, ignored: 1 },
    pullRequests: {
      status: "read",
      recorded: 1,
      ignored: 1,
      repo: "acme/shop",
    },
  });

  const [answer, comment] = await records(project);
  expect(answer).toMatchObject({
    id: "learned-1",
    kind: "observation",
    flow: "studio-lab",
    state: "time-picker",
    observation: UI_SENTENCE,
    target: { file: ".idiom/flows/studio-lab.json" },
    candidate: { kind: "ruling", checkable: "judged", rule: UI_SENTENCE },
    placement: { via: "words", tokens: ["time", "picker"] },
    harvest: {
      source: "escalation",
      key: "autobuild:booking-times:esc_a1",
      at: "2026-11-09T09:00:00.000Z",
      author: "director",
      build: "booking-times",
      escalation: "esc_a1",
      pr: 41,
      categories: ["spacing"],
    },
    recordedAt: clock().toISOString(),
  });
  expect(comment).toMatchObject({
    id: "learned-2",
    kind: "observation",
    observation: PR_COMMENT,
    placement: {
      via: "proposed",
      proposal: ".idiom/proposals/states/learned-2.json",
    },
    target: { file: ".idiom/proposals/states/learned-2.json" },
    candidate: { kind: "ruling" },
    harvest: {
      source: "pr-review-comment",
      key: "github:acme/shop#41:review-comment:501",
      at: "2026-11-10T08:00:00.000Z",
      author: "director",
      pr: 41,
      url: "https://github.com/acme/shop/pull/41#discussion_r501",
      path: "src/Toast.tsx",
      categories: ["layout"],
    },
  });
  expect(
    JSON.parse(
      await readFile(
        join(project, ".idiom", "proposals", "states", "learned-2.json"),
        "utf8",
      ),
    ),
  ).toMatchObject({ learned: "learned-2", observation: PR_COMMENT });

  // Harvest records misses only: design law and config are untouched.
  expect(
    await Promise.all(
      files.map((file) => readFile(join(project, file), "utf8")),
    ),
  ).toEqual(before);

  expect(
    JSON.parse(await readFile(join(project, ".idiom", "harvest.json"), "utf8")),
  ).toEqual({
    version: 1,
    autobuild: { through: "2026-11-09T09:00:00.000Z" },
    pullRequests: { repo: "acme/shop", through: "2026-11-10T10:30:00.000Z" },
    lastRunAt: clock().toISOString(),
  });
}, 60_000);

test("running again adds nothing; a new answer adds exactly one; an older --since is absorbed by keys", async () => {
  const { project, harvest, serve, calls } = await setup();
  await harvest();
  const second = await harvest();
  expect(second.recorded).toHaveLength(0);
  expect(await records(project)).toHaveLength(2);
  // The cursor skips builds not updated since: only booking-times is read.
  const statusCalls = (from: number) =>
    calls
      .slice(from)
      .filter((call) => call.args[0] === "build")
      .map((call) => call.args[2]);
  expect(statusCalls(0)).toEqual([
    "booking-times",
    "error-text-tells",
    "retry-only",
    "booking-times",
  ]);

  serve(harvestFixture({ newAnswer: true }));
  const third = await harvest();
  expect(third.recorded.map(({ entry }) => entry.harvest?.key)).toEqual([
    "autobuild:booking-times:esc_a2",
  ]);
  const [added] = third.recorded;
  expect(added?.entry).toMatchObject({
    id: "learned-3",
    observation: NEW_ANSWER,
    candidate: { kind: "glossary", rule: 'Say "Reserve", not "Book".' },
    entry: { term: "Book", preferred: "Reserve" },
  });
  expect(third.cursor?.autobuild?.through).toBe("2026-11-11T09:00:00.000Z");

  const replay = await harvest({ since: "2026-01-01" });
  expect(replay.recorded).toHaveLength(0);
  expect(replay.duplicates).toBe(3);
  expect(await records(project)).toHaveLength(3);
}, 60_000);

test("unreadable pull request comments are reported; autobuild answers are still recorded", async () => {
  const { project, harvest, serve } = await setup();
  serve(unauthenticated(harvestFixture()));
  const result = await harvest();
  expect(result.sources.pullRequests).toEqual({
    status: "unavailable",
    reason: "To get started with GitHub CLI, please run:  gh auth login",
  });
  expect(result.recorded.map(({ entry }) => entry.harvest?.source)).toEqual([
    "escalation",
  ]);
  const cursor = JSON.parse(
    await readFile(join(project, ".idiom", "harvest.json"), "utf8"),
  );
  expect(cursor.pullRequests).toBeUndefined();
  expect(cursor.autobuild).toEqual({ through: "2026-11-09T09:00:00.000Z" });
}, 60_000);

test("gh missing from PATH is named; both sources missing is an error", async () => {
  const { harvest } = await setup(["ab"]);
  const result = await harvest();
  expect(result.sources.pullRequests).toEqual({
    status: "unavailable",
    reason: "gh is not installed",
  });
  expect(result.recorded).toHaveLength(1);

  const none = await setup([]);
  const error = await none.harvest().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(IdiomError);
  expect((error as Error).message).toBe(
    "nothing to harvest: autobuild answers not read (ab is not installed); pull request comments not read (gh is not installed)",
  );
}, 60_000);

test("the ambient autobuild identity never reaches ab or gh", async () => {
  const { harvest, calls } = await setup();
  await harvest();
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    for (const name of AMBIENT_AB_IDENTITY)
      expect(call.env[name]).toBeUndefined();
    expect(call.env.AB_STORE).toBe("/tmp/store");
    expect(call.env.PATH).toBeTruthy();
  }
  expect(harvestEnvironment({ AB_BUILD: "x", HOME: "/h" })).toEqual({
    HOME: "/h",
  });
}, 60_000);

test("a build whose status cannot be read is read again next run, older answers included", async () => {
  const { project, harvest, serve } = await setup();
  await harvest();
  const statusKey = "ab build status booking-times --events 100000 --json";
  const withLaterBuild = (responses: Responses): Responses => {
    const builds = JSON.parse(
      responses["ab builds --all --json"]?.stdout ?? "[]",
    );
    builds.push({ slug: "later", updatedAt: "2026-11-12T00:00:00.000Z" });
    return {
      ...responses,
      "ab builds --all --json": { stdout: JSON.stringify(builds) },
      "ab build status later --events 100000 --json": {
        stdout: JSON.stringify({
          events: [
            {
              ts: "2026-11-12T00:00:00.000Z",
              actor: { kind: "human", user: "director" },
              type: "escalation.answered",
              payload: { id: "esc_l1", answer: "Retry the build." },
            },
          ],
        }),
      },
    };
  };
  // booking-times now holds a newer answer (2026-11-11T09:00), but its
  // status read fails while a later build is read fine.
  serve(
    withLaterBuild({
      ...harvestFixture({ newAnswer: true }),
      [statusKey]: { code: 1, stderr: "database is locked" },
    }),
  );
  const failed = await harvest();
  expect(failed.recorded).toHaveLength(0);
  expect(failed.sources.autobuild).toMatchObject({
    status: "read",
    skipped: ["booking-times: database is locked"],
  });
  expect(failed.cursor?.autobuild?.through).toBe("2026-11-09T09:00:00.000Z");

  serve(withLaterBuild(harvestFixture({ newAnswer: true })));
  const recovered = await harvest();
  expect(recovered.recorded.map(({ entry }) => entry.harvest?.key)).toEqual([
    "autobuild:booking-times:esc_a2",
  ]);
  expect(recovered.cursor?.autobuild?.through).toBe("2026-11-12T00:00:00.000Z");
  expect(await records(project)).toHaveLength(3);
}, 60_000);

test("--dry-run reports what it would record and writes nothing", async () => {
  const { project, harvest } = await setup();
  const result = await harvest({ dryRun: true });
  expect(result.dryRun).toBe(true);
  expect(result.recorded.map(({ entry }) => entry.id)).toEqual([
    "learned-1",
    "learned-2",
  ]);
  for (const path of [
    ".idiom/learned.jsonl",
    ".idiom/harvest.json",
    ".idiom/proposals",
  ])
    expect(await exists(join(project, path))).toBe(false);
}, 60_000);

test("an invalid cursor and an invalid --since are named", async () => {
  const { project, harvest } = await setup();
  await expect(harvest({ since: "last tuesday" })).rejects.toThrow(
    '--since "last tuesday" is not a date',
  );
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(project, ".idiom", "harvest.json"), '{"version":2}');
  await expect(harvest()).rejects.toThrow(
    ".idiom/harvest.json is not a harvest cursor",
  );
}, 60_000);
