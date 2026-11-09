import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadRunRecord, type RunRecord } from "../capture/run-record.js";
import { storedRunsNewestFirst } from "../review/artifacts.js";
import type { ColorScheme } from "../schemas/project.js";
import type { GateEstimate, GateServer, GateStatePlan } from "./types.js";

/** Defaults for numbers no stored run measured; the plan says `(no history)`. */
export const GATE_DEFAULTS = {
  tupleCaptureMs: 20_000,
  controlProbeMs: 1_500,
  buildMs: 0,
  startMs: 30_000,
  checksMs: 5_000,
  /** A detached worktree of the base plus its dependency install. */
  refPrepareMs: 30_000,
} as const;

export const tupleKey = (state: string, viewport: string, scheme: string) =>
  `${state}\0${viewport}\0${scheme}`;

export type StoredRun = {
  runId: string;
  directory: string;
  record: RunRecord;
  checksMs?: number | undefined;
  /** Probed tuple → probe results that ran (not reused, not skipped). */
  probed: Map<string, number>;
  /** Probed tuple → control identity → rendered fingerprint. */
  fingerprints: Map<string, Map<string, string>>;
};

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Up to `limit` newest stored runs of a flow, with their probe evidence.
 * `accept` filters runs by their record before anything else is read.
 */
export async function loadFlowHistory(
  projectDirectory: string,
  flow: string,
  limit = 5,
  accept?: (record: RunRecord) => Promise<boolean>,
): Promise<StoredRun[]> {
  const reports = resolve(projectDirectory, ".idiom", "reports");
  const runs: StoredRun[] = [];
  for (const runId of await storedRunsNewestFirst(reports)) {
    if (runs.length >= limit) break;
    const directory = join(reports, runId);
    let record: RunRecord | undefined;
    try {
      record = await loadRunRecord(directory);
    } catch {
      continue;
    }
    if (record?.flow !== flow) continue;
    if (accept && !(await accept(record))) continue;
    const checks = (await readJson(join(directory, "checks-timings.json"))) as
      | { checks?: { status?: string; ms?: number } }
      | undefined;
    const run: StoredRun = {
      runId,
      directory,
      record,
      ...(checks?.checks?.status === "measured" &&
      typeof checks.checks.ms === "number"
        ? { checksMs: checks.checks.ms }
        : {}),
      probed: new Map(),
      fingerprints: new Map(),
    };
    const schemes = new Set(record.selected.map((tuple) => tuple.colorScheme));
    for (const tuple of record.probe.executed) {
      const segments = [tuple.state, tuple.viewport];
      const candidates = [
        join(directory, ...segments, tuple.colorScheme, "observations.json"),
        ...(schemes.size <= 1
          ? [join(directory, ...segments, "observations.json")]
          : []),
      ];
      for (const path of candidates) {
        const observations = (await readJson(path)) as
          | {
              probe?: {
                results?: Array<{
                  elapsedMs?: number;
                  reusedFrom?: string;
                  status?: string;
                }>;
                fingerprints?: Record<string, string>;
              };
            }
          | undefined;
        if (!observations?.probe) continue;
        const key = tupleKey(tuple.state, tuple.viewport, tuple.colorScheme);
        run.probed.set(
          key,
          (observations.probe.results ?? []).filter(
            (result) =>
              result.elapsedMs !== undefined && result.reusedFrom === undefined,
          ).length,
        );
        if (observations.probe.fingerprints)
          run.fingerprints.set(
            key,
            new Map(Object.entries(observations.probe.fingerprints)),
          );
        break;
      }
    }
    runs.push(run);
  }
  return runs;
}

