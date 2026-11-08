import { resolve } from "node:path";
import { type GitRead, readGit } from "../changed/git.js";
import { selectChangedStates, stateKey } from "../changed/select.js";
import { classifyOccurrences } from "../digest/build.js";
import type { DigestRecord } from "../digest/record.js";
import type { Flow } from "../schemas/flow.js";
import {
  commitFiles,
  commitInfo,
  firstParentCommits,
  isAncestor,
  repositoryRoot,
  resolveCommit,
} from "./git.js";
import type {
  AttributionRecord,
  Introduction,
  IntroductionCause,
} from "./record.js";
import { ticketIds } from "./tickets.js";

/** Longer ranges record the range but not the commits touching each state. */
export const MAX_ATTRIBUTION_COMMITS = 200;

/**
 * Tie this run's new findings to the commit range they appeared in: the
 * previous complete run's commit to this run's. Within a linear range, the
 * first-parent commits whose files map to the finding's state (the same
 * mapping `check --changed` uses) are its candidates; exactly one is the
 * likely cause. Git failures inside the range become `candidatesOmitted`.
 */
export async function attributeIntroductions(options: {
  projectDirectory: string;
  flows: Flow[];
  current: DigestRecord;
  previous: DigestRecord | null;
  ticketPattern: string;
  git?: GitRead | undefined;
  select?: typeof selectChangedStates | undefined;
}): Promise<AttributionRecord> {
  const { current, previous } = options;
  const git = options.git ?? readGit;
  const select = options.select ?? selectChangedStates;
  const record: AttributionRecord = {
    version: 1,
    flow: current.flow,
    runId: current.runId,
    commit: current.commit,
    dirty: current.dirty,
    previous:
      previous === null
        ? null
        : {
            runId: previous.runId,
            commit: previous.commit,
            dirty: previous.dirty,
            completedAt: previous.completedAt,
          },
    configChanged:
      previous !== null && previous.configHash !== current.configHash,
    introductions: [],
  };
  if (previous === null) return record;
  const added = classifyOccurrences(current, previous).added.filter(
    (occurrence) =>
      occurrence.disposition === "open" && occurrence.coverageOnly !== true,
  );
  if (added.length === 0) return record;
  const repository = await repositoryRoot(options.projectDirectory, git);
  if (repository === undefined) return record;
  const [from, to] = await Promise.all([
    resolveCommit(repository, previous.commit, git),
    resolveCommit(repository, current.commit, git),
  ]);
  if (from === undefined || to === undefined) return record;
  const linear = from === to || (await isAncestor(repository, from, to, git));
  let commits: string[] | undefined;
  let omitted: string | undefined;
  try {
    commits = linear
      ? from === to
        ? []
        : await firstParentCommits(repository, from, to, git)
      : undefined;
  } catch (error) {
    omitted = gitReason(error);
  }
  const range = {
    from,
    to,
    commits: commits?.length ?? null,
    linear,
    fromDirty: previous.dirty,
    toDirty: current.dirty,
  };
  // Per commit: its cause and the states its files map to.
  let touched: Array<{ cause: IntroductionCause; states: Set<string> }> = [];
  if (omitted === undefined)
    omitted = !linear
      ? "not a linear range"
      : commits === undefined || commits.length === 0
        ? "no commits in range"
        : commits.length > MAX_ATTRIBUTION_COMMITS
          ? `range longer than ${MAX_ATTRIBUTION_COMMITS} commits`
          : undefined;
  if (omitted === undefined && commits !== undefined) {
    try {
      const details = [];
      for (const sha of commits) {
        const info = await commitInfo(repository, sha, git);
        details.push({
          info,
          files: await commitFiles(repository, info, git),
        });
      }
      const union = [...new Set(details.flatMap(({ files }) => files))].sort();
      const selection = await select(options.projectDirectory, options.flows, {
        repository,
        head: to,
        requestedBase: from,
        resolvedBase: from,
        baseReason: "first-seen range",
        files: union.map((path) => ({
          path,
          absolute: resolve(repository, path),
        })),
      });
      const statesByFile = new Map(
        selection.files.map((file) => [
          file.path,
          new Set(file.states.map(stateKey)),
        ]),
      );
      touched = details.map(({ info, files }) => ({
        cause: {
          commit: info.commit,
          subject: info.shownSubject,
          tickets: ticketIds(
            `${info.subject}\n${info.body}`,
            options.ticketPattern,
          ),
        },
        states: new Set(
          files.flatMap((file) => [...(statesByFile.get(file) ?? [])]),
        ),
      }));
    } catch (error) {
      omitted = gitReason(error);
    }
  }
  record.introductions = added.map((occurrence): Introduction => {
    const base = {
      id: occurrence.id,
      fingerprint: occurrence.fingerprint,
      where: occurrence.where,
      state: occurrence.state,
      range,
    };
    if (omitted !== undefined) return { ...base, candidatesOmitted: omitted };
    const key = stateKey({ flow: current.flow, state: occurrence.state });
    const candidates = touched
      .filter(({ states }) => states.has(key))
      .map(({ cause }) => cause);
    const [only] = candidates;
    return {
      ...base,
      candidates,
      ...(candidates.length === 1 && only !== undefined
        ? { likely: only }
        : {}),
    };
  });
  return record;
}

function gitReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `git: ${message.split("\n")[0] ?? message}`;
}
