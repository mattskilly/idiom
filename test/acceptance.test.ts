import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { severityGateEligible } from "../src/findings/gate.js";
import {
  acceptanceText,
  basisDescription,
} from "../src/findings/presentation.js";
import { findingSchema } from "../src/schemas/finding.js";

const legacy = JSON.parse(
  await readFile(
    new URL("./fixtures/finding-contract/legacy.json", import.meta.url),
    "utf8",
  ),
);
function oldFinding(layer: "model" | "deterministic" = "deterministic") {
  return {
    ...legacy,
    layer,
    basis: undefined,
    basisDetails: undefined,
    acceptance: ["Keep this exact human text."],
    confidence: 0.73,
  };
}

test("legacy arrays normalize without claiming executable proof or behavioral history", () => {
  const measured = findingSchema.parse(oldFinding());
  expect(measured.basis).toBe("measured");
  expect(measured.basisDetails.summary).toContain("not recorded");
  expect(measured.acceptance).toEqual({
    version: 1,
    kind: "legacy",
    doneWhen: ["Keep this exact human text."],
  });
  expect(acceptanceText(measured)).toEqual(["Keep this exact human text."]);
  const judged = findingSchema.parse(oldFinding("model"));
  expect(judged.basis).toBe("judged");
  expect(basisDescription(judged)).toContain("stated confidence 0.73");
});

test("new contracts reject unknown versions, non-JSON parameters and inconsistent provenance", () => {
  const input = oldFinding("model");
  const manual = {
    ...input,
    basis: "judged",
    basisDetails: { kind: "judged", summary: "Suggestion", confidence: 0.73 },
    acceptance: { version: 1, kind: "manual", doneWhen: input.acceptance },
  };
  expect(findingSchema.safeParse(manual).success).toBe(true);
  expect(
    findingSchema.safeParse({ ...manual, layer: "deterministic" }).success,
  ).toBe(false);
  expect(
    findingSchema.safeParse({
      ...manual,
      acceptance: { ...manual.acceptance, version: 2 },
    }).success,
  ).toBe(false);
  expect(
    findingSchema.safeParse({
      ...manual,
      basisDetails: { ...manual.basisDetails, confidence: 1.2 },
    }).success,
  ).toBe(false);
  expect(
    findingSchema.safeParse({
      ...manual,
      acceptance: { ...manual.acceptance, extra: true },
    }).success,
  ).toBe(false);
});

describe("severity gate basis matrix", () => {
  for (const basis of ["measured", "observed", "judged"] as const)
    for (const severity of ["blocker", "major", "minor"] as const)
      for (const threshold of ["never", "blocker", "major", "minor"] as const)
        for (const optIn of [false, true])
          test(`${basis}/${severity}/${threshold}/judged=${optIn}`, () => {
            const ranks = { blocker: 0, major: 1, minor: 2 };
            const expected =
              threshold !== "never" &&
              (basis !== "judged" || optIn) &&
              ranks[severity] <= ranks[threshold];
            expect(
              severityGateEligible({ basis, severity }, threshold, optIn),
            ).toBe(expected);
          });
});

test("probe-only observations carry actual timing and cannot borrow another control's coverage", async () => {
  const { deadControlCheck } = await import("../src/checks/dead-control.js");
  const { checksConfigFrom } = await import("../src/checks/registry.js");
  const { buildRuleContract } = await import("../src/findings/contract.js");
  const { evaluateRuleAcceptance } = await import(
    "../src/verify/acceptance.js"
  );
  const { emptyObservation, tupleFor } = await import("./motion-support.js");
  const config = checksConfigFrom();
  const result = {
    selector: "#go",
    name: "Go",
    effects: [] as import("../src/checks/types.js").ProbeEffect[],
    status: "completed" as const,
    elapsedMs: 36,
    persistent: false,
  };
  const tuple = tupleFor({
    ...emptyObservation,
    probe: { status: "ran", results: [result] },
  });
  const candidate = deadControlCheck.run({
    tuple,
    config,
    narrowViewport: false,
  }).candidates[0];
  if (!candidate) throw new Error("expected dead control");
  const built = buildRuleContract(tuple, candidate, config);
  expect(built.basis).toBe("observed");
  expect(built.basisDetails).toMatchObject({
    kind: "observed",
    timing: { elapsedMs: 36 },
    action: { source: "probe-click", selector: "#go" },
  });
  const fixed = tupleFor({
    ...emptyObservation,
    probe: { status: "ran", results: [{ ...result, effects: ["dom"] }] },
  });
  expect(
    evaluateRuleAcceptance({
      contract: built.acceptance,
      currentA: [fixed],
      currentB: [fixed],
      config,
    }).status,
  ).toBe("passed");
  const unrelated = tupleFor({
    ...emptyObservation,
    probe: {
      status: "ran",
      results: [{ ...result, selector: "#other", effects: ["dom"] }],
    },
  });
  expect(
    evaluateRuleAcceptance({
      contract: built.acceptance,
      currentA: [unrelated],
      currentB: [unrelated],
      config,
    }).status,
  ).toBe("not-recheckable");
  const skipped = tupleFor({
    ...emptyObservation,
    probe: {
      status: "ran",
      results: [{ ...result, skipped: "not reached", effects: ["dom"] }],
    },
  });
  expect(
    evaluateRuleAcceptance({
      contract: built.acceptance,
      currentA: [skipped],
      currentB: [skipped],
      config,
    }).status,
  ).toBe("not-recheckable");
});

