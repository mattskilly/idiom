import { expect, test } from "vitest";
import type { ProbeCandidate } from "../src/capture/probe.js";
import {
  controlIdentity,
  createProbeLedger,
} from "../src/capture/probe-ledger.js";
import {
  accumulateProbeRound,
  mergePlannedProbe,
} from "../src/capture/probe-merge.js";
import type { ProbeArtifact, ProbeResult } from "../src/checks/types.js";

const candidate = (selector: string): ProbeCandidate => ({
  path: "body > button",
  selector,
  role: "button",
  name: "Help",
  region: "navigation",
  signature: "button.icon>nav",
  repeated: false,
  explanation: { selector, controlId: `local-${selector}` },
});
const result: ProbeResult = {
  selector: "#replayed",
  name: "Help",
  region: "navigation",
  persistent: true,
  effects: [],
  status: "completed",
  elapsedMs: 123,
  timings: {
    clickMs: 10,
    effectWindowMs: 50,
    restoreCheckMs: 40,
    escapeMs: 0,
    replayMs: 0,
  },
};
const identity = (value: ProbeCandidate) =>
  controlIdentity({
    ...value,
    role: value.role ?? "",
    signature: value.signature ?? value.path,
  });

test("completed owner results and glyph samples use the saved capture's local identity", () => {
  const ledger = createProbeLedger();
  const saved = candidate("#saved");
  ledger.plan("p", [{ state: "a", candidates: [saved] }]);
  ledger.record("p", identity(saved), "a", result, [
    {
      selector: "#replayed",
      controlId: "old-document",
      trigger: "hover",
      source: "probe",
      status: "absent",
      tooltips: [],
    },
  ]);
  const artifact: ProbeArtifact = {
    status: "ran",
    results: [{ ...result }],
    candidates: [candidate("#replayed")],
  };
  mergePlannedProbe({
    ledger,
    partition: "p",
    state: "a",
    candidates: [saved],
    artifact,
  });
  expect(artifact.results).toEqual([
    { ...result, selector: "#saved", repeated: undefined },
  ]);
  expect(artifact.explanations?.records[0]).toMatchObject({
    selector: "#saved",
    controlId: "local-#saved",
  });
  expect(artifact.candidates).toBeUndefined();
});

test("reuse names the assigned state, keeps local flags and excludes attempt timings", () => {
  const ledger = createProbeLedger();
  const saved = candidate("#local");
  ledger.plan("p", [
    { state: "a", candidates: [candidate("#a")] },
    { state: "b", candidates: [saved] },
  ]);
  ledger.record(
    "p",
    identity(saved),
    "a",
    { ...result, repeated: true, replayRequired: true },
    [],
  );
  const artifact: ProbeArtifact = {
    status: "ran",
    results: [
      {
        ...result,
        selector: "#fresh-local",
        status: "not-reached",
        skipped: "assigned",
      },
    ],
    candidates: [candidate("#fresh-local")],
  };
  mergePlannedProbe({
    ledger,
    partition: "p",
    state: "b",
    candidates: [saved],
    artifact,
  });
  expect(artifact.results).toEqual([
    {
      selector: "#local",
      name: "Help",
      region: "navigation",
      persistent: true,
      effects: [],
      status: "completed",
      repeated: undefined,
      reusedFrom: "a",
    },
  ]);
});

test("a failed replay still reports every saved control and preserves state expiry", () => {
  const ledger = createProbeLedger();
  const saved = candidate("#saved");
  ledger.plan("p", [
    { state: "a", candidates: [saved] },
    { state: "b", candidates: [saved] },
  ]);
  const owner: ProbeArtifact = {
    status: "timed-out",
    reason: "state timed-out: initialization",
    results: [],
  };
  mergePlannedProbe({
    ledger,
    partition: "p",
    state: "a",
    candidates: [saved],
    artifact: owner,
  });
  expect(owner.status).toBe("timed-out");
  expect(owner.results).toHaveLength(1);
  expect(owner.results[0]).toMatchObject({
    selector: "#saved",
    status: "not-reached",
    skipped: "not reached: state timed-out: initialization",
  });
  const later: ProbeArtifact = { status: "partial", results: [] };
  mergePlannedProbe({
    ledger,
    partition: "p",
    state: "b",
    candidates: [saved],
    artifact: later,
  });
  expect(later.results[0]).toMatchObject({
    status: "not-reached",
    skipped: "not reached: assigned state a did not complete",
  });
});

