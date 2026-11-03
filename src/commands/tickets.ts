import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { readDecisionLog } from "../decisions/log.js";
import { IdiomError } from "../errors.js";
import { repairPresentation, reviewFindings } from "../repair/presentation.js";
import {
  type CatalogFinding,
  checkpointLineageStatus,
  findCatalogFinding,
  findCatalogLineage,
  loadReviewCatalog,
  persistCatalogFindingNames,
} from "../review/catalog.js";
import { lineageDecision } from "../review/lifecycle.js";
import {
  indexTrackerTickets,
  resolveEmbeddedTicket,
  TRACKER_TICKET_STATES,
  type TrackerTicketState,
} from "../tickets/embedded.js";
import {
  lineageMentionedBy,
  type MalformedTicket,
  malformedFromFindingNames,
  unionMalformed,
} from "../tickets/index.js";
import { rankTicketRecords } from "../tickets/ranking.js";
import { renderTicket, ticketIdsForIdentities } from "../tickets/render.js";
import { parseFindingBlocks } from "../verify/spec.js";

export type TicketOutcome =
  | {
      kind: "created";
      findingId: string;
      ticketId: string;
      path: string;
    }
  | {
      kind: "already-emitted";
      findingId: string;
      ticketId: string;
      path: string;
      state?: TrackerTicketState | undefined;
      unchanged: boolean;
    }
  | {
      kind: "already-resolved";
      findingId: string;
      status: "ticketed" | "verified-fixed";
      path?: string | undefined;
      state?: TrackerTicketState | undefined;
    }
  | {
      kind: "conflict";
      findingId: string;
      ticketId: string;
      paths: string[];
    }
  | {
      /** A malformed tracker ticket may own this lineage; nothing was emitted. */
      kind: "blocked";
      findingId: string;
      paths: string[];
    };

