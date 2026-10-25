import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fixture, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
test("motion fixture exposes snaps and slow fades, then passes with 120ms and a reduced-motion override", async () => {
  const before = await reviewFixture(
    browser,
    await fixture("motion-before.html"),
    { probe: true, reducedMotion: false },
  );
  expect(
    before.some(
      ({ candidate }) =>
        candidate.rule === "idiom:motion-no-transition" &&
        candidate.explanation.includes("Layers panel collapse: no transition"),
    ),
  ).toBe(true);
  expect(
    before.some(
      ({ candidate }) =>
        candidate.category === "motion" &&
        candidate.explanation.includes("400ms exceeds 150ms limit"),
    ),
  ).toBe(true);
  for (const reducedMotion of [false, true]) {
    const after = await reviewFixture(
      browser,
      await fixture("motion-after.html"),
      {
        probe: true,
        reducedMotion,
        checks: { motion: { durations: [120, 150] } },
      },
    );
    expect(
      after.filter(({ candidate }) => candidate.category === "motion"),
    ).toEqual([]);
  }
}, 30_000);
