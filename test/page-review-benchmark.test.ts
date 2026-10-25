import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type ReviewedFixture, reviewFixture } from "./benchmark-support.js";

const directory = join(import.meta.dirname, "fixtures/page-review");
const page = (name: string) => readFile(join(directory, name), "utf8");

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

const pageContent = (findings: ReviewedFixture) =>
  findings
    .filter(({ candidate }) => candidate.category === "page-content")
    .map(({ candidate }) => [candidate.rule, candidate.fingerprintHint]);

test("page-content benchmark reports the planted defects on before and nothing on after", async () => {
  const brief = await page("brief.md");
  const before = await reviewFixture(browser, await page("before.html"), {
    checks: { page: {} },
    brief,
    axe: true,
  });
  expect(pageContent(before)).toEqual([
    ["idiom:placeholder-text", "Lorem ipsum"],
    ["idiom:missing-hero-cta", undefined],
    ["idiom:missing-final-cta", undefined],
    ["axe:image-alt", undefined],
    ["idiom:unsupported-claim", "12000+teams"],
    ["idiom:unsupported-claim", "87%"],
  ]);
  expect(
    before
      .filter(({ candidate }) => candidate.category === "heading-structure")
      .map(({ candidate }) => candidate.rule),
  ).toContain("idiom:multiple-h1");

  const after = await reviewFixture(browser, await page("after.html"), {
    checks: { page: {} },
    brief,
    axe: true,
  });
  expect(pageContent(after)).toEqual([]);
  expect(
    after.filter(({ candidate }) => candidate.category === "heading-structure"),
  ).toEqual([]);
});

test("page-content is skipped without page review, so flows are unaffected", async () => {
  const before = await reviewFixture(browser, await page("before.html"), {
    axe: true,
  });
  expect(pageContent(before)).toEqual([]);
});

test("checks.page.ctaSelectors resolve at capture and replace the CTA heuristic", async () => {
  const html = (await page("after.html")).replace(
    '<a class="button" href="/start">Start your page</a>',
    '<a class="cta" href="/start">Start your page</a>',
  );
  const heuristic = await reviewFixture(browser, html, {
    checks: { page: {} },
  });
  expect(pageContent(heuristic)).toEqual([
    ["idiom:missing-hero-cta", undefined],
  ]);
  const configured = await reviewFixture(browser, html, {
    checks: { page: { ctaSelectors: [".cta", ".button"] } },
  });
  expect(pageContent(configured)).toEqual([]);
});
