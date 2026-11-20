import { IdiomError } from "../errors.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const MAX_SCORECARD_WEEKS = 52;
export const DEFAULT_SCORECARD_WEEKS = 4;

/** One ISO 8601 week in UTC: Monday 00:00 up to the next Monday. */
export type Week = {
  /** `2026-W46`. */
  label: string;
  /** Inclusive, epoch milliseconds. */
  start: number;
  /** Exclusive, epoch milliseconds. */
  end: number;
};

/** The ISO week (UTC) containing an instant. */
export function isoWeek(at: number | Date): Week {
  const time = typeof at === "number" ? at : at.getTime();
  const day = new Date(time);
  const midnight = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
  );
  const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
  const start = midnight - weekday * DAY;
  // The ISO year is the year of the week's Thursday.
  const thursday = new Date(start + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const number =
    Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / WEEK) + 1;
  return {
    label: `${year}-W${String(number).padStart(2, "0")}`,
    start,
    end: start + WEEK,
  };
}

/** A `YYYY-MM-DD` that names a real calendar day, as UTC midnight. */
function calendarDay(text: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().startsWith(text)
    ? at
    : undefined;
}

/**
 * A recorded date: a `YYYY-MM-DD` day (the whole UTC day, `at` its start) or
 * an ISO datetime. Anything else is undefined.
 */
export function parseRecordDate(
  text: string | undefined,
): { at: number; dayOnly: boolean } | undefined {
  if (text === undefined) return undefined;
  const value = text.trim();
  const day = calendarDay(value);
  if (day !== undefined) return { at: day, dayOnly: true };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? { at, dayOnly: false } : undefined;
}

function parseWeeks(value: string | number): number {
  const text = String(value).trim();
  const count = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(count) || count < 1 || count > MAX_SCORECARD_WEEKS)
    throw new IdiomError(
      `--weeks must be a whole number from 1 to ${MAX_SCORECARD_WEEKS}, got ${JSON.stringify(text)}`,
    );
  return count;
}

/**
 * The scorecard's weeks, oldest first. Default: the last four ending with the
 * current week. `since` starts at the week containing that day; alone it runs
 * through the current week, with `weeks` it is that many weeks.
 */
export function weekWindow(options: {
  now: Date;
  weeks?: string | number | undefined;
  since?: string | undefined;
}): Week[] {
  const now = options.now.getTime();
  const current = isoWeek(now);
  const count =
    options.weeks === undefined ? undefined : parseWeeks(options.weeks);
  let first: Week;
  let length: number;
  if (options.since !== undefined) {
    const day = calendarDay(options.since.trim());
    if (day === undefined)
      throw new IdiomError(
        `--since must be a YYYY-MM-DD date, got ${JSON.stringify(options.since)}`,
      );
    if (day > now)
      throw new IdiomError(`--since ${options.since} is after today`);
    first = isoWeek(day);
    length = count ?? Math.round((current.start - first.start) / WEEK) + 1;
  } else {
    length = count ?? DEFAULT_SCORECARD_WEEKS;
    first = isoWeek(current.start - (length - 1) * WEEK);
  }
  return Array.from({ length }, (_, index) =>
    isoWeek(first.start + index * WEEK),
  );
}

/** The window week containing an instant, if any. */
export function weekOf(window: readonly Week[], at: number): Week | undefined {
  return window.find((week) => at >= week.start && at < week.end);
}
