import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { IdiomError } from "../errors.js";
import type { FindingLineage } from "../review/catalog.js";
import { parseFindingBlocks } from "../verify/spec.js";
import type { MalformedTicket } from "./index.js";

export const TRACKER_TICKET_STATES = [
  "triage",
  "ready",
  "doing",
  "done",
] as const;

export type TrackerTicketState = (typeof TRACKER_TICKET_STATES)[number];

export type EmbeddedTicket = {
  path: string;
  state: TrackerTicketState;
};

export type TrackerIndex = {
  contents: Map<string, string>;
  embedded: Map<string, EmbeddedTicket[]>;
  malformed: MalformedTicket[];
};

function identityKey(identity: {
  findingId: string;
  fingerprint: string;
}): string {
  return JSON.stringify([identity.findingId, identity.fingerprint]);
}

// A tracker ticket is a regular `.md` file or a `.md` symlink to one, the same
// rule lifecycle lookup applies through access(). Dangling links are absent,
// as they are to access(); links to directories are not tickets.
async function isTicketFile(entry: Dirent, path: string): Promise<boolean> {
  if (!entry.name.endsWith(".md")) return false;
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new IdiomError(
      `cannot read tracker ticket ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Symlinked tickets are keyed by their tracker path, not their target, so
// generated-filename lookup and reported paths match lifecycle's.
export async function indexTrackerTickets(
  trackerRoot: string,
): Promise<TrackerIndex> {
  const contents = new Map<string, string>();
  const embedded = new Map<string, EmbeddedTicket[]>();
  const malformed: MalformedTicket[] = [];
  for (const state of TRACKER_TICKET_STATES) {
    const directory = join(trackerRoot, state);
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new IdiomError(
        `cannot enumerate ticket tracker ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (!(await isTicketFile(entry, path))) continue;
      let source: string;
      try {
        source = await readFile(path, "utf8");
      } catch (error) {
        throw new IdiomError(
          `cannot read tracker ticket ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      contents.set(path, source);
      let findings: ReturnType<typeof parseFindingBlocks>;
      try {
        findings = parseFindingBlocks(source);
      } catch (error) {
        // Reported per ticket; it contributes no identities.
        malformed.push({
          path,
          state,
          error: `cannot parse tracker ticket ${path}: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      for (const finding of findings) {
        for (const findingId of [finding.id, ...(finding.idAliases ?? [])]) {
          const key = identityKey({
            findingId,
            fingerprint: finding.fingerprint,
          });
          const matches = embedded.get(key) ?? [];
          // One ticket carrying an identity twice is not a duplicate.
          if (!matches.some((match) => match.path === path))
            matches.push({ path, state });
          embedded.set(key, matches);
        }
      }
    }
  }
  return { contents, embedded, malformed };
}

export type EmbeddedResolution =
  | { kind: "none" }
  | { kind: "single"; ticket: EmbeddedTicket }
  | { kind: "conflict"; paths: string[] };

/** An identity embedded in several tickets is a conflict, never collapsed to its first ticket. */
export function resolveEmbeddedTicket(
  index: TrackerIndex,
  lineage: Pick<FindingLineage, "identities">,
): EmbeddedResolution {
  const paths: string[] = [];
  for (const identity of lineage.identities) {
    const matches = index.embedded.get(identityKey(identity)) ?? [];
    if (matches.length < 2) continue;
    for (const match of matches)
      if (!paths.includes(match.path)) paths.push(match.path);
  }
  if (paths.length > 0) return { kind: "conflict", paths };
  for (const identity of lineage.identities) {
    const match = index.embedded.get(identityKey(identity))?.[0];
    if (match !== undefined) return { kind: "single", ticket: match };
  }
  return { kind: "none" };
}
