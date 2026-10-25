import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { resolveRunBaseline } from "../baseline/compare.js";
import { tupleCoordinateKey } from "../baseline/coordinate.js";
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
import { checksConfigFrom } from "../checks/registry.js";
import { IdiomError } from "../errors.js";
import { loadRunTuples, resolveStoredRun } from "../review/artifacts.js";
import {
  describeSpread,
  groupRepeatedFindings,
  isRepeated,
  memberCoordinates,
} from "../review/groups.js";
import {
  type CheckIssue,
  categoryCounts,
  collapseIssues,
} from "../review/issues.js";
import type { ReviewOutcome } from "../review/report.js";
import {
  type ReviewDependencies,
  type ReviewRunResult,
  runReview,
} from "../review/run.js";
import type { Finding } from "../schemas/finding.js";
import {
  type ClusterTicketsResult,
  emitClusterTickets,
  renderClusterTicketsResult,
} from "../tickets/emit.js";
import { validateProject } from "../validation.js";
import { deterministicFingerprintSet } from "../verify/evaluate.js";

/** One element failing one rule, wherever it repeats (#52). */
export type CheckGroup = {
  id: string;
  severity: Finding["severity"];
  category: Finding["category"];
  rule?: string | undefined;
  where: string;
  selector?: string | undefined;
  problem: string;
  fix: string[];
  screenshot?: string | undefined;
  /** Every member is past the review's attention cap. */
  deferred?: true | undefined;
  members: Array<{
    id: string;
    severity: Finding["severity"];
    where: string;
    deferred?: true | undefined;
    /** tupleCoordinateKey strings: state/viewport[/scheme][#combination]. */
    coordinates: string[];
  }>;
  coordinates: string[];
  states: string[];
  viewports: string[];
  colorSchemes: string[];
  combinations?: string[] | undefined;
};

export type CheckSummary = {
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
  baselineRecorded?: Awaited<ReturnType<typeof recordBaseline>>;
  blocking: number;
  /** With --baseline: findings already present there and left out. */
  preExisting?: number | undefined;
  /** With --advisory: the model's design-intent review; never gates. */
  advisory?: CheckAdvisory | undefined;
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
  return (await checkWithReview(options)).summary;
}

/** Internal rich seam for controllers; normal check output stays unchanged. */
export async function checkWithReview(
  options: CheckOptions & {
    materializeAllDeterministic?: boolean;
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
  const recordedMode = all !== true && baseline === undefined;
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
      bootstrap = { validated, flow, runDirectory: "", requireHead: true };
    }
  }
  const result = await runReview({
    ...reviewOptions,
    deterministicOnly: true,
    ...(advisory === true ? { advisory: true } : {}),
    ...(materializeAllDeterministic === true
      ? { materializeAllDeterministic: true }
      : {}),
    ...(recordedMode || materializeAllDeterministic === true
      ? { includeDeterministicOccurrences: true }
      : {}),
  });
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
        checksConfigFrom(validated.project.checks),
      );
    }
  }
  const findings = JSON.parse(
    await readFile(result.findingsPath, "utf8"),
  ) as Finding[];
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
    const groups = groupRepeatedFindings(
      live,
      memberCoordinates(result.groups),
      deferredIds,
    ).map((group): CheckGroup => {
      const representative = summaries.get(
        group.representative,
      ) as SummaryFinding;
      return {
        id: group.id,
        severity: group.severity,
        category: representative.category,
        ...(group.rule === undefined ? {} : { rule: group.rule }),
        where: representative.where,
        ...(representative.selector === undefined
          ? {}
          : { selector: representative.selector }),
        problem: representative.problem,
        fix: representative.fix,
        ...(representative.screenshot === undefined
          ? {}
          : { screenshot: representative.screenshot }),
        ...(group.members.every((member) => member.deferred === true)
          ? { deferred: true }
          : {}),
        members: group.members.map((member) => ({
          id: member.id,
          severity: member.severity,
          where: summaries.get(member.id)?.where ?? member.state,
          ...(member.deferred === true ? { deferred: true } : {}),
          coordinates: member.coordinates.map(tupleCoordinateKey),
        })),
        coordinates: group.coordinates.map(tupleCoordinateKey),
        states: group.states,
        viewports: group.viewports,
        colorSchemes: group.colorSchemes,
        ...(group.combinations === undefined
          ? {}
          : { combinations: group.combinations }),
      };
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
      issues: collapseIssues(
        groups,
        new Set(result.primaryActionSelectors ?? []),
      ),
      blocking: live.filter((finding) => finding.severity !== "minor").length,
      ...(known === undefined
        ? {}
        : { preExisting: open.length - live.length }),
    };
  }
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
            fix: finding.acceptance,
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
    summary.tickets = await emitClusterTickets({
      project: options.project,
      cwd: options.cwd,
      out: emitTickets,
      selection: { policy: "current-run", records },
    });
  }
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
  const output = withAdvisory(
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
  );
  const notice =
    summary.baselineRecorded === undefined
      ? ""
      : `Automatically recorded baseline at ${summary.baselineRecorded.commit.slice(0, 12)} → ${summary.baselineRecorded.path}. Commit this file${summary.baselineRecorded.pixelCount > 0 ? ` and ${summary.baselineRecorded.pixelDirectory}` : ""}. Use idiom baseline accept ${summary.flow} after intentional changes.\n`;
  return (
    notice +
    (summary.tickets === undefined
      ? output
      : `${output}${renderClusterTicketsResult(summary.tickets)}\n`)
  );
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
  const renderIssue = (issue: CheckIssue, index: number) => {
    const example = byId.get(issue.id) as CheckGroup;
    const item = renderGroupItem(
      example,
      index,
      issue.elements > 1
        ? [
            `   Repeated on ${issue.elements} similar elements (${issue.findings} findings in ${issue.places} places); example below.`,
          ]
        : [],
    );
    if (issue.elements > 1 && options.all !== true)
      item.splice(
        -1,
        0,
        `   Other groups: idiom check ${summary.flow} --all lists them.`,
      );
    lines.push(...item);
    // --all exposes every sibling's evidence and per-element decide command.
    if (options.all === true)
      for (const id of issue.groups.slice(1)) {
        const group = byId.get(id) as CheckGroup;
        const sibling = renderGroupItem(group, index);
        sibling[0] = `   Similar element: ${group.selector ?? group.where} (${group.id})`;
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
