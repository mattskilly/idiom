import { defaultChecksSettings } from "../schemas/project.js";
import { ran, skipped, unavailable, v2Observations, verify } from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  RowOrnamentObservation,
} from "./types.js";

const RULE = "idiom:repeated-row-ornament";

function describe(ornament: RowOrnamentObservation): string {
  if (ornament.kind === "chip") return `The "${ornament.text}" badge`;
  if (ornament.kind === "mark") return "The same status mark";
  return ornament.name === "icon"
    ? "The same icon"
    : `The "${ornament.name}" icon`;
}

/**
 * The same chip, icon or mark drawn on (nearly) every item of a list, rail,
 * table or grid: it adds noise without telling items apart.
 */
export const repeatedRowOrnamentCheck: DeterministicCheck = {
  id: "repeated-row-ornament",
  run({ tuple, config }) {
    const settings =
      config.repeatedRowOrnament ?? defaultChecksSettings.repeatedRowOrnament;
    if (!settings.enabled) return skipped(this.id, "repeatedRowOrnament");
    const ornaments = v2Observations(tuple)?.rowOrnaments;
    if (ornaments === undefined)
      return unavailable(
        this.id,
        "observations predate the row-ornament scan (recapture)",
      );
    const seen = new Set<string>();
    const candidates: FindingCandidate[] = [];
    for (const ornament of ornaments) {
      const label = ornament.kind === "chip" ? ornament.text : ornament.name;
      const fingerprint = `repeated-row-ornament:${ornament.collection}|${ornament.kind}|${label}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      candidates.push({
        category: this.id,
        severity: "info",
        rule: RULE,
        selectorHint: ornament.collection,
        fingerprintHint: fingerprint,
        explanation: `${describe(ornament)} (${ornament.example}) repeats on ${ornament.count} of ${ornament.items} items in ${ornament.collection}; a mark every item carries does not tell items apart.`,
        acceptance: [
          `${ornament.collection} shows the decoration only on items it distinguishes, or states it once for the collection.`,
        ],
        verification: verify(this.id, {
          collection: ornament.collection,
          collectionKind: ornament.collectionKind,
          example: ornament.example,
          kind: ornament.kind,
          name: ornament.name,
          count: ornament.count,
          items: ornament.items,
          viewportWidth: tuple.width,
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
