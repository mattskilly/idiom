import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { overflowClipCheck } from "../src/checks/overflow-clip.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ObservationArtifact,
  ObservationArtifactV1,
  ObservedElement,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { reviewFixture } from "./benchmark-support.js";

/**
 * Dogfooding requests #60 and #62: pattern names in a picker are names, not
 * sentence-case slips, and thumbnails cropped by their cards are the design.
 */
const directory = join(import.meta.dirname, "fixtures/noise-defaults");

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

let observed: ObservationArtifact | undefined;

async function review(name: string, checks?: unknown) {
  const html = await readFile(join(directory, name), "utf8");
  return (
    await reviewFixture(browser, html, {
      ...(checks === undefined ? {} : { checks }),
      onObservations: (observations) => {
        observed = observations;
      },
    })
  ).map(({ candidate }) => candidate);
}

const casing = (findings: Awaited<ReturnType<typeof review>>) =>
  findings
    .filter(({ rule }) => rule === "idiom:mixed-label-casing")
    .map(({ selectorHint }) => selectorHint);

test("Title Case pattern names in a picker report without config; data-idiom-name items in a collection do not (#60)", async () => {
  const flagged = casing(await review("pattern-library.html"));
  expect(flagged.some((selector) => selector.startsWith("#p-"))).toBe(true);
  expect(flagged.filter((selector) => selector.startsWith("#n-"))).toEqual([]);
  expect(flagged.some((selector) => selector.startsWith("#s-"))).toBe(true);
});

test("checks.copy.properNouns quiets declared names; other casing and glossary hits still report (#60)", async () => {
  const findings = await review("pattern-library.html", {
    copy: {
      properNouns: ["Hero Centered", "CTA Centered"],
      glossary: [{ term: "Leads", preferred: "Contacts" }],
    },
  });
  const flagged = casing(findings);
  expect(flagged.filter((selector) => selector.startsWith("#p-"))).toEqual([]);
  expect(flagged).toContain("#s-one");
  expect(
    findings.some(
      ({ rule, selectorHint }) =>
        rule === "idiom:glossary-term" && selectorHint === "#g-leads-grid",
    ),
  ).toBe(true);
});

test("a mis-cased variant of a declared proper noun is still compared (#60)", async () => {
  const findings = await review("pattern-library.html", {
    copy: { properNouns: ["Hero Centered"] },
  });
  // "Hero Centered" drops out; "Hero centered" still meets "Pricing Centered".
  expect(
    findings.some(
      ({ rule, selectorHint, explanation }) =>
        rule === "idiom:mixed-label-casing" &&
        selectorHint.startsWith("#m-") &&
        explanation.includes('"Hero centered"'),
    ),
  ).toBe(true);
});

test("data-idiom-name outside a list or grid collection is not exempt (#60)", async () => {
  const flagged = casing(await review("pattern-library.html"));
  expect(flagged.some((selector) => selector.startsWith("#l-"))).toBe(true);
});

test("thumbnails, images and canvases cropped by their cards are not clipped content (#62)", async () => {
  const findings = await review("dashboard-thumbnails.html");
  // The fixture reproduces the reported measurements.
  const size = (selector: string) => {
    const box = observed?.elements.find((entry) => entry.selector === selector);
    return `${box?.scrollWidth}×${box?.scrollHeight} in ${box?.clientWidth}×${box?.clientHeight}`;
  };
  expect(size("#thumb-small")).toBe("96×77 in 96×72");
  expect(size("#thumb-large")).toBe("361×289 in 361×225");
  const clipped = findings.filter(
    ({ rule }) => rule === "idiom:element-content-clipped",
  );
  const at = (selector: string) =>
    clipped.filter(({ selectorHint }) => selectorHint === selector);
  for (const selector of [
    "#thumb-small",
    "#thumb-large",
    "#avatar",
    "#sparkline",
    "#declared-crop",
  ])
    expect(at(selector), selector).toEqual([]);
  expect(at("#plain-overflow")).toHaveLength(1);
  expect(at("#captioned")).toHaveLength(1);
  expect(at("#fixed-text")).toHaveLength(1);
  const text = findings.filter(({ rule }) => rule === "idiom:text-clipped");
  expect(
    text.some(({ explanation }) => explanation.includes("past #crop-text")),
  ).toBe(true);
  expect(text.some(({ selectorHint }) => selectorHint === "#fixed-text")).toBe(
    true,
  );
});

const element = (
  selector: string,
  overrides: Partial<ObservedElement> = {},
): ObservedElement => ({
  selector,
  tag: "div",
  text: "",
  visible: true,
  interactive: false,
  enabled: true,
  rect: { x: 0, y: 0, width: 96, height: 72 },
  scrollWidth: 96,
  scrollHeight: 72,
  clientWidth: 96,
  clientHeight: 72,
  outOfFlow: false,
  ancestorSelectors: [],
  styles: {
    color: "rgb(0, 0, 0)",
    backgroundColor: "rgba(0, 0, 0, 0)",
    fontSize: "14px",
    fontWeight: "400",
    lineHeight: "20px",
    display: "block",
    position: "static",
    overflowX: "visible",
    overflowY: "visible",
    textOverflow: "clip",
    opacity: "1",
    zIndex: "auto",
  } as unknown as ObservedElement["styles"],
  hitTestWith: [],
  ...overrides,
});

test("overflow-clip finds media children of version 1 observations by ancestor selector (#62)", () => {
  const clipping = {
    scrollHeight: 77,
    styles: {
      ...element("x").styles,
      overflowX: "hidden",
      overflowY: "hidden",
    },
  };
  const observations: ObservationArtifactV1 = {
    version: 1,
    viewport: { width: 1440, height: 900 },
    document: {
      scrollWidth: 1440,
      scrollHeight: 900,
      clientWidth: 1440,
      clientHeight: 900,
    },
    elements: [
      element("#thumb", clipping),
      element("#thumb > iframe", {
        tag: "iframe",
        ancestorSelectors: ["#thumb"],
      }),
      element("#card", { ...clipping, text: "Draft" }),
      element("#card > iframe", {
        tag: "iframe",
        ancestorSelectors: ["#card"],
      }),
    ],
    headings: [],
    tokens: { status: "not-configured" },
  };
  const tuple = {
    flow: "dashboard",
    state: "recent",
    viewport: "desktop",
    width: 1440,
    height: 900,
    metadataPath: "recent/desktop/metadata.json",
    artifactPaths: ["recent/desktop/observations.json"],
    commit: "fixture",
    createdAt: "2026-10-22T00:00:00.000Z",
    observations,
    axe: { violations: [] },
    console: [],
    mismatches: [],
  } as unknown as CheckTuple;
  const result = overflowClipCheck.run({
    tuple,
    config: checksConfigFrom(checksConfigSchema.parse({})),
  } as Parameters<typeof overflowClipCheck.run>[0]);
  const selectors =
    "candidates" in result
      ? result.candidates.map(({ selectorHint }) => selectorHint)
      : [];
  expect(selectors).toEqual(["#card"]);
});
