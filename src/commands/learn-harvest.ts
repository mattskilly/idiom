import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { IdiomError } from "../errors.js";
import { findStateCapture } from "../learn/capture.js";
import { type DraftInterpretation, draftLearning } from "../learn/draft.js";
import {
  type HarvestResult,
  type HarvestSources,
  harvestCorrections,
  type SourceSummary,
} from "../learn/harvest.js";
import { sentences } from "../learn/harvest-classify.js";
import {
  type Exec,
  readEscalationAnswers,
  readPullRequestComments,
} from "../learn/harvest-sources.js";
import { interpretObservation } from "../learn/interpret.js";
import { compileLaw } from "../learn/law.js";
import { readLearnedLog } from "../learn/misses.js";
import { atomicWrite } from "../learn/write.js";
import { persistRulingNames } from "../rulings/names.js";
import type { LearnedEntry } from "../schemas/learned.js";
import { validateProject } from "../validation.js";
import { defaultConfirmation, type LearnDependencies } from "./learn.js";
import { markLearnedCovered } from "./learn-misses.js";

export type HarvestDependencies = {
  /** Runs `ab` and `gh`; defaults to the real executables. */
  exec?: Exec | undefined;
  /** The environment the tools see; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv | undefined;
  /** Replaces both readers (tests). */
  sources?: HarvestSources | undefined;
};

/** `idiom learn --harvest`. */
export async function learnHarvestCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow?: string | undefined;
  since?: string | undefined;
  dryRun?: boolean | undefined;
  dependencies?: LearnDependencies | undefined;
}): Promise<HarvestResult> {
  let since: string | undefined;
  if (options.since !== undefined) {
    const parsed = Date.parse(options.since);
    if (Number.isNaN(parsed))
      throw new IdiomError(
        `--since ${JSON.stringify(options.since)} is not a date; pass an ISO date or date-time`,
      );
    since = new Date(parsed).toISOString();
  }
  const { projectDirectory, flows } = await validateProject(options);
  if (
    options.flow !== undefined &&
    !flows.some((record) => record.flow.id === options.flow)
  )
    throw new IdiomError(`no flow ${JSON.stringify(options.flow)}`);
  const harvest = options.dependencies?.harvest;
  const environment = harvest?.environment ?? process.env;
  const reader = {
    root: projectDirectory,
    environment,
    exec: harvest?.exec,
  };
  const sources: HarvestSources = harvest?.sources ?? {
    autobuild: (cursor) =>
      readEscalationAnswers({ ...reader, since: cursor.since }),
    pullRequests: (cursor) =>
      readPullRequestComments({
        ...reader,
        since: cursor.since,
        sinceRepo: cursor.repo,
      }),
  };
  return harvestCorrections({
    projectDirectory,
    flows,
    flowId: options.flow,
    since,
    dryRun: options.dryRun,
    sources,
    clock: options.dependencies?.clock,
  });
}

const day = (at: string) => at.slice(0, 10);

/** `from <build> <escalation> (date)` or `from PR #n review comment (date)`. */
export function harvestedSource(entry: LearnedEntry): string {
  const harvest = entry.harvest;
  if (harvest === undefined) return "";
  const what =
    harvest.source === "escalation"
      ? `${harvest.build ?? "autobuild"} ${harvest.escalation ?? ""}`.trimEnd()
      : `PR #${harvest.pr ?? "?"} ${
          harvest.source === "pr-review-comment"
            ? `review comment${harvest.path === undefined ? "" : ` on ${harvest.path}`}`
            : harvest.source === "pr-review"
              ? "review"
              : "comment"
        }`;
  return `from ${what} (${day(harvest.at)}${harvest.author === undefined ? "" : `, ${harvest.author}`})`;
}

function placementLabel(entry: LearnedEntry): string {
  const via = entry.placement?.via;
  return via === "proposed"
    ? `state proposed: ${entry.placement?.proposal ?? entry.target.file}`
    : `state matched, ${via ?? "state"}`;
}

function unread(label: string, summary: SourceSummary): string[] {
  return summary.status === "unavailable"
    ? [`${label}: not read — ${summary.reason}.`]
    : (summary.skipped ?? []).map(
        (skip) => `${label}: skipped ${skip}; read again next run.`,
      );
}

