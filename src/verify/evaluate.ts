import { tupleCoordinate, tupleCoordinateKey } from "../baseline/coordinate.js";
import { runDeterministicChecks } from "../checks/registry.js";
import type { ChecksConfig, CheckTuple } from "../checks/types.js";
import { designIdentity } from "../design/identity.js";
import { IdiomError } from "../errors.js";
import { findingFingerprintIdentity } from "../review/fingerprint.js";
import { compareOccurrences } from "../review/occurrences.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import {
  type AcceptanceResult,
  evaluateRuleAcceptance,
  unavailableAcceptance,
} from "./acceptance.js";
import { compareFindingLocus, type LocusComparison } from "./locus.js";
import {
  assertMaskAgreement,
  buildSemanticProfile,
  type ProfileKind,
  type SemanticProfile,
} from "./profile.js";

export type CalibrationResult = {
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark" | undefined;
  fullV2: "equal";
  fullV2Signature: string;
  negotiated: ProfileKind;
  negotiatedResult: "equal";
  baselineProfile: SemanticProfile;
  currentProfileA: SemanticProfile;
  currentProfileB: SemanticProfile;
};

export type FindingVerdict = {
  finding: Finding;
  acceptance: AcceptanceResult;
  status: "fixed" | "reproduced" | "unverifiable";
  reason: string;
  locus?: LocusComparison | undefined;
};

export type VerificationEvaluation = {
  calibrations: CalibrationResult[];
  findings: FindingVerdict[];
  newBlockers: string[];
  newFindings?: DeterministicCandidateRecord[] | undefined;
  passed: boolean;
};

function requireTuple(
  tuples: CheckTuple[],
  state: string,
  viewport: string,
  colorScheme: "light" | "dark",
  label: string,
): CheckTuple {
  const coordinate = `${state}/${viewport}${tuples.some((tuple) => tuple.colorSchemeAxis) ? `/${colorScheme}` : ""}`;
  const matches = tuples.filter(
    (tuple) =>
      tuple.state === state &&
      tuple.viewport === viewport &&
      (tuple.colorScheme ?? "light") === colorScheme,
  );
  if (matches.length !== 1)
    throw new IdiomError(
      `${label} has ${matches.length} tuples for ${coordinate}`,
    );
  const tuple = matches[0] as CheckTuple;
  if (tuple.failure !== undefined)
    throw new IdiomError(
      `${label} tuple ${coordinate} failed at ${tuple.failure.stage}: ${tuple.failure.message}`,
    );
  if (tuple.observations === undefined)
    throw new IdiomError(`${label} tuple ${coordinate} has no observations`);
  return tuple;
}

function assertSameMachine(
  baseline: CheckTuple,
  currentA: CheckTuple,
  currentB: CheckTuple,
): void {
  if (
    baseline.platform === undefined ||
    currentA.platform === undefined ||
    currentB.platform === undefined
  )
    throw new IdiomError(
      `tuple ${baseline.state}/${baseline.viewport} lacks platform metadata`,
    );
  const machine = (tuple: CheckTuple) =>
    `${tuple.platform?.platform}\0${tuple.platform?.architecture}\0${tuple.platform?.release}\0${tuple.platform?.browserVersion}`;
  if (
    machine(baseline) !== machine(currentA) ||
    machine(currentA) !== machine(currentB)
  )
    throw new IdiomError(
      `cross-machine evidence is unsupported for ${baseline.state}/${baseline.viewport}`,
    );
}

type CandidateIdentity = {
  identities: Set<string>;
  blocker: boolean;
  label: string;
};

/** Every fingerprint (and alias) the deterministic checks produce for a run. */
export function deterministicFingerprintSet(
  tuples: CheckTuple[],
  legacyColorScheme: "light" | "dark",
  config?: ChecksConfig,
): Set<string> {
  return new Set(
    [
      ...candidateFingerprints(
        tuples,
        legacyColorScheme,
        undefined,
        config,
      ).values(),
    ].flatMap(({ identities }) => [...identities]),
  );
}

