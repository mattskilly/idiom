import { expect, test } from "vitest";
import { loadingPersists } from "../src/capture/loading-stuck.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { loadingStuckCheck } from "../src/checks/loading-stuck.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { buildRuleContract } from "../src/findings/contract.js";
import { evaluateRuleAcceptance } from "../src/verify/acceptance.js";
import { evaluateVerification } from "../src/verify/evaluate.js";
import { evidenceTuple, loadingEvidence } from "./blank-media-support.js";

const config = checksConfigFrom();
function check(evidence = loadingEvidence()) {
  return loadingStuckCheck.run({
    tuple: evidenceTuple({ loadingStuck: evidence }),
    config,
    tuples: [],
    narrowViewport: false,
  });
}
test("continuous visible interval uses inclusive duration and never combines records", () => {
  const evidence = loadingEvidence(),
    r = evidence.records[0];
  if (!r) throw Error("record");
  expect(loadingPersists(r, 5000)).toBe(true);
  for (const patch of [{ ageMs: 4999.99 }, { active: false }, { masked: true }])
    expect(loadingPersists({ ...r, ...patch }, 5000)).toBe(false);
  expect(
    check({
      ...evidence,
      records: [
        { ...r, ageMs: 3000, active: false },
        { ...r, identity: 1, ageMs: 3000 },
      ],
    }).candidates,
  ).toHaveLength(0);
  expect(check().candidates[0]).toMatchObject({
    severity: "minor",
    targetSelectors: ["#loading"],
  });
  expect(check().candidates[0]?.explanation).toContain("5.00 seconds");
});
test("resolved and intentional states pass; late onset and missing evidence do not fire", () => {
  const evidence = loadingEvidence();
  expect(
    check({
      ...evidence,
      records: evidence.records.map((r) => ({ ...r, active: false })),
    }).candidates,
  ).toEqual([]);
  expect(
    check({ ...evidence, intentional: true, status: "skipped" }).coverage
      .status,
  ).toBe("not-applicable");
  expect(check({ ...evidence, observedMs: 4999 }).coverage.status).toBe(
    "unavailable",
  );
  expect(
    loadingStuckCheck.run({
      tuple: evidenceTuple(),
      config,
      tuples: [],
      narrowViewport: false,
    }).coverage.status,
  ).toBe("unavailable");
  expect(
    loadingStuckCheck.run({
      tuple: evidenceTuple(),
      config: { ...config, loadingStuck: { enabled: false } },
      tuples: [],
      narrowViewport: false,
    }).coverage.status,
  ).toBe("skipped");
  expect(check({ ...evidence, records: [] }).coverage.status).toBe("ran");
  expect(
    observationArtifactSchema.parse(
      evidenceTuple({ loadingStuck: evidence }).observations,
    ),
  ).toMatchObject({ loadingStuck: evidence });
});
test("acceptance requires resolved recorded target and the complete original window", () => {
  const evidence = loadingEvidence(),
    before = evidenceTuple({ loadingStuck: evidence });
  const candidate = check().candidates[0];
  if (!candidate) throw Error("candidate");
  const contract = buildRuleContract(before, candidate, config).acceptance;
  const resolved = {
    ...evidence,
    records: evidence.records.map((r) => ({
      ...r,
      active: false,
      endedMs: 200,
    })),
  };
  const result = (e = resolved) =>
    evaluateRuleAcceptance({
      contract,
      currentA: [evidenceTuple({ loadingStuck: e })],
      currentB: [evidenceTuple({ loadingStuck: e })],
      config,
    }).status;
  expect(result()).toBe("passed");
  for (const patch of [
    { records: [] },
    { observedMs: 100 },
    { windowMs: 100 },
    { intentional: true },
    { status: "partial" as const },
    { records: resolved.records.map((r) => ({ ...r, masked: true })) },
  ])
    expect(result({ ...resolved, ...patch })).toBe("not-recheckable");
});

test("calibration tolerates observation-clock jitter but preserves threshold disagreement", () => {
  const a = loadingEvidence({ observedMs: 5100, records: [] });
  const b = loadingEvidence({ observedMs: 5600, records: [] });
  const baseline = evidenceTuple({ loadingStuck: a });
  expect(
    evaluateVerification({
      findings: [],
      baseline: [baseline],
      currentA: [baseline],
      currentB: [evidenceTuple({ loadingStuck: b })],
      checksConfig: config,
    }).passed,
  ).toBe(true);
  const persistent = loadingEvidence();
  expect(() =>
    evaluateVerification({
      findings: [],
      baseline: [baseline],
      currentA: [evidenceTuple({ loadingStuck: persistent })],
      currentB: [
        evidenceTuple({
          loadingStuck: {
            ...persistent,
            records: persistent.records.map((r) => ({ ...r, ageMs: 4999 })),
          },
        }),
      ],
      checksConfig: config,
    }),
  ).toThrow("deterministic check results");
});
