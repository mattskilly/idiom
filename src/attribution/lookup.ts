import { tupleCoordinateKey } from "../baseline/coordinate.js";
import type { FindingLineage } from "../review/catalog.js";
import {
  type AttributionRecord,
  introductionKey,
  introductionsByKey,
  type RecordedIntroduction,
  readAttributionRecord,
} from "./record.js";

/** attribution.json reads, cached per run directory for one command. */
export type AttributionCache = Map<
  string,
  Promise<AttributionRecord | undefined>
>;

/**
 * A lineage's latest recorded introduction: its occurrences newest first,
 * each run's attribution.json matched at the occurrence's coordinate against
 * every fingerprint the lineage has carried. A finding that went away and
 * came back reports when it came back.
 */
export async function lineageIntroduction(
  lineage: Pick<FindingLineage, "occurrences" | "fingerprints">,
  cache: AttributionCache = new Map(),
): Promise<RecordedIntroduction | undefined> {
  for (const occurrence of [...lineage.occurrences].reverse()) {
    let pending = cache.get(occurrence.runDirectory);
    if (pending === undefined) {
      pending = readAttributionRecord(occurrence.runDirectory);
      cache.set(occurrence.runDirectory, pending);
    }
    const record = await pending;
    if (record === undefined) continue;
    const introductions = introductionsByKey(record);
    const where = tupleCoordinateKey(occurrence.finding);
    for (const fingerprint of [
      occurrence.finding.fingerprint,
      ...lineage.fingerprints,
    ]) {
      const found = introductions.get(introductionKey(where, fingerprint));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
