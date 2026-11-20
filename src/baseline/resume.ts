import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type CollapsedCombination,
  combinationsReport,
  createSecretScanner,
  defaultRunName,
  stateCombination,
} from "../capture/artifacts.js";
import { captureTupleKey } from "../capture/resolve.js";
import type { ResumeCapture } from "../capture/run.js";
import {
  currentRunOwner,
  recoverInterruptedRun,
} from "../capture/run-lifecycle.js";
import {
  loadRunRecord,
  type RunRecord,
  runRecordSchema,
} from "../capture/run-record.js";
import type { Coordinate } from "../capture/scope.js";
import type { ProbeArtifact } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import type { Flow } from "../schemas/flow.js";
import { STATE_BUDGET_STAGE } from "./record.js";

/** An interrupted capture a baseline can continue from. */
export type ResumableRun = { directory: string; record: RunRecord };

const short = (commit: string) => commit.slice(0, 12);

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * The newest capture of `flow` under `reports`, which must be interrupted:
 * one that completed has nothing to resume, and one still running belongs
 * to another process. Hidden (dot) directories are never runs.
 */
export async function findResumableRun(
  reports: string,
  flow: string,
): Promise<ResumableRun> {
  let entries: Dirent[];
  try {
    entries = await readdir(reports, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }
  const runs: ResumableRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = join(reports, entry.name);
    try {
      await recoverInterruptedRun(directory);
      const record = await loadRunRecord(directory);
      if (record?.flow === flow && record.status !== undefined)
        runs.push({ directory, record });
    } catch {
      // Not a lifecycle run this command can read.
    }
  }
  // Last written first: a composed run keeps its interrupted run's start.
  const newest = runs.sort(
    (a, b) =>
      (b.record.updatedAt ?? "").localeCompare(a.record.updatedAt ?? "") ||
      b.directory.localeCompare(a.directory),
  )[0];
  if (newest === undefined)
    throw new IdiomError(
      `no interrupted capture of ${flow} to resume; run idiom baseline record ${flow}`,
    );
  const id = newest.record.runId ?? newest.directory;
  if (newest.record.status === "complete")
    throw new IdiomError(
      `nothing to resume: the newest capture of ${flow} (${id}) completed; run idiom baseline record ${flow}`,
    );
  if (newest.record.status === "running")
    throw new IdiomError(
      `the newest capture of ${flow} (${id}) is still running in process ${newest.record.owner?.pid ?? "unknown"}; wait for it or stop it first`,
    );
  return newest;
}

export type ResumeCurrent = {
  commit: string;
  dirty: boolean;
  captureSettingsIdentity: string;
  idiomVersion: string;
  production: boolean;
  toggleIdentity: string;
  selected: Coordinate[];
};

const label = (tuple: Coordinate) =>
  `${tuple.state}/${tuple.viewport}/${tuple.colorScheme}`;

/** Why the interrupted run cannot be continued now, or undefined when it can. */
export function resumeRefusal(
  record: RunRecord,
  current: ResumeCurrent,
): string | undefined {
  if (record.captureSettingsIdentity === undefined)
    return "it predates resumable captures (no capture settings identity recorded)";
  if (record.source.commit !== current.commit)
    return `it captured ${short(record.source.commit)} but HEAD is ${short(current.commit)}`;
  if (record.source.dirty) return "its captured tree was dirty";
  if (current.dirty) return "the working tree is dirty";
  if (
    record.idiomVersion !== undefined &&
    record.idiomVersion !== current.idiomVersion
  )
    return `it was captured by Idiom ${record.idiomVersion}, this is ${current.idiomVersion}`;
  if (
    record.production !== undefined &&
    record.production !== current.production
  )
    return record.production
      ? "it was a production capture and this one is not"
      : "this is a production capture and it was not";
  if (record.captureSettingsIdentity !== current.captureSettingsIdentity)
    return "the capture configuration changed since it ran (capture settings identity differs)";
  if (
    record.toggleIdentity !== undefined &&
    record.toggleIdentity !== current.toggleIdentity
  )
    return "the flow's toggle declarations changed";
  const recorded = new Set(record.selected.map(captureTupleKey));
  const now = new Set(current.selected.map(captureTupleKey));
  const added = current.selected.filter(
    (tuple) => !recorded.has(captureTupleKey(tuple)),
  );
  const removed = record.selected.filter(
    (tuple) => !now.has(captureTupleKey(tuple)),
  );
  if (added.length > 0 || removed.length > 0) {
    const list = (tuples: Coordinate[]) =>
      `${tuples.slice(0, 5).map(label).join(", ")}${tuples.length > 5 ? `, +${tuples.length - 5} more` : ""}`;
    return `the flow's selected tuples changed (${[
      ...(added.length ? [`added: ${list(added)}`] : []),
      ...(removed.length ? [`removed: ${list(removed)}`] : []),
    ].join("; ")})`;
  }
  return undefined;
}

