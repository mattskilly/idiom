import {
  type ReferenceMeasurement,
  reconcileReferences,
} from "../design/decide.js";
import { designEvidenceProblem, tupleDesigns } from "../design/evidence.js";
import { measureComparisons } from "../design/measure.js";
import type { DesignRegions } from "../design/types.js";
import { unavailable } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

/** One minor finding per changed region between a design image and the app. */
export function regionCandidates(regions: DesignRegions): FindingCandidate[] {
  return regions.regions.map((region) => {
    const { x, y, width, height } = region.rect;
    const target = region.owner ?? region.elements[0] ?? "body";
    const covers = region.owner
      ? `\`${region.owner}\``
      : region.elements.length
        ? region.elements.map((selector) => `\`${selector}\``).join(", ")
        : "an area with no single owning element";
    const changedArea =
      Math.round((region.changedCells / region.cells) * 1000) / 1000;
    const offset = `${regions.offset >= 0 ? "+" : ""}${regions.offset}`;
    return {
      category: "design-drift",
      severity: "minor",
      rule: "idiom:design-drift",
      selectorHint: target,
      fingerprintHint: region.owner
        ? `region:${region.owner}`
        : `region:${x >> 4},${y >> 4},${width >> 4},${height >> 4}`,
      explanation: `Visible difference from the design image over ${covers}, at ${x},${y} ${width}×${height} CSS px (${Math.round(changedArea * 100)}% of cells changed, design offset ${offset} px).`,
      fix: `Compare the paired crops and bring ${region.owner ? `\`${region.owner}\`` : "this area"} in line with the design image, or accept this departure through a normal decision.`,
      designDrift: {
        version: 1,
        pairId: region.id,
        method: "region",
        property: "visual",
        designValue: null,
        appValue: null,
        designSelector: null,
        appSelector: region.owner,
        region: {
          id: region.id,
          rect: region.rect,
          designRect: region.designRect,
          offset: regions.offset,
          owner: region.owner,
          elements: region.elements,
          changedArea,
        },
      },
      acceptance: [
        "The area matches the intended design image, or the departure is accepted.",
      ],
      verification: {
        check: "design-drift",
        params: { selector: target, region: region.id },
      },
    };
  });
}

function regionNote(regions: DesignRegions): string | undefined {
  const notes = [
    ...(regions.omitted
      ? [`${regions.omitted} smaller changed region(s) omitted`]
      : []),
    ...regions.uncompared.map(
      (band) =>
        `${band.side === "app" ? "app" : "design"} rows ${band.top}–${band.top + band.height} px have no counterpart and were not compared`,
    ),
  ];
  return notes.length ? notes.join("; ") : undefined;
}

export const designDriftCheck: DeterministicCheck = {
  id: "design-drift",
  run({ tuple, config }) {
    const designs = tupleDesigns(tuple);
    if (!designs.length || config.designDrift?.enabled === false)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: designs.length
            ? "design comparison disabled"
            : (tuple.designNotApplicable ?? "no design declared at capture"),
        },
        candidates: [],
      };
    const problem = designEvidenceProblem(tuple);
    if (problem) return unavailable(this.id, problem);
    const app = tuple.observations;
    const measured: ReferenceMeasurement[] = [];
    const regionFindings: FindingCandidate[] = [];
    const notes: string[] = [];
    for (const [index, design] of designs.entries()) {
      const name =
        design.descriptor.name ?? (index ? `design-${index + 1}` : "design");
      if (design.descriptor.resolved?.kind === "image") {
        // Image regions are evidence for judgment, not element values to reconcile.
        const regions = design.regions;
        if (!regions)
          return unavailable(this.id, "saved design regions are unavailable");
        const note = regionNote(regions);
        if (note) notes.push(designs.length > 1 ? `${name}: ${note}` : note);
        regionFindings.push(
          ...regionCandidates(regions).map((candidate) =>
            index === 0 || !candidate.designDrift
              ? candidate
              : {
                  ...candidate,
                  fingerprintHint: `${name}:${candidate.fingerprintHint}`,
                  designDrift: { ...candidate.designDrift, reference: name },
                },
          ),
        );
        continue;
      }
      const observations = design.observations;
      if (observations?.version !== 2 || app?.version !== 2)
        return unavailable(
          this.id,
          "design comparison requires V2 observations on both sides; recapture",
        );
      measured.push({
        name,
        source: design.descriptor.source,
        ...measureComparisons(observations, app, config, design.matches),
      });
    }
    return {
      coverage: {
        check: this.id,
        status: "ran",
        ...(notes.length ? { reason: notes.join("; ") } : {}),
      },
      candidates: [
        ...(measured.length
          ? reconcileReferences(measured, tuple, config)
          : []),
        ...regionFindings,
      ],
    };
  },
};
