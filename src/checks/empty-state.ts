import { unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const emptyStateCheck: DeterministicCheck = {
  id: "empty-state",
  run({ tuple, config }) {
    const observation = tuple.observations;
    if (observation?.version !== 2 || !observation.emptyRegions)
      return unavailable(
        this.id,
        "observations predate empty-region observation (recapture)",
      );
    if (!config.emptyState.auto && config.emptyState.regions.length === 0)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "auto-detection off and no checks.emptyState.regions",
        },
        candidates: [],
      };
    const evidence = observation.emptyRegions;
    const notes: string[] = [];
    let incomplete = config.emptyState.auto && !evidence.auto;
    if (incomplete)
      notes.push("auto regions not resolved at capture (recapture)");
    for (const { selector } of config.emptyState.regions) {
      const captured = evidence.configured.find(
        (entry) => entry.selector === selector,
      );
      if (!captured) {
        incomplete = true;
        notes.push(
          `${selector} not resolved at capture (recapture after adding checks.emptyState.regions)`,
        );
      } else if (captured.matched === 0)
        notes.push(`${selector} matched no rendered regions`);
    }
    const regions = evidence.regions.filter((region) =>
      region.source === "configured"
        ? config.emptyState.regions.some(
            (entry) => entry.selector === region.configured,
          )
        : config.emptyState.auto,
    );
    const candidates: FindingCandidate[] = [];
    for (const region of regions) {
      const hasCta = region.cta.length > 0;
      const hasText = (region.text.match(/\p{L}{2,}/gu) ?? []).length >= 2;
      if (hasCta && hasText) continue;
      const missing = hasCta
        ? "has a call to action but no text explaining why it is empty"
        : hasText
          ? `has text (${JSON.stringify(region.text)}) but no call to action`
          : "has no call to action and no explanatory text";
      candidates.push({
        category: this.id,
        severity: region.source === "configured" ? "major" : "minor",
        rule: "idiom:empty-state",
        selectorHint: region.selector,
        fingerprintHint: `empty-state:${region.selector}`,
        explanation: `The empty ${region.source === "configured" ? "region" : region.source} ${region.selector} (no items) ${missing}.`,
        acceptance: [
          `When ${region.selector} has no items it explains why in words and offers a button or link to the next step.`,
        ],
        verification: verify(this.id, {
          selector: region.selector,
          source: region.source,
          hasCta,
          hasText,
        }),
      });
    }
    return {
      coverage: {
        check: this.id,
        status: incomplete && regions.length === 0 ? "unavailable" : "ran",
        reason: [`${regions.length} empty regions examined`, ...notes].join(
          "; ",
        ),
      },
      candidates,
    };
  },
};