/** Raw deterministic identities, independent of review policy and attention caps. */
export function deterministicCandidateRecords(options: {
  tuples: CheckTuple[];
  legacyColorScheme: "light" | "dark";
  expectedTupleKeys: readonly string[];
  config?: ChecksConfig | undefined;
}) {
  return runDeterministicChecks(
    options.tuples,
    options.expectedTupleKeys,
    options.config,
  ).candidates.map(({ tuple, candidate }) => ({
    coordinate: tupleCoordinate(tuple),
    key: tupleCoordinateKey(tupleCoordinate(tuple)),
    ...findingFingerprintIdentity({
      category: candidate.category,
      flow: tuple.flow,
      state: tuple.state,
      rule: candidate.rule,
      selectorHint: candidate.fingerprintHint ?? candidate.selectorHint,
      ...(tuple.colorSchemeAxis
        ? {
            colorScheme: tuple.colorScheme,
            legacyColorScheme: options.legacyColorScheme,
          }
        : {}),
    }),
    category: candidate.category,
    rule: candidate.rule,
    severity: candidate.severity,
    selector: candidate.selectorHint,
  }));
}

export type DeterministicCandidateRecord = ReturnType<
  typeof deterministicCandidateRecords
>[number];

function candidateFingerprints(
  tuples: CheckTuple[],
  legacyColorScheme: "light" | "dark",
  expectedTupleKeys?: readonly string[],
  config?: ChecksConfig,
): Map<string, CandidateIdentity> {
  const result = new Map<string, CandidateIdentity>();
  for (const { tuple, candidate } of runDeterministicChecks(
    tuples,
    expectedTupleKeys,
    config,
  ).candidates) {
    const identity = findingFingerprintIdentity({
      category: candidate.category,
      flow: tuple.flow,
      state: tuple.state,
      rule: candidate.rule,
      selectorHint: candidate.fingerprintHint ?? candidate.selectorHint,
      ...(tuple.colorSchemeAxis
        ? {
            colorScheme: tuple.colorScheme,
            legacyColorScheme,
          }
        : {}),
    });
    const coordinate = `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? legacyColorScheme}`;
    result.set(`${coordinate}\0${identity.fingerprint}`, {
      identities: new Set([identity.fingerprint, ...identity.aliases]),
      blocker: candidate.severity === "blocker",
      label: `${candidate.category} on ${tuple.state}/${tuple.viewport}${tuple.colorSchemeAxis ? `/${tuple.colorScheme ?? legacyColorScheme}` : ""}: ${candidate.explanation}`,
    });
  }
  return result;
}

function assertDeterministicAgreement(
  first: CheckTuple[],
  second: CheckTuple[],
  legacyColorScheme: "light" | "dark",
  expectedTupleKeys?: readonly string[],
  config?: ChecksConfig,
): void {
  const deterministicSignature = (tuples: CheckTuple[]) => {
    const checked = runDeterministicChecks(tuples, expectedTupleKeys, config);
    return JSON.stringify({
      candidates: [
        ...candidateFingerprints(
          tuples,
          legacyColorScheme,
          expectedTupleKeys,
          config,
        ).keys(),
      ].sort(),
      coverage: checked.coverage
        .map(({ tuple, coverage }) => ({
          tuple: `${tuple.state}/${tuple.viewport}${tuple.colorSchemeAxis ? `/${tuple.colorScheme ?? legacyColorScheme}` : ""}`,
          ...coverage,
        }))
        .sort((left, right) =>
          `${left.tuple}/${left.check}`.localeCompare(
            `${right.tuple}/${right.check}`,
          ),
        ),
      captureCoverage: checked.captureCoverage,
    });
  };
  const left = deterministicSignature(first);
  const right = deterministicSignature(second);
  if (left !== right)
    throw new IdiomError(
      "current captures disagree on deterministic check results",
    );
}