/** A tuple's directory under a run, relative: with or without a scheme level. */
export async function tupleDirectory(
  runDirectory: string,
  tuple: Coordinate,
): Promise<string | undefined> {
  for (const relative of [
    join(tuple.state, tuple.viewport, tuple.colorScheme),
    join(tuple.state, tuple.viewport),
  ])
    if (await exists(join(runDirectory, relative, "metadata.json")))
      return relative;
  return undefined;
}

type StoredMetadata = {
  failure?: { stage?: string } | null;
  layoutRepresentative?: string;
  build?: { kind?: string; id?: string };
  expectations?: { passed?: boolean };
  colorSchemeAxis?: boolean;
};

export type ResumePlan = {
  /** Kept tuples, in selected order. */
  carried: Coordinate[];
  /** Tuples to capture again, in selected order. */
  remaining: Coordinate[];
  /** What the partial capture needs; undefined when nothing remains. */
  capture?: ResumeCapture | undefined;
};

/**
 * Which tuples of the interrupted run to keep. Only final tuples are kept:
 * a completed tuple may still be its pre-probe snapshot. A state that ran
 * out of its time budget is captured again. With toggles, a combination
 * group (base state × viewport × scheme) is kept whole or not at all, so
 * layout collapse sees the same representatives as an uninterrupted run.
 */
export async function resumePlan(
  interrupted: ResumableRun,
  flow: Flow,
): Promise<ResumePlan> {
  const { record, directory } = interrupted;
  const finals = new Set((record.finalTuples ?? []).map(captureTupleKey));
  const kept = new Set<string>();
  for (const tuple of record.selected) {
    const key = captureTupleKey(tuple);
    if (!finals.has(key)) continue;
    const relative = await tupleDirectory(directory, tuple);
    if (relative === undefined) continue;
    const metadata = (await readJson(
      join(directory, relative, "metadata.json"),
    )) as StoredMetadata | undefined;
    if (metadata === undefined) continue;
    if (metadata.failure?.stage === STATE_BUDGET_STAGE) continue;
    kept.add(key);
  }
  const bases = new Map(
    flow.states.map((state) => [state.id, stateCombination(state)?.base]),
  );
  if (
    bases.size > 0 &&
    [...bases.values()].some((base) => base !== undefined)
  ) {
    const group = (tuple: Coordinate) => {
      const base = bases.get(tuple.state);
      return base === undefined
        ? undefined
        : `${base}\0${tuple.viewport}\0${tuple.colorScheme}`;
    };
    const broken = new Set(
      record.selected.flatMap((tuple) => {
        const id = group(tuple);
        return id !== undefined && !kept.has(captureTupleKey(tuple))
          ? [id]
          : [];
      }),
    );
    for (const tuple of record.selected) {
      const id = group(tuple);
      if (id !== undefined && broken.has(id))
        kept.delete(captureTupleKey(tuple));
    }
  }
  const carried = record.selected.filter((tuple) =>
    kept.has(captureTupleKey(tuple)),
  );
  const remaining = record.selected.filter(
    (tuple) => !kept.has(captureTupleKey(tuple)),
  );
  if (remaining.length === 0) return { carried, remaining };
  const probed = new Set(
    (record.probe.policy === "everywhere"
      ? record.selected
      : record.probe.intended
    ).map(captureTupleKey),
  );
  const carriedProbes: ResumeCapture["carriedProbes"] = [];
  for (const tuple of carried) {
    if (!probed.has(captureTupleKey(tuple))) continue;
    const relative = await tupleDirectory(directory, tuple);
    if (relative === undefined) continue;
    const observations = (await readJson(
      join(directory, relative, "observations.json"),
    )) as { version?: number; probe?: ProbeArtifact } | undefined;
    if (observations?.version === 2 && observations.probe !== undefined)
      carriedProbes.push({ coordinate: tuple, probe: observations.probe });
  }
  return {
    carried,
    remaining,
    capture: {
      tupleKeys: new Set(remaining.map(captureTupleKey)),
      probeIntended: record.probe.intended,
      carriedProbes,
    },
  };
}

