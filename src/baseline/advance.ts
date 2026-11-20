import { realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { resolveCaptureScope } from "../capture/scope.js";
import { defaultBranch, type GitRead, readGit } from "../changed/git.js";
import { IdiomError } from "../errors.js";
import type { ReviewDependencies } from "../review/run.js";
import { flowSchema } from "../schemas/flow.js";
import { projectSchema, resolveGateConfig } from "../schemas/project.js";
import { validateProject } from "../validation.js";
import {
  type BaseResolution,
  captureBaseRecord,
  composeBaseRecord,
  covers,
  missingScope,
  type PlannedTuple,
  resolveBaseComparison,
} from "./base.js";
import {
  baseCacheDirectory,
  baseCachePath,
  readBaseCache,
  writeBaseCacheRecord,
} from "./base-cache.js";
import { type LockOptions, withFileLock } from "./lock.js";
import { type GitAncestry, gitAncestry } from "./resolve.js";
import type { BaselineRecord } from "./schema.js";
import {
  baselineDirectory,
  baselinePath,
  readBaselineFile,
  writeBaselineRecord,
} from "./store.js";

export type AdvanceStatus =
  | "advanced"
  | "current"
  | "superseded"
  | "failed"
  | "absent";

export type FlowAdvance = {
  flow: string;
  status: AdvanceStatus;
  tupleCount?: number | undefined;
  findingCount?: number | undefined;
  /** Tuples captured at the target by this advance. */
  capturedTuples?: number | undefined;
  failedTuples?: string[] | undefined;
  /** The nearest stored record kept when the flow failed. */
  previous?: string | undefined;
  /** A stored record newer than the target. */
  supersededBy?: string | undefined;
  reason?: string | undefined;
  /** The committed baseline file, when written. */
  path?: string | undefined;
};

export type BaselineAdvanceResult = {
  target: string;
  commit: string;
  /** What --fetch did, when it was asked for. */
  fetched?: string | undefined;
  /** The project's base-cache directory. */
  cachePath: string;
  flows: FlowAdvance[];
};

export type AdvanceDependencies = {
  capture?: typeof captureBaseRecord | undefined;
  git?: GitRead | undefined;
  ancestry?: GitAncestry | undefined;
  review?: ReviewDependencies | undefined;
  lock?: Partial<LockOptions> | undefined;
};

export const DEFAULT_ADVANCE_WAIT_MS = 30 * 60 * 1000;
const ADVANCE_STALE_MS = 2 * 60 * 60 * 1000;

const short = (commit: string) => commit.slice(0, 12);

export const advanceFailed = (result: BaselineAdvanceResult): boolean =>
  result.flows.some((flow) => flow.status === "failed");

/**
 * Advance the gate's base to the target branch tip for every flow that needs
 * it. A flow a stored record already speaks for (the gate's own rule) is
 * current and captures nothing; otherwise only the missing tuples the target
 * declares are captured, and a record is written only when every one of them
 * succeeded. Runs hold one lock per project, and never overwrite a record
 * newer than the target.
 */
export async function advanceBaselines(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow?: string | undefined;
  target?: string | undefined;
  commitFile?: boolean | undefined;
  fetch?: boolean | undefined;
  prod?: boolean | undefined;
  waitMs?: number | undefined;
  dependencies?: AdvanceDependencies | undefined;
}): Promise<BaselineAdvanceResult> {
  const dependencies = options.dependencies ?? {};
  const git = dependencies.git ?? readGit;
  const ancestry = dependencies.ancestry ?? gitAncestry;
  const capture = dependencies.capture ?? captureBaseRecord;
  const validated = await validateProject({
    project: options.project,
    flow: options.flow,
    cwd: options.cwd,
  });
  const { projectDirectory } = validated;
  const stateDirectory = validated.stateProjectDirectory ?? projectDirectory;
  const repository = (
    await git(projectDirectory, ["rev-parse", "--show-toplevel"])
  ).trim();
  const prefix = relative(
    await realpath(repository),
    await realpath(projectDirectory),
  )
    .split(sep)
    .join("/");
  const inRepository = (path: string) => (prefix ? `${prefix}/${path}` : path);
  const cacheDirectory = await baseCacheDirectory(stateDirectory, git);
  const target = options.target ?? (await defaultBranch(repository, git));
  if (target === undefined)
    throw new IdiomError(
      "baseline advance found no target branch (no remote HEAD, main or master); pass --target <ref>",
    );
  return withFileLock(
    join(cacheDirectory, "advance.lock"),
    {
      waitMs: options.waitMs ?? DEFAULT_ADVANCE_WAIT_MS,
      staleMs: ADVANCE_STALE_MS,
      describe: `target ${target}`,
      holderLabel: "another baseline advance",
      ...dependencies.lock,
    },
    async () => {
      const fetched =
        options.fetch === true
          ? await fetchTarget(repository, target, git)
          : undefined;
      let commit: string;
      try {
        commit = (
          await git(repository, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${target}^{commit}`,
          ])
        ).trim();
      } catch {
        throw new IdiomError(
          `cannot resolve --target ${JSON.stringify(target)} to a local commit; fetch it and retry`,
        );
      }
      const at = async (path: string) =>
        git(repository, ["show", `${commit}:${inRepository(path)}`]);
      const exists = async (path: string) =>
        git(repository, ["cat-file", "-e", `${commit}:${inRepository(path)}`])
          .then(() => true)
          .catch(() => false);
      const nonUi = resolveGateConfig(validated.project).nonUi;
      const committedPath = (flow: string) =>
        baselinePath(
          baselineDirectory(stateDirectory, validated.project),
          flow,
        );

      /** A stored record strictly newer than the target, if any. */
      const newerRecord = async (flow: string): Promise<string | undefined> => {
        const records: BaselineRecord[] = [
          ...(await readBaseCache(
            await baseCachePath(stateDirectory, flow, git),
            flow,
          )),
          ...(options.commitFile === true
            ? ((await readBaselineFile(committedPath(flow)))?.records ?? [])
            : []),
        ];
        for (const record of records) {
          if (record.commit === commit) continue;
          if (
            (await ancestry
              .isAncestor(projectDirectory, commit, record.commit)
              .catch(() => undefined)) === true
          )
            return record.commit;
        }
        return undefined;
      };

      const flows: FlowAdvance[] = [];
      for (const { file, flow } of validated.flows) {
        const id = flow.id;
        const flowFile = `.idiom/flows/${basename(file)}`;
        try {
          if (!(await exists(flowFile))) {
            flows.push({
              flow: id,
              status: "absent",
              reason: `not on ${target} yet`,
            });
            continue;
          }
          // What the target declares, never the working tree: a build being
          // finalized may add states, viewports or schemes the target lacks.
          const targetTuples = await (async (): Promise<PlannedTuple[]> => {
            const read = async <T>(
              path: string,
              parse: (value: unknown) => T,
            ): Promise<T> => {
              try {
                return parse(JSON.parse(await at(path)));
              } catch (error) {
                throw new TargetConfigError(
                  `${path} at ${target} ${short(commit)} cannot be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
                );
              }
            };
            const targetProject = await read(".idiom/project.json", (value) =>
              projectSchema.parse(value),
            );
            const targetFlow = await read(flowFile, (value) =>
              flowSchema.parse(value),
            );
            let selected: ReturnType<typeof resolveCaptureScope>["selected"];
            try {
              selected = resolveCaptureScope({
                project: targetProject,
                flow: targetFlow,
                scope: {},
              }).selected;
            } catch (error) {
              throw new TargetConfigError(
                `${flowFile} at ${target} ${short(commit)} selects no tuples: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            return selected.map((tuple) => ({
              state: tuple.state.id,
              viewport: tuple.viewport.name,
              scheme: tuple.colorScheme,
            }));
          })();
          if (targetTuples.length === 0) {
            flows.push({
              flow: id,
              status: "absent",
              reason: `declares no tuples on ${target}`,
            });
            continue;
          }
          const supersededBy = await newerRecord(id);
          if (supersededBy !== undefined) {
            flows.push({ flow: id, status: "superseded", supersededBy });
            continue;
          }
          const resolution = await resolveBaseComparison({
            validated,
            flow: id,
            base: commit,
            tuples: targetTuples,
            nonUi,
            git,
            ancestry,
          });
          const onlyTarget = (record: BaselineRecord): BaselineRecord => ({
            ...record,
            tuples: record.tuples.filter((tuple) =>
              targetTuples.some((planned) => covers(tuple, planned)),
            ),
          });
          const summary = (record: BaselineRecord) => ({
            tupleCount: record.tuples.length,
            findingCount: record.tuples.reduce(
              (sum, tuple) => sum + tuple.findings.length,
              0,
            ),
          });
          if (resolution.missing.length === 0) {
            const fileCovered =
              options.commitFile !== true ||
              (
                await resolveBaseComparison({
                  validated,
                  flow: id,
                  base: commit,
                  tuples: targetTuples,
                  nonUi,
                  git,
                  ancestry,
                  sources: ["baseline"],
                })
              ).missing.length === 0;
            if (fileCovered) {
              flows.push({
                flow: id,
                status: "current",
                ...(resolution.covering[0] === undefined
                  ? {}
                  : {
                      reason: `covered by ${short(resolution.covering[0].record.commit)}`,
                    }),
              });
              continue;
            }
            // The base cache covers the target; only the file trails it.
            const record = onlyTarget(
              composeBaseRecord(
                commit,
                resolution.covering.map((candidate) => candidate.record),
              ),
            );
            const path = committedPath(id);
            await writeBaselineRecord(path, id, record);
            flows.push({
              flow: id,
              status: "advanced",
              ...summary(record),
              capturedTuples: 0,
              failedTuples: [],
              reason: "from the base cache",
              path,
            });
            continue;
          }
          const failed = (
            reason: string,
            failedTuples: string[] = [],
          ): FlowAdvance => ({
            flow: id,
            status: "failed",
            failedTuples,
            reason,
            ...previousOf(resolution),
          });
          let captured: Awaited<ReturnType<typeof captureBaseRecord>>;
          try {
            captured = await capture({
              base: commit,
              flow: id,
              project: options.project,
              cwd: options.cwd,
              scope: missingScope(resolution.missing),
              prod: options.prod,
              dependencies: dependencies.review,
            });
          } catch (error) {
            if ((error as { name?: unknown }).name === "AbortError")
              throw error;
            flows.push(
              failed(
                `capture failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
            continue;
          }
          if (captured.failedTupleKeys.length > 0) {
            flows.push(
              failed(
                `${captured.failedTupleKeys.length} tuple(s) failed: ${captured.failedTupleKeys.join(", ")}`,
                captured.failedTupleKeys,
              ),
            );
            continue;
          }
          const record = captured.record;
          const absent = resolution.missing.filter(
            (planned) =>
              !record?.tuples.some((tuple) => covers(tuple, planned)),
          );
          if (record === undefined || absent.length > 0) {
            const keys = (
              record === undefined ? resolution.missing : absent
            ).map(
              (tuple) => `${tuple.state}/${tuple.viewport}/${tuple.scheme}`,
            );
            flows.push(
              failed(
                `capture returned no record for declared tuples ${keys.join(", ")}`,
                keys,
              ),
            );
            continue;
          }
          const composed = onlyTarget(
            composeBaseRecord(commit, [
              record,
              ...resolution.covering.map((candidate) => candidate.record),
            ]),
          );
          const newer = await newerRecord(id);
          if (newer !== undefined) {
            flows.push({ flow: id, status: "superseded", supersededBy: newer });
            continue;
          }
          await writeBaseCacheRecord(
            await baseCachePath(stateDirectory, id, git),
            id,
            composed,
          );
          let path: string | undefined;
          if (options.commitFile === true) {
            path = committedPath(id);
            await writeBaselineRecord(path, id, composed);
          }
          flows.push({
            flow: id,
            status: "advanced",
            ...summary(composed),
            capturedTuples: record.tuples.length,
            failedTuples: [],
            ...(path === undefined ? {} : { path }),
          });
        } catch (error) {
          if (!(error instanceof TargetConfigError)) throw error;
          flows.push({
            flow: id,
            status: "failed",
            failedTuples: [],
            reason: error.message,
          });
        }
      }
      return {
        target,
        commit,
        ...(fetched === undefined ? {} : { fetched }),
        cachePath: cacheDirectory,
        flows,
      };
    },
  );
}

