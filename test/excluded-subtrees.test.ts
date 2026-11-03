import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isSpacingEligible } from "../src/checks/shared.js";
import type { ObservedElement } from "../src/checks/types.js";
import { reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

const html = await readFile(
  join(import.meta.dirname, "fixtures/benchmark/closed-details-spacing.html"),
  "utf8",
);

test("spacing rules skip closed details, hidden, inert and content-visibility-hidden subtrees", async () => {
  let elements: ObservedElement[] = [];
  const found = (
    await reviewFixture(browser, html, {
      checks: { scales: { spacing: [0, 4, 8, 12, 16, 24, 32] } },
      onObservations: (observations) => {
        elements = observations.elements;
      },
    })
  ).map(({ candidate }) => candidate);
  // The same cramped group outside them is still found.
  expect(
    found
      .filter((c) => c.category === "field-group")
      .map((c) => c.selectorHint)
      .sort(),
  ).toEqual(["#name", "#name-hint"]);
  // Off-scale spacing counts only the visible note, never the excluded copies.
  const offScale = found.filter((c) => c.rule === "idiom:off-scale-spacing");
  expect(offScale).toHaveLength(3);
  for (const finding of offScale)
    expect(finding.explanation).toMatch(/^1 elements use/);
  const reason = (selector: string) =>
    elements.find((element) => element.selector === selector)?.spacingExcluded;
  expect(reason("#proxy")).toBe("closed-details");
  expect(reason("#region")).toBe("inert");
  expect(reason("#cache")).toBe("content-visibility-hidden");
  expect(reason("#name")).toBeUndefined();
  // A closed disclosure's summary is still measured.
  const summary = elements.find((element) => element.tag === "summary");
  expect(summary?.spacingExcluded).toBeUndefined();
}, 60_000);

test("artifacts captured before exclusions drop excluded members at check time", async () => {
  const found = (
    await reviewFixture(browser, html, {
      onObservations: (observations) => {
        if (observations.version !== 2) return;
        // The capture's field group still lists #name; the check drops it.
        const inert = observations.elements.find(
          (element) => element.selector === "#name",
        );
        if (inert) inert.spacingExcluded = "inert";
      },
    })
  )
    .map(({ candidate }) => candidate)
    .filter((c) => c.category === "field-group");
  expect(found.map((c) => c.selectorHint)).toEqual([]);
}, 60_000);

test("isSpacingEligible needs a painted element outside every excluded subtree", () => {
  const element = { painted: { value: true } } as ObservedElement;
  expect(isSpacingEligible(element)).toBe(true);
  // Older artifacts carry neither fact and stay eligible.
  expect(isSpacingEligible({} as ObservedElement)).toBe(true);
  expect(
    isSpacingEligible({
      painted: { value: false, reason: "closed-details" },
    } as ObservedElement),
  ).toBe(false);
  expect(isSpacingEligible({ ...element, spacingExcluded: "inert" })).toBe(
    false,
  );
});