type CombinationsFile = {
  collapsed?: CollapsedCombination[];
  notes?: string[];
};

/**
 * The run-root `combinations.json` of the composed run: kept tuples'
 * collapsed entries from the interrupted run, the partial run's, and the
 * counts an uninterrupted run computes from them.
 */
async function composedCombinations(options: {
  flow: Flow;
  selected: Coordinate[];
  carried: ReadonlySet<string>;
  interrupted: string;
  partial?: string | undefined;
}): Promise<ReturnType<typeof combinationsReport> | undefined> {
  const combinationOf = new Map(
    options.flow.states.map((state) => [state.id, stateCombination(state)]),
  );
  const declaresToggles =
    "toggles" in options.flow && options.flow.toggles !== undefined;
  const fromInterrupted = (await readJson(
    join(options.interrupted, "combinations.json"),
  )) as CombinationsFile | undefined;
  const fromPartial =
    options.partial === undefined
      ? undefined
      : ((await readJson(join(options.partial, "combinations.json"))) as
          | CombinationsFile
          | undefined);
  if (!declaresToggles && !fromInterrupted && !fromPartial) return undefined;
  const collapsed = new Map<string, CollapsedCombination>();
  if (fromInterrupted !== undefined) {
    for (const entry of fromInterrupted.collapsed ?? [])
      if (options.carried.has(captureTupleKey(entry)))
        collapsed.set(captureTupleKey(entry), entry);
  } else {
    // Written before runs kept combinations.json: read the kept tuples' own
    // layout representatives instead.
    const schemes = new Set(options.selected.map((tuple) => tuple.colorScheme));
    for (const tuple of options.selected) {
      if (!options.carried.has(captureTupleKey(tuple))) continue;
      const relative = await tupleDirectory(options.interrupted, tuple);
      if (relative === undefined) continue;
      const metadata = (await readJson(
        join(options.interrupted, relative, "metadata.json"),
      )) as StoredMetadata | undefined;
      const representative = metadata?.layoutRepresentative;
      const own = combinationOf.get(tuple.state);
      const sameAs =
        representative === undefined
          ? undefined
          : combinationOf.get(representative);
      if (representative === undefined || !own || !sameAs) continue;
      collapsed.set(captureTupleKey(tuple), {
        ...tuple,
        colorSchemeAxis: metadata?.colorSchemeAxis ?? schemes.size > 1,
        combination: own.label,
        sameAs: { state: representative, combination: sameAs.label },
      });
    }
  }
  for (const entry of fromPartial?.collapsed ?? [])
    collapsed.set(captureTupleKey(entry), entry);
  const order = new Map(
    options.selected.map((tuple, index) => [captureTupleKey(tuple), index]),
  );
  const ordered = [...collapsed.values()].sort(
    (a, b) =>
      (order.get(captureTupleKey(a)) ?? 0) -
      (order.get(captureTupleKey(b)) ?? 0),
  );
  const notes = [
    ...new Set([
      ...(fromInterrupted?.notes ?? []),
      ...(fromPartial?.notes ?? []),
    ]),
  ];
  return combinationsReport({
    captured:
      options.selected.filter(
        (tuple) => combinationOf.get(tuple.state) !== undefined,
      ).length - ordered.length,
    collapsed: ordered,
    cap: "toggleCap" in options.flow ? options.flow.toggleCap : undefined,
    notes,
  });
}

