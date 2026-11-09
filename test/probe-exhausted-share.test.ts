import { expect, test } from "vitest";
import { type ProbeCandidate, probeControls } from "../src/capture/probe.js";
import {
  createFlowProbeBudget,
  FLOW_PROBE_EXHAUSTED,
} from "../src/capture/probe-budget.js";
import { createProbeLedger } from "../src/capture/probe-ledger.js";
import { mergePlannedProbe } from "../src/capture/probe-merge.js";

// No browser runs here: every page method throws, proving the exhausted
// share returns before any page work.
const touched = () => {
  throw new Error("page touched");
};
const untouchablePage = new Proxy(
  {},
  { get: (_target, key) => (key === "then" ? undefined : touched) },
) as unknown as import("playwright").Page;
const candidate = (selector: string): ProbeCandidate => ({
  path: "body > button",
  selector,
  role: "button",
  name: selector,
  region: "navigation",
  signature: `button${selector}`,
  repeated: false,
});

test("an exhausted share reports its candidates as out of time, not as a probe failure", async () => {
  const leases = createFlowProbeBudget(
    1000,
    [
      { id: "landing", count: 2 },
      { id: "next", count: 1 },
    ],
    { deadlineAt: 100, now: () => 500 },
  );
  const lease = leases.get("landing");
  const next = leases.get("next");
  if (!lease || !next) throw new Error("missing lease");
  let extended = 0;
  next.start({
    extend(ms) {
      extended += ms;
    },
  });
  const ledger = createProbeLedger();
  const c1 = candidate("#one");
  const c2 = candidate("#two");
  ledger.plan("p", [{ state: "landing", candidates: [c1, c2] }]);
  const phases: string[] = [];
  const artifact = await probeControls({
    page: untouchablePage,
    flowBudget: lease,
    ledger,
    ledgerPartition: "p",
    stateId: "landing",
    restore: async () => touched(),
    skip: [],
    maxControls: 10,
    waitMs: 0,
    onProbeProgress: ({ phase }) => phases.push(phase),
  });
  expect(phases).toEqual(["initialization", "complete"]);
  expect(artifact).toMatchObject({
    status: "partial",
    reason: FLOW_PROBE_EXHAUSTED,
    results: [],
  });
  expect(artifact.reason).not.toContain("deadline duration");
  mergePlannedProbe({
    ledger,
    partition: "p",
    state: "landing",
    candidates: [c1, c2],
    artifact,
  });
  expect(artifact.results).toHaveLength(2);
  for (const row of artifact.results) {
    expect(row).toMatchObject({
      status: "not-reached",
      skipped: `not reached: ${FLOW_PROBE_EXHAUSTED}`,
    });
    expect(row.skipped).not.toMatch(/^not reached: probe failed/);
  }
  // The early finish is idempotent and refunds no time the flow did not have.
  expect(() => lease.finish(0)).not.toThrow();
  expect(extended).toBe(0);
  expect(next.shareMs()).toBe(0);
});
