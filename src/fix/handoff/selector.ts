import type { SummaryFinding } from "../../baseline/summary.js";

type SelectorSource = Pick<SummaryFinding, "acceptance" | "selector"> & {
  /** verification.params when the caller has the full finding. */
  params?: Record<string, unknown> | undefined;
  selectorHint?: string | undefined;
};

/**
 * The element a finding is about: the acceptance rule's first target
 * selector, then the check's own `selector` parameter, then a hint, then the
 * document itself.
 */
export function findingSelector(finding: SelectorSource): string {
  const acceptance = finding.acceptance;
  if (
    acceptance !== undefined &&
    !Array.isArray(acceptance) &&
    acceptance.kind === "rule" &&
    acceptance.target.kind === "selectors" &&
    acceptance.target.selectors[0] !== undefined
  )
    return acceptance.target.selectors[0];
  const param = finding.params?.selector;
  if (typeof param === "string" && param.length > 0) return param;
  if (finding.selector !== undefined && finding.selector.length > 0)
    return finding.selector;
  if (finding.selectorHint !== undefined && finding.selectorHint.length > 0)
    return finding.selectorHint;
  return "document";
}
