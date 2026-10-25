import { access, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { baselineRecordCommand } from "../src/commands/baseline.js";
import { reviewCommand } from "../src/commands/review.js";
import {
  baselineProject,
  cleanHtml,
  storedBaselineRun,
} from "./baseline-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const overflowingHtml = cleanHtml.replace(
  "</main>",
  '</main><div style="width:1100px;height:20px;background:#eee"></div>',
);
const changedHtml = cleanHtml.replace(
  "<h1>Studio</h1>",
  '<h1>Studio</h1><p style="background:#3050c0;color:#fff;padding:40px">Banner</p>',
);

async function publishedProject(flow: Record<string, unknown> = {}) {
  const setup = await baselineProject({ required: [] });
  directories.push(setup.project);
  await writeFile(
    join(setup.project, ".idiom/flows/studio.json"),
    JSON.stringify({
      id: "studio",
      title: "Studio",
      intent: [],
      setup: [],
      kind: "published",
      pages: ["/"],
      viewports: ["desktop"],
      ...flow,
    }),
  );
  return setup;
}

async function review(project: string, from: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "review",
      "studio",
      "--project",
      project,
      "--from",
      from,
      "--deterministic-only",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("a published review fails on document overflow with the measured width", async () => {
  const { project, commit } = await publishedProject();
  await storedBaselineRun(project, "wide", commit, [
    { state: "page-root", html: overflowingHtml },
  ]);
  const result = await review(project, "wide");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("published budget failed");
  expect(result.stderr).toMatch(/The page is 11\d\dpx wide at the 800px/);
});

test("a clean published review passes", async () => {
  const { project, commit } = await publishedProject();
  await storedBaselineRun(project, "clean", commit, [{ state: "page-root" }]);
  const result = await review(project, "clean");
  expect(result.stderr).not.toContain("published budget failed");
  expect(result.code).toBe(0);
  const reviewed = await reviewCommand({
    flow: "studio",
    project,
    from: "clean",
    deterministicOnly: true,
  });
  expect(reviewed.publishedBudget).toEqual({ violations: [] });
});

test("baseline record writes pixel baselines that later reviews are budgeted against", async () => {
  const { project, commit } = await publishedProject({
    budget: { maxDiffRatio: 0.001 },
  });
  await storedBaselineRun(project, "recorded", commit, [
    { state: "page-root" },
  ]);
  const recorded = await baselineRecordCommand({
    flow: "studio",
    project,
    from: "recorded",
  });
  expect(recorded.pixelCount).toBe(1);
  expect(
    await readdir(join(project, ".idiom/baselines/studio.pixels")),
  ).toEqual(["page-root--desktop.png"]);

  expect((await review(project, "recorded")).code).toBe(0);

  await storedBaselineRun(project, "drifted", commit, [
    { state: "page-root", html: changedHtml },
  ]);
  const drifted = await review(project, "drifted");
  expect(drifted.code).not.toBe(0);
  expect(drifted.stderr).toMatch(
    /\d+\.\d\d% of pixels differ from the recorded baseline \(budget 0\.10%\)/,
  );
});

test("a flow that is not published records no pixel baselines", async () => {
  const setup = await baselineProject({ required: [] });
  directories.push(setup.project);
  await storedBaselineRun(setup.project, "plain", setup.commit);
  const recorded = await baselineRecordCommand({
    flow: "studio",
    project: setup.project,
    from: "plain",
  });
  expect(recorded.pixelCount).toBe(0);
  await expect(
    access(join(setup.project, ".idiom/baselines/studio.pixels")),
  ).rejects.toThrow();
  const reviewed = await reviewCommand({
    flow: "studio",
    project: setup.project,
    from: "plain",
    deterministicOnly: true,
  });
  expect(reviewed.publishedBudget).toBeUndefined();
});
