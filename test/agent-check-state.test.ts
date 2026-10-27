import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createBudget, recordEdit } from "../hooks/lib.mjs";
import {
  beginCheckRecording,
  completeCheckRecording,
} from "../src/agent/check-state.js";
import { initProject } from "../src/commands/init.js";
import type { ReportCoverage } from "../src/report/coverage.js";
import { commit, git } from "./baseline-support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), "idiom-check-state-"));
  roots.push(project);
  await initProject({ project, yes: true });
  await mkdir(join(project, "src"));
  await writeFile(join(project, "src/Page.tsx"), "before");
  await git(project, "init", "-q", "-b", "main");
  await commit(project, "fixture");
  return project;
}
const coverage: ReportCoverage = {
  flow: "studio",
  purpose: "test",
  declaredStateCount: 1,
  states: ["home"],
  viewports: [{ name: "desktop", width: 800, height: 600 }],
  colorSchemes: ["light"],
  selectedTuples: 1,
  successfulTuples: 1,
  commits: [],
  limitations: [],
};
const state = async (project: string) =>
  JSON.parse(
    await readFile(join(project, ".idiom/agent-hooks/state.json"), "utf8"),
  );

test("live scoped completion records compatible evidence even on a dirty tree", async () => {
  const project = await fixture();
  await writeFile(join(project, "src/Page.tsx"), "dirty checked");
  const recording = await beginCheckRecording({
    project,
    flow: "studio",
    scope: { states: "home" },
  });
  expect(recording).toBeDefined();
  await completeCheckRecording(recording, coverage);
  expect((await state(project)).check).toMatchObject({
    flow: "studio",
    scope: { states: "home" },
    digest: recording?.start.digest,
    startedAt: recording?.metadata.startedAt,
    completedAt: expect.any(Number),
  });
});

test.each([
  undefined,
  { ...coverage, selectedTuples: 0, successfulTuples: 0 },
  { ...coverage, successfulTuples: 0 },
  {
    ...coverage,
    failedTuples: [
      { state: "home", viewport: "desktop", colorScheme: "light" as const },
    ],
  },
  {
    ...coverage,
    unresolvedTuples: [
      { state: "home", viewport: "desktop", colorScheme: "light" as const },
    ],
  },
])(
  "missing, empty, failed or unresolved coverage cannot acknowledge a check (%#)",
  async (report) => {
    const project = await fixture();
    const recording = await beginCheckRecording({ project, flow: "studio" });
    expect(recording).toBeDefined();
    await completeCheckRecording(recording, report);
    await expect(state(project)).rejects.toThrow();
  },
);

test("source changes, cancellation and changed configuration cannot acknowledge a check", async () => {
  const project = await fixture();
  const original = await readFile(join(project, "src/Page.tsx"), "utf8");
  const recording = await beginCheckRecording({ project, flow: "studio" });
  expect(recording).toBeDefined();
  await writeFile(join(project, "src/Page.tsx"), "edited during capture");
  await completeCheckRecording(recording, coverage);
  await expect(state(project)).rejects.toThrow();
  await writeFile(join(project, "src/Page.tsx"), original);
  const cancelled = new AbortController();
  cancelled.abort();
  await completeCheckRecording(recording, coverage, cancelled.signal);
  await expect(state(project)).rejects.toThrow();
  const file = join(project, ".idiom/project.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  config.agent = { hooks: false };
  await writeFile(file, JSON.stringify(config));
  await completeCheckRecording(recording, coverage);
  expect(
    await beginCheckRecording({ project, flow: "studio" }),
  ).toBeUndefined();
  await expect(state(project)).rejects.toThrow();
});

test("an edit observed after check start is preserved even if the content is restored", async () => {
  const project = await fixture();
  const recording = await beginCheckRecording({ project, flow: "studio" });
  if (!recording) throw new Error("no recording");
  const budget = createBudget(5000);
  try {
    await recordEdit(recording.context, "src/Page.tsx", budget);
  } finally {
    budget.close();
  }
  await completeCheckRecording(recording, coverage);
  const saved = await state(project);
  expect(saved.check).toBeUndefined();
  expect(saved.pending[0].path).toBe("src/Page.tsx");
});

test("older overlapping checks cannot replace newer evidence or its Stop acknowledgments", async () => {
  const project = await fixture();
  const older = await beginCheckRecording({ project, flow: "older" });
  const newer = await beginCheckRecording({ project, flow: "newer" });
  expect(older).toBeDefined();
  expect(newer).toBeDefined();
  await completeCheckRecording(newer, coverage);
  const saved = await state(project);
  await completeCheckRecording(older, coverage);
  expect(await state(project)).toEqual(saved);
});

test("empty globs and invalid configuration suppress recording without affecting callers", async () => {
  const project = await fixture();
  const file = join(project, ".idiom/project.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  config.agent = { uiGlobs: [] };
  await writeFile(file, JSON.stringify(config));
  expect(
    await beginCheckRecording({ project, flow: "studio" }),
  ).toBeUndefined();
  await writeFile(file, "{invalid");
  expect(
    await beginCheckRecording({ project, flow: "studio" }),
  ).toBeUndefined();
  await completeCheckRecording(undefined, coverage);
  await expect(state(project)).rejects.toThrow();
});
