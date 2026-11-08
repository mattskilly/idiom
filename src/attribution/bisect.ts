import { rm, rmdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { type GitRead, readGit } from "../changed/git.js";
import { projectChecksConfig } from "../checks/project-config.js";
import { captureCommand } from "../commands/capture.js";
import { IdiomError, RunFailure } from "../errors.js";
import { loadRunTuples } from "../review/artifacts.js";
import { findCatalogLineage, loadReviewCatalog } from "../review/catalog.js";
import { validateProject } from "../validation.js";
import { deterministicCandidateRecords } from "../verify/evaluate.js";
import {
  commitInfo,
  firstParentCommits,
  isAncestor,
  repositoryRoot,
  resolveCommit,
} from "./git.js";
import { lineageIntroduction } from "./lookup.js";
import type { IntroductionCause } from "./record.js";
import { DEFAULT_TICKET_PATTERN, ticketIds } from "./tickets.js";

export type BisectResult = {
  finding: string;
  flow: string;
  coordinate: string;
  range: { from: string; to: string; commits: number };
  probes: Array<{ commit: string; present: boolean }>;
  firstBad: IntroductionCause | null;
  verdict: "found" | "not-in-range";
};

export type BisectDependencies = {
  capture?: typeof captureCommand | undefined;
  git?: GitRead | undefined;
};

const short = (sha: string) => sha.slice(0, 7);

function refuse(headline: string, hint: string): RunFailure {
  return new RunFailure({
    stage: "preflight",
    cause: "bisect-refused",
    headline,
    hint,
  });
}

/**
 * `idiom bisect <finding>`: binary search over the first-parent commits of
 * the finding's recorded first-seen range. Each probe captures only the
 * finding's coordinate at one commit in a detached worktree (`--ref`), into
 * scratch output under `.idiom/cache/bisect`, and runs the invoking
 * checkout's deterministic checks in memory. The user's checkout, the review
 * catalog and the digest history are never touched.
 */
export async function bisectFinding(options: {
  finding: string;
  project?: string | undefined;
  cwd?: string | undefined;
  /** One progress line per probe, as it happens. */
  onLine?: ((line: string) => void) | undefined;
  dependencies?: BisectDependencies | undefined;
  now?: (() => Date) | undefined;
}): Promise<BisectResult> {
  const git = options.dependencies?.git ?? readGit;
  const capture = options.dependencies?.capture ?? captureCommand;
  const say = options.onLine ?? (() => undefined);
  const catalog = await loadReviewCatalog({
    project: options.project,
    cwd: options.cwd,
  });
  const lineage = findCatalogLineage(catalog, options.finding);
  const introduction = await lineageIntroduction(lineage);
  if (introduction === undefined)
    throw refuse(
      `no first-seen range recorded for ${lineage.id}`,
      `idiom check ${lineage.latest.finding.flow} records one when a finding is new against the previous complete run`,
    );
  const occurrence =
    lineage.occurrences.find(
      (candidate) => candidate.runId === introduction.runId,
    ) ?? lineage.latest;
  const flowId = occurrence.finding.flow;
  const validated = await validateProject({
    project: options.project,
    cwd: options.cwd,
    flow: flowId,
  });
  const flow = validated.flows[0]?.flow;
  if (flow === undefined) throw new IdiomError(`unknown flow ${flowId}`);
  const state = validated.projectDirectory;
  const repository = await repositoryRoot(state, git);
  const { range } = introduction;
  const missingHistory = (sha: string) =>
    refuse(
      `bisect needs local history for ${short(sha)}`,
      "fetch it and retry",
    );
  if (repository === undefined) throw missingHistory(range.from);
  const from = await resolveCommit(repository, range.from, git);
  if (from === undefined) throw missingHistory(range.from);
  const to = await resolveCommit(repository, range.to, git);
  if (to === undefined) throw missingHistory(range.to);
  if (
    !range.linear ||
    (from !== to && !(await isAncestor(repository, from, to, git)))
  )
    throw refuse(
      "the recorded range is not linear",
      `bisect needs ${short(from)} to be an ancestor of ${short(to)}`,
    );
  const commits =
    from === to ? [] : await firstParentCommits(repository, from, to, git);
  if (commits.length === 0)
    throw refuse(
      "no commits between the runs",
      "the finding came from uncommitted or configuration changes; inspect the working tree or the checks configuration",
    );
  const configPath = join(
    relative(repository, state),
    ".idiom",
    "project.json",
  ).replaceAll("\\", "/");
  try {
    await git(repository, ["cat-file", "-e", `${to}:${configPath}`]);
  } catch {
    throw refuse(
      `bisect needs --ref worktree capture: no committed ${configPath} at ${short(to)}`,
      "commit the project configuration, then run idiom check again to record a new range",
    );
  }
  const where = introduction.where;
  const fingerprints = new Set(lineage.fingerprints);
  const checksConfig = await projectChecksConfig(validated);
  const scheme = occurrence.finding.colorScheme;
  const stamp = (options.now?.() ?? new Date())
    .toISOString()
    .replaceAll(/[:.]/g, "-");
  const scratch = join(state, ".idiom", "cache", "bisect", stamp);
  const probes: BisectResult["probes"] = [];
  const total = Math.ceil(Math.log2(commits.length + 1));
  let lo = -1;
  let hi = commits.length - 1;
  const bounds = () =>
    `known absent at ${short(lo < 0 ? from : (commits[lo] as string))}, present at ${short(commits[hi] as string)}`;
  const probe = async (commit: string): Promise<boolean> => {
    say(
      `bisect ${lineage.id}: probing ${short(commit)} (${probes.length + 1} of ~${Math.max(total, probes.length + 1)})`,
    );
    const out = join(scratch, short(commit));
    try {
      const captured = await capture({
        flow: flowId,
        ref: commit,
        project: state,
        out,
        scope: {
          states: occurrence.finding.state,
          viewports: occurrence.finding.viewport,
          ...(scheme === undefined ? {} : { schemes: scheme }),
        },
      });
      const loaded = await loadRunTuples(
        validated,
        flow,
        captured.runDirectory,
      );
      const failed = loaded.tuples.find(
        (tuple) =>
          tuple.state === occurrence.finding.state &&
          tuple.viewport === occurrence.finding.viewport &&
          tuple.failure !== undefined,
      );
      if (failed?.failure !== undefined)
        throw new IdiomError(
          `${failed.failure.stage}: ${failed.failure.message.split("\n")[0]}`,
        );
      const present = deterministicCandidateRecords({
        tuples: loaded.tuples,
        legacyColorScheme: validated.project.capture.colorScheme,
        expectedTupleKeys: loaded.expectedTupleKeys,
        config: checksConfig,
      }).some(
        (record) =>
          record.key === where &&
          [record.fingerprint, ...record.aliases].some((fingerprint) =>
            fingerprints.has(fingerprint),
          ),
      );
      probes.push({ commit, present });
      say(`  ${present ? "present" : "absent"}`);
      return present;
    } catch (error) {
      throw new IdiomError(
        `bisect probe at ${short(commit)} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}; ${bounds()}`,
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  };
  const result = (
    firstBad: IntroductionCause | null,
    verdict: BisectResult["verdict"],
  ): BisectResult => ({
    finding: lineage.id,
    flow: flowId,
    coordinate: where,
    range: { from, to, commits: commits.length },
    probes,
    firstBad,
    verdict,
  });
  try {
    if (range.toDirty && !(await probe(to))) {
      say(
        `${lineage.id} is absent at every commit; it came from uncommitted changes in the recorded run`,
      );
      return result(null, "not-in-range");
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await probe(commits[mid] as string)) hi = mid;
      else lo = mid;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
    // Only when empty: a concurrent bisect keeps its own scratch.
    await rmdir(join(state, ".idiom", "cache", "bisect")).catch(
      () => undefined,
    );
  }
  const info = await commitInfo(repository, commits[hi] as string, git);
  const firstBad = {
    commit: info.commit,
    subject: info.shownSubject,
    tickets: ticketIds(
      `${info.subject}\n${info.body}`,
      validated.project.attribution?.ticketPattern ?? DEFAULT_TICKET_PATTERN,
    ),
  };
  say(
    `first appears at ${short(firstBad.commit)} "${firstBad.subject}"${firstBad.tickets.length === 0 ? "" : ` (${firstBad.tickets.join(", ")})`}`,
  );
  say(
    `range ${short(from)}..${short(to)}, ${commits.length} commit${commits.length === 1 ? "" : "s"}, ${probes.length} probe${probes.length === 1 ? "" : "s"}`,
  );
  return result(firstBad, "found");
}
