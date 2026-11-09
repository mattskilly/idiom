import { relative, sep } from "node:path";
import type { ProbeRegion } from "../capture/probe.js";
import { withRefWorktree } from "../capture/ref-worktree.js";
import type { CaptureScope } from "../capture/scope.js";
import { type GitRead, readGit } from "../changed/git.js";
import { IdiomError } from "../errors.js";
import { classifyByPath } from "../gate/classify.js";
import { type ReviewDependencies, runReview } from "../review/run.js";
import type { ColorScheme } from "../schemas/project.js";
import type { ValidationResult } from "../validation.js";
import {
  baseCachePath,
  engineIdentity,
  readBaseCache,
  writeBaseCacheRecord,
} from "./base-cache.js";
import { checksConfigHash } from "./config-hash.js";
import { tupleCoordinateKey } from "./coordinate.js";
import { buildBaselineRecord } from "./record.js";
import { type GitAncestry, gitAncestry } from "./resolve.js";
import type { BaselineRecord, BaselineTuple } from "./schema.js";
import { baselineDirectory, baselinePath, readBaselineFile } from "./store.js";

/** One gate or changed-check tuple, before capture. */
export type PlannedTuple = {
  state: string;
  viewport: string;
  scheme: ColorScheme;
};

export type BaseRecordSource = "baseline" | "base-cache";

/** A stored record usable at the base, with where it came from. */
export type BaseCandidate = {
  record: BaselineRecord;
  source: BaseRecordSource;
  path: string;
  /** Commits from the record to the base. */
  behindBase: number;
};

/**
 * Where the comparison for one flow stands before any capture: the stored
 * records that already speak for the base, the planned tuples none covers,
 * and the nearest stored record reachable from the base (the fallback).
 */
export type BaseResolution = {
  base: string;
  covering: BaseCandidate[];
  missing: PlannedTuple[];
  fallback?: BaseCandidate | undefined;
  cachePath: string;
  notes: string[];
};

/** The record a check compares with, and how it was obtained. */
export type BaseComparison = {
  /** "fallback" compares with a stored baseline behind the base. */
  source: "baseline" | "base-cache" | "base-capture" | "fallback";
  base: string;
  record: BaselineRecord;
  path: string;
  /** The stored baseline the comparison leaned on, when not captured at base. */
  baselineCommit?: string | undefined;
  behindBase?: number | undefined;
  notes: string[];
};

/**
 * Tracked Idiom bookkeeping that never changes a render: a commit that only
 * records a baseline or a decision leaves the previous capture current.
 */
const bookkeeping =
  /(?:^|\/)\.idiom\/(?:baselines\/[^/]+\.json$|decisions\.jsonl$|finding-names\.json$|ruling-names\.json$)/;

export const covers = (
  tuple: Pick<BaselineTuple, "state" | "viewport" | "colorScheme">,
  planned: PlannedTuple,
) =>
  tuple.state === planned.state &&
  tuple.viewport === planned.viewport &&
  (tuple.colorScheme === undefined || tuple.colorScheme === planned.scheme);

const plannedKey = (tuple: PlannedTuple) =>
  `${tuple.state}/${tuple.viewport}/${tuple.scheme}`;

/**
 * Which stored records already judge the base for these tuples. A record
 * speaks for the base when it was captured there, or when nothing between it
 * and the base can change a render by the gate's own path pass (no import
 * graph: conservative). Records from either source must match the current
 * checks configuration to count; a stale one can still serve as fallback.
 */
