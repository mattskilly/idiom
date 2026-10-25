import { afterEach, expect, test, vi } from "vitest";
import { Deadline, DeadlineExpired } from "../src/capture/deadline.js";

afterEach(() => vi.useRealTimers());
const never = () => new Promise<never>(() => {});
function deadline(ms = 100) {
  return new Deadline("control", ms, () => "#print observe", {
    now: () => Date.now(),
  });
}
test("host expiry bounds a task and never-settling finalizer", async () => {
  vi.useFakeTimers();
  const d = deadline();
  const task = d.run(async () => {
    try {
      await never();
    } finally {
      await never();
    }
  });
  const assertion = expect(task).rejects.toMatchObject({
    scope: "control",
    activity: "#print observe",
  });
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  d.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
test("parent cancellation wins, including simultaneous state expiry", async () => {
  vi.useFakeTimers();
  const state = new Deadline("state", 50, () => "initialization", {
    now: () => Date.now(),
  });
  const control = new Deadline("control", 50, () => "click", {
    signal: state.signal,
    now: () => Date.now(),
  });
  const assertion = expect(control.run(never)).rejects.toMatchObject({
    scope: "state",
  });
  await vi.advanceTimersByTimeAsync(50);
  await assertion;
  state.dispose();
  control.dispose();
});
test("success, errors, clipping and retirement release timers", async () => {
  vi.useFakeTimers();
  const d = deadline();
  expect(d.remaining(1500)).toBe(100);
  await vi.advanceTimersByTimeAsync(99);
  expect(d.remaining()).toBe(1);
  expect(await d.run(async () => 42)).toBe(42);
  await expect(
    d.run(async () => {
      throw new Error("actual error");
    }),
  ).rejects.toThrow("actual error");
  d.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
test.each([true, false])(
  "late task settlement is handled (%s)",
  async (reject) => {
    vi.useFakeTimers();
    const d = deadline();
    let release!: () => void;
    const task = d.run(
      () =>
        new Promise<void>((resolve, fail) => {
          release = () => (reject ? fail(new Error("late")) : resolve());
        }),
    );
    const assertion = expect(task).rejects.toBeInstanceOf(DeadlineExpired);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    release();
    await vi.advanceTimersByTimeAsync(0);
    d.dispose();
  },
);
test("long timers rearm without overflowing", async () => {
  vi.useFakeTimers();
  const d = deadline(3_000_000_000);
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(d.remaining()).toBe(852_516_353);
  d.dispose();
});