test("final reasons replace stale unreached rows, and nested items finished elsewhere fill unfinished rows", () => {
  const ledger = createProbeLedger();
  const saved = candidate("#saved");
  const menu: ProbeCandidate = {
    ...candidate("#menu"),
    name: "Menu",
    signature: "#menu",
    explanation: undefined,
  };
  ledger.plan("p", [
    { state: "a", candidates: [saved, menu] },
    { state: "b", candidates: [saved, menu] },
  ]);
  const menuKey = identity(menu);
  const item: ProbeResult = {
    ...result,
    selector: "#two",
    name: "Menu › Two",
  };
  ledger.record(
    "p",
    menuKey,
    "a",
    { ...result, selector: "#menu", name: "Menu" },
    [],
    [],
    true,
  );
  ledger.record(
    "p",
    menuKey,
    "b",
    { ...result, selector: "#menu", name: "Menu" },
    [],
    [item],
    false,
  );
  ledger.exhaust("p", "flow probe time exhausted");
  const artifact: ProbeArtifact = {
    status: "partial",
    results: [
      {
        ...result,
        selector: "#saved",
        status: "not-reached",
        skipped: "not reached: flow budget share",
      },
      { ...result, selector: "#menu", name: "Menu" },
      {
        ...item,
        status: "not-reached",
        skipped: "not reached: nested-menu budget",
      },
    ],
  };
  mergePlannedProbe({
    ledger,
    partition: "p",
    state: "a",
    candidates: [saved, menu],
    artifact,
  });
  expect(artifact.results[0]?.skipped).toBe(
    "not reached: flow probe time exhausted",
  );
  expect(artifact.results[2]).toMatchObject({
    name: "Menu › Two",
    status: "completed",
    reusedFrom: "b",
    elapsedMs: undefined,
  });
  expect(artifact.results).toHaveLength(3);
});

test("a later round replaces only the rows it worked on", () => {
  const previous: ProbeArtifact = {
    status: "timed-out",
    results: [
      { ...result, selector: "#done" },
      {
        ...result,
        selector: "#later",
        status: "not-reached",
        skipped: "not reached: flow budget share",
      },
    ],
  };
  const merged = accumulateProbeRound(previous, {
    status: "ran",
    results: [
      {
        ...result,
        selector: "#done",
        status: "not-reached",
        skipped: "not reached: assigned to state: a",
      },
      { ...result, selector: "#later", elapsedMs: 9 },
      { ...result, selector: "#later-nested", name: "Help › Item" },
    ],
  });
  expect(merged.results.map((row) => [row.selector, row.status])).toEqual([
    ["#done", "completed"],
    ["#later", "completed"],
    ["#later-nested", "completed"],
  ]);
});

test("a revealed state stays on the opening state's row and is dropped from reused copies", () => {
  const revealed = {
    name: "Help",
    kind: "popup" as const,
    trigger: "body > button",
    status: "unavailable" as const,
    reason: "revealed-state limit (checks.probe.maxRevealed)",
  };
  const nested: ProbeResult = {
    ...result,
    selector: "#item",
    name: "Help › Link",
    revealed: { ...revealed, name: "Help › Link", kind: "mode" },
  };
  const merged = (state: string) => {
    const ledger = createProbeLedger();
    const saved = candidate("#saved");
    ledger.plan("p", [{ state: "a", candidates: [saved] }]);
    ledger.record(
      "p",
      identity(saved),
      "a",
      { ...result, revealed },
      [],
      [nested],
    );
    const artifact: ProbeArtifact = { status: "ran", results: [] };
    mergePlannedProbe({
      ledger,
      partition: "p",
      state,
      candidates: [saved],
      artifact,
    });
    return artifact.results;
  };
  const owner = merged("a");
  expect(owner[0]?.revealed).toEqual(revealed);
  expect(owner[1]?.revealed).toEqual(nested.revealed);
  const reused = merged("b");
  expect(reused[0]?.reusedFrom).toBe("a");
  expect(reused[0]?.revealed).toBeUndefined();
  expect(reused[1]?.reusedFrom).toBe("a");
  expect(reused[1]?.revealed).toBeUndefined();
});

test("a later round's selection trials join the earlier round's", () => {
  const trial = (
    selector: string,
    status: "completed" | "timed-out",
  ): NonNullable<ProbeArtifact["selectionTrials"]>["trials"][number] => ({
    selector,
    name: selector,
    affordance: "link",
    status,
    effects: [],
  });
  const merged = accumulateProbeRound(
    {
      status: "ran",
      results: [],
      selectionTrials: {
        status: "partial",
        reason: "#b timed-out (selection)",
        limit: 12,
        candidates: 2,
        trials: [trial("#a", "completed"), trial("#b", "timed-out")],
      },
    },
    {
      status: "ran",
      results: [],
      selectionTrials: {
        status: "ran",
        limit: 12,
        candidates: 2,
        trials: [trial("#b", "completed"), trial("#c", "completed")],
      },
    },
  );
  expect(merged.selectionTrials).toEqual({
    status: "partial",
    reason: "#b timed-out (selection)",
    limit: 12,
    candidates: 4,
    trials: [
      trial("#a", "completed"),
      trial("#b", "completed"),
      trial("#c", "completed"),
    ],
  });
  // A round without the pass keeps the other round's trials.
  expect(
    accumulateProbeRound(
      { status: "ran", results: [] },
      { status: "ran", results: [], selectionTrials: merged.selectionTrials },
    ).selectionTrials,
  ).toBe(merged.selectionTrials);
});
