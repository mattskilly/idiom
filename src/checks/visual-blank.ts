import { blankReason } from "../capture/visual-blank.js";
import { defaultChecksSettings } from "../schemas/project.js";
import { skipped, unavailable, v2Observations, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const visualBlankCheck: DeterministicCheck = {
  id: "visual-blank",
  run({ tuple, config }) {
    if (!(config.visualBlank ?? defaultChecksSettings.visualBlank).enabled)
      return skipped(this.id, "visualBlank");
    const evidence = v2Observations(tuple)?.visualBlank;
    if (
      !evidence ||
      evidence.status === "unavailable" ||
      evidence.status === "skipped"
    )
      return unavailable(
        this.id,
        evidence?.reason ?? "blank-media evidence is unavailable (recapture)",
      );
    const candidates: FindingCandidate[] = [];
    for (const record of evidence.records) {
      const reason = blankReason(record);
      if (!reason) continue;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:visual-blank",
        selectorHint: record.selector,
        targetSelectors: [record.selector],
        explanation: `${record.kind} ${record.selector} (${Math.round(record.rect.width)} × ${Math.round(record.rect.height)} CSS px) appears blank: ${reason}.`,
        acceptance: [
          `${record.kind} ${record.selector} paints visible media content after the state is ready.`,
        ],
        verification: verify(this.id, {
          selector: record.selector,
          kind: record.kind,
          reason,
          algorithm: evidence.algorithm,
          dominantThreshold: evidence.dominantThreshold,
          opacityThreshold: evidence.opacityThreshold,
          overlayAlphaThreshold: evidence.overlayAlphaThreshold,
          swatchSelectors: evidence.swatchSelectors,
          width: record.rect.width,
          height: record.rect.height,
          dominantShare: record.pixels?.dominantShare,
          opacity: record.opacity,
          overlay: record.overlay,
        }),
      });
    }
    const unmeasured = evidence.records.filter(
      (r) => !r.masked && !r.exempt && !r.pixels,
    );
    const partial =
      evidence.status === "partial"
        ? evidence.reason
        : unmeasured.length
          ? `${unmeasured.length} screenshot crops not measured`
          : undefined;
    return {
      coverage: {
        check: this.id,
        status: "ran",
        reason: `${evidence.records.length} media surfaces inventoried${partial ? `; partial: ${partial}` : ""}`,
      },
      candidates,
    };
  },
};
