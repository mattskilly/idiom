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
  "idiom:empty-frame",
  "idiom:repeated-row-ornament",
  "idiom:glyph-over-icon",
]);
const html = (name: string) =>
  readFile(
    new URL(`./fixtures/frame-ornament/${name}.html`, import.meta.url),
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

test("an empty bordered header fails at desktop and passes at mobile, where its button shows", async () => {
  let observations: ObservationArtifact | undefined;
  const wide = await review("empty-header", {
    onObservations: (value) => {
      observations = value;
    },
  });
  expect(summary(wide)).toEqual([
    ["idiom:empty-frame", "minor", "header.app-header"],
  ]);
  expect(wide[0]?.explanation).toBe(
    "header.app-header is a 1280×64px box with a bottom border and nothing visible inside it at 1280px (1 child is hidden at this width).",
  );
  expect(wide[0]?.acceptance).toEqual([
    "At 1280px, header.app-header shows content, or is not drawn as a bordered or filled box when it has none.",
  ]);
  expect(wide[0]?.fingerprintHint).toBe("empty-frame:header.app-header");
  expect(wide[0]?.verification.params).toMatchObject({
    selector: "header.app-header",
    viewportWidth: 1280,
    paint: "border",
    borderSides: ["bottom"],
    hiddenChildren: 1,
  });
  expect(
    observations?.version === 2 ? observations.emptyFrames : undefined,
  ).toHaveLength(1);
  expect(await review("empty-header", { viewport: mobile })).toEqual([]);
});

test("spacers and same-background blocks are not empty frames", async () => {
  expect(await review("spacer")).toEqual([]);
});

test("icon-only toolbars, loading rows, named swatches, scrims, small chips, image tiles and faded-in content do not fire", async () => {
  expect(await review("near-miss-frames")).toEqual([]);
});

test("a state's intentionallyEmpty selector exempts an empty drop zone", async () => {
  expect(summary(await review("intentional-empty"))).toEqual([
    ["idiom:empty-frame", "minor", "#dropzone"],
  ]);
  expect(
    await review("intentional-empty", { intentionallyEmpty: ["#dropzone"] }),
  ).toEqual([]);
  expect(
    await review("intentional-empty", {
      checks: { emptyFrame: { ignore: ["#dropzone"] } },
    }),
  ).toEqual([]);
});

test("a rail whose every icon carries the same corner badge fires both rules", async () => {
  const found = await review("rail-badges");
  const glyphs = found.filter((c) => c.rule === "idiom:glyph-over-icon");
  expect(glyphs).toHaveLength(6);
  expect(glyphs.every((c) => c.severity === "minor")).toBe(true);
  expect(new Set(glyphs.map((c) => c.fingerprintHint)).size).toBe(6);
  const home = glyphs.find(
    (c) =>
      c.verification.params?.selectors !== undefined &&
      c.selectorHint.includes("a:nth-of-type(1)"),
  );
  expect(home?.explanation).toBe(
    "A 10×10px glyph (body > nav > a:nth-of-type(1) > span:nth-of-type(1) > svg:nth-of-type(2)) sits over the icon body > nav > a:nth-of-type(1) > span:nth-of-type(1) > svg:nth-of-type(1) inside the 56×56px control body > nav > a:nth-of-type(1) at 1280px, covering it with 49% of its own box.",
  );
  expect(home?.verification.params).toMatchObject({
    viewportWidth: 1280,
    glyphSize: { width: 10, height: 10 },
    ratio: 0.49,
  });
  const repeated = found.filter(
    (c) => c.rule === "idiom:repeated-row-ornament",
  );
  expect(summary(repeated)).toEqual([
    ["idiom:repeated-row-ornament", "info", 'nav[aria-label="Workspace"]'],
  ]);
  expect(repeated[0]?.explanation).toMatch(
    /^The "ext" icon \(.+\) repeats on 6 of 6 items in nav\[aria-label="Workspace"\]; a mark every item carries does not tell items apart\.$/,
  );
  expect(repeated[0]?.verification.params).toMatchObject({
    collectionKind: "rail",
    kind: "icon",
    count: 6,
    items: 6,
  });
});

test("a list-wrapped rail is one collection; a chip inside the row link counts, a secondary button's icon does not", async () => {
  const found = await review("rail-badges-list");
  const repeated = found.filter(
    (c) => c.rule === "idiom:repeated-row-ornament",
  );
  expect(
    repeated.map((c) => [c.selectorHint, c.verification.params?.name]).sort(),
  ).toEqual(
    [
      ["body > nav > ul", "ext"],
      ["ul.projects", "Beta"],
    ].sort(),
  );
  const beta = repeated.find((c) => c.selectorHint === "ul.projects");
  expect(beta?.explanation).toMatch(
    /^The "Beta" badge \(.+\) repeats on 6 of 6 items in ul\.projects;/,
  );
  expect(found.some((c) => c.explanation.includes("more-icon"))).toBe(false);
  expect(found.filter((c) => c.rule === "idiom:glyph-over-icon")).toHaveLength(
    6,
  );
});

test("badges beside labels, on some items, and unread counts over an icon do not fire", async () => {
  expect(await review("rail-clean")).toEqual([]);
});

test("an identical icon inside each row's own action button is not a row ornament", async () => {
  expect(await review("row-actions")).toEqual([]);
});

test("a status column with differing values passes; an identical chip on every row is info", async () => {
  const found = await review("status-column");
  expect(summary(found)).toEqual([
    ["idiom:repeated-row-ornament", "info", "ul.updates"],
  ]);
  expect(found[0]?.explanation).toMatch(
    /^The "New" badge \(.+\) repeats on 6 of 6 items in ul\.updates;/,
  );
});
