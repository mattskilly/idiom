import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

const load = (name: string) =>
  readFile(join(import.meta.dirname, "fixtures", name), "utf8");
const viewport = { width: 1280, height: 800 };

async function budget(name: string, published: boolean) {
  const findings = await reviewFixture(browser, await load(name), {
    viewport,
    images: true,
    ...(published ? { published: {} } : {}),
  });
  return findings
    .map(({ candidate }) => candidate)
    .filter((candidate) => candidate.category === "published-budget");
}

test("a published page 1352px wide at 1280 with a broken image fails", async () => {
  const findings = await budget("published-before.html", true);
  const overflow = findings.find(
    (finding) => finding.rule === "published:document-overflow",
  );
  expect(overflow?.severity).toBe("blocker");
  expect(overflow?.explanation).toContain("1352px");
  const image = findings.find(
    (finding) => finding.rule === "published:broken-image",
  );
  expect(image?.explanation).toContain("http://127.0.0.1:9/missing-hero.png");
});

test("the fixed published page reports nothing from the budget", async () => {
  expect(await budget("published-after.html", true)).toEqual([]);
});

test("the budget does not run on a flow that is not published", async () => {
  expect(await budget("published-before.html", false)).toEqual([]);
});
