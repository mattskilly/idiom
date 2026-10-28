import { checksConfigFrom } from "../checks/registry.js";
import { actionIdentity, temporalAction } from "../checks/temporal-evidence.js";
import type {
  ChecksConfig,
  CheckTuple,
  FindingCandidate,
} from "../checks/types.js";
import type {
  AcceptanceAction,
  BasisDetails,
  RuleAcceptance,
} from "../schemas/acceptance.js";
import { jsonRecord } from "./json.js";
import { settingsHash, stable } from "./settings.js";

export function settingsIdentity(config?: ChecksConfig): string {
  return settingsHash({ ...checksConfigFrom(), ...config });
}
export function coordinate(tuple: CheckTuple) {
  return {
    flow: tuple.flow,
    state: tuple.state,
    viewport: tuple.viewport,
    ...(tuple.colorScheme === undefined
      ? {}
      : { colorScheme: tuple.colorScheme }),
    ...(tuple.combination === undefined
      ? {}
      : { combination: tuple.combination }),
  };
}
const crossChecks = new Set([
  "responsive-break",
  "spacing-rhythm",
  "luminance-parity",
  "sibling-chrome",
  "cross-surface-naming",
]);
export function buildRuleContract(
  tuple: CheckTuple,
  candidate: FindingCandidate,
  config?: ChecksConfig,
  tuples: CheckTuple[] = [tuple],
): {
  basis: "measured" | "observed";
  basisDetails: BasisDetails;
  acceptance: RuleAcceptance;
} {
  const params = candidate.verification.params ?? {};
  const timeline = temporalAction(tuple, candidate);
  const action: AcceptanceAction | undefined = timeline
    ? actionIdentity(timeline)
    : candidate.observation?.action;
  const required = crossChecks.has(candidate.category)
    ? tuples
    : (candidate.evidenceTuples ?? [tuple]);
  const realSelectors = new Set(
    tuple.observations?.elements.map((e) => e.selector) ?? [],
  );
  const explicit =
    candidate.targetSelectors ??
    (Array.isArray(params.selectors) &&
    params.selectors.every((s) => typeof s === "string")
      ? (params.selectors as string[])
      : typeof params.selector === "string"
        ? [
            params.selector,
            ...(typeof params.neighbour === "string" ? [params.neighbour] : []),
          ]
        : typeof params.a === "string" && typeof params.b === "string"
          ? [params.a, params.b]
          : undefined);
  const selectors = explicit ?? [candidate.selectorHint];
  const relatedActions: AcceptanceAction[] = [];
  let unresolvedActions = 0;
  if (candidate.rule === "idiom:motion-snap" && Array.isArray(params.actions)) {
    for (const raw of params.actions) {
      const recorded = raw as Record<string, unknown>;
      const matches =
        tuple.timelines?.actions.filter(
          (a) =>
            a.source === recorded.source &&
            a.selector === recorded.selector &&
            a.name === recorded.name &&
            a.stepIndex === recorded.stepIndex,
        ) ?? [];
      if (matches.length === 1 && matches[0])
        relatedActions.push(actionIdentity(matches[0]));
      else unresolvedActions++;
    }
  }
  const target: RuleAcceptance["target"] = action
    ? {
        kind: "action",
        action,
        ...(relatedActions.length ? { relatedActions } : {}),
      }
    : candidate.documentScope ||
        (!explicit && !selectors.every((s) => realSelectors.has(s)))
      ? {
          kind: "document",
          scope: candidate.fingerprintHint ?? candidate.selectorHint,
          ...(candidate.designDrift?.region
            ? {
                region: candidate.designDrift.region.rect,
                ...(candidate.designDrift.reference
                  ? { reference: candidate.designDrift.reference }
                  : {}),
              }
            : {}),
        }
      : { kind: "selectors", selectors };
  const settings = config ?? checksConfigFrom();
  const thresholds = {
    interactionShift: settings.interactionShift,
    layoutShift: settings.layoutShift,
    withinMs: settings.progressWithinMs,
    loading: settings.loading,
    failure: settings.failure,
  };
  const actionEvidence = timeline
    ? jsonRecord({
        status: timeline.status,
        durationMs: timeline.durationMs,
        held: timeline.held,
        failure: timeline.failure,
      })
    : (candidate.observation?.result ?? {});
  // The explanation contains the actual measured/structural result, rather than invented numbers.
  const basisDetails: BasisDetails = action
    ? {
        kind: "observed",
        summary: candidate.explanation,
        action,
        timing: timeline
          ? { elapsedMs: timeline.durationMs }
          : (candidate.observation?.timing ?? {
              reason: "Timing was not recorded in this capture.",
            }),
        result: actionEvidence,
      }
    : {
        kind: "measured",
        rule: candidate.rule,
        summary: candidate.explanation,
        measurement: jsonRecord({
          ...params,
          result: candidate.explanation,
          ...(candidate.axeNodes ? { axeNodes: candidate.axeNodes } : {}),
        }),
      };
  return {
    basis: action ? "observed" : "measured",
    basisDetails,
    acceptance: {
      version: 1,
      kind: "rule",
      rule: candidate.rule,
      check: candidate.verification.check,
      doneWhen: candidate.acceptance,
      coordinate: coordinate(tuple),
      requiredCoordinates: [
        ...new Map(
          [tuple, ...required].map((t) => [
            stable(coordinate(t)),
            coordinate(t),
          ]),
        ).values(),
      ],
      target,
      condition: {
        kind: "rule-clear",
        settingsIdentity: settingsIdentity(config),
        parameters: jsonRecord({
          ...params,
          thresholds,
          ...(candidate.category === "component-size" &&
          tuple.observations?.version === 2
            ? {
                componentSettingsIdentity: settingsHash(
                  tuple.observations.components
                    ?.filter(
                      (c) =>
                        c.name === params.component &&
                        c.selector === params.selector,
                    )
                    .map(
                      ({
                        name,
                        selector,
                        width,
                        height,
                        tolerance,
                        inferred,
                      }) => ({
                        name,
                        selector,
                        width,
                        height,
                        tolerance,
                        inferred,
                      }),
                    ),
                ),
              }
            : {}),
          ...(tuple.captureSettingsIdentity
            ? { captureSettingsIdentity: tuple.captureSettingsIdentity }
            : {}),
          ...([
            "interaction-shift",
            "target-size",
            "spacing-rhythm",
            "overflow-clip",
            "adjacent-gap",
          ].includes(candidate.category)
            ? { units: { distance: "CSS px" } }
            : {}),
          ...([
            "motion",
            "liveness",
            "loading-state-missing",
            "double-submit",
            "progress-affordance",
            "error-state-missing",
            "retry-blocked",
          ].includes(candidate.category)
            ? { units: { time: "ms" } }
            : {}),
          ...(unresolvedActions ? { unresolvedActions } : {}),
          ...(timeline?.failure
            ? {
                failureRequests: timeline.failure.requests
                  .map((r) => ({
                    method: r.method,
                    path: r.path,
                  }))
                  .sort((a, b) => stable(a).localeCompare(stable(b))),
                failureMode: timeline.failure.mode,
                failureStatus: timeline.failure.status,
                feedbackWithinMs: timeline.failure.feedbackWithinMs,
              }
            : {}),
          ...(timeline?.held
            ? {
                requests: timeline.held.requests
                  .map((r) => ({
                    method: r.method,
                    path: r.path,
                    resourceType: r.resourceType,
                  }))
                  .sort((a, b) => stable(a).localeCompare(stable(b))),
                delayMs: timeline.held.delayMs,
              }
            : {}),
        }),
        allowRemoval: candidate.allowRemoval ?? false,
      },
    },
  };
}
