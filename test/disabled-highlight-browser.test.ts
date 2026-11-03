import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ObservationArtifact, ProbeResult } from "../src/checks/types.js";
import { reviewFixture } from "./benchmark-support.js";

/** Consumer upgrade request #122: a disabled "Paste" row with a hover highlight. */
const directory = join(import.meta.dirname, "fixtures/disabled-highlight");

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

async function review(name: string) {
  const html = await readFile(join(directory, name), "utf8");
  let results: ProbeResult[] = [];
  const findings = await reviewFixture(browser, html, {
    probe: true,
    onObservations: (observations: ObservationArtifact) => {
      if (observations.version === 2)
        results = observations.probe?.results ?? [];
    },
  });
  const highlights = findings
    .map(({ candidate }) => candidate)
    .filter((candidate) => candidate.category === "disabled-highlight");
  const result = (selector: string) =>
    results.find((entry) => entry.selector === selector);
  return { highlights, result };
}

test("a disabled menu row that takes the enabled rows' hover highlight is reported", async () => {
  const { highlights, result } = await review("menu.html");
  expect(highlights).toHaveLength(1);
  expect(highlights[0]?.rule).toBe("idiom:disabled-row-highlight");
  expect(highlights[0]?.explanation).toContain('"Paste"');
  expect(highlights[0]?.explanation).toContain("rgb(232, 232, 232)");
  const menu = result("#edit")?.menu;
  expect(menu?.items.map((item) => [item.name, item.disabled])).toEqual([
    ["Copy", false],
    ["Paste", true],
  ]);
  expect(menu?.hover?.length).toBe(2);
}, 60_000);

test("disabled rows that keep their resting colours are not reported", async () => {
  const { highlights, result } = await review("clean.html");
  expect(highlights).toEqual([]);
  expect(result("#edit")?.menu?.hover?.length).toBe(2);
  expect(result("#insert")?.menu?.hover?.length).toBe(2);
}, 60_000);
