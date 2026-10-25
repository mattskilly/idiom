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
    new URL(`./fixtures/compound-controls/${name}.html`, import.meta.url),
    "utf8",
  );
const compound = (findings: Awaited<ReturnType<typeof reviewFixture>>) =>
  findings
    .filter((f) => f.candidate.category === "compound-control")
    .map((f) => f.candidate);

test("the Size control is flagged twice: duplicate unit and suffix on the border", async () => {
  let observations: ObservationArtifact | undefined;
  const found = compound(
    await reviewFixture(browser, await html("before"), {
      checks: { compoundControls: {} },
      onObservations: (value) => {
        observations = value;
      },
    }),
  );
  const select =
    observations?.version === 2
      ? observations.elements.find((e) => e.selector === "#width-unit")
      : undefined;
  expect(select?.signals?.value).toBe("px");
  expect(found.map((c) => [c.rule, c.selectorHint, c.severity]).sort()).toEqual(
    [
      ["idiom:compound-control-adornment-inset", expect.any(String), "major"],
      ["idiom:compound-control-adornment-inset", expect.any(String), "major"],
      ["idiom:compound-control-duplicate-token", "#height-unit", "minor"],
      ["idiom:compound-control-duplicate-token", "#width-unit", "minor"],
    ].sort(),
  );
  const width = found.filter((c) => c.explanation.includes('"Width"'));
  expect(width).toHaveLength(2);
  for (const candidate of width) expect(candidate.explanation).toContain("px");
  // The correctly inset "%" suffix and the "Medium" select are not flagged.
  expect(found.some((c) => c.explanation.includes("Opacity"))).toBe(false);
  expect(found.some((c) => c.selectorHint === "#font-size")).toBe(false);
});

test("the fixed Size control has no compound-control findings", async () => {
  expect(
    compound(
      await reviewFixture(browser, await html("after"), {
        checks: { compoundControls: {} },
      }),
    ),
  ).toEqual([]);
});

test("compound-control is skipped without checks.compoundControls", async () => {
  expect(compound(await reviewFixture(browser, await html("before")))).toEqual(
    [],
  );
});
