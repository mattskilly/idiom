import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveActor } from "../src/decisions/actor.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const neutral = {
  env: {},
  isDirectory: async () => false,
  exists: async () => false,
};

test.each([
  [{}, { actor: "human" }],
  [{ CLAUDECODE: "1" }, { actor: "agent", agent: "claude-code" }],
  [
    { CLAUDE_CODE_CHILD_SESSION: "1" },
    { actor: "agent", agent: "claude-code" },
  ],
  [{ CODEX_THREAD_ID: "thread" }, { actor: "agent", agent: "codex" }],
  [{ CODEX_SESSION_ID: "session" }, { actor: "agent", agent: "codex" }],
  [{ CODEX_CI: "1" }, { actor: "agent", agent: "codex" }],
  [
    { AB_BUILD: " build ", CLAUDECODE: "1" },
    { actor: "agent", agent: "autobuild:build" },
  ],
  [
    { AB_PHASE: "implement", CODEX_CI: "1" },
    { actor: "agent", agent: "autobuild" },
  ],
  [{ AB_SESSION: "session" }, { actor: "agent", agent: "autobuild" }],
  [
    {
      AB_BUILD: " ",
      CLAUDECODE: "0",
      CODEX_THREAD_ID: " ",
      CODEX_CI: "0",
      CI: "1",
      CODEX_HOME: "/tmp",
      ANTHROPIC_API_KEY: "not-identity",
    },
    { actor: "human" },
  ],
])("runtime hints %j resolve deterministically", async (env, expected) => {
  expect(await resolveActor({ dependencies: { ...neutral, env } })).toEqual(
    expected,
  );
  expect(
    await resolveActor({ actor: "human", dependencies: { ...neutral, env } }),
  ).toEqual({ actor: "human" });
  expect(
    await resolveActor({
      source: "mcp",
      actor: "human",
      dependencies: { ...neutral, env },
    }),
  ).toEqual({ actor: "agent", agent: "mcp" });
});

test("explicit agent keeps a detected label and otherwise has none; invalid override fails", async () => {
  expect(await resolveActor({ actor: "agent", dependencies: neutral })).toEqual(
    { actor: "agent" },
  );
  expect(
    await resolveActor({
      actor: "agent",
      dependencies: { ...neutral, env: { CODEX_CI: "1" } },
    }),
  ).toEqual({ actor: "agent", agent: "codex" });
  await expect(
    resolveActor({ actor: "robot" as "agent", dependencies: neutral }),
  ).rejects.toThrow();
});

test("bounded nearest context, broken markers and explicit projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "idiom-actor-"));
  directories.push(root);
  const project = join(root, "project");
  const nested = join(project, "src", "nested");
  await mkdir(nested, { recursive: true });
  await mkdir(join(root, ".ab"));
  await writeFile(join(root, ".ab", "context.json"), '{"build":"unrelated"}');
  await writeFile(join(project, ".git"), "gitdir: elsewhere");
  const options = { cwd: nested, dependencies: { env: {} } };
  expect(await resolveActor(options)).toEqual({ actor: "human" });
  await writeFile(join(project, ".ab"), "ordinary file");
  expect(await resolveActor(options)).toEqual({ actor: "human" });
  await rm(join(project, ".ab"));
  await mkdir(join(project, ".ab"));
  // Bare, broken, blank and harvest-shaped contexts name no build: still human.
  for (const content of [
    undefined,
    "{broken",
    '{"build":" "}',
    '{"run":"harvest_1","phase":"synthesize"}',
  ]) {
    if (content) await writeFile(join(project, ".ab", "context.json"), content);
    expect(await resolveActor(options)).toEqual({ actor: "human" });
  }
  // A live session's environment still marks a build-less directory as agent.
  expect(
    await resolveActor({
      ...options,
      dependencies: { env: { AB_PHASE: "x" } },
    }),
  ).toEqual({ actor: "agent", agent: "autobuild" });
  await writeFile(join(project, ".ab", "context.json"), '{"build":"local"}');
  expect(await resolveActor(options)).toEqual({
    actor: "agent",
    agent: "autobuild:local",
  });
  expect(
    await resolveActor({
      cwd: root,
      projectDirectory: project,
      dependencies: { env: {} },
    }),
  ).toEqual({ actor: "agent", agent: "autobuild:unrelated" });
  // The explicit project's marker is checked when invoked from another repository.
  await writeFile(join(root, ".git"), "boundary");
  await rm(join(root, ".ab"), { recursive: true });
  expect(
    await resolveActor({
      cwd: root,
      projectDirectory: project,
      dependencies: { env: {} },
    }),
  ).toEqual({ actor: "agent", agent: "autobuild:local" });
  await mkdir(join(project, "src", ".ab"));
  await writeFile(
    join(project, "src", ".ab", "context.json"),
    '{"build":"nearest"}',
  );
  expect(await resolveActor(options)).toEqual({
    actor: "agent",
    agent: "autobuild:nearest",
  });
});