class TargetConfigError extends Error {}

function previousOf(resolution: BaseResolution): { previous?: string } {
  const previous = resolution.fallback?.record.commit;
  return previous === undefined ? {} : { previous };
}

/**
 * Fetch the target's remote branch, so a post-merge or finalize step advances
 * to what has actually landed. A local ref has nothing to fetch.
 */
export async function fetchTarget(
  repository: string,
  target: string,
  git: GitRead,
): Promise<string> {
  const remotes = (await git(repository, ["remote"]))
    .split("\n")
    .map((remote) => remote.trim())
    .filter(Boolean);
  const name = target.startsWith("refs/remotes/")
    ? target.slice("refs/remotes/".length)
    : target;
  const remote = remotes
    .filter((candidate) => name.startsWith(`${candidate}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (
    remote === undefined ||
    (!target.startsWith("refs/remotes/") && target.startsWith("refs/"))
  )
    return `not fetched: ${target} is not a remote-tracking branch`;
  const branch = name.slice(remote.length + 1);
  try {
    await git(repository, [
      "fetch",
      "--quiet",
      remote,
      `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
    ]);
  } catch (error) {
    throw new IdiomError(
      `baseline advance could not fetch ${remote}/${branch}: ${error instanceof Error ? error.message.trim() : String(error)}`,
    );
  }
  return `fetched ${remote}/${branch}`;
}
