import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { runCompare } from "../src/compare/run.js";
import { validateAttachmentManifest } from "../src/verify/attachments.js";
import { writeBeforeAfterComposite } from "../src/verify/compare.js";
import {
  baselineProject,
  cleanHtml,
  missing,
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

const changedHtml = cleanHtml.replace(
  "<h1>Studio</h1>",
  '<h1>Studio</h1><p style="background:#c03030;color:#fff;padding:24px">A new banner</p>',
);

async function twoRuns() {
  const setup = await baselineProject({ required: [] });
  directories.push(setup.project);
  await writeFile(
    join(setup.project, ".idiom/flows/studio.json"),
    JSON.stringify({
      id: "studio",
      title: "Studio",
      intent: [],
      setup: [],
      states: ["editor", "changed"].map((id) => ({
        id,
        description: id,
        url: "/",
        expect: { selectorPresent: [] },
      })),
    }),
  );
  await storedBaselineRun(setup.project, "before-run", setup.commit, [
    { state: "editor" },
    { state: "changed" },
  ]);
  await storedBaselineRun(setup.project, "after-run", setup.commit, [
    { state: "editor" },
    { state: "changed", html: changedHtml, mismatches: [missing("#banner")] },
  ]);
  return setup;
}

test("compare writes a labelled composite only for the tuple that changed", async () => {
  const { project } = await twoRuns();
  const out = join(project, ".idiom/reports/compare-out");
  const result = await runCompare({
    flow: "studio",
    from: "after-run",
    against: "before-run",
    project,
    out,
  });
  expect(
    result.changed.map(({ state, kind, path, ordinal }) => ({
      state,
      kind,
      path,
      ordinal,
    })),
  ).toEqual([
    {
      state: "changed",
      kind: "idiom-before-after-001",
      path: "before-after-changed-desktop.png",
      ordinal: 1,
    },
  ]);
  expect(result.unchanged.map(({ state }) => state)).toEqual(["editor"]);
  const report = await readFile(join(out, "before-after.md"), "utf8");
  expect(report).toContain("## Unchanged tuples\n\n- editor / desktop");
  expect(report).not.toContain("before-after-editor-desktop.png");
  expect(report).toContain("idiom-verify-report");
  const manifest = JSON.parse(
    await readFile(join(out, "attachments.json"), "utf8"),
  );
  await validateAttachmentManifest({
    outputDirectory: out,
    manifest,
    requireFiles: true,
  });
  const composite = PNG.sync.read(
    await readFile(join(out, "before-after-changed-desktop.png")),
  );
  const shot = PNG.sync.read(
    await readFile(
      join(project, ".idiom/reports/after-run/changed/desktop/screenshot.png"),
    ),
  );
  expect(composite.height).toBe(shot.height + 48);
  expect(composite.width).toBe(shot.width * 2 + 8);
}, 60_000);

test("compare lists new findings, and swapping the runs lists them as fixed", async () => {
  const { project } = await twoRuns();
  const forward = await runCompare({
    flow: "studio",
    from: "after-run",
    against: "before-run",
    project,
    out: join(project, ".idiom/reports/forward"),
  });
  expect(forward.newFindings.map(({ category }) => category)).toContain(
    "missing-state",
  );
  expect(forward.fixedFindings).toEqual([]);
  const forwardReport = await readFile(forward.reportPath, "utf8");
  const newSection = forwardReport.slice(
    forwardReport.indexOf("## New findings"),
    forwardReport.indexOf("## Fixed findings"),
  );
  expect(newSection).toContain("missing-state");

  const backward = await runCompare({
    flow: "studio",
    from: "before-run",
    against: "after-run",
    project,
    out: join(project, ".idiom/reports/backward"),
  });
  expect(backward.newFindings).toEqual([]);
  expect(backward.fixedFindings.map(({ category }) => category)).toContain(
    "missing-state",
  );
  const backwardReport = await readFile(backward.reportPath, "utf8");
  expect(
    backwardReport.slice(backwardReport.indexOf("## Fixed findings")),
  ).toContain("missing-state");
}, 60_000);

test("compare refuses a foreign --out but replaces its own output", async () => {
  const { project } = await twoRuns();
  const foreign = join(project, ".idiom/reports/foreign");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "keep.txt"), "mine");
  await expect(
    runCompare({
      flow: "studio",
      from: "after-run",
      against: "before-run",
      project,
      out: foreign,
    }),
  ).rejects.toThrow(/ownership marker/);
  expect(await readFile(join(foreign, "keep.txt"), "utf8")).toBe("mine");

  const owned = join(project, ".idiom/reports/owned");
  const options = {
    flow: "studio",
    from: "after-run",
    against: "before-run",
    project,
    out: owned,
  };
  await runCompare(options);
  await runCompare(options);
  expect(await readFile(join(owned, ".idiom-compare-output"), "utf8")).toBe(
    "This directory is owned by idiom compare.\n",
  );
}, 60_000);

test("compare rejects a run of another flow and identical run ids", async () => {
  const { project } = await twoRuns();
  const metadata = join(
    project,
    ".idiom/reports/after-run/editor/desktop/metadata.json",
  );
  const record = JSON.parse(await readFile(metadata, "utf8"));
  record.flow.id = "elsewhere";
  await writeFile(metadata, JSON.stringify(record));
  await expect(
    runCompare({
      flow: "studio",
      from: "after-run",
      against: "before-run",
      project,
      out: join(project, ".idiom/reports/x"),
    }),
  ).rejects.toThrow(/does not match requested flow/);
  await expect(
    runCompare({
      flow: "studio",
      from: "before-run",
      against: "before-run",
      project,
    }),
  ).rejects.toThrow(/different runs/);
}, 60_000);

test("idiom compare prints the summary and exits 0", async () => {
  const { project } = await twoRuns();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "compare",
      "studio",
      "--project",
      project,
      "--from",
      "after-run",
      "--against",
      "before-run",
      "--out",
      join(project, ".idiom/reports/cli"),
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  );
  expect(stderr).toEqual([]);
  expect(code).toBe(0);
  expect(stdout.join("")).toMatch(
    /^Compared studio: 1 changed, 1 unchanged, \d+ new \/ 0 fixed finding\(s\) — .*before-after\.md/,
  );
}, 60_000);

function gradient(width: number, height: number, seed: number): Buffer {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = seed === 0 ? (offset / 4) % 256 : 20;
    image.data[offset + 1] = seed === 0 ? 80 : (offset / 4) % 256;
    image.data[offset + 2] = seed === 0 ? 160 : 60;
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
}

test("a composite without labels is byte-identical to the verify composite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-composite-"));
  directories.push(directory);
  const outputPath = join(directory, "composite.png");
  await writeBeforeAfterComposite({
    beforePath: "",
    afterPath: "",
    outputPath,
    beforeSource: gradient(120, 40, 0),
    afterSource: gradient(100, 50, 1),
  });
  // Rendered by the composite writer before labels existed.
  expect(
    createHash("sha256")
      .update(await readFile(outputPath))
      .digest("hex"),
  ).toBe("b8065c297579203ca02d00cdc8e5f47478d8436fce07ed93afcf3f2ae856aa65");
});
