import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { IdiomError } from "../errors.js";
import type { FindingLineage } from "../review/catalog.js";
import type { Finding } from "../schemas/finding.js";
import { parseFindingBlocks } from "../verify/spec.js";
import { mentionsToken } from "./mentions.js";
import { ticketIdsForIdentities } from "./render.js";
import { physicalPath } from "./target.js";

export type IndexedTicket = {
  path: string;
  root: string;
  state: string;
  findings: Finding[];
  source: string;
  /** Set when the ticket's embedded records don't parse; it then owns nothing. */
  error?: string | undefined;
};
export type MalformedTicket = { path: string; state: string; error: string };
export async function readIndexedTicket(
  path: string,
  root: string,
  state: string,
): Promise<IndexedTicket> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new IdiomError(
      `cannot parse tracker ticket ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return { path, root, state, source, findings: parseFindingBlocks(source) };
  } catch (error) {
    return {
      path,
      root,
      state,
      source,
      findings: [],
      error: `cannot parse tracker ticket ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
export async function indexTickets(roots: string[]): Promise<IndexedTicket[]> {
  const result: IndexedTicket[] = [];
  const seen = new Set<string>();
  for (const root of new Set(await Promise.all(roots.map(physicalPath)))) {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const directories = [root];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        ["assets", "images", "crops", "attachments"].includes(
          entry.name.toLowerCase(),
        ) ||
        entry.name.startsWith(".")
      )
        continue;
      const path = join(root, entry.name);
      if (
        entry.isDirectory() ||
        (entry.isSymbolicLink() && (await stat(path)).isDirectory())
      )
        directories.push(path);
    }
    for (const directory of directories) {
      for (const entry of (
        await readdir(directory, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.toLowerCase().endsWith(".md")) continue;
        const filename = join(directory, entry.name);
        if (
          !entry.isFile() &&
          !(entry.isSymbolicLink() && (await stat(filename)).isFile())
        )
          continue;
        const path = await physicalPath(filename);
        if (seen.has(path)) continue;
        seen.add(path);
        result.push(
          await readIndexedTicket(
            path,
            root,
            directory === root ? "root" : basename(directory),
          ),
        );
      }
    }
  }
  return result;
}
export function ticketsForLineage(
  index: IndexedTicket[],
  lineage: FindingLineage,
): IndexedTicket[] {
  const names = new Set(lineage.ids);
  const fingerprints = new Set(lineage.fingerprints);
  const filenames = new Set(
    ticketIdsForIdentities([
      ...lineage.identities,
      { findingId: lineage.id, fingerprint: lineage.first.finding.fingerprint },
    ]).map((id) => `${id}.md`),
  );
  return index.filter(
    (ticket) =>
      (ticket.error === undefined && filenames.has(basename(ticket.path))) ||
      ticket.findings.some(
        (finding) =>
          [finding.id, ...(finding.idAliases ?? [])].some((id) =>
            names.has(id),
          ) ||
          (finding.flow === lineage.latest.finding.flow &&
            finding.category === lineage.latest.finding.category &&
            fingerprints.has(finding.fingerprint)),
      ),
  );
}

/**
 * Whether a malformed ticket might own the lineage: its filename is one of the
 * lineage's generated ticket ids, or its raw text names one of the lineage's
 * ids or fingerprints as a whole token.
 */
export function lineageMentionedBy(
  ticket: { path: string; source: string },
  lineage: FindingLineage,
): boolean {
  const filenames = new Set(
    ticketIdsForIdentities([
      ...lineage.identities,
      { findingId: lineage.id, fingerprint: lineage.first.finding.fingerprint },
    ]).map((id) => `${id}.md`),
  );
  if (filenames.has(basename(ticket.path))) return true;
  return [
    ...new Set([lineage.id, ...lineage.ids, ...lineage.fingerprints]),
  ].some((value) => mentionsToken(ticket.source, value));
}
export function malformedTicketsForLineage(
  index: IndexedTicket[],
  lineage: FindingLineage,
): IndexedTicket[] {
  return index.filter(
    (ticket) =>
      ticket.error !== undefined && lineageMentionedBy(ticket, lineage),
  );
}
export function malformedTickets(index: IndexedTicket[]): MalformedTicket[] {
  return index.flatMap((ticket) =>
    ticket.error === undefined
      ? []
      : [{ path: ticket.path, state: ticket.state, error: ticket.error }],
  );
}
/** Joins malformed-ticket reports by path, keeping the first seen. */
export function unionMalformed(
  ...lists: ReadonlyArray<readonly MalformedTicket[]>
): MalformedTicket[] {
  const byPath = new Map<string, MalformedTicket>();
  for (const list of lists)
    for (const ticket of list)
      if (!byPath.has(ticket.path)) byPath.set(ticket.path, ticket);
  return [...byPath.values()];
}
/** The finding-name bootstrap's malformed own tickets, as tickets results report them. */
export function malformedFromFindingNames(
  tickets: ReadonlyArray<{ path: string; error: string }>,
): MalformedTicket[] {
  return tickets.map(({ path, error }) => ({
    path,
    state: basename(dirname(path)),
    error,
  }));
}
