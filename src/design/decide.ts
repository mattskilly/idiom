import type {
  ChecksConfig,
  CheckTuple,
  FindingCandidate,
} from "../checks/types.js";
import type { Decision } from "../schemas/decision.js";
import type { DesignDecisionEvidence } from "../schemas/finding.js";
import { type Comparison, designValuesAgree } from "./measure.js";

/** A person's choice of reference for one disagreeing property on one state. */
export type DesignChoice = {
  flow: string;
  state: string;
  colorScheme?: "light" | "dark" | undefined;
  decisionKey: string;
  reference: string;
};

const choiceKey = (choice: Omit<DesignChoice, "reference">) =>
  [
    choice.flow,
    choice.state,
    choice.colorScheme ?? "",
    choice.decisionKey,
  ].join("\0");

/** The last recorded choice per flow, state, scheme and decision key. */
export function designChoicesFrom(
  decisions: readonly Decision[],
): DesignChoice[] {
  const latest = new Map<string, DesignChoice>();
  for (const decision of decisions) {
    const choice = decision.designChoice;
    if (!choice) continue;
    latest.set(choiceKey(choice), {
      flow: choice.flow,
      state: choice.state,
      ...(choice.colorScheme === undefined
        ? {}
        : { colorScheme: choice.colorScheme }),
      decisionKey: choice.decisionKey,
      reference: choice.reference,
    });
  }
  return [...latest.values()];
}

export type ReferenceMeasurement = {
  name: string;
  source: string;
  candidates: FindingCandidate[];
  comparisons: Comparison[];
};

/**
 * Reconcile several references per matched app element and property. Where
 * the references disagree with each other the result is a design decision,
 * never a defect against either; a recorded choice turns it back into
 * ordinary drift against the chosen reference.
 */
export function reconcileReferences(
  references: ReferenceMeasurement[],
  tuple: Pick<CheckTuple, "flow" | "state" | "colorScheme" | "colorSchemeAxis">,
  config: ChecksConfig,
): FindingCandidate[] {
  if (references.length === 1) return references[0]?.candidates ?? [];
  const choices = new Map(
    (config.designChoices ?? []).map((choice) => [choiceKey(choice), choice]),
  );
  const byKey = new Map<
    string,
    Array<{ reference: ReferenceMeasurement; comparison: Comparison }>
  >();
  const compared = new Set<FindingCandidate>();
  for (const reference of references)
    for (const comparison of reference.comparisons) {
      if (comparison.candidate) compared.add(comparison.candidate);
      const list = byKey.get(comparison.key);
      if (list) list.push({ reference, comparison });
      else byKey.set(comparison.key, [{ reference, comparison }]);
    }
  const output: FindingCandidate[] = [];
  const tagged = (
    candidate: FindingCandidate,
    reference: ReferenceMeasurement,
    extra: Partial<NonNullable<FindingCandidate["designDrift"]>> = {},
  ): FindingCandidate => ({
    ...candidate,
    ...(candidate.designDrift
      ? {
          designDrift: {
            ...candidate.designDrift,
            ...(reference === references[0]
              ? {}
              : { reference: reference.name }),
            ...extra,
          },
        }
      : {}),
  });
  for (const entries of byKey.values()) {
    const [first] = entries;
    if (!first) continue;
    if (entries.length === 1) {
      if (first.comparison.candidate)
        output.push(tagged(first.comparison.candidate, first.reference));
      continue;
    }
    const disagree = entries.some((x, i) =>
      entries
        .slice(i + 1)
        .some((y) => !designValuesAgree(x.comparison, y.comparison, config)),
    );
    if (!disagree) {
      if (first.comparison.candidate)
        output.push(
          tagged(first.comparison.candidate, first.reference, {
            alsoReferences: entries.slice(1).map((e) => e.reference.name),
          }),
        );
      continue;
    }
    const decisionKey = `decision:${first.comparison.hint}`;
    const choice = choices.get(
      choiceKey({
        flow: tuple.flow,
        state: tuple.state,
        ...(tuple.colorSchemeAxis ? { colorScheme: tuple.colorScheme } : {}),
        decisionKey,
      }),
    );
    const chosen = choice
      ? entries.find((e) => e.reference.name === choice.reference)
      : undefined;
    if (chosen) {
      // The person's choice resolved it; drift remains only against that reference.
      const candidate = chosen.comparison.candidate;
      if (candidate)
        output.push({
          ...candidate,
          explanation: `${candidate.explanation} (chosen reference ${chosen.reference.name})`,
          ...(candidate.designDrift
            ? {
                designDrift: {
                  ...candidate.designDrift,
                  chosenReference: chosen.reference.name,
                },
              }
            : {}),
        });
      continue;
    }
    output.push(decisionCandidate(entries, decisionKey));
  }
  // Unmatched content is per reference; the same gap seen by several is one finding.
  const unmatched = new Map<string, FindingCandidate>();
  for (const reference of references)
    for (const candidate of reference.candidates) {
      if (compared.has(candidate)) continue;
      const key = `${candidate.rule}\0${candidate.fingerprintHint ?? candidate.selectorHint}`;
      const existing = unmatched.get(key);
      if (existing?.designDrift) {
        existing.designDrift.alsoReferences = [
          ...(existing.designDrift.alsoReferences ?? []),
          reference.name,
        ];
        continue;
      }
      const copy = tagged(candidate, reference);
      unmatched.set(key, copy);
      output.push(copy);
    }
  return output;
}

