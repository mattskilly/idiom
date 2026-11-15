import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { controlGapCheck } from "../src/checks/control-gap.js";
import { negativeSpacingCheck } from "../src/checks/negative-spacing.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ChecksConfig,
  ControlGapObservation,
  DeterministicCheck,
  NegativeSpacingObservation,
  ObservationArtifactV2,
} from "../src/checks/types.js";
import { checkMarks, checksConfigSchema } from "../src/schemas/project.js";
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

const rect = { x: 10, y: 10, width: 64, height: 20 };
const gap = (fields: Partial<ControlGapObservation> = {}) => ({
  control: "span.chip",
  first: "span.chip > span:nth-of-type(2)",
  second: "button.reset",
  firstKind: "text" as const,
  secondKind: "control" as const,
  gap: 0,
  rect,
  text: "↑18 ←6×",
  ...fields,
});
const spacing: NegativeSpacingObservation = {
  selector: "span.chip",
  property: "word-spacing",
  value: -2,
  em: -0.15,
  text: "↑18 ←6×",
  rect,
};
const ran = <T>(records: T[]) => ({ status: "ran" as const, records });

const both = [
  [controlGapCheck, "control-gap scan", "controlGap"],
  [negativeSpacingCheck, "negative-spacing scan", "negativeSpacing"],
] as const;
const everything: Partial<ObservationArtifactV2> = {
  controlGaps: ran([gap()]),
  negativeSpacings: ran([spacing]),
};

test.each(both)(
  "%o is unavailable when the observation predates its scan",
  (check, scan) => {
    expect(run(check, {}).coverage).toMatchObject({
      status: "unavailable",
      reason: `observations predate the ${scan} (recapture)`,
    });
  },
);

