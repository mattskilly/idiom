import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { captureTupleKey } from "../capture/resolve.js";
import { projectChecksConfig } from "../checks/project-config.js";
import type { CheckTuple } from "../checks/types.js";
import { IdiomError, RunFailure } from "../errors.js";
import { loadRunTuples } from "../review/artifacts.js";
import type { Flow } from "../schemas/flow.js";
import { isPublishedFlow } from "../schemas/flow.js";
import type { ValidationResult } from "../validation.js";
import { deterministicCandidateRecords } from "../verify/evaluate.js";
import { IDIOM_VERSION } from "../version.js";
import { checksConfigHash } from "./config-hash.js";
import { tupleCoordinate, tupleCoordinateKey } from "./coordinate.js";
import { gitAncestry } from "./resolve.js";
import type { BaselineRecord, BaselineTuple } from "./schema.js";
import {
  baselineDirectory,
  baselinePath,
  pixelBaselineDirectory,
  pixelBaselineName,
  writeBaselineRecord,
} from "./store.js";

/**
 * Copies each published tuple's screenshot into `<flow>.pixels/` (committed
 * next to the findings baseline) and prunes images no tuple maps to.
 */
async function recordPixelBaselines(
  directory: string,
  runDirectory: string,
  tuples: CheckTuple[],
): Promise<number> {
  await mkdir(directory, { recursive: true });
  const written = new Set<string>();
  for (const tuple of tuples) {
    if (tuple.screenshotPath === undefined) continue;
    const name = pixelBaselineName(tupleCoordinate(tuple));
    const target = join(directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await copyFile(join(runDirectory, tuple.screenshotPath), temporary);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    written.add(name);
  }
  for (const entry of await readdir(directory)) {
    if (entry.endsWith(".png") && !written.has(entry))
      await rm(join(directory, entry), { force: true });
  }
  return written.size;
}

export type CaptureFailure = import("../capture/scope.js").Coordinate & {
  stage: string;
  message: string;
  hostDeferred?: boolean | undefined;
};

/** Shared automatic-baseline evidence guard, in selected matrix order. */
export function captureCompleteness(
  loaded: Pick<
    Awaited<ReturnType<typeof loadRunTuples>>,
    "tuples" | "expectedTupleKeys" | "record"
  >,
  colorScheme: "light" | "dark",
): { failures: CaptureFailure[]; total: number } {
  const byKey = new Map(
    loaded.tuples.map((tuple) => [
      captureTupleKey({
        ...tuple,
        colorScheme: tuple.colorScheme ?? colorScheme,
      }),
      tuple,
    ]),
  );
  const keys =
    loaded.record?.selected.map(captureTupleKey) ?? loaded.expectedTupleKeys;
  const failures: CaptureFailure[] = [];
  for (const key of new Set(keys)) {
    const tuple = byKey.get(key);
    const [state, viewport, scheme] = key.split("\0");
    if (!tuple || tuple.failure || !tuple.screenshotPath)
      failures.push({
        state: state!,
        viewport: viewport!,
        colorScheme: scheme as "light" | "dark",
        stage: tuple?.failure?.stage ?? "capture",
        message:
          tuple?.failure?.message ??
          (tuple ? "screenshot missing" : "tuple missing"),
        ...(tuple?.failure?.hostDeferred ? { hostDeferred: true } : {}),
      });
  }
  return { failures, total: new Set(keys).size };
}
export type BaselineNotRecorded = {
  failed: number;
  total: number;
  successful: number;
  coordinates: import("../capture/scope.js").Coordinate[];
  message: string;
};
export function baselineGapDiagnostic(
  failures: CaptureFailure[],
  total: number,
): BaselineNotRecorded {
  const failed = failures.length;
  const successful = total - failed;
  const coordinates = failures.map(({ state, viewport, colorScheme }) => ({
    state,
    viewport,
    colorScheme,
  }));
  return {
    failed,
    total,
    successful,
    coordinates,
    message: `Baseline not recorded: ${failed} of ${total} tuples failed (${coordinates.map((tuple) => `${tuple.state}/${tuple.viewport}/${tuple.colorScheme}`).join(", ")}). Findings for the other ${successful} are above.`,
  };
}

async function assembleBaselineRecord(
  validated: ValidationResult,
  loaded: Awaited<ReturnType<typeof loadRunTuples>>,
  options: { excludeFailed?: boolean } = {},
): Promise<{ record: BaselineRecord; failedTupleKeys: string[] }> {
  const failedTupleKeys = loaded.tuples
    .filter((tuple) => tuple.failure !== undefined)
    .map((tuple) => tupleCoordinateKey(tupleCoordinate(tuple)));
  const failed = new Set(options.excludeFailed ? failedTupleKeys : []);
  const candidates = deterministicCandidateRecords({
    tuples: loaded.tuples,
    expectedTupleKeys: loaded.expectedTupleKeys,
    legacyColorScheme: validated.project.capture.colorScheme,
    config: await projectChecksConfig(validated),
  });
  const tuples = new Map<string, BaselineTuple>(
    loaded.tuples.map((tuple) => {
      const coordinate = tupleCoordinate(tuple);
      return [tupleCoordinateKey(coordinate), { ...coordinate, findings: [] }];
    }),
  );
  for (const { key, coordinate, ...finding } of candidates) {
    const tuple = tuples.get(key) ?? { ...coordinate, findings: [] };
    if (
      !tuple.findings.some(
        (existing) => existing.fingerprint === finding.fingerprint,
      )
    )
      tuple.findings.push(finding);
    tuples.set(key, tuple);
  }
  for (const key of failed) tuples.delete(key);
  return {
    record: {
      commit: loaded.commit,
      recordedAt: new Date().toISOString(),
      idiomVersion: IDIOM_VERSION,
      configHash: checksConfigHash(validated.project.checks),
      tuples: [...tuples.values()],
    },
    failedTupleKeys,
  };
}

/**
 * A baseline record from a stored run without writing it: the base
 * comparison and `baseline advance` build one per capture. Tuples whose
 * capture failed are left out (no evidence either way) and named.
 */
export async function buildBaselineRecord(options: {
  validated: ValidationResult;
  flow: Flow;
  runDirectory: string;
}): Promise<{ record: BaselineRecord; failedTupleKeys: string[] }> {
  const loaded = await loadRunTuples(
    options.validated,
    options.flow,
    options.runDirectory,
  );
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(loaded.commit))
    throw new IdiomError(
      "baseline record needs a capture with a valid Git commit; capture a committed tree first",
    );
  return assembleBaselineRecord(options.validated, loaded, {
    excludeFailed: true,
  });
}

