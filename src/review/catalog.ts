import type { Dirent } from "node:fs";
import { access, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readDecisionLog } from "../decisions/log.js";
import { IdiomError } from "../errors.js";
import { findProjectDirectory, resolveProjectArgument } from "../project.js";
import type { Decision } from "../schemas/decision.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import { lineageDecision } from "./lifecycle.js";
import {
  type FindingNamesState,
  loadFindingNames,
  persistFindingNames,
  registryEntryForFinding,
} from "./names.js";

export type CatalogFinding = {
  finding: Finding;
  runId: string;
  runDirectory: string;
  findingsPath: string;
};

export type FindingIdentityPair = {
  fingerprint: string;
  findingId: string;
};

export type FindingLineage = {
  id: string;
  first: CatalogFinding;
  latest: CatalogFinding;
  occurrences: CatalogFinding[];
  ids: string[];
  fingerprints: string[];
  identities: FindingIdentityPair[];
};

export type ReviewCatalog = {
  projectDirectory: string;
  names: FindingNamesState;
  runs: Array<{
    runId: string;
    runDirectory: string;
    findingsPath: string;
    findings: CatalogFinding[];
  }>;
  /** Latest occurrence of every lineage. */
  findings: CatalogFinding[];
  lineages: FindingLineage[];
};

function issueText(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

async function readFindings(path: string): Promise<Finding[] | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new IdiomError(
      `cannot read reviewed findings ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(value))
    throw new IdiomError(
      `invalid reviewed findings ${path}: <root>: expected an array`,
    );
  return value.map((item, index) => {
    const parsed = findingSchema.safeParse(item);
    if (!parsed.success) {
      throw new IdiomError(
        `invalid reviewed findings ${path}: ${index}.${issueText(parsed.error)}`,
      );
    }
    return parsed.data;
  });
}

function compatible(left: Finding, right: Finding): boolean {
  return (
    left.flow === right.flow &&
    left.state === right.state &&
    left.category === right.category &&
    left.rule === right.rule &&
    (left.colorScheme === undefined ||
      right.colorScheme === undefined ||
      left.colorScheme === right.colorScheme)
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function addToLineage(lineage: FindingLineage, record: CatalogFinding): void {
  lineage.occurrences.push(record);
  lineage.latest = record;
  lineage.ids = unique([
    ...lineage.ids,
    record.finding.id,
    ...(record.finding.idAliases ?? []),
  ]);
  lineage.fingerprints = unique([
    ...lineage.fingerprints,
    record.finding.fingerprint,
  ]);
  for (const findingId of [
    record.finding.id,
    ...(record.finding.idAliases ?? []),
  ])
    if (
      !lineage.identities.some(
        (identity) =>
          identity.fingerprint === record.finding.fingerprint &&
          identity.findingId === findingId,
      )
    )
      lineage.identities.push({
        fingerprint: record.finding.fingerprint,
        findingId,
      });
}

function buildLineages(
  records: CatalogFinding[],
  names: FindingNamesState,
  decisions: readonly Decision[],
): FindingLineage[] {
  const lineages: FindingLineage[] = [];
  for (const record of records) {
    const registry = registryEntryForFinding(names, record.finding);
    const recordIds = unique([
      registry.name,
      ...registry.legacyIds,
      record.finding.id,
      ...(record.finding.idAliases ?? []),
    ]);
    const idMatches = lineages.filter((lineage) =>
      lineage.ids.some((id) => recordIds.includes(id)),
    );
    if (
      idMatches.some(
        (lineage) => !compatible(lineage.first.finding, record.finding),
      )
    ) {
      const existing = idMatches[0];
      throw new IdiomError(
        `ambiguous finding id ${JSON.stringify(record.finding.id)} appears in ${existing?.latest.findingsPath} and ${record.findingsPath} for unrelated findings`,
      );
    }
    const fingerprintMatches = lineages.filter(
      (lineage) =>
        lineage.latest.runId !== record.runId &&
        (lineage.fingerprints.includes(record.finding.fingerprint) ||
          registry.fingerprints.some((fingerprint) =>
            lineage.fingerprints.includes(fingerprint),
          )) &&
        compatible(lineage.first.finding, record.finding),
    );
    const matches = unique([...idMatches, ...fingerprintMatches]);
    if (matches.length > 1) {
      throw new IdiomError(
        `ambiguous finding lineage for ${JSON.stringify(record.finding.id)} in ${record.findingsPath}`,
      );
    }
    const lineage = matches[0];
    if (lineage === undefined) {
      lineages.push({
        id: registry.name,
        first: record,
        latest: record,
        occurrences: [record],
        ids: recordIds,
        fingerprints: unique([
          record.finding.fingerprint,
          ...registry.fingerprints,
        ]),
        identities: [
          record.finding.id,
          ...(record.finding.idAliases ?? []),
        ].map((findingId) => ({
          fingerprint: record.finding.fingerprint,
          findingId,
        })),
      });
    } else {
      addToLineage(lineage, record);
    }
  }
  const owners = new Map<string, FindingLineage>();
  for (const lineage of lineages) {
    for (const id of lineage.ids) {
      const owner = owners.get(id);
      if (owner !== undefined && owner !== lineage)
        throw new IdiomError(
          `ambiguous finding id ${JSON.stringify(id)} resolves to multiple lineages`,
        );
      owners.set(id, lineage);
    }
    for (const decision of decisions) {
      if (
        !lineage.ids.includes(decision.findingId) ||
        !lineage.fingerprints.includes(decision.fingerprint) ||
        lineage.identities.some(
          (identity) =>
            identity.findingId === decision.findingId &&
            identity.fingerprint === decision.fingerprint,
        )
      )
        continue;
      lineage.identities.push({
        findingId: decision.findingId,
        fingerprint: decision.fingerprint,
      });
    }
  }
  return lineages;
}

export function reportRootsFor(
  projectDirectory: string,
  additionalReportRoots: readonly string[] = [],
): string[] {
  const roots = [
    resolve(projectDirectory, ".idiom", "reports"),
    ...additionalReportRoots.map((root) => resolve(root)),
  ];
  return roots.filter((root, index) => roots.indexOf(root) === index);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Whether any resolved report root is present on disk. A root that exists but
 * holds no runs is a genuine answer — the project simply has not been reviewed
 * yet — not missing state.
 */
export async function anyReportRootExists(
  roots: readonly string[],
): Promise<boolean> {
  for (const root of roots) if (await exists(root)) return true;
  return false;
}

export async function loadReviewCatalog(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  /**
   * Report roots consulted after the project's own. Defaults to none, so every
   * caller other than `idiom context` reads exactly one checkout.
   */
  additionalReportRoots?: readonly string[] | undefined;
  /** Tracker roots available for finding-name migration evidence. */
  additionalTrackerRoots?: readonly string[] | undefined;
}): Promise<ReviewCatalog> {
  const projectDirectory = await findProjectDirectory(
    resolveProjectArgument(options.project, options.cwd),
  );

  // A run ID is the merge key, and the first root holding it wins, so the
  // project's own reports always take precedence over an inherited copy.
  const merged = new Map<string, { runDirectory: string }>();
  for (const root of reportRootsFor(
    projectDirectory,
    options.additionalReportRoots,
  )) {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new IdiomError(
        `cannot enumerate review reports ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of entries.filter((candidate) =>
      candidate.isDirectory(),
    )) {
      if (merged.has(entry.name)) continue;
      merged.set(entry.name, { runDirectory: resolve(root, entry.name) });
    }
  }

  const names = await loadFindingNames({
    projectDirectory,
    additionalReportRoots: options.additionalReportRoots,
    additionalTrackerRoots: options.additionalTrackerRoots,
  });
  const runs: ReviewCatalog["runs"] = [];
  const all: CatalogFinding[] = [];
  for (const [runId, { runDirectory }] of [...merged.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const findingsPath = join(runDirectory, "findings.json");
    const findings = await readFindings(findingsPath);
    if (findings === undefined) continue;
    const records = findings.map((finding) => ({
      finding,
      runId,
      runDirectory,
      findingsPath,
    }));
    all.push(...records);
    runs.push({ runId, runDirectory, findingsPath, findings: records });
  }
  const lineages = buildLineages(
    all,
    names,
    await readDecisionLog(projectDirectory),
  );
  return {
    projectDirectory,
    names,
    runs,
    findings: lineages.map((lineage) => lineage.latest),
    lineages,
  };
}

