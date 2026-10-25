import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fixture, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

const ours = new Set(["disguised-control", "fresh-state"]);

const reported = async (name: string, fresh?: boolean) =>
  (
    await reviewFixture(browser, await fixture(name), {
      state: "first-load",
      ...(fresh === undefined ? {} : { fresh }),
    })
  )
    .map(({ candidate }) => candidate)
    .filter((candidate) => ours.has(candidate.category));

test("a disguised composer button, a readonly field and an enabled Undo are caught on a fresh state (#33)", async () => {
  const before = await reported("fresh-state-before.html", true);
  const found = before.map(
    (candidate) => `${candidate.rule} ${candidate.selectorHint}`,
  );
  expect(found).toEqual(
    expect.arrayContaining([
      "idiom:disguised-control #inspector-describe",
      "idiom:input-rejects-text #slug",
      "idiom:fresh-history-enabled #undo",
    ]),
  );
  expect(found).toHaveLength(3);
  const selectors = before.map((candidate) => candidate.selectorHint);
  for (const quiet of ["#site-search", "#save-as", "#theme", "#redo"])
    expect(selectors).not.toContain(quiet);
  expect(
    before.find((candidate) => candidate.selectorHint === "#inspector-describe")
      ?.explanation,
  ).toContain('"Describe a change"');
});

test("the repaired view reports nothing from the new checks (#33)", async () => {
  expect(await reported("fresh-state-after.html", true)).toEqual([]);
});

test("history controls are not judged on states not declared fresh (#33)", async () => {
  const before = await reported("fresh-state-before.html");
  expect(
    before.filter((candidate) => candidate.category === "fresh-state"),
  ).toEqual([]);
});

test("configured selectors are resolved at capture and honoured at review (#33)", async () => {
  const found = (
    await reviewFixture(browser, await fixture("fresh-state-before.html"), {
      fresh: true,
      checks: {
        disguisedControl: { ignore: [".describe-field"] },
        freshState: { unsavedSelectors: ["#save-as"] },
      },
    })
  )
    .map(({ candidate }) => candidate)
    .filter((candidate) => ours.has(candidate.category))
    .map((candidate) => `${candidate.rule} ${candidate.selectorHint}`);
  expect(found).not.toContain("idiom:disguised-control #inspector-describe");
  expect(found).toContain("idiom:fresh-unsaved-indicator #save-as");
});