/**
 * Compose one ordinary complete run from the interrupted run's kept tuples
 * and the partial run's newly captured ones. Readers, review and the
 * baseline see a normal run; the interrupted run is left untouched and the
 * partial run is removed once the composed run is published.
 */
export async function composeResumedRun(options: {
  reports: string;
  flow: Flow;
  interrupted: ResumableRun;
  partial?: ResumableRun | undefined;
  carried: Coordinate[];
  environments?: NodeJS.ProcessEnv[] | undefined;
  now?: Date | undefined;
}): Promise<{ directory: string; record: RunRecord }> {
  const { interrupted, partial } = options;
  const source = interrupted.record;
  const id = source.runId ?? interrupted.directory;
  const refuse = (reason: string) =>
    new IdiomError(
      `cannot resume run ${id}: ${reason}; run idiom baseline record ${options.flow.id} for a fresh capture`,
    );
  if (partial !== undefined) {
    if (partial.record.status !== "complete")
      throw refuse("the remaining tuples did not finish capturing");
    if (
      partial.record.source.commit !== source.source.commit ||
      partial.record.source.dirty !== source.source.dirty
    )
      throw refuse("the tree changed while the remaining tuples were captured");
  }
  const carried = new Set(options.carried.map(captureTupleKey));
  const build = (
    partial ? await readJson(join(partial.directory, "build.json")) : undefined
  ) as { kind?: string; id?: string } | undefined;
  const earlierBuild = (await readJson(
    join(interrupted.directory, "build.json"),
  )) as { kind?: string; id?: string } | undefined;
  if (source.production === true) {
    if (build === undefined && earlierBuild === undefined)
      throw refuse("it recorded no production build provenance");
    if (
      build !== undefined &&
      options.carried.length > 0 &&
      (earlierBuild?.kind !== build.kind || earlierBuild?.id !== build.id)
    )
      throw refuse(
        `the production build was rebuilt (${earlierBuild?.id ?? "unknown"} → ${build.id ?? "unknown"})`,
      );
  }
  const staging = join(options.reports, `.compose-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    const metadata = new Map<string, StoredMetadata | undefined>();
    for (const tuple of source.selected) {
      const key = captureTupleKey(tuple);
      const from = carried.has(key)
        ? interrupted.directory
        : partial?.directory;
      const relative =
        from === undefined ? undefined : await tupleDirectory(from, tuple);
      if (from === undefined || relative === undefined)
        throw refuse(`tuple ${label(tuple)} has no captured evidence`);
      await cp(join(from, relative), join(staging, relative), {
        recursive: true,
        errorOnExist: true,
      });
      metadata.set(
        key,
        (await readJson(join(staging, relative, "metadata.json"))) as
          | StoredMetadata
          | undefined,
      );
    }
    const combinations = await composedCombinations({
      flow: options.flow,
      selected: source.selected,
      carried,
      interrupted: interrupted.directory,
      partial: partial?.directory,
    });
    if (combinations !== undefined)
      await writeFile(
        join(staging, "combinations.json"),
        `${JSON.stringify(combinations, null, 2)}\n`,
      );
    const runBuild = build ?? earlierBuild;
    if (runBuild !== undefined)
      await writeFile(
        join(staging, "build.json"),
        `${JSON.stringify(runBuild, null, 2)}\n`,
      );
    for (const directory of [partial?.directory, interrupted.directory]) {
      if (directory === undefined) continue;
      const log = join(directory, "server.log");
      if (await exists(log)) {
        await copyFile(log, join(staging, "server.log"));
        break;
      }
    }
    const now = options.now ?? new Date();
    const runId = defaultRunName(now);
    const timingOf = new Map(
      [
        ...source.timings.tuples.filter((tuple) =>
          carried.has(captureTupleKey(tuple)),
        ),
        ...(partial?.record.timings.tuples ?? []),
      ].map((tuple) => [captureTupleKey(tuple), tuple]),
    );
    const unavailable = { status: "unavailable" as const, ms: 0 };
    const intended = source.probe.intended;
    const executed = new Set([
      ...source.timings.tuples
        .filter(
          (tuple) =>
            carried.has(captureTupleKey(tuple)) &&
            tuple.probe.status === "measured",
        )
        .map(captureTupleKey),
      ...(partial?.record.probe.executed ?? []).map(captureTupleKey),
    ]);
    const selectedKeys = new Set(source.selected.map(captureTupleKey));
    const inSelection = <T extends Coordinate>(tuples: T[] | undefined) =>
      (tuples ?? []).filter((tuple) =>
        selectedKeys.has(captureTupleKey(tuple)),
      );
    const retries = inSelection(partial?.record.retries);
    const owner = await currentRunOwner();
    const record = runRecordSchema.parse({
      version: 1,
      status: "complete",
      runId,
      owner,
      startedAt: source.startedAt,
      updatedAt: now.toISOString(),
      endedAt: now.toISOString(),
      completedTuples: source.selected,
      finalTuples: source.selected,
      resumedFrom: [
        id,
        ...(partial ? [partial.record.runId ?? "partial"] : []),
      ],
      ...(source.idiomVersion === undefined
        ? {}
        : { idiomVersion: source.idiomVersion }),
      ...(source.production === undefined
        ? {}
        : { production: source.production }),
      ...(source.toggleIdentity === undefined
        ? {}
        : { toggleIdentity: source.toggleIdentity }),
      ...(partial?.record.host === undefined
        ? {}
        : {
            host: partial.record.host,
            deferredTuples: inSelection(partial.record.deferredTuples),
          }),
      retryCount: retries.length,
      retries,
      captureSettingsIdentity: source.captureSettingsIdentity,
      flow: source.flow,
      source: source.source,
      declared: source.declared,
      selected: source.selected,
      viewports: source.viewports,
      probe: {
        ...source.probe,
        executed: intended.filter((tuple) =>
          executed.has(captureTupleKey(tuple)),
        ),
        ...(partial?.record.probe.flowBudgetMs === undefined
          ? {}
          : { flowBudgetMs: partial.record.probe.flowBudgetMs }),
      },
      timings: {
        ...(partial?.record.timings.slowestControls === undefined
          ? {}
          : { slowestControls: partial.record.timings.slowestControls }),
        build: partial?.record.timings.build ?? unavailable,
        start: partial?.record.timings.start ?? unavailable,
        tuples: source.selected.map(
          (tuple) =>
            timingOf.get(captureTupleKey(tuple)) ?? {
              ...tuple,
              total: unavailable,
              probe: unavailable,
            },
        ),
        probe: partial?.record.timings.probe ?? unavailable,
        checks: { status: "skipped", ms: 0 },
        capture: partial?.record.timings.capture ?? unavailable,
      },
      ...(source.capture === undefined ? {} : { capture: source.capture }),
      ...(partial?.record.devServer === undefined
        ? {}
        : { devServer: partial.record.devServer }),
    });
    await writeFile(
      join(staging, "run.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    const passed = [...metadata.values()].filter(
      (entry) => entry?.expectations?.passed === true,
    ).length;
    await writeFile(
      join(staging, "baseline.md"),
      [
        `# Baseline: ${options.flow.title}`,
        "",
        ...(runBuild?.id === undefined
          ? []
          : [`Production build: \`${runBuild.id}\``, ""]),
        `Flow \`${options.flow.id}\`: ${passed} passed, ${metadata.size - passed} failed, ${metadata.size} total.`,
        "",
        `Resumed capture: kept ${options.carried.length} tuple(s) of run ${id}${partial ? ` and captured ${partial.record.selected.length} in run ${partial.record.runId ?? "partial"}` : ""}. Each tuple's artifacts are in its state/viewport directory.`,
        "",
      ].join("\n"),
    );
    // Everything here came from scanned runs; scan the composed tree anyway.
    await createSecretScanner().scan(
      staging,
      options.environments ?? [process.env],
    );
    const directory = join(options.reports, runId);
    if (await exists(directory))
      throw new IdiomError(
        `capture output already exists and will not be overwritten: ${directory}`,
      );
    await rename(staging, directory);
    return { directory, record };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