/** Persist a catalog's in-memory migration before a command publishes output. */
export async function persistCatalogFindingNames(
  catalog: ReviewCatalog,
): Promise<string> {
  return persistFindingNames(catalog.names);
}

export function findCatalogLineage(
  catalog: ReviewCatalog,
  findingId: string,
): FindingLineage {
  const matches = catalog.lineages.filter((lineage) =>
    lineage.ids.includes(findingId),
  );
  if (matches.length === 0)
    throw new IdiomError(`unknown finding id ${JSON.stringify(findingId)}`);
  if (matches.length > 1)
    throw new IdiomError(`ambiguous finding id ${JSON.stringify(findingId)}`);
  const match = matches[0];
  if (match === undefined)
    throw new IdiomError(`unknown finding id ${JSON.stringify(findingId)}`);
  return match;
}

export function findCatalogFinding(
  catalog: ReviewCatalog,
  findingId: string,
): CatalogFinding {
  return findCatalogLineage(catalog, findingId).latest;
}

export function newestOpenFindings(
  catalog: ReviewCatalog,
  decisions: readonly Decision[],
): CatalogFinding[] {
  return (
    catalog.runs.at(-1)?.findings.filter((record) => {
      const lineage = findCatalogLineage(catalog, record.finding.id);
      return lineageDecision(lineage, decisions, record) === undefined;
    }) ?? []
  );
}

export async function checkpointLineageStatus(options: {
  catalog: ReviewCatalog;
  findingId: string;
  status: "ticketed" | "verified-fixed" | "verify-failed";
}): Promise<CatalogFinding> {
  const lineage = findCatalogLineage(options.catalog, options.findingId);
  const target = lineage.latest;
  const source = await readFindings(target.findingsPath);
  if (source === undefined)
    throw new IdiomError(
      `reviewed findings disappeared: ${target.findingsPath}`,
    );
  const index = source.findIndex((finding) => finding.id === target.finding.id);
  if (index < 0)
    throw new IdiomError(
      `finding ${target.finding.id} disappeared from ${target.findingsPath}`,
    );
  const updated = findingSchema.parse({
    ...source[index],
    status:
      options.status === "ticketed" &&
      (source[index]?.status === "verified-fixed" ||
        source[index]?.status === "verify-failed")
        ? source[index]?.status
        : options.status,
  });
  if (
    options.status !== "ticketed" &&
    !["ticketed", "verified-fixed", "verify-failed"].includes(
      source[index]?.status ?? "open",
    )
  ) {
    throw new IdiomError(
      `cannot checkpoint ${options.status} for ${lineage.id} before ticketed`,
    );
  }
  source[index] = updated;
  const temporary = `${target.findingsPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  await rename(temporary, target.findingsPath);
  target.finding = updated;
  lineage.latest.finding = updated;
  return target;
}
