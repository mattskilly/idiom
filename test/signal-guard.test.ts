import { describe, expect, inject, test } from "vitest";
import {
  clearViolations,
  isGuardedTarget,
  readViolations,
} from "./support/signal-guard.js";

const mainPid = 4100;
const mainPgid = 4000;

describe("signal guard targets", () => {
  test.each([
    [mainPid, "SIGTERM"],
    [mainPid, "SIGINT"],
    [mainPid, 15],
    [mainPid, 2],
    [mainPid, undefined],
    [-mainPgid, "SIGTERM"],
    [0, "SIGTERM"],
    [-1, "sigint"],
  ])("refuses %s %s", (target, signal) => {
    expect(isGuardedTarget({ target, signal, mainPid, mainPgid })).toBe(true);
  });

  test.each([
    [mainPid, "SIGKILL"],
    [-mainPgid, 9],
    [0, 0],
    [4200, "SIGTERM"],
    [-4200, "SIGTERM"],
    [mainPgid, "SIGTERM"],
  ])("allows %s %s", (target, signal) => {
    expect(isGuardedTarget({ target, signal, mainPid, mainPgid })).toBe(false);
  });

  test("an unknown main group still guards the main pid and 0", () => {
    const unknown = { mainPid, mainPgid: undefined };
    expect(isGuardedTarget({ target: 0, signal: "SIGTERM", ...unknown })).toBe(
      true,
    );
    expect(
      isGuardedTarget({ target: -mainPgid, signal: "SIGTERM", ...unknown }),
    ).toBe(false);
  });
});

test("a live SIGTERM to the run's own group is refused, named and recorded", () => {
  const { violations } = inject("signalGuard");
  // Never send for real: without the installed wrapper this would end the run.
  expect(Reflect.get(process, Symbol.for("idiom.signalGuard"))).toBe(true);
  try {
    expect(() => process.kill(0, "SIGTERM")).toThrow(
      /signal guard: .*test\/signal-guard\.test\.ts tried to send SIGTERM .*target 0/,
    );
    expect(readViolations(violations).join("\n")).toContain(
      "signal-guard.test.ts",
    );
  } finally {
    clearViolations(violations, "test/signal-guard.test.ts");
  }
  expect(readViolations(violations).join("\n")).not.toContain(
    "signal-guard.test.ts",
  );
});
