import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { sourceStatus } from "../src/capture/resolve.js";
import { run } from "../src/cli.js";
import { baselineRecordCommand } from "../src/commands/baseline.js";
import { checkCommand } from "../src/commands/check.js";
import { RUN_FAILURE_EXIT_CODE, RunFailure } from "../src/errors.js";
import { preflightRun } from "../src/preflight.js";
import { validateProject } from "../src/validation.js";
import { baselineProject, commit } from "./baseline-support.js";

// Preflight refuses a run before any server or capture work: every test
// injects capture spies and proves neither was reached.

const projects: string[] = [];

afterEach(async () => {
  await Promise.all(
    projects
      .splice(0)
      .map((project) => rm(project, { recursive: true, force: true })),
  );
});

async function fixture() {
  const created = await baselineProject();
  projects.push(created.project);
  return created;
}

function captureSpies() {
  const snapshotSource = vi.fn(async () => {
    throw new Error("capture must not start");
  });
  const spawn = vi.fn(() => {
    throw new Error("server must not start");
  });
  return {
    snapshotSource,
    spawn,
    dependencies: {
      capture: {
        snapshotSource,
        process: { spawn: spawn as never },
      },
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<RunFailure> {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(RunFailure);
  return error as RunFailure;
}

test("a dirty tree refuses the first check before the server starts", async () => {
  const { project } = await fixture();
  await writeFile(join(project, "page.html"), "<p>changed</p>");
  const spies = captureSpies();
  const failure = await rejection(
    checkCommand({
      flow: "studio",
      cwd: project,
      dependencies: spies.dependencies,
    }),
  );
  expect(failure.stage).toBe("preflight");
  expect(failure.cause).toBe("tree-dirty");
  expect(failure.paths).toEqual(["page.html"]);
  expect(failure.headline).toMatch(
    /^baseline refused: tree dirty: .*\(commit or stash, or pass --all\)$/,
  );
  expect(failure.headline).toContain("page.html");
  expect(spies.snapshotSource).not.toHaveBeenCalled();
  expect(spies.spawn).not.toHaveBeenCalled();
});

test("more than five dirty paths list five and count the rest", async () => {
  const { project } = await fixture();
  for (const index of [1, 2, 3, 4, 5, 6, 7])
    await writeFile(join(project, `file-${index}.txt`), String(index));
  const spies = captureSpies();
  const failure = await rejection(
    checkCommand({
      flow: "studio",
      cwd: project,
      dependencies: spies.dependencies,
    }),
  );
  expect(failure.paths).toHaveLength(7);
  expect(failure.headline).toBe(
    "baseline refused: tree dirty: file-1.txt, file-2.txt, file-3.txt, file-4.txt, file-5.txt (+2 more) (commit or stash, or pass --all)",
  );
});

test("Idiom's own run-written files and ignored paths never make the tree dirty", async () => {
  const { project } = await fixture();
  await writeFile(join(project, ".gitignore"), "ignored/\n");
  await writeFile(join(project, ".idiom", "finding-names.json"), "{}\n");
  await writeFile(join(project, ".idiom", "ruling-names.json"), "{}\n");
  await commit(project, "registries");

  await writeFile(
    join(project, ".idiom", "finding-names.json"),
    '{"version":1}\n',
  );
  expect((await sourceStatus(project)).dirty).toBe(false);
  await writeFile(
    join(project, ".idiom", "ruling-names.json"),
    '{"version":1}\n',
  );
  expect((await sourceStatus(project)).dirty).toBe(false);
  await mkdir(join(project, "ignored"), { recursive: true });
  await writeFile(join(project, "ignored", "build.log"), "noise");
  await mkdir(join(project, ".idiom", "cache", "other"), { recursive: true });
  await writeFile(join(project, ".idiom", "cache", "other", "x"), "x");
  expect(await sourceStatus(project)).toMatchObject({
    dirty: false,
    dirtyPaths: [],
  });

  await writeFile(join(project, "untracked.txt"), "new");
  expect(await sourceStatus(project)).toMatchObject({
    dirty: true,
    dirtyPaths: ["untracked.txt"],
  });
});

test("--all and a stored run skip the tree check", async () => {
  const { project } = await fixture();
  await writeFile(join(project, "page.html"), "<p>changed</p>");
  const validated = await validateProject({ cwd: project, flow: "studio" });
  await expect(
    preflightRun({ validated, baseline: "none", allHint: true }),
  ).resolves.toBeUndefined();
  // With --all the capture is reached: the injected source snapshot runs.
  const spies = captureSpies();
  await expect(
    checkCommand({
      flow: "studio",
      cwd: project,
      all: true,
      dependencies: spies.dependencies,
    }),
  ).rejects.toThrow("capture must not start");
  expect(spies.snapshotSource).toHaveBeenCalled();
});

test("a corrupt finding-name registry refuses before capture", async () => {
  const { project } = await fixture();
  await writeFile(join(project, ".idiom", "finding-names.json"), "{not json");
  const spies = captureSpies();
  const failure = await rejection(
    checkCommand({
      flow: "studio",
      cwd: project,
      all: true,
      dependencies: spies.dependencies,
    }),
  );
  expect(failure.stage).toBe("preflight");
  expect(failure.cause).toBe("finding-name-registry");
  expect(failure.headline).toMatch(
    /^finding-name registry refused: invalid finding-name registry /,
  );
  expect(spies.snapshotSource).not.toHaveBeenCalled();
});

test("baseline record refuses a dirty tree before capture, without --all", async () => {
  const { project } = await fixture();
  await writeFile(join(project, "page.html"), "<p>changed</p>");
  const spies = captureSpies();
  const failure = await rejection(
    baselineRecordCommand({
      flow: "studio",
      cwd: project,
      dependencies: spies.dependencies,
    }),
  );
  expect(failure.cause).toBe("tree-dirty");
  expect(failure.headline).toBe(
    "baseline refused: tree dirty: page.html (commit or stash)",
  );
  expect(failure.hint).not.toContain("--all");
  expect(spies.snapshotSource).not.toHaveBeenCalled();
});

test("the CLI prints the refusal first, exits 2, and adds JSON with --json", async () => {
  const { project } = await fixture();
  await writeFile(join(project, "page.html"), "<p>changed</p>");
  const spies = captureSpies();
  const stderr: string[] = [];
  const stdout: string[] = [];
  const code = await run(["node", "idiom", "check", "studio", "--json"], {
    cwd: project,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    capture: spies.dependencies.capture,
  });
  expect(code).toBe(RUN_FAILURE_EXIT_CODE);
  const lines = stderr.join("").split("\n");
  expect(lines[0]).toMatch(/^baseline refused: tree dirty: page\.html /);
  expect(lines).toContain(
    "Fix: commit or stash the listed paths, or pass --all to inspect without recording a baseline",
  );
  const json = JSON.parse(stdout.join(""));
  expect(json).toEqual({
    flow: "studio",
    failure: {
      stage: "preflight",
      cause: "tree-dirty",
      hint: "commit or stash the listed paths, or pass --all to inspect without recording a baseline",
      message: lines[0],
      paths: ["page.html"],
    },
  });
  expect(spies.spawn).not.toHaveBeenCalled();
});
