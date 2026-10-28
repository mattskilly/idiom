import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createReplayLedger,
  type ReplayLedger,
} from "../src/capture/replay-ledger.js";
import { expectedCaptureTupleKeys } from "../src/capture/resolve.js";
import { runCapture } from "../src/capture/run.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { buildDeterministicDrafts } from "../src/review/findings.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

/**
 * Replay budget (file-199): three states reached through the same request-
 * sending step 1, probed concurrently, replay that step's held replay once
 * for the flow and all receive the same evidence and findings.
 */
let directory: string;
let port: number;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "idiom-replay-once-"));
  await copyFile(
    join(import.meta.dirname, "fixtures/replay-once/server.mjs"),
    join(directory, "server.mjs"),
  );
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("no port");
  port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const flow = flowSchema.parse({
  id: "orders",
  title: "Orders",
  setup: [],
  intent: [],
  states: [
    ["loaded", []],
    ["archived", [{ action: "click", selector: "#show-a" }]],
    ["drafts", [{ action: "click", selector: "#show-b" }]],
  ].map(([id, rest]) => ({
    id,
    description: String(id),
    url: "/",
    steps: [{ action: "click", selector: "#load" }, ...(rest as unknown[])],
    expect: {},
  })),
});

/** Counts the replays that actually ran and recorded. */
function spy(options: { dropFirst?: boolean } = {}) {
  const ledger = createReplayLedger();
  const recorded: string[] = [];
  const wrapped: ReplayLedger = {
    ...ledger,
    record(partition, key, state, actions, failureKeys) {
      recorded.push(state);
      if (options.dropFirst && recorded.length === 1) return;
      ledger.record(partition, key, state, actions, failureKeys);
    },
  };
  return { ledger: wrapped, recorded };
}

