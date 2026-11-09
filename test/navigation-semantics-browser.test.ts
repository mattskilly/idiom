import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type {
  IconControlObservation,
  ObservationArtifact,
  ProbeResult,
} from "../src/checks/types.js";
import { reviewFixture, reviewStates } from "./benchmark-support.js";

/**
 * Three navigation problems a person found that capture could not see: a
 * Settings item that expanded with no chevron, a logo that opened a drawer
 * it could not close, and one icon meaning two things.
 */
const directory = join(import.meta.dirname, "fixtures/navigation-semantics");
const categories = [
  "disclosure-affordance",
  "opener-cannot-close",
  "icon-meaning",
] as const;
type Category = (typeof categories)[number];

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

async function review(name: string) {
  const html = await readFile(join(directory, name), "utf8");
  let results: ProbeResult[] = [];
  let icons: IconControlObservation[] = [];
  const findings = await reviewFixture(browser, html, {
    probe: true,
    onObservations: (observations: ObservationArtifact) => {
      if (observations.version !== 2) return;
      results = observations.probe?.results ?? [];
      icons = observations.iconControls ?? [];
    },
  });
  const of = (category: Category) =>
    findings
      .map(({ candidate }) => candidate)
      .filter((candidate) => candidate.category === category);
  const result = (selector: string) =>
    results.find((entry) => entry.selector === selector);
  return { of, result, icons, results };
}

const PANEL_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><path d="M6 2.5v11M10 2.5v11" stroke="currentColor"/></svg>';

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Board</title>
<style>body { margin: 0; padding: 24px; font: 16px system-ui, sans-serif; } button { min-width: 32px; min-height: 32px; }</style>
</head><body>${body}
<script>for (const b of document.querySelectorAll("button")) b.addEventListener("click", () => document.body.classList.toggle(b.getAttribute("aria-label")));</script>
</body></html>`;

test("a Settings item that expands with no indicator is reported once, at minor", async () => {
  const { of, result } = await review("affordance-missing.html");
  const findings = of("disclosure-affordance");
  expect(findings).toHaveLength(1);
  expect(findings[0]?.severity).toBe("minor");
  expect(findings[0]?.rule).toBe("idiom:disclosure-affordance");
  expect(findings[0]?.explanation).toContain('"Settings"');
  const indicator = result("#settings")?.indicator;
  expect(indicator?.before.expanded).toBe("false");
  expect(indicator?.after.expanded).toBe("true");
  expect(indicator?.before.graphics).toEqual(indicator?.after.graphics);
}, 60_000);

test("a chevron that rotates passes (near miss)", async () => {
  const { of, result } = await review("affordance-chevron-rotates.html");
  expect(of("disclosure-affordance")).toEqual([]);
  const indicator = result("#settings")?.indicator;
  expect(indicator?.after.expanded).toBe("true");
  expect(indicator?.before.graphics).not.toEqual(indicator?.after.graphics);
}, 60_000);

test("plus/minus pseudo-elements, a label swap, menu buttons and a details marker pass", async () => {
  for (const name of [
    "affordance-plus-minus.html",
    "affordance-text-swap.html",
    "affordance-menu-text.html",
    "affordance-details.html",
  ]) {
    const { of, results } = await review(name);
    expect(of("disclosure-affordance"), name).toEqual([]);
    expect(
      results.some((entry) => entry.indicator !== undefined),
      name,
    ).toBe(true);
  }
}, 120_000);

test("a logo that opens a drawer a second click cannot close is reported", async () => {
  const { of, result } = await review("opener-stays-open.html");
  const findings = of("opener-cannot-close");
  expect(findings).toHaveLength(1);
  expect(findings[0]?.severity).toBe("minor");
  expect(findings[0]?.selectorHint).toBe("#logo");
  expect(result("#logo")?.reclick?.outcome).toBe("stayed-open");
  expect(result("#logo")?.reclick?.closeNearby).toBeUndefined();
}, 60_000);

test("a logo that toggles its drawer passes (near miss)", async () => {
  const { of, result } = await review("opener-toggles.html");
  expect(of("opener-cannot-close")).toEqual([]);
  expect(result("#logo")?.reclick?.outcome).toBe("closed");
}, 60_000);

test("a close control where the opener was passes, covered or beside it", async () => {
  const covers = await review("opener-close-covers.html");
  expect(covers.of("opener-cannot-close")).toEqual([]);
  expect(covers.result("#logo")?.reclick).toMatchObject({
    outcome: "not-tested",
    closeNearby: { name: "Close" },
  });
  const beside = await review("opener-close-beside.html");
  expect(beside.of("opener-cannot-close")).toEqual([]);
  expect(beside.result("#logo")?.reclick).toMatchObject({
    outcome: "stayed-open",
    closeNearby: { name: "×" },
  });
}, 120_000);

test("one icon meaning collapse panel and 3-column layout is reported once", async () => {
  const { of, icons } = await review("icon-two-meanings.html");
  const findings = of("icon-meaning");
  expect(findings).toHaveLength(1);
  expect(findings[0]?.severity).toBe("minor");
  expect(findings[0]?.explanation).toContain('"Collapse panel"');
  expect(findings[0]?.explanation).toContain('"3-column layout"');
  expect(icons).toHaveLength(2);
  expect(icons[0]?.fingerprint).toMatch(/^svg:[0-9a-f]{8}$/);
  expect(icons[0]?.fingerprint).toBe(icons[1]?.fingerprint);
  expect(icons.every((icon) => icon.placement === "only")).toBe(true);
}, 60_000);

test("the same icon with one meaning, and repeated rows, pass", async () => {
  const same = await review("icon-same-meaning.html");
  expect(same.of("icon-meaning")).toEqual([]);
  expect(same.icons).toHaveLength(2);
  expect(same.icons[0]?.fingerprint).toBe(same.icons[1]?.fingerprint);
  const rows = await review("icon-repeated-rows.html");
  expect(rows.of("icon-meaning")).toEqual([]);
  const trash = rows.icons.filter((icon) => icon.name.startsWith("Delete"));
  const chevrons = rows.icons.filter((icon) => icon.role === "link");
  expect(trash).toHaveLength(3);
  expect(chevrons).toHaveLength(3);
  expect(chevrons.every((icon) => icon.placement === "trailing")).toBe(true);
  expect(trash[0]?.fingerprint).not.toBe(chevrons[0]?.fingerprint);
}, 120_000);

test("an icon carrying two meanings across two states is reported once, listing both", async () => {
  const { findings } = await reviewStates(
    browser,
    [
      {
        state: "board",
        html: page(
          `<button aria-label="Collapse panel">${PANEL_ICON}</button>`,
        ),
      },
      {
        state: "layout",
        html: page(
          `<button aria-label="3-column layout">${PANEL_ICON}</button>`,
        ),
      },
    ],
    { probe: true },
  );
  const icon = findings.filter(
    ({ candidate }) => candidate.category === "icon-meaning",
  );
  expect(icon).toHaveLength(1);
  expect(icon[0]?.state).toBe("board");
  expect(icon[0]?.candidate.explanation).toContain('"Collapse panel" (board)');
  expect(icon[0]?.candidate.explanation).toContain(
    '"3-column layout" (layout)',
  );
}, 60_000);
