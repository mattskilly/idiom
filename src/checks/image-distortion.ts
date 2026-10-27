import { defaultChecksSettings } from "../schemas/project.js";
import { paintedGate } from "./painted.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  ImageRenderObservation,
} from "./types.js";

const minVisibleDistortionPx = 1;

/** Pixels off on either axis after the best proportional scaling of the source. */
export function distortionPixelError(record: ImageRenderObservation): number {
  const { width: w, height: h } = record.rendered;
  const { naturalWidth: W, naturalHeight: H } = record;
  if (!(w > 0 && h > 0 && W > 0 && H > 0)) return 0;
  return Math.abs(w * H - h * W) / (W + H);
}

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
    const gate = paintedGate(tuple, ["idiom:image-distorted"]);
    const candidates: FindingCandidate[] = scan.records
      .filter((record) => gate.allows("idiom:image-distorted", record.selector))
      .filter(
        (record) =>
          !record.broken &&
          record.objectFit === "fill" &&
          record.distortion > settings.distortionTolerance &&
          distortionPixelError(record) >= minVisibleDistortionPx &&
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
    return gate.result(scanResult(this.id, candidates, scan));
  },
};
