import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  beginCheckRecording,
  completeCheckRecording,
} from "../agent/check-state.js";
import { resolveRunBaseline } from "../baseline/compare.js";
import { recordBaseline } from "../baseline/record.js";
import { renderBaselineComparison } from "../baseline/render.js";
import {
  type BaselineComparisonSummary,
  displayPath,
  type SummaryFinding,
  summarizeBaselineComparison,
  summarizeFinding,
} from "../baseline/summary.js";
import type { CaptureScope } from "../capture/scope.js";
import type { ProductionBuild } from "../capture/types.js";
import type { PaintedCoverageReport } from "../checks/painted.js";
import { projectChecksConfig } from "../checks/project-config.js";
import {
  type FlowStateCoverage,
  stateCoverageLine,
} from "../coverage/states.js";
import { IdiomError } from "../errors.js";
import { acceptanceText, basisDescription } from "../findings/presentation.js";
import { loadRunTuples, resolveStoredRun } from "../review/artifacts.js";
import { describeSpread, isRepeated } from "../review/groups.js";
import {
  type CheckIssue,
  categoryCounts,
  collapseIssues,
} from "../review/issues.js";
import { type CheckGroup, projectIssueSummary } from "../review/summary.js";

export type { CheckGroup } from "../review/summary.js";

import type { ReviewOutcome } from "../review/report.js";
import {
  type ReviewDependencies,
  type ReviewRunResult,
  runReview,
} from "../review/run.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import type { ClusterCause } from "../tickets/cluster.js";
import {
  type ClusterTicketsResult,
  emitClusterTickets,
  renderClusterTicketsResult,
} from "../tickets/emit.js";
import { validateProject } from "../validation.js";
import { deterministicFingerprintSet } from "../verify/evaluate.js";

export type CheckSummary = PaintedCoverageReport & {
  scope?: import("../capture/run-record.js").RunRecord | undefined;
  timings?: import("../capture/timings.js").RunTimings | undefined;
  coverage?: import("../report/coverage.js").ReportCoverage | undefined;
  tickets?: ClusterTicketsResult | undefined;
  build?: ProductionBuild | undefined;
  flow: string;
  runDirectory: string;
  reportPath: string;
  findings: SummaryFinding[];
  /** Full/legacy mode findings grouped by element and rule; absent in recorded comparison mode. */
  groups?: CheckGroup[] | undefined;
  /** Ranked presentation only; every group belongs to exactly one issue. */
  issues?: CheckIssue[] | undefined;
  preExistingFindings?: SummaryFinding[];
  fixed?: BaselineComparisonSummary["fixed"];
  baseline?: BaselineComparisonSummary["baseline"];
  baselineNotApplied?: string;
  baselineRecorded?: Awaited<ReturnType<typeof recordBaseline>>;
  blocking: number;
  /** With --baseline: findings already present there and left out. */
  preExisting?: number | undefined;
  /** With --advisory: the model's design-intent review; never gates. */
  advisory?: CheckAdvisory | undefined;
  /** Repeated off-scale values held as questions instead of findings. */
  designSystemQuestions?: CheckDesignSystemQuestion[] | undefined;
};

export type CheckDesignSystemQuestion = {
  id: string;
  question: string;
  count: number;
  suggestedToken: string;
};

export type CheckAdvisory = {
  path: string;
  outcome: ReviewOutcome;
  patterns: Array<{
    id: string;
    status: "ok" | "failed" | "skipped";
    reason?: string | undefined;
    findings: Array<{
      id: string;
      aspect: string;
      severity: Finding["severity"];
      where: string;
      section: string;
      basis?: Finding["basis"];
      basisDetails?: Finding["basisDetails"];
      acceptance?: Finding["acceptance"];
      problem: string;
      fix: string[];
      evidence?: string | undefined;
    }>;
  }>;
};

const order = { blocker: 0, major: 1, minor: 2 } as const;

/**
 * The agent loop: capture, run every deterministic check, and print what to
 * fix in the order to fix it. Fast, model-free and repeatable, so a coding
 * agent can run it after every UI change instead of waiting for a gate.
 */
