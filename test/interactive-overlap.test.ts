import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { reviewStates } from "./benchmark-support.js";

let browser: Browser;
let fieldHtml: string;
beforeAll(async () => {
  browser = await chromium.launch();
  fieldHtml = await readFile(
    join(import.meta.dirname, "fixtures/interactive-overlap/field.html"),
    "utf8",
  );
});
afterAll(async () => {
  await browser.close();
});

async function overlaps() {
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "field", html: fieldHtml }],
    { viewport: { width: 390, height: 844 } },
  );
  return {
    found: findings
      .map(({ candidate }) => candidate)
      .filter(
        (candidate) =>
          candidate.rule === "idiom:interactive-overlap" ||
          candidate.rule === "idiom:elements-overlap",
      ),
    tuples,
  };
}

const naming = (
  found: Awaited<ReturnType<typeof overlaps>>["found"],
  selector: string,
) => found.filter((candidate) => candidate.selectorHint?.includes(selector));

test("an input group's 1px shared border is quiet; real overlaps are still reported", async () => {
  const { found, tuples } = await overlaps();
  const elements = tuples[0]?.observations?.elements ?? [];
  const promo = elements.find((element) => element.selector === "#promo-code");
  const redeem = elements.find((element) => element.selector === "#redeem");
  // The capture really does see the collapsed border as a 1px overlap.
  expect(promo?.hitTestWith).toContain("#redeem");
  expect(
    (promo?.rect.x ?? 0) + (promo?.rect.width ?? 0) - (redeem?.rect.x ?? 0),
  ).toBeCloseTo(1, 1);

  expect(naming(found, "#redeem")).toEqual([]);
  expect(
    naming(found, "#stolen-submit").map(
      (candidate) => `${candidate.rule} ${candidate.severity}`,
    ),
  ).toEqual(["idiom:interactive-overlap major"]);
  expect(
    naming(found, "#pill-week").map(
      (candidate) => `${candidate.rule} ${candidate.severity}`,
    ),
  ).toEqual(["idiom:interactive-overlap major"]);
});
