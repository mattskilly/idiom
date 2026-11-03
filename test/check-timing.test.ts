import { expect, test } from "vitest";
import {
  checkTiming,
  formatDuration,
  type RunTimings,
  renderTimingLine,
} from "../src/capture/timings.js";

const measured = (ms: number) => ({ status: "measured" as const, ms });

test("durations read at a glance", () => {
  expect(formatDuration(420)).toBe("0.4s");
  expect(formatDuration(12_000)).toBe("12s");
  expect(formatDuration(110_000)).toBe("1m50s");
  expect(formatDuration(3_720_000)).toBe("1h02m");
});

test("the timing line names every phase and the slowest", () => {
  const timings: RunTimings = {
    build: { status: "reused", ms: 0 },
    start: measured(12_000),
    tuples: [],
    probe: measured(62_000),
    checks: measured(9_000),
    capture: measured(110_000),
  };
  const timing = checkTiming(timings, 161_000);
  expect(timing.slowest).toBe("probe");
  expect(renderTimingLine(timing)).toBe(
    "Timing: 2m41s — build reused, server start 12s, capture 1m50s (probe 1m02s), checks 9.0s; slowest: probe",
  );
  const capture = checkTiming({ ...timings, probe: measured(1_000) }, 1);
  expect(capture.slowest).toBe("capture");
});

test("historical runs mark capture phases skipped", () => {
  const timing = checkTiming(
    {
      build: measured(1),
      start: measured(1),
      tuples: [],
      probe: measured(1),
      checks: measured(5),
      historical: true,
    },
    10,
  );
  expect(timing.historical).toBe(true);
  expect(timing.phases.capture.status).toBe("skipped");
  expect(timing.slowest).toBe("checks");
});
