import { defaultChecksSettings } from "../schemas/project.js";
import { ran, skipped, unavailable, v2Observations, verify } from "./shared.js";
import type { DeterministicCheck } from "./types.js";

export type LayoutShiftEntry = {
  value: number;
  startTime: number;
  hadRecentInput?: boolean | undefined;
};

/**
 * Cumulative layout shift as Core Web Vitals defines it: the largest session
 * window, where a window closes after a 1 s gap or once it spans 5 s.
 * Shifts right after user input do not count.
 */
export function layoutShiftScore(entries: readonly LayoutShiftEntry[]): number {
  let best = 0;
  let current = 0;
  let windowStart = Number.NEGATIVE_INFINITY;
  let previous = Number.NEGATIVE_INFINITY;
  for (const entry of [...entries]
    .filter((entry) => entry.hadRecentInput !== true)
    .sort((a, b) => a.startTime - b.startTime)) {
    if (
      entry.startTime - previous < 1000 &&
      entry.startTime - windowStart < 5000
    )
      current += entry.value;
    else {
      current = entry.value;
      windowStart = entry.startTime;
    }
    previous = entry.startTime;
    best = Math.max(best, current);
  }
  return Math.round(best * 10000) / 10000;
}

export const layoutShiftCheck: DeterministicCheck = {
  id: "layout-shift",
  run({ tuple, config }) {
    const settings = config.layoutShift ?? defaultChecksSettings.layoutShift;
    if (!settings.enabled) return skipped(this.id, "layoutShift");
    const shift = v2Observations(tuple)?.layoutShift;
    if (shift === undefined)
      return unavailable(
        this.id,
        "layout shift evidence is unavailable (recapture with this version)",
      );
    if (shift.status !== "ran")
      return unavailable(
        this.id,
        shift.reason ?? "layout shift evidence is unavailable",
      );
    if (shift.score <= settings.max) return ran(this.id, []);
    const counts = new Map<string, number>();
    for (const entry of shift.entries)
      for (const source of entry.sources)
        counts.set(source, (counts.get(source) ?? 0) + 1);
    const sources = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([selector]) => selector);
    const selector = sources[0] ?? "body";
    return ran(this.id, [
      {
        category: this.id,
        severity: "minor",
        rule: "idiom:layout-shift",
        selectorHint: selector,
        explanation: `Content moves after load: cumulative layout shift is ${shift.score} (above ${settings.max})${sources.length > 0 ? `, shifting ${sources.slice(0, 5).join(", ")}` : ""}.`,
        acceptance: [
          `Cumulative layout shift during load stays at or under ${settings.max} (reserve space for late content, images and banners).`,
        ],
        verification: verify(this.id, { max: settings.max }),
      },
    ]);
  },
};
