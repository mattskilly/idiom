import type { SummaryFinding } from "../../baseline/summary.js";
import type { CheckSummary } from "../../commands/check.js";
import { severityGateEligible } from "../../findings/gate.js";

export type FailOn = "blocker" | "major" | "minor" | "never";

/**
 * The new findings a gate fails on: at or above `failOn`, not held as a
 * pending decision, not acknowledged and not pre-existing. The CLI's exit
 * decision and the fix handoff both read this, so they cannot disagree.
 */
export function blockingFindings(
  checked: ReadonlyArray<{ flow: string; summary: CheckSummary }>,
  options: {
    failOn: FailOn;
    failOnJudged?: boolean | undefined;
    decisionIds?: ReadonlySet<string> | undefined;
  },
): Array<{ flow: string; finding: SummaryFinding }> {
  if (options.failOn === "never") return [];
  return checked.flatMap((entry) => {
    const preExisting = new Set(
      (entry.summary.preExistingFindings ?? []).map((finding) => finding.id),
    );
    return entry.summary.findings
      .filter(
        (finding) =>
          !options.decisionIds?.has(finding.id) &&
          finding.acknowledged === undefined &&
          !preExisting.has(finding.id) &&
          severityGateEligible(
            finding,
            options.failOn,
            options.failOnJudged ?? false,
          ),
      )
      .map((finding) => ({ flow: entry.flow, finding }));
  });
}
