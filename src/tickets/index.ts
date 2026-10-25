import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { IdiomError } from "../errors.js";
import type { FindingLineage } from "../review/catalog.js";
import type { Finding } from "../schemas/finding.js";
import { parseFindingBlocks } from "../verify/spec.js";
import { ticketIdsForIdentities } from "./render.js";
import { physicalPath } from "./target.js";

export type IndexedTicket = {
  path: string;
  root: string;
  state: string;
  findings: Finding[];
};
export async function readIndexedTicket(
  path: string,
  root: string,
  state: string,
): Promise<IndexedTicket> {
  try {
    return {
      path,
      root,
      state,
      findings: parseFindingBlocks(await readFile(path, "utf8")),
    };
  } catch (error) {
    throw new IdiomError(
      `cannot parse tracker ticket ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
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
      filenames.has(basename(ticket.path)) ||
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
