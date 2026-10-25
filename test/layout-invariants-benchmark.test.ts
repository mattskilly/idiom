import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { InvariantInput } from "../src/schemas/invariant.js";
import { fixture, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

const invariants: InvariantInput[] = [
  { name: "controls", selector: ".ed-controls", height: 64 },
  { selector: ".panel", width: { min: 280, max: 480 } },
  {
    align: "bottom",
    selectors: [".drawer-head", ".ed-controls"],
    tolerance: 0,
  },
  { edge: ".canvas:top", equals: ".ed-controls:bottom", offset: 16 },
];

test("layout invariants catch the controls regression and clear after repair (#29)", async () => {
  const before = (
    await reviewFixture(
      browser,
      await fixture("layout-invariants-before.html"),
      { invariants },
    )
  ).filter(({ candidate }) => candidate.category === "layout-invariants");
  expect(before.map(({ candidate }) => candidate.explanation)).toContain(
    "controls height 85, expected 64",
  );
  expect(before.map(({ candidate }) => candidate.explanation)).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "bottom edges differ: .drawer-head 112, .ed-controls 133",
      ),
    ]),
  );
  expect(
    before.some(({ candidate }) => candidate.explanation.includes("offset")),
  ).toBe(true);
  const after = await reviewFixture(
    browser,
    await fixture("layout-invariants-after.html"),
    { invariants },
  );
  expect(
    after.filter(({ candidate }) => candidate.category === "layout-invariants"),
  ).toEqual([]);
});
