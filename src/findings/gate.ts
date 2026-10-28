import type { FindingBasis } from "../schemas/acceptance.js";

export function severityGateEligible(
  finding: {
    severity: string;
    basis?: FindingBasis | undefined;
    layer?: string;
  },
  failOn: "never" | "blocker" | "major" | "minor",
  failOnJudged = false,
): boolean {
  if (failOn === "never") return false;
  if (
    (finding.basis ?? (finding.layer === "model" ? "judged" : "measured")) ===
      "judged" &&
    !failOnJudged
  )
    return false;
  const rank: Record<string, number> = { blocker: 0, major: 1, minor: 2 };
  return (rank[finding.severity] ?? 3) <= (rank[failOn] ?? -1);
}
