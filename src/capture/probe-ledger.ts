import type { ExplanationRecord, ProbeResult } from "../checks/types.js";
import type { ProbeCandidate } from "./probe.js";

/** What identifies one control across the states of a flow. */
export type ControlIdentityParts = {
  role: string;
  name: string;
  region?: string | undefined;
  /** `#id` for an authored id, otherwise the control's and parent's classes. */
  signature: string;
};

export type ProbeLedgerEntry = {
  result: ProbeResult;
  /** Explanation records sampled with the control, keyed to its old selector. */
  explanations: ExplanationRecord[];
  /** Completed nested menu items the control opened, reused with it. */
  nested?: ProbeResult[] | undefined;
  /** Nested items ran out of budget: another state may finish them. */
  starved?: boolean | undefined;
  state: string;
};

/**
 * Finished probe results of one capture run, keyed by control identity and
 * partitioned by viewport and colour scheme. In memory only: it is never
 * serialized and never part of a finding's identity.
 */
export type ProbeAllocation = { state?: string; reason?: string; own: boolean };
export type ProbeLedger = {
  plan(
    partition: string,
    states: Array<{ state: string; candidates: ProbeCandidate[] }>,
  ): void;
  allocation(partition: string, key: string): ProbeAllocation | undefined;
  planned(partition: string): boolean;
  registerNames(partition: string, candidates: ProbeCandidate[]): void;
  priority(partition: string, candidate: ProbeCandidate): number;
  sample(partition: string, group: string, key: string): boolean;
  assignedCount(partition: string, state: string): number;
  /**
   * Budget weight of a state's pending work: each singleton check candidate
   * counts fully, other controls (repeated rows, ordinary) a tenth each.
   */
  assignedWeight(partition: string, state: string): number;
  /** Record the identities a state enumerated. */
  seen(partition: string, keys: string[], state: string): void;
  lookup(partition: string, key: string): ProbeLedgerEntry | undefined;
  /** Only completed results are recorded; anything else is probed again. */
  record(
    partition: string,
    key: string,
    state: string,
    result: ProbeResult,
    explanations: ExplanationRecord[],
    nested?: ProbeResult[],
    starved?: boolean,
  ): void;
  /** Whether a state other than `state` enumerated this identity first. */
  enumeratedBefore(partition: string, key: string, state: string): boolean;
  /** Whether an allocated control is work in the current probe round. */
  pending(partition: string, key: string): boolean;
  /** A planned top-level attempt began in `state`. */
  attempt(partition: string, key: string, state: string): void;
  /** A planned top-level attempt ended without a completed result. */
  fail(partition: string, key: string, state: string): void;
  /**
   * Requeue every allocated control that no state finished onto a state
   * that shows it and has not attempted it yet; the next round probes only
   * those. Returns how many controls were requeued.
   */
  steal(partition: string, runnable: ReadonlySet<string>): number;
  /** Close the flow: unfinished controls get their final reason. */
  exhaust(partition: string, reason: string): void;
  /** Why an allocated control has no result anywhere, once that is final. */
  finalReason(partition: string, key: string): string | undefined;
};

/** Rank of a control that is none of the probe's own check candidates. */
export const ORDINARY_PRIORITY = 6;

export function controlIdentity(parts: ControlIdentityParts): string {
  return [parts.role, parts.name, parts.region ?? "", parts.signature].join(
    "|",
  );
}

/**
 * Identity keys for one enumeration, in order. A repeat of an identical key
 * inside the same state gets a `#n` ordinal so look-alikes stay distinct.
 */
export function identityKeys(candidates: ControlIdentityParts[]): string[] {
  const counts = new Map<string, number>();
  return candidates.map((candidate) => {
    const key = controlIdentity(candidate);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count === 1 ? key : `${key}#${count}`;
  });
}

