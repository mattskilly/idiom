import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { crampedPaddingCheck } from "../src/checks/cramped-padding.js";
import { edgeTextCheck } from "../src/checks/edge-text.js";
import { headingRhythmCheck } from "../src/checks/heading-rhythm.js";
import { hiddenAtRestCheck } from "../src/checks/hidden-at-rest.js";
import { numericAlignCheck } from "../src/checks/numeric-align.js";
import { raggedRowCheck } from "../src/checks/ragged-row.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { textOcclusionCheck } from "../src/checks/text-occlusion.js";
import { typeLegibilityCheck } from "../src/checks/type-legibility.js";
import type {
  ChecksConfig,
  DeterministicCheck,
  HiddenAtRestScan,
  ObservationArtifactV2,
  TypeLegibilityObservation,
} from "../src/checks/types.js";
import {
  checksConfigSchema,
  hiddenOkMarks,
  legibilityOptions,
} from "../src/schemas/project.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const run = (
  check: DeterministicCheck,
  fields: Partial<ObservationArtifactV2>,
  config: ChecksConfig = checksConfigFrom(),
  width?: number,
) =>
  check.run({
    tuple: {
      ...invariantTuple({ ...invariantObservations(), ...fields }),
      ...(width === undefined ? {} : { width }),
    },
    tuples: [],
    narrowViewport: false,
    config,
  });

const rect = { x: 0, y: 0, width: 300, height: 40 };
const hiddenRecord = {
  selector: "section.reveal > p",
  root: "section.reveal",
  cause: "opacity" as const,
  opacity: 0,
  rect,
  text: "Repairs",
};
const atRest = (fields: Partial<HiddenAtRestScan>): HiddenAtRestScan => ({
  status: "ran",
  total: 100,
  hidden: 0,
  area: 10000,
  hiddenArea: 0,
  inFlight: 0,
  records: [hiddenRecord],
  ...fields,
});
const edge = {
  selector: "main > p",
  side: "left" as const,
  distance: 15.9,
  threshold: 16,
  rect,
  text: "Repairs",
};
const cramped = {
  container: "div.card",
  selector: "div.card > p",
  side: "left" as const,
  distance: 2,
  rect,
  text: "Repairs",
};
const heading = {
  selector: "article > h2",
  level: 2,
  text: "Wheels",
  gapAbove: 16,
  gapBelow: 16,
  above: "article > p:nth-of-type(1)",
  below: "article > p:nth-of-type(2)",
};
const type = (
  fields: Partial<TypeLegibilityObservation>,
): TypeLegibilityObservation => ({
  selector: "p.fine",
  reason: "small-body",
  value: 11,
  text: "Repairs",
  rect,
  ...fields,
});
const column = {
  container: "table.invoice",
  kind: "table" as const,
  column: 1,
  header: "Amount",
  cells: 4,
  numeric: 4,
  problems: ["left-aligned" as const],
  example: "1,204.50",
};
const ragged = {
  collection: "div.plans",
  row: 0,
  items: 3,
  spread: 8.5,
  heights: [100, 108.5, 104],
  tallest: "div.plans > div:nth-of-type(2)",
  shortest: "div.plans > div:nth-of-type(1)",
};
const occlusion = {
  text: "p.copy",
  cover: "img.stamp",
  ratio: 0.52,
  samples: 23,
  covered: 12,
  rect,
};
const ran = <T>(records: T[]) => ({ status: "ran" as const, records });

const all = [
  [hiddenAtRestCheck, "hidden-at-rest scan", "hiddenAtRest"],
  [edgeTextCheck, "edge-text scan", "edgeText"],
  [crampedPaddingCheck, "cramped-padding scan", "crampedPadding"],
  [headingRhythmCheck, "heading-rhythm scan", "headingRhythm"],
  [typeLegibilityCheck, "type-legibility scan", "typeLegibility"],
  [numericAlignCheck, "numeric-align scan", "numericAlign"],
  [raggedRowCheck, "ragged-row scan", "raggedRow"],
  [textOcclusionCheck, "text-occlusion scan", "textOcclusion"],
] as const;
const everything: Partial<ObservationArtifactV2> = {
  hiddenAtRest: atRest({ hidden: 50, hiddenArea: 5000 }),
  edgeTexts: ran([edge]),
  crampedPaddings: ran([cramped]),
  headingRhythms: ran([heading]),
  typeLegibility: ran([type({})]),
  numericColumns: ran([column]),
  raggedRows: ran([ragged]),
  textOcclusions: [occlusion],
};

test.each(all)(
  "%o is unavailable when the observation predates its scan",
  (check, scan) => {
    expect(run(check, {}).coverage).toMatchObject({
      status: "unavailable",
      reason: `observations predate the ${scan} (recapture)`,
    });
  },
);