export type CheckOptions = {
  flow: string;
  project?: string | undefined;
  cwd?: string | undefined;
  prod?: boolean | undefined;
  scope?: CaptureScope | undefined;
  /** Serve the application on this port instead of a free one. */
  port?: number | undefined;
  /** Refetch pinned Figma frames. */
  refreshDesign?: boolean | undefined;
  from?: string | undefined;
  latest?: boolean | undefined;
  /** Report only findings this stored run did not already have. */
  baseline?: string | undefined;
  sinceBaseline?: boolean | undefined;
  baselineFile?: string | undefined;
  all?: boolean | undefined;
  emitTickets?: string | undefined;
  /** Also run the advisory design-intent review; never affects the gate. */
  advisory?: boolean | undefined;
  dependencies?: ReviewDependencies | undefined;
};

export async function checkCommand(
  options: CheckOptions,
): Promise<CheckSummary> {
  return (await checkWithReview({ ...options, recordAgentCheck: true }))
    .summary;
}

/** Internal rich seam for controllers; normal check output stays unchanged. */
export async function checkWithReview(
  options: CheckOptions & {
    bootstrapBaseline?: boolean;
    materializeAllDeterministic?: boolean;
    /** Adapters need tuple diagnostics before an automatic baseline can fail. */
    captureFailureIsError?: boolean;
    /** Only public live check commands count toward the agent reminder. */
    recordAgentCheck?: boolean;
  },
): Promise<{ summary: CheckSummary; review: ReviewRunResult }> {
  const {
    baseline,
    sinceBaseline,
    baselineFile,
    all,
    emitTickets,
    advisory,
    materializeAllDeterministic,
    captureFailureIsError,
    recordAgentCheck,
    bootstrapBaseline,
    ...reviewOptions
  } = options;
  const selectors = [
    baseline !== undefined,
    sinceBaseline === true,
    baselineFile !== undefined,
  ].filter(Boolean).length;
  if (selectors > 1 || (all === true && selectors > 0))
    throw new IdiomError(
      "--all, --baseline, --since-baseline and --baseline-file are mutually exclusive",
    );
  let recordedMode = all !== true && baseline === undefined;
  let baselineNotApplied: string | undefined;
  let bootstrap: Parameters<typeof recordBaseline>[0] | undefined;
  if (recordedMode) {
    const validated = await validateProject(options);
    const flow = validated.flows[0]?.flow;
    if (flow === undefined)
      throw new IdiomError(`unknown flow ${options.flow}`);
    const { selected, path } = await resolveRunBaseline({
      validated,
      flow,
      baselineFile,
      cwd: options.cwd,
    });
    if (selected === undefined) {
      if (sinceBaseline === true || baselineFile !== undefined)
        throw new IdiomError(
          `no recorded baseline for "${flow.id}" reachable from HEAD in ${path}; run idiom baseline record ${flow.id} on a clean committed tree and commit it`,
        );
      if (bootstrapBaseline === false) {
        recordedMode = false;
        baselineNotApplied =
          "baseline not applied: no reachable recorded baseline; changed checks never initialize one";
      } else
        bootstrap = { validated, flow, runDirectory: "", requireHead: true };
    }
  }
  const recording =
    recordAgentCheck === true &&
    options.from === undefined &&
    options.latest !== true
      ? await beginCheckRecording(options)
      : undefined;
  const result = await runReview({
    ...reviewOptions,
    deterministicOnly: true,
    includeIssueRankingContext: !recordedMode,
    ...(advisory === true ? { advisory: true } : {}),
    ...(materializeAllDeterministic === true
      ? { materializeAllDeterministic: true }
      : {}),
    ...(recordedMode || materializeAllDeterministic === true
      ? { includeDeterministicOccurrences: true }
      : {}),
  });
  options.dependencies?.capture?.signal?.throwIfAborted();
  if (captureFailureIsError) {
    const validated = await validateProject(options);
    const flow = validated.flows[0]?.flow;
    if (flow) {
      const loaded = await loadRunTuples(validated, flow, result.runDirectory);
      const failures = loaded.tuples.flatMap((tuple) =>
        tuple.failure
          ? [`${tuple.failure.stage}: ${tuple.failure.message}`]
          : [],
      );
      if (failures.length)
        throw new IdiomError(
          `Capture failed: ${failures.join("; ")}. Reports: ${result.reportPath}, ${result.htmlReportPath}`,
        );
    }
  }
  const baselineRecorded =
    bootstrap === undefined
      ? undefined
      : await recordBaseline({
          ...bootstrap,
          runDirectory: result.runDirectory,
        });
  let known: Set<string> | undefined;
  if (baseline !== undefined) {
    const validated = await validateProject({
      project: options.project,
      flow: options.flow,
      cwd: options.cwd,
    });
    const record = validated.flows[0];
    if (record !== undefined) {
      const loaded = await loadRunTuples(
        validated,
        record.flow,
        resolveStoredRun(validated.projectDirectory, baseline),
      );
      known = deterministicFingerprintSet(
        loaded.tuples,
        validated.project.capture.colorScheme,
        await projectChecksConfig(validated),
      );
    }
  }
  const findings = findingSchema
    .array()
    .parse(JSON.parse(await readFile(result.findingsPath, "utf8")));
  let summary: CheckSummary;
  if (recordedMode) {
    summary = {
      flow: options.flow,
      ...(result.build === undefined ? {} : { build: result.build }),
      runDirectory: result.runDirectory,
      reportPath: result.reportPath,
      ...(await summarizeBaselineComparison(options, result, findings)),
      ...(baselineRecorded === undefined ? {} : { baselineRecorded }),
    };
  } else {
    const deferredIds = new Set(
      result.deferredFindings.map((finding) => finding.id),
    );
    const open = [...findings, ...result.deferredFindings].filter(
      (finding) => finding.status === "open" || finding.status === "approved",
    );
    const live = open
      .filter(
        (finding) => known === undefined || !known.has(finding.fingerprint),
      )
      .sort(
        (left, right) =>
          order[left.severity] - order[right.severity] ||
          left.state.localeCompare(right.state) ||
          left.id.localeCompare(right.id),
      );
    const base = options.cwd ?? process.cwd();
    const summaries = new Map(
      live.map((finding) => [
        finding.id,
        {
          ...(deferredIds.has(finding.id) ? { deferred: true } : {}),
          ...summarizeFinding(finding, result, base),
        },
      ]),
    );
    const { groups, issues } = projectIssueSummary({
      findings: live,
      groups: result.groups,
      summaries,
      deferredIds,
      primaryActionSelectors: result.primaryActionSelectors,
      rankingContext: result.issueRankingContext,
    });
    summary = {
      flow: options.flow,
      ...(result.build === undefined ? {} : { build: result.build }),
      runDirectory: result.runDirectory,
      reportPath: result.reportPath,
      findings: live.map(
        (finding) => summaries.get(finding.id) as SummaryFinding,
      ),
      groups,
      issues,
      blocking: live.filter(
        (finding) => finding.severity !== "minor" && finding.basis !== "judged",
      ).length,
      ...(known === undefined
        ? {}
        : { preExisting: open.length - live.length }),
    };
  }
  if (baselineNotApplied !== undefined)
    summary.baselineNotApplied = baselineNotApplied;
  if (result.designSystemQuestions.length > 0)
    summary.designSystemQuestions = result.designSystemQuestions.map(
      (decision) => ({
        id: decision.id,
        question: decision.question,
        count: decision.scaleCluster?.count ?? 0,
        suggestedToken: decision.scaleCluster?.suggestedToken ?? "",
      }),
    );
  if (result.advisory !== undefined) {
    const base = options.cwd ?? process.cwd();
    summary.advisory = {
      path: displayPath(base, result.advisory.path),
      outcome: result.advisory.review.outcome,
      patterns: result.advisory.review.patterns.map((pattern) => ({
        id: pattern.id,
        status: pattern.status,
        ...(pattern.reason === undefined ? {} : { reason: pattern.reason }),
        findings: pattern.findings.map(({ aspect, section, finding }) => {
          const evidence =
            finding.evidence.screenshots.find((path) =>
              path.includes("/crops/"),
            ) ?? finding.evidence.screenshots[0];
          return {
            id: finding.id,
            aspect,
            severity: finding.severity,
            where: `${finding.state}/${finding.viewport}${finding.colorScheme === undefined ? "" : `/${finding.colorScheme}`}`,
            section,
            problem: finding.explanation,
            basis: finding.basis,
            basisDetails: finding.basisDetails,
            acceptance: finding.acceptance,
            fix: acceptanceText(finding),
            ...(evidence === undefined
              ? {}
              : {
                  evidence: displayPath(
                    base,
                    `${result.runDirectory}/${evidence}`,
                  ),
                }),
          };
        }),
      })),
    };
  }
  summary.scope = result.scope;
  summary.timings = result.timings;
  summary.coverage = result.reportCoverage;
  if (result.checkCoverage !== undefined)
    summary.checkCoverage = result.checkCoverage;
  if (emitTickets !== undefined) {
    const actionable = new Set(
      summary.findings
        .filter(
          (finding) =>
            finding.deferred !== true && finding.occurrenceOnly !== true,
        )
        .map((finding) => finding.id),
    );
    const records = findings
      .filter((finding) => actionable.has(finding.id))
      .map((finding) => ({
        finding,
        runId: basename(result.runDirectory),
        runDirectory: result.runDirectory,
        findingsPath: result.findingsPath,
      }));
    const rootCauses = new Map<string, ClusterCause>();
    for (const issue of summary.issues ?? []) {
      const cause = issue.rootCause;
      if (cause === undefined) continue;
      const { symptoms, counts: _counts, ...rest } = cause;
      for (const symptom of symptoms)
        for (const finding of symptom.findings)
          rootCauses.set(finding.id, { ...rest, symptoms: symptoms.length });
    }
    const recordIds = new Set(records.map((record) => record.finding.id));
    const issueScores = new Map<string, number>();
    const groupsById = new Map(
      (summary.groups ?? []).map((group) => [group.id, group]),
    );
    for (const issue of summary.issues ?? [])
      for (const groupId of issue.groups)
        for (const member of groupsById.get(groupId)?.members ?? []) {
          if (!recordIds.has(member.id)) continue;
          issueScores.set(
            member.id,
            Math.max(issueScores.get(member.id) ?? -Infinity, issue.score),
          );
        }
    summary.tickets = await emitClusterTickets({
      project: options.project,
      cwd: options.cwd,
      out: emitTickets,
      rootCauses,
      issueScores,
      selection: { policy: "current-run", records },
    });
  }
  options.dependencies?.capture?.signal?.throwIfAborted();
  await completeCheckRecording(
    recording,
    result.reportCoverage,
    options.dependencies?.capture?.signal,
  );
  return { summary, review: result };
}

