import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isOffScreen } from "../src/checks/shared.js";
import type { ObservedElement } from "../src/checks/types.js";
import { reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

const fixture = (name: string) =>
  readFile(join(import.meta.dirname, "fixtures/spacing-rhythm", name), "utf8");
const rhythm = async (html: string) =>
  (await reviewFixture(browser, html))
    .map(({ candidate }) => candidate)
    .filter((candidate) => candidate.category === "spacing-rhythm")
    .map((candidate) => candidate.explanation);

test("a hugging wrapper's own edges and an off-screen skip link are not rhythm outliers", async () => {
  expect(await rhythm(await fixture("hugging-and-skip-link.html"))).toEqual([]);
});

test("a padded container edge and a real outlier are still measured", async () => {
  const html = await fixture("hugging-and-skip-link.html");
  // Two pixels of padding is a choice, not content reaching the edge.
  const padded = await rhythm(
    html.replace(
      "section.hug { padding: 0;",
      "section.hug { padding: 2px 0 0;",
    ),
  );
  expect(padded).toEqual([
    expect.stringMatching(
      /section:nth-of-type\(4\) > a has 2 CSS px clearance above it to container top edge at section\.hug/,
    ),
  ]);
  // The outlying row in the settings fixture still reports, against its rule.
  expect(await rhythm(await fixture("settings.html"))).toEqual([
    expect.stringMatching(/0 CSS px clearance below it to rule at/),
  ]);
});

test("isOffScreen covers left, right and top parking but not partial overlap", () => {
  const artifact = { document: { scrollWidth: 800 } };
  const at = (x: number, y: number) =>
    ({ rect: { x, y, width: 100, height: 30 } }) as ObservedElement;
  expect(isOffScreen(at(-9999, 10), artifact)).toBe(true);
  expect(isOffScreen(at(800, 10), artifact)).toBe(true);
  expect(isOffScreen(at(8, -40), artifact)).toBe(true);
  expect(isOffScreen(at(-50, 10), artifact)).toBe(false);
  expect(isOffScreen(at(8, -20), artifact)).toBe(false);
  expect(isOffScreen(at(8, 2000), artifact)).toBe(false);
});
