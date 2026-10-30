import type {
  CheckCoverage,
  CheckResult,
  CheckTuple,
  CoverageStatus,
  ObservedElement,
} from "./types.js";

/** Absence is deliberately eligible: old artifacts keep their original domain. */
export const isElementPainted = (element: ObservedElement | undefined) =>
  element?.painted?.value !== false;

/** One gate per check/tuple, counting distinct owners in each rule's domain. */
export function paintedGate(tuple: CheckTuple, rules: readonly string[]) {
  const elements = tuple.observations?.elements ?? [];
  const bySelector = new Map(
    elements.map((element) => [element.selector, element]),
  );
  const hasFacts = elements.some((element) => element.painted !== undefined);
  const skipped = new Map(rules.map((rule) => [rule, new Set<string>()]));
  const allows = (
    rule: string,
    ...owners: Array<string | ObservedElement | undefined>
  ) => {
    let allowed = true;
    for (const owner of owners) {
      const element = typeof owner === "string" ? bySelector.get(owner) : owner;
      if (element?.painted?.value === false) {
        skipped.get(rule)?.add(element.selector);
        allowed = false;
      }
    }
    return allowed;
  };
  const coverage = () =>
    hasFacts
      ? {
          paintedSkipped: Object.fromEntries(
            [...skipped].map(([rule, owners]) => [rule, owners.size]),
          ),
        }
      : {};
  return {
    allows,
    filter: <T extends ObservedElement>(rule: string, domain: readonly T[]) =>
      domain.filter((element) => allows(rule, element)),
    coverage,
    result: (result: CheckResult): CheckResult => ({
      ...result,
      coverage: { ...result.coverage, ...coverage() },
    }),
  };
}

export function coverageStatusText(status: CoverageStatus): string {
  return status === "not-applicable" ? "not applicable" : status;
}

export function paintedCoverageText(coverage: {
  reason?: string | undefined;
  paintedSkipped?: Record<string, number> | undefined;
  inkSkipped?: Record<string, number> | undefined;
}): string {
  return [
    coverage.reason,
    ...Object.entries(coverage.paintedSkipped ?? {}).map(
      ([rule, count]) => `${rule}: ${count} skipped as not painted`,
    ),
    ...Object.entries(coverage.inkSkipped ?? {}).map(
      ([rule, count]) =>
        `${rule}: ${count} skipped as not visible in the captured screenshot`,
    ),
  ]
    .filter(Boolean)
    .join("; ");
}

export type PaintedCoverageReport = {
  checkCoverage?:
    | Array<
        CheckCoverage & Pick<CheckTuple, "state" | "viewport" | "colorScheme">
      >
    | undefined;
};

/** Public JSON coverage without serializing tuples' DOM and observation payloads. */
export function reportedCheckCoverage(
  entries: Array<{ tuple: CheckTuple; coverage: CheckCoverage }>,
): PaintedCoverageReport {
  if (
    !entries.some(
      ({ coverage }) =>
        coverage.paintedSkipped !== undefined ||
        coverage.inkSkipped !== undefined,
    )
  )
    return {};
  return {
    checkCoverage: entries.map(({ tuple, coverage }) => ({
      ...coverage,
      state: tuple.state,
      viewport: tuple.viewport,
      ...(tuple.colorScheme === undefined
        ? {}
        : { colorScheme: tuple.colorScheme }),
    })),
  };
}
