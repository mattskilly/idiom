import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  type TupleCoordinate,
  tupleCoordinate,
  tupleCoordinateKey,
} from "../baseline/coordinate.js";
import { checksConfigFrom } from "../checks/registry.js";
import type { CheckTuple } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import { loadRunTuples, resolveStoredRun } from "../review/artifacts.js";
import { validateProject } from "../validation.js";
import {
  type AttachmentManifest,
  canonicalAttachmentKind,
  validateAttachmentManifest,
  writeAttachmentManifest,
} from "../verify/attachments.js";
import { diffImages, writeBeforeAfterComposite } from "../verify/compare.js";
import {
  type DeterministicCandidateRecord,
  deterministicCandidateRecords,
} from "../verify/evaluate.js";
import {
  assertReplaceable,
  compareOutputOwner,
  exists,
  publish,
} from "../verify/output.js";
import { renderCompareReport } from "./report.js";

export type ComparedTuple = TupleCoordinate & {
  key: string;
};

export type ChangedTuple = ComparedTuple & {
  ordinal: number;
  kind: string;
  path: string;
  differentPixels: number;
  totalPixels: number;
};

export type CompareFinding = Pick<
  DeterministicCandidateRecord,
  "category" | "rule" | "severity" | "selector" | "key" | "fingerprint"
>;

export type CompareResult = {
  flow: string;
  before: { runId: string; commit: string };
  after: { runId: string; commit: string };
  outputDirectory: string;
  reportPath: string;
  manifestPath: string;
  changed: ChangedTuple[];
  unchanged: ComparedTuple[];
  onlyBefore: ComparedTuple[];
  onlyAfter: ComparedTuple[];
  notComparable: Array<ComparedTuple & { reason: string }>;
  newFindings: CompareFinding[];
  fixedFindings: CompareFinding[];
};

function defaultOutput(projectDirectory: string, now: Date): string {
  return join(
    projectDirectory,
    ".idiom",
    "reports",
    `compare-${now.toISOString().replaceAll(":", "-").replaceAll(".", "-")}`,
  );
}

function compositePath(coordinate: TupleCoordinate): string {
  const combination =
    coordinate.combination === undefined
      ? ""
      : `-${coordinate.combination.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  return `before-after-${coordinate.state}-${coordinate.viewport}${coordinate.colorScheme === undefined ? "" : `-${coordinate.colorScheme}`}${combination}.png`;
}

function notComparableReason(
  side: "before" | "after",
  tuple: CheckTuple,
): string | undefined {
  if (tuple.failure !== undefined)
    return `${side} capture failed at ${tuple.failure.stage}: ${tuple.failure.message.split("\n")[0]}`;
  if (tuple.screenshotPath === undefined)
    return `${side} capture has no screenshot`;
  return undefined;
}

/** Records in `records` whose identity `other` does not share. */
function unmatched(
  records: DeterministicCandidateRecord[],
  other: DeterministicCandidateRecord[],
): CompareFinding[] {
  const known = new Set(
    other.flatMap(({ fingerprint, aliases }) => [fingerprint, ...aliases]),
  );
  const seen = new Set<string>();
  const result: CompareFinding[] = [];
  for (const record of records) {
    if ([record.fingerprint, ...record.aliases].some((id) => known.has(id)))
      continue;
    const identity = `${record.fingerprint}\0${record.key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({
      category: record.category,
      rule: record.rule,
      severity: record.severity,
      selector: record.selector,
      key: record.key,
      fingerprint: record.fingerprint,
    });
  }
  return result;
}

/**
 * Pairs two stored captures of one flow tuple by tuple and writes a labelled
 * before | after composite for every tuple whose pixels changed, plus a
 * report of new and fixed deterministic findings. The output follows the
 * verify attachment contract, so it deposits the way verify output does.
 */
