import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readDecisionLog } from "../decisions/log.js";
import { IdiomError } from "../errors.js";
import { repairPresentation } from "../repair/presentation.js";
import { assertEvidencePaths } from "../review/artifacts.js";
import {
  type CatalogFinding,
  checkpointLineageStatus,
  findCatalogLineage,
  loadReviewCatalog,
  persistCatalogFindingNames,
  type ReviewCatalog,
} from "../review/catalog.js";
import { lineageDecision } from "../review/lifecycle.js";
import {
  type ClusterCause,
  type ClusterMember,
  clusterTicketId,
  componentFor,
  type FindingCluster,
  groupFindings,
  observationLoader,
} from "./cluster.js";
import {
  indexTickets,
  type MalformedTicket,
  malformedFromFindingNames,
  malformedTickets,
  malformedTicketsForLineage,
  readIndexedTicket,
  ticketsForLineage,
  unionMalformed,
} from "./index.js";
import { rankClusters, type TicketScores } from "./ranking.js";
import { renderClusterTicket } from "./render.js";
import { sweepTicketEvidence } from "./sweep-evidence.js";
import { physicalPath, resolveTicketTarget } from "./target.js";

export type ClusterTicketOutcome =
  | { kind: "created"; findingIds: string[]; ticketId: string; path: string }
  | { kind: "already-emitted"; findingId: string; path: string; state: string }
  | { kind: "already-resolved"; findingId: string; status: string }
  | { kind: "conflict"; findingId: string; paths: string[] }
  /** A malformed tracker ticket may own this lineage; nothing was emitted. */
  | { kind: "blocked"; findingId: string; paths: string[] };
export type ClusterTicketsResult = {
  projectDirectory: string;
  outputDirectory: string;
  createdPaths: string[];
  outcomes: ClusterTicketOutcome[];
  ineligible: string[];
  /** Tracker tickets whose embedded records don't parse; reported, not thrown. */
  malformed: MalformedTicket[];
  omittedCount?: number;
  selectedClusters?: FindingCluster[];
};
export type ClusterTicketsOptions = {
  project?: string | undefined;
  cwd?: string | undefined;
  findingIds?: string[] | undefined;
  out?: string | undefined;
  /** Root cause per source finding id (before lineage canonicalisation). */
  rootCauses?: ReadonlyMap<string, ClusterCause> | undefined;
  issueScores?: TicketScores | undefined;
  /** Ignore the primary checkout's finding names; defaults to the config. */
  isolatedRegistry?: boolean | undefined;
};

