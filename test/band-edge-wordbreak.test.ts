import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { bandEdgesCheck } from "../src/checks/band-edges.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type {
  BandEdgeObservation,
  CheckTuple,
  ObservationArtifactV2,
  WordBreakObservation,
} from "../src/checks/types.js";
import { wordBreakCheck } from "../src/checks/word-break.js";
import {
  checksConfigSchema,
  defaultChecksSettings,
} from "../src/schemas/project.js";
import { emptyObservation, tupleFor } from "./motion-support.js";

const config = (value: unknown = { bandEdges: {}, wordBreak: {} }) =>
  checksConfigFrom(checksConfigSchema.parse(value));
const band = (
  left: number,
  right = 665,
  selector = `#band-${left}`,
  fullBleedMedia = false,
): BandEdgeObservation => ({
  selector,
  rect: { x: 0, y: 0, width: 800, height: 120 },
  fullBleedMedia,
  content: { left, right, selectors: [`${selector} > div`] },
});
const bands = (records: BandEdgeObservation[]): ObservationArtifactV2 => ({
  ...emptyObservation,
  bandEdges: { status: "ran", records },
});
const runBands = (records: BandEdgeObservation[], tolerance = 8) =>
  bandEdgesCheck.run({
    tuple: tupleFor(bands(records)),
    config: config({ bandEdges: { tolerance } }),
    narrowViewport: false,
  });
const split: WordBreakObservation = {
  selector: "#heading",
  word: "purposeful",
  text: "purposeful",
  start: 0,
  end: 10,
  before: {
    selector: "#heading",
    node: 0,
    start: 7,
    end: 8,
    text: "f",
    rect: { x: 70, y: 0, width: 10, height: 20 },
  },
  after: {
    selector: "#heading",
    node: 0,
    start: 8,
    end: 9,
    text: "u",
    rect: { x: 0, y: 24, width: 10, height: 20 },
  },
};
const words = (records: WordBreakObservation[]): ObservationArtifactV2 => ({
  ...emptyObservation,
  wordBreaks: { status: "ran", records },
});

test("new config is optional, strict, independently defaulted and copied", () => {
  expect(defaultChecksSettings).not.toHaveProperty("bandEdges");
  expect(defaultChecksSettings).not.toHaveProperty("wordBreak");
  expect(checksConfigFrom({ minGap: 3 })).not.toHaveProperty("bandEdges");
  expect(config().bandEdges).toEqual({ enabled: true, tolerance: 8 });
  expect(config().wordBreak).toEqual({ enabled: true });
  expect(config({ bandEdges: { tolerance: 0 } }).bandEdges?.tolerance).toBe(0);
  for (const value of [
    { bandEdges: { tolerance: -1 } },
    { bandEdges: { tolerance: Infinity } },
    { bandEdges: { tolerance: NaN } },
    { bandEdges: { extra: true } },
    { wordBreak: { tolerance: 8 } },
  ])
    expect(checksConfigSchema.safeParse(value).success).toBe(false);
  const settings = checksConfigSchema.parse({ bandEdges: {}, wordBreak: {} });
  const copied = checksConfigFrom(settings);
  expect(copied.bandEdges).not.toBe(settings.bandEdges);
  for (const check of [bandEdgesCheck, wordBreakCheck]) {
    expect(
      check.run({
        tuple: tupleFor(emptyObservation),
        config: checksConfigFrom(),
        narrowViewport: false,
      }).coverage.status,
    ).toBe("skipped");
    expect(
      check.run({
        tuple: tupleFor(emptyObservation),
        config: config({
          bandEdges: { enabled: false },
          wordBreak: { enabled: false },
        }),
        narrowViewport: false,
      }).coverage.status,
    ).toBe("skipped");
  }
});

test.each([
  [143, 665, 8, 0],
  [143.01, 665, 8, 1],
  [135, 656.99, 8, 1],
  [144, 656, 8, 1],
  [136, 665, 0, 1],
  [143.01, 665, 9, 0],
])(
  "edges %s/%s with tolerance %s produce %s findings",
  (left, right, tolerance, count) => {
    const result = runBands(
      [
        band(135, 665, "#a"),
        band(135, 665, "#b"),
        band(135, 665, "#c"),
        band(left, right, "#outlier"),
      ],
      tolerance,
    );
    expect(result.candidates).toHaveLength(count);
    if (count)
      expect(result.candidates[0]).toMatchObject({
        severity: "minor",
        selectorHint: "#outlier",
        verification: { params: { viewportWidth: 800, tolerance } },
      });
  },
);

