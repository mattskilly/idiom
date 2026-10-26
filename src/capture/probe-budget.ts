import type { Deadline } from "./deadline.js";

export type ProbeBudgetLease = {
  shareMs(): number;
  start(deadline: Pick<Deadline, "extend">): void;
  finish(spentMs: number): void;
};

/**
 * One aggregate flow allowance, divided by assigned work, with live refunds.
 * With `deadlineAt`, no state's share runs past that monotonic time.
 */
export function createFlowProbeBudget(
  totalMs: number,
  work: Array<{ id: string; count: number }>,
  limit?: { deadlineAt: number; now: () => number },
): Map<string, ProbeBudgetLease> {
  const totalWork = work.reduce(
    (sum, item) => sum + Math.max(1, item.count),
    0,
  );
  const slots = work.map((item) => ({
    ...item,
    count: Math.max(1, item.count),
    grant: (totalMs * Math.max(1, item.count)) / totalWork,
    done: false,
    /** Longest share the wall-clock limit allows, fixed when the state starts. */
    cap: Number.POSITIVE_INFINITY,
    fixed: false,
    deadline: undefined as Pick<Deadline, "extend"> | undefined,
  }));
  const fix = (slot: (typeof slots)[number]) => {
    if (slot.fixed || !limit) return;
    slot.fixed = true;
    slot.cap = Math.max(0, limit.deadlineAt - limit.now());
  };
  const leases = new Map<string, ProbeBudgetLease>(
    slots.map((slot) => [
      slot.id,
      {
        shareMs: () => {
          fix(slot);
          return Math.min(slot.grant, slot.cap);
        },
        start(deadline) {
          fix(slot);
          slot.deadline = deadline;
        },
        finish(spentMs) {
          if (slot.done) return;
          slot.done = true;
          const refund = Math.max(0, Math.min(slot.grant, slot.cap) - spentMs);
          const remaining = slots.filter((other) => !other.done);
          const weight = remaining.reduce((sum, other) => sum + other.count, 0);
          for (const other of remaining) {
            // A state that has not started yet takes its cap when it does.
            const before = Math.min(other.grant, other.cap);
            other.grant += (refund * other.count) / weight;
            const extra = Math.min(other.grant, other.cap) - before;
            if (extra > 0) other.deadline?.extend(extra);
          }
        },
      } satisfies ProbeBudgetLease,
    ]),
  );
  return leases;
}