export async function resolveBaseComparison(options: {
  validated: ValidationResult;
  flow: string;
  base: string;
  tuples: PlannedTuple[];
  nonUi: string[];
  git?: GitRead | undefined;
  ancestry?: GitAncestry | undefined;
}): Promise<BaseResolution> {
  const { validated, base } = options;
  const git = options.git ?? readGit;
  const ancestry = options.ancestry ?? gitAncestry;
  const projectDirectory = validated.projectDirectory;
  const stateDirectory =
    validated.stateProjectDirectory ?? validated.projectDirectory;
  const notes: string[] = [];
  const engine = engineIdentity();
  const currentHash = checksConfigHash(validated.project.checks);
  const committedPath = baselinePath(
    baselineDirectory(stateDirectory, validated.project),
    options.flow,
  );
  const committed = await readBaselineFile(committedPath).catch((error) => {
    notes.push(String(error instanceof Error ? error.message : error));
    return undefined;
  });
  const cachePath = await baseCachePath(stateDirectory, options.flow, git);
  const cached = (await readBaseCache(cachePath, options.flow)).filter(
    (record) => record.engine === engine,
  );
  const records: Array<{
    record: BaselineRecord;
    source: BaseRecordSource;
    path: string;
  }> = [
    ...cached.map(({ engine: _engine, ...record }) => ({
      record,
      source: "base-cache" as const,
      path: cachePath,
    })),
    ...(committed !== undefined && committed.flow === options.flow
      ? committed.records.map((record) => ({
          record,
          source: "baseline" as const,
          path: committedPath,
        }))
      : []),
  ];
  const reachable: Array<BaseCandidate & { equivalent: boolean }> = [];
  const repository = (
    await git(projectDirectory, ["rev-parse", "--show-toplevel"])
  ).trim();
  const prefix = relative(repository, projectDirectory).split(sep).join("/");
  const local = (path: string) =>
    prefix && path.startsWith(`${prefix}/`)
      ? path.slice(prefix.length + 1)
      : path;
  const equivalence = new Map<string, boolean>();
  const equivalent = async (commit: string) => {
    if (commit === base) return true;
    const known = equivalence.get(commit);
    if (known !== undefined) return known;
    let result = false;
    try {
      const files = (
        await git(repository, [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          commit,
          base,
          "--",
        ])
      )
        .split("\0")
        .filter(Boolean)
        .filter((path) => !bookkeeping.test(path));
      result = !classifyByPath(
        files.map((path) => ({ path: local(path) })),
        options.nonUi,
      ).some((file) => file.ui);
    } catch {
      result = false;
    }
    equivalence.set(commit, result);
    return result;
  };
  for (const entry of records) {
    const ancestor = await ancestry
      .isAncestor(projectDirectory, entry.record.commit, base)
      .catch(() => undefined);
    if (ancestor !== true) {
      if (ancestor === undefined && entry.source === "baseline")
        notes.push(
          `cannot establish ancestry of baseline ${entry.record.commit.slice(0, 12)}; ignored (fetch full history to use it)`,
        );
      continue;
    }
    reachable.push({
      ...entry,
      behindBase: await ancestry.distance(
        projectDirectory,
        entry.record.commit,
        base,
      ),
      equivalent:
        entry.record.configHash === currentHash &&
        (await equivalent(entry.record.commit)),
    });
  }
  // Nearest first; at equal distance the base cache (exact tuples) wins,
  // then the newest recording.
  reachable.sort(
    (a, b) =>
      a.behindBase - b.behindBase ||
      Number(b.source === "base-cache") - Number(a.source === "base-cache") ||
      b.record.recordedAt.localeCompare(a.record.recordedAt),
  );
  const covering: BaseCandidate[] = [];
  const missing: PlannedTuple[] = [];
  for (const tuple of options.tuples) {
    const found = reachable.find(
      (candidate) =>
        candidate.equivalent &&
        candidate.record.tuples.some((stored) => covers(stored, tuple)),
    );
    if (found === undefined) {
      missing.push(tuple);
      continue;
    }
    if (!covering.some((candidate) => candidate.record === found.record)) {
      const { equivalent: _equivalent, ...candidate } = found;
      covering.push(candidate);
    }
  }
  const nearest = reachable[0];
  const fallback =
    nearest === undefined
      ? undefined
      : (({ equivalent: _equivalent, ...candidate }) => candidate)(nearest);
  return {
    base,
    covering: covering.sort(
      (a, b) =>
        reachable.findIndex((entry) => entry.record === a.record) -
        reachable.findIndex((entry) => entry.record === b.record),
    ),
    missing: [...new Map(missing.map((t) => [plannedKey(t), t])).values()],
    ...(fallback === undefined ? {} : { fallback }),
    cachePath,
    notes,
  };
}

/**
 * One record at the base from layers in priority order: per coordinate the
 * first layer holding it wins (a fresh base capture over a cached one over a
 * stored baseline). The configuration hash is the first layer's.
 */
export function composeBaseRecord(
  base: string,
  layers: BaselineRecord[],
): BaselineRecord {
  const first = layers[0];
  if (first === undefined)
    throw new IdiomError("a base record needs at least one layer");
  const tuples = new Map<string, BaselineTuple>();
  for (const layer of layers)
    for (const tuple of layer.tuples) {
      const key = tupleCoordinateKey(tuple);
      if (!tuples.has(key)) tuples.set(key, tuple);
    }
  return {
    ...first,
    commit: base,
    tuples: [...tuples.values()],
  };
}

