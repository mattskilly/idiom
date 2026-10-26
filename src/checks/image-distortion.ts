import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const imageDistortionCheck: DeterministicCheck = {
  id: "image-distortion",
  run({ tuple, config }) {
    const settings = config.images ?? defaultChecksSettings.images;
    if (!settings.enabled) return skipped(this.id, "images");
    const scan = v2Observations(tuple)?.imageRenders;
    if (scan === undefined)
      return unavailable(
        this.id,
        "image render evidence is unavailable (recapture with this version)",
      );
    const seen = new Set<string>();
    const candidates: FindingCandidate[] = scan.records
      .filter(
        (record) =>
          !record.broken &&
          record.objectFit === "fill" &&
          record.distortion > settings.distortionTolerance &&
          !seen.has(record.selector) &&
          seen.add(record.selector) !== undefined,
      )
      .map((record) => {
        const size = `${Math.round(record.rendered.width)}×${Math.round(record.rendered.height)}`;
        const natural = `${record.naturalWidth}×${record.naturalHeight}`;
        return {
          category: this.id,
          severity: "major" as const,
          rule: "idiom:image-distorted",
          selectorHint: record.selector,
          explanation: `${record.selector} is drawn at ${size} from a ${natural} source, stretching it ${Math.round(record.distortion * 1000) / 10}% out of proportion.`,
          acceptance: [
            `${record.selector} keeps its natural aspect ratio (within ${Math.round(settings.distortionTolerance * 1000) / 10}%), for example with object-fit: cover or contain.`,
          ],
          verification: verify(this.id, {
            selector: record.selector,
            tolerance: settings.distortionTolerance,
          }),
        };
      });
    return scanResult(this.id, candidates, scan);
  },
};
