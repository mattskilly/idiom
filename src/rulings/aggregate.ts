import type {
  DecisionObservation,
  RulingCandidate,
  RulingCoordinate,
  UnruledDecision,
} from "../schemas/ruling.js";
import { normalizeChoiceKey, rulingFingerprint } from "./fingerprint.js";

export const MAX_UNRULED_DECISIONS = 3;

export type AggregatedDecision = Omit<UnruledDecision, "id">;

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function coordinate(observation: DecisionObservation): RulingCoordinate {
  return {
    state: observation.state,
    viewport: observation.viewport,
    ...(observation.colorScheme === undefined
      ? {}
      : { colorScheme: observation.colorScheme }),
    screenshot: observation.screenshot,
  };
}

function candidateKey(candidate: RulingCandidate): string {
  return JSON.stringify(candidate);
}

export function aggregateDecisionObservations(options: {
  observations: DecisionObservation[];
  resolvedFingerprints?: ReadonlySet<string> | undefined;
  limit?: number | undefined;
}): AggregatedDecision[] {
  const grouped = new Map<string, DecisionObservation[]>();
  for (const observation of options.observations) {
    const key = normalizeChoiceKey(observation.choiceKey);
    grouped.set(key, [...(grouped.get(key) ?? []), observation]);
  }
  return [...grouped.entries()]
    .flatMap(([choiceKey, observations]) => {
      const fingerprint = rulingFingerprint(choiceKey);
      if (options.resolvedFingerprints?.has(fingerprint) === true) return [];
      const distinctStates = new Set(observations.map((item) => item.state));
      if (distinctStates.size < 2) return [];
      const occurrences = uniqueBy(
        observations.map(coordinate),
        (item) =>
          `${item.state}\0${item.viewport}\0${item.colorScheme ?? ""}\0${item.screenshot}`,
      ).sort(
        (left, right) =>
          left.state.localeCompare(right.state) ||
          left.viewport.localeCompare(right.viewport) ||
          (left.colorScheme ?? "").localeCompare(right.colorScheme ?? "") ||
          left.screenshot.localeCompare(right.screenshot),
      );
      const candidates = uniqueBy(
        observations.flatMap((item) => item.candidates),
        candidateKey,
      );
      const first = observations[0];
      if (first === undefined) return [];
      return [
        {
          fingerprint,
          choiceKey,
          question: first.question,
          nearestLawExcerpt: first.nearestLawExcerpt,
          occurrences,
          candidates,
        },
      ];
    })
    .sort(
      (left, right) =>
        new Set(right.occurrences.map((item) => item.state)).size -
          new Set(left.occurrences.map((item) => item.state)).size ||
        left.choiceKey.localeCompare(right.choiceKey),
    )
    .slice(0, options.limit ?? MAX_UNRULED_DECISIONS);
}