export type TicketsResult = {
  projectDirectory: string;
  outputDirectory: string;
  outcomes: TicketOutcome[];
  ineligible: string[];
  /** Tracker tickets whose embedded records don't parse; reported, not thrown. */
  malformed: MalformedTicket[];
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function lifecycleResolutionStatus(
  lineage: ReturnType<typeof findCatalogLineage>,
): "ticketed" | "verified-fixed" | undefined {
  if (
    lineage.occurrences.some(
      (occurrence) => occurrence.finding.status === "verified-fixed",
    )
  )
    return "verified-fixed";
  if (
    lineage.occurrences.some(
      (occurrence) => occurrence.finding.status === "ticketed",
    )
  )
    return "ticketed";
  return undefined;
}

function outputPath(out: string, cwd: string | undefined): string {
  return isAbsolute(out) ? resolve(out) : resolve(cwd ?? process.cwd(), out);
}

function canonicalTicketOptions(
  catalog: Awaited<ReturnType<typeof loadReviewCatalog>>,
  record: CatalogFinding,
  ticketDirectory: string,
) {
  const lineage = findCatalogLineage(catalog, record.finding.id);
  const firstIdentity = lineage.identities[0] ?? {
    fingerprint: lineage.first.finding.fingerprint,
    findingId: lineage.first.finding.id,
  };
  return {
    record,
    sourceFindings: reviewFindings(catalog, record),
    ticketDirectory,
    identity: {
      fingerprint: firstIdentity.fingerprint,
      findingId: lineage.id,
    },
    presentation: repairPresentation(catalog, record),
  };
}

function compatibleTicketBodies(
  catalog: Awaited<ReturnType<typeof loadReviewCatalog>>,
  lineage: ReturnType<typeof findCatalogLineage>,
  ticketDirectory: string,
): string[] {
  const identities =
    lineage.identities.length > 0
      ? lineage.identities
      : [
          {
            fingerprint: lineage.first.finding.fingerprint,
            findingId: lineage.first.finding.id,
          },
        ];
  return identities.map(
    (identity) =>
      renderTicket({
        record: lineage.latest,
        sourceFindings: reviewFindings(catalog, lineage.latest),
        ticketDirectory,
        identity,
        // No presentation: this intentionally reproduces the pre-migration
        // rendering, including the latest content and raw sibling IDs.
      }).body,
  );
}

function ticketBytesAreKnown(
  source: string,
  canonical: string,
  legacy: readonly string[],
): boolean {
  const normalized = (body: string) =>
    body.replace(
      /(`{3,})idiom:finding\r?\n([\s\S]*?)\r?\n\1/g,
      (_block, fence, json) => {
        const sort = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(sort)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => [k, sort(v)]),
                )
              : value;
        return `${fence}idiom:finding\n${JSON.stringify(sort(parseFindingBlocks(`${fence}idiom:finding\n${json}\n${fence}`)[0]))}\n${fence}`;
      },
    );
  return [canonical, ...legacy].some(
    (body) => normalized(source) === normalized(body),
  );
}

export async function ticketsCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  findingIds?: string[] | undefined;
  out?: string | undefined;
}): Promise<TicketsResult> {
  const catalog = await loadReviewCatalog(options);
  const decisions = await readDecisionLog(catalog.projectDirectory);
  const defaultRoot = join(catalog.projectDirectory, ".autobuild", "tickets");
  const defaultTriage = join(defaultRoot, "triage");
  const outputDirectory =
    options.out === undefined
      ? defaultTriage
      : outputPath(options.out, options.cwd);
  const trackerOutput = resolve(outputDirectory) === resolve(defaultTriage);
  const selected =
    options.findingIds === undefined || options.findingIds.length === 0
      ? catalog.findings
      : options.findingIds.map((id) => findCatalogFinding(catalog, id));
  const unique = new Map(
    selected.map((record) => {
      const lineage = findCatalogLineage(catalog, record.finding.id);
      return [lineage.id, lineage.latest] as const;
    }),
  );
  const trackerIndex = await indexTrackerTickets(defaultRoot);
  const ineligible: string[] = [];
  const outcomes: TicketOutcome[] = [];

  // Ticket publication and lifecycle checkpointing are mutating operations;
  // commit the migration boundary before either can cite a canonical name.
  await persistCatalogFindingNames(catalog);

  for (const record of rankTicketRecords([...unique.values()])) {
    const lineage = findCatalogLineage(catalog, record.finding.id);
    const accepted =
      lineageDecision(lineage, decisions, record)?.decision === "accept";
    const firstIdentity = lineage.identities[0] ?? {
      fingerprint: lineage.first.finding.fingerprint,
      findingId: lineage.id,
    };
    const candidateTicketIds = ticketIdsForIdentities([
      ...lineage.identities,
      { fingerprint: firstIdentity.fingerprint, findingId: lineage.id },
    ]);
    // Before the located branch: ticketBytesAreKnown would re-parse a
    // malformed same-name ticket and throw.
    const blockers = trackerIndex.malformed.filter((ticket) =>
      lineageMentionedBy(
        {
          path: ticket.path,
          source: trackerIndex.contents.get(ticket.path) ?? "",
        },
        lineage,
      ),
    );
    if (blockers.length > 0) {
      outcomes.push({
        kind: "blocked",
        findingId: lineage.id,
        paths: blockers.map((ticket) => ticket.path),
      });
      continue;
    }
    if (accepted && trackerOutput) {
      const located: Array<{
        state: TrackerTicketState;
        path: string;
        source: string;
      }> = [];
      for (const state of TRACKER_TICKET_STATES) {
        for (const candidateId of candidateTicketIds) {
          const path = join(defaultRoot, state, `${candidateId}.md`);
          const source = trackerIndex.contents.get(path);
          if (source !== undefined) located.push({ state, path, source });
        }
      }
      if (located.length > 1) {
        const rendered = renderTicket(
          canonicalTicketOptions(catalog, record, outputDirectory),
        );
        outcomes.push({
          kind: "conflict",
          findingId: lineage.id,
          ticketId: rendered.id,
          paths: located.map((item) => item.path),
        });
        continue;
      }
      const existing = located[0];
      if (existing !== undefined) {
        const rendered = renderTicket(
          canonicalTicketOptions(catalog, record, outputDirectory),
        );
        outcomes.push({
          kind: "already-emitted",
          findingId: lineage.id,
          ticketId:
            existing.path.split("/").at(-1)?.replace(/\.md$/, "") ??
            rendered.id,
          path: existing.path,
          state: existing.state,
          unchanged: ticketBytesAreKnown(
            existing.source,
            rendered.body,
            compatibleTicketBodies(catalog, lineage, outputDirectory),
          ),
        });
        await checkpointLineageStatus({
          catalog,
          findingId: lineage.id,
          status: "ticketed",
        });
        continue;
      }
    } else if (accepted) {
      try {
        const located: string[] = [];
        for (const candidateId of candidateTicketIds) {
          const candidate = join(outputDirectory, `${candidateId}.md`);
          if (await exists(candidate)) located.push(candidate);
        }
        if (located.length > 1) {
          const rendered = renderTicket(
            canonicalTicketOptions(catalog, record, outputDirectory),
          );
          outcomes.push({
            kind: "conflict",
            findingId: lineage.id,
            ticketId: rendered.id,
            paths: located,
          });
          continue;
        }
        const path = located[0];
        if (located.length === 1) {
          if (path === undefined) continue;
          const rendered = renderTicket(
            canonicalTicketOptions(catalog, record, outputDirectory),
          );
          outcomes.push({
            kind: "already-emitted",
            findingId: lineage.id,
            ticketId:
              path.split("/").at(-1)?.replace(/\.md$/, "") ?? rendered.id,
            path,
            unchanged: ticketBytesAreKnown(
              await readFile(path, "utf8"),
              rendered.body,
              compatibleTicketBodies(catalog, lineage, outputDirectory),
            ),
          });
          continue;
        }
      } catch (error) {
        throw new IdiomError(
          `cannot inspect ticket output ${outputDirectory}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const lifecycleStatus = lifecycleResolutionStatus(lineage);
    const embedded = resolveEmbeddedTicket(trackerIndex, lineage);
    if (embedded.kind === "conflict") {
      outcomes.push({
        kind: "conflict",
        findingId: lineage.id,
        ticketId: renderTicket(
          canonicalTicketOptions(catalog, record, outputDirectory),
        ).id,
        paths: embedded.paths,
      });
      continue;
    }
    const embeddedTicket =
      embedded.kind === "single" ? embedded.ticket : undefined;
    if (lifecycleStatus !== undefined || embeddedTicket !== undefined) {
      const status = lifecycleStatus ?? "ticketed";
      if (lifecycleStatus === undefined) {
        await checkpointLineageStatus({
          catalog,
          findingId: lineage.id,
          status: "ticketed",
        });
      }
      outcomes.push({
        kind: "already-resolved",
        findingId: lineage.id,
        status,
        ...(embeddedTicket === undefined
          ? {}
          : { path: embeddedTicket.path, state: embeddedTicket.state }),
      });
      continue;
    }

    if (!accepted) {
      ineligible.push(lineage.id);
      continue;
    }

    const rendered = renderTicket(
      canonicalTicketOptions(catalog, record, outputDirectory),
    );
    const filename = `${rendered.id}.md`;

    const destination = join(outputDirectory, filename);
    try {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(destination, rendered.body, {
        encoding: "utf8",
        flag: "wx",
      });
      outcomes.push({
        kind: "created",
        findingId: lineage.id,
        ticketId: rendered.id,
        path: destination,
      });
      if (trackerOutput) {
        await checkpointLineageStatus({
          catalog,
          findingId: lineage.id,
          status: "ticketed",
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        outcomes.push({
          kind: "already-emitted",
          findingId: lineage.id,
          ticketId: rendered.id,
          path: destination,
          ...(trackerOutput ? { state: "triage" as const } : {}),
          unchanged: ticketBytesAreKnown(
            await readFile(destination, "utf8"),
            rendered.body,
            compatibleTicketBodies(catalog, lineage, outputDirectory),
          ),
        });
        if (trackerOutput) {
          await checkpointLineageStatus({
            catalog,
            findingId: lineage.id,
            status: "ticketed",
          });
        }
        continue;
      }
      throw new IdiomError(
        `cannot create ticket ${destination}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    projectDirectory: catalog.projectDirectory,
    outputDirectory,
    outcomes,
    ineligible,
    malformed: unionMalformed(
      trackerIndex.malformed,
      malformedFromFindingNames(catalog.names.malformedTickets),
    ),
  };
}

export { emitClusterTickets as clusterTicketsCommand } from "../tickets/emit.js";