test.each(both)("%o is skipped when disabled", (check, _scan, key) => {
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

test.each(both)(
  "%o reports minor findings and keeps partial coverage honest",
  (check) => {
    const result = run(check, everything);
    expect(result.coverage.status).toBe("ran");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.severity).toBe("minor");
    expect(result.candidates[0]?.category).toBe(check.id);
    const partial = run(check, {
      controlGaps: {
        status: "partial",
        reason: "more than 50 records; kept the first 50",
        records: [gap()],
      },
      negativeSpacings: {
        status: "partial",
        reason: "more than 50 records; kept the first 50",
        records: [spacing],
      },
    });
    expect(partial.candidates).toHaveLength(1);
    expect(partial.coverage).toMatchObject({
      status: "unavailable",
      reason: "more than 50 records; kept the first 50",
    });
  },
);

test("control gap fires under the configured minimum, never at it", () => {
  const fires = (value: number, min?: number) =>
    run(
      controlGapCheck,
      { controlGaps: ran([gap({ gap: value })]) },
      checksConfigFrom(
        min === undefined ? {} : { controlGap: { enabled: true, min } },
      ),
    ).candidates.length;
  expect(fires(3.5)).toBe(1);
  expect(fires(4)).toBe(0);
  expect(fires(3.5, 3)).toBe(0);
  expect(fires(5, 6)).toBe(1);
});

test("control gap names the control, both parts and the gap, and its identity excludes the gap", () => {
  const [finding] = run(controlGapCheck, {
    controlGaps: ran([gap({ gap: 0.5 })]),
  }).candidates;
  expect(finding?.selectorHint).toBe("span.chip");
  expect(finding?.fingerprintHint).toBe(
    "control-gap:span.chip:span.chip > span:nth-of-type(2):button.reset",
  );
  expect(finding?.explanation).toBe(
    "In span.chip, span.chip > span:nth-of-type(2) and button.reset (text and control) sit 0.5px apart at 800px; parts inside one control need at least 4px between them.",
  );
  expect(finding?.verification.params).toMatchObject({
    selector: "span.chip",
    gap: 0.5,
    min: 4,
  });
  const [other] = run(controlGapCheck, {
    controlGaps: ran([gap({ gap: 1 })]),
  }).candidates;
  expect(other?.fingerprintHint).toBe(finding?.fingerprintHint);
});

test("negative spacing names the selector, property and value", () => {
  const [finding] = run(negativeSpacingCheck, {
    negativeSpacings: ran([spacing]),
  }).candidates;
  expect(finding?.fingerprintHint).toBe(
    "negative-spacing:span.chip:word-spacing",
  );
  expect(finding?.explanation).toContain("word-spacing: -2px (-0.15em)");
  expect(finding?.acceptance).toEqual([
    "span.chip has no negative word-spacing.",
  ]);
});

test("the artifact schema accepts both records and both marks, and rejects a negative gap", () => {
  const observations = {
    ...invariantObservations(),
    ...everything,
    selectorMarks: [
      { purpose: "spacing-include", selector: ".lede", matches: ["p.lede"] },
      { purpose: "spacing-ignore", selector: ".brand", matches: [] },
    ],
  };
  expect(observationArtifactSchema.parse(observations)).toEqual(observations);
  expect(() =>
    observationArtifactSchema.parse({
      ...invariantObservations(),
      controlGaps: ran([gap({ gap: -1 })]),
    }),
  ).toThrow();
  expect(() =>
    observationArtifactSchema.parse({
      ...invariantObservations(),
      negativeSpacings: ran([{ ...spacing, property: "line-height" }]),
    }),
  ).toThrow();
});

test("project settings default, bound the minimum and emit the spacing marks", () => {
  const defaults = checksConfigSchema.parse({});
  expect(defaults.controlGap).toEqual({ enabled: true, min: 4 });
  expect(defaults.negativeSpacing).toEqual({
    enabled: true,
    scope: "interface",
    include: [],
    ignore: [],
  });
  expect(() => checksConfigSchema.parse({ controlGap: { min: 13 } })).toThrow();
  expect(() => checksConfigSchema.parse({ controlGap: { min: -1 } })).toThrow();
  expect(() =>
    checksConfigSchema.parse({ negativeSpacing: { scope: "content" } }),
  ).toThrow();
  const marks = checkMarks(
    checksConfigSchema.parse({
      negativeSpacing: { include: [".lede", ".lede"], ignore: [".brand"] },
    }),
  );
  expect(marks.filter((mark) => mark.purpose.startsWith("spacing-"))).toEqual([
    { purpose: "spacing-include", selector: ".lede" },
    { purpose: "spacing-ignore", selector: ".brand" },
  ]);
  expect(checksConfigFrom().negativeSpacing).toEqual({
    enabled: true,
    scope: "interface",
  });
});

test("a scoped minimum applies only to records inside its surface, and the strictest overlapping law wins", () => {
  const config = checksConfigFrom(
    checksConfigSchema.parse({
      controlGap: {
        scopes: [
          { name: "Toolbar law.", selector: '[role="toolbar"]', min: 6 },
          { name: "Menu law.", selector: '[role="menu"]', min: 8 },
        ],
      },
    }),
  );
  const result = run(
    controlGapCheck,
    {
      controlGaps: ran([
        // Outside every surface: the global 4px minimum.
        gap({ control: "span.outside", gap: 5 }),
        // Inside the toolbar: 5px is under its 6px law.
        gap({ control: "span.toolbar", gap: 5, scopes: ['[role="toolbar"]'] }),
        // Inside both: the 8px menu law wins.
        gap({
          control: "span.both",
          gap: 7,
          scopes: ['[role="toolbar"]', '[role="menu"]'],
        }),
      ]),
    },
    config,
  );
  expect(
    result.candidates.map((candidate) => [
      candidate.selectorHint,
      candidate.verification.params?.min,
      candidate.verification.params?.scope,
    ]),
  ).toEqual([
    ["span.toolbar", 6, '[role="toolbar"]'],
    ["span.both", 8, '[role="menu"]'],
  ]);
  expect(result.candidates[0]?.explanation).toContain(
    'need at least 6px between them (law: "Toolbar law.", in [role="toolbar"])',
  );
  // The fingerprint does not depend on the law.
  expect(result.candidates[0]?.fingerprintHint).toBe(
    `control-gap:span.toolbar:${gap().first}:${gap().second}`,
  );
});

test("records without scopes (older captures) use the global minimum", () => {
  const config = checksConfigFrom(
    checksConfigSchema.parse({
      controlGap: {
        scopes: [
          { name: "Toolbar law.", selector: '[role="toolbar"]', min: 6 },
        ],
      },
    }),
  );
  const result = run(
    controlGapCheck,
    { controlGaps: ran([gap({ gap: 5 }), gap({ control: "span.b", gap: 3 })]) },
    config,
  );
  expect(result.candidates.map((candidate) => candidate.selectorHint)).toEqual([
    "span.b",
  ]);
  expect(result.candidates[0]?.verification.params).not.toHaveProperty("scope");
});

test("scope selectors become gap-scope and centering-scope marks; the artifact keeps record scopes", () => {
  const settings = checksConfigSchema.parse({
    controlGap: {
      scopes: [{ name: "Toolbar law.", selector: '[role="toolbar"]', min: 6 }],
    },
    textCentering: {
      scopes: [
        { name: "Centre law.", selector: '[role="toolbar"]', tolerance: 1 },
      ],
    },
  });
  expect(
    checkMarks(settings).filter(({ purpose }) => purpose.endsWith("-scope")),
  ).toEqual([
    { purpose: "gap-scope", selector: '[role="toolbar"]' },
    { purpose: "centering-scope", selector: '[role="toolbar"]' },
  ]);
  expect(
    observationArtifactSchema.safeParse({
      ...invariantObservations(),
      controlGaps: ran([gap({ scopes: ['[role="toolbar"]'] })]),
    }).success,
  ).toBe(true);
  expect(() =>
    checksConfigSchema.parse({
      controlGap: {
        scopes: [
          { name: "a", selector: '[role="toolbar"]', min: 6 },
          { name: "b", selector: '[role="toolbar"]', min: 5 },
        ],
      },
    }),
  ).toThrow(/unique/);
});

test("configs without the new keys normalise exactly as before", () => {
  const settings = checksConfigSchema.parse({});
  expect(settings.controlGap).toEqual({ enabled: true, min: 4 });
  expect(settings).not.toHaveProperty("textCentering");
  expect(settings).not.toHaveProperty("invariants");
  expect(checksConfigFrom(settings)).not.toHaveProperty("textCentering");
});
