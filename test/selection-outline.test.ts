import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
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
    new URL(`./fixtures/selection-outline/${name}.html`, import.meta.url),
    "utf8",
  );
const crossings = (findings: Awaited<ReturnType<typeof reviewFixture>>) =>
  findings
    .map(({ candidate }) => candidate)
    .filter(
      (candidate) =>
        candidate.rule === "idiom:selection-outline-crosses-popover",
    );

test("a selection frame drawn across an open dropdown is flagged", async () => {
  let observations: ObservationArtifact | undefined;
  const found = crossings(
    await reviewFixture(browser, await html("open"), {
      onObservations: (value) => {
        observations = value;
      },
    }),
  );
  expect(found.map((c) => [c.severity, c.selectorHint])).toEqual([
    ["major", "#block"],
  ]);
  const scan =
    observations?.version === 2 ? observations.selectionOutlines : undefined;
  expect(scan?.status).toBe("ran");
  expect(scan?.records).toHaveLength(1);
  expect(scan?.records[0]).toMatchObject({
    owner: "#block",
    ownerName: "Navigation block",
    ownerState: "framed",
    painter: "#frame",
    kind: "border",
    popover: "#menu",
    popoverRole: "menu",
    crossing: { x: 144, y: 102, width: 192, height: 2 },
    stacking: "hit-test",
  });
  expect(found[0]?.explanation).toBe(
    "The framed outline of Navigation block (#block), drawn by #frame as border, runs across the open menu #menu for 192×2px at (144, 102) even though the menu is above it.",
  );
  expect(() => observationArtifactSchema.parse(observations)).not.toThrow();
});

test("a frame beside a closed dropdown is not flagged", async () => {
  let observations: ObservationArtifact | undefined;
  expect(
    crossings(
      await reviewFixture(browser, await html("closed"), {
        onObservations: (value) => {
          observations = value;
        },
      }),
    ),
  ).toEqual([]);
  expect(
    observations?.version === 2 ? observations.selectionOutlines : undefined,
  ).toEqual({ status: "ran", records: [] });
});

test("an element's own outline paints beneath the open dropdown and is not flagged", async () => {
  expect(
    crossings(await reviewFixture(browser, await html("self-outline"))),
  ).toEqual([]);
});

test("a frame around another block beside an open dropdown is not flagged", async () => {
  expect(crossings(await reviewFixture(browser, await html("beside")))).toEqual(
    [],
  );
});

test("a dropdown the probe opens is judged in its revealed state", async () => {
  let observations: ObservationArtifact | undefined;
  const found = crossings(
    await reviewFixture(browser, await html("toggle"), {
      probe: true,
      onObservations: (value) => {
        observations = value;
      },
    }),
  );
  expect(found).toHaveLength(1);
  expect(found[0]?.explanation).toMatch(
    /^editor › Products: The focused outline of Navigation block/,
  );
  expect(found[0]?.fingerprintHint).toBe(
    "revealed Products | idiom:selection-outline-crosses-popover|#block|#menu",
  );
  expect(() => observationArtifactSchema.parse(observations)).not.toThrow();
}, 60_000);
