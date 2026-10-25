import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { adjacentGapCheck } from "../src/checks/adjacent-gap.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  FindingCandidate,
  ObservationArtifactV2,
} from "../src/checks/types.js";
import { checkMarks, checksConfigSchema } from "../src/schemas/project.js";
import { type ReviewOptions, reviewStates } from "./benchmark-support.js";

let browser: Browser;
let html: string;
beforeAll(async () => {
  browser = await chromium.launch();
  html = await readFile(
    join(import.meta.dirname, "fixtures/adjacent-gap/editor.html"),
    "utf8",
  );
});
afterAll(async () => {
  await browser.close();
});

async function gaps(
  options: Omit<ReviewOptions, "state" | "focus"> & { focus?: string } = {},
) {
  const { focus, ...shared } = options;
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "editor", html, ...(focus === undefined ? {} : { focus }) }],
    shared,
  );
  return {
    found: findings
      .map(({ candidate }) => candidate)
      .filter((candidate) => candidate.category === "adjacent-gap"),
    tuples,
  };
}

const naming = (found: FindingCandidate[], ...parts: string[]) =>
  found.filter((c) => parts.every((part) => c.explanation.includes(part)));

test("flush layout regions, indicator dots and cross-subtree shapes are not reported", async () => {
  for (const focus of [undefined, "#ai-input"]) {
    const { found } = await gaps(focus === undefined ? {} : { focus });
    for (const quiet of [
      'nav[aria-label="Panels"]',
      "#content",
      "#ed-controls",
      "#asg-content",
      "#style-dialog",
      "#settings-dialog",
      "#section-general",
      "#section-advanced",
      "#panel-left",
      "#panel-right",
      "#dot-small",
      "#dot-ring",
      "#loose-a",
      "#loose-b",
    ])
      expect(naming(found, quiet), quiet).toEqual([]);
  }
});

test("stepper buttons touching their number input are reported in the field", async () => {
  const { found } = await gaps();
  for (const [label, wrapper] of [
    ["Line height", "#field-line-height"],
    ["Letter spacing", "#field-letter-spacing"],
    ["Opacity", "#field-opacity"],
  ] as const) {
    const lower = label.toLowerCase();
    const input = naming(
      found,
      `input[aria-label="${label}"]`,
      `button[aria-label="Decrease ${lower}"]`,
    );
    expect(input, label).toHaveLength(1);
    expect(input[0]?.severity).toBe("major");
    expect(input[0]?.explanation).toContain(`in ${wrapper}`);
    expect(input[0]?.verification.params).toMatchObject({ parent: wrapper });
    expect(
      naming(
        found,
        `button[aria-label="Decrease ${lower}"]`,
        `button[aria-label="Increase ${lower}"]`,
      ),
      label,
    ).toHaveLength(1);
  }
});

test("a composer field's ring touching Send is a major collision; at rest it has air", async () => {
  const rest = await gaps();
  expect(naming(rest.found, "#ai-input")).toEqual([]);
  expect(naming(rest.found, "#ai-send")).toEqual([]);
  const focused = await gaps({ focus: "#ai-input" });
  const ring = naming(focused.found, "#ai-input", "#ai-send");
  expect(ring).toHaveLength(1);
  expect(ring[0]).toMatchObject({
    severity: "major",
    rule: "idiom:focus-ring-collision",
  });
  expect(ring[0]?.explanation).toContain("within 0px");
  expect(ring[0]?.explanation).toContain("in #composer");
  expect(ring[0]?.verification.params).toMatchObject({ parent: "#composer" });
});

test("bordered shapes flush within one parent are still reported", async () => {
  const { found } = await gaps();
  const cards = naming(found, "#card-a", "#card-b");
  expect(cards).toHaveLength(1);
  expect(cards[0]?.explanation).toContain("in #cards");
  for (const candidate of found)
    expect(candidate.verification.params?.parent).toBeTypeOf("string");
});

test("configured region selectors are never compared", async () => {
  const { found } = await gaps({
    checks: { adjacentGap: { regions: [".cards > .card:first-child"] } },
  });
  expect(naming(found, "#card-a", "#card-b")).toEqual([]);
});

test("indicatorMax 0 compares indicator dots again", async () => {
  const { found } = await gaps({
    checks: { adjacentGap: { indicatorMax: 0 } },
  });
  expect(naming(found, "#dot-ring", "#unit-em")).toHaveLength(1);
  expect(naming(found, "#dot-small", "#unit-px")).toHaveLength(1);
});

test("captures without outlineOffset measure the ring as before", async () => {
  const { tuples } = await gaps({ focus: "#ai-input" });
  const tuple = tuples[0];
  const observation = tuple?.observations as ObservationArtifactV2;
  expect(observationArtifactSchema.parse(observation)).toEqual(observation);
  for (const element of observation.elements)
    delete element.styles.outlineOffset;
  expect(observationArtifactSchema.parse(observation)).toEqual(observation);
  const result = adjacentGapCheck.run({
    tuple: {
      ...(tuple as NonNullable<typeof tuple>),
      observations: observation,
    },
    narrowViewport: false,
    config: checksConfigFrom(),
  });
  const ring = result.candidates.filter(
    (c) =>
      c.explanation.includes("#ai-input") && c.explanation.includes("#ai-send"),
  );
  expect(ring).toHaveLength(1);
  expect(ring[0]).toMatchObject({
    severity: "minor",
    rule: "idiom:focus-ring-collision",
  });
  expect(ring[0]?.explanation).toContain("within 2px");
});

test("adjacentGap config defaults, rejects unknown keys and marks regions", () => {
  const defaults = checksConfigSchema.parse({});
  expect(defaults.adjacentGap).toEqual({ regions: [], indicatorMax: 16 });
  expect(checksConfigFrom(defaults).adjacentGap).toEqual({ indicatorMax: 16 });
  expect(
    checksConfigSchema.safeParse({ adjacentGap: { gap: 4 } }).success,
  ).toBe(false);
  expect(
    checksConfigSchema.safeParse({ adjacentGap: { indicatorMax: -1 } }).success,
  ).toBe(false);
  const settings = checksConfigSchema.parse({
    adjacentGap: { regions: [".rail", ".rail"] },
  });
  expect(
    checkMarks(settings).filter((mark) => mark.purpose === "adjacent-region"),
  ).toEqual([{ purpose: "adjacent-region", selector: ".rail" }]);
});

test("the observation schema accepts adjacent-region marks", async () => {
  const { tuples } = await gaps({
    checks: { adjacentGap: { regions: ["#cards"] } },
  });
  const observation = tuples[0]?.observations as ObservationArtifactV2;
  expect(
    observation.selectorMarks?.find(
      (mark) => mark.purpose === "adjacent-region",
    ),
  ).toMatchObject({ selector: "#cards", matches: ["#cards"] });
  expect(observationArtifactSchema.parse(observation)).toEqual(observation);
});
