import { expect, test } from "vitest";
import {
  describeQuickCaptureFailures,
  isOutOfTime,
  OUT_OF_TIME_ADVICE,
  QuickCaptureFailed,
  quickCaptureAdvice,
  quickCaptureFailures,
} from "../src/quick/failures.js";

const tuple = (stage: string, message: string) => ({
  state: "page-1",
  viewport: "mobile",
  colorScheme: "dark" as const,
  failure: { stage, message },
});

test.each([
  ["screenshot", "screenshot out of time: 6270 ms of the 30000 ms …", true],
  [
    "screenshot",
    "page.screenshot: Timeout 6270ms exceeded. waiting for fonts to load... fonts loaded",
    true,
  ],
  ["navigation", "page.goto: Timeout 30000ms exceeded.", true],
  ["readiness", "readiness timed out after 10000 ms", true],
  ["navigation", "net::ERR_NAME_NOT_RESOLVED", false],
  ["axe", "Timeout 100ms exceeded", false],
])("%s failure %j is out of time: %s", (stage, message, expected) => {
  expect(isOutOfTime(stage, message)).toBe(expected);
});

test("quick capture failures carry the tuple coordinate and pick their advice", () => {
  const failures = quickCaptureFailures([
    { state: "page-1", viewport: "desktop", colorScheme: "light" },
    tuple("screenshot", "screenshot out of time: 0 ms left"),
  ]);
  expect(failures).toEqual([
    {
      state: "page-1",
      viewport: "mobile",
      colorScheme: "dark",
      stage: "screenshot",
      message: "screenshot out of time: 0 ms left",
      outOfTime: true,
    },
  ]);
  expect(quickCaptureAdvice(failures)).toBe(OUT_OF_TIME_ADVICE);
  expect(OUT_OF_TIME_ADVICE).toContain("30000 ms");
  expect(OUT_OF_TIME_ADVICE).toContain("10000 ms");
  expect(OUT_OF_TIME_ADVICE).toContain("1000 ms left");
  expect(describeQuickCaptureFailures(failures, 4)).toBe(
    "1 of 4 captures failed — page-1/mobile/dark: screenshot out of time: 0 ms left",
  );
  const other = quickCaptureFailures([tuple("navigation", "net::ERR_FAILED")]);
  expect(quickCaptureAdvice(other)).toContain("Open the report");
  expect(describeQuickCaptureFailures(other, 4)).toContain(
    "page-1/mobile/dark: navigation: net::ERR_FAILED",
  );
  for (const advice of [
    quickCaptureAdvice(failures),
    quickCaptureAdvice(other),
  ])
    expect(advice).not.toMatch(/\bport\b|server settings|project\.json/);
});

test("a quick capture failure ends with its own advice", () => {
  const failures = quickCaptureFailures([
    tuple("screenshot", "screenshot out of time: 0 ms left"),
  ]);
  const error = new QuickCaptureFailed(
    failures,
    1,
    "/Users/x/idiom-quick-reports/run/report.md",
  );
  expect(error.message.split("\n")).toEqual([
    "Quick capture failed: 1 of 1 captures failed — page-1/mobile/dark: screenshot out of time: 0 ms left. Report: /Users/x/idiom-quick-reports/run/report.md",
    OUT_OF_TIME_ADVICE,
  ]);
});
