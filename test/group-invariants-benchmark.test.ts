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
  {
    name: "page switcher",
    group: ".page-switcher",
    items: ".page-link",
    attribute: "data-project-id",
  },
];

test("group invariants name the stray pages and clear after repair (#41)", async () => {
  const before = (
    await reviewFixture(
      browser,
      await fixture("group-invariants-before.html"),
      {
        invariants,
      },
    )
  ).filter(({ candidate }) => candidate.category === "group-invariants");
  expect(before).toHaveLength(1);
  const explanation = before[0]?.candidate.explanation ?? "";
  expect(explanation).toContain("3 items");
  for (const stray of [
    "HVAC tune-up",
    "Apex Financial overview",
    "Dental tests",
  ])
    expect(explanation).toContain(stray);
  for (const member of ["Home", "Menu", "Locations"])
    expect(explanation).not.toContain(`"${member}"`);
  const after = await reviewFixture(
    browser,
    await fixture("group-invariants-after.html"),
    { invariants },
  );
  expect(
    after.filter(({ candidate }) => candidate.category === "group-invariants"),
  ).toEqual([]);
});
