import type { BriefCheck } from "../brief/assertions.js";
import {
  type BriefTuple,
  evaluateBriefAssertions,
} from "../checks/brief-mismatch.js";
import {
  type BriefAssertionForm,
  briefAssertionForm,
} from "../schemas/brief.js";

export type BriefAssertionCoverage = {
  criterion: number;
  assertion: number;
  form: BriefAssertionForm;
  state: string;
  selector: string;
  /** Tuples on which the assertion held, broke, or could not be measured. */
  passed: number;
  mismatched: number;
  unmeasured: string[];
};

/**
 * What became of each decided brief relevant to the reviewed flow: judged,
 * targeting states this run did not capture, holding no assertion at all
 * ("decided, not checkable"), or skipped as ineligible.
 */
export type BriefCoverageEntry = { slug: string; title: string } & (
  | { status: "checked"; assertions: BriefAssertionCoverage[] }
  | { status: "not-captured"; states: string[] }
  | { status: "not-checkable" }
  | { status: "skipped"; reason: string }
);

export type BriefCoverage = { entries: BriefCoverageEntry[] };

/**
 * Briefs with no assertions are listed for every flow; briefs whose
 * assertions all target other flows are omitted.
 */
export function computeBriefCoverage(
  tuples: readonly Omit<BriefTuple, "flow">[],
  briefs: readonly BriefCheck[],
  flow: string,
): BriefCoverage {
  const flowTuples = tuples.map((tuple) => ({ ...tuple, flow }));
  const entries: BriefCoverageEntry[] = [];
  for (const brief of briefs) {
    const all = brief.criteria.flatMap((criterion) => criterion.assertions);
    const here = all.filter((assertion) => assertion.flow === flow);
    if (all.length > 0 && here.length === 0) continue;
    const head = { slug: brief.slug, title: brief.title };
    if (brief.eligible !== true) {
      entries.push({
        ...head,
        status: "skipped",
        reason: brief.eligible.reason,
      });
      continue;
    }
    if (all.length === 0) {
      entries.push({ ...head, status: "not-checkable" });
      continue;
    }
    const assertions = new Map<string, BriefAssertionCoverage>();
    for (const criterion of brief.criteria)
      for (const [index, assertion] of criterion.assertions.entries())
        if (assertion.flow === flow)
          assertions.set(`${criterion.index}:${index}`, {
            criterion: criterion.index,
            assertion: index,
            form: briefAssertionForm(assertion),
            state: assertion.state,
            selector: assertion.selector,
            passed: 0,
            mismatched: 0,
            unmeasured: [],
          });
    const measured = new Set<string>();
    for (const tuple of flowTuples)
      for (const result of evaluateBriefAssertions(tuple, [brief])) {
        const key = `${result.criterion.index}:${result.assertionIndex}`;
        const entry = assertions.get(key);
        if (entry === undefined) continue;
        measured.add(key);
        if (result.outcome === "pass") entry.passed += 1;
        else if (result.outcome === "mismatch") entry.mismatched += 1;
        else if (
          result.outcome === "unmeasured" &&
          result.reason !== undefined &&
          !entry.unmeasured.includes(result.reason)
        )
          entry.unmeasured.push(result.reason);
      }
    if (measured.size === 0) {
      entries.push({
        ...head,
        status: "not-captured",
        states: [...new Set(here.map((assertion) => assertion.state))].sort(),
      });
      continue;
    }
    for (const [key, entry] of assertions) {
      if (!measured.has(key))
        entry.unmeasured.push(`state ${entry.state} was not captured`);
      else if (
        entry.passed + entry.mismatched === 0 &&
        entry.unmeasured.length === 0
      )
        entry.unmeasured.push(
          entry.form === "visibleWithoutHover"
            ? `no touch viewport was captured for ${entry.state}`
            : "not measured",
        );
    }
    entries.push({
      ...head,
      status: "checked",
      assertions: [...assertions.values()],
    });
  }
  return { entries };
}

function assertionLabel(entry: BriefAssertionCoverage): string {
  return `criterion ${entry.criterion} assertion ${entry.assertion} (${entry.form} ${entry.selector} at ${entry.state})`;
}

function entryLines(entry: BriefCoverageEntry): string[] {
  const name = `- ${entry.title} (${entry.slug})`;
  if (entry.status === "not-checkable")
    return [`${name}: decided, not checkable`];
  if (entry.status === "skipped") return [`${name}: skipped (${entry.reason})`];
  if (entry.status === "not-captured")
    return [
      `${name}: not captured (state${entry.states.length === 1 ? "" : "s"} ${entry.states.join(", ")})`,
    ];
  const mismatched = entry.assertions.filter(
    (assertion) => assertion.mismatched > 0,
  ).length;
  const unmeasured = entry.assertions.filter(
    (assertion) => assertion.mismatched === 0 && assertion.passed === 0,
  );
  const passed = entry.assertions.length - mismatched - unmeasured.length;
  return [
    `${name}: checked; ${passed} passed, ${mismatched} mismatched, ${unmeasured.length} unmeasured`,
    ...unmeasured.map(
      (assertion) =>
        `  - ${assertionLabel(assertion)}: ${assertion.unmeasured.join("; ")}`,
    ),
  ];
}

/** Text lines shared by the check summary and the report. */
export function briefCoverageLines(coverage: BriefCoverage): string[] {
  const count = coverage.entries.length;
  return [
    `Decided briefs: ${count} ${count === 1 ? "applies" : "apply"} to this flow.`,
    ...coverage.entries.flatMap(entryLines),
  ];
}