export function renderCheckSummary(
  summary: CheckSummary,
  options: {
    ungrouped?: boolean | undefined;
    top?: number | undefined;
    all?: boolean | undefined;
  } = {},
): string {
  const output = withDesignSystemQuestions(
    withAdvisory(
      summary.groups !== undefined &&
        summary.baseline === undefined &&
        options.ungrouped !== true
        ? summary.preExisting !== undefined
          ? renderCheckGroups(summary, summary.groups)
          : renderCheckIssues(
              summary,
              summary.groups,
              summary.issues ?? collapseIssues(summary.groups, new Set()),
              options,
            )
        : renderCheckFindings(summary),
      summary.advisory,
    ),
    summary.designSystemQuestions,
  );
  const notice =
    summary.baselineRecorded === undefined
      ? ""
      : `Automatically recorded baseline at ${summary.baselineRecorded.commit.slice(0, 12)} → ${summary.baselineRecorded.path}. Commit this file${summary.baselineRecorded.pixelCount > 0 ? ` and ${summary.baselineRecorded.pixelDirectory}` : ""}. Use idiom baseline accept ${summary.flow} after intentional changes.\n`;
  const covered = withStateCoverage(output, summary.coverage?.stateCoverage);
  return (
    notice +
    (summary.tickets === undefined
      ? covered
      : `${covered}${renderClusterTicketsResult(summary.tickets)}\n`)
  );
}

