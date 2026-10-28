import { observed } from "../findings/observation.js";
import { defaultChecksSettings } from "../schemas/project.js";
import {
  attributeShift,
  type ShiftCause,
  shiftCauses,
  shiftFix,
} from "./interaction-shift.js";
import { ran, skipped, unavailable, v2Observations, verify } from "./shared.js";
import { displacements, scrollAt } from "./timeline.js";
import type { CheckTuple, DeterministicCheck } from "./types.js";

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

/**
 * The late content behind the largest load shift, from the load timeline.
 * Undefined without a load timeline or when nothing accounts for the shift,
 * so an uncertain cause is never named.
 */
export function largestShiftCause(
  tuple: CheckTuple,
  entries: readonly { value: number; startTime: number }[],
):
  | {
      cause: ShiftCause;
      value: number;
      time: number;
      moved: string[];
      timeline?: string | undefined;
    }
  | undefined {
  const largest = entries.reduce<(typeof entries)[number] | undefined>(
    (best, entry) => (best && best.value >= entry.value ? best : entry),
    undefined,
  );
  if (!largest) return undefined;
  const load = tuple.timelines?.actions.find(
    (action) => action.source === "load" && action.status !== "unavailable",
  );
  if (!load) return undefined;
  const shift = load.shifts
    .filter((entry) => Math.abs(entry.time - largest.startTime) <= 50)
    .sort(
      (a, b) =>
        Math.abs(a.time - largest.startTime) -
        Math.abs(b.time - largest.startTime),
    )[0];
  if (!shift) return undefined;
  const causes = shiftCauses(load, displacements(load));
  const scroll = scrollAt(load, shift.time);
  const page = (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => ({
    ...rect,
    x: rect.x + scroll.x,
    y: rect.y + scroll.y,
  });
  const sources = [...shift.sources].sort(
    (a, b) =>
      b.previousRect.width * b.previousRect.height -
      a.previousRect.width * a.previousRect.height,
  );
  for (const source of sources) {
    // An empty source rect means it entered or left the viewport. Its zero
    // coordinates do not describe a displacement toward the page origin.
    if (
      source.previousRect.width <= 0 ||
      source.previousRect.height <= 0 ||
      source.currentRect.width <= 0 ||
      source.currentRect.height <= 0
    )
      continue;
    const cause = attributeShift(
      {
        start: page(source.previousRect),
        end: page(source.currentRect),
        peakAt: shift.time,
        peakDx: source.currentRect.x - source.previousRect.x,
        peakDy: source.currentRect.y - source.previousRect.y,
      },
      causes,
    );
    if (cause)
      return {
        cause,
        value: largest.value,
        time: largest.startTime,
        moved: sources.map((entry) => entry.selector),
        ...(load.id === undefined ? {} : { timeline: load.id }),
      };
  }
  return undefined;
}

const causeVerb = {
  insert: "was inserted",
  remove: "was removed",
  resize: "resized",
  // Load timelines never carry the scrollbar cause; complete for the type.
  scrollbar: "gave up its scrollbar",
} as const;

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
    const late = largestShiftCause(tuple, shift.entries);
    const height = late
      ? Math.round(
          Math.abs(
            late.cause.kind === "resize"
              ? late.cause.delta?.dh || late.cause.final.height
              : late.cause.final.height,
          ),
        )
      : 0;
    return ran(this.id, [
      {
        observation: observed(
          { source: "load-sample", kind: "load", name: "page load" },
          shift,
          shift.elapsedMs === undefined
            ? undefined
            : { elapsedMs: shift.elapsedMs },
        ),
        category: this.id,
        severity: "major",
        rule: "idiom:layout-shift",
        selectorHint: selector,
        explanation: `Content moves after load: cumulative layout shift is ${shift.score} (above ${settings.max})${sources.length > 0 ? `, shifting ${sources.slice(0, 5).join(", ")}` : ""}.${late ? ` The largest shift (${Math.round(late.value * 10000) / 10000} at ${Math.round(late.time)}ms) came from late content: ${late.cause.selector} ${causeVerb[late.cause.kind]} (${height}px).` : ""}`,
        ...(late
          ? {
              fix: shiftFix(late.cause, true, late.moved),
              ...(late.timeline === undefined
                ? {}
                : { timeline: late.timeline }),
            }
          : {}),
        acceptance: [
          `Cumulative layout shift during load stays at or under ${settings.max} (reserve space for late content, images and banners).`,
        ],
        verification: verify(this.id, { max: settings.max }),
      },
    ]);
  },
};
