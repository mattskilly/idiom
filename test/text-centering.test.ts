import { readFile } from "node:fs/promises";
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
  await browser.close();
});
const fixture = () =>
  readFile(
    join(import.meta.dirname, "fixtures/text-centering/glyph-buttons.html"),
    "utf8",
  );
const centering = (findings: Awaited<ReturnType<typeof reviewFixture>>) =>
  findings
    .map(({ candidate }) => candidate)
    .filter((c) => c.category === "text-centering");

test("one-sided decoration uses the content box while filled chips retain their edges", async () => {
  const html = await readFile(
    join(
      import.meta.dirname,
      "fixtures/text-centering/one-sided-decoration.html",
    ),
    "utf8",
  );
  const found = centering(await reviewFixture(browser, html));
  expect(found.map((c) => c.selectorHint).sort()).toEqual([
    "#filled-pad",
    "#underline-off",
  ]);
  expect(
    found.find((c) => c.selectorHint === "#underline-off")?.explanation,
  ).toContain("content box");
});

test("hidden labels and centred glyphs are not reported; off-centre glyphs and chips are (dogfooding requests #59, #71)", async () => {
  let observations: ObservationArtifact | undefined;
  const found = centering(
    await reviewFixture(browser, await fixture(), {
      onObservations: (value) => {
        observations = value;
      },
    }),
  );
  expect(found.map((c) => c.selectorHint).sort()).toEqual([
    "#chip",
    "#plus-off",
  ]);
  const plusOff = found.find((c) => c.selectorHint === "#plus-off");
  expect(plusOff?.explanation).toContain('"+"');
  expect(plusOff?.explanation).toContain("below");

  const signals = (selector: string) => {
    if (observations === undefined || observations.version !== 2)
      throw new Error("expected v2 observations");
    return observations.elements.find(
      (element) => element.selector === selector,
    )?.signals;
  };
  expect(signals("#send")?.labelInk).toEqual({ text: "", lineCount: 0 });
  expect(signals("#send-vh")?.labelInk).toEqual({ text: "", lineCount: 0 });
  expect(signals("#plus")?.labelInk?.glyph).toBe(true);
  expect(signals("#minus")?.labelInk?.glyph).toBe(true);
  expect(signals("#chip")?.labelInk?.text).toBe("Button");
  expect(signals("#chip")?.labelInk?.glyph).toBeUndefined();
});

test("captures without visible-only geometry keep the previous measurement", async () => {
  const found = centering(
    await reviewFixture(browser, await fixture(), {
      onObservations: (value) => {
        if (value.version !== 2) return;
        for (const element of value.elements)
          if (element.signals !== undefined) delete element.signals.labelInk;
      },
    }),
  );
  const selectors = found.map((c) => c.selectorHint);
  expect(selectors).toContain("#chip");
  expect(selectors).toContain("#plus-off");
  // The hidden label is what the legacy measurement mistook for the label.
  expect(selectors).toContain("#send");
});

test("font-metric rounding under a lowered tolerance is not off-centre; a real offset is", async () => {
  const html = await readFile(
    join(import.meta.dirname, "fixtures/text-centering/subpixel.html"),
    "utf8",
  );
  // A tolerance configured below 1.5px is raised to the 1.5px floor.
  const found = centering(
    await reviewFixture(browser, html, { checks: { centeringTolerance: 1 } }),
  );
  expect(found.map((c) => c.selectorHint)).toEqual(["#nudged"]);
  expect(found[0]?.explanation).toContain("tolerance 1.5px");
  expect(
    centering(await reviewFixture(browser, html)).map((c) => c.selectorHint),
  ).toEqual(["#nudged"]);
});
