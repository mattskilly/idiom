import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type ReviewOptions, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

const narrow = { width: 900, height: 800 };
const desktop = { width: 1280, height: 800 };
const rules = new Set([
  "idiom:toolbar-wrap",
  "idiom:toolbar-off-centre",
  "idiom:toolbar-odd-control",
]);
const html = (name: string) =>
  readFile(
    new URL(`./fixtures/toolbar-layout/${name}.html`, import.meta.url),
    "utf8",
  );
async function review(name: string, options: ReviewOptions = {}) {
  const found = await reviewFixture(browser, await html(name), {
    viewport: narrow,
    ...options,
  });
  return found
    .map((f) => f.candidate)
    .filter((candidate) => rules.has(candidate.rule));
}
type Found = Awaited<ReturnType<typeof review>>;
const evidence = (found: Found) =>
  found
    .map((c) => ({
      rule: c.rule,
      severity: c.severity,
      selector: c.selectorHint,
      fingerprint: c.fingerprintHint,
      explanation: c.explanation,
      params: c.verification.params,
    }))
    .sort((a, b) => (a.fingerprint ?? "").localeCompare(b.fingerprint ?? ""));
const byRule = (found: Found, rule: string) =>
  found.filter((c) => c.rule === rule);

test("the broken toolbar wraps, has a top-aligned icon and a bordered close button at 900px", async () => {
  const found = await review("toolbar-broken");
  // The evidence: every toolbar finding the fixture captures at 900px.
  expect(evidence(found)).toMatchObject([
    {
      rule: "idiom:toolbar-odd-control",
      severity: "minor",
      selector: 'div[aria-label="Selection"]',
      params: {
        selector: 'div[aria-label="Selection"]',
        control: 'button[aria-label="Clear offset"]',
        property: "border",
        value: "1px solid",
        siblings: "none",
        viewportWidth: 900,
      },
    },
    {
      rule: "idiom:toolbar-off-centre",
      severity: "minor",
      params: {
        item: 'button[aria-label="Align"]',
        offset: -2,
        tolerance: 1,
        row: 1,
        viewportWidth: 900,
      },
    },
    {
      rule: "idiom:toolbar-wrap",
      severity: "major",
      params: {
        selector: 'div[aria-label="Selection"]',
        wrapped: ["button.text"],
        height: 74,
        singleRowHeight: 42,
        rows: 2,
        viewportWidth: 900,
      },
    },
  ]);
  const [wrap] = byRule(found, "idiom:toolbar-wrap");
  expect(wrap?.explanation).toBe(
    'div[aria-label="Selection"] wraps to 2 rows at 900px: button.text ("Reset position") sits on row 2; the toolbar is 74px tall against 42px on one row.',
  );
  const [off] = byRule(found, "idiom:toolbar-off-centre");
  expect(off?.explanation).toContain("sits 2px high of row 1's centre");
  const [odd] = byRule(found, "idiom:toolbar-odd-control");
  expect(odd?.explanation).toContain(
    "has a 1px solid border where every sibling control has no border",
  );
});

test("the broken toolbar fires nothing at 1280px, and the correct toolbar fires nothing at either width", async () => {
  // The evidence at 1280px: no toolbar findings.
  expect(
    evidence(await review("toolbar-broken", { viewport: desktop })),
  ).toEqual([]);
  for (const viewport of [narrow, desktop])
    expect(
      evidence(await review("toolbar-correct", { viewport })),
      `toolbar-correct at ${viewport.width}`,
    ).toEqual([]);
});

test("two captures of the broken toolbar produce identical findings", async () => {
  const first = evidence(await review("toolbar-broken"));
  const second = evidence(await review("toolbar-broken"));
  expect(first).toHaveLength(3);
  expect(second).toEqual(first);
});

test("segmented groups, tooltips, a 1px nudge and vertical toolbars are not findings", async () => {
  for (const viewport of [narrow, desktop])
    expect(
      evidence(await review("toolbar-near-miss", { viewport })),
      `toolbar-near-miss at ${viewport.width}`,
    ).toEqual([]);
});

test("a configured selector measures an element that is not a role=toolbar", async () => {
  const found = await review("toolbar-near-miss", {
    checks: { toolbarLayout: { selectors: [".my-bar"] } },
  });
  expect(evidence(found).map((f) => [f.rule, f.selector])).toEqual([
    ["idiom:toolbar-wrap", "div.my-bar"],
  ]);
});

test("a learned one-row law is cited in the wrap finding", async () => {
  const name = "The selection toolbar is always exactly one row.";
  const found = await review("toolbar-broken", {
    checks: {
      toolbarLayout: {
        scopes: [{ name, selector: '[role="toolbar"]', law: "one-row" }],
      },
    },
  });
  const [wrap] = byRule(found, "idiom:toolbar-wrap");
  expect(wrap?.explanation).toContain(`(law: "${name}", in [role="toolbar"])`);
  expect(wrap?.verification.params).toMatchObject({
    scope: '[role="toolbar"]',
  });
  // The fingerprint does not depend on the law.
  expect(wrap?.fingerprintHint).toBe(
    'toolbar-wrap:div[aria-label="Selection"]',
  );
});

test("a learned centring law sets the tolerance inside its toolbar", async () => {
  const name = "Every toolbar control is vertically centred within 3px.";
  const loose = await review("toolbar-broken", {
    checks: {
      toolbarLayout: {
        scopes: [
          { name, selector: '[role="toolbar"]', law: "centred", tolerance: 3 },
        ],
      },
    },
  });
  expect(byRule(loose, "idiom:toolbar-off-centre")).toEqual([]);
  const strict = await review("toolbar-near-miss", {
    checks: {
      toolbarLayout: {
        scopes: [
          {
            name: "History controls are centred.",
            selector: '[aria-label="History"]',
            law: "centred",
            tolerance: 0.5,
          },
        ],
      },
    },
  });
  const [nudged] = byRule(strict, "idiom:toolbar-off-centre");
  expect(nudged?.verification.params).toMatchObject({
    offset: 1,
    tolerance: 0.5,
    scope: '[aria-label="History"]',
  });
  expect(nudged?.explanation).toContain("sits 1px low");
});
