import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ObservationArtifact } from "../src/checks/types.js";
import { reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

const viewport = { width: 1280, height: 800 };
const rules = new Set([
  "idiom:empty-frame",
  "idiom:nested-border",
  "idiom:browser-default-style",
]);
const fixture = (name: string) =>
  join(import.meta.dirname, `fixtures/tile-picker/${name}.html`);

async function review(name: string) {
  let observations: ObservationArtifact | undefined;
  const html = await readFile(fixture(name), "utf8");
  const found = await reviewFixture(browser, html, {
    viewport,
    onObservations: (value) => {
      observations = value;
    },
  });
  const candidates = found
    .map((f) => f.candidate)
    .filter((candidate) => rules.has(candidate.rule));
  if (observations?.version !== 2) throw Error("missing V2 observations");
  return { candidates, observations, html };
}

const summary = (
  candidates: Awaited<ReturnType<typeof review>>["candidates"],
) => candidates.map((c) => [c.rule, c.selectorHint]).sort();

const evidence: Record<string, unknown> = {};

test("the half-empty photo-look picker fires empty-frame, nested-border and browser-default-style once each", async () => {
  const { candidates, observations } = await review("picker");
  evidence.before = candidates;
  expect(summary(candidates)).toEqual([
    ["idiom:browser-default-style", "body > main > aside > fieldset > legend"],
    ["idiom:empty-frame", 'button[aria-label="Natural"]'],
    ["idiom:nested-border", 'button[aria-label="Vivid"]'],
  ]);
  const empty = candidates.find((c) => c.rule === "idiom:empty-frame");
  expect(empty?.explanation).toBe(
    'button[aria-label="Natural"] is a 93×40px frame whose 28×28px media (body > main > aside > fieldset > div > button:nth-of-type(1) > img) fills 23% of it, leaving 77% empty to its right at 1280px (3 sibling frames in div.tiles do the same).',
  );
  expect(empty?.fingerprintHint).toBe("empty-frame:underfilled:div.tiles");
  expect(empty?.verification.params).toMatchObject({
    count: 3,
    side: "right",
    mediaWidth: 28,
    mediaHeight: 28,
  });
  expect(Number(empty?.verification.params?.emptyShare)).toBeGreaterThanOrEqual(
    0.65,
  );
  const nested = candidates.find((c) => c.rule === "idiom:nested-border");
  expect(nested?.explanation).toContain("is selected (aria-pressed)");
  expect(nested?.explanation).toContain("so the choice shows two rings.");
  expect(nested?.verification.params).toMatchObject({ marker: "aria-pressed" });
  const legend = candidates.find(
    (c) => c.rule === "idiom:browser-default-style",
  );
  expect(legend?.fingerprintHint).toBe("browser-default-style:legend");
  expect(observations.underfilledFrames?.map((f) => f.selector)).toEqual([
    'button[aria-label="Natural"]',
    'button[aria-label="Vivid"]',
    'button[aria-label="Mono"]',
  ]);
  expect(
    observations.underfilledFrames?.every((f) => f.group === "div.tiles"),
  ).toBe(true);
  expect(observations.browserDefaultLegends).toEqual({
    count: 1,
    records: [
      {
        selector: "body > main > aside > fieldset > legend",
        fieldset: "body > main > aside > fieldset",
        text: "Photo look",
      },
    ],
  });
});

test("the corrected picker (filled photos, one ring, a plain heading) fires none of the three", async () => {
  const { candidates, observations } = await review("picker-fixed");
  evidence.after = candidates;
  expect(candidates).toEqual([]);
  expect(observations.underfilledFrames).toEqual([]);
  expect(observations.browserDefaultLegends).toEqual({ count: 0, records: [] });
});

test("media pinned off-centre on the open axis is recorded; media centred on both axes is not", async () => {
  const { observations } = await review("shapes");
  expect(
    observations.underfilledFrames?.map((f) => [f.selector, f.side]),
  ).toEqual([
    ['button[aria-label="Left one"]', "right"],
    ['button[aria-label="Top one"]', "bottom"],
  ]);
});

// Opt-in evidence (IDIOM_UPDATE_TILE_PICKER=1): the findings before and
// after the correction, and full-page captures of both fixtures.
afterAll(async () => {
  if (process.env.IDIOM_UPDATE_TILE_PICKER !== "1") return;
  const out = join(import.meta.dirname, "../docs/field-test");
  await mkdir(join(out, "tile-picker"), { recursive: true });
  for (const [name, file] of [
    ["before", "picker"],
    ["after", "picker-fixed"],
  ] as const) {
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(await readFile(fixture(file), "utf8"), {
        waitUntil: "load",
      });
      await page.screenshot({
        path: join(out, "tile-picker", `${name}.png`),
        fullPage: true,
      });
    } finally {
      await page.close();
    }
  }
  const pick = (value: unknown) =>
    ((value as Array<Record<string, unknown>> | undefined) ?? []).map((c) => ({
      rule: c.rule,
      selector: c.selectorHint,
      explanation: c.explanation,
    }));
  await writeFile(
    join(out, "tile-picker.json"),
    `${JSON.stringify(
      {
        description:
          "The half-empty photo-look picker (test/fixtures/tile-picker/picker.html) and its correction (picker-fixed.html) at 1280×800, through the real capture and the empty-frame, nested-border and browser-default-style checks. Screenshots: tile-picker/before.png, tile-picker/after.png.",
        before: pick(evidence.before),
        after: pick(evidence.after),
      },
      null,
      2,
    )}\n`,
  );
});
