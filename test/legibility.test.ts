import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ObservationArtifact } from "../src/checks/types.js";
import { type ReviewOptions, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

const desktop = { width: 1280, height: 800 };
const mobile = { width: 390, height: 844 };
const rules = new Set([
  "idiom:hidden-at-rest",
  "idiom:edge-text",
  "idiom:cramped-padding",
  "idiom:heading-rhythm",
  "idiom:type-legibility",
  "idiom:numeric-align",
  "idiom:ragged-row",
  "idiom:text-occlusion",
]);
const html = (name: string) =>
  readFile(
    new URL(`./fixtures/legibility/${name}.html`, import.meta.url),
    "utf8",
  );
async function review(name: string, options: ReviewOptions = {}) {
  const found = await reviewFixture(browser, await html(name), {
    viewport: desktop,
    ...options,
  });
  return found
    .map((f) => f.candidate)
    .filter((candidate) => rules.has(candidate.rule));
}
const summary = (found: Awaited<ReturnType<typeof review>>) =>
  found.map((c) => [c.rule, c.severity, c.selectorHint]).sort();
async function passes(name: string, options: ReviewOptions = {}) {
  for (const viewport of [desktop, mobile])
    expect(
      summary(await review(name, { viewport, ...options })),
      `${name} at ${viewport.width}`,
    ).toEqual([]);
}

test("text left at opacity 0 by a reveal that never ran is hidden at rest", async () => {
  let observations: ObservationArtifact | undefined;
  const found = await review("reveal-stuck", {
    onObservations: (value) => {
      observations = value;
    },
  });
  expect(summary(found)).toEqual([
    ["idiom:hidden-at-rest", "minor", "div.reveal"],
  ]);
  expect(found[0]?.fingerprintHint).toBe("hidden-at-rest:div.reveal");
  expect(found[0]?.explanation).toContain(
    "5 of 6 text blocks in the viewport (83% by count",
  );
  expect(found[0]?.verification.params).toMatchObject({
    root: "div.reveal",
    total: 6,
    hidden: 5,
  });
  expect(
    observations?.version === 2 ? observations.hiddenAtRest : undefined,
  ).toMatchObject({ status: "ran", total: 6, hidden: 5, inFlight: 0 });
  expect(summary(await review("reveal-stuck", { viewport: mobile }))).toEqual([
    ["idiom:hidden-at-rest", "minor", "div.reveal"],
  ]);
});

test("revealed content, and hidden menus, sr-only text, closed details and declared content are not hidden at rest", async () => {
  await passes("reveal-done");
  await passes("hidden-near-miss", { intentionallyHidden: ["#later"] });
  // Without the declaration the faded block is more than a fifth of the text.
  expect(summary(await review("hidden-near-miss"))).toEqual([
    ["idiom:hidden-at-rest", "minor", "#later"],
  ]);
});

test("body text 8px from the viewport's edge is edge text at both widths", async () => {
  const wide = await review("edge-flush");
  expect(summary(wide)).toEqual([["idiom:edge-text", "minor", "body > p"]]);
  expect(wide[0]?.explanation).toContain("8px from the left edge");
  expect(wide[0]?.explanation).toContain("at least 16px");
  const narrow = await review("edge-flush", { viewport: mobile });
  expect(narrow[0]?.explanation).toContain("at least 12px");
  await passes("edge-padded");
});

test("a paragraph that opens with an inline element is one edge-text finding", async () => {
  expect(summary(await review("edge-inline-lead"))).toEqual([
    ["idiom:edge-text", "minor", "body > p"],
  ]);
});

test("13px from the edge passes the 12px narrow minimum, and a full-bleed caption is exempt", async () => {
  expect(summary(await review("edge-near-miss", { viewport: mobile }))).toEqual(
    [],
  );
  // The same 13px is under the 16px minimum at desktop width.
  expect(summary(await review("edge-near-miss"))).toEqual([
    ["idiom:edge-text", "minor", "body > p"],
  ]);
});

test("text 2px inside a bordered card is cramped", async () => {
  const found = await review("cramped-card");
  expect(summary(found)).toEqual([
    ["idiom:cramped-padding", "minor", "div.card"],
  ]);
  expect(found[0]?.verification.params).toMatchObject({
    side: "left",
    distance: 2,
    min: 4,
  });
  await passes("padded-card");
  // Exactly 4px, a 20px badge with 1px padding, and a box with only a
  // bottom border (text flush with its undrawn left side).
  await passes("cramped-near-miss");
});

test("a heading closer to the block above than to its content breaks the rhythm", async () => {
  const found = await review("heading-tight-above");
  expect(summary(found)).toEqual([
    ["idiom:heading-rhythm", "minor", "body > article > h2"],
  ]);
  expect(found[0]?.verification.params).toMatchObject({
    gapAbove: 8,
    gapBelow: 24,
  });
  await passes("heading-good");
  // 17px above and 16px below; a small eyebrow tight above a heading.
  await passes("heading-near-miss");
});

test("a heading opening the second of two sibling sections is judged", async () => {
  const found = await review("heading-sections");
  expect(summary(found)).toEqual([
    [
      "idiom:heading-rhythm",
      "minor",
      "body > main > section:nth-of-type(2) > h2",
    ],
  ]);
  expect(found[0]?.verification.params).toMatchObject({
    gapAbove: 8,
    gapBelow: 24,
  });
});

test("small, tight, justified, shouted and tracked body text each report once", async () => {
  const found = await review("type-bad");
  expect(found.map((c) => c.verification.params?.reason).sort()).toEqual([
    "all-caps",
    "justified",
    "letter-spacing",
    "small-body",
    "tight-leading",
  ]);
  expect(found.every((c) => c.severity === "minor")).toBe(true);
  expect(found.map((c) => c.fingerprintHint).sort()).toEqual([
    "type-legibility:all-caps",
    "type-legibility:justified",
    "type-legibility:letter-spacing:0.15",
    "type-legibility:small-body:11",
    "type-legibility:tight-leading:1",
  ]);
  await passes("type-good");
  // 12px body, an 11px label, 1.2 leading, a 30-character caps run, 0.1em.
  await passes("type-near-miss");
});

test("a left-aligned, proportional amounts column is reported once", async () => {
  const found = await review("numbers-left");
  expect(summary(found)).toEqual([
    ["idiom:numeric-align", "minor", "table.invoice"],
  ]);
  expect(found[0]?.verification.params).toMatchObject({
    column: 1,
    problems: ["left-aligned", "proportional-figures"],
  });
  expect(found[0]?.explanation).toContain('the "Amount" column');
  await passes("numbers-right-tabular");
  // Dates, ticket ids, a 2-of-5 numeric column and right-aligned monospace.
  await passes("numbers-near-miss");
});

test("cards in one row ending far apart are ragged", async () => {
  const found = await review("ragged-cards");
  expect(summary(found)).toEqual([["idiom:ragged-row", "minor", "div.plans"]]);
  expect(found[0]?.fingerprintHint).toBe("ragged-row:div.plans:0");
  await passes("even-cards");
  // Bottoms exactly 8px apart, and a multi-column masonry wall.
  await passes("ragged-near-miss");
});

test("an opaque image over half a paragraph occludes its text", async () => {
  const found = await review("occluded-text");
  expect(summary(found)).toEqual([["idiom:text-occlusion", "minor", "p.copy"]]);
  expect(found[0]?.verification.params).toMatchObject({ cover: "img.stamp" });
  await passes("clear-text");
  // A cover over a fifth of the text, a translucent scrim and an open dialog.
  await passes("occlusion-near-miss");
});

test("disabled rules record no evidence and report skipped", async () => {
  let observations: ObservationArtifact | undefined;
  const found = await review("reveal-stuck", {
    checks: {
      hiddenAtRest: { enabled: false },
      textOcclusion: { enabled: false },
    },
    onObservations: (value) => {
      observations = value;
    },
  });
  expect(found).toEqual([]);
  expect(
    observations?.version === 2
      ? [observations.hiddenAtRest, observations.textOcclusions]
      : "v1",
  ).toEqual([undefined, undefined]);
  expect(
    observations?.version === 2 ? observations.edgeTexts?.status : undefined,
  ).toBe("ran");
});