export async function runCompare(options: {
  flow: string;
  /** The after run. */
  from: string;
  /** The before run. */
  against: string;
  project?: string | undefined;
  cwd?: string | undefined;
  out?: string | undefined;
  now?: (() => Date) | undefined;
}): Promise<CompareResult> {
  if (options.from === options.against)
    throw new IdiomError("--from and --against must name different runs");
  const validated = await validateProject({
    project: options.project,
    flow: options.flow,
    cwd: options.cwd,
  });
  const flow = validated.flows[0]?.flow;
  if (flow === undefined || flow.id !== options.flow)
    throw new IdiomError(`requested flow ${options.flow} was not validated`);
  const beforeDirectory = resolveStoredRun(
    validated.projectDirectory,
    options.against,
  );
  const afterDirectory = resolveStoredRun(
    validated.projectDirectory,
    options.from,
  );
  const before = await loadRunTuples(validated, flow, beforeDirectory);
  const after = await loadRunTuples(validated, flow, afterDirectory);

  const now = options.now?.() ?? new Date();
  const outputDirectory =
    options.out === undefined
      ? defaultOutput(validated.projectDirectory, now)
      : resolve(validated.projectDirectory, options.out);
  if (options.out === undefined && (await exists(outputDirectory)))
    throw new IdiomError(
      `default compare output already exists; retry with --out for atomic replacement: ${outputDirectory}`,
    );
  await assertReplaceable(outputDirectory, compareOutputOwner);

  const beforeByKey = new Map(
    before.tuples.map((tuple) => [
      tupleCoordinateKey(tupleCoordinate(tuple)),
      tuple,
    ]),
  );
  const afterKeys = new Set(
    after.tuples.map((tuple) => tupleCoordinateKey(tupleCoordinate(tuple))),
  );

  await mkdir(dirname(outputDirectory), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(outputDirectory), `.${basename(outputDirectory)}.staging-`),
  );
  let published = false;
  try {
    const changed: ChangedTuple[] = [];
    const unchanged: ComparedTuple[] = [];
    const notComparable: CompareResult["notComparable"] = [];
    const onlyAfter: ComparedTuple[] = [];
    for (const afterTuple of after.tuples) {
      const coordinate = tupleCoordinate(afterTuple);
      const key = tupleCoordinateKey(coordinate);
      const beforeTuple = beforeByKey.get(key);
      if (beforeTuple === undefined) {
        onlyAfter.push({ ...coordinate, key });
        continue;
      }
      const reason =
        notComparableReason("before", beforeTuple) ??
        notComparableReason("after", afterTuple);
      if (reason !== undefined) {
        notComparable.push({ ...coordinate, key, reason });
        continue;
      }
      const beforeSource = await readFile(
        join(beforeDirectory, beforeTuple.screenshotPath as string),
      );
      const afterSource = await readFile(
        join(afterDirectory, afterTuple.screenshotPath as string),
      );
      const diff = diffImages(beforeSource, afterSource);
      if (diff.differentPixels === 0) {
        unchanged.push({ ...coordinate, key });
        continue;
      }
      const ordinal = changed.length + 1;
      const path = compositePath(coordinate);
      await writeBeforeAfterComposite({
        beforePath: beforeTuple.screenshotPath as string,
        afterPath: afterTuple.screenshotPath as string,
        beforeSource,
        afterSource,
        outputPath: join(staging, path),
        labels: {
          title: `${coordinate.state} / ${coordinate.viewport}${coordinate.colorScheme === undefined ? "" : ` / ${coordinate.colorScheme}`}`,
          before: `BEFORE ${(beforeTuple.commit || before.commit).slice(0, 7)}`,
          after: `AFTER ${(afterTuple.commit || after.commit).slice(0, 7)}`,
        },
      });
      changed.push({
        ...coordinate,
        key,
        ordinal,
        kind: canonicalAttachmentKind(ordinal),
        path,
        differentPixels: diff.differentPixels,
        totalPixels: diff.padded.width * diff.padded.height,
      });
    }
    const onlyBefore = before.tuples
      .map((tuple) => {
        const coordinate = tupleCoordinate(tuple);
        return { ...coordinate, key: tupleCoordinateKey(coordinate) };
      })
      .filter(({ key }) => !afterKeys.has(key));

    const config = checksConfigFrom(validated.project.checks);
    const records = (loaded: typeof before) =>
      deterministicCandidateRecords({
        tuples: loaded.tuples,
        expectedTupleKeys: loaded.expectedTupleKeys,
        legacyColorScheme: validated.project.capture.colorScheme,
        config,
      });
    const beforeRecords = records(before);
    const afterRecords = records(after);
    const newFindings = unmatched(afterRecords, beforeRecords);
    const fixedFindings = unmatched(beforeRecords, afterRecords);

    const manifest: AttachmentManifest = {
      version: 1,
      report: { kind: "idiom-verify-report", path: "before-after.md" },
      composites: changed.map((tuple) => ({
        ordinal: tuple.ordinal,
        kind: tuple.kind,
        state: tuple.state,
        viewport: tuple.viewport,
        ...(tuple.colorScheme === undefined
          ? {}
          : { colorScheme: tuple.colorScheme }),
        path: tuple.path,
      })),
    };
    const result = {
      flow: flow.id,
      before: { runId: before.runId, commit: before.commit },
      after: { runId: after.runId, commit: after.commit },
      changed,
      unchanged,
      onlyBefore,
      onlyAfter,
      notComparable,
      newFindings,
      fixedFindings,
    };
    await writeFile(
      join(staging, "before-after.md"),
      renderCompareReport(result),
    );
    await writeAttachmentManifest(staging, manifest);
    await writeFile(
      join(staging, compareOutputOwner.marker),
      compareOutputOwner.text,
    );
    await validateAttachmentManifest({
      outputDirectory: staging,
      manifest,
      requireFiles: true,
    });
    await publish(staging, outputDirectory, compareOutputOwner);
    published = true;
    return {
      ...result,
      outputDirectory,
      reportPath: join(outputDirectory, "before-after.md"),
      manifestPath: join(outputDirectory, "attachments.json"),
    };
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}
