import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { BriefCheck } from "../src/brief/assertions.js";
import { briefAssertionSchema } from "../src/schemas/brief.js";
import { fixture, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

const statement =
  "tile height unchanged at 56px; pin control inside the tile's rectangle";

const brief: BriefCheck = {
  slug: "pinned-group",
  title: "Pinned group in the Add drawer",
  decision: "Corner pin icon",
  eligible: true,
  criteria: [
    {
      index: 0,
      statement,
      assertions: [
        {
          flow: "studio-lab",
          state: "editor",
          selector: ".drawer-item",
          height: 56,
        },
        {
          flow: "studio-lab",
          state: "editor",
          selector: ".drawer-item .pin",
          within: ".tile",
        },
      ].map((assertion) => briefAssertionSchema.parse(assertion)),
    },
  ],
};

const mismatches = async (name: string) =>
  (
    await reviewFixture(browser, await fixture(name), {
      decidedBriefs: [brief],
    })
  )
    .filter(({ candidate }) => candidate.category === "brief-mismatch")
    .map(({ candidate }) => candidate);

test("a full-size sibling pin breaks both parts of the decided brief", async () => {
  const found = await mismatches("brief-drawer-sibling.html");
  const rules = new Set(found.map((candidate) => candidate.rule));
  expect(rules).toEqual(
    new Set([
      "idiom:brief-mismatch:pinned-group:c0:a0:size",
      "idiom:brief-mismatch:pinned-group:c0:a1:within",
    ]),
  );
  // One finding per drawer item for each part.
  expect(found).toHaveLength(6);
  const explanations = found.map((candidate) => candidate.explanation);
  expect(explanations).toContain(
    `Brief "Pinned group in the Add drawer" (pinned-group), criterion "${statement}": .drawer-item height 100, expected 56 (tolerance 1)`,
  );
  expect(explanations).toContain(
    `Brief "Pinned group in the Add drawer" (pinned-group), criterion "${statement}": .drawer-item .pin extends 44px below .tile`,
  );
  expect(found[0]?.severity).toBe("major");
  expect(found[0]?.acceptance).toEqual([`${statement} (brief pinned-group)`]);
});

test("the small in-tile icon passes the same brief", async () => {
  expect(await mismatches("brief-drawer-icon.html")).toEqual([]);
});