function decisionCandidate(
  entries: Array<{ reference: ReferenceMeasurement; comparison: Comparison }>,
  decisionKey: string,
): FindingCandidate {
  const [first] = entries;
  if (!first) throw new Error("design decision needs references");
  const { comparison } = first;
  const evidence: DesignDecisionEvidence = {
    version: 1,
    decisionKey,
    property: comparison.property,
    appSelector: comparison.pair.app,
    appValue: comparison.appValue,
    references: entries.map(({ reference, comparison: c }) => ({
      name: reference.name,
      source: reference.source,
      value: c.designValue,
      ...(c.allowance === undefined ? {} : { allowance: c.allowance }),
      matchesBuild: c.within,
      ...(c.layerPath ? { layerPath: c.layerPath } : {}),
      ...(c.link ? { link: c.link } : {}),
      pairId: c.pair.id,
      designSelector: c.pair.design,
    })),
  };
  const matching = entries
    .filter((e) => e.comparison.within)
    .map((e) => e.reference.name);
  const values = entries
    .map(
      (e) => `${e.reference.name} ${JSON.stringify(e.comparison.designValue)}`,
    )
    .join(", ");
  const names = entries.map((e) => e.reference.name).join("|");
  return {
    category: "design-drift",
    severity: "minor",
    rule: "idiom:design-decision",
    selectorHint: comparison.pair.app,
    fingerprintHint: decisionKey,
    explanation: `${comparison.property}: design references disagree (${values}); build ${JSON.stringify(comparison.appValue)} matches ${matching.length ? matching.join(" and ") : "none"}. Choose a reference: idiom decide --finding <id> --choose <${names}>`,
    fix: `Ask a person which reference is intended for ${comparison.property} on ${comparison.pair.app}, record it with idiom decide --finding <id> --choose <name>, then align the build with that reference.`,
    designDrift: {
      version: 1,
      pairId: comparison.pair.id,
      method: comparison.pair.method,
      property: comparison.property,
      designValue: comparison.designValue,
      appValue: comparison.appValue,
      designSelector: comparison.pair.design,
      appSelector: comparison.pair.app,
      ...(comparison.neighbour ? { neighbour: comparison.neighbour } : {}),
      designDecision: evidence,
    },
    acceptance: [
      `A person chooses which design reference is intended for ${comparison.property}; the build then agrees with it.`,
    ],
    verification: {
      check: "design-drift",
      params: {
        selector: comparison.pair.app,
        pairId: comparison.pair.id,
        property: comparison.property,
        decisionKey,
      },
    },
  };
}
