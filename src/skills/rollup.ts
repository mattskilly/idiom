import { skillNames } from "./distribution.js";
import type { FileOutcome, Outcome, SkillSummary } from "./types.js";

// The first six follow the published order. `removed` is still an applied
// change, so it ranks next; `kept` left a file as it was (a customized retired
// file or a protected entry), which is still more than `current`.
export const outcomePrecedence: Outcome[] = [
  "conflicted",
  "merged",
  "resolved",
  "adopted",
  "installed",
  "removed",
  "kept",
  "current",
];
export function rollupSkills(files: FileOutcome[]): SkillSummary[] {
  const summaries: SkillSummary[] = [];
  for (const name of skillNames) {
    const own = files
      .filter((file) => file.skill === name)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (!own.length) continue;
    const outcome =
      outcomePrecedence.find((action) =>
        own.some((file) => file.action === action),
      ) ?? "current";
    summaries.push({ name, outcome, files: own });
  }
  return summaries;
}
export function skillSummaryLine(summary: SkillSummary): string {
  if (summary.outcome === "current") return `${summary.name}: current`;
  const count = summary.files.filter(
    (file) => file.action === summary.outcome,
  ).length;
  return `${summary.name}: ${summary.outcome} (${count} ${count === 1 ? "file" : "files"})`;
}
