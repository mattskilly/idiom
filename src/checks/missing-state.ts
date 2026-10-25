import { buildSemanticProfile } from "../verify/profile.js";
import { ran, verify } from "./shared.js";
import type {
  CheckTuple,
  DeterministicCheck,
  FindingCandidate,
} from "./types.js";

export const missingStateCheck: DeterministicCheck = {
  id: "missing-state",
  run({ tuple }) {
    const candidates: FindingCandidate[] = [];
    if (tuple.failure !== undefined) {
      candidates.push({
        category: this.id,
        severity: "blocker",
        rule: `idiom:tuple-failure:${tuple.failure.stage}`,
        selectorHint: `${tuple.state}/${tuple.viewport}`,
        explanation: `The declared state did not render during ${tuple.failure.stage}: ${tuple.failure.message}`,
        acceptance: [
          `The ${tuple.state} state completes capture at ${tuple.viewport} without a ${tuple.failure.stage} failure.`,
        ],
        verification: verify(this.id, { stage: tuple.failure.stage }),
      });
    }
    for (const mismatch of tuple.mismatches) {
      const actual =
        mismatch.actual === undefined
          ? "not observed"
          : String(mismatch.actual);
      candidates.push({
        category: this.id,
        severity: "blocker",
        rule: `idiom:expectation-${mismatch.kind}`,
        selectorHint: `${tuple.state}:${mismatch.kind}:${String(mismatch.expected)}`,
        explanation: `The ${mismatch.kind} expectation was ${JSON.stringify(mismatch.expected)}, but the capture recorded ${actual}.`,
        acceptance: [
          `The declared ${mismatch.kind} expectation ${JSON.stringify(mismatch.expected)} passes.`,
        ],
        verification: verify(this.id, {
          kind: mismatch.kind,
          expected: mismatch.expected,
        }),
      });
    }
    return ran(this.id, candidates);
  },
};

function tupleKey(tuple: CheckTuple): string {
  return `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? "light"}`;
}

export function missingColorSchemeCandidates(
  tuples: CheckTuple[],
  expectedTupleKeys?: readonly string[],
): Array<{
  tuple: CheckTuple;
  candidate: FindingCandidate;
  checkOrder: number;
}> {
  if (expectedTupleKeys === undefined || tuples.length === 0) return [];
  const observed = [...new Set(tuples.map(tupleKey))].sort();
  const expected = [...new Set(expectedTupleKeys)].sort();
  if (
    observed.length !== expected.length ||
    observed.some((key, index) => key !== expected[index])
  )
    return [];
  const schemes = [
    ...new Set(expectedTupleKeys.map((key) => key.split("\0")[2] ?? "light")),
  ];
  if (schemes.length < 2) return [];
  const byKey = new Map(tuples.map((tuple) => [tupleKey(tuple), tuple]));
  const coordinates = [
    ...new Set(
      expectedTupleKeys.map((key) => key.split("\0").slice(0, 2).join("\0")),
    ),
  ];
  const results = [];
  for (let index = 1; index < schemes.length; index += 1) {
    const previous = schemes[index - 1] as string;
    const duplicate = schemes[index] as string;
    const evidence: CheckTuple[] = [];
    let identical = true;
    for (const coordinate of coordinates) {
      const left = byKey.get(`${coordinate}\0${previous}`);
      const right = byKey.get(`${coordinate}\0${duplicate}`);
      if (
        left === undefined ||
        right === undefined ||
        left.failure !== undefined ||
        right.failure !== undefined ||
        left.mismatches.length > 0 ||
        right.mismatches.length > 0 ||
        left.observations?.version !== 2 ||
        right.observations?.version !== 2
      ) {
        identical = false;
        break;
      }
      evidence.push(left, right);
      const leftProfile = buildSemanticProfile({
        artifact: left.observations,
        kind: "v2-full",
      });
      const rightProfile = buildSemanticProfile({
        artifact: right.observations,
        kind: "v2-full",
      });
      if (leftProfile.signature !== rightProfile.signature) {
        identical = false;
        break;
      }
    }
    const representative = tuples.find(
      (tuple) => (tuple.colorScheme ?? "light") === duplicate,
    );
    if (!identical || representative === undefined) continue;
    results.push({
      tuple: representative,
      checkOrder: 8,
      candidate: {
        category: "missing-state" as const,
        severity: "blocker" as const,
        rule: "idiom:missing-color-scheme",
        selectorHint: `color-scheme:${duplicate}=${previous}`,
        explanation: `The declared ${duplicate} color scheme rendered identically to ${previous} across every captured state and viewport.`,
        acceptance: [
          `The ${duplicate} color scheme produces a stable rendered difference from ${previous} on at least one captured surface.`,
        ],
        verification: verify("missing-state", {
          previousColorScheme: previous,
          colorScheme: duplicate,
          fullFlow: true,
        }),
        evidenceTuples: [...new Set(evidence)],
      },
    });
  }
  return results;
}
