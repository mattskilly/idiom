import { expect, test } from "vitest";
import {
  isoWeek,
  parseRecordDate,
  weekWindow,
} from "../src/scorecard/weeks.js";

const at = (text: string) => Date.parse(text);
const labels = (weeks: { label: string }[]) => weeks.map((week) => week.label);

test("ISO week labels across a year boundary", () => {
  expect(isoWeek(at("2026-12-28T00:00:00Z")).label).toBe("2026-W53");
  expect(isoWeek(at("2026-12-31T12:00:00Z")).label).toBe("2026-W53");
  expect(isoWeek(at("2027-01-01T00:00:00Z")).label).toBe("2026-W53");
  expect(isoWeek(at("2027-01-03T23:59:59Z")).label).toBe("2026-W53");
  expect(isoWeek(at("2027-01-04T00:00:00Z")).label).toBe("2027-W01");
  expect(isoWeek(at("2025-12-29T00:00:00Z")).label).toBe("2026-W01");
  expect(isoWeek(at("2026-11-15T12:00:00Z")).label).toBe("2026-W46");
});

test("weeks run Monday 00:00 UTC to the next Monday", () => {
  const sunday = isoWeek(at("2026-11-15T23:59:59.999Z"));
  const monday = isoWeek(at("2026-11-16T00:00:00.000Z"));
  expect(sunday.label).toBe("2026-W46");
  expect(monday.label).toBe("2026-W47");
  expect(new Date(sunday.start).toISOString()).toBe("2026-11-09T00:00:00.000Z");
  expect(sunday.end).toBe(monday.start);
});

const now = new Date("2026-11-15T12:00:00Z");

test("default window: the last four weeks ending with the current week", () => {
  expect(labels(weekWindow({ now }))).toEqual([
    "2026-W43",
    "2026-W44",
    "2026-W45",
    "2026-W46",
  ]);
  expect(labels(weekWindow({ now, weeks: "2" }))).toEqual([
    "2026-W45",
    "2026-W46",
  ]);
});

test("--since starts at its week; alone it runs to now, with --weeks it is n weeks", () => {
  expect(labels(weekWindow({ now, since: "2026-10-28" }))).toEqual([
    "2026-W44",
    "2026-W45",
    "2026-W46",
  ]);
  expect(labels(weekWindow({ now, since: "2026-10-28", weeks: "2" }))).toEqual([
    "2026-W44",
    "2026-W45",
  ]);
  expect(labels(weekWindow({ now, since: "2026-11-15" }))).toEqual([
    "2026-W46",
  ]);
});

test("bad --weeks and --since are errors", () => {
  for (const weeks of ["0", "53", "1.5", "two", "-1", ""])
    expect(() => weekWindow({ now, weeks })).toThrow(/--weeks must be/);
  for (const since of ["2026-13-01", "2026-02-30", "Nov 10", "2026-11-1"])
    expect(() => weekWindow({ now, since })).toThrow(/--since must be/);
  expect(() => weekWindow({ now, since: "2026-11-16" })).toThrow(/after today/);
});

test("record dates: a day, a datetime, or nothing", () => {
  expect(parseRecordDate("2026-11-10")).toEqual({
    at: at("2026-11-10T00:00:00Z"),
    dayOnly: true,
  });
  expect(parseRecordDate("2026-11-10T14:30:00-05:00")).toEqual({
    at: at("2026-11-10T19:30:00Z"),
    dayOnly: false,
  });
  expect(parseRecordDate("Nov 10")).toBeUndefined();
  expect(parseRecordDate("2026-02-30")).toBeUndefined();
  expect(parseRecordDate(undefined)).toBeUndefined();
});
