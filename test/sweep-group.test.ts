import { expect, test } from "vitest";
import { findingSchema } from "../src/schemas/finding.js";
import { groupSweep } from "../src/sweep/group.js";
import type { SweepFlowResult } from "../src/sweep/types.js";

// No observations means the established neutral geometry fallback.
test("sweep proposals retain scores, severity tiers and proposal-ID tie-break", async () => {
  const records = [
    ["low", "minor", "target-size"],
    ["high", "minor", "dead-control"],
    ["tie", "minor", "error-text"],
    ["major", "major", "target-size"],
    ["blocker", "blocker", "target-size"],
  ].map(([id, severity, category]) => ({
    finding: findingSchema.parse({
      id,
      fingerprint: id,
      severity,
      category,
      rule: `rule-${id}`,
      status: "open",
      confidence: 1,
      layer: "deterministic",
      createdAt: "2026-10-29T00:00:00Z",
      commit: "abc",
      flow: "flow",
      state: "ready",
      viewport: "desktop",
      evidence: { screenshots: [] },
      explanation: id,
      acceptance: ["Repair"],
      verification: {
        kind: "deterministic-check",
        check: category,
        params: { selector: `#${id}` },
      },
    }),
    runId: "run",
    runDirectory: "/unavailable",
    findingsPath: "/unavailable/findings.json",
  }));
  const flows = [
    {
      flow: "flow",
      records,
      review: { groups: [], runDirectory: "/unavailable" },
    },
  ] as unknown as SweepFlowResult[];
  const proposals = await groupSweep(flows);
  expect(proposals.map((p) => p.severity)).toEqual([
    "blocker",
    "major",
    "minor",
    "minor",
    "minor",
  ]);
  expect(proposals.map((p) => p.score)).toEqual([1, 1, 9, 9, 1]);
  const ties = proposals.slice(2, 4).map((p) => p.id);
  expect(ties).toEqual([...ties].sort((a, b) => a.localeCompare(b)));
  expect(proposals.flatMap((p) => p.findingIds).sort()).toEqual(
    records.map((r) => r.finding.id).sort(),
  );
});