test("unrelated timelines leave static and document measurements measured", async () => {
  const { emptyObservation, tupleFor } = await import("./motion-support.js");
  const { buildRuleContract } = await import("../src/findings/contract.js");
  const { TIMELINE_LIMITS } = await import("../src/capture/timeline.js");
  const tuple = {
    ...tupleFor(emptyObservation),
    timelines: {
      version: 1 as const,
      status: "ran" as const,
      truncated: { actions: 0 },
      limits: { ...TIMELINE_LIMITS },
      actions: [
        {
          source: "load" as const,
          kind: "load",
          name: "load",
          url: "/",
          startedAt: 0,
          durationMs: 100,
          settled: true,
          status: "ran" as const,
          truncated: [],
          shifts: [],
          frames: [],
          mutations: [],
          animations: [],
          requests: [],
          viewTransition: { used: false },
          effectRegion: { controls: [] },
        },
      ],
    },
  };
  const candidate = {
    category: "missing-state" as const,
    severity: "blocker" as const,
    rule: "idiom:expectation-text-present",
    selectorHint: "state:expectation",
    explanation: "The declared text was not observed.",
    acceptance: ["The declared expectation passes."],
    verification: {
      check: "missing-state" as const,
      params: { kind: "text-present", expected: "Welcome" },
    },
  };
  const built = buildRuleContract(tuple, candidate);
  expect(built.basis).toBe("measured");
  expect(built.acceptance.target).toEqual({
    kind: "document",
    scope: "state:expectation",
  });
  expect(built.acceptance.kind).toBe("rule");
});

test("removing an expectation or changing capture predicate settings cannot prove a new acceptance", async () => {
  const { missingStateCheck } = await import("../src/checks/missing-state.js");
  const { checksConfigFrom } = await import("../src/checks/registry.js");
  const { buildRuleContract } = await import("../src/findings/contract.js");
  const { evaluateRuleAcceptance } = await import(
    "../src/verify/acceptance.js"
  );
  const { emptyObservation, tupleFor } = await import("./motion-support.js");
  const config = checksConfigFrom();
  const original = {
    ...tupleFor(emptyObservation),
    captureSettingsIdentity: "a".repeat(64),
    declaredExpectations: {
      textPresent: ["Welcome"],
      selectorPresent: [],
      selectorAbsent: [],
    },
    mismatches: [{ kind: "text-present" as const, expected: "Welcome" }],
  };
  const candidate = missingStateCheck.run({
    tuple: original,
    config,
    narrowViewport: false,
  }).candidates[0];
  if (!candidate) throw new Error("Expected failed expectation");
  const contract = buildRuleContract(original, candidate, config).acceptance;
  const fixed = { ...original, mismatches: [] };
  const evaluate = (current: import("../src/checks/types.js").CheckTuple) =>
    evaluateRuleAcceptance({
      contract,
      currentA: [current],
      currentB: [current],
      config,
    });
  expect(evaluate(fixed).status).toBe("passed");
  expect(
    evaluate({
      ...fixed,
      declaredExpectations: { ...fixed.declaredExpectations, textPresent: [] },
    }).status,
  ).toBe("not-recheckable");
  expect(
    evaluate({ ...fixed, captureSettingsIdentity: "b".repeat(64) }).status,
  ).toBe("not-recheckable");
});

test("an already emitted legacy verification sidecar keeps its original bytes", async () => {
  const { mkdtemp, readdir, writeFile, rm, realpath } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { sweepTicketEvidence } = await import(
    "../src/tickets/sweep-evidence.js"
  );
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-legacy-acceptance-")),
  );
  try {
    const raw = { ...oldFinding(), evidence: { screenshots: [] } };
    const finding = findingSchema.parse(raw);
    const record = {
      finding,
      runId: "original",
      runDirectory: directory,
      findingsPath: join(directory, "findings.json"),
    };
    const options = {
      cluster: {
        key: "fixture",
        component: "note",
        members: [{ id: finding.id, record, component: "note" }],
      },
      id: "fixture",
      directory,
      projectDirectory: directory,
      occurrences: [record],
    };
    await sweepTicketEvidence(options);
    const sideDirectory = join(directory, ".idiom/fixture");
    const [name] = await readdir(sideDirectory);
    if (!name) throw new Error("missing sidecar");
    const path = join(sideDirectory, name);
    const original = `\`\`\`idiom:finding\n${JSON.stringify(raw, null, 2)}\n\`\`\`\n`;
    await writeFile(path, original);
    await expect(sweepTicketEvidence(options)).resolves.toContain(path);
    expect(await readFile(path, "utf8")).toBe(original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
