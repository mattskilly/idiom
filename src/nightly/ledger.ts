import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { IdiomError } from "../errors.js";

/**
 * What `idiom nightly` has filed: each tracker ticket (or proposal file) and
 * the finding identities it covers. Committed, so a later run updates the
 * ticket instead of filing it again.
 */
export const FILED_TICKETS_FILE = "filed-tickets.json";

const entrySchema = z
  .object({
    sink: z.enum(["autobuild", "directory"]),
    /** The tracker ticket id, or the proposal path relative to the project. */
    ticket: z.string().min(1),
    findingIds: z.array(z.string()),
    fingerprints: z.array(z.string()),
    flows: z.array(z.string()),
    labels: z.array(z.string()),
    bodyDigest: z.string(),
    filedAt: z.string(),
    updatedAt: z.string(),
    /** The resolved or missing ticket this one was filed in place of. */
    replaced: z.string().optional(),
  })
  .strict();
export const ledgerSchema = z
  .object({ version: z.literal(1), entries: z.array(entrySchema) })
  .strict();
export type Ledger = z.infer<typeof ledgerSchema>;
export type LedgerEntry = z.infer<typeof entrySchema>;
/** A cluster's identities: every lineage id and fingerprint of its members. */
export type FindingIdentities = { ids: string[]; fingerprints: string[] };

export function ledgerPath(projectDirectory: string): string {
  return join(projectDirectory, ".idiom", FILED_TICKETS_FILE);
}

export async function readLedger(path: string): Promise<Ledger> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, entries: [] };
    throw error;
  }
  try {
    return ledgerSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new IdiomError(
      `malformed ${path}: ${error instanceof Error ? error.message : String(error)}; fix or delete it (identities are recovered from the tracker)`,
    );
  }
}

const sorted = (values: readonly string[]) => [...new Set(values)].sort();

/** Atomic and stable: sorted entries and sets, so commits diff cleanly. */
export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  const entries = ledger.entries
    .map((entry) => ({
      ...entry,
      findingIds: sorted(entry.findingIds),
      fingerprints: sorted(entry.fingerprints),
      flows: sorted(entry.flows),
      labels: sorted(entry.labels),
    }))
    .sort(
      (left, right) =>
        left.sink.localeCompare(right.sink) ||
        left.ticket.localeCompare(right.ticket),
    );
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
    );
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Entries sharing any lineage id or fingerprint with the identities. */
export function matchEntries<
  Entry extends Pick<LedgerEntry, "findingIds" | "fingerprints">,
>(entries: readonly Entry[], identities: FindingIdentities): Entry[] {
  const ids = new Set(identities.ids);
  const fingerprints = new Set(identities.fingerprints);
  return entries.filter(
    (entry) =>
      entry.findingIds.some((id) => ids.has(id)) ||
      entry.fingerprints.some((fingerprint) => fingerprints.has(fingerprint)),
  );
}