/** What a resolution compares with when nothing is captured. */
export function comparisonWithoutCapture(
  resolution: BaseResolution,
): BaseComparison | undefined {
  const [first, ...rest] = resolution.covering;
  if (first !== undefined && resolution.missing.length === 0)
    return {
      source: first.source,
      base: resolution.base,
      record: composeBaseRecord(resolution.base, [
        first.record,
        ...rest.map((candidate) => candidate.record),
      ]),
      path: first.path,
      ...(first.record.commit === resolution.base
        ? {}
        : {
            baselineCommit: first.record.commit,
            behindBase: first.behindBase,
          }),
      notes: resolution.notes,
    };
  const fallback = resolution.fallback;
  if (fallback === undefined) return undefined;
  return {
    source: "fallback",
    base: resolution.base,
    record: fallback.record,
    path: fallback.path,
    baselineCommit: fallback.record.commit,
    behindBase: fallback.behindBase,
    notes: resolution.notes,
  };
}

/** A captured base layered over what the resolution already had. */
export function comparisonWithCapture(
  resolution: BaseResolution,
  captured: { record?: BaselineRecord | undefined; failedTupleKeys: string[] },
  configHash: string,
): BaseComparison {
  const layers = [
    ...(captured.record === undefined ? [] : [captured.record]),
    ...resolution.covering.map((candidate) => candidate.record),
    // Tuples the base capture could not produce fall back to the nearest
    // stored record; absent there too, their findings count as new.
    ...(resolution.fallback === undefined ? [] : [resolution.fallback.record]),
  ];
  const fellBack =
    resolution.fallback === undefined
      ? []
      : captured.failedTupleKeys.filter((key) =>
          resolution.fallback?.record.tuples.some(
            (tuple) => tupleCoordinateKey(tuple) === key,
          ),
        );
  return {
    source: "base-capture",
    base: resolution.base,
    record: layers.length
      ? composeBaseRecord(resolution.base, layers)
      : {
          commit: resolution.base,
          recordedAt: new Date().toISOString(),
          idiomVersion: engineIdentity(),
          configHash,
          tuples: [],
        },
    path: resolution.cachePath,
    notes: [
      ...resolution.notes,
      ...(captured.failedTupleKeys.length
        ? [
            `base capture failed for ${captured.failedTupleKeys.join(", ")}${fellBack.length ? `; judged ${fellBack.join(", ")} against baseline ${resolution.fallback?.record.commit.slice(0, 12)}` : ""}`,
          ]
        : []),
    ],
  };
}

/** The capture scope that covers every missing tuple of one flow. */
export function missingScope(missing: PlannedTuple[]): CaptureScope {
  return {
    states: [...new Set(missing.map((tuple) => tuple.state))].join(","),
    viewports: [...new Set(missing.map((tuple) => tuple.viewport))].join(","),
    schemes: [...new Set(missing.map((tuple) => tuple.scheme))].join(","),
  };
}

export type BaseCaptureOptions = {
  base: string;
  flow: string;
  project?: string | undefined;
  cwd?: string | undefined;
  scope: CaptureScope;
  prod?: boolean | undefined;
  probeBudgetMs?: number | undefined;
  probeDisabled?: boolean | undefined;
  probeRegions?: ReadonlyMap<string, ProbeRegion> | undefined;
  /** Written with the captured record; omitted, nothing is cached. */
  cachePath?: string | undefined;
  dependencies?: ReviewDependencies | undefined;
};
export type BaseCaptureResult = {
  /** Undefined when the base declares none of the scope (all new). */
  record?: BaselineRecord | undefined;
  failedTupleKeys: string[];
  ms: number;
};

/**
 * Capture the base commit in a detached worktree with its own committed
 * configuration and an owned server, deterministic checks only. It calls
 * `runReview`, not the check controller: no digest, attribution, agent-check
 * state, decisions or baseline is written for the base. States, viewports and
 * schemes the base does not declare are left out (the build added them).
 */
