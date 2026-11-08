import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { detachedFlyoutCheck } from "../src/checks/detached-flyout.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ObservationArtifactV2,
  ProbeResult,
  Rect,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const rect = (x = 0, y = 0): Rect => ({ x, y, width: 40, height: 40 });
const result = (panel: Rect): ProbeResult => ({
  selector: "#trigger",
  name: "Settings › More",
  effects: ["aria", "dom"],
  persistent: false,
  status: "completed",
  openedDisclosure: {
    root: "#panel",
    kind: "expanded",
    trigger: rect(),
    panel,
  },
});
const observation = (results: ProbeResult[]): ObservationArtifactV2 => ({
  version: 2,
  viewport: { width: 1440, height: 900 },
  document: {
    scrollWidth: 1440,
    scrollHeight: 900,
    clientWidth: 1440,
    clientHeight: 900,
  },
  elements: [],
  headings: [],
  tokens: { status: "not-configured" },
  maskMembership: [],
  probe: { status: "ran", results },
});
const run = (observations: ObservationArtifactV2) =>
  detachedFlyoutCheck.run({
    tuple: { observations } as CheckTuple,
    tuples: [],
    narrowViewport: true,
    config: checksConfigFrom(checksConfigSchema.parse({})),
  });

test.each([
  [rect(), 0],
  [rect(40), 0],
  [rect(64), 24],
  [rect(64.001), 24.001],
  [rect(55, 60), 25],
  [rect(0, 200), 160],
])("nearest-edge separation for %j is %s px", (panel, distance) => {
  const checked = run(observation([result(panel)]));
  expect(checked.candidates).toHaveLength(distance > 24 ? 1 : 0);
  if (distance > 24) {
    expect(checked.candidates[0]).toMatchObject({
      severity: "minor",
      category: "detached-flyout",
      rule: "idiom:detached-flyout",
      fingerprintHint: "#trigger | #panel",
      verification: {
        check: "detached-flyout",
        params: {
          trigger: "#trigger",
          root: "#panel",
          maximum: 24,
          name: "Settings › More",
        },
      },
    });
    expect(checked.candidates[0]?.verification.params?.distance).toBeCloseTo(
      distance,
      6,
    );
    expect(checked.candidates[0]?.explanation).toContain("Settings › More");
  }
});

test("deduplicates a trigger/panel pair and preserves distinct panel identities", () => {
  const first = result(rect(0, 200));
  const other = result(rect(0, 200));
  if (other.openedDisclosure) other.openedDisclosure.root = "#other";
  expect(run(observation([first, first, other])).candidates).toHaveLength(2);
});

test("missing, invalid, skipped and incomplete geometry never asserts a distance", () => {
  const missing = result(rect());
  delete missing.openedDisclosure;
  for (const entry of [
    missing,
    { ...result(rect(0, 200)), skipped: "not clickable" },
    { ...result(rect(0, 200)), status: "timed-out" as const },
    { ...result(rect(0, 200)), status: "not-reached" as const },
    result({ ...rect(), width: 0 }),
    result({ ...rect(), y: NaN }),
  ]) {
    const checked = run(observation([entry]));
    expect(checked.candidates).toEqual([]);
    expect(checked.coverage.status).toBe("unavailable");
  }
});

test("new geometry round-trips and old observations remain valid without inference", () => {
  const captured = observation([result(rect(0, 200))]);
  const parsed = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(captured)),
  );
  expect(parsed).toEqual(captured);
  expect(run(parsed as ObservationArtifactV2).candidates).toEqual(
    run(captured).candidates,
  );
  delete captured.probe?.results[0]?.openedDisclosure;
  expect(
    run(observationArtifactSchema.parse(captured) as ObservationArtifactV2)
      .candidates,
  ).toEqual([]);
});
