import { defaultChecksSettings } from "../schemas/project.js";
import { ran, skipped, unavailable, v2Observations, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const RULE = "idiom:text-occlusion";

/** Text more than 30% covered by an opaque element painted above it. */
export const textOcclusionCheck: DeterministicCheck = {
  id: "text-occlusion",
  run({ tuple, config }) {
    const settings =
      config.textOcclusion ?? defaultChecksSettings.textOcclusion;
    if (!settings.enabled) return skipped(this.id, "textOcclusion");
    const records = v2Observations(tuple)?.textOcclusions;
    if (records === undefined)
      return unavailable(
        this.id,
        "observations predate the text-occlusion scan (recapture)",
      );
    const candidates: FindingCandidate[] = records.map((record) => ({
      category: this.id,
      severity: "minor",
      rule: RULE,
      selectorHint: record.text,
      fingerprintHint: `text-occlusion:${record.text}:${record.cover}`,
      explanation: `${record.cover} is painted over ${Math.round(record.ratio * 100)}% of the text in ${record.text} at ${tuple.width}px (${record.covered} of ${record.samples} sampled points), so part of it cannot be read.`,
      acceptance: [
        `At ${tuple.width}px, no opaque element covers more than 30% of the text in ${record.text}.`,
      ],
      verification: verify(this.id, {
        selector: record.text,
        cover: record.cover,
        viewportWidth: tuple.width,
        ratio: record.ratio,
      }),
    }));
    return ran(this.id, candidates);
  },
};
