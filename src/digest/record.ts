import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { z } from "zod";
import { checksConfigHash } from "../baseline/config-hash.js";
import { tupleCoordinateKey } from "../baseline/coordinate.js";
import { isGateOpen } from "../baseline/summary.js";
import type { RunRecord } from "../capture/run-record.js";
import type { ReportCoverage } from "../report/coverage.js";
import { findingRank } from "../review/presentation-order.js";
import { affectedCounts, type IssueRankingContext } from "../review/ranking.js";
import type { Finding } from "../schemas/finding.js";
import type { Project } from "../schemas/project.js";
import { findingSeveritySchema } from "../schemas/severity.js";

/**
 * What one `check` concluded, in a form `idiom digest` can compare without
 * rerunning anything: every gate-relevant deterministic occurrence with its
 * disposition, and the run's coverage problems. A capture artifact.
 */
export const DIGEST_RECORD_FILE = "digest.json";

const impactReason = z.enum([
  "states",
  "viewports",
  "primary",
  "interactive",
  "broken",
]);
const coverageProblemSchema = z
  .object({
    kind: z.enum(["failed", "interrupted", "busy-host"]),
    where: z.string().optional(),
    tuples: z.array(z.string()).optional(),
    detail: z.string(),
  })
  .strict();
const occurrenceSchema = z
  .object({
    id: z.string(),
    fingerprint: z.string(),
    /** Coordinate key: state/viewport[/scheme][#combination]. */
    where: z.string(),
    state: z.string(),
    viewport: z.string(),
    groupKey: z.string().optional(),
    category: z.string(),
    rule: z.string().optional(),
    severity: findingSeveritySchema,
    problem: z.string(),
    disposition: z.enum(["open", "acknowledged", "rejected"]),
    coverageOnly: z.literal(true).optional(),
    score: z.number(),
    impactReasons: z.array(impactReason),
  })
  .strict();
export const digestRecordSchema = z
  .object({
    version: z.literal(1),
    flow: z.string(),
    runId: z.string(),
    completedAt: z.iso.datetime(),
    commit: z.string(),
    dirty: z.boolean(),
    /** Relative to the project directory. */
    reportPath: z.string(),
    configHash: z.string(),
    scope: z.enum(["full", "partial"]),
    coverage: z
      .object({
        selected: z.number().int().min(0),
        captured: z.array(z.string()),
        problems: z.array(coverageProblemSchema),
      })
      .strict(),
    occurrences: z.array(occurrenceSchema),
  })
  .strict();
export type DigestRecord = z.infer<typeof digestRecordSchema>;
export type DigestOccurrence = DigestRecord["occurrences"][number];
export type DigestCoverageProblem = z.infer<typeof coverageProblemSchema>;

export async function writeDigestRecord(
  runDirectory: string,
  record: DigestRecord,
): Promise<string> {
  const path = join(runDirectory, DIGEST_RECORD_FILE);
  const temporary = `${path}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(digestRecordSchema.parse(record), null, 2)}\n`,
  );
  await rename(temporary, path);
  return path;
}

