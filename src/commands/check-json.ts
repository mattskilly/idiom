/**
 * The `check --changed --json` and `check --gate --json` payloads, before the
 * CLI stamps interfaceVersion and the update notice. Pure, so
 * src/interface/surfaces.ts can tie their types to the stable contracts.
 */
import { mergePending } from "../decisions/pending.js";
import { decisionQuestion } from "../decisions/question.js";
import { gatePlanLine } from "../gate/render.js";
import type { GateSkipResult } from "../gate/types.js";
import { conditionLine } from "../unattended/condition.js";
import type { CheckSummary } from "./check.js";
import type { ChangedCheckResult } from "./check-changed.js";
import type { GatePlanOnlyResult, GateRunResult } from "./check-gate.js";

/** `verdict: "deferred"` and every timed-out tuple, when any flow timed out. */
export function aggregateDeferral(
  checked: Array<{ flow: string; summary: CheckSummary }>,
) {
  const timedOutTuples = checked.flatMap((entry) =>
    (entry.summary.timedOutTuples ?? []).map((tuple) => ({
      flow: entry.flow,
      ...tuple,
    })),
  );
  return timedOutTuples.length
    ? { verdict: "deferred" as const, timedOutTuples }
    : {};
}

function checkedEntries(output: ChangedCheckResult) {
  return output.checks.flatMap((entry) =>
    entry.status === "checked" ? [entry] : [],
  );
}

function selectionJson(output: ChangedCheckResult) {
  return {
    selection: output.selection,
    checkedStates: output.checkedStates,
    checks: output.checks.map((entry) =>
      entry.status === "checked"
        ? {
            flow: entry.flow,
            status: entry.status,
            summary: entry.summary,
          }
        : entry,
    ),
  };
}

/** `idiom check --changed --json`. */
export function changedCheckJson(output: ChangedCheckResult) {
  return {
    ...aggregateDeferral(checkedEntries(output)),
    ...selectionJson(output),
  };
}

/** `idiom check --gate --json` when no changed path reaches a rendered page. */
export function gateSkipJson(result: GateSkipResult) {
  return {
    gate: {
      skipped: true as const,
      reason: result.reason,
      base: result.base,
      line: result.line,
      files: result.files,
      allFlows: result.allFlows,
    },
  };
}

/** `idiom check --gate --plan-only --json`. */
export function gatePlanOnlyJson(result: GatePlanOnlyResult) {
  return {
    gate: {
      planOnly: true as const,
      line: gatePlanLine(result.plan),
      plan: result.plan,
    },
  };
}

/**
 * `idiom check --gate --json` for a gate that ran. decisionNeeded is the
 * merged pending questions, exactly as `decide --pending` prints them.
 */
export function gateRunJson(result: GateRunResult) {
  const output = result.changed;
  const decisionNeeded = mergePending(
    checkedEntries(output).flatMap(
      (entry) => entry.summary.decisionNeeded ?? [],
    ),
  );
  return {
    gate: {
      plan: result.plan,
      skippedWork: result.skippedWork,
      estimateMs: result.estimateMs,
      budgetMs: result.budgetMs,
      server: result.server,
      comparisons: result.comparisons,
      timing: result.timing,
    },
    ...aggregateDeferral(checkedEntries(output)),
    decisionNeeded,
    decisionQuestion: decisionQuestion(decisionNeeded),
    ...selectionJson(output),
    ...(result.conditions.length === 0
      ? {}
      : {
          conditions: result.conditions.map((condition) => ({
            key: condition.key,
            cause: condition.cause,
            line: conditionLine(condition),
          })),
        }),
  };
}
