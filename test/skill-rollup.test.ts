import { expect, test } from "vitest";
import { rollupSkills, skillSummaryLine } from "../src/skills/rollup.js";
import type { FileOutcome, Outcome, SkillName } from "../src/skills/types.js";

const file = (
  action: Outcome,
  name: string,
  skill: SkillName = "idiom",
): FileOutcome => ({
  skill,
  path: `.agents/skills/${skill}/${name}`,
  action,
  previous: { kind: "unknown" },
  incomingVersion: "2.0.0",
  pristinePath: `.agents/skills/.idiom-pristine/${skill}/${name}`,
  incomingPath: null,
  needsResolution: false,
});

test.each([
  ["conflicted", "merged"],
  ["merged", "resolved"],
  ["resolved", "adopted"],
  ["adopted", "installed"],
  ["installed", "removed"],
  ["removed", "kept"],
  ["kept", "current"],
] as [Outcome, Outcome][])("%s outranks %s", (winner, loser) => {
  const [summary] = rollupSkills([file(loser, "a.md"), file(winner, "b.md")]);
  expect(summary?.outcome).toBe(winner);
  expect(skillSummaryLine(summary as never)).toBe(`idiom: ${winner} (1 file)`);
});

test("all current reports current without a count", () => {
  const summaries = rollupSkills([
    file("current", "a.md"),
    file("current", "b.md"),
  ]);
  expect(summaries.map(skillSummaryLine)).toEqual(["idiom: current"]);
});

test("counts only files carrying the winning outcome, in skill order", () => {
  const summaries = rollupSkills([
    file("current", "SKILL.md", "idiom-verify"),
    file("merged", "b.md"),
    file("adopted", "c.md"),
    file("merged", "a.md"),
  ]);
  expect(summaries.map(skillSummaryLine)).toEqual([
    "idiom: merged (2 files)",
    "idiom-verify: current",
  ]);
  expect(summaries[0]?.files.map((value) => value.path)).toEqual([
    ".agents/skills/idiom/a.md",
    ".agents/skills/idiom/b.md",
    ".agents/skills/idiom/c.md",
  ]);
});

test("skills without files are omitted", () => {
  expect(rollupSkills([])).toEqual([]);
  expect(
    rollupSkills([file("installed", "SKILL.md", "idiom-verify")]).map(
      (summary) => summary.name,
    ),
  ).toEqual(["idiom-verify"]);
});