export async function emitClusterTickets(
  options: ClusterTicketsOptions & {
    /** A check passes exact persisted current-run records, including an explicitly empty set. */
    maxTickets?: number | undefined;
    orderedClusters?: FindingCluster[] | undefined;
    occurrences?: CatalogFinding[] | undefined;
    selection?:
      | { policy: "current-run"; records: CatalogFinding[] }
      | undefined;
  },
): Promise<ClusterTicketsResult> {
  const catalog = await loadReviewCatalog(options);
  // Validate the destination and parse every existing ticket before any name/status write.
  const target = await resolveTicketTarget({
    ...options,
    projectDirectory: catalog.projectDirectory,
  });
  const index = await indexTickets([
    target.canonicalRoot,
    target.root,
    join(catalog.projectDirectory, ".autobuild/tickets"),
  ]);
  const decisions = await readDecisionLog(catalog.projectDirectory);
  const selected =
    options.selection === undefined
      ? options.findingIds === undefined || options.findingIds.length === 0
        ? catalog.findings
        : options.findingIds.map((id) => findCatalogLineage(catalog, id).latest)
      : options.selection.records;
  const unique = new Map(
    selected.map((record) => [
      findCatalogLineage(catalog, record.finding.id).id,
      record,
    ]),
  );
  const result: ClusterTicketsResult = {
    projectDirectory: catalog.projectDirectory,
    outputDirectory: target.outputDirectory,
    createdPaths: [],
    outcomes: [],
    ineligible: [],
    malformed: unionMalformed(
      malformedTickets(index),
      await Promise.all(
        malformedFromFindingNames(catalog.names.malformedTickets).map(
          async (ticket) => ({
            ...ticket,
            path: await physicalPath(ticket.path),
          }),
        ),
      ),
    ),
    omittedCount: 0,
    selectedClusters: [],
  };
  const pending: ClusterMember[] = [];
  const availableImages = new Map<string, string[]>();
  const loadObservations = observationLoader();
  const checkpoint = new Set<string>();
  const acceptedIds = new Set<string>();
  for (const [id, record] of [...unique].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const lineage = findCatalogLineage(catalog, id);
    const accepted =
      lineageDecision(lineage, decisions, record)?.decision === "accept";
    const blockers = malformedTicketsForLineage(index, lineage);
    if (blockers.length > 0) {
      result.outcomes.push({
        kind: "blocked",
        findingId: id,
        paths: blockers.map((ticket) => ticket.path),
      });
      continue;
    }
    if (accepted) acceptedIds.add(id);
    const owners = ticketsForLineage(index, lineage);
    if (owners.length > 1) {
      result.outcomes.push({
        kind: "conflict",
        findingId: id,
        paths: owners.map((owner) => owner.path),
      });
      continue;
    }
    const owner = owners[0];
    if (owner !== undefined) {
      result.outcomes.push({
        kind: "already-emitted",
        findingId: id,
        path: owner.path,
        state: owner.state,
      });
      if (accepted && owner.root === target.canonicalRoot) checkpoint.add(id);
      continue;
    }
    const terminal = lineage.occurrences.find((occurrence) =>
      ["ticketed", "verified-fixed", "verify-failed"].includes(
        occurrence.finding.status,
      ),
    );
    if (terminal !== undefined) {
      result.outcomes.push({
        kind: "already-resolved",
        findingId: id,
        status: terminal.finding.status,
      });
      continue;
    }
    if (!accepted && options.selection === undefined) {
      result.ineligible.push(id);
      continue;
    }
    if (
      options.selection !== undefined &&
      !["open", "approved"].includes(record.finding.status)
    ) {
      result.ineligible.push(id);
      continue;
    }
    const { member, images } = await buildClusterMember(catalog, record, {
      id,
      cause: options.rootCauses?.get(record.finding.id),
      loadObservations,
    });
    pending.push(member);
    availableImages.set(id, images);
  }
  if (pending.length === 0 && checkpoint.size === 0) return result;
  await persistCatalogFindingNames(catalog);
  const pendingById = new Map(pending.map((member) => [member.id, member]));
  const canonicalScores = new Map<string, number>();
  for (const [id, score] of options.issueScores ?? []) {
    const canonicalId = findCatalogLineage(catalog, id).id;
    canonicalScores.set(
      canonicalId,
      Math.max(canonicalScores.get(canonicalId) ?? -Infinity, score),
    );
  }
  const candidates =
    options.orderedClusters === undefined
      ? rankClusters(groupFindings(pending), canonicalScores)
      : options.orderedClusters
          .map((cluster) => ({
            ...cluster,
            members: cluster.members.flatMap((member) => {
              const canonicalId = findCatalogLineage(catalog, member.id).id;
              const available = pendingById.get(canonicalId);
              return available === undefined ? [] : [available];
            }),
          }))
          .filter((cluster) => cluster.members.length > 0);
  const selectedClusters = candidates.slice(
    0,
    options.maxTickets ?? candidates.length,
  );
  result.omittedCount = candidates.length - selectedClusters.length;
  result.selectedClusters = selectedClusters;
  for (const cluster of selectedClusters) {
    const id = clusterTicketId(cluster);
    const rendered = renderClusterTicket({
      cluster,
      id,
      ticketDirectory: target.outputDirectory,
      availableImages,
    });
    const extraEvidence =
      options.occurrences === undefined
        ? ""
        : await sweepTicketEvidence({
            cluster,
            id,
            directory: target.outputDirectory,
            projectDirectory: catalog.projectDirectory,
            occurrences: options.occurrences.map((record) => ({
              ...record,
              finding: {
                ...record.finding,
                id: findCatalogLineage(catalog, record.finding.id).id,
              },
            })),
          });
    const path = join(target.outputDirectory, `${id}.md`);
    await mkdir(target.outputDirectory, { recursive: true });
    let existed = false;
    try {
      await writeFile(path, rendered.body + extraEvidence, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new IdiomError(
          `cannot create ticket ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      existed = true;
    }
    const published = await readIndexedTicket(path, target.root, "triage");
    if (published.error !== undefined) {
      // Only an existing same-name file can be malformed; it owns nothing provably.
      for (const member of cluster.members)
        result.outcomes.push({
          kind: "blocked",
          findingId: member.id,
          paths: [path],
        });
      result.malformed = unionMalformed(result.malformed, [
        { path, state: published.state, error: published.error },
      ]);
      continue;
    }
    index.push(published);
    if (existed) {
      // A same-name file is only a retry when its embedded identities cover each member.
      for (const member of cluster.members) {
        const owners = ticketsForLineage(
          index,
          findCatalogLineage(catalog, member.id),
        );
        if (owners.length !== 1 || owners[0]?.path !== path) {
          result.outcomes.push({
            kind: "conflict",
            findingId: member.id,
            paths: [
              path,
              ...owners
                .filter((owner) => owner.path !== path)
                .map((owner) => owner.path),
            ],
          });
          continue;
        }
        result.outcomes.push({
          kind: "already-emitted",
          findingId: member.id,
          path,
          state: "triage",
        });
        if (target.canonical && acceptedIds.has(member.id))
          checkpoint.add(member.id);
      }
    } else {
      result.createdPaths.push(path);
      result.outcomes.push({
        kind: "created",
        findingIds: cluster.members.map((member) => member.id),
        ticketId: id,
        path,
      });
      if (target.canonical)
        for (const member of cluster.members)
          if (acceptedIds.has(member.id)) checkpoint.add(member.id);
    }
  }
  for (const findingId of checkpoint)
    await checkpointLineageStatus({ catalog, findingId, status: "ticketed" });
  return result;
}

/**
 * One record as a cluster member: its canonical presentation keeping this
 * occurrence's fingerprint, its component and cause, and the screenshots
 * that still exist on disk.
 */
export async function buildClusterMember(
  catalog: ReviewCatalog,
  record: CatalogFinding,
  options: {
    /** The lineage id the member is known by. */
    id: string;
    cause?: ClusterCause | undefined;
    loadObservations: ReturnType<typeof observationLoader>;
  },
): Promise<{ member: ClusterMember; images: string[] }> {
  const { id, cause } = options;
  const observations = await options.loadObservations(record);
  const presented = repairPresentation(catalog, record).target;
  // Presentation supplies canonical IDs/aliases; clustered evidence retains this occurrence's fingerprint.
  const canonical = {
    ...presented,
    finding: {
      ...presented.finding,
      fingerprint: record.finding.fingerprint,
    },
  };
  const member: ClusterMember = {
    id,
    record: canonical,
    component: componentFor(record, id, observations),
    ...(cause === undefined ? {} : { cause }),
  };
  const images: string[] = [];
  for (const image of record.finding.evidence.screenshots) {
    try {
      await assertEvidencePaths(record.runDirectory, [image]);
      images.push(image);
    } catch (error) {
      if (!(error instanceof IdiomError)) throw error;
      // Missing legacy screenshots are explicitly described as unavailable.
    }
  }
  return { member, images };
}

export function renderClusterTicketsResult(
  result: ClusterTicketsResult,
): string {
  const created = result.outcomes.filter(
    (outcome) => outcome.kind === "created",
  ).length;
  const conflicts = result.outcomes.filter(
    (outcome) => outcome.kind === "conflict",
  ).length;
  const blocked = result.outcomes.filter(
    (outcome) => outcome.kind === "blocked",
  ).length;
  const skipped = result.outcomes.length - created - conflicts - blocked;
  return [
    `Tickets: ${created} created, ${skipped} skipped, ${conflicts} conflict(s), ${blocked > 0 ? `${blocked} blocked, ` : ""}${result.ineligible.length} ineligible — ${result.outputDirectory}`,
    ...result.outcomes.map((outcome) =>
      outcome.kind === "created"
        ? `${outcome.findingIds.join(", ")}: created ${outcome.path}`
        : outcome.kind === "conflict"
          ? `${outcome.findingId}: conflict — ${outcome.paths.join(", ")}`
          : outcome.kind === "blocked"
            ? `${outcome.findingId}: blocked by malformed tracker ticket — ${outcome.paths.join(", ")}`
            : outcome.kind === "already-emitted"
              ? `${outcome.findingId}: already emitted in ${outcome.state} — ${outcome.path}`
              : `${outcome.findingId}: already resolved (${outcome.status})`,
    ),
    ...result.ineligible.map((id) => `${id}: not eligible; no ticket emitted`),
    ...result.malformed.map(
      (ticket) => `malformed tracker ticket: ${ticket.error}`,
    ),
  ].join("\n");
}
