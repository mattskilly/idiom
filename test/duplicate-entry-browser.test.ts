import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { duplicateEntryCheck } from "../src/checks/duplicate-entry.js";
import type { ObservationArtifact, ProbeResult } from "../src/checks/types.js";
import { reviewFixture } from "./benchmark-support.js";

/**
 * dogfooding requests #51 and #63: duplicate entry points are identified by
 * location, not accessible name, and focus that follows another effect is a
 * side effect rather than the control's destination.
 */
const directory = join(import.meta.dirname, "fixtures/duplicate-entry");

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
  const findings = await reviewFixture(browser, html, {
    probe: true,
    onObservations: (observations: ObservationArtifact) => {
      if (observations.version === 2)
        results = observations.probe?.results ?? [];
    },
  });
  const duplicates = findings
    .map(({ candidate }) => candidate)
    .filter((candidate) => candidate.category === "duplicate-entry");
  const result = (selector: string) =>
    results.find((entry) => entry.selector === selector);
  return { duplicates, results, result };
}

test("same-name gears in different regions and a menu item are one finding with three locations (#51)", async () => {
  const { duplicates, results, result } = await review("page-settings.html");
  expect(duplicates).toHaveLength(1);
  const explanation = duplicates[0]?.explanation ?? "";
  expect(explanation).toContain("3 controls");
  expect(explanation).toContain("Page settings");
  expect(explanation).toContain("#title-gear");
  expect(explanation).toContain("#tool-gear");
  expect(explanation).toContain('toolbar "Tools"');
  expect(explanation).toContain('menu "Project"');
  expect(explanation).not.toContain('"Edit"');
  expect(result("#tool-gear")?.repeated).not.toBe(true);
  expect(result("#tool-gear")?.region).toBe('toolbar "Tools"');
  expect(result("#title-gear")?.region).toBe("main");
  expect(result("#undo")?.repeated).not.toBe(true);
  const edits = results.filter((entry) => entry.name === "Edit");
  expect(edits).toHaveLength(3);
  expect(edits.every((entry) => entry.repeated === true)).toBe(true);
}, 60_000);

test("a list whose rows are bare buttons opening one inspector is a repeated list, not duplicates", async () => {
  const { duplicates, results } = await review("layer-list.html");
  expect(duplicates).toEqual([]);
  const layers = results.filter((entry) =>
    ["Header", "Hero", "Footer"].includes(entry.name),
  );
  expect(layers).toHaveLength(3);
  expect(layers.every((entry) => entry.repeated === true)).toBe(true);
}, 60_000);

test("controls that do different things and then focus one field are not duplicates (#63)", async () => {
  const { duplicates, result } = await review("focus-redirect.html");
  expect(duplicates).toEqual([]);
  expect(result("#keep-brand")?.primary).toBe(true);
  expect(result("#use-template")?.primary).toBe(true);
}, 60_000);

test("controls whose only effect is focusing one field are still duplicates", async () => {
  const { duplicates, result } = await review("focus-only.html");
  expect(duplicates).toHaveLength(1);
  const explanation = duplicates[0]?.explanation ?? "";
  expect(explanation).toContain("3 controls");
  expect(explanation).toContain("moves focus to");
  for (const selector of ["#header-search", "#main-search", "#footer-search"])
    expect(result(selector)?.primary).toBe(false);
}, 60_000);

test("stored artifacts without primary keep grouping focus signatures", () => {
  const focus = (selector: string, primary?: boolean) => ({
    selector,
    name: selector,
    effects: ["dom", "focus"] as ProbeResult["effects"],
    signature: "focus:input:Find a page",
    persistent: true,
    ...(primary === undefined ? {} : { primary }),
  });
  const run = (results: ProbeResult[]) =>
    duplicateEntryCheck.run({
      tuple: {
        observations: {
          version: 2,
          probe: { status: "ran", results },
        },
      },
    } as unknown as Parameters<typeof duplicateEntryCheck.run>[0]);
  const candidates = (results: ProbeResult[]) => run(results).candidates;
  expect(candidates([focus("#a"), focus("#b")])).toHaveLength(1);
  expect(candidates([focus("#a", true), focus("#b", true)])).toEqual([]);
  expect(candidates([focus("#a", false), focus("#b", false)])).toHaveLength(1);
});
