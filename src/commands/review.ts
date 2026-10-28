import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BaselineComparisonSummary,
  summarizeBaselineComparison,
  summarizeFinding,
} from "../baseline/summary.js";
import {
  type PageReviewDependencies,
  type PageReviewResult,
  runPageReview,
} from "../review/page.js";
import {
  type ReviewDependencies,
  type ReviewRunResult,
  runReview,
} from "../review/run.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import { isPublishedFlow } from "../schemas/flow.js";
import { validateProject } from "../validation.js";

export type PublishedBudgetViolation = {
  id: string;
  state: string;
  viewport: string;
  explanation: string;
};

/** Open (or approved) published-budget findings: the published review gate. */
function publishedBudgetViolations(
  findings: Finding[],
): PublishedBudgetViolation[] {
  return findings
    .filter(
      (finding) =>
        finding.category === "published-budget" &&
        (finding.status === "open" || finding.status === "approved"),
    )
    .map(({ id, state, viewport, explanation }) => ({
      id,
      state,
      viewport,
      explanation,
    }));
}

export async function reviewCommand(options: {
  flow: string;
  project?: string | undefined;
  cwd?: string | undefined;
  refreshDesign?: boolean | undefined;
  from?: string | undefined;
  latest?: boolean | undefined;
  deterministicOnly?: boolean | undefined;
  sinceBaseline?: boolean | undefined;
  dependencies?: ReviewDependencies | undefined;
}): Promise<
  ReviewRunResult & {
    comparison?: BaselineComparisonSummary & {
      unclassified: number;
      currentJudged?: import("../baseline/summary.js").SummaryFinding[];
    };
    publishedBudget?: { violations: PublishedBudgetViolation[] };
  }
> {
  const { sinceBaseline, ...reviewOptions } = options;
  const result = await runReview({
    ...reviewOptions,
    ...(sinceBaseline === true
      ? { includeDeterministicOccurrences: true }
      : {}),
  });
  const published = (
    await validateProject({
      project: options.project,
      cwd: options.cwd,
      flow: options.flow,
    })
  ).flows.some(({ flow }) => isPublishedFlow(flow));
  let material: Finding[] | undefined;
  const readMaterial = async () => {
    material ??= findingSchema
      .array()
      .parse(JSON.parse(await readFile(result.findingsPath, "utf8")));
    return material;
  };
  const publishedBudget = published
    ? {
        violations: publishedBudgetViolations([
          ...(await readMaterial()),
          ...result.deferredFindings,
        ]),
      }
    : undefined;
  const gated =
    publishedBudget === undefined ? result : { ...result, publishedBudget };
  if (sinceBaseline !== true) return gated;
  const findings = await readMaterial();
  const comparison = {
    ...(await summarizeBaselineComparison(options, result, findings)),
    currentJudged: [...findings, ...result.deferredFindings]
      .filter(
        (f) =>
          f.basis === "judged" &&
          (f.status === "open" || f.status === "approved"),
      )
      .map((f) => summarizeFinding(f, result, options.cwd ?? process.cwd())),
    unclassified: [...findings, ...result.deferredFindings].filter(
      (finding) => finding.layer !== "deterministic",
    ).length,
  };
  await writeFile(
    join(result.runDirectory, "baseline-comparison.json"),
    `${JSON.stringify(comparison, null, 2)}\n`,
  );
  return { ...gated, comparison };
}

export async function pageReviewCommand(
  options: Parameters<typeof runPageReview>[0] & {
    dependencies?: PageReviewDependencies | undefined;
  },
): Promise<PageReviewResult> {
  return await runPageReview(options);
}
