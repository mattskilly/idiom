import type { ActionTimeline } from "../checks/types.js";

/** One web step's held replays, as the state that ran them recorded them. */
export type ReplayEntry = {
  state: string;
  /** `slow-replay` and `failure-replay` timelines of the step, without ids. */
  actions: ActionTimeline[];
  /** Failure-replay keys the run completed. */
  failureKeys: string[];
};

export type ReplayCopy = {
  actions: ActionTimeline[];
  failureKeys: string[];
  /** Steps copied, and how many of them carried a failure replay. */
  reused: number;
  failureReused: number;
};

/**
 * Held replays of web steps, once per flow. A web step's held replay depends
 * only on the steps before it (and the step), so every state reached through
 * the same prefix would replay it identically. Each key gets one owner per
 * probe round, fixed before the round starts: only the owner replays it, the
 * other holders skip it without waiting, and the owner's result is copied to
 * them after the round. An owner that did not record hands the key to
 * another holder next round. In memory only, partitioned by viewport and
 * colour scheme; never serialized and never part of a finding's identity.
 */
export type ReplayLedger = {
  plan(
    partition: string,
    states: Array<{ state: string; keys: string[] }>,
  ): void;
  planned(partition: string): boolean;
  /** The state that replays `key` this round; undefined when unplanned. */
  owner(partition: string, key: string): string | undefined;
  /** Keys `state` owns that have no result yet and are not final. */
  assignedCount(partition: string, state: string): number;
  /** First result wins. */
  record(
    partition: string,
    key: string,
    state: string,
    actions: ActionTimeline[],
    failureKeys: string[],
  ): void;
  lookup(partition: string, key: string): ReplayEntry | undefined;
  /**
   * After a round: every owner in `ran` that left its key without a result
   * tried it; reassign the key to a runnable holder that has not. Returns
   * how many keys were reassigned.
   */
  steal(
    partition: string,
    ran: ReadonlySet<string>,
    runnable: ReadonlySet<string>,
  ): number;
  /** Close the flow: keys without a result get their final reason. */
  exhaust(partition: string, reason: string): void;
  finalReason(partition: string, key: string): string | undefined;
  /** Other states' results for `keys` that `state` has not received yet. */
  fill(partition: string, state: string, keys: readonly string[]): ReplayCopy;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createReplayLedger(): ReplayLedger {
  const planned = new Set<string>();
  const holders = new Map<string, string[]>();
  const owners = new Map<string, string>();
  const tried = new Map<string, Set<string>>();
  const entries = new Map<string, ReplayEntry>();
  const finals = new Map<string, string>();
  const filled = new Set<string>();
  const slot = (partition: string, key: string) => `${partition}\0${key}`;
  const inPartition = (partition: string, id: string) =>
    id.startsWith(`${partition}\0`);
  const open = (id: string) => !entries.has(id) && !finals.has(id);
  /** Owned open keys per state, for least-loaded assignment. */
  const loads = (partition: string) => {
    const counts = new Map<string, number>();
    for (const [id, state] of owners)
      if (inPartition(partition, id) && open(id))
        counts.set(state, (counts.get(state) ?? 0) + 1);
    return counts;
  };
  return {
    plan(partition, states) {
      planned.add(partition);
      const counts = new Map<string, number>();
      for (const { state, keys } of states)
        for (const key of keys) {
          const id = slot(partition, key);
          const list = holders.get(id) ?? [];
          if (!list.includes(state)) list.push(state);
          holders.set(id, list);
        }
      for (const [id, list] of holders) {
        if (!inPartition(partition, id) || owners.has(id)) continue;
        // Fewest owned keys so far; ties go to flow order.
        let chosen: string | undefined;
        for (const state of list)
          if (
            chosen === undefined ||
            (counts.get(state) ?? 0) < (counts.get(chosen) ?? 0)
          )
            chosen = state;
        if (chosen === undefined) continue;
        owners.set(id, chosen);
        counts.set(chosen, (counts.get(chosen) ?? 0) + 1);
      }
    },
    planned: (partition) => planned.has(partition),
    owner: (partition, key) => owners.get(slot(partition, key)),
    assignedCount(partition, state) {
      let count = 0;
      for (const [id, owner] of owners)
        if (owner === state && inPartition(partition, id) && open(id))
          count += 1;
      return count;
    },
    record(partition, key, state, actions, failureKeys) {
      const id = slot(partition, key);
      if (entries.has(id) || actions.length === 0) return;
      entries.set(id, {
        state,
        actions: actions.map(({ id: _id, ...action }) => clone(action)),
        failureKeys: [...failureKeys],
      });
      finals.delete(id);
    },
    lookup: (partition, key) => entries.get(slot(partition, key)),
    steal(partition, ran, runnable) {
      const counts = loads(partition);
      let reassigned = 0;
      for (const [id, owner] of owners) {
        if (!inPartition(partition, id) || !open(id) || !ran.has(owner))
          continue;
        const attempts = tried.get(id) ?? new Set<string>();
        attempts.add(owner);
        tried.set(id, attempts);
        counts.set(owner, Math.max(0, (counts.get(owner) ?? 0) - 1));
        let chosen: string | undefined;
        for (const state of holders.get(id) ?? [])
          if (
            runnable.has(state) &&
            !attempts.has(state) &&
            (chosen === undefined ||
              (counts.get(state) ?? 0) < (counts.get(chosen) ?? 0))
          )
            chosen = state;
        if (chosen === undefined) {
          finals.set(
            id,
            `not completed in any state that shows it (tried ${[...attempts].join(", ")})`,
          );
          continue;
        }
        owners.set(id, chosen);
        counts.set(chosen, (counts.get(chosen) ?? 0) + 1);
        reassigned += 1;
      }
      return reassigned;
    },
    exhaust(partition, reason) {
      for (const id of owners.keys())
        if (inPartition(partition, id) && open(id)) finals.set(id, reason);
    },
    finalReason: (partition, key) => finals.get(slot(partition, key)),
    fill(partition, state, keys) {
      const copy: ReplayCopy = {
        actions: [],
        failureKeys: [],
        reused: 0,
        failureReused: 0,
      };
      for (const key of keys) {
        const id = slot(partition, key);
        const entry = entries.get(id);
        const pair = `${id}\0${state}`;
        if (!entry || entry.state === state || filled.has(pair)) continue;
        filled.add(pair);
        copy.actions.push(...entry.actions.map(clone));
        copy.failureKeys.push(...entry.failureKeys);
        copy.reused += 1;
        if (entry.actions.some((action) => action.source === "failure-replay"))
          copy.failureReused += 1;
      }
      return copy;
    },
  };
}