const median = (values: number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/** Medians of a flow's history, with defaults where it has none. */
export type CostModel = {
  tupleCaptureMs(state: string, viewport: string, scheme: ColorScheme): number;
  controlProbeMs: number;
  buildMs: number;
  startMs: number;
  checksMs: number;
  noHistory: boolean;
  /** Controls the reference run's probe clicked in a state, if known. */
  probedControls(state: string): number | undefined;
};

export function costModel(history: StoredRun[]): CostModel {
  const perTuple = new Map<string, number[]>();
  const all: number[] = [];
  const perControl: number[] = [];
  for (const run of history)
    for (const tuple of run.record.timings.tuples) {
      if (tuple.total.status !== "measured") continue;
      const key = tupleKey(tuple.state, tuple.viewport, tuple.colorScheme);
      const capture = Math.max(0, tuple.total.ms - tuple.probe.ms);
      perTuple.set(key, [...(perTuple.get(key) ?? []), capture]);
      all.push(capture);
      const probed = run.probed.get(key);
      if (tuple.probe.status === "measured" && probed)
        perControl.push(tuple.probe.ms / probed);
    }
  const measured = (pick: (run: StoredRun) => RunRecord["timings"]["build"]) =>
    median(
      history
        .map(pick)
        .filter((phase) => phase.status === "measured")
        .map((phase) => phase.ms),
    );
  const build = measured((run) => run.record.timings.build);
  const start = measured((run) => run.record.timings.start);
  const checks = median(
    history.flatMap((run) =>
      run.checksMs === undefined ? [] : [run.checksMs],
    ),
  );
  const fallbackTuple = median(all);
  const control = median(perControl);
  return {
    tupleCaptureMs: (state, viewport, scheme) =>
      median(perTuple.get(tupleKey(state, viewport, scheme)) ?? []) ??
      fallbackTuple ??
      GATE_DEFAULTS.tupleCaptureMs,
    controlProbeMs: control ?? GATE_DEFAULTS.controlProbeMs,
    buildMs: build ?? GATE_DEFAULTS.buildMs,
    startMs: start ?? GATE_DEFAULTS.startMs,
    checksMs: checks ?? GATE_DEFAULTS.checksMs,
    noHistory: fallbackTuple === undefined,
    probedControls: (state) => {
      for (const run of history) {
        for (const [key, fingerprints] of run.fingerprints)
          if (key.startsWith(`${state}\0`)) return fingerprints.size;
        for (const [key, count] of run.probed)
          if (key.startsWith(`${state}\0`)) return count;
      }
      return undefined;
    },
  };
}

/**
 * Lanes are one per viewport and colour scheme, `concurrency` at a time; the
 * probe pass runs one lane per probed state.
 */
export function estimateGate(options: {
  states: GateStatePlan[];
  model: CostModel;
  server: GateServer;
  concurrency: number;
  probeBudgetMs?: number | undefined;
  probeTargetMs: number;
}): GateEstimate {
  const { model } = options;
  const lanes = new Map<string, number>();
  for (const state of options.states)
    for (const viewport of state.viewports)
      for (const scheme of state.schemes) {
        const lane = `${viewport}\0${scheme}`;
        lanes.set(
          lane,
          (lanes.get(lane) ?? 0) +
            model.tupleCaptureMs(state.state, viewport, scheme),
        );
      }
  const laneTotals = [...lanes.values()];
  const captureSum = laneTotals.reduce((sum, value) => sum + value, 0);
  const captureMs = laneTotals.length
    ? Math.max(
        Math.max(...laneTotals),
        captureSum / Math.min(options.concurrency, laneTotals.length),
      )
    : 0;
  const probes = options.states
    .filter((state) => state.probe)
    .map((state) => state.probeControls * model.controlProbeMs);
  const probeSum = probes.reduce((sum, value) => sum + value, 0);
  let probeMs = probes.length
    ? Math.max(
        Math.max(...probes),
        probeSum / Math.min(options.concurrency, probes.length),
      )
    : 0;
  const target =
    options.probeBudgetMs !== undefined && options.probeBudgetMs > 0
      ? options.probeBudgetMs
      : options.probeTargetMs;
  if (target > 0) probeMs = Math.min(probeMs, target);
  const reused = options.server.mode === "reused";
  const buildMs = reused ? 0 : model.buildMs;
  const startMs = reused ? 0 : model.startMs;
  const checksMs = options.states.length ? model.checksMs : 0;
  return {
    totalMs: Math.round(buildMs + startMs + captureMs + probeMs + checksMs),
    buildMs: Math.round(buildMs),
    startMs: Math.round(startMs),
    captureMs: Math.round(captureMs),
    probeMs: Math.round(probeMs),
    checksMs: Math.round(checksMs),
    noHistory: model.noHistory,
  };
}
