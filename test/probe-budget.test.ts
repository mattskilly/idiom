import { expect, test } from "vitest";
import { Deadline, DeadlineExpired } from "../src/capture/deadline.js";
import { createFlowProbeBudget } from "../src/capture/probe-budget.js";

test("flow shares follow assigned work and unfinished states receive refunds", () => {
  const leases = createFlowProbeBudget(1000, [
    { id: "a", count: 1 },
    { id: "b", count: 3 },
    { id: "c", count: 1 },
  ]);
  const a = leases.get("a");
  const b = leases.get("b");
  const c = leases.get("c");
  if (!a || !b || !c) throw new Error("missing lease");
  expect([a.shareMs(), b.shareMs(), c.shareMs()]).toEqual([200, 600, 200]);
  let extended = 0;
  b.start({
    extend(ms) {
      extended += ms;
    },
  });
  a.finish(100);
  expect(b.shareMs()).toBe(675);
  expect(extended).toBe(75);
  expect(c.shareMs()).toBe(225);
  c.finish(125);
  expect(b.shareMs()).toBe(775);
  expect(extended).toBe(175);
  // Completion is idempotent, and spent time is never credited twice.
  a.finish(0);
  expect(b.shareMs()).toBe(775);
  expect(100 + 125 + b.shareMs()).toBe(1000);
});

test("refunds extend a live deadline without reviving expired work", () => {
  let now = 0;
  const deadline = new Deadline("state", 10, () => "fixture", {
    now: () => now,
  });
  try {
    deadline.extend(20);
    now = 15;
    expect(() => deadline.check()).not.toThrow();
    now = 31;
    expect(() => deadline.check()).toThrow(DeadlineExpired);
    deadline.extend(100);
    expect(() => deadline.check()).toThrow(DeadlineExpired);
  } finally {
    deadline.dispose();
  }
});

test("a wall-clock limit caps each share from the moment its state starts", () => {
  let now = 0;
  const leases = createFlowProbeBudget(
    1000,
    [
      { id: "a", count: 1 },
      { id: "b", count: 1 },
    ],
    { deadlineAt: 700, now: () => now },
  );
  const a = leases.get("a");
  const b = leases.get("b");
  if (!a || !b) throw new Error("missing lease");
  let extended = 0;
  a.start({
    extend(ms) {
      extended += ms;
    },
  });
  expect(a.shareMs()).toBe(500);
  now = 400;
  // b starts late: only 300ms of wall time remain.
  expect(b.shareMs()).toBe(300);
  b.finish(100);
  // a's refund cannot carry it past the wall-clock limit.
  expect(a.shareMs()).toBe(700);
  expect(extended).toBe(200);
});
