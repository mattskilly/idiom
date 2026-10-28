import { errorStateMissingCheck, retryBlockedCheck } from "./failure-state.js";
import type { FilmstripIdentity } from "./filmstrip-schema.js";
import { interactionShiftCheck } from "./interaction-shift.js";
import { layoutShiftCheck } from "./layout-shift.js";
import {
  doubleSubmitCheck,
  loadingStateMissingCheck,
} from "./loading-state.js";
import { motionCheck } from "./motion.js";
import type {
  ActionTimeline,
  ChecksConfig,
  CheckTuple,
  FindingCandidate,
} from "./types.js";

// Private recording identity is deliberately absent from enumerable observation data.
const key = Symbol("filmstrip recording");
export function recordingKey(value: object): string | undefined {
  return (value as { [key]?: string })[key];
}
export function linkRecording<T extends object>(
  value: T,
  id: string | undefined,
): T {
  return id === undefined
    ? value
    : Object.defineProperty(value, key, {
        value: id,
        enumerable: false,
        configurable: true,
      });
}
export function actionIdentity(action: ActionTimeline): FilmstripIdentity {
  return {
    source: action.source,
    kind: action.kind,
    name: action.name,
    ...(action.selector === undefined ? {} : { selector: action.selector }),
    ...(action.stepIndex === undefined ? {} : { stepIndex: action.stepIndex }),
    ...(action.failure === undefined ? {} : { failureOf: action.failure.of }),
    ...(action.held === undefined ? {} : { heldOf: action.held.of }),
  };
}
export function sameAction(
  a: FilmstripIdentity,
  b: FilmstripIdentity,
): boolean {
  return (
    a.source === b.source &&
    a.kind === b.kind &&
    a.selector === b.selector &&
    a.name === b.name &&
    a.stepIndex === b.stepIndex &&
    a.heldOf === b.heldOf &&
    a.failureOf === b.failureOf
  );
}
/** Action-linked rules share this lookup. Never infer identity from a probe ordinal. */
export function temporalAction(
  tuple: CheckTuple,
  candidate: {
    timeline?: string | undefined;
    category: string;
    verification: { params?: Record<string, unknown> | undefined };
  },
): ActionTimeline | undefined {
  const actions = tuple.timelines?.actions ?? [];
  let matches: ActionTimeline[];
  if (candidate.timeline !== undefined)
    matches = actions.filter((a) => a.id === candidate.timeline);
  else if (recordingKey(candidate))
    matches = actions.filter(
      (a) => recordingKey(a) === recordingKey(candidate),
    );
  else if (candidate.category === "layout-shift")
    matches = actions.filter((a) => a.source === "load");
  else if (candidate.category === "motion") {
    const p = candidate.verification.params ?? {};
    const motion =
      tuple.observations?.version === 2 ? tuple.observations.motion : undefined;
    const measured =
      motion?.actions.filter(
        (a) =>
          a.source === p.source &&
          a.name === p.action &&
          a.selector === p.actionSelector &&
          a.stepIndex === p.stepIndex,
      ) ?? [];
    if (measured.length !== 1) return undefined;
    const recorded = recordingKey(measured[0] as object);
    const persisted = measured[0]?.timelineId;
    matches = actions.filter((a) =>
      persisted
        ? a.id === persisted
        : recorded
          ? recordingKey(a) === recorded
          : a.source === p.source &&
            a.name === p.action &&
            a.selector === p.actionSelector &&
            a.stepIndex === p.stepIndex,
    );
  } else return undefined;
  return matches.length === 1 ? matches[0] : undefined;
}
/** Use the real rule implementations at native finish and again before publication. */
export function temporalCandidates(
  tuple: CheckTuple,
  config: ChecksConfig,
): FindingCandidate[] {
  return [
    motionCheck,
    loadingStateMissingCheck,
    doubleSubmitCheck,
    errorStateMissingCheck,
    retryBlockedCheck,
    layoutShiftCheck,
    interactionShiftCheck,
  ].flatMap(
    (check) =>
      check.run({ tuple, config, tuples: [tuple], narrowViewport: true })
        .candidates,
  );
}
