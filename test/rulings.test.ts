import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseModelResponse } from "../src/critique/schema.js";
import { aggregateDecisionObservations } from "../src/rulings/aggregate.js";
import { rulingFingerprint } from "../src/rulings/fingerprint.js";
import { appendRuling, parseRulingBlocks } from "../src/rulings/law.js";
import {
  loadRulingNames,
  nameUnruledDecisions,
  persistRulingNames,
} from "../src/rulings/names.js";
import type { DecisionObservation } from "../src/schemas/ruling.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function observation(
  choiceKey: string,
  state: string,
  viewport = "mobile",
): DecisionObservation {
  return {
    choiceKey,
    question: `How should ${choiceKey} work?`,
    state,
    viewport,
    screenshot: `${state}/${viewport}`,
    nearestLawExcerpt: "Keep actions clear.",
    candidates: [],
  };
}

test("observation parsing drops unsupported entries without damaging findings", () => {
  const screenshots = [
    {
      label: "ready/mobile",
      path: "ready/mobile/screenshot.png",
      readPath: "/tmp/ready.png",
      state: "ready",
      viewport: "mobile",
    },
  ];
  const finding = {
    category: "hierarchy",
    severity: "major",
    confidence: 0.8,
    rule: "Keep actions clear.",
    selectorHint: "main",
    state: "ready",
    viewport: "mobile",
    screenshots: ["ready/mobile"],
    references: [],
    explanation: "The action is unclear.",
    suggestedArea: "main action",
    acceptance: ["The action is clear."],
  };
  const result = parseModelResponse(
    JSON.stringify({
      findings: [finding],
      decisionObservations: [
        {
          ...observation("chip-selection", "ready"),
          candidates: [
            {
              wording: "Invented rule",
              precedent: { kind: "law", excerpt: "Not in the law" },
            },
          ],
        },
      ],
    }),
    screenshots,
    [],
    screenshots,
    "Keep actions clear.",
  );
  expect(result.findings).toEqual([finding]);
  expect(result.decisionObservations).toEqual([]);
  expect(result.discardedDecisionObservations).toBe(1);
});

test("aggregation requires distinct states, suppresses resolutions, and applies its own stable cap", () => {
  const observations = [
    observation("single", "ready", "mobile"),
    observation("single", "ready", "desktop"),
    ...["delta", "alpha", "charlie", "bravo"].flatMap((choice) => [
      observation(choice, "ready"),
      observation(choice, "confirmed"),
    ]),
  ];
  const aggregated = aggregateDecisionObservations({
    observations,
    resolvedFingerprints: new Set([rulingFingerprint("bravo")]),
  });
  expect(aggregated.map((item) => item.choiceKey)).toEqual([
    "alpha",
    "charlie",
    "delta",
  ]);
  expect(aggregated.every((item) => item.occurrences.length === 2)).toBe(true);
});

test("law blocks preserve the prior bytes and parse rule and no-rule outcomes", () => {
  const base = "# Law\r\nKeep actions clear.";
  const first = appendRuling(base, {
    id: "ruling-1",
    fingerprint: "one",
    choiceKey: "chip-selection",
    outcome: "rule",
    wording: "Selected chips use a filled treatment.",
    recordedAt: "2026-08-20T12:00:00.000Z",
  });
  const completed = appendRuling(first, {
    id: "ruling-2",
    fingerprint: "two",
    choiceKey: "date-input-strategy",
    outcome: "no-rule",
    recordedAt: "2026-08-20T12:01:00.000Z",
  });
  expect(completed.startsWith(base)).toBe(true);
  expect(completed).toContain("\r\n<!-- idiom:ruling:start -->");
  const parsed = parseRulingBlocks(completed);
  expect(parsed.prose).toBe(base);
  expect(parsed.resolutions.map((item) => item.outcome)).toEqual([
    "rule",
    "no-rule",
  ]);
  const resolution = parsed.resolutions[0];
  expect(resolution).toBeDefined();
  if (resolution === undefined) throw new Error("missing parsed resolution");
  expect(() => appendRuling(completed, resolution)).toThrow(
    "already been recorded",
  );
});

test("ruling text cannot inject a marker that corrupts the completed law", () => {
  expect(() =>
    appendRuling("# Law\n\nKeep actions clear.\n", {
      id: "ruling-1",
      fingerprint: "one",
      choiceKey: "chip-selection",
      outcome: "rule",
      wording: "Use filled chips. <!-- idiom:ruling:end -->",
      recordedAt: "2026-08-20T12:00:00.000Z",
    }),
  ).toThrow("malformed recorded ruling block");
});

test("ruling names are stable and persisted before reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-ruling-names-"));
  directories.push(directory);
  const state = await loadRulingNames({
    projectDirectory: directory,
    gitTopology: async () => undefined,
  });
  const decision = aggregateDecisionObservations({
    observations: [
      observation("chip-selection", "ready"),
      observation("chip-selection", "confirmed"),
    ],
  });
  expect(nameUnruledDecisions(state, decision)[0]?.id).toBe("ruling-1");
  await persistRulingNames(state);
  expect(
    JSON.parse(
      await readFile(join(directory, ".idiom", "ruling-names.json"), "utf8"),
    ),
  ).toMatchObject({ next: 2 });
  const reloaded = await loadRulingNames({
    projectDirectory: directory,
    gitTopology: async () => undefined,
  });
  expect(nameUnruledDecisions(reloaded, decision)[0]?.id).toBe("ruling-1");
});

