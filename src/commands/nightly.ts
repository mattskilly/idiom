import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { type DigestFlow, digestFlows } from "../digest/build.js";
import { renderDigest } from "../digest/render.js";
import { IdiomError, RunFailure, type RunFailureJson } from "../errors.js";
import { autobuildTracker } from "../nightly/autobuild.js";
import {
  fileNightly,
  type NightlyFilingResult,
  type NightlyOutcome,
  type NightlySeverity,
  type NightlySink,
} from "../nightly/file.js";
import { ledgerPath } from "../nightly/ledger.js";
import type { ReviewDependencies } from "../review/run.js";
import { findingSchema } from "../schemas/finding.js";
import { findAutobuildRoot } from "../tickets/target.js";
import { validateProject } from "../validation.js";
import { executableOnPath } from "../wiring/detect.js";
import {
  type ClusterInputs,
  checkWithReview,
  clusterInputsFromCheck,
} from "./check.js";

export const NIGHTLY_DEFAULT_SEVERITY: NightlySeverity = "major";
export const NIGHTLY_DEFAULT_LABELS = ["idiom"] as const;
export const NIGHTLY_DEFAULT_OUT = ".idiom/reports/nightly";

export type NightlyTracker = "auto" | "autobuild" | "directory";

export type NightlyOptions = {
  flows?: string[] | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  severity?: NightlySeverity | undefined;
  labels?: string[] | undefined;
  tracker?: NightlyTracker | undefined;
  out?: string | undefined;
  dryRun?: boolean | undefined;
  probeBudgetMs?: number | undefined;
  isolatedRegistry?: boolean | undefined;
  dependencies?:
    | (ReviewDependencies & {
        /** The per-flow check; tests inject one over stored captures. */
        check?: typeof checkWithReview | undefined;
        now?: (() => Date) | undefined;
      })
    | undefined;
};

export type NightlyFlowResult = {
  flow: string;
  status: "checked" | "failed";
  /** New findings since the baseline, before the severity filter. */
  newFindings: number;
  /** Host busy: some coordinates were not reviewed. */
  deferred?: boolean | undefined;
  error?: RunFailureJson | undefined;
};

export type NightlyResult = {
  flows: NightlyFlowResult[];
  sink: NightlySink["kind"];
  severity: NightlySeverity;
  labels: string[];
  triageState?: string | undefined;
  outDirectory?: string | undefined;
  ledgerPath: string;
  dryRun: boolean;
  belowSeverity: number;
  outcomes: NightlyOutcome[];
  digest: DigestFlow[];
};

/**
 * `idiom nightly`: check every flow against its baseline and file each new
 * finding cluster at or above the severity as a triage ticket, or update the
 * one already filed. Tools propose, humans promote: nothing leaves triage.
 */
export async function nightlyCommand(
  options: NightlyOptions,
): Promise<NightlyResult> {
  const validated = await validateProject({
    project: options.project,
    cwd: options.cwd,
  });
  const { projectDirectory } = validated;
  const ids = new Set<string>();
  for (const { file, flow } of validated.flows) {
    if (basename(file, ".json") !== flow.id || ids.has(flow.id))
      throw new IdiomError(
        `${file}: filename must match its unique manifest id ${JSON.stringify(flow.id)}`,
      );
    ids.add(flow.id);
  }
  const requested = options.flows ?? [];
  for (const flow of requested)
    if (!ids.has(flow))
      throw new IdiomError(
        `unknown flow ${JSON.stringify(flow)}; flows: ${[...ids].sort().join(", ")}`,
      );
  const flows =
    requested.length === 0 ? [...ids].sort() : [...new Set(requested)];
  if (flows.length === 0)
    throw new IdiomError("no flows to check; add one under .idiom/flows/");
  const config = validated.project.nightly;
  const severity =
    options.severity ?? config?.severity ?? NIGHTLY_DEFAULT_SEVERITY;
  const labels = [
    ...new Set(
      options.labels !== undefined && options.labels.length > 0
        ? options.labels
        : (config?.labels ?? NIGHTLY_DEFAULT_LABELS),
    ),
  ];
  for (const label of labels)
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(label))
      throw new IdiomError(
        `invalid label ${JSON.stringify(label)}: start with a letter or digit and use only letters, digits, :, ., _ or -`,
      );
  const outDirectory =
    options.out !== undefined
      ? resolve(options.cwd ?? process.cwd(), options.out)
      : resolve(projectDirectory, config?.out ?? NIGHTLY_DEFAULT_OUT);
  // Every refusal happens here, before any capture.
  const sink = await resolveSink({
    tracker: options.tracker ?? "auto",
    projectDirectory,
    outDirectory,
    environment: options.dependencies?.environment ?? process.env,
  });
  const check = options.dependencies?.check ?? checkWithReview;
  const results: NightlyFlowResult[] = [];
  const inputs: ClusterInputs[] = [];
  for (const flow of flows) {
    try {
      const { summary, review } = await check({
        flow,
        project: projectDirectory,
        cwd: options.cwd,
        sinceBaseline: true,
        probeBudgetMs: options.probeBudgetMs,
        isolatedRegistry: options.isolatedRegistry,
        recordAgentCheck: false,
        dependencies: options.dependencies,
      });
      const findings = findingSchema
        .array()
        .parse(JSON.parse(await readFile(review.findingsPath, "utf8")));
      inputs.push(clusterInputsFromCheck(summary, review, findings));
      results.push({
        flow,
        status: "checked",
        newFindings: summary.findings.length,
        ...(summary.verdict === "deferred" ? { deferred: true } : {}),
      });
    } catch (error) {
      // One flow that cannot run never stops the others from filing.
      if (!(error instanceof RunFailure)) throw error;
      results.push({
        flow,
        status: "failed",
        newFindings: 0,
        error: error.failureJson(),
      });
    }
  }
  const filed: NightlyFilingResult = await fileNightly({
    project: projectDirectory,
    cwd: options.cwd,
    isolatedRegistry: options.isolatedRegistry,
    ledgerPath: ledgerPath(validated.stateProjectDirectory ?? projectDirectory),
    inputs,
    severity,
    labels,
    sink: sink.sink,
    dryRun: options.dryRun,
    now: options.dependencies?.now,
  });
  const digest: DigestFlow[] = [];
  for (const result of results) {
    if (result.status !== "checked") continue;
    try {
      digest.push(
        ...(await digestFlows({
          project: projectDirectory,
          cwd: options.cwd,
          flow: result.flow,
        })),
      );
    } catch {
      // The digest is a summary; a flow without one still filed.
    }
  }
  return {
    flows: results,
    sink: sink.sink.kind,
    severity,
    labels,
    ...(sink.sink.kind === "autobuild"
      ? { triageState: sink.sink.triageState }
      : { outDirectory }),
    ledgerPath: filed.ledgerPath,
    dryRun: filed.dryRun,
    belowSeverity: filed.belowSeverity,
    outcomes: filed.outcomes,
    digest,
  };
}