export function renderHarvest(result: HarvestResult): string {
  const { autobuild, pullRequests } = result.sources;
  const count = (summary: SourceSummary) =>
    summary.status === "read" ? summary.recorded : 0;
  const lines: string[] = [];
  const total = result.recorded.length;
  lines.push(
    `${result.dryRun ? "Would record" : "Harvested"} ${total} UI correction${total === 1 ? "" : "s"} (${count(autobuild)} escalation answer${count(autobuild) === 1 ? "" : "s"}, ${count(pullRequests)} PR comment${count(pullRequests) === 1 ? "" : "s"}); ignored ${result.ignored} non-UI, ${result.duplicates} already harvested.`,
  );
  for (const record of result.recorded) {
    const { entry } = record;
    lines.push(
      `${entry.id}  open  ${entry.flow}/${entry.state} (${placementLabel(entry)})  ${harvestedSource(entry)}`,
      `  ${JSON.stringify(entry.observation)}`,
    );
  }
  lines.push(
    ...unread("Autobuild answers", autobuild),
    ...unread("PR review comments", pullRequests),
  );
  if (total === 0) {
    const through = [
      result.previous?.autobuild?.through,
      result.previous?.pullRequests?.through,
    ]
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);
    lines.push(
      through === undefined
        ? "Nothing new to record."
        : `Nothing new since ${through}.`,
    );
    return lines.join("\n");
  }
  lines.push(
    "",
    `Rule candidates (${total}):`,
    ...result.recorded.map(({ entry }) =>
      entry.candidate === undefined
        ? `  ${entry.id}  (no candidate)`
        : `  ${entry.id}  ${entry.candidate.kind} (${entry.candidate.checkable})  ${entry.candidate.rule}`,
    ),
  );
  if (result.dryRun) lines.push("", "Dry run: no files changed.");
  else
    lines.push(
      "",
      `Confirm them in one pass: idiom learn --confirm ${result.recorded.map(({ entry }) => entry.id).join(" ")}`,
      "Commit .idiom/learned.jsonl, .idiom/harvest.json and .idiom/proposals/states/.",
    );
  return lines.join("\n");
}

export type ConfirmOutcome =
  | { id: string; status: "applied"; kind: string; by: string; paths: string[] }
  | { id: string; status: "declined" }
  | { id: string; status: "refused"; reason: string };

/** The interpretation the candidate came from, read again from the words. */
function candidateInterpretation(
  entry: LearnedEntry,
): DraftInterpretation | undefined {
  const kind = entry.candidate?.kind;
  if (kind === "ruling") return { kind: "ruling" };
  for (const sentence of [
    ...sentences(entry.observation).map((item) => item.text),
    entry.observation,
  ]) {
    const interpretation = interpretObservation(sentence);
    if (interpretation.kind === kind) return interpretation;
  }
  return undefined;
}

/**
 * `idiom learn --confirm [ids...]`: turn harvested rule candidates into
 * rules or configuration, one diff and prompt each, and mark each harvested
 * record covered by the learned record it became. No ids means every open
 * harvested record with a candidate. A candidate that cannot apply yet is
 * reported and the pass goes on.
 */