export function evaluateVerification(options: {
  findings: Finding[];
  baseline: CheckTuple[];
  currentA: CheckTuple[];
  currentB: CheckTuple[];
  legacyColorScheme?: "light" | "dark" | undefined;
  expectedTupleKeys?: readonly string[] | undefined;
  checksConfig?: ChecksConfig | undefined;
  fullFlow?: boolean | undefined;
}): VerificationEvaluation {
  const legacyColorScheme = options.legacyColorScheme ?? "light";
  const axisAware = options.currentB.some((tuple) => tuple.colorSchemeAxis);
  const multiSchemeSelection =
    new Set(
      options.currentB.map((tuple) => tuple.colorScheme ?? legacyColorScheme),
    ).size > 1;
  if (!multiSchemeSelection)
    assertDeterministicAgreement(
      options.currentA,
      options.currentB,
      legacyColorScheme,
      options.expectedTupleKeys,
      options.checksConfig,
    );
  const tupleKeys = [
    ...new Set(
      options.currentB.map(
        (tuple) =>
          `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? legacyColorScheme}`,
      ),
    ),
  ];
  const calibrations = tupleKeys.map((tupleKey): CalibrationResult => {
    const [state = "", viewport = "", rawColorScheme = legacyColorScheme] =
      tupleKey.split("\0");
    const colorScheme = rawColorScheme as "light" | "dark";
    const coordinate = `${state}/${viewport}${axisAware ? `/${colorScheme}` : ""}`;
    const baseline = requireTuple(
      options.baseline,
      state,
      viewport,
      colorScheme,
      "baseline",
    );
    const currentA = requireTuple(
      options.currentA,
      state,
      viewport,
      colorScheme,
      "current run A",
    );
    const currentB = requireTuple(
      options.currentB,
      state,
      viewport,
      colorScheme,
      "current run B",
    );
    if (
      baseline.width !== currentA.width ||
      baseline.height !== currentA.height ||
      currentA.width !== currentB.width ||
      currentA.height !== currentB.height
    )
      throw new IdiomError(
        `viewport dimensions drift for ${coordinate}: baseline ${baseline.width}x${baseline.height}, A ${currentA.width}x${currentA.height}, B ${currentB.width}x${currentB.height}`,
      );
    assertSameMachine(baseline, currentA, currentB);
    if (
      currentA.observations?.version !== 2 ||
      currentB.observations?.version !== 2
    )
      throw new IdiomError(
        `fresh verify captures must emit observation version 2 for ${coordinate}`,
      );
    try {
      assertMaskAgreement(currentA.observations, currentB.observations);
    } catch (error) {
      throw new IdiomError(
        `${error instanceof Error ? error.message : String(error)} for ${coordinate}`,
      );
    }
    const fullA = buildSemanticProfile({
      artifact: currentA.observations,
      kind: "v2-full",
    });
    const fullB = buildSemanticProfile({
      artifact: currentB.observations,
      kind: "v2-full",
    });
    if (fullA.signature !== fullB.signature)
      throw new IdiomError(
        `nondeterministic v2-full signature for ${coordinate}`,
      );
    const negotiated: ProfileKind =
      baseline.observations?.version === 1 ? "v1-compatible" : "v2-full";
    const membership = currentB.observations.maskMembership;
    const baselineProfile = buildSemanticProfile({
      artifact: baseline.observations as NonNullable<
        CheckTuple["observations"]
      >,
      kind: negotiated,
      ...(negotiated === "v1-compatible" ? { maskMembership: membership } : {}),
    });
    const currentProfileA = buildSemanticProfile({
      artifact: currentA.observations,
      kind: negotiated,
      ...(negotiated === "v1-compatible" ? { maskMembership: membership } : {}),
    });
    const currentProfileB = buildSemanticProfile({
      artifact: currentB.observations,
      kind: negotiated,
      ...(negotiated === "v1-compatible" ? { maskMembership: membership } : {}),
    });
    if (currentProfileA.signature !== currentProfileB.signature)
      throw new IdiomError(
        `nondeterministic ${negotiated} signature for ${coordinate}`,
      );
    return {
      state,
      viewport,
      ...(axisAware ? { colorScheme } : {}),
      fullV2: "equal",
      fullV2Signature: fullB.signature,
      negotiated,
      negotiatedResult: "equal",
      baselineProfile,
      currentProfileA,
      currentProfileB,
    };
  });
  const calibrationByTuple = new Map(
    calibrations.map((calibration) => [
      `${calibration.state}\0${calibration.viewport}\0${calibration.colorScheme ?? legacyColorScheme}`,
      calibration,
    ]),
  );
  if (multiSchemeSelection)
    assertDeterministicAgreement(
      options.currentA,
      options.currentB,
      legacyColorScheme,
      options.expectedTupleKeys,
      options.checksConfig,
    );
  const currentCandidates = candidateFingerprints(
    options.currentB,
    legacyColorScheme,
    options.expectedTupleKeys,
    options.checksConfig,
  );
  const checkedCaptures = options.findings.some(
    (f) => !Array.isArray(f.acceptance) && f.acceptance.kind === "rule",
  )
    ? [options.currentA, options.currentB].map((tuples) =>
        runDeterministicChecks(
          tuples,
          options.expectedTupleKeys,
          options.checksConfig,
        ),
      )
    : undefined;
  const findings = options.findings.map((input): FindingVerdict => {
    const finding = findingSchema.parse(input);
    const acceptance = unavailableAcceptance(
      finding.acceptance,
      finding.verification.kind === "manual"
        ? "Manual findings cannot be proven fixed by offline verification."
        : undefined,
    );
    if (finding.verification.kind === "deterministic-check") {
      const coordinate = `${finding.state}\0${finding.viewport}\0${finding.colorScheme ?? legacyColorScheme}`;
      if (finding.category === "design-drift") {
        const identities = [
          options.baseline,
          options.currentA,
          options.currentB,
        ].map((tuples) => {
          const tuple = tuples.find(
            (t) =>
              `${t.state}\0${t.viewport}\0${t.colorScheme ?? legacyColorScheme}` ===
              coordinate,
          );
          return tuple ? designIdentity(tuple) : undefined;
        });
        if (
          options.checksConfig?.designDrift?.enabled === false ||
          identities.some((id) => id === undefined) ||
          new Set(identities).size !== 1
        )
          return {
            finding,
            acceptance: unavailableAcceptance(
              finding.acceptance,
              "Design comparison requires usable, unchanged intended reference evidence in baseline and both current captures.",
            ),
            status: "unverifiable",
            reason:
              "Design comparison requires usable, unchanged intended reference evidence in baseline and both current captures.",
          };
      }
      if (finding.acceptance.kind === "rule") {
        const evaluated = evaluateRuleAcceptance({
          contract: finding.acceptance,
          checkedCaptures,
          currentA: options.currentA,
          currentB: options.currentB,
          config: options.checksConfig,
          expectedTupleKeys: options.expectedTupleKeys,
        });
        return {
          finding,
          acceptance: evaluated,
          status:
            evaluated.status === "passed"
              ? "fixed"
              : evaluated.status === "failed"
                ? "reproduced"
                : "unverifiable",
          reason: evaluated.reason,
        };
      }
      const reproduced = [...currentCandidates.entries()].some(
        ([key, candidate]) =>
          key.startsWith(`${coordinate}\0`) &&
          candidate.identities.has(finding.fingerprint),
      );
      return {
        finding,
        acceptance,
        status: reproduced ? "reproduced" : "fixed",
        reason: reproduced
          ? `legacy fingerprint evaluation: declared deterministic fingerprint ${finding.fingerprint} still emits`
          : `legacy fingerprint evaluation: declared deterministic fingerprint ${finding.fingerprint} no longer emits`,
      };
    }
    if (finding.verification.kind === "manual")
      return {
        finding,
        acceptance,
        status: "unverifiable",
        reason:
          "manual findings cannot be proven fixed by offline verification",
      };
    const calibration = calibrationByTuple.get(
      `${finding.state}\0${finding.viewport}\0${finding.colorScheme ?? legacyColorScheme}`,
    );
    if (calibration === undefined)
      throw new IdiomError(`missing calibration for finding ${finding.id}`);
    const locus = compareFindingLocus({
      finding,
      baseline: calibration.baselineProfile,
      currentA: calibration.currentProfileA,
      currentB: calibration.currentProfileB,
    });
    return {
      finding,
      acceptance,
      status: locus.changed ? "fixed" : "reproduced",
      reason: locus.changed
        ? `negotiated ${calibration.negotiated} evidence changed within ${locus.source}`
        : `negotiated ${calibration.negotiated} evidence is unchanged within ${locus.source}`,
      locus,
    };
  });
  const baselineCandidates = candidateFingerprints(
    options.baseline,
    legacyColorScheme,
    options.expectedTupleKeys,
    options.checksConfig,
  );
  const newBlockers = [...currentCandidates.entries()]
    .filter(([key, candidate]) => {
      if (!candidate.blocker) return false;
      const coordinate = key.split("\0").slice(0, 3).join("\0");
      return ![...baselineCandidates.entries()].some(
        ([baselineKey, baseline]) =>
          baselineKey.startsWith(`${coordinate}\0`) &&
          [...candidate.identities].some((identity) =>
            baseline.identities.has(identity),
          ),
      );
    })
    .map(([, candidate]) => candidate.label)
    .sort();
  return {
    calibrations,
    findings,
    newBlockers,
    ...(options.fullFlow
      ? {
          newFindings: compareOccurrences(
            deterministicCandidateRecords({
              tuples: options.baseline,
              legacyColorScheme,
              expectedTupleKeys: options.expectedTupleKeys ?? [],
              config: options.checksConfig,
            }),
            deterministicCandidateRecords({
              tuples: options.currentB,
              legacyColorScheme,
              expectedTupleKeys: options.expectedTupleKeys ?? [],
              config: options.checksConfig,
            }),
          ).introduced,
        }
      : {}),
    passed:
      findings.every(({ status }) => status === "fixed") &&
      newBlockers.length === 0,
  };
}