export async function recordBaseline(options: {
  validated: ValidationResult;
  flow: Flow;
  runDirectory: string;
  out?: string | undefined;
  requireHead?: boolean | undefined;
  expectedCommit?: string | undefined;
}) {
  const { validated, flow, runDirectory } = options;
  const loaded = await loadRunTuples(validated, flow, runDirectory);
  for (const tuple of loaded.tuples) {
    const metadata = JSON.parse(
      await readFile(join(runDirectory, tuple.metadataPath), "utf8"),
    ) as { source: { dirty?: boolean } };
    if (
      metadata.source.dirty === true ||
      (options.requireHead === true && metadata.source.dirty !== false)
    )
      throw new RunFailure({
        stage: "capture",
        cause: "tree-dirty-after-capture",
        headline: "baseline refused: the captured tree was dirty",
        detail: `baseline record needs a capture of a clean tree; commit or stash first${options.requireHead === true ? ", then capture HEAD again, or inspect with --all" : ""}`,
        hint: `commit or stash, then capture HEAD again (if the tree was clean before the run, something the run executed changed a tracked file: commit it or gitignore it)${options.requireHead === true ? ", or inspect with --all" : ""}`,
      });
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(loaded.commit))
    throw new IdiomError(
      "baseline record needs a capture with a valid Git commit; capture a committed tree first",
    );
  if (options.requireHead === true) {
    const head =
      options.expectedCommit ??
      (await gitAncestry.head(validated.projectDirectory));
    if (loaded.commit !== head)
      throw new IdiomError(
        "automatic baseline needs a capture of clean HEAD; commit or stash, then capture HEAD and run check again, or inspect with --all",
      );
    if (
      loaded.tuples.length === 0 ||
      captureCompleteness(loaded, validated.project.capture.colorScheme)
        .failures.length > 0
    )
      throw new IdiomError(
        "automatic baseline needs a successful capture; fix capture failures and retry, or inspect with --all",
      );
  }
  const { record } = await assembleBaselineRecord(validated, loaded);
  const tuples = record.tuples;
  const configHash = record.configHash;
  const path = baselinePath(
    options.out ??
      baselineDirectory(
        validated.stateProjectDirectory ?? validated.projectDirectory,
        validated.project,
      ),
    flow.id,
  );
  const { replaced } = await writeBaselineRecord(path, flow.id, record);
  const pixelDirectory = pixelBaselineDirectory(
    options.out ??
      baselineDirectory(
        validated.stateProjectDirectory ?? validated.projectDirectory,
        validated.project,
      ),
    flow.id,
  );
  const pixelCount = isPublishedFlow(flow)
    ? await recordPixelBaselines(pixelDirectory, runDirectory, loaded.tuples)
    : 0;
  return {
    path,
    pixelCount,
    pixelDirectory,
    flow: flow.id,
    commit: loaded.commit,
    findingCount: tuples.reduce((sum, tuple) => sum + tuple.findings.length, 0),
    tupleCount: tuples.length,
    configHash,
    replaced,
  };
}
