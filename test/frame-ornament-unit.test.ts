import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { emptyFrameCheck } from "../src/checks/empty-frame.js";
import { glyphOverIconCheck } from "../src/checks/glyph-over-icon.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { repeatedRowOrnamentCheck } from "../src/checks/repeated-row-ornament.js";
import type {
  ChecksConfig,
  DeterministicCheck,
  ObservationArtifactV2,
} from "../src/checks/types.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const run = (
  check: DeterministicCheck,
  fields: Partial<ObservationArtifactV2>,
  config: ChecksConfig = checksConfigFrom(),
) =>
  check.run({
    tuple: invariantTuple({ ...invariantObservations(), ...fields }),
    tuples: [],
    narrowViewport: false,
    config,
  });

const frame = {
  selector: "#bar",
  rect: { x: 0, y: 0, width: 800, height: 64 },
  paint: "border" as const,
  borderSides: ["bottom" as const],
  hiddenChildren: 1,
};
const ornament = {
  collection: "ul.list",
  collectionKind: "list" as const,
  items: 6,
  count: 5,
  kind: "chip" as const,
  text: "Beta",
  example: "ul.list > li:nth-of-type(1) > span",
  name: "Beta",
  width: 36,
  height: 18,
};
const overlap = {
  control: "a.item",
  glyph: "svg.ext",
  icon: "svg.icon",
  controlRect: { x: 0, y: 0, width: 56, height: 56 },
  glyphRect: { x: 33, y: 13, width: 10, height: 10 },
  iconRect: { x: 16, y: 16, width: 24, height: 24 },
  overlap: { width: 7, height: 7 },
  ratio: 0.49,
};

test.each([
  [emptyFrameCheck, "empty-frame scan"],
  [repeatedRowOrnamentCheck, "row-ornament scan"],
  [glyphOverIconCheck, "glyph-over-icon scan"],
])(
  "%o is unavailable when the observation predates its scan",
  (check, scan) => {
    const result = run(check, {});
    expect(result.coverage).toMatchObject({
      status: "unavailable",
      reason: `observations predate the ${scan} (recapture)`,
    });
    expect(
      check.run({
        tuple: { ...invariantTuple(), observations: undefined },
        tuples: [],
        narrowViewport: false,
        config: checksConfigFrom(),
      }).coverage.status,
    ).toBe("unavailable");
  },
);

test.each([
  [emptyFrameCheck, "emptyFrame"],
  [repeatedRowOrnamentCheck, "repeatedRowOrnament"],
  [glyphOverIconCheck, "glyphOverIcon"],
] as const)("%o is skipped when disabled", (check, key) => {
  const result = run(
    check,
    {
      emptyFrames: [frame],
      rowOrnaments: [ornament],
      glyphOverlaps: [overlap],
    },
    checksConfigFrom({ [key]: { enabled: false, ignore: [] } }),
  );
  expect(result.coverage).toMatchObject({
    status: "skipped",
    reason: `checks.${key} is not enabled`,
  });
  expect(result.candidates).toEqual([]);
});

test("an empty frame is minor and worded with its size, sides and hidden children", () => {
  const result = run(emptyFrameCheck, { emptyFrames: [frame] });
  expect(result.coverage.status).toBe("ran");
  expect(result.candidates).toEqual([
    expect.objectContaining({
      category: "empty-frame",
      severity: "minor",
      rule: "idiom:empty-frame",
      selectorHint: "#bar",
      fingerprintHint: "empty-frame:#bar",
      explanation:
        "#bar is a 800×64px box with a bottom border and nothing visible inside it at 800px (1 child is hidden at this width).",
    }),
  ]);
  const filled = run(emptyFrameCheck, {
    emptyFrames: [
      { ...frame, paint: "background", borderSides: [], hiddenChildren: 0 },
    ],
  });
  expect(filled.candidates[0]?.explanation).toBe(
    "#bar is a 800×64px box with a filled background and nothing visible inside it at 800px.",
  );
  expect(run(emptyFrameCheck, { emptyFrames: [] }).candidates).toEqual([]);
});

test("repeated row ornaments are info, one candidate per collection and decoration", () => {
  const result = run(repeatedRowOrnamentCheck, {
    rowOrnaments: [
      ornament,
      { ...ornament, example: "ul.list > li:nth-of-type(2) > span" },
      {
        ...ornament,
        kind: "icon",
        text: "",
        name: "external",
        example: "ul.list svg",
      },
    ],
  });
  expect(result.candidates.map((c) => [c.severity, c.fingerprintHint])).toEqual(
    [
      ["info", "repeated-row-ornament:ul.list|chip|Beta"],
      ["info", "repeated-row-ornament:ul.list|icon|external"],
    ],
  );
  expect(result.candidates[0]?.explanation).toBe(
    'The "Beta" badge (ul.list > li:nth-of-type(1) > span) repeats on 5 of 6 items in ul.list; a mark every item carries does not tell items apart.',
  );
  expect(result.candidates[1]?.explanation).toMatch(/^The "external" icon/);
  expect(result.candidates[0]?.acceptance).toEqual([
    "ul.list shows the decoration only on items it distinguishes, or states it once for the collection.",
  ]);
});

test("a glyph over an icon is minor and names the control, glyph and icon", () => {
  const result = run(glyphOverIconCheck, { glyphOverlaps: [overlap] });
  expect(result.candidates).toEqual([
    expect.objectContaining({
      severity: "minor",
      rule: "idiom:glyph-over-icon",
      selectorHint: "svg.ext",
      fingerprintHint: "glyph-over-icon:a.item|svg.ext",
      explanation:
        "A 10×10px glyph (svg.ext) sits over the icon svg.icon inside the 56×56px control a.item at 800px, covering it with 49% of its own box.",
      acceptance: [
        "Inside a.item, svg.ext does not overlap svg.icon at 800px.",
      ],
    }),
  ]);
});

test("the artifact schema accepts the three records and an empty-ok mark", () => {
  const observations = {
    ...invariantObservations(),
    emptyFrames: [frame],
    rowOrnaments: [ornament],
    glyphOverlaps: [overlap],
    selectorMarks: [
      { purpose: "empty-ok", selector: "#bar", matches: ["#bar"] },
    ],
  };
  expect(observationArtifactSchema.parse(observations)).toEqual(observations);
  expect(
    observationArtifactSchema.safeParse({
      ...observations,
      glyphOverlaps: [{ ...overlap, ratio: 1.5 }],
    }).success,
  ).toBe(false);
  expect(
    observationArtifactSchema.safeParse({
      ...observations,
      emptyFrames: [{ ...frame, extra: true }],
    }).success,
  ).toBe(false);
});