test.each(all)("%o is skipped when disabled", (check, _scan, key) => {
  const result = run(
    check,
    everything,
    checksConfigFrom({ [key]: { enabled: false } }),
  );
  expect(result.coverage).toMatchObject({
    status: "skipped",
    reason: `checks.${key} is not enabled`,
  });
  expect(result.candidates).toEqual([]);
});

test.each(all)("%o reports minor findings when enabled", (check) => {
  const result = run(check, everything);
  expect(result.coverage.status).toBe("ran");
  expect(result.candidates.length).toBeGreaterThan(0);
  expect(result.candidates.every((c) => c.severity === "minor")).toBe(true);
  expect(result.candidates.every((c) => c.category === check.id)).toBe(true);
});

test("hidden-at-rest fires above a fifth by count or by area, never at exactly a fifth", () => {
  const fires = (fields: Partial<HiddenAtRestScan>) =>
    run(hiddenAtRestCheck, { hiddenAtRest: atRest(fields) }).candidates.length;
  expect(fires({ hidden: 20, hiddenArea: 2000 })).toBe(0);
  expect(fires({ hidden: 21, hiddenArea: 0 })).toBe(1);
  expect(fires({ hidden: 1, hiddenArea: 2100 })).toBe(1);
  expect(fires({ total: 0, area: 0, hidden: 0, records: [] })).toBe(0);
  const [finding] = run(hiddenAtRestCheck, {
    hiddenAtRest: atRest({
      hidden: 3,
      total: 4,
      hiddenArea: 9000,
      records: [
        { ...hiddenRecord, root: "div.other", selector: "div.other > p" },
        hiddenRecord,
        { ...hiddenRecord, selector: "section.reveal > h2" },
      ],
    }),
  }).candidates;
  expect(finding?.fingerprintHint).toBe("hidden-at-rest:section.reveal");
  expect(finding?.selectorHint).toBe("section.reveal");
  expect(finding?.explanation).toMatch(
    /^3 of 4 text blocks in the viewport \(75% by count, 90% by area\) are invisible at 800px/,
  );
  expect(finding?.explanation).toContain(
    "Most sit under section.reveal (opacity 0)",
  );
});