export async function learnConfirmCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  ids: string[];
  yes?: boolean | undefined;
  dependencies?: LearnDependencies | undefined;
  write?: ((message: string) => void) | undefined;
}): Promise<ConfirmOutcome[]> {
  const validated = await validateProject(options);
  const { projectDirectory, project, flows } = validated;
  const entries = await readLearnedLog(projectDirectory, { strict: true });
  const targets =
    options.ids.length > 0
      ? options.ids
      : entries
          .filter(
            (entry) =>
              entry.harvest !== undefined &&
              entry.covered === undefined &&
              entry.candidate !== undefined,
          )
          .map((entry) => entry.id);
  const outcomes: ConfirmOutcome[] = [];
  const clock = options.dependencies?.clock ?? (() => new Date());
  for (const id of targets) {
    const refuse = (reason: string) => {
      outcomes.push({ id, status: "refused", reason });
    };
    const entry = (
      await readLearnedLog(projectDirectory, { strict: true })
    ).find((candidate) => candidate.id === id);
    if (entry === undefined) {
      refuse("unknown learned id");
      continue;
    }
    if (entry.kind !== "observation" || entry.harvest === undefined) {
      refuse("not a harvested record (idiom learn --harvest)");
      continue;
    }
    if (entry.covered !== undefined) {
      refuse(`already covered by ${entry.covered.by}`);
      continue;
    }
    const candidate = entry.candidate;
    if (candidate === undefined) {
      refuse("has no rule candidate");
      continue;
    }
    const declared = flows.find(
      (record) =>
        record.flow.id === entry.flow &&
        record.flow.states.some((state) => state.id === entry.state),
    );
    const compiled =
      candidate.kind === "law" ? compileLaw(entry.observation) : undefined;
    const projectWide =
      candidate.kind === "ruling" ||
      candidate.kind === "glossary" ||
      (compiled !== undefined &&
        "law" in compiled &&
        (compiled.law.scope === undefined ||
          compiled.law.scope.selector !== undefined));
    if (declared === undefined && !projectWide) {
      refuse(
        `add the draft state in ${entry.placement?.proposal ?? entry.target.file} first`,
      );
      continue;
    }
    const interpretation = candidateInterpretation(entry);
    if (interpretation === undefined) {
      refuse(
        `cannot read the ${candidate.kind} candidate from the words again`,
      );
      continue;
    }
    try {
      const needsCapture =
        declared !== undefined &&
        (interpretation.kind === "component" ||
          interpretation.kind === "invariant" ||
          interpretation.kind === "mirrored" ||
          (interpretation.kind === "law" &&
            interpretation.law.scope !== undefined &&
            interpretation.law.scope.selector === undefined));
      const capture = needsCapture
        ? await findStateCapture({
            projectDirectory,
            flow: entry.flow,
            state: entry.state,
            viewports: [
              ...(declared.flow.viewports ?? []),
              ...project.viewports.map((viewport) => viewport.name),
            ],
            colorScheme: project.capture.colorScheme,
          })
        : undefined;
      const draft = await draftLearning({
        projectDirectory,
        project,
        flow: declared ?? flows.find((record) => record.flow.id === entry.flow),
        flowId: entry.flow,
        state: entry.state,
        ...(entry.placement === undefined
          ? {}
          : { placement: entry.placement }),
        observation: entry.observation,
        interpretation,
        capture,
        ...(candidate.kind === "ruling" ? { wording: candidate.rule } : {}),
        recordedAt: clock().toISOString(),
        launch: options.dependencies?.launch,
        gitTopology: options.dependencies?.gitTopology,
      });
      options.write?.(`${id}: ${candidate.rule}\n${draft.diff}`);
      const confirmed =
        options.yes === true ||
        (await (options.dependencies?.confirm ?? defaultConfirmation)(
          draft.diff,
        ));
      if (!confirmed) {
        outcomes.push({ id, status: "declined" });
        continue;
      }
      for (const copy of draft.copies) {
        await mkdir(dirname(copy.to), { recursive: true });
        await copyFile(copy.from, copy.to);
      }
      for (const write of draft.writes)
        await atomicWrite(write.path, write.after);
      if (draft.rulingNames !== undefined)
        await persistRulingNames(draft.rulingNames);
      await markLearnedCovered({
        projectDirectory,
        id,
        by: draft.id,
        at: draft.entry.recordedAt,
      });
      outcomes.push({
        id,
        status: "applied",
        kind: draft.kind,
        by: draft.id,
        paths: draft.writes.map((write) => write.displayPath),
      });
    } catch (error) {
      if (!(error instanceof IdiomError)) throw error;
      refuse(error.message);
    }
  }
  return outcomes;
}

export function renderConfirm(outcomes: ConfirmOutcome[]): string {
  if (outcomes.length === 0)
    return "No open harvested rule candidates to confirm.";
  const applied = outcomes.filter((outcome) => outcome.status === "applied");
  const lines = outcomes.map((outcome) =>
    outcome.status === "applied"
      ? `${outcome.id}  applied as ${outcome.by} (${outcome.kind}) — ${outcome.paths.join(", ")}`
      : outcome.status === "declined"
        ? `${outcome.id}  declined; no files changed`
        : `${outcome.id}  not applied — ${outcome.reason}`,
  );
  lines.push(
    applied.length === 0
      ? "Nothing applied."
      : `Applied ${applied.length} of ${outcomes.length}; commit the changed files.`,
  );
  return lines.join("\n");
}