const scaleCluster = {
  property: "spacing:padding" as const,
  value: "17px",
  count: 12,
  distinctStates: 1,
  distinctElements: 6,
  context: {
    landmark: "main",
    component: "role:.row-control",
    viewport: "desktop",
  },
  componentLabel: ".row-control",
  nearestSteps: { below: "16px", above: "24px", steps: ["16px", "24px"] },
  suggestedToken: "space-row-control-main",
  examples: [
    {
      state: "orders",
      viewport: "desktop",
      screenshot: "orders/desktop",
      selector: ".row-control",
    },
  ],
};

test("a scale question may sit in one state; a model decision still needs two", async () => {
  const { unruledDecisionSchema } = await import("../src/schemas/ruling.js");
  const decision = {
    id: "ruling-3",
    fingerprint: "print",
    choiceKey: "scale-cluster:v1 spacing:padding 17px",
    question: "17px padding appears 12 times…",
    nearestLawExcerpt: "checks.scales.spacing: [16px, 24px]",
    occurrences: [
      { state: "orders", viewport: "desktop", screenshot: "orders/desktop" },
    ],
    candidates: [],
  };
  expect(
    unruledDecisionSchema.safeParse({ ...decision, scaleCluster }).success,
  ).toBe(true);
  const generic = unruledDecisionSchema.safeParse(decision);
  expect(generic.success).toBe(false);
  expect(generic.error?.issues.map((issue) => issue.message)).toEqual([
    "must contain at least 2 occurrences",
  ]);
  const sameState = unruledDecisionSchema.safeParse({
    ...decision,
    occurrences: [
      decision.occurrences[0],
      { state: "orders", viewport: "phone", screenshot: "orders/phone" },
    ],
  });
  expect(sameState.error?.issues.map((issue) => issue.message)).toEqual([
    "must recur across at least two distinct states",
  ]);
});

test("scale answers: add-step is a rule with a token, drift is a no-rule without one, and both round-trip", async () => {
  const { rulingResolutionSchema } = await import("../src/schemas/ruling.js");
  const base = {
    id: "ruling-3",
    fingerprint: "print",
    choiceKey: "scale-cluster:v1 spacing:padding 17px",
    recordedAt: "2026-10-27T12:00:00.000Z",
  };
  const scale = {
    property: "spacing:padding" as const,
    value: "17px",
    context: scaleCluster.context,
  };
  const messages = (value: unknown) =>
    rulingResolutionSchema
      .safeParse(value)
      .error?.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
  expect(
    messages({
      ...base,
      outcome: "no-rule",
      scale: { ...scale, answer: "add-step" },
    }),
  ).toEqual([
    "outcome: an add-step answer records a rule",
    "scale.token: required for an add-step answer",
  ]);
  expect(
    messages({
      ...base,
      outcome: "rule",
      wording: "x",
      scale: { ...scale, answer: "drift", token: "space-x" },
    }),
  ).toEqual([
    "outcome: a drift answer records no rule",
    "scale.token: must be omitted for a drift answer",
  ]);
  expect(
    messages({
      ...base,
      outcome: "rule",
      wording: "x",
      scale: { ...scale, answer: "add-step", token: "-bad token" },
    })?.[0],
  ).toMatch(/^scale\.token: must start with a letter or digit/);
  // A drift answer may carry the MCP reason; a plain no-rule still may not.
  expect(
    messages({
      ...base,
      outcome: "no-rule",
      reason: "Dense tables are exceptional.",
      scale: { ...scale, answer: "drift" },
    }),
  ).toBeUndefined();
  expect(messages({ ...base, outcome: "no-rule", reason: "x" })).toEqual([
    "reason: must be omitted for a no-rule outcome",
  ]);

  const added = appendRuling("# Law", {
    ...base,
    outcome: "rule",
    wording: "Add the `space-row` step.",
    scale: { ...scale, answer: "add-step", token: "space-row" },
  });
  expect(added).toContain(
    "Add the `space-row` step: 17px padding for role:.row-control in main at desktop.",
  );
  const drifted = appendRuling(added, {
    ...base,
    id: "ruling-4",
    fingerprint: "other",
    outcome: "no-rule",
    scale: { ...scale, answer: "drift" },
  });
  expect(drifted).toContain(
    "Keep reporting 17px padding on role:.row-control in main at desktop as drift.",
  );
  expect(
    parseRulingBlocks(drifted).resolutions.map(
      (resolution) => resolution.scale,
    ),
  ).toEqual([
    { ...scale, answer: "add-step", token: "space-row" },
    { ...scale, answer: "drift" },
  ]);
});