test("a partial hidden-at-rest scan still reports and says it was incomplete", () => {
  const result = run(hiddenAtRestCheck, {
    hiddenAtRest: atRest({
      status: "partial",
      reason: "more than 2000 text blocks; scanned the first 2000",
      hidden: 50,
    }),
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.coverage).toMatchObject({
    status: "unavailable",
    reason: "more than 2000 text blocks; scanned the first 2000",
  });
});

test("edge text merges both sides of one element into one finding", () => {
  const result = run(edgeTextCheck, {
    edgeTexts: ran([edge, { ...edge, side: "right", distance: 3 }]),
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.fingerprintHint).toBe("edge-text:main > p");
  expect(result.candidates[0]?.explanation).toBe(
    "Body text in main > p sits 15.9px from the left edge and 3px from the right edge of the 800px viewport; text needs at least 16px from the screen's edge at this width.",
  );
});

test("cramped padding names the container, side and distance", () => {
  const [finding] = run(crampedPaddingCheck, {
    crampedPaddings: ran([cramped]),
  }).candidates;
  expect(finding?.fingerprintHint).toBe("cramped-padding:div.card");
  expect(finding?.explanation).toBe(
    "Text in div.card (div.card > p) sits 2px from the box's left inner edge at 800px; text inside a bordered or filled box needs at least 4px of room.",
  );
});

test("heading rhythm words equal gaps as a finding", () => {
  const [finding] = run(headingRhythmCheck, {
    headingRhythms: ran([heading]),
  }).candidates;
  expect(finding?.explanation).toBe(
    'The heading article > h2 ("Wheels") sits 16px below article > p:nth-of-type(1) and 16px above article > p:nth-of-type(2) at 800px; a heading should be closer to the content it introduces than to the block before it.',
  );
  expect(finding?.acceptance).toEqual([
    "At 800px, the gap above article > h2 is larger than the gap below it.",
  ]);
});

test("type legibility groups by reason and value, so 14 paragraphs at 11px report once", () => {
  const records = Array.from({ length: 14 }, (_, index) =>
    type({ selector: `p:nth-of-type(${index + 1})` }),
  );
  const result = run(typeLegibilityCheck, {
    typeLegibility: ran([
      ...records,
      type({ reason: "small-body", value: 10 }),
      type({ reason: "all-caps", value: 41, selector: "p.a" }),
      type({ reason: "all-caps", value: 35, selector: "p.b" }),
    ]),
  });
  expect(result.candidates.map((c) => c.fingerprintHint)).toEqual([
    "type-legibility:small-body:11",
    "type-legibility:small-body:10",
    "type-legibility:all-caps",
  ]);
  expect(result.candidates[0]?.explanation).toBe(
    "Body text is set at 11px (under 12px) in 14 places at 800px, for example p:nth-of-type(1), p:nth-of-type(2), p:nth-of-type(3).",
  );
  expect(result.candidates[0]?.verification.params).toMatchObject({
    count: 14,
    value: 11,
  });
  expect(result.candidates[2]?.verification.params).not.toHaveProperty("value");
});

test("numeric align names the column and both problems", () => {
  const [finding] = run(numericAlignCheck, {
    numericColumns: ran([
      { ...column, problems: ["left-aligned", "proportional-figures"] },
    ]),
  }).candidates;
  expect(finding?.fingerprintHint).toBe("numeric-align:table.invoice:1");
  expect(finding?.explanation).toBe(
    'In table.invoice, the "Amount" column holds numbers in 4 of 4 cells (such as 1,204.50) and is left-aligned, so digits of different lengths do not line up, and set in proportional figures (no tabular-nums), so digits differ in width at 800px.',
  );
  const [unnamed] = run(numericAlignCheck, {
    numericColumns: ran([{ ...column, header: "", kind: "list" as const }]),
  }).candidates;
  expect(unnamed?.explanation).toContain("column 2 holds numbers");
});

test("ragged rows are per row, worded with the spread and heights", () => {
  const [finding] = run(raggedRowCheck, {
    raggedRows: ran([ragged]),
  }).candidates;
  expect(finding?.fingerprintHint).toBe("ragged-row:div.plans:0");
  expect(finding?.explanation).toBe(
    "The 3 cards in row 1 of div.plans end up to 8.5px apart at 800px (heights 100–109px; tallest div.plans > div:nth-of-type(2), shortest div.plans > div:nth-of-type(1)).",
  );
});

test("text occlusion names the cover and the covered share", () => {
  const [finding] = run(textOcclusionCheck, {
    textOcclusions: [occlusion],
  }).candidates;
  expect(finding?.fingerprintHint).toBe("text-occlusion:p.copy:img.stamp");
  expect(finding?.explanation).toBe(
    "img.stamp is painted over 52% of the text in p.copy at 800px (12 of 23 sampled points), so part of it cannot be read.",
  );
});

test("hiddenOkMarks takes intentionallyHidden and the selectors steps wait to hide", () => {
  expect(
    hiddenOkMarks({
      intentionallyHidden: ["#later", ".toast"],
      steps: [
        { action: "click", selector: "#open" },
        { action: "waitFor", selector: ".spinner", state: "hidden" },
        { action: "waitFor", selector: ".panel", state: "visible" },
        { action: "waitFor", selector: "#later", state: "hidden" },
      ],
    }),
  ).toEqual([
    { purpose: "hidden-ok", selector: "#later" },
    { purpose: "hidden-ok", selector: ".toast" },
    { purpose: "hidden-ok", selector: ".spinner" },
  ]);
  expect(hiddenOkMarks({})).toEqual([]);
});

test("legibilityOptions follows the in-page toggles and the negative-spacing scope", () => {
  expect(
    legibilityOptions(
      checksConfigSchema.parse({ raggedRow: { enabled: false } }),
    ),
  ).toEqual({
    hiddenAtRest: true,
    edgeText: true,
    crampedPadding: true,
    headingRhythm: true,
    typeLegibility: true,
    numericAlign: true,
    raggedRow: false,
    controlGap: true,
    negativeSpacing: true,
    negativeSpacingScope: "interface",
  });
});

test("the artifact schema accepts the new records and a hidden-ok mark, and rejects over-cap arrays", () => {
  const observations = {
    ...invariantObservations(),
    ...everything,
    selectorMarks: [
      { purpose: "hidden-ok", selector: "#later", matches: ["#later"] },
    ],
  };
  expect(observationArtifactSchema.parse(observations)).toEqual(observations);
  expect(
    observationArtifactSchema.safeParse({
      ...observations,
      textOcclusions: Array.from({ length: 51 }, () => occlusion),
    }).success,
  ).toBe(false);
  expect(
    observationArtifactSchema.safeParse({
      ...observations,
      edgeTexts: ran(Array.from({ length: 51 }, () => edge)),
    }).success,
  ).toBe(false);
  expect(
    observationArtifactSchema.safeParse({
      ...observations,
      hiddenAtRest: atRest({
        records: Array.from({ length: 21 }, () => hiddenRecord),
      }),
    }).success,
  ).toBe(false);
  expect(
    observationArtifactSchema.safeParse({
      ...observations,
      numericColumns: ran([{ ...column, extra: true }]),
    }).success,
  ).toBe(false);
});
