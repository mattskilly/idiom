import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { inlineReportImages, pngDataUri } from "../src/report/html.js";
import { renderReviewHtmlReport } from "../src/review/html-report.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("inlines report images smallest first until the byte budget is spent", async () => {
  const run = await mkdtemp(join(tmpdir(), "inline-images-"));
  directories.push(run);
  await mkdir(join(run, "home", "desktop"), { recursive: true });
  const files = {
    "home/desktop/screenshot.png": Buffer.alloc(60, 1),
    "home/desktop/crop-a.png": Buffer.alloc(10, 2),
    "home/desktop/crop-b.png": Buffer.alloc(20, 3),
  };
  for (const [path, bytes] of Object.entries(files))
    await writeFile(join(run, path), bytes);

  const inlined = await inlineReportImages(run, Object.keys(files), 40);

  expect([...inlined.keys()].sort()).toEqual([
    "home/desktop/crop-a.png",
    "home/desktop/crop-b.png",
  ]);
  expect(inlined.get("home/desktop/crop-a.png")).toBe(
    pngDataUri(files["home/desktop/crop-a.png"]),
  );
  expect(inlined.has("home/desktop/screenshot.png")).toBe(false);
});

test("links a tuple screenshot the report could not inline", () => {
  const html = renderReviewHtmlReport({
    flow: "site",
    commit: "abc1234",
    coverage: [],
    outcome: { kind: "deterministic-only" },
    findings: [],
    tuples: [
      {
        state: "rules",
        viewport: "desktop",
        width: 1440,
        height: 900,
        screenshotPath: "rules/desktop/screenshot.png",
      },
    ],
    screenshots: new Map(),
  } as unknown as Parameters<typeof renderReviewHtmlReport>[0]);
  expect(html).toContain('href="rules/desktop/screenshot.png"');
  expect(html).toContain("too large to inline");
  expect(html).not.toContain('<img class="screenshot"');
});