/**
 * The state coverage line goes just before the trailing `Full report:` line,
 * or last, so the parsed output forms keep their places.
 */
function withStateCoverage(
  output: string,
  coverage: FlowStateCoverage | undefined,
): string {
  if (coverage === undefined) return output;
  const line = stateCoverageLine(coverage);
  const lines = output.replace(/\n$/, "").split("\n");
  const last = lines.at(-1) ?? "";
  if (last.startsWith("Full report: "))
    return `${[...lines.slice(0, -1), line, last].join("\n")}\n`;
  return `${[...lines, line].join("\n")}\n`;
}

/**
 * One group for every repeated off-scale value held as a question, before
 * the trailing `Full report:` line. Its occurrences are not findings, so
 * they never enter the top issues.
 */
function withDesignSystemQuestions(
  output: string,
  questions: CheckDesignSystemQuestion[] | undefined,
): string {
  if (questions === undefined || questions.length === 0) return output;
  const block = [
    `Design system questions (${questions.length}):`,
    ...questions.map(
      (question) =>
        `  ${question.id} — ${question.question} (${question.count} occurrences). Answer: idiom ruling --decision ${question.id} --add-step [--token ${question.suggestedToken}] | --drift`,
    ),
    "",
  ];
  const lines = output.replace(/\n$/, "").split("\n");
  const last = lines.at(-1) ?? "";
  if (last.startsWith("Full report: "))
    return `${[...lines.slice(0, -1), ...block, last].join("\n")}\n`;
  return `${[...lines, "", ...block].join("\n").trimEnd()}\n`;
}