test("full-bleed bands and empty bands do not vote; sides establish consensus independently", () => {
  const result = runBands([
    band(135, 665, "#a"),
    band(135, 665, "#b"),
    band(224, 665, "#nav"),
    band(0, 800, "#image", true),
    { ...band(0), content: null },
  ]);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.verification.params).toMatchObject({
    dominant: { left: 135, right: 665 },
    deviations: { left: 89, right: 0 },
  });
  const independent = runBands([
    band(0, 700, "#a"),
    band(100, 700, "#b"),
    band(200, 600, "#c"),
  ]);
  expect(independent.candidates.map((c) => c.selectorHint)).toEqual(["#c"]);
  expect(independent.coverage.reason).toContain("left");
});

test.each(
  [[], [135], [135, 224], [135, 135, 224, 224], [0, 8, 16]].map((values) => [
    values,
  ]),
)("no speculative reference for insufficient or tied gutters %j", (values) => {
  const result = runBands(values.map((v, i) => band(v, i * 100, `#b${i}`)));
  expect(result.candidates).toEqual([]);
  expect(result.coverage).toMatchObject({
    status: "ran",
    reason: expect.stringContaining("No dominant"),
  });
});

test("band evidence is scoped to each tuple without pooling viewports, states or schemes", () => {
  const a = tupleFor(
    bands([band(135, 665, "#a"), band(135, 665, "#b"), band(224, 665, "#nav")]),
  );
  const b = {
    ...tupleFor(
      bands([band(24, 776, "#a"), band(24, 776, "#b"), band(24, 776, "#nav")]),
    ),
    state: "other",
    colorScheme: "dark" as const,
    width: 768,
  };
  expect(
    runDeterministicChecks([a, b], undefined, config())
      .candidates.filter((c) => c.candidate.category === "band-edges")
      .map((c) => c.tuple.width),
  ).toEqual([800]);
});

test("word findings combine words and duplicate evidence once per owner and every affected viewport", () => {
  const tuple = tupleFor(
    words([split, split, { ...split, word: "solutions", end: 9 }]),
  );
  const result = runDeterministicChecks(
    [
      tuple,
      { ...tuple, viewport: "tablet", width: 768 },
      { ...tuple, viewport: "narrow", width: 390, observations: words([]) },
    ],
    undefined,
    config(),
  );
  const found = result.candidates.filter(
    (c) => c.candidate.category === "word-break",
  );
  expect(found.map((c) => c.tuple.width)).toEqual([800, 768]);
  expect(found[0]?.candidate.verification.params?.splits).toHaveLength(2);
  expect(found[0]?.candidate).toMatchObject({
    severity: "major",
    rule: "idiom:unhyphenated-word-break",
  });
});

test("empty success, missing/legacy evidence and partial measurements stay distinct", () => {
  for (const [check, key] of [
    [bandEdgesCheck, "bandEdges"],
    [wordBreakCheck, "wordBreaks"],
  ] as const) {
    const run = (observation: ObservationArtifactV2 | undefined) =>
      check.run({
        tuple: { ...tupleFor(emptyObservation), observations: observation },
        config: config(),
        narrowViewport: false,
      });
    expect(
      run({ ...emptyObservation, [key]: { status: "ran", records: [] } })
        .coverage.status,
    ).toBe("ran");
    expect(run(emptyObservation).coverage).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("recapture"),
    });
    expect(run(undefined).coverage.status).toBe("unavailable");
    expect(
      run({
        ...emptyObservation,
        [key]: { status: "partial", reason: "Work limit reached", records: [] },
      }).coverage,
    ).toMatchObject({ status: "unavailable", reason: "Work limit reached" });
    const legacy: CheckTuple = {
      ...tupleFor(emptyObservation),
      observations: { ...emptyObservation, version: 1 },
    };
    expect(
      check.run({ tuple: legacy, config: config(), narrowViewport: false })
        .coverage.status,
    ).toBe("unavailable");
  }
  const partial = {
    ...words([split]),
    wordBreaks: {
      status: "partial" as const,
      reason: "Unsupported writing mode",
      records: [split],
    },
  };
  expect(
    wordBreakCheck.run({
      tuple: tupleFor(partial),
      config: config(),
      narrowViewport: false,
    }).candidates,
  ).toHaveLength(1);
});