/** Missing or unreadable records are absent: an old run never breaks a digest. */
export async function readDigestRecord(
  runDirectory: string,
): Promise<DigestRecord | undefined> {
  try {
    const parsed = digestRecordSchema.safeParse(
      JSON.parse(
        await readFile(join(runDirectory, DIGEST_RECORD_FILE), "utf8"),
      ),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Tuple failures describe coverage, not design. */
export function isTupleFailure(rule: string | undefined): boolean {
  return rule?.startsWith("idiom:tuple-failure:") === true;
}

/**
 * Whether a run-record coordinate (always schemed) names the same tuple as
 * an occurrence key, which carries a scheme only on a colour-scheme axis.
 */
export function coordinateCovers(problem: string, where: string): boolean {
  const [state, viewport, scheme] = problem.split("/");
  const [ownState, ownViewport, ownScheme] = (where.split("#")[0] ?? "").split(
    "/",
  );
  return (
    state === ownState &&
    viewport === ownViewport &&
    (ownScheme === undefined || ownScheme === scheme)
  );
}

function disposition(
  finding: Finding,
): DigestOccurrence["disposition"] | undefined {
  if (finding.status === "rejected") return "rejected";
  if (!isGateOpen(finding)) return undefined;
  return finding.acknowledgement === undefined ? "open" : "acknowledged";
}

/**
 * The source identity and checks hash a run's digest record carries. Shared by
 * the digest record and the attribution computed before the report, so both
 * agree on what this run is.
 */
export function digestInputs(options: {
  scope: RunRecord | undefined;
  coverage: ReportCoverage | undefined;
  checks: Project["checks"];
}): { commit: string; dirty: boolean; configHash: string } {
  return {
    commit:
      options.scope?.source.commit ??
      options.coverage?.commits[0]?.value ??
      "unknown",
    dirty: options.scope?.source.dirty ?? false,
    configHash: checksConfigHash(options.checks),
  };
}

export function buildDigestRecord(options: {
  flow: string;
  runDirectory: string;
  projectDirectory: string;
  reportPath: string;
  occurrences: readonly Finding[];
  coverage: ReportCoverage | undefined;
  scope: RunRecord | undefined;
  captured: readonly string[];
  commit: string;
  dirty: boolean;
  configHash: string;
  rankingContext?: IssueRankingContext | undefined;
  now: Date;
}): DigestRecord {
  const occurrences = options.occurrences.flatMap(
    (finding): DigestOccurrence[] => {
      const recorded = disposition(finding);
      if (recorded === undefined) return [];
      const where = tupleCoordinateKey(finding);
      const rank = findingRank(
        finding,
        options.rankingContext,
        affectedCounts([where], options.rankingContext),
      );
      return [
        {
          id: finding.id,
          fingerprint: finding.fingerprint,
          where,
          state: finding.state,
          viewport: finding.viewport,
          ...(finding.groupKey === undefined
            ? {}
            : { groupKey: finding.groupKey }),
          category: finding.category,
          ...(finding.rule === undefined ? {} : { rule: finding.rule }),
          severity: finding.severity,
          problem: finding.explanation,
          disposition: recorded,
          ...(isTupleFailure(finding.rule)
            ? { coverageOnly: true as const }
            : {}),
          score: rank.score,
          impactReasons: rank.impactReasons,
        },
      ];
    },
  );
  const key = (coordinate: {
    state: string;
    viewport: string;
    colorScheme: string;
  }) => `${coordinate.state}/${coordinate.viewport}/${coordinate.colorScheme}`;
  const failureAt = (where: string) =>
    options.occurrences.find(
      (finding) =>
        isTupleFailure(finding.rule) &&
        coordinateCovers(where, tupleCoordinateKey(finding)),
    );
  const failedDetail = (where: string) =>
    failureAt(where)?.explanation.split("\n")[0] ??
    (options.occurrences.some(
      (finding) =>
        finding.rule?.startsWith("idiom:expectation-") === true &&
        coordinateCovers(where, tupleCoordinateKey(finding)),
    )
      ? "a declared expectation was not met"
      : "capture failed");
  const problems: DigestCoverageProblem[] = [
    ...(options.coverage?.failedTuples ?? []).map((coordinate) => ({
      kind: "failed" as const,
      where: key(coordinate),
      detail: failedDetail(key(coordinate)),
    })),
    ...(options.coverage?.unresolvedTuples ?? []).map((coordinate) =>
      failureAt(key(coordinate)) === undefined
        ? {
            kind: "interrupted" as const,
            where: key(coordinate),
            detail: "not captured",
          }
        : {
            kind: "failed" as const,
            where: key(coordinate),
            detail: failedDetail(key(coordinate)),
          },
    ),
  ];
  return {
    version: 1,
    flow: options.flow,
    runId: basename(options.runDirectory),
    completedAt: options.now.toISOString(),
    commit: options.commit,
    dirty: options.dirty,
    reportPath: relative(options.projectDirectory, options.reportPath),
    configHash: options.configHash,
    scope:
      options.scope === undefined ||
      options.scope.selected.length === options.scope.declared.length
        ? "full"
        : "partial",
    coverage: {
      selected:
        options.scope?.selected.length ?? options.coverage?.selectedTuples ?? 0,
      captured: [...new Set(options.captured)].sort(),
      problems,
    },
    occurrences,
  };
}
