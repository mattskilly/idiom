import type { ProbeArtifact, ProbeResult } from "../checks/types.js";
import { mergeExplanations } from "./explanations.js";
import type { ProbeCandidate } from "./probe.js";
import { identityKeys, type ProbeLedger } from "./probe-ledger.js";

const keysFor = (candidates: ProbeCandidate[]) =>
  identityKeys(
    candidates.map((candidate) => ({
      ...candidate,
      role: candidate.role ?? "",
      signature: candidate.signature ?? candidate.path,
    })),
  );

/** Merge after all assigned states settle, localizing onto the saved capture. */
export function mergePlannedProbe(options: {
  ledger: ProbeLedger;
  partition: string;
  state: string;
  candidates: ProbeCandidate[];
  artifact: ProbeArtifact;
}): void {
  const { ledger, partition, state, candidates, artifact } = options;
  const partial = () => {
    if (artifact.status !== "timed-out") artifact.status = "partial";
  };
  const keys = keysFor(candidates);
  const replayed = artifact.candidates ?? candidates;
  const replayKeys = keysFor(replayed);
  const replayByKey = new Map(
    replayed.map((candidate, index) => [replayKeys[index], candidate]),
  );
  const missing = (candidate: ProbeCandidate, reason: string): ProbeResult => ({
    selector: candidate.selector,
    name: candidate.name,
    region: candidate.region,
    repeated: candidate.repeated ? true : undefined,
    persistent: true,
    effects: [],
    status: "not-reached",
    skipped: `not reached: ${reason}`,
  });
  for (const [ordinal, candidate] of candidates.entries()) {
    const key = keys[ordinal] ?? candidate.path;
    const allocation = ledger.allocation(partition, key);
    const localReplay = replayByKey.get(key);
    let position = artifact.results.findIndex(
      (result) =>
        result.selector === (localReplay?.selector ?? candidate.selector) &&
        result.name === candidate.name,
    );
    // This state's own replay failure explains its rows better than any
    // flow-level reason.
    let ownFailure = false;
    if (position < 0) {
      ownFailure = allocation?.state === state && artifact.reason !== undefined;
      const reason =
        allocation?.reason ??
        (allocation?.state === state
          ? (artifact.reason ?? "control missing after assigned state replay")
          : `assigned state ${allocation?.state ?? "unavailable"} did not complete`);
      position = artifact.results.length;
      artifact.results.push(missing(candidate, reason));
      partial();
    }
    if (!allocation?.state) continue;
    const cached = ledger.lookup(partition, key);
    const current = artifact.results[position];
    if (!cached) {
      // Attempted rows keep their own outcome; only unreached rows are restated.
      if (current?.status !== "not-reached" || ownFailure) continue;
      const final = ledger.finalReason(partition, key);
      if (final || allocation.state !== state) {
        partial();
        artifact.results[position] = missing(
          candidate,
          final ?? `assigned state ${allocation.state} did not complete`,
        );
      }
      continue;
    }
    const owner = cached.state === state;
    const { elapsedMs, timings, replayRequired, ...result } = cached.result;
    artifact.results[position] = {
      ...result,
      selector: candidate.selector,
      name: candidate.name,
      region: candidate.region,
      repeated: candidate.repeated ? true : undefined,
      persistent: true,
      ...(owner
        ? { elapsedMs, timings, replayRequired }
        : { reusedFrom: cached.state }),
    };
    // Nested items finished anywhere fill this state's unfinished rows.
    for (const nested of cached.nested ?? []) {
      const source = nested.reusedFrom ?? cached.state;
      const same = (row: ProbeResult) =>
        row.name === nested.name && row.selector === nested.selector;
      if (
        artifact.results.some((row) => same(row) && row.status === "completed")
      )
        continue;
      const row: ProbeResult =
        source === state
          ? { ...nested, reusedFrom: undefined }
          : {
              ...nested,
              elapsedMs: undefined,
              timings: undefined,
              replayRequired: undefined,
              reusedFrom: source,
            };
      const open = artifact.results.findIndex(same);
      if (open >= 0) artifact.results[open] = row;
      else artifact.results.push(row);
    }
    if (cached.explanations.length)
      artifact.explanations = mergeExplanations(artifact.explanations, {
        version: 1,
        status: "ran",
        records: cached.explanations.map((record) => ({
          ...record,
          selector: candidate.explanation?.selector ?? candidate.selector,
          controlId: candidate.explanation?.controlId,
        })),
      });
  }
  delete artifact.candidates;
}

/**
 * Fold a later probe round into the rows a state already holds. Only rows
 * the round actually worked on replace unfinished ones; placeholders for
 * other states' work are dropped.
 */
export function accumulateProbeRound(
  previous: ProbeArtifact,
  next: ProbeArtifact,
): ProbeArtifact {
  const results = [...previous.results];
  for (const row of next.results) {
    if (row.skipped?.startsWith("not reached: assigned to state:")) continue;
    const same = (other: ProbeResult) =>
      other.selector === row.selector && other.name === row.name;
    const open = results.findIndex(
      (other) => same(other) && other.status !== "completed",
    );
    if (open >= 0) results[open] = row;
    else if (!results.some(same)) results.push(row);
  }
  const explanations = mergeExplanations(
    previous.explanations,
    next.explanations,
  );
  return {
    ...previous,
    results,
    ...(explanations ? { explanations } : {}),
    ...(previous.candidates ? {} : { candidates: next.candidates }),
  };
}
