import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ObservationArtifact } from "../src/checks/types.js";
import { reviewFixture } from "./benchmark-support.js";

let browser: Browser;
const html = await readFile(
  join(import.meta.dirname, "fixtures/selected-state/selected-controls.html"),
  "utf8",
);
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

async function review(respectControlIntent?: boolean) {
  let observations: ObservationArtifact | undefined;
  const findings = await reviewFixture(browser, html, {
    probe: true,
    ...(respectControlIntent === undefined
      ? {}
      : { checks: { probe: { respectControlIntent } } }),
    onObservations: (captured) => {
      observations = captured;
    },
  });
  if (observations?.version !== 2) throw new Error("v2 expected");
  const results = observations.probe?.results ?? [];
  return {
    dead: findings
      .map(({ candidate }) => candidate)
      .filter((candidate) => candidate.category === "dead-control")
      .map((candidate) => candidate.selectorHint)
      .sort(),
    result: (id: string) => results.find((r) => r.selector === `#${id}`),
    explanations: (id: string) =>
      (observations?.version === 2
        ? (observations.explanations?.records ?? [])
        : []
      ).filter((record) => record.selector === `#${id}`),
  };
}

test("already-selected tabs, radios, options and current items are not clicked by default", async () => {
  const { dead, result, explanations } = await review();
  for (const [id, reason] of [
    ["tab", "already selected: aria-selected"],
    ["glyph-tab", "already selected: aria-selected"],
    ["role-radio", "already selected: aria-checked"],
    ["option", "already selected: aria-selected"],
    ["current", "already selected: aria-current"],
  ] as const)
    expect(result(id), id).toMatchObject({ skipped: reason, effects: [] });
  // The skip comes after explanation sampling, so the glyph keeps its
  // hover and focus evidence instead of being marked unavailable.
  const sampled = explanations("glyph-tab");
  expect(sampled.map((record) => record.trigger).sort()).toEqual([
    "focus",
    "hover",
  ]);
  expect(sampled.some((record) => record.status === "unavailable")).toBe(false);
  // Toggles and an ordinary inert button are still clicked and found.
  expect(dead).toEqual(["#checkbox", "#dead", "#switch"]);
  for (const id of ["switch", "checkbox", "dead"])
    expect(result(id)?.skipped, id).toBeUndefined();
}, 60_000);

test("with respectControlIntent, selected controls are skipped before sampling, as before", async () => {
  const { dead, result, explanations } = await review(true);
  for (const id of ["tab", "glyph-tab", "role-radio", "option", "current"])
    expect(result(id)?.skipped, id).toMatch(/^already selected: /);
  expect(
    explanations("glyph-tab").every(
      (record) => record.status === "unavailable",
    ),
  ).toBe(true);
  // The opt-in also skips the checked switch and checkbox (aria-checked).
  expect(dead).toEqual(["#dead"]);
}, 60_000);
