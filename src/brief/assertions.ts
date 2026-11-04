import { settingsHash } from "../findings/settings.js";
import {
  type BriefAssertion,
  briefAssertionSelectors,
  type CompleteStoredBrief,
  type StoredBrief,
} from "../schemas/brief.js";
import type { FlowRecord } from "../validation.js";

/** A decided brief as `check`, `review`, capture and `context` read it. */
export type BriefCheck = {
  slug: string;
  title: string;
  /** The chosen option's title. */
  decision: string;
  /** Ineligible briefs are listed in coverage with the reason, never judged. */
  eligible: true | { reason: string };
  criteria: Array<{
    index: number;
    statement: string;
    assertions: BriefAssertion[];
  }>;
};

type CriteriaShape = Pick<StoredBrief, "acceptanceCriteria">;

export function hasBriefAssertions(brief: CriteriaShape): boolean {
  return (brief.acceptanceCriteria ?? []).some(
    (criterion) => (criterion.assertions?.length ?? 0) > 0,
  );
}

/**
 * Every assertion's flow and state must be declared, so a typo is caught
 * when the brief is recorded rather than read as "not captured" forever.
 */
export function validateBriefAssertions(
  brief: CriteriaShape,
  flows: readonly FlowRecord[],
): string[] {
  const issues: string[] = [];
  const byId = new Map(flows.map(({ flow }) => [flow.id, flow]));
  for (const [criterionIndex, criterion] of (
    brief.acceptanceCriteria ?? []
  ).entries())
    for (const [index, assertion] of (criterion.assertions ?? []).entries()) {
      const path = `acceptanceCriteria[${criterionIndex}].assertions[${index}]`;
      const flow = byId.get(assertion.flow);
      if (flow === undefined) {
        issues.push(
          `${path}.flow: no flow ${JSON.stringify(assertion.flow)}; flows: ${[...byId.keys()].sort().join(", ") || "none"}`,
        );
        continue;
      }
      if (!flow.states.some((state) => state.id === assertion.state))
        issues.push(
          `${path}.state: flow ${flow.id} declares no state ${JSON.stringify(assertion.state)}; states: ${flow.states.map((state) => state.id).join(", ")}`,
        );
    }
  return issues;
}

/** Why a decided brief is not judged, or true. */
export function briefEligibility(
  brief: CompleteStoredBrief,
): BriefCheck["eligible"] {
  const chosenId = brief.chosenOption ?? brief.recommendation.option;
  const chosen = brief.options.find((option) => option.id === chosenId);
  if (chosen?.kind === "dont-build")
    return { reason: "decided not to build; nothing to check" };
  if (chosenId !== brief.recommendation.option)
    return {
      reason: `criteria were written for ${brief.recommendation.option}, not the chosen ${chosenId}; re-record them`,
    };
  return true;
}

export function briefCheckFrom(brief: CompleteStoredBrief): BriefCheck {
  const chosenId = brief.chosenOption ?? brief.recommendation.option;
  const chosen = brief.options.find((option) => option.id === chosenId);
  return {
    slug: brief.slug,
    title: brief.title,
    decision: chosen?.title ?? chosenId,
    eligible: briefEligibility(brief),
    criteria: brief.acceptanceCriteria.map((criterion, index) => ({
      index,
      statement: criterion.statement,
      assertions: criterion.assertions ?? [],
    })),
  };
}

/**
 * A short hash of what an assertion asserts: selector, form, expected values,
 * tolerance, flow and state. `name` is a label, so renaming never reopens.
 */
export function briefAssertionIdentity(assertion: BriefAssertion): string {
  const { name: _name, ...rest } = assertion;
  return settingsHash(rest).slice(0, 8);
}

/** A tuple state `S` or `S.<combination>` belongs to declared state `S`. */
export function briefStateMatches(tupleState: string, state: string): boolean {
  return tupleState === state || tupleState.startsWith(`${state}.`);
}

/** Eligible assertions that target this flow and state, in brief order. */
export function briefAssertionsFor(
  checks: readonly BriefCheck[],
  flow: string,
  state: string,
): Array<{
  brief: BriefCheck;
  criterion: BriefCheck["criteria"][number];
  index: number;
  assertion: BriefAssertion;
}> {
  return checks.flatMap((brief) =>
    brief.eligible !== true
      ? []
      : brief.criteria.flatMap((criterion) =>
          criterion.assertions.flatMap((assertion, index) =>
            assertion.flow === flow && briefStateMatches(state, assertion.state)
              ? [{ brief, criterion, index, assertion }]
              : [],
          ),
        ),
  );
}

/** The selectors capture must resolve for this flow state: sorted, unique. */
export function briefSelectorsFor(
  checks: readonly BriefCheck[],
  flow: string,
  state: string,
): string[] {
  return [
    ...new Set(
      briefAssertionsFor(checks, flow, state).flatMap(({ assertion }) =>
        briefAssertionSelectors(assertion),
      ),
    ),
  ].sort();
}
