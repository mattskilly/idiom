import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fixture, reviewFixture } from "./benchmark-support.js";

/**
 * The craft rules (file-170) must add no findings to the saved benchmark,
 * page-review and structural pages, with the keyboard focus sweep on.
 *
 * One genuine defect is pinned rather than tuned away: the page-review
 * fixture's hero image is a truncated GIF data URI (no image data), so the
 * browser really does render a broken image there.
 */
const genuine = new Set([
  "page-review/before.html broken-image",
  "page-review/after.html broken-image",
]);
const craftCategories = new Set([
  "font-loading",
  "broken-link",
  "focus-visible",
  "line-length",
  "orphan-word",
  "image-distortion",
  "broken-image",
  "layout-shift",
]);

const checks = {
  explanation: "visible",
  components: [
    { name: "override dot", selector: ".bp-override-dot", width: 8, height: 8 },
  ],
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const fixtures = join(import.meta.dirname, "fixtures");
const pages = async () => [
  ...(await readdir(join(fixtures, "benchmark")))
    .filter((name) => name.endsWith(".html"))
    .map((name) => ({ name: `benchmark/${name}`, load: () => fixture(name) })),
  ...(
    await Promise.all(
      ["page-review", "structural"].map(async (directory) =>
        (
          await readdir(join(fixtures, directory))
        )
          .filter((name) => name.endsWith(".html"))
          .map((name) => ({
            name: `${directory}/${name}`,
            load: () => readFile(join(fixtures, directory, name), "utf8"),
          })),
      ),
    )
  ).flat(),
];

test("saved pages gain no craft-rule findings", {
  timeout: 240_000,
}, async () => {
  const noise: string[] = [];
  const found = new Set<string>();
  for (const page of await pages()) {
    const findings = await reviewFixture(browser, await page.load(), {
      checks,
      focusSweep: true,
    });
    for (const { candidate } of findings) {
      found.add(`${page.name} ${candidate.category}`);
      if (
        craftCategories.has(candidate.category) &&
        !genuine.has(`${page.name} ${candidate.category}`)
      )
        noise.push(
          `${page.name}: ${candidate.category} ${candidate.explanation}`,
        );
    }
  }
  expect(noise).toEqual([]);
  for (const key of genuine) expect(found).toContain(key);
});
