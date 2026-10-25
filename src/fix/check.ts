import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { tupleCoordinateKey } from "../baseline/coordinate.js";
import {
  captureTupleKey,
  expectedCaptureTupleKeys,
} from "../capture/resolve.js";
import { checksConfigFrom } from "../checks/registry.js";
import { type CheckSummary, checkWithReview } from "../commands/check.js";
import { readDecisionLog } from "../decisions/log.js";
import { IdiomError } from "../errors.js";
import { loadRunTuples } from "../review/artifacts.js";
import {
  type CatalogFinding,
  findCatalogLineage,
  loadReviewCatalog,
  type ReviewCatalog,
} from "../review/catalog.js";
import { lineageDecision } from "../review/lifecycle.js";
import type { ReviewDependencies } from "../review/run.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import { validateProject } from "../validation.js";
import { deterministicCandidateRecords } from "../verify/evaluate.js";
import type { Occurrence } from "./compare.js";

export type FixSnapshot = {
  projectDirectory: string;
  runDirectory: string;
  summary: CheckSummary;
  catalog: ReviewCatalog;
  records: CatalogFinding[];
  occurrences: Finding[];
  raw: Occurrence[];
  eligible: Occurrence[];
  configuration: string;
  designFile: string;
};

export async function eligibleRecords(
  snapshot: FixSnapshot,
): Promise<CatalogFinding[]> {
  const decisions = await readDecisionLog(snapshot.projectDirectory);
  return snapshot.records.filter((record) =>
    repairEligible(snapshot.catalog, decisions, record),
  );
}

/** Match check's open-work statuses for both assignment and remaining counts. */
function repairEligible(
  catalog: ReviewCatalog,
  decisions: Awaited<ReturnType<typeof readDecisionLog>>,
  record: CatalogFinding,
): boolean {
  return (
    (record.finding.status === "open" ||
      record.finding.status === "approved") &&
    lineageDecision(
      findCatalogLineage(catalog, record.finding.id),
      decisions,
      record,
    )?.decision !== "reject"
  );
}

export async function refreshEligibility(snapshot: FixSnapshot): Promise<void> {
  const decisions = await readDecisionLog(snapshot.projectDirectory);
  snapshot.eligible = snapshot.raw.filter((candidate) =>
    snapshot.occurrences.some(
      (finding) =>
        tupleCoordinateKey(finding) === candidate.key &&
        [candidate.fingerprint, ...candidate.aliases].includes(
          finding.fingerprint,
        ) &&
        repairEligible(snapshot.catalog, decisions, {
          finding,
          runId: basename(snapshot.runDirectory),
          runDirectory: snapshot.runDirectory,
          findingsPath: resolve(snapshot.runDirectory, "findings.json"),
        }),
    ),
  );
}

export function selectTargets(
  snapshot: FixSnapshot,
  records: CatalogFinding[],
  top: number,
): CatalogFinding[] {
  const byId = new Map(records.map((record) => [record.finding.id, record]));
  const groups = new Map(
    snapshot.summary.groups?.map((group) => [group.id, group]),
  );
  const ordered =
    snapshot.summary.issues?.flatMap((issue) =>
      issue.groups.flatMap(
        (id) => groups.get(id)?.members.map((member) => member.id) ?? [],
      ),
    ) ?? snapshot.summary.findings.map((finding) => finding.id);
  return [...new Set(ordered)]
    .flatMap((id) => {
      const record = byId.get(id);
      return record === undefined ? [] : [record];
    })
    .slice(0, top);
}

export async function takeFixSnapshot(options: {
  flow: string;
  project?: string | undefined;
  cwd?: string | undefined;
  dependencies?: ReviewDependencies | undefined;
}): Promise<FixSnapshot> {
  const validated = await validateProject(options);
  const flow = validated.flows[0]?.flow;
  if (!flow) throw new IdiomError(`flow ${options.flow} was not validated`);
  const { summary, review } = await checkWithReview({
    ...options,
    all: true,
    materializeAllDeterministic: true,
  });
  const loaded = await loadRunTuples(validated, flow, review.runDirectory);
  const expected = expectedCaptureTupleKeys({
    project: validated.project,
    flow,
    collapsed: loaded.collapsedTupleKeys,
  });
  const actual = loaded.tuples.map((tuple) =>
    captureTupleKey({
      ...tuple,
      colorScheme: tuple.colorScheme ?? validated.project.capture.colorScheme,
    }),
  );
  if (
    expected.some((key) => !actual.includes(key)) ||
    actual.some((key) => !expected.includes(key)) ||
    new Set(actual).size !== actual.length ||
    loaded.tuples.some(
      (tuple) =>
        tuple.failure !== undefined ||
        tuple.mismatches.length > 0 ||
        tuple.observations === undefined,
    ) ||
    (summary.coverage?.unresolvedTuples?.length ?? 0) > 0 ||
    (summary.coverage?.failedTuples?.length ?? 0) > 0 ||
    (summary.coverage?.omittedStates?.length ?? 0) > 0 ||
    (summary.coverage?.omittedViewports?.length ?? 0) > 0 ||
    (summary.coverage?.omittedSchemes?.length ?? 0) > 0
  ) {
    throw new IdiomError(
      "fix requires complete successful full-flow capture coverage; a missing or failed tuple cannot prove a fix",
    );
  }
  const findings = findingSchema
    .array()
    .parse(JSON.parse(await readFile(review.findingsPath, "utf8")));
  const catalog = await loadReviewCatalog({
    project: validated.projectDirectory,
  });
  const snapshot: FixSnapshot = {
    projectDirectory: validated.projectDirectory,
    runDirectory: resolve(review.runDirectory),
    summary,
    catalog,
    records: findings
      .filter(
        (finding) =>
          finding.layer === "deterministic" &&
          finding.category !== "missing-state",
      )
      .map((finding) => ({
        finding,
        runId: loaded.runId,
        runDirectory: resolve(review.runDirectory),
        findingsPath: review.findingsPath,
      })),
    occurrences: review.deterministicOccurrences ?? findings,
    raw: deterministicCandidateRecords({
      tuples: loaded.tuples,
      expectedTupleKeys: loaded.expectedTupleKeys,
      legacyColorScheme: validated.project.capture.colorScheme,
      config: checksConfigFrom(validated.project.checks),
    }),
    eligible: [],
    // Include flow, policy and design rules: agents must repair the application, not weaken the evidence contract.
    configuration: JSON.stringify({
      project: validated.project,
      flow,
      rules: validated.rules,
      design: await readFile(
        resolve(
          validated.projectDirectory,
          validated.project.design.specFile ?? "DESIGN.md",
        ),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    }),
    designFile: resolve(
      validated.projectDirectory,
      validated.project.design.specFile ?? "DESIGN.md",
    ),
  };
  await refreshEligibility(snapshot);
  return snapshot;
}
