import { relative } from "node:path";
import { IdiomError } from "../errors.js";
import { acceptanceText } from "../findings/presentation.js";
import type { ReviewRunResult } from "../review/run.js";
import type { Finding } from "../schemas/finding.js";
import { type ValidationResult, validateProject } from "../validation.js";
import type { BaseComparison } from "./base.js";
import { compareRunToBaseline } from "./compare.js";
import { tupleCoordinateKey } from "./coordinate.js";

export type SummaryFinding = {
  basis?: Finding["basis"] | undefined;
  basisDetails?: Finding["basisDetails"] | undefined;
  acceptance?: Finding["acceptance"] | undefined;
  id: string;
  /** Stable identity for occurrence-level presentation across pushes. */
  fingerprint?: string | undefined;
  severity: Finding["severity"];
  category: Finding["category"];
  rule?: string | undefined;
  /** Same element and rule across states and schemes (#52). */
  groupKey?: string | undefined;
  where: string;
  selector?: string | undefined;
  problem: string;
  fix: string[];
  screenshot?: string | undefined;
  filmstrip?: string | undefined;
  /** The action timeline the finding was measured from. */
  timeline?: { id: string; path: string } | undefined;
  deferred?: boolean | undefined;
  occurrenceOnly?: boolean | undefined;
  /** Tracked elsewhere: shown, never counted toward --fail-on or as new. */
  acknowledged?: { reference: string; until?: string | undefined } | undefined;
};
/** Relative to the working directory when inside it, absolute otherwise. */
export function displayPath(base: string, absolute: string): string {
  const local = relative(base, absolute);
  return local.startsWith("..") ? absolute : local;
}
export function summarizeFinding(
  finding: Finding,
  result: Pick<ReviewRunResult, "runDirectory">,
  base: string,
): SummaryFinding {
  const params = finding.verification.params ?? {};
  const selector =
    typeof params.selector === "string" ? params.selector : undefined;
  const screenshot =
    finding.evidence.screenshots.find((path) => path.includes("/crops/")) ??
    finding.evidence.screenshots[0];
  return {
    id: finding.id,
    fingerprint: finding.fingerprint,
    basis: finding.basis,
    basisDetails: finding.basisDetails,
    acceptance: finding.acceptance,
    severity: finding.severity,
    category: finding.category,
    ...(finding.rule === undefined ? {} : { rule: finding.rule }),
    ...(finding.groupKey === undefined ? {} : { groupKey: finding.groupKey }),
    where: `${finding.state}/${finding.viewport}${finding.colorScheme === undefined ? "" : `/${finding.colorScheme}`}`,
    ...(selector === undefined ? {} : { selector }),
    problem: finding.explanation,
    fix: acceptanceText(finding),
    ...(finding.evidence.filmstrip?.sheet
      ? {
          filmstrip: displayPath(
            base,
            `${result.runDirectory}/${finding.evidence.filmstrip.sheet}`,
          ),
        }
      : {}),
    ...(screenshot === undefined
      ? {}
      : {
          screenshot: displayPath(base, `${result.runDirectory}/${screenshot}`),
        }),
    ...(finding.acknowledgement === undefined
      ? {}
      : {
          acknowledged: {
            reference: finding.acknowledgement.reference,
            ...(finding.acknowledgement.until === undefined
              ? {}
              : { until: finding.acknowledgement.until }),
          },
        }),
    ...(finding.evidence.timeline === undefined
      ? {}
      : {
          timeline: {
            id: finding.evidence.timeline.id,
            path: displayPath(
              base,
              `${result.runDirectory}/${finding.evidence.timeline.artifact}`,
            ),
          },
        }),
  };
}
const occurrenceKey = (finding: Finding) =>
  `${tupleCoordinateKey(finding)}\0${finding.fingerprint}`;
export async function summarizeBaselineComparison(
  options: {
    flow: string;
    validated?: ValidationResult | undefined;
    comparisonCommit?: string | undefined;
    baselineFile?: string | undefined;
    project?: string | undefined;
    cwd?: string | undefined;
    comparison?: BaseComparison | undefined;
  },
  result: ReviewRunResult,
  material: Finding[],
) {
  if (result.deterministicOccurrences === undefined)
    throw new IdiomError(
      "review did not return requested deterministic occurrences",
    );
  const validated = options.validated ?? (await validateProject(options));
  const flow = validated.flows[0]?.flow;
  if (flow === undefined) throw new IdiomError(`unknown flow ${options.flow}`);
  const comparison = await compareRunToBaseline({
    validated,
    flow,
    baselineFile: options.baselineFile,
    comparisonCommit: options.comparisonCommit,
    comparison: options.comparison,
    cwd: options.cwd,
    runDirectory: result.runDirectory,
    // Acknowledged occurrences never enter the comparison: neither new nor,
    // since fixed is read from every current candidate, fixed.
    liveOccurrences: result.deterministicOccurrences.filter(
      (finding) => isGateOpen(finding) && finding.acknowledgement === undefined,
    ),
  });
  const materialKeys = new Set(material.map(occurrenceKey));
  const deferredKeys = new Set(result.deferredFindings.map(occurrenceKey));
  const summarize = (finding: Finding): SummaryFinding => ({
    ...summarizeFinding(finding, result, options.cwd ?? process.cwd()),
    where: tupleCoordinateKey(finding),
    ...(!materialKeys.has(occurrenceKey(finding))
      ? deferredKeys.has(occurrenceKey(finding))
        ? { deferred: true }
        : { occurrenceOnly: true }
      : {}),
  });
  return {
    findings: comparison.newFindings.map(summarize),
    blocking: comparison.newFindings.filter(
      (finding) =>
        finding.severity === "blocker" || finding.severity === "major",
    ).length,
    preExisting: comparison.preExisting.length,
    preExistingFindings: comparison.preExisting.map(summarize),
    fixed: comparison.fixed.map(
      ({ fingerprint, severity, category, rule, where, selector }) => ({
        fingerprint,
        severity,
        category,
        rule,
        where,
        selector,
      }),
    ),
    baseline: comparison.baseline,
    acknowledgedFindings: result.deterministicOccurrences
      .filter(
        (finding) =>
          isGateOpen(finding) && finding.acknowledgement !== undefined,
      )
      .map(summarize),
    acknowledgementLapses: result.acknowledgementLapses,
  };
}

/** Open work a gate may count; an acknowledgement additionally excludes it. */
export function isGateOpen(finding: Finding): boolean {
  return finding.status === "open" || finding.status === "approved";
}
export type BaselineComparisonSummary = Awaited<
  ReturnType<typeof summarizeBaselineComparison>
>;