async function resolveSink(options: {
  tracker: NightlyTracker;
  projectDirectory: string;
  outDirectory: string;
  environment: NodeJS.ProcessEnv;
}): Promise<{ sink: NightlySink }> {
  const directory = {
    sink: { kind: "directory", out: options.outDirectory },
  } as const;
  if (options.tracker === "directory") return directory;
  const root = await findAutobuildRoot(options.projectDirectory);
  const ab =
    root !== undefined &&
    (await executableOnPath("ab", { environment: options.environment }));
  if (root === undefined || !ab) {
    if (options.tracker === "auto") return directory;
    throw new IdiomError(
      root === undefined
        ? `--tracker autobuild needs an autobuild project (no autobuild.toml above ${options.projectDirectory}); use --tracker directory to write proposals to ${options.outDirectory}`
        : "--tracker autobuild needs the autobuild CLI (ab) on PATH; use --tracker directory to write proposals instead",
    );
  }
  const tracker = autobuildTracker({ root, environment: options.environment });
  const triageStates = await tracker.triageStates();
  const triageState = triageStates[0];
  if (triageState === undefined)
    throw new IdiomError(
      "no autobuild ticket state has the triage role (ab ticket states --json); nightly files only into triage, so it filed nothing. Give a state the triage role, or use --tracker directory",
    );
  return { sink: { kind: "autobuild", tracker, triageState, triageStates } };
}

const outcomeVerb: Record<NightlyOutcome["kind"], string> = {
  created: "filed",
  updated: "updated",
  unchanged: "unchanged",
  "in-progress": "left alone (in progress)",
  "reopened-as-new": "reappeared; filed",
  "refiled-missing": "ticket missing; refiled",
  conflict: "conflict",
  skipped: "skipped",
  error: "error",
};

function outcomeLine(outcome: NightlyOutcome, dryRun: boolean): string {
  const ids = outcome.findingIds.join(", ");
  const would = dryRun ? "would be " : "";
  switch (outcome.kind) {
    case "conflict":
      return `${ids}: conflict — matches ${(outcome.tickets ?? []).join(", ")}; filed nothing`;
    case "skipped":
      return `${ids}: skipped (${outcome.reason})`;
    case "error":
      return `${ids}: error — ${outcome.message}`;
    case "in-progress":
      return `${ids}: ${outcomeVerb[outcome.kind]} — ${outcome.ticket}${outcome.ticketState === undefined ? "" : ` in ${outcome.ticketState}`}`;
    default: {
      const where = [
        outcome.ticket,
        outcome.state === undefined ? undefined : `in ${outcome.state}`,
        outcome.replaced === undefined
          ? undefined
          : `replacing ${outcome.replaced}`,
      ]
        .filter((part) => part !== undefined)
        .join(" ");
      return `${ids}: ${would}${outcomeVerb[outcome.kind]}${where === "" ? "" : ` ${where}`} — ${JSON.stringify(outcome.title)} [${(outcome.labels ?? []).join(", ")}]`;
    }
  }
}

export function renderNightly(result: NightlyResult): string {
  const count = (kind: NightlyOutcome["kind"]) =>
    result.outcomes.filter((outcome) => outcome.kind === kind).length;
  const target =
    result.sink === "autobuild"
      ? `autobuild triage (${result.triageState})`
      : `proposals in ${result.outDirectory}`;
  return [
    ...result.flows.map((flow) =>
      flow.status === "failed"
        ? `${flow.flow}: not checked — ${flow.error?.message} (${flow.error?.cause})`
        : `${flow.flow}: ${flow.newFindings} new finding(s)${flow.deferred ? "; deferred (host busy), incomplete" : ""}`,
    ),
    `${result.dryRun ? "Dry run — " : ""}Filing at ${result.severity} and above to ${target}: ${count("created") + count("reopened-as-new") + count("refiled-missing")} filed, ${count("updated")} updated, ${count("unchanged")} unchanged, ${count("in-progress")} in progress, ${count("skipped")} skipped, ${count("conflict")} conflict(s), ${count("error")} error(s)${result.belowSeverity > 0 ? `; ${result.belowSeverity} below ${result.severity}` : ""}`,
    ...result.outcomes.map((outcome) => outcomeLine(outcome, result.dryRun)),
    ...(result.dryRun ? [] : [`Ledger: ${result.ledgerPath} (commit it)`]),
    ...(result.digest.length === 0 ? [] : ["", ...renderDigest(result.digest)]),
  ].join("\n");
}
