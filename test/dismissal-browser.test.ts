import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ObservationArtifact, ProbeResult } from "../src/checks/types.js";
import { reviewFixture } from "./benchmark-support.js";

/** A drawer's "Start from…" menu that ignored outside and iframe clicks. */
const directory = join(import.meta.dirname, "fixtures/dismissal");

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
  const candidates = findings.map(({ candidate }) => candidate);
  const dismissal = (selector: string) =>
    results.find((entry) => entry.selector === selector)?.dismissal;
  return {
    popovers: candidates.filter(
      (candidate) => candidate.category === "popover-dismissal",
    ),
    focus: candidates.filter(
      (candidate) => candidate.category === "focus-return",
    ),
    dismissal,
  };
}

const outcomes = (tests: Array<{ method: string; outcome: string }> = []) =>
  Object.fromEntries(tests.map((test) => [test.method, test.outcome]));

test("a menu that closes on Escape, an outside click and an iframe click passes", async () => {
  const { popovers, focus, dismissal } = await review("closes-all.html");
  expect(popovers).toEqual([]);
  expect(focus).toEqual([]);
  const block = dismissal("#start");
  expect(block?.status).toBe("tested");
  expect(outcomes(block?.tests)).toEqual({
    escape: "closed",
    outside: "closed",
    iframe: "closed",
  });
  expect(block?.tests[0]?.focus?.returned).toBe(true);
}, 60_000);

test("a menu that ignores outside clicks is reported for the outside and iframe clicks", async () => {
  const { popovers, dismissal } = await review("ignores-outside.html");
  expect(popovers.map((finding) => finding.rule)).toEqual([
    "idiom:popover-not-dismissed",
    "idiom:popover-not-dismissed",
  ]);
  expect(popovers.every((finding) => finding.severity === "major")).toBe(true);
  expect(outcomes(dismissal("#start")?.tests)).toEqual({
    escape: "closed",
    outside: "stayed-open",
    iframe: "stayed-open",
  });
}, 60_000);

test("a menu that ignores iframe clicks is reported once, naming the iframe", async () => {
  const { popovers, dismissal } = await review("ignores-iframe.html");
  expect(popovers).toHaveLength(1);
  expect(popovers[0]?.explanation).toContain('"Canvas"');
  expect(popovers[0]?.explanation).toContain("iframe");
  const iframe = dismissal("#start")?.tests.find(
    (entry) => entry.method === "iframe",
  );
  expect(iframe?.outcome).toBe("stayed-open");
  expect(iframe?.iframe?.name).toBe("Canvas");
}, 60_000);

test("an alert dialog is exempt from the outside click, not from Escape", async () => {
  const { popovers, dismissal } = await review("alertdialog.html");
  expect(popovers).toEqual([]);
  const block = dismissal("#review");
  expect(block?.explicit).toBe("alertdialog");
  const outside = block?.tests.find((entry) => entry.method === "outside");
  expect(outside?.outcome).toBe("not-tested");
  expect(outside?.reason).toMatch(/^exempt: /);
  expect(outcomes(block?.tests).escape).toBe("closed");
}, 60_000);

test("Escape that drops focus to the body is reported as focus not returned", async () => {
  const { popovers, focus, dismissal } = await review(
    "escape-drops-focus.html",
  );
  expect(popovers).toEqual([]);
  expect(focus).toHaveLength(1);
  expect(focus[0]?.rule).toBe("idiom:focus-not-returned");
  expect(focus[0]?.severity).toBe("minor");
  expect(focus[0]?.explanation).toContain("body");
  expect(dismissal("#start")?.tests[0]?.focus?.active).toBe("body");
}, 60_000);

test("an in-flow accordion panel is not a popover", async () => {
  const { popovers, focus, dismissal } = await review("accordion.html");
  expect(popovers).toEqual([]);
  expect(focus).toEqual([]);
  expect(dismissal("#shipping")?.status).toBe("not-applicable");
}, 60_000);

test("a menu nested in a probed drawer is tested and reported", async () => {
  const { popovers, dismissal } = await review("nested-in-drawer.html");
  const block = dismissal("#start");
  expect(block?.kind).toBe("popup");
  expect(block?.root).toContain("ul");
  expect(outcomes(block?.tests)).toEqual({
    escape: "closed",
    outside: "stayed-open",
    iframe: "stayed-open",
  });
  expect(
    popovers.filter((finding) => finding.explanation?.includes("Start from")),
  ).toHaveLength(2);
}, 60_000);
