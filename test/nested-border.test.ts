import { readFile } from "node:fs/promises";
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
const html = (name: string) =>
  readFile(
    new URL(`./fixtures/nested-border/${name}.html`, import.meta.url),
    "utf8",
  );
const nested = (findings: Awaited<ReturnType<typeof reviewFixture>>) =>
  findings
    .filter((f) => f.candidate.category === "nested-border")
    .map((f) => f.candidate);

test("a pill trigger inside a square wrapper border is flagged once per swatch", async () => {
  let observations: ObservationArtifact | undefined;
  const found = nested(
    await reviewFixture(browser, await html("picker"), {
      onObservations: (value) => {
        observations = value;
      },
    }),
  );
  const swatch =
    observations?.version === 2
      ? observations.elements.find((e) => e.selector === "#swatch-a")
      : undefined;
  expect(swatch?.styles).toMatchObject({
    borderTopStyle: "solid",
    borderLeftStyle: "solid",
  });
  expect(found.map((c) => [c.rule, c.severity, c.selectorHint]).sort()).toEqual(
    [
      ["idiom:nested-border", "minor", "#swatch-a"],
      ["idiom:nested-border", "minor", "#swatch-b"],
      ["idiom:nested-border", "minor", "#swatch-c"],
    ],
  );
  expect(new Set(found.map((c) => c.fingerprintHint)).size).toBe(3);
  const first = found.find((c) => c.selectorHint === "#swatch-a");
  expect(first?.explanation).toBe(
    "#pill-a draws its own pill border 2px inside #swatch-a's square border, so the edge reads doubled and mismatched.",
  );
  expect(first?.verification.params?.selectors).toEqual([
    "#swatch-a",
    "#pill-a",
  ]);
});

test("a card holding a label and a padded bordered input is not flagged", async () => {
  expect(
    nested(await reviewFixture(browser, await html("card-input"))),
  ).toEqual([]);
});

test("focus rings and focus-within wrapper borders are not flagged", async () => {
  expect(
    nested(
      await reviewFixture(browser, await html("focus-ring"), { focus: "#q" }),
    ),
  ).toEqual([]);
});

test("nested frames with the same radius and style are not flagged", async () => {
  expect(
    nested(await reviewFixture(browser, await html("same-shape"))),
  ).toEqual([]);
});

test("capture inventories repeated-content containers, empty ones included", async () => {
  let observations: ObservationArtifact | undefined;
  await reviewFixture(browser, await html("containers"), {
    onObservations: (value) => {
      observations = value;
    },
  });
  const containers =
    observations?.version === 2 ? observations.repeatedContainers : undefined;
  expect(
    containers?.map(({ selector, kind, name, items }) => [
      selector,
      kind,
      name,
      items,
    ]),
  ).toEqual([
    ["#fonts", "list", "Fonts", 0],
    ["#assets", "table", "Assets", 2],
    ["#palette", "editor", "Palette", 0],
    ["#tags", "editor", "Tags", 1],
  ]);
});
