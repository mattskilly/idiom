import { relative } from "node:path";
import { IdiomError } from "../errors.js";
import type { ReviewRunResult } from "../review/run.js";
import type { Finding } from "../schemas/finding.js";
import { validateProject } from "../validation.js";
import { compareRunToBaseline } from "./compare.js";
import { tupleCoordinateKey } from "./coordinate.js";

export type SummaryFinding = {
  id: string;
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
  deferred?: boolean | undefined;
  occurrenceOnly?: boolean | undefined;
};
/** Relative to the working directory when inside it, absolute otherwise. */
export function displayPath(base: string, absolute: string): string {
  const local = relative(base, absolute);
  return local.startsWith("..") ? absolute : local;
}
export function summarizeFinding(
  finding: Finding,
  result: ReviewRunResult,
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
    severity: finding.severity,
    category: finding.category,
    ...(finding.rule === undefined ? {} : { rule: finding.rule }),
    ...(finding.groupKey === undefined ? {} : { groupKey: finding.groupKey }),
    where: `${finding.state}/${finding.viewport}${finding.colorScheme === undefined ? "" : `/${finding.colorScheme}`}`,
    ...(selector === undefined ? {} : { selector }),
    problem: finding.explanation,
    fix: finding.acceptance,
    ...(screenshot === undefined
      ? {}
      : {
          screenshot: displayPath(base, `${result.runDirectory}/${screenshot}`),
        }),
  };
}
const occurrenceKey = (finding: Finding) =>
  `${tupleCoordinateKey(finding)}\0${finding.fingerprint}`;
export async function summarizeBaselineComparison(
  options: {
    flow: string;
    baselineFile?: string | undefined;
    project?: string | undefined;
    cwd?: string | undefined;
  },
  result: ReviewRunResult,
  material: Finding[],
) {
  if (result.deterministicOccurrences === undefined)
    throw new IdiomError(
      "review did not return requested deterministic occurrences",
    );
  const validated = await validateProject(options);
  const flow = validated.flows[0]?.flow;
  if (flow === undefined) throw new IdiomError(`unknown flow ${options.flow}`);
  const comparison = await compareRunToBaseline({
    validated,
    flow,
    baselineFile: options.baselineFile,
    cwd: options.cwd,
    runDirectory: result.runDirectory,
    liveOccurrences: result.deterministicOccurrences.filter(
      (finding) => finding.status === "open" || finding.status === "approved",
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
      (finding) => finding.severity !== "minor",
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
  };
}
export type BaselineComparisonSummary = Awaited<
  ReturnType<typeof summarizeBaselineComparison>
>;