export function createProbeLedger(): ProbeLedger {
  const entries = new Map<string, ProbeLedgerEntry>();
  const firstSeen = new Map<string, string>();
  const allocations = new Map<string, ProbeAllocation>();
  const planned = new Set<string>();
  const names = new Map<string, Set<string>>();
  const samples = new Map<string, Set<string>>();
  const occurrencesOf = new Map<
    string,
    Array<{ state: string; candidate: ProbeCandidate }>
  >();
  const pendingWork = new Set<string>();
  const attempted = new Map<string, Set<string>>();
  const failed = new Map<string, string>();
  /** How many rounds each state was handed a control without finishing it. */
  const offered = new Map<string, Map<string, number>>();
  const finals = new Map<string, string>();
  const unfinished = (id: string) => {
    const allocation = allocations.get(id);
    if (!allocation?.state || failed.has(id)) return false;
    const entry = entries.get(id);
    return !entry || entry.starved === true;
  };
  const registerNames = (partition: string, candidates: ProbeCandidate[]) => {
    for (const candidate of candidates) {
      const id = `${partition}\0${candidate.name}`;
      const surfaces = names.get(id) ?? new Set<string>();
      surfaces.add(
        `${candidate.role}|${candidate.region}|${candidate.signature}`,
      );
      names.set(id, surfaces);
    }
  };
  const sample = (partition: string, group: string, key: string) => {
    const id = `${partition}\0${group}`;
    const selected = samples.get(id) ?? new Set<string>();
    if (selected.has(key)) return true;
    if (selected.size >= 2) return false;
    selected.add(key);
    samples.set(id, selected);
    return true;
  };
  const slot = (partition: string, key: string) => `${partition}\0${key}`;
  return {
    registerNames,
    sample,
    priority(partition, candidate) {
      // The probe's own check candidates come before ordinary controls:
      // duplicate entries, unexplained glyphs, then possibly dead actions.
      // A declared popup trigger ranks with the glyphs: the items it reveals
      // (further entry points, possibly dead actions) are reached only through
      // it. Repeated rows that qualify rank after the singletons, never dropped.
      const base =
        (names.get(`${partition}\0${candidate.name}`)?.size ?? 0) > 1
          ? 0
          : candidate.explanation ||
              candidate.textLabel === false ||
              (candidate.popup === true && !candidate.submit)
            ? 1
            : candidate.textLabel &&
                !candidate.submit &&
                (candidate.role === "button" || candidate.role === "menuitem")
              ? 2
              : undefined;
      if (base === undefined) return ORDINARY_PRIORITY;
      return candidate.repeatedGroup ? base + 3 : base;
    },
    plan(partition, states) {
      planned.add(partition);
      registerNames(
        partition,
        states.flatMap((state) => state.candidates),
      );
      const controls = new Map<
        string,
        Array<{ state: string; candidate: ProbeCandidate }>
      >();
      const loads = new Map(states.map(({ state }) => [state, 0]));
      for (const { state, candidates } of states) {
        const keys = identityKeys(
          candidates.map((candidate) => ({
            ...candidate,
            role: candidate.role ?? "",
            signature: candidate.signature ?? candidate.path,
          })),
        );
        for (const [index, candidate] of candidates.entries()) {
          const key = keys[index] ?? candidate.path;
          const occurrences = controls.get(key) ?? [];
          occurrences.push({ state, candidate });
          controls.set(key, occurrences);
        }
      }
      // Sample in saved DOM order before balancing assignments.
      const sampledOut = new Set<string>();
      for (const [key, occurrences] of controls) {
        const group = occurrences[0]?.candidate.repeatedGroup;
        const first = occurrences[0]?.candidate;
        if (
          !group ||
          !first ||
          this.priority(partition, first) < ORDINARY_PRIORITY
        )
          continue;
        if (!sample(partition, group, key)) sampledOut.add(key);
      }
      // Assign state-specific work first, so sharing balances the total load.
      const ordered = [...controls].sort((a, b) => a[1].length - b[1].length);
      for (const [key, occurrences] of ordered) {
        const own = occurrences.length === 1;
        if (sampledOut.has(key)) {
          allocations.set(slot(partition, key), {
            own,
            reason: "repeated-row sample",
          });
          continue;
        }
        const available = occurrences.filter(
          ({ candidate }) => !candidate.unavailable,
        );
        const chosen = available.sort(
          (a, b) =>
            Number(a.candidate.modal === true) -
              Number(b.candidate.modal === true) ||
            (loads.get(a.state) ?? 0) - (loads.get(b.state) ?? 0),
        )[0];
        if (!chosen) {
          allocations.set(slot(partition, key), {
            own,
            reason:
              occurrences[0]?.candidate.unavailable ??
              "unavailable in every state",
          });
          continue;
        }
        allocations.set(slot(partition, key), { own, state: chosen.state });
        occurrencesOf.set(slot(partition, key), available);
        pendingWork.add(slot(partition, key));
        loads.set(chosen.state, (loads.get(chosen.state) ?? 0) + 1);
      }
    },
    allocation(partition, key) {
      return allocations.get(slot(partition, key));
    },
    planned(partition) {
      return planned.has(partition);
    },
    assignedCount(partition, state) {
      return [...allocations].filter(
        ([key, value]) =>
          key.startsWith(`${partition}\0`) &&
          value.state === state &&
          pendingWork.has(key),
      ).length;
    },
    assignedWeight(partition, state) {
      let singletons = 0;
      let others = 0;
      for (const [id, value] of allocations) {
        if (
          !id.startsWith(`${partition}\0`) ||
          value.state !== state ||
          !pendingWork.has(id)
        )
          continue;
        const candidate = occurrencesOf.get(id)?.[0]?.candidate;
        if (candidate && this.priority(partition, candidate) < 3)
          singletons += 1;
        else others += 1;
      }
      return singletons + Math.ceil(others / 10);
    },
    seen(partition, keys, state) {
      for (const key of keys) {
        const id = slot(partition, key);
        if (!firstSeen.has(id)) firstSeen.set(id, state);
      }
    },
    lookup(partition, key) {
      return entries.get(slot(partition, key));
    },
    record(partition, key, state, result, explanations, nested, starved) {
      if (result.status !== "completed") return;
      const id = slot(partition, key);
      const existing = entries.get(id);
      if (!existing) {
        entries.set(id, {
          result: structuredClone(result),
          explanations: structuredClone(explanations),
          ...(nested?.length ? { nested: structuredClone(nested) } : {}),
          ...(starved ? { starved: true } : {}),
          state,
        });
        return;
      }
      if (!existing.starved) return;
      // A later state finished nested items the first one could not reach.
      if (!existing.explanations.length && explanations.length)
        existing.explanations = structuredClone(explanations);
      const known = new Map<string, number>();
      for (const item of existing.nested ?? [])
        known.set(item.name, (known.get(item.name) ?? 0) + 1);
      for (const item of nested ?? []) {
        const count = known.get(item.name) ?? 0;
        if (count > 0) {
          known.set(item.name, count - 1);
          continue;
        }
        const {
          elapsedMs: _elapsed,
          timings: _timings,
          replayRequired: _replay,
          ...rest
        } = structuredClone(item);
        existing.nested = [
          ...(existing.nested ?? []),
          { ...rest, reusedFrom: item.reusedFrom ?? state },
        ];
      }
      existing.starved = starved === true;
    },
    pending(partition, key) {
      return pendingWork.has(slot(partition, key));
    },
    attempt(partition, key, state) {
      const id = slot(partition, key);
      const states = attempted.get(id) ?? new Set<string>();
      states.add(state);
      attempted.set(id, states);
    },
    fail(partition, key, state) {
      const id = slot(partition, key);
      if (!entries.has(id)) failed.set(id, state);
    },
    steal(partition, runnable) {
      pendingWork.clear();
      const loads = new Map<string, number>();
      let requeued = 0;
      for (const [id, allocation] of allocations) {
        if (!id.startsWith(`${partition}\0`) || !unfinished(id)) continue;
        const tried = attempted.get(id) ?? new Set<string>();
        // The state that just held it was offered it once more.
        const offers = offered.get(id) ?? new Map<string, number>();
        if (allocation.state)
          offers.set(allocation.state, (offers.get(allocation.state) ?? 0) + 1);
        offered.set(id, offers);
        const chosen = (occurrencesOf.get(id) ?? [])
          .filter(
            ({ state }) =>
              runnable.has(state) &&
              !tried.has(state) &&
              (offers.get(state) ?? 0) < 2,
          )
          .sort(
            (a, b) =>
              Number(a.candidate.modal === true) -
                Number(b.candidate.modal === true) ||
              (offers.get(a.state) ?? 0) - (offers.get(b.state) ?? 0) ||
              (loads.get(a.state) ?? 0) - (loads.get(b.state) ?? 0),
          )[0];
        if (!chosen) {
          finals.set(
            id,
            entries.has(id)
              ? "nested items not reached in any state that shows it"
              : `not completed in any state that shows it (tried ${[...new Set([...offers.keys(), ...tried])].join(", ")})`,
          );
          continue;
        }
        allocation.state = chosen.state;
        pendingWork.add(id);
        loads.set(chosen.state, (loads.get(chosen.state) ?? 0) + 1);
        requeued += 1;
      }
      return requeued;
    },
    exhaust(partition, reason) {
      pendingWork.clear();
      for (const [id, allocation] of allocations) {
        if (!id.startsWith(`${partition}\0`)) continue;
        if (failed.has(id) && !entries.has(id))
          finals.set(id, `timed out at state ${failed.get(id)}`);
        else if (allocation.state && unfinished(id) && !finals.has(id))
          finals.set(id, reason);
      }
    },
    finalReason(partition, key) {
      return finals.get(slot(partition, key));
    },
    enumeratedBefore(partition, key, state) {
      const first = firstSeen.get(slot(partition, key));
      return first !== undefined && first !== state;
    },
  };
}