async function capture(
  ledger: ReplayLedger | null,
  out: string,
  options: { derived?: boolean } = {},
) {
  const selectedFlow = options.derived
    ? flowSchema.parse({
        ...flow,
        setup: [
          {
            run: `node -e 'console.log("seed=http://127.0.0.1:${port}/booking/live-token?submit")'`,
            captureStdout: true,
          },
        ],
        states: flow.states.map(({ url: _url, ...state }) => ({
          ...state,
          urlFrom: { source: "setup-stdout", pattern: "seed=(\\S+)" },
        })),
      })
    : flow;
  const project = projectSchema.parse({
    version: 1,
    app: { name: "Fixture", framework: "other" },
    server: {
      build: "node -e 0",
      start: "node server.mjs",
      readyUrl: `http://127.0.0.1:${port}/`,
      port,
      env: {},
    },
    viewports: [{ name: "desktop", width: 1280, height: 800 }],
    capture: { settleMs: 0, concurrency: 3 },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const captured = await runCapture({
    projectDirectory: directory,
    ...(options.derived ? {} : { port }),
    project,
    flow: selectedFlow,
    out,
    dependencies: {
      snapshotSource: async () => ({ commit: "fixture", dirty: false }),
      inheritedEnvironment: { PATH: process.env.PATH },
      replayLedger: ledger,
    },
  });
  expect(captured.counts).toEqual({ passed: 3, failed: 0, total: 3 });
  const loaded = await loadCaptureRun({
    runDirectory: captured.runDirectory,
    expectedFlow: flow.id,
  });
  const checks = runDeterministicChecks(
    loaded.tuples,
    expectedCaptureTupleKeys({ project, flow: selectedFlow }),
    checksConfigFrom(project.checks),
  );
  const stepFindings = checks.candidates.filter(
    (entry) =>
      entry.candidate.timeline === "slow-step-1" ||
      entry.candidate.timeline === "failure-step-1",
  );
  const replayEvidence = Object.fromEntries(
    loaded.tuples.map((tuple) => [
      tuple.state,
      {
        actions: tuple.timelines?.actions
          .filter(
            (action) =>
              action.id === "slow-step-1" || action.id === "failure-step-1",
          )
          .map((action) => ({
            id: action.id,
            url: action.url,
            requests: action.requests.map(({ method, path }) => ({
              method,
              path,
            })),
            heldRequests: action.held?.requests.map(({ method, path }) => ({
              method,
              path,
            })),
            failureRequests: action.failure?.requests.map(
              ({ method, path }) => ({ method, path }),
            ),
          })),
        completed:
          tuple.observations?.version === 2
            ? tuple.observations.probe?.failureReplay?.completed
            : undefined,
      },
    ]),
  );
  const loading = checks.candidates.filter(
    (entry) =>
      entry.candidate.rule === "idiom:loading-state-missing" &&
      entry.candidate.timeline === "slow-step-1",
  );
  const fingerprints = buildDeterministicDrafts({
    runId: "fixture",
    entries: loading,
  })
    .map(({ finding }) => finding.fingerprint)
    .sort();
  const held = Object.fromEntries(
    loaded.tuples.map((tuple) => [
      tuple.state,
      tuple.timelines?.actions
        .filter((action) => action.id === "slow-step-1")
        .map((action) => action.held),
    ]),
  );
  const reused = loaded.tuples.reduce(
    (sum, tuple) =>
      sum +
      ((tuple.observations?.version === 2
        ? tuple.observations.probe?.heldReplay?.reused
        : undefined) ?? 0),
    0,
  );
  return {
    hints: loading.map((entry) => entry.candidate.fingerprintHint).sort(),
    states: loading.map((entry) => entry.tuple.state).sort(),
    fingerprints,
    held,
    reused,
    replayEvidence,
    stepRules: stepFindings.map(({ candidate }) => candidate.rule).sort(),
    stepHints: stepFindings
      .map(({ candidate }) => candidate.fingerprintHint)
      .sort(),
    stepFingerprints: buildDeterministicDrafts({
      runId: "fixture",
      entries: stepFindings,
    })
      .map(({ finding }) => finding.fingerprint)
      .sort(),
  };
}

test("three states probing concurrently replay their shared web step once and keep every finding", async () => {
  const once = spy();
  const shared = await capture(once.ledger, "capture-once");
  // One owner ran it; no other state replayed it in the same round.
  expect(once.recorded).toHaveLength(1);
  expect(shared.reused).toBe(2);
  const facts = Object.values(shared.held);
  expect(facts).toHaveLength(3);
  for (const entry of facts) {
    expect(entry).toHaveLength(1);
    expect(entry).toEqual(facts[0]);
  }
  expect(shared.states).toEqual(["archived", "drafts", "loaded"]);
  // Without the ledger every state replays the step itself.
  const every = await capture(null, "capture-every");
  expect(every.reused).toBe(0);
  expect(every.states).toEqual(shared.states);
  expect(shared.hints).toEqual(every.hints);
  expect(shared.fingerprints).toEqual(every.fingerprints);
}, 240_000);

test("an owner that does not record hands the step to another state next round", async () => {
  const failing = spy({ dropFirst: true });
  const result = await capture(failing.ledger, "capture-owner-failure");
  expect(failing.recorded).toHaveLength(2);
  expect(new Set(failing.recorded).size).toBe(2);
  for (const entry of Object.values(result.held)) expect(entry).toHaveLength(1);
  expect(result.states).toEqual(["archived", "drafts", "loaded"]);
}, 240_000);

test("copied replays normalize setup URLs and owned ports like each state's independent replay", async () => {
  const once = spy();
  const shared = await capture(once.ledger, "capture-derived-once", {
    derived: true,
  });
  const every = await capture(null, "capture-derived-every", { derived: true });
  expect(once.recorded).toHaveLength(1);
  expect(shared.reused).toBe(2);
  expect(shared.states).toEqual(["archived", "drafts", "loaded"]);
  expect(shared.stepRules).toContain("idiom:loading-state-missing");
  expect(shared.stepRules).toContain("idiom:double-submit");
  expect(shared.stepHints).toEqual(every.stepHints);
  expect(shared.stepFingerprints).toEqual(every.stepFingerprints);
  expect(shared.replayEvidence).toEqual(every.replayEvidence);
  for (const [state, evidence] of Object.entries(shared.replayEvidence)) {
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("live-token");
    expect(serialized).toContain(`http://127.0.0.1:${port}`);
    expect(serialized).toContain(`/%7Bsetup-stdout:${state}%7D/api/slow-step`);
    expect(evidence.actions?.map(({ id }) => id)).toContain("slow-step-1");
    for (const action of evidence.actions ?? []) {
      expect(action.url).toBe(`/%7Bsetup-stdout:${state}%7D`);
    }
  }
}, 240_000);