/**
 * Insert the advisory block before the trailing `Full report:` line, or after
 * a clean result, so the parsed output forms keep their places.
 */
function withAdvisory(
  output: string,
  advisory: CheckAdvisory | undefined,
): string {
  if (advisory === undefined) return output;
  const count = advisory.patterns.reduce(
    (total, pattern) => total + pattern.findings.length,
    0,
  );
  const block = [
    `Advisory design review (does not affect the exit code): ${count} finding(s) across ${advisory.patterns.length} pattern(s).`,
    ...(advisory.outcome.kind === "degraded"
      ? [`Incomplete: ${advisory.outcome.reason}`]
      : []),
    "",
  ];
  let index = 1;
  for (const pattern of advisory.patterns) {
    if (pattern.status !== "ok")
      block.push(
        `${pattern.id}: ${pattern.status}${pattern.reason === undefined ? "" : ` (${pattern.reason})`}`,
        "",
      );
    for (const finding of pattern.findings) {
      block.push(
        `A${index}. [advisory · ${finding.aspect}] ${pattern.id} — ${finding.section} (${finding.severity}, ${finding.where})`,
        `   Basis: ${basisDescription(finding)}`,
        `   Problem: ${finding.problem}`,
        ...finding.fix.map((line) => `   Done when: ${line}`),
        ...(finding.evidence === undefined
          ? []
          : [`   Evidence: ${finding.evidence}`]),
        "",
      );
      index += 1;
    }
  }
  const lines = output.replace(/\n$/, "").split("\n");
  const last = lines.at(-1) ?? "";
  if (last.startsWith("Full report: "))
    return `${[...lines.slice(0, -1), ...block, last].join("\n")}\n`;
  return `${[...lines, "", ...block].join("\n").trimEnd()}\n`;
}

