import { resolve } from "node:path";
import { projectChecksConfig } from "../checks/project-config.js";
import { IdiomError } from "../errors.js";
import { loadRunTuples } from "../review/artifacts.js";
import type { Finding } from "../schemas/finding.js";
import type { Flow } from "../schemas/flow.js";
import type { ValidationResult } from "../validation.js";
import {
  type DeterministicCandidateRecord,
  deterministicCandidateRecords,
} from "../verify/evaluate.js";
import { checksConfigHash } from "./config-hash.js";
import { tupleCoordinate, tupleCoordinateKey } from "./coordinate.js";
import { type GitAncestry, selectBaselineRecord } from "./resolve.js";
import type { BaselineFinding, BaselineRecord } from "./schema.js";
import { baselineDirectory, baselinePath, readBaselineFile } from "./store.js";

type Identity = { fingerprint: string; aliases: string[] };
const identities = (finding: Identity) => [
  finding.fingerprint,
  ...finding.aliases,
];
function identitySets(entries: Array<{ key: string; findings: Identity[] }>) {
  const result = new Map<string, Set<string>>();
  for (const entry of entries) {
    const set = result.get(entry.key) ?? new Set<string>();
    for (const finding of entry.findings)
      for (const id of identities(finding)) set.add(id);
    result.set(entry.key, set);
  }
  return result;
}
export function compareToBaseline(options: {
  record: BaselineRecord;
  currentCandidates: DeterministicCandidateRecord[];
  currentTupleKeys: ReadonlySet<string>;
  liveOccurrences: Finding[];
  currentConfigHash: string;
}) {
  const baseline = identitySets(
    options.record.tuples.map((tuple) => ({
      key: tupleCoordinateKey(tuple),
      findings: tuple.findings,
    })),
  );
  const current = identitySets(
    options.currentCandidates.map((candidate) => ({
      key: candidate.key,
      findings: [candidate],
    })),
  );
  const newFindings: Finding[] = [];
  const preExisting: Finding[] = [];
  for (const finding of options.liveOccurrences) {
    const key = tupleCoordinateKey(finding);
    const candidate = options.currentCandidates.find(
      (candidate) =>
        candidate.key === key && candidate.fingerprint === finding.fingerprint,
    );
    const ids =
      candidate === undefined ? [finding.fingerprint] : identities(candidate);
    (ids.some((id) => baseline.get(key)?.has(id))
      ? preExisting
      : newFindings
    ).push(finding);
  }
  const fixed: Array<BaselineFinding & { where: string }> = [];
  const uncoveredTuples: string[] = [];
  for (const tuple of options.record.tuples) {
    const key = tupleCoordinateKey(tuple);
    if (!options.currentTupleKeys.has(key)) {
      uncoveredTuples.push(key);
      continue;
    }
    for (const finding of tuple.findings)
      if (!identities(finding).some((id) => current.get(key)?.has(id)))
        fixed.push({ ...finding, where: key });
  }
  return {
    newFindings,
    preExisting,
    fixed,
    uncoveredTuples: [...new Set(uncoveredTuples)].sort(),
    ...(options.record.configHash === options.currentConfigHash
      ? {}
      : {
          stale: {
            reason: `checks configuration changed since the baseline was recorded (${options.record.configHash.slice(7, 19)} → ${options.currentConfigHash.slice(7, 19)})`,
          },
        }),
  };
}

export async function resolveRunBaseline(options: {
  validated: ValidationResult;
  flow: Flow;
  baselineFile?: string | undefined;
  cwd?: string | undefined;
  git?: GitAncestry | undefined;
}) {
  const { validated, flow } = options;
  const path =
    options.baselineFile === undefined
      ? baselinePath(
          baselineDirectory(validated.projectDirectory, validated.project),
          flow.id,
        )
      : resolve(options.cwd ?? process.cwd(), options.baselineFile);
  const file = await readBaselineFile(path);
  if (file !== undefined && file.flow !== flow.id)
    throw new IdiomError(
      `baseline ${path} belongs to flow ${file.flow}, not ${flow.id}`,
    );
  const selected =
    file === undefined
      ? undefined
      : await selectBaselineRecord({
          projectDirectory: validated.projectDirectory,
          file,
          git: options.git,
        });
  return { path, selected };
}

export async function compareRunToBaseline(options: {
  validated: ValidationResult;
  flow: Flow;
  runDirectory: string;
  baselineFile?: string | undefined;
  cwd?: string | undefined;
  liveOccurrences: Finding[];
  git?: GitAncestry | undefined;
}) {
  const { validated, flow } = options;
  const { path, selected } = await resolveRunBaseline(options);
  if (selected === undefined)
    throw new IdiomError(
      `no recorded baseline for "${flow.id}" reachable from HEAD in ${path}; run \`idiom baseline record ${flow.id}\` on main and commit it (a shallow clone may need the baseline commit fetched)`,
    );
  const loaded = await loadRunTuples(validated, flow, options.runDirectory);
  const comparison = compareToBaseline({
    record: selected.record,
    currentCandidates: deterministicCandidateRecords({
      tuples: loaded.tuples,
      expectedTupleKeys: loaded.expectedTupleKeys,
      legacyColorScheme: validated.project.capture.colorScheme,
      config: await projectChecksConfig(validated),
    }),
    currentTupleKeys: new Set(
      loaded.tuples
        .filter((tuple) => tuple.failure === undefined)
        .map((tuple) => tupleCoordinateKey(tupleCoordinate(tuple))),
    ),
    liveOccurrences: options.liveOccurrences,
    currentConfigHash: checksConfigHash(validated.project.checks),
  });
  return {
    ...comparison,
    baseline: {
      commit: selected.record.commit,
      recordedAt: selected.record.recordedAt,
      path,
      distance: selected.distance,
      configHash: selected.record.configHash,
      ...(comparison.stale === undefined ? {} : { stale: comparison.stale }),
      uncoveredTuples: comparison.uncoveredTuples,
    },
  };
}
