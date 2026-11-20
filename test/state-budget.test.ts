import { expect, test } from "vitest";
import {
  StateBudgetExpired,
  StateBudgets,
} from "../src/capture/state-budget.js";

/** A fake clock and timer queue: time moves only when the test says so. */
function fakeTime() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    clock: () => now,
    timers: {
      set: (callback: () => void, ms: number) => {
        const id = next++;
        timers.set(id, { at: now + ms, callback });
        return id;
      },
      clear: (handle: unknown) => {
        timers.delete(handle as number);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
    },
  };
}

test("a state's clock runs only while some of its work is in flight", () => {
  const time = fakeTime();
  // One minute.
  const budgets = new StateBudgets(1, time.clock, time.timers);
  const first = budgets.begin("editor", "capture");
  time.advance(10_000);
  // A second tuple of the same state overlaps: the union is charged once.
  const second = budgets.begin("editor", "capture");
  time.advance(20_000);
  first();
  time.advance(10_000);
  second();
  expect(budgets.spentMs("editor")).toBe(40_000);
  // Queued time between spans is not the state's.
  time.advance(600_000);
  expect(budgets.spentMs("editor")).toBe(40_000);
  expect(budgets.signal("editor").aborted).toBe(false);
  // Re-entry resumes from the time already spent.
  const third = budgets.begin("editor", "probe");
  time.advance(19_999);
  expect(budgets.signal("editor").aborted).toBe(false);
  time.advance(1);
  expect(budgets.signal("editor").aborted).toBe(true);
  const reason = budgets.expired("editor");
  expect(reason).toBeInstanceOf(StateBudgetExpired);
  expect(reason?.message).toBe(
    "state editor exceeded capture.stateMaxMinutes=1 during probe",
  );
  third();
});

test("only the state that ran out is aborted", () => {
  const time = fakeTime();
  const budgets = new StateBudgets(0.5, time.clock, time.timers);
  const slow = budgets.begin("slow", "capture");
  const other = budgets.begin("other", "capture");
  time.advance(20_000);
  other();
  time.advance(10_000);
  expect(budgets.expired("slow")?.step).toBe("capture");
  expect(budgets.signal("other").aborted).toBe(false);
  expect(budgets.expired("other")).toBeUndefined();
  slow();
  // A state already over its budget expires as soon as it starts again.
  budgets.begin("slow", "design reference")();
  expect(budgets.signal("slow").aborted).toBe(true);
});

test("without a limit nothing is ever aborted", () => {
  const time = fakeTime();
  const budgets = new StateBudgets(undefined, time.clock, time.timers);
  expect(budgets.enabled).toBe(false);
  const end = budgets.begin("editor", "capture");
  time.advance(10 ** 9);
  end();
  expect(budgets.signal("editor").aborted).toBe(false);
  expect(budgets.expired("editor")).toBeUndefined();
});