function renderCheckFindings(summary: CheckSummary): string {
  const buildNote =
    summary.build === undefined
      ? ""
      : `Production build: ${summary.build.id}\n`;
  if (summary.baseline !== undefined) {
    const comparison = {
      ...summary,
      baseline: summary.baseline,
      fixed: summary.fixed ?? [],
      preExisting: summary.preExisting ?? 0,
      preExistingFindings: summary.preExistingFindings ?? [],
    };
    const header =
      summary.findings.length === 0
        ? `idiom check ${summary.flow}: clean — no new deterministic findings (${comparison.fixed.length} fixed, ${comparison.preExisting} pre-existing).`
        : `idiom check ${summary.flow}: ${summary.findings.length} new finding(s).`;
    return `${buildNote}${header}\n${renderBaselineComparison(comparison)}\nFull report: ${summary.reportPath}\n`;
  }
  const baselineNote =
    summary.preExisting === undefined
      ? ""
      : ` (${summary.preExisting} pre-existing finding(s) in the baseline not shown)`;
  if (summary.findings.length === 0)
    return `${buildNote}idiom check ${summary.flow}: clean — no ${summary.preExisting === undefined ? "open" : "new"} deterministic findings${baselineNote}.\n`;
  const lines = [
    `${buildNote}idiom check ${summary.flow}: ${summary.findings.length} ${summary.preExisting === undefined ? "open" : "new"} finding(s), ${summary.blocking} blocking (blocker/major)${baselineNote}. Fix in this order:`,
    "",
  ];
  for (const [index, finding] of summary.findings.entries()) {
    lines.push(
      `${index + 1}. [${finding.severity}] ${finding.category} — ${finding.where}${finding.selector === undefined ? "" : ` — ${finding.selector}`}`,
      `   Basis: ${basisDescription(finding)}`,
      `   Problem: ${finding.problem}`,
      ...finding.fix.map((line) => `   Done when: ${line}`),
      ...(finding.screenshot === undefined
        ? []
        : [`   Evidence: ${finding.screenshot}`]),
      ...(finding.deferred === true
        ? []
        : [
            `   Decide: idiom decide --finding ${finding.id} --accept|--reject --reason "…"`,
          ]),
      "",
    );
  }
  lines.push(`Full report: ${summary.reportPath}`);
  return `${lines.join("\n")}\n`;
}

function renderCheckGroups(
  summary: CheckSummary,
  groups: CheckGroup[],
): string {
  const buildNote =
    summary.build === undefined
      ? ""
      : `Production build: ${summary.build.id}\n`;
  const baselineNote =
    summary.preExisting === undefined
      ? ""
      : ` (${summary.preExisting} pre-existing finding(s) in the baseline not shown)`;
  if (groups.length === 0)
    return `${buildNote}idiom check ${summary.flow}: clean — no ${summary.preExisting === undefined ? "open" : "new"} deterministic findings${baselineNote}.\n`;
  const lines = [
    `${buildNote}idiom check ${summary.flow}: ${summary.findings.length} ${summary.preExisting === undefined ? "open" : "new"} finding(s) in ${groups.length} group(s), ${summary.blocking} blocking (blocker/major)${baselineNote}. Fix in this order:`,
    "",
  ];
  for (const [index, group] of groups.entries()) {
    lines.push(...renderGroupItem(group, index));
  }
  lines.push(`Full report: ${summary.reportPath}`);
  return `${lines.join("\n")}\n`;
}

function renderGroupItem(
  group: CheckGroup,
  index: number,
  extra: string[] = [],
): string[] {
  const repeated = isRepeated(group);
  const decidable = group.members.filter((member) => member.deferred !== true);
  return [
    `${index + 1}. [${group.severity}] ${group.category} — ${group.where}${group.selector === undefined ? "" : ` — ${group.selector}`}`,
    ...extra,
    `   Basis: ${basisDescription(group)}`,
    `   Problem: ${group.problem}`,
    ...group.fix.map((line) => `   Done when: ${line}`),
    ...(repeated
      ? [
          `   Seen: ${describeSpread(group)}`,
          `   Members: ${group.members.map((member) => member.id).join(", ")}`,
        ]
      : []),
    ...(group.screenshot === undefined
      ? []
      : [`   Evidence: ${group.screenshot}`]),
    ...(group.deferred === true
      ? []
      : group.members.length > 1
        ? [
            `   Decide: idiom decide --group ${group.id} --accept|--reject --reason "…"`,
          ]
        : [
            `   Decide: idiom decide --finding ${decidable[0]?.id} --accept|--reject --reason "…"`,
          ]),
    "",
  ];
}

