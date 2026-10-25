import { expect, test } from "vitest";
import { emptyStateCheck } from "../src/checks/empty-state.js";
import { progressAffordanceCheck } from "../src/checks/progress-affordance.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  DeterministicCheck,
  EmptyRegionObservation,
  ObservationArtifact,
  ProgressStep,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { emptyObservation, tupleFor } from "./motion-support.js";

function run(
  check: DeterministicCheck,
  observations?: ObservationArtifact,
  settings = {},
) {
  const tuple = { ...tupleFor(emptyObservation), observations };
  return check.run({
    tuple,
    narrowViewport: false,
    tuples: [tuple],
    config: checksConfigFrom(checksConfigSchema.parse(settings)),
  });
}
const region: EmptyRegionObservation = {
  selector: "#canvas",
  source: "configured",
  configured: "#canvas",
  rect: { x: 0, y: 0, width: 400, height: 200 },
  scope: "region",
  cta: [],
  text: "",
};
const settings = {
  emptyState: { regions: [{ selector: "#canvas", items: ".block" }] },
};
const empty = (regions: EmptyRegionObservation[]) => ({
  ...emptyObservation,
  emptyRegions: {
    auto: true,
    configured: [{ selector: "#canvas", matched: 1 }],
    regions,
  },
});
const step: ProgressStep = {
  stepIndex: 1,
  action: "click",
  selector: "#generate",
  status: "ran",
  firstMs: null,
  observedMs: 1100,
  settledMs: 200,
};
const progress = (changes: Partial<ProgressStep> = {}) => ({
  ...emptyObservation,
  progress: {
    version: 1 as const,
    withinMs: 1000,
    steps: [{ ...step, ...changes }],
  },
});

test("legacy captures disclose unavailable empty-state and progress coverage", () => {
  const v1 = { ...emptyObservation, version: 1 as const };
  for (const observation of [undefined, v1, emptyObservation]) {
    expect(run(emptyStateCheck, observation).coverage.status).toBe(
      "unavailable",
    );
  }
  expect(run(progressAffordanceCheck, v1).coverage.status).toBe("unavailable");
  expect(run(progressAffordanceCheck, emptyObservation).coverage.status).toBe(
    "skipped",
  );
});

test.each([
  [[], "", "no call to action and no explanatory text"],
  [["button"], "", "no text explaining"],
  [[], "No blocks yet", "but no call to action"],
  [["button"], "Empty", "no text explaining"],
])("empty-state explains missing evidence: %j %s", (cta, text, explanation) => {
  const result = run(
    emptyStateCheck,
    empty([{ ...region, cta, text }]),
    settings,
  );
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    severity: "major",
    explanation: expect.stringContaining(explanation),
  });
});

test("empty-state passes complete evidence and uses minor severity for automatic lists", () => {
  expect(
    run(
      emptyStateCheck,
      empty([{ ...region, cta: ["button"], text: "No blocks yet" }]),
      settings,
    ).candidates,
  ).toEqual([]);
  expect(
    run(emptyStateCheck, empty([{ ...region, source: "list" }])).candidates[0]
      ?.severity,
  ).toBe("minor");
  expect(
    run(emptyStateCheck, empty([]), { emptyState: { auto: false } }).coverage
      .status,
  ).toBe("skipped");
  expect(
    run(
      emptyStateCheck,
      {
        ...emptyObservation,
        emptyRegions: { auto: true, configured: [], regions: [] },
      },
      settings,
    ).coverage,
  ).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("not resolved at capture"),
  });
  expect(
    run(
      emptyStateCheck,
      {
        ...emptyObservation,
        emptyRegions: {
          auto: true,
          configured: [{ selector: "#canvas", matched: 0 }],
          regions: [],
        },
      },
      settings,
    ).coverage.reason,
  ).toContain("matched no rendered regions");
});

test("progress thresholds rejudge raw hits and disclose insufficient evidence", () => {
  expect(
    run(progressAffordanceCheck, progress({ firstMs: 500 })).candidates,
  ).toEqual([]);
  expect(
    run(progressAffordanceCheck, progress({ firstMs: 1500 })).candidates,
  ).toHaveLength(1);
  expect(
    run(progressAffordanceCheck, progress()).candidates[0]?.explanation,
  ).toContain("settled after 200ms");
  expect(
    run(progressAffordanceCheck, progress({ firstMs: 1500 }), {
      progressWithinMs: 2000,
    }).candidates,
  ).toEqual([]);
  const short = run(progressAffordanceCheck, progress({ observedMs: 500 }));
  expect(short.candidates).toEqual([]);
  expect(short.coverage).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("recapture"),
  });
  expect(
    run(
      progressAffordanceCheck,
      progress({ status: "unavailable", reason: "navigation" }),
    ).coverage,
  ).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("navigation"),
  });
});

test("new observation fields stay optional and strict", async () => {
  const { observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  expect(observationArtifactSchema.parse(emptyObservation)).toEqual(
    emptyObservation,
  );
  expect(
    observationArtifactSchema.safeParse({
      ...emptyObservation,
      emptyRegions: { auto: true, configured: [], regions: [], extra: true },
    }).success,
  ).toBe(false);
  expect(
    observationArtifactSchema.safeParse({
      ...progress(),
      progress: { ...progress().progress, extra: true },
    }).success,
  ).toBe(false);
});
