import type { CheckSummary } from "../../commands/check.js";

/**
 * Finding ids in issue rank order: function before appearance, as the
 * summary's issues already rank them. A root cause is taken whole (past `top`)
 * or not at all, and never split. Without issues, summary order holds.
 */
export function rankFindingIds(
  summary: Pick<CheckSummary, "findings" | "groups" | "issues">,
  ids: readonly string[],
  top: number,
): string[] {
  const allowed = new Set(ids);
  const known = (list: string[]) =>
    [...new Set(list)].filter((id) => allowed.has(id));
  const issues = summary.issues;
  if (issues === undefined)
    return known(summary.findings.map((finding) => finding.id)).slice(0, top);
  const groups = new Map(summary.groups?.map((group) => [group.id, group]));
  const selected: string[] = [];
  for (const issue of issues) {
    const eligible = known(
      issue.groups.flatMap(
        (id) => groups.get(id)?.members.map((member) => member.id) ?? [],
      ),
    ).filter((id) => !selected.includes(id));
    if (eligible.length === 0) continue;
    if (issue.rootCause !== undefined) {
      if (selected.length === 0) return eligible;
      break;
    }
    for (const id of eligible) {
      if (selected.length >= top) return selected;
      selected.push(id);
    }
  }
  return selected;
}
