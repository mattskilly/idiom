import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { SummaryFinding } from "../src/baseline/summary.js";
import type { CheckSummary } from "../src/commands/check.js";
import { roundOutcome } from "../src/fix/handoff/progress.js";
import { writeHandoffRound } from "../src/fix/handoff/write.js";

// Findings keyed by fingerprint so rounds compare by occurrence, not id.
const finding = (name: string, id = name): SummaryFinding => ({
  id,
  fingerprint: `fp-${name}`,
  severity: "major",
  category: "adjacent-gap",
  rule: "idiom:adjacent-elements-touch",
  where: "list/desktop",
  problem: `${name} touches its neighbour`,
  fix: [`${name} keeps 8px`],
  selector: `.${name}`,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idiom-fix-revert-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const gate = (...findings: SummaryFinding[]) =>
  writeHandoffRound({
    dir: "handoff",
    cwd: dir,
    projectDirectory: dir,
    base: "base",
    head: "head",
    failOn: "major",
    checked: [
      {
        flow: "orders",
        summary: { findings } as unknown as CheckSummary,
      },
    ],
    totalMs: 1,
  });

test("roundOutcome keeps only edits that fixed a target and introduced nothing", () => {
  const progress = (fixed: string[], introduced: string[]) => ({
    fixed,
    persisting: [],
    introduced,
  });
  expect(roundOutcome(progress(["a"], []), 1)).toBe("commit");
  expect(roundOutcome(progress(["a"], ["c"]), 2)).toBe("revert");
  expect(roundOutcome(progress([], []), 2)).toBe("revert");
  expect(roundOutcome(progress([], []), 0)).toBe("commit");
});

test("a reverted round is never the baseline for progress, the next targets or the summary", async () => {
  // Round 0: A and B block.
  const zero = await gate(finding("a"), finding("b"));
  expect(zero.round).toMatchObject({ round: 0, next: "repair" });
  expect(zero.round.outcome).toBeUndefined();

  // Round 1: the edit fixed A but introduced C, so the CLI says revert and
  // points the next repair back at round 0, which describes HEAD again.
  const one = await gate(finding("b"), finding("c"));
  expect(one.round.progress).toEqual({
    fixed: ["a"],
    persisting: ["b"],
    introduced: ["c"],
  });
  expect(one.round).toMatchObject({ outcome: "revert", repairFrom: 0 });
  expect(one.json).toMatchObject({ outcome: "revert", repairFrom: 0 });
  const handoff = await readFile(
    join(dir, "handoff", "round-1", "handoff.md"),
    "utf8",
  );
  expect(handoff).toContain(
    "Outcome: revert. The edits this round judged introduced c",
  );
  expect(handoff).toContain("round-0/handoff.md");
  await writeFile(
    join(dir, "handoff", "round-1", "edits.md"),
    "- toolbar.css: widened the gap; reverted (introduced c).\n",
  );

  // Round 2, worked from round 0 after the revert: B is fixed and A, back
  // with the revert, persists. Compared with round 1 instead, A would read as
  // introduced and C as fixed, and the correct fix would be reverted.
  const two = await gate(finding("a"));
  expect(two.round.progress).toEqual({
    fixed: ["b"],
    persisting: ["a"],
    introduced: [],
  });
  expect(two.round).toMatchObject({ outcome: "commit", repairFrom: 2 });

  // Round 3 reverts again (nothing fixed) and the step stops. The summary
  // describes HEAD: A open, B fixed and committed, C never mentioned.
  const three = await gate(finding("a"));
  expect(three.round).toMatchObject({
    next: "stop",
    outcome: "revert",
    repairFrom: 2,
  });
  const summary = await readFile(join(dir, "handoff", "summary.md"), "utf8");
  const lines = summary.trimEnd().split("\n");
  expect(lines[0]).toBe(
    "Idiom fix: fixed 1 of 2 new blocking finding(s) in 3 round(s) (2 reverted).",
  );
  expect(summary).toContain("- a idiom:adjacent-elements-touch at `.a`");
  expect(summary).toContain("Rounds tried: 3.");
  expect(summary).toContain("Fixed and committed: b.");
  expect(summary).not.toMatch(/\bc\b idiom/);
  const transcript = await readFile(
    join(dir, "handoff", "transcript.md"),
    "utf8",
  );
  expect(transcript).toContain(
    "Outcome: edits reverted; the next repair works from round 0.",
  );
  expect(transcript).toContain("Outcome: edits kept (committed).");
  expect(transcript).toContain(
    "Edits this round re-verified:\n\n- toolbar.css: widened the gap; reverted (introduced c).",
  );
});

test("a stop right after a revert summarises the last kept round, not the reverted one", async () => {
  await gate(finding("a"), finding("b"));
  await gate(finding("b")); // fixed a: commit
  await gate(finding("b")); // nothing fixed: revert
  const last = await gate(finding("c")); // fixed b, introduced c: revert
  expect(last.round).toMatchObject({ next: "stop", outcome: "revert" });
  const summary = await readFile(join(dir, "handoff", "summary.md"), "utf8");
  // b is still open at HEAD (its fix was reverted); c does not exist there.
  expect(summary).toContain("Fixed and committed: a.");
  expect(summary).toContain("- b idiom:adjacent-elements-touch");
  expect(summary).not.toContain("- c ");
});