export async function captureBaseRecord(
  options: BaseCaptureOptions,
): Promise<BaseCaptureResult> {
  const started = performance.now();
  const captured = await withRefWorktree(
    {
      ref: options.base,
      flow: options.flow,
      project: options.project,
      cwd: options.cwd,
      dependencies: options.dependencies?.capture,
    },
    async (executionContext) => {
      const { validated } = executionContext;
      const flow = validated.flows[0]?.flow;
      if (flow === undefined)
        throw new IdiomError(`unknown flow ${options.flow} at base`);
      const split = (value: string | undefined) =>
        value
          ?.split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
      const states = split(options.scope.states)?.filter((id) =>
        flow.states.some((state) => state.id === id),
      );
      const viewports = split(options.scope.viewports)?.filter((name) =>
        validated.project.viewports.some((viewport) => viewport.name === name),
      );
      const schemes = split(options.scope.schemes)?.filter((scheme) =>
        validated.project.colorSchemes.includes(scheme as ColorScheme),
      );
      if (
        states?.length === 0 ||
        viewports?.length === 0 ||
        schemes?.length === 0
      )
        return undefined;
      const result = await runReview({
        flow: options.flow,
        project: options.project,
        cwd: options.cwd,
        executionContext,
        scope: {
          ...(states === undefined ? {} : { states: states.join(",") }),
          ...(viewports === undefined
            ? {}
            : { viewports: viewports.join(",") }),
          ...(schemes === undefined ? {} : { schemes: schemes.join(",") }),
        },
        prod: options.prod,
        deterministicOnly: true,
        isolatedRegistry: true,
        ...(options.probeBudgetMs === undefined
          ? {}
          : { probeBudgetMs: options.probeBudgetMs }),
        ...(options.probeDisabled ? { probeDisabled: true } : {}),
        ...(options.probeRegions === undefined
          ? {}
          : { probeRegions: options.probeRegions }),
        dependencies: {
          ...options.dependencies,
          capture: {
            ...options.dependencies?.capture,
            signal: executionContext.signal,
          },
        },
      });
      return buildBaselineRecord({
        validated,
        flow,
        runDirectory: result.runDirectory,
      });
    },
  );
  if (
    options.cachePath !== undefined &&
    captured !== undefined &&
    captured.record.tuples.length > 0
  )
    await writeBaseCacheRecord(
      options.cachePath,
      options.flow,
      captured.record,
    );
  return {
    ...(captured ?? { failedTupleKeys: [] }),
    ms: Math.round(performance.now() - started),
  };
}

export type SettledComparison = {
  comparison?: BaseComparison | undefined;
  /** Why no record applies: the check gates open findings. */
  unavailable?: string | undefined;
  /** The base capture was skipped or failed; printed by the gate. */
  warning?: string | undefined;
  captureMs?: number | undefined;
};

/** The no-capture outcome when the base was not (or could not be) captured. */
export function fallbackComparison(
  resolution: BaseResolution,
  why: string,
  flow: string,
): SettledComparison {
  const comparison = comparisonWithoutCapture(resolution);
  const base = resolution.base.slice(0, 12);
  if (comparison === undefined || comparison.source !== "fallback") {
    const unavailable = `no baseline reachable from base ${base}; gating open findings`;
    return {
      unavailable,
      warning: `warning: ${why}; ${unavailable} — run idiom baseline advance ${flow}`,
    };
  }
  const warning = `warning: ${why}; comparing with baseline ${comparison.record.commit.slice(0, 12)}, ${comparison.behindBase} commit(s) behind base ${base} — findings already at the base may be counted as new; run idiom baseline advance ${flow}`;
  return {
    comparison: { ...comparison, notes: [...comparison.notes, why] },
    warning,
  };
}

/**
 * Finish one flow's comparison: no capture when stored records cover every
 * tuple, else the given base capture, degrading to the fallback (never a
 * failure) when the capture throws for anything but cancellation.
 */
export async function settleBaseComparison(options: {
  resolution: BaseResolution;
  flow: string;
  configHash: string;
  capture?: (() => Promise<BaseCaptureResult>) | undefined;
  /** Why there is no capture function (the gate's budget). */
  skipped?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<SettledComparison> {
  const { resolution } = options;
  if (resolution.missing.length === 0) {
    const comparison = comparisonWithoutCapture(resolution);
    if (comparison !== undefined) return { comparison };
  }
  if (options.capture === undefined)
    return fallbackComparison(
      resolution,
      options.skipped ?? "base capture skipped",
      options.flow,
    );
  try {
    const captured = await options.capture();
    return {
      comparison: comparisonWithCapture(
        resolution,
        captured,
        options.configHash,
      ),
      captureMs: captured.ms,
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return fallbackComparison(
      resolution,
      `base capture failed (${error instanceof Error ? error.message : String(error)})`,
      options.flow,
    );
  }
}
