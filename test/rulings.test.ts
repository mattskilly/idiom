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