function renderCheckIssues(
  summary: CheckSummary,
  groups: CheckGroup[],
  issues: CheckIssue[],
  options: { top?: number | undefined; all?: boolean | undefined },
): string {
  if (groups.length === 0) return renderCheckGroups(summary, groups);
  const top = Math.min(options.top ?? 5, issues.length);
  const byId = new Map(groups.map((group) => [group.id, group]));
  const buildNote =
    summary.build === undefined
      ? ""
      : `Production build: ${summary.build.id}\n`;
  const lines = [
    `${buildNote}idiom check ${summary.flow}: ${summary.findings.length} open finding(s) in ${groups.length} group(s) and ${issues.length} issue(s), ${summary.blocking} blocking (blocker/major).`,
    "",
    `Top issues (${top} of ${issues.length}), fix these first:`,
    "",
  ];
  const renderRootCause = (
    issue: CheckIssue,
    cause: NonNullable<CheckIssue["rootCause"]>,
    index: number,
  ) => {
    lines.push(
      `${index + 1}. [${issue.severity}] root cause — ${cause.cause}`,
      `   Confidence: ${cause.confidence} (${cause.kind} ${cause.key.replaceAll("\0", " ")})`,
      `   Evidence: ${cause.evidence.join("; ")}`,
      ...(cause.fix === undefined ? [] : [`   Suggested fix: ${cause.fix}`]),
      `   Symptoms (${cause.counts.symptoms}; ${cause.counts.findings} findings):`,
      ...cause.symptoms.map(
        (symptom) =>
          `   - ${symptom.category} ${symptom.rule ?? "unspecified"} — ${symptom.selector ?? "document"} — ${basisDescription(byId.get(symptom.group) ?? {})} — ${symptom.measurement} (${symptom.group})`,
      ),
      "   Done when: every symptom above clears on recheck.",
      `   Decide symptoms individually: idiom decide --group|--finding … (idiom check ${summary.flow} --all lists each)`,
      "",
    );
    if (options.all === true)
      for (const symptom of cause.symptoms) {
        const group = byId.get(symptom.group) as CheckGroup;
        const item = renderGroupItem(group, index);
        item.splice(1, 0, `   Rule: ${group.rule ?? "unspecified"}`);
        item[0] = `   Symptom: [${group.severity}] ${group.category} — ${group.selector ?? group.where} (${group.id})`;
        lines.push(...item);
      }
  };
  const renderIssue = (issue: CheckIssue, index: number) => {
    if (issue.rootCause !== undefined)
      return renderRootCause(issue, issue.rootCause, index);
    const example = byId.get(issue.id) as CheckGroup;
    const item = renderGroupItem(
      { ...example, severity: issue.severity },
      index,
      issue.elements > 1
        ? [
            `   ${issue.category} family: ${issue.elements} occurrences (${issue.findings} findings in ${issue.places} places); example below.`,
          ]
        : [],
    );
    item.splice(1, 0, `   Rules: ${issue.rules.join(", ") || "unspecified"}`);
    if (issue.rules.length > 1)
      item.splice(2, 0, `   Example rule: ${example.rule ?? "unspecified"}`);
    if (issue.elements > 1 && options.all !== true)
      item.splice(
        -1,
        0,
        `   Other groups: idiom check ${summary.flow} --all lists them.`,
      );
    lines.push(...item);
    // --all exposes each original occurrence and its own decision target.
    if (options.all === true)
      for (const id of issue.groups.slice(1)) {
        const group = byId.get(id) as CheckGroup;
        const sibling = renderGroupItem(group, index);
        sibling.splice(1, 0, `   Rule: ${group.rule ?? "unspecified"}`);
        sibling[0] = `   Occurrence: [${group.severity}] ${group.category} — ${group.selector ?? group.where} (${group.id})`;
        lines.push(...sibling);
      }
  };
  issues.slice(0, top).forEach(renderIssue);
  const rest = issues.slice(top);
  if (rest.length > 0) {
    lines.push(`Also found (${rest.length} more issue(s)):`);
    for (const count of categoryCounts(rest, byId))
      lines.push(
        `  ${count.category}: ${count.issues} issue(s), ${count.findings} finding(s)`,
      );
    if (options.all === true) {
      lines.push("");
      rest.forEach((issue, index) => {
        renderIssue(issue, top + index);
      });
    } else lines.push(`List everything: idiom check ${summary.flow} --all`, "");
  }
  lines.push(`Full report: ${summary.reportPath}`);
  return `${lines.join("\n")}\n`;
}
