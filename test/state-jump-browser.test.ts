import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { reviewStates } from "./benchmark-support.js";

const directory = join(import.meta.dirname, "fixtures/state-jump");

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

/** The closed page, then the same page after clicking the trigger. */
async function jumps(
  name: string,
  trigger: string,
  intendedChanges?: string[],
) {
  const html = await readFile(join(directory, name), "utf8");
  const { findings, tuples } = await reviewStates(browser, [
    { state: "closed", html },
    {
      state: "opened",
      html,
      from: "closed",
      click: trigger,
      ...(intendedChanges === undefined ? {} : { intendedChanges }),
    },
  ]);
  return {
    findings: findings
      .map(({ candidate }) => candidate)
      .filter((candidate) => candidate.rule === "idiom:state-jump"),
    tuples,
  };
}

test("a logo that shrinks and moves when its drawer opens is reported, and the links it pushes are one grouped move", async () => {
  const { findings, tuples } = await jumps("logo-resizes.html", "#logo");
  expect(findings).toHaveLength(2);
  const [finding, pushed] = findings;
  expect(finding?.selectorHint).toBe("#logo");
  expect(finding?.explanation).toContain('"Workspace home"');
  expect(finding?.explanation).toContain("8px right");
  expect(finding?.explanation).toContain("shrinks from 28×28 to 24×24");
  expect(finding?.evidenceTuples?.map((tuple) => tuple.state)).toEqual([
    "closed",
    "opened",
  ]);
  expect(tuples.map((tuple) => tuple.from)).toEqual([undefined, "closed"]);
  expect(pushed?.explanation).toMatch(
    /^2 elements \("Projects", "Reports"\) move together 4px right/,
  );
}, 60_000);

test("a drawer that opens without moving its trigger passes", async () => {
  expect((await jumps("drawer-overlay.html", "#logo")).findings).toEqual([]);
}, 60_000);

test("a renamed trigger moving half a pixel and a declared change do not fire", async () => {
  expect(
    (await jumps("near-miss.html", "#menu-toggle", ["#search"])).findings,
  ).toEqual([]);
  // Without the declaration the widened search field is reported.
  const undeclared = (await jumps("near-miss.html", "#menu-toggle")).findings;
  expect(undeclared.map((finding) => finding.selectorHint)).toEqual([
    "#search",
  ]);
}, 60_000);
