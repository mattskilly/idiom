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
import { IdiomError } from "../errors.js";
import { loadRunTuples } from "../review/artifacts.js";
import type { Flow } from "../schemas/flow.js";
import { isPublishedFlow } from "../schemas/flow.js";
import type { ValidationResult } from "../validation.js";
import { deterministicCandidateRecords } from "../verify/evaluate.js";
import { IDIOM_VERSION } from "../version.js";
import { checksConfigHash } from "./config-hash.js";
import { tupleCoordinate, tupleCoordinateKey } from "./coordinate.js";
import { gitAncestry } from "./resolve.js";
import type { BaselineTuple } from "./schema.js";
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

export async function recordBaseline(options: {
  validated: ValidationResult;
  flow: Flow;
  runDirectory: string;
  out?: string | undefined;
  requireHead?: boolean | undefined;
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
      throw new IdiomError(
        `baseline record needs a capture of a clean tree; commit or stash first${options.requireHead === true ? ", then capture HEAD again, or inspect with --all" : ""}`,
      );
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(loaded.commit))
    throw new IdiomError(
      "baseline record needs a capture with a valid Git commit; capture a committed tree first",
    );
  if (options.requireHead === true) {
    const head = await gitAncestry.head(validated.projectDirectory);
    if (loaded.commit !== head)
      throw new IdiomError(
        "automatic baseline needs a capture of clean HEAD; commit or stash, then capture HEAD and run check again, or inspect with --all",
      );
    const captured = new Set(
      loaded.tuples.map((tuple) =>
        captureTupleKey({
          ...tuple,
          colorScheme:
            tuple.colorScheme ?? validated.project.capture.colorScheme,
        }),
      ),
    );
    if (
      loaded.expectedTupleKeys.some((key) => !captured.has(key)) ||
      loaded.tuples.length === 0 ||
      loaded.tuples.some(
        (tuple) =>
          tuple.failure !== undefined || tuple.screenshotPath === undefined,
      )
    )
      throw new IdiomError(
        "automatic baseline needs a successful capture; fix capture failures and retry, or inspect with --all",
      );
  }
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
  const configHash = checksConfigHash(validated.project.checks);
  const path = baselinePath(
    options.out ??
      baselineDirectory(validated.projectDirectory, validated.project),
    flow.id,
  );
  const { replaced } = await writeBaselineRecord(path, flow.id, {
    commit: loaded.commit,
    recordedAt: new Date().toISOString(),
    idiomVersion: IDIOM_VERSION,
    configHash,
    tuples: [...tuples.values()],
  });
  const pixelDirectory = pixelBaselineDirectory(
    options.out ??
      baselineDirectory(validated.projectDirectory, validated.project),
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
    findingCount: [...tuples.values()].reduce(
      (sum, tuple) => sum + tuple.findings.length,
      0,
    ),
    tupleCount: tuples.size,
    configHash,
    replaced,
  };
}