test("strict artifacts retain old captures and validate bounded finite geometry and offsets", () => {
  for (const observation of [
    emptyObservation,
    bands([band(135)]),
    words([split]),
    {
      ...words([]),
      wordBreaks: { status: "unavailable", reason: "Unsupported", records: [] },
    },
  ])
    expect(
      observationArtifactSchema.parse(JSON.parse(JSON.stringify(observation))),
    ).toEqual(observation);
  const { maskMembership: _, version: __, ...v1 } = emptyObservation;
  expect(
    observationArtifactSchema.safeParse({ ...v1, version: 1 }).success,
  ).toBe(true);
  const bad = [
    { bandEdges: { status: "partial", records: [] } },
    {
      bandEdges: {
        status: "ran",
        records: [
          { ...band(135), rect: { x: NaN, y: 0, width: 100, height: 2 } },
        ],
      },
    },
    {
      bandEdges: {
        status: "ran",
        records: [
          {
            ...band(135),
            content: { left: 200, right: 100, selectors: ["#content"] },
          },
        ],
      },
    },
    { bandEdges: { status: "ran", records: [{ ...band(135), extra: 1 }] } },
    { wordBreaks: { status: "ran", records: [{ ...split, end: -1 }] } },
    {
      wordBreaks: {
        status: "ran",
        records: [{ ...split, before: { ...split.before, extra: true } }],
      },
    },
    {
      wordBreaks: {
        status: "ran",
        records: [{ ...split, after: { ...split.after, start: 10, end: 8 } }],
      },
    },
  ];
  for (const override of bad)
    expect(
      observationArtifactSchema.safeParse({ ...emptyObservation, ...override })
        .success,
    ).toBe(false);
});

test("saved geometry flows through findings, reports, verification identities and baselines", async () => {
  const { buildDeterministicDrafts, finalizeFindings } = await import(
    "../src/review/findings.js"
  );
  const { findingSchema } = await import("../src/schemas/finding.js");
  const { renderReport } = await import("../src/review/report.js");
  const { deterministicFingerprintSet, deterministicCandidateRecords } =
    await import("../src/verify/evaluate.js");
  const { baselineFindingSchema } = await import("../src/baseline/schema.js");
  const { checksConfigHash } = await import("../src/baseline/config-hash.js");
  const settings = checksConfigSchema.parse({ bandEdges: {}, wordBreak: {} });
  const saved = observationArtifactSchema.parse(
    JSON.parse(
      JSON.stringify({
        ...bands([
          band(135, 665, "#a"),
          band(135, 665, "#b"),
          band(224, 665, "#nav"),
        ]),
        wordBreaks: { status: "ran", records: [split] },
      }),
    ),
  );
  const tuple = { ...tupleFor(emptyObservation), observations: saved };
  const result = runDeterministicChecks(
    [tuple],
    undefined,
    checksConfigFrom(settings),
  );
  const entries = result.candidates.filter((c) =>
    ["band-edges", "word-break"].includes(c.candidate.category),
  );
  const findings = finalizeFindings({
    runId: "fixture",
    drafts: buildDeterministicDrafts({ runId: "fixture", entries }),
  });
  expect(findings).toHaveLength(2);
  const identities = deterministicFingerprintSet(
    [tuple],
    "light",
    checksConfigFrom(settings),
  );
  for (const finding of findings) {
    expect(findingSchema.parse(JSON.parse(JSON.stringify(finding)))).toEqual(
      finding,
    );
    expect(identities.has(finding.fingerprint)).toBe(true);
    expect(finding.verification.params?.selector).toBeTruthy();
  }
  const records = deterministicCandidateRecords({
    tuples: [tuple],
    legacyColorScheme: "light",
    expectedTupleKeys: [],
    config: checksConfigFrom(settings),
  });
  for (const record of records.filter((r) =>
    ["band-edges", "word-break"].includes(r.category),
  ))
    expect(
      baselineFindingSchema.safeParse({
        fingerprint: record.fingerprint,
        aliases: record.aliases,
        category: record.category,
        rule: record.rule,
        severity: record.severity,
        selector: record.selector,
      }).success,
    ).toBe(true);
  expect(checksConfigHash(settings)).not.toBe(
    checksConfigHash(checksConfigSchema.parse({})),
  );
  const report = renderReport({
    flow: tuple.flow,
    commit: "fixture",
    findings,
    tuples: [tuple],
    coverage: result.coverage,
    outcome: { kind: "deterministic-only" },
  });
  expect(report).toContain("band-edges");
  expect(report).toContain("word-break");
});
