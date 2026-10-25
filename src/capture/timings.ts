import { z } from "zod";
export const phaseTimingSchema = z
  .object({
    status: z.enum([
      "measured",
      "reused",
      "skipped",
      "unsupported",
      "unavailable",
    ]),
    ms: z.number().finite().nonnegative(),
  })
  .strict();
export type PhaseTiming = z.infer<typeof phaseTimingSchema>;
export const skipped = (): PhaseTiming => ({ status: "skipped", ms: 0 });
export const controlTimingSchema = z
  .object({
    state: z.string().min(1),
    viewport: z.string().min(1),
    colorScheme: z.enum(["light", "dark"]),
    selector: z.string().min(1),
    name: z.string(),
    elapsedMs: z.number().finite().nonnegative(),
    outcome: z.enum(["completed", "timed-out"]),
  })
  .strict();
export type ControlTiming = z.infer<typeof controlTimingSchema>;
export function slowestControls(controls: ControlTiming[]): ControlTiming[] {
  return [...controls]
    .sort(
      (a, b) =>
        b.elapsedMs - a.elapsedMs ||
        JSON.stringify([
          a.state,
          a.viewport,
          a.colorScheme,
          a.selector,
          a.name,
        ]).localeCompare(
          JSON.stringify([
            b.state,
            b.viewport,
            b.colorScheme,
            b.selector,
            b.name,
          ]),
        ),
    )
    .slice(0, 5);
}
export type RunTimings = {
  slowestControls?: ControlTiming[] | undefined;
  build: PhaseTiming;
  start: PhaseTiming;
  tuples: Array<{
    state: string;
    viewport: string;
    colorScheme: "light" | "dark";
    total: PhaseTiming;
    probe: PhaseTiming;
  }>;
  probe: PhaseTiming;
  checks: PhaseTiming;
  historical?: boolean | undefined;
};
export function renderTimings(timings: RunTimings | undefined): string {
  if (!timings)
    return "Timings (ms): build unavailable; start unavailable; capture unavailable; probe unavailable; checks unavailable";
  const phase = (value: PhaseTiming) =>
    `${value.ms.toFixed(1)} ms (${value.status})`;
  return [
    `Timings${timings.historical ? " (capture phases are historical evidence)" : ""}:`,
    `  build: ${phase(timings.build)}; start: ${phase(timings.start)}`,
    ...(timings.tuples.length === 0
      ? ["  capture: no tuple measurements"]
      : []),
    ...timings.tuples.map(
      (tuple) =>
        `  capture ${tuple.state}/${tuple.viewport}/${tuple.colorScheme}: ${phase(tuple.total)}; probe (included): ${phase(tuple.probe)}`,
    ),
    ...(timings.slowestControls ?? []).map(
      (control) =>
        `  probe control ${control.state}/${control.viewport}/${control.colorScheme} ${control.selector} ${control.name}: ${control.elapsedMs.toFixed(1)} ms (${control.outcome})`,
    ),
    `  probe (included in capture): ${phase(timings.probe)}; checks: ${phase(timings.checks)}`,
  ].join("\n");
}
