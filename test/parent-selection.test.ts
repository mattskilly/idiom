import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import type {
  ObservationArtifact,
  ProbeArtifact,
} from "../src/checks/types.js";
import { type ReviewedFixture, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
let observations: ObservationArtifact | undefined;
let probe: ProbeArtifact | undefined;
let findings: ReviewedFixture;
const html = await readFile(
  join(import.meta.dirname, "fixtures/parent-selection/editor.html"),
  "utf8",
);
const parentFindings = () =>
  findings
    .map(({ candidate }) => candidate)
    .filter((candidate) => candidate.rule === "idiom:control-selects-parent");

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  findings = await reviewFixture(browser, html, {
    probe: true,
    onObservations: (captured) => {
      observations = captured;
      if (captured.version === 2) probe = captured.probe;
    },
  });
}, 90_000);
afterAll(async () => {
  await browser.close();
});

test("a nav CTA and links that select their parent block are one finding", () => {
  const found = parentFindings();
  expect(found).toHaveLength(1);
  const [finding] = found;
  expect(finding).toMatchObject({
    category: "parent-selection",
    severity: "major",
    selectorHint: "#nav-cta",
    fingerprintHint: "idiom:control-selects-parent|#nav-block",
  });
  expect(finding?.explanation).toContain(
    "Clicking “Get started” (#nav-cta), which looks like a button, selected its ancestor Navigation block (#nav-block, aria-selected)",
  );
  expect(finding?.explanation).toContain(
    "Also: “Home”, “Pricing”, “Book demo”.",
  );
});

test("the main pass records the ancestor on the CTA's own result", () => {
  const cta = probe?.results.find((result) => result.selector === "#nav-cta");
  expect(cta?.selectsAncestor).toEqual({
    ancestor: "#nav-block",
    ancestorName: "Navigation block",
    marker: "aria-selected",
    affordance: "button",
  });
});

test("the selection pass clicks links and look-alikes without navigating", () => {
  const trials = probe?.selectionTrials?.trials ?? [];
  expect(probe?.selectionTrials?.status).toBe("ran");
  const trial = (selector: string) =>
    trials.find((entry) => entry.selector === selector);
  expect(trial("#nav-home")?.selectsAncestor).toMatchObject({
    ancestor: "#nav-block",
    affordance: "link",
  });
  expect(trial("#nav-demo")?.selectsAncestor).toMatchObject({
    ancestor: "#nav-block",
    affordance: "button",
  });
  for (const entry of trials) {
    if (["#nav-delete", "#nav-remove"].includes(entry.selector)) continue;
    expect(entry.status, entry.selector).toBe("completed");
    expect(entry.effects, entry.selector).not.toContain("navigation");
  }
  // Links outside a selectable container are never clicked.
  expect(trial("#docs-link")).toBeUndefined();
  // Trials never become probe results, where a guarded link would read as dead.
  expect(probe?.results.some((result) => result.selector === "#nav-home")).toBe(
    false,
  );
});

test("the selection pass never clicks a destructive name", () => {
  const trials = probe?.selectionTrials?.trials ?? [];
  for (const selector of ["#nav-delete", "#nav-remove"])
    expect(
      trials.find((entry) => entry.selector === selector),
      selector,
    ).toEqual({
      selector,
      name: selector === "#nav-delete" ? "Delete block" : "Remove block",
      affordance: selector === "#nav-delete" ? "link" : "button",
      status: "skipped",
      skipped: "destructive name",
      effects: [],
      elapsedMs: 0,
    });
  const text = parentFindings()
    .map((finding) => finding.explanation)
    .join("\n");
  expect(text).not.toMatch(/Delete block|Remove block/);
});

test("a tile that selects itself and a route wrapper are not reported", () => {
  for (const id of ["tile-a", "tile-b", "tile-c"]) {
    const result = probe?.results.find((entry) => entry.selector === `#${id}`);
    expect(result?.effects.length, id).toBeGreaterThan(0);
    expect(result?.selectsAncestor, id).toBeUndefined();
  }
  const text = parentFindings()
    .map((finding) => `${finding.explanation} ${finding.selectorHint}`)
    .join("\n");
  expect(text).not.toMatch(/tile-|docs-link|blog-link|site-nav/);
});

test("the captured probe artifact parses", () => {
  expect(() => observationArtifactSchema.parse(observations)).not.toThrow();
});
