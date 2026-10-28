import { judgeFailure } from "../checks/failure-state.js";
import { judgeDoubleSubmit, judgeLoading } from "../checks/loading-state.js";
import { runDeterministicChecks } from "../checks/registry.js";
import { actionIdentity, sameAction } from "../checks/temporal-evidence.js";
import {
  type ChecksConfig,
  type CheckTuple,
  deterministicCheckIds,
} from "../checks/types.js";
import { tupleDesigns } from "../design/evidence.js";
import { buildRuleContract, settingsIdentity } from "../findings/contract.js";
import { settingsHash, stable } from "../findings/settings.js";
import type { Acceptance, RuleAcceptance } from "../schemas/acceptance.js";

export type AcceptanceResult = {
  contract: Acceptance;
  status: "passed" | "failed" | "not-recheckable";
  reason: string;
};
export function unavailableAcceptance(
  contract: Acceptance,
  reason?: string,
): AcceptanceResult {
  return {
    contract,
    status: "not-recheckable",
    reason:
      reason ??
      (contract.kind === "legacy"
        ? "Historical record has no executable acceptance condition; the finding uses legacy verification."
        : contract.kind === "rule"
          ? "Executable acceptance could not be safely evaluated."
          : "No executable condition was recorded; human acceptance has not been proven."),
  };
}
function sameCoordinate(
  a: RuleAcceptance["coordinate"],
  b: CheckTuple,
): boolean {
  return (
    a.flow === b.flow &&
    a.state === b.state &&
    a.viewport === b.viewport &&
    (a.colorScheme ?? "light") === (b.colorScheme ?? "light") &&
    a.combination === b.combination
  );
}
function sameTarget(
  a: RuleAcceptance["target"],
  b: RuleAcceptance["target"],
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "action" && b.kind === "action")
    return [a.action, ...(a.relatedActions ?? [])].some((left) =>
      [b.action, ...(b.relatedActions ?? [])].some((right) =>
        sameAction(left, right),
      ),
    );
  if (a.kind === "selectors" && b.kind === "selectors")
    return (
      [...a.selectors].sort().join("\0") === [...b.selectors].sort().join("\0")
    );
  if (a.kind === "document" && b.kind === "document" && a.region && b.region)
    return (
      a.reference === b.reference &&
      a.region.x < b.region.x + b.region.width &&
      b.region.x < a.region.x + a.region.width &&
      a.region.y < b.region.y + b.region.height &&
      b.region.y < a.region.y + a.region.height
    );
  return a.kind === "document" && b.kind === "document" && a.scope === b.scope;
}
/** A tuple-level 'ran' is insufficient for an action that was never reached. */
function targetEvidence(
  contract: RuleAcceptance,
  tuple: CheckTuple,
  config?: ChecksConfig,
): string | undefined {
  const target = contract.target;
  if (
    contract.condition.parameters.captureSettingsIdentity &&
    tuple.captureSettingsIdentity !==
      contract.condition.parameters.captureSettingsIdentity
  )
    return "Capture predicate settings or declarations changed; removing an expectation cannot prove acceptance.";
  if (
    contract.check === "missing-state" &&
    contract.rule.startsWith("idiom:expectation-")
  ) {
    const { kind, expected } = contract.condition.parameters;
    const declaration = tuple.declaredExpectations;
    const present =
      kind === "status"
        ? declaration?.status === expected
        : (kind === "text-present"
            ? declaration?.textPresent
            : kind === "selector-present"
              ? declaration?.selectorPresent
              : declaration?.selectorAbsent
          )?.includes(String(expected));
    if (!present)
      return "The original expectation is not declared in the current capture; it was not rechecked.";
  }
  const obs =
    tuple.observations?.version === 2 ? tuple.observations : undefined;
  if (
    contract.check === "layout-invariants" ||
    contract.check === "group-invariants"
  ) {
    const parameters = contract.condition.parameters;
    const matches =
      obs?.invariants?.filter(
        (record) =>
          stable(record.declaration) === stable(parameters.invariant) &&
          JSON.stringify(record.origin) === JSON.stringify(parameters.origin),
      ) ?? [];
    return matches.length === 1
      ? undefined
      : "The original invariant declaration was not measured or changed; another invariant cannot substitute for it.";
  }
  if (
    target.kind === "document" &&
    contract.check === "design-drift" &&
    target.region
  ) {
    const design = tupleDesigns(tuple).find(
      (d, index) =>
        (d.descriptor.name ?? (index ? `design-${index + 1}` : "design")) ===
        (target.reference ?? "design"),
    );
    const region = target.region;
    if (
      !design?.regions ||
      design.regions.uncompared.some(
        (band) =>
          band.top < region.y + region.height &&
          band.top + band.height > region.y,
      )
    )
      return "The original design-image region was not completely compared.";
    return undefined;
  }
  if (contract.check === "component-size") {
    const p = contract.condition.parameters;
    const matches =
      obs?.components?.filter(
        (c) => c.name === p.component && c.selector === p.selector,
      ) ?? [];
    const identity = settingsHash(
      matches.map(({ name, selector, width, height, tolerance, inferred }) => ({
        name,
        selector,
        width,
        height,
        tolerance,
        inferred,
      })),
    );
    return matches.length === 1 &&
      matches[0]?.rects.length &&
      !matches[0].unresolved &&
      identity === p.componentSettingsIdentity
      ? undefined
      : "Original component measurement or size declaration is missing, unresolved or changed.";
  }
  if (target.kind === "selectors") {
    for (const selector of target.selectors) {
      const matches =
        tuple.observations?.elements.filter((e) => e.selector === selector) ??
        [];
      if (
        matches.length !== 1 &&
        !(matches.length === 0 && contract.condition.allowRemoval)
      )
        return `Target ${selector} is missing or ambiguous; removal was not established by this condition.`;
    }
    // Geometry scans can run while individual targets were skipped.
    const scans: Record<string, unknown> = {
      "line-length": obs?.lineLengths,
      "orphan-word": obs?.orphanWords,
      "image-distortion": obs?.imageRenders,
    };
    if (Object.hasOwn(scans, contract.check)) {
      const scan = scans[contract.check] as
        | { records?: { selector: string }[] }
        | undefined;
      if (
        !scan?.records ||
        target.selectors.some(
          (s) => !scan.records?.some((r) => r.selector === s),
        )
      )
        return "The relevant target has no usable measurement in the current scan.";
    }
    return undefined;
  }
  if (
    target.kind === "document" &&
    contract.rule === "idiom:document-horizontal-overflow"
  )
    return undefined;
  if (target.kind === "document")
    return [
      "missing-state",
      "console-error",
      "heading-structure",
      "font-loading",
      "published-budget",
      "page-content",
    ].includes(contract.check)
      ? undefined
      : "Original structural target was not recorded as a resolvable selector; document-level coverage alone cannot prove it clear.";
  if (contract.condition.parameters.unresolvedActions)
    return "Some recorded motion actions lack unambiguous timeline evidence.";
  for (const action of target.relatedActions ?? []) {
    const reason = targetEvidence(
      { ...contract, target: { kind: "action", action } },
      tuple,
      config,
    );
    if (reason) return reason;
  }
  const action = target.action;
  const selector = action.selector;
  const only = <T>(entries: T[], usable: (entry: T) => boolean): boolean =>
    entries.length === 1 && usable(entries[0] as T);
  if (action.source === "probe-click" && contract.check === "dead-control") {
    const records =
      obs?.probe?.results.filter(
        (r) => r.selector === selector && r.name === action.name,
      ) ?? [];
    return only(
      records,
      (r) =>
        r.skipped === undefined &&
        (r.status === "completed" ||
          (r.status === undefined && obs?.probe?.status === "ran")),
    )
      ? undefined
      : "Original control was not completely probed (missing, skipped, timed out or ambiguous).";
  }
  if (action.source === "load-sample")
    return obs?.layoutShift?.status === "ran"
      ? undefined
      : "Page-load shift observation is unavailable.";
  if (action.source === "focus-trial")
    return only(
      obs?.focusVisible?.records.filter((r) => r.selector === selector) ?? [],
      () => true,
    )
      ? undefined
      : "Original keyboard focus target was not measured.";
  if (action.source === "liveness")
    return only(
      obs?.liveness?.entries.filter(
        (r) => r.selector === selector && r.identity === action.name,
      ) ?? [],
      (r) => r.status === "measured",
    )
      ? undefined
      : "Original liveness target was not sampled.";
  if (action.source === "touch-trial")
    return only(
      obs?.touchReachability?.entries.filter((r) => r.selector === selector) ??
        [],
      (r) =>
        r.hover.status !== "unavailable" &&
        r.focus.status !== "unavailable" &&
        obs?.touchReachability?.restored === true,
    )
      ? undefined
      : "Original hover/focus trial is incomplete.";
  if (action.source === "progress")
    return only(
      obs?.progress?.steps.filter(
        (r) =>
          r.selector === selector &&
          r.stepIndex === action.stepIndex &&
          r.action === action.kind,
      ) ?? [],
      (r) =>
        r.status === "ran" &&
        (r.firstMs !== null ||
          r.observedMs >= Number(contract.condition.parameters.withinMs)),
    )
      ? undefined
      : "Original long-running step lacks a complete feedback window.";
  if (action.source === "explanation-trial") {
    const records =
      (obs?.explanations ?? obs?.probe?.explanations)?.records ?? [];
    return ["hover", "focus"].every((trigger) =>
      records.some(
        (r) =>
          r.selector === selector &&
          r.trigger === trigger &&
          r.status !== "unavailable",
      ),
    )
      ? undefined
      : "Original control lacks complete hover and focus explanation trials.";
  }
  if (action.source === "collection-probe")
    return only(
      obs?.probe?.collections?.filter((r) => r.selector === selector) ?? [],
      (r) => r.reason === undefined && r.menus.length > 0,
    )
      ? undefined
      : "Original collection menu/context menu probe is incomplete.";
  const matches =
    tuple.timelines?.actions.filter((r) =>
      sameAction(action, actionIdentity(r)),
    ) ?? [];
  if (matches.length !== 1)
    return "Original action/replay is missing or ambiguous; another action cannot substitute for it.";
  const timeline = matches[0];
  if (
    timeline?.status !== "ran" ||
    timeline.truncated.length ||
    !timeline.settled
  )
    return "Original action timeline is partial, truncated or did not settle.";
  if (timeline.held) {
    const requests = contract.condition.parameters.requests;
    const actual = timeline.held.requests
      .map((r) => ({
        method: r.method,
        path: r.path,
        resourceType: r.resourceType,
      }))
      .sort((a, b) => stable(a).localeCompare(stable(b)));
    if (
      JSON.stringify(requests) !== JSON.stringify(actual) ||
      timeline.held.delayMs !== contract.condition.parameters.delayMs
    )
      return "Held replay request identity or delay changed.";
    const withinMs = Number(contract.condition.parameters.withinMs);
    const verdict =
      contract.check === "double-submit"
        ? judgeDoubleSubmit({ ...timeline, held: timeline.held }, withinMs)
        : judgeLoading(
            { ...timeline, held: timeline.held },
            withinMs,
            (index) =>
              obs?.progress?.steps.some(
                (s) => s.stepIndex === index && s.status === "ran",
              ) ?? false,
          );
    if (!verdict.fires && !verdict.judged)
      return `Original held replay cannot be judged: ${verdict.note}`;
  }
  if (timeline.failure) {
    if (
      JSON.stringify(contract.condition.parameters.failureRequests) !==
        JSON.stringify(
          timeline.failure.requests.map((r) => ({
            method: r.method,
            path: r.path,
          })),
        ) ||
      timeline.failure.mode !== contract.condition.parameters.failureMode ||
      timeline.failure.status !== contract.condition.parameters.failureStatus ||
      timeline.failure.feedbackWithinMs !==
        contract.condition.parameters.feedbackWithinMs
    )
      return "Failure replay requests or recovery settings changed.";
    const verdict = judgeFailure({ ...timeline, failure: timeline.failure });
    if (!verdict.judged)
      return `Original failure replay cannot be judged: ${verdict.note}`;
  }
  // Motion without a timeline may exist in historical artifacts; do not fabricate a complete window.
  void config;
  return undefined;
}
export function evaluateRuleAcceptance(options: {
  contract: RuleAcceptance;
  currentA: CheckTuple[];
  currentB: CheckTuple[];
  config?: ChecksConfig | undefined;
  expectedTupleKeys?: readonly string[] | undefined;
  checkedCaptures?:
    | readonly ReturnType<typeof runDeterministicChecks>[]
    | undefined;
}): AcceptanceResult {
  const { contract } = options;
  const result = (
    status: AcceptanceResult["status"],
    reason: string,
  ): AcceptanceResult => ({ contract, status, reason });
  if (!(deterministicCheckIds as readonly string[]).includes(contract.check))
    return unavailableAcceptance(
      contract,
      `Unknown acceptance evaluator ${contract.check}.`,
    );
  if (settingsIdentity(options.config) !== contract.condition.settingsIdentity)
    return unavailableAcceptance(
      contract,
      "Effective check settings changed; disabled checks or relaxed thresholds cannot prove acceptance.",
    );
  const statuses = [options.currentA, options.currentB].map((tuples, index) => {
    const checked =
      options.checkedCaptures?.[index] ??
      runDeterministicChecks(tuples, options.expectedTupleKeys, options.config);
    const matching = checked.candidates.some(
      ({ tuple, candidate }) =>
        sameCoordinate(contract.coordinate, tuple) &&
        candidate.rule === contract.rule &&
        sameTarget(
          contract.target,
          buildRuleContract(tuple, candidate, options.config, tuples).acceptance
            .target,
        ),
    );
    if (matching)
      return {
        status: "failed" as const,
        reason: `${contract.rule} still emits for the original target/action.`,
      };
    for (const coordinate of contract.requiredCoordinates) {
      const matches = tuples.filter((t) => sameCoordinate(coordinate, t));
      if (matches.length !== 1)
        return {
          status: "not-recheckable" as const,
          reason: `Required tuple ${coordinate.state}/${coordinate.viewport}/${coordinate.colorScheme ?? "light"} is missing or ambiguous.`,
        };
      const tuple = matches[0] as CheckTuple;
      if (tuple.failure || !tuple.observations)
        return {
          status: "not-recheckable" as const,
          reason: "Required capture failed or lacks observations.",
        };
      const coverage = checked.coverage.find(
        (r) => r.tuple === tuple && r.coverage.check === contract.check,
      )?.coverage;
      if (coverage?.status !== "ran")
        return {
          status: "not-recheckable" as const,
          reason: coverage?.reason ?? "Rule did not run on a required tuple.",
        };
      if (sameCoordinate(contract.coordinate, tuple)) {
        const reason = targetEvidence(contract, tuple, options.config);
        if (reason) return { status: "not-recheckable" as const, reason };
      }
    }
    return {
      status: "passed" as const,
      reason: `${contract.rule} is clear for the original target/action with complete evidence under unchanged settings.`,
    };
  });
  if (statuses[0]?.status !== statuses[1]?.status)
    return result(
      "not-recheckable",
      "Acceptance results disagree between current calibration captures A and B.",
    );
  const agreed = statuses[0];
  return result(
    agreed?.status ?? "not-recheckable",
    agreed?.reason ?? "No current captures.",
  );
}
