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
  /** Wall clock from browser launch to the last tuple settled; absent in older runs. */
  capture?: PhaseTiming | undefined;
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

export type TimingPhase =
  | "build"
  | "server start"
  | "capture"
  | "probe"
  | "checks";
/** One check's wall clock and where it went; `capture` includes `probe`. */
export type CheckTiming = {
  totalMs: number;
  phases: {
    build: PhaseTiming;
    serverStart: PhaseTiming;
    capture: PhaseTiming;
    probe: PhaseTiming;
    checks: PhaseTiming;
  };
  slowest: TimingPhase;
  probeIncludedInCapture: true;
  /** Capture phases come from a stored run (`--from`, `--latest`). */
  historical?: boolean | undefined;
};

export function formatDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function checkTiming(
  timings: RunTimings | undefined,
  totalMs: number,
): CheckTiming {
  const unavailable: PhaseTiming = { status: "unavailable", ms: 0 };
  const historical = timings?.historical === true;
  const stored = (phase: PhaseTiming | undefined): PhaseTiming =>
    historical ? skipped() : (phase ?? unavailable);
  const probe = stored(timings?.probe);
  const tupleSum = (timings?.tuples ?? []).reduce(
    (sum, tuple) => sum + tuple.total.ms,
    0,
  );
  const capture = historical
    ? skipped()
    : (timings?.capture ??
      (timings?.tuples.length
        ? { status: "measured" as const, ms: tupleSum }
        : unavailable));
  const phases = {
    build: stored(timings?.build),
    serverStart: stored(timings?.start),
    capture,
    probe,
    checks: timings?.checks ?? unavailable,
  };
  const candidates: Array<[TimingPhase, number]> = [
    ["build", phases.build.ms],
    ["server start", phases.serverStart.ms],
    ["capture", Math.max(0, phases.capture.ms - phases.probe.ms)],
    ["probe", phases.probe.ms],
    ["checks", phases.checks.ms],
  ];
  const slowest = candidates.reduce((best, entry) =>
    entry[1] > best[1] ? entry : best,
  )[0];
  return {
    totalMs: Math.max(0, totalMs),
    phases,
    slowest,
    probeIncludedInCapture: true,
    ...(historical ? { historical: true } : {}),
  };
}

const phaseText = (label: string, phase: PhaseTiming) =>
  phase.status === "measured"
    ? `${label} ${formatDuration(phase.ms)}`
    : `${label} ${phase.status === "unsupported" ? "n/a" : phase.status}`;

/** The last line of every check: one glance at why a run was slow. */
export function renderTimingLine(timing: CheckTiming, label?: string): string {
  const { phases } = timing;
  const probe =
    phases.probe.status === "measured"
      ? ` (probe ${formatDuration(phases.probe.ms)})`
      : phases.probe.status === "skipped" ||
          phases.probe.status === "unsupported"
        ? ""
        : ` (probe ${phases.probe.status})`;
  return `Timing${label === undefined ? "" : ` ${label}`}: ${formatDuration(timing.totalMs)} — ${[
    phaseText("build", phases.build),
    phaseText("server start", phases.serverStart),
    `${phaseText("capture", phases.capture)}${probe}`,
    phaseText("checks", phases.checks),
  ].join(", ")}; slowest: ${timing.slowest}`;
}

/** Several flows' timings summed into one line (multi-flow `--changed`/`--gate`). */
export function combineCheckTimings(
  timings: CheckTiming[],
  totalMs: number,
): CheckTiming {
  const sum = (pick: (timing: CheckTiming) => PhaseTiming): PhaseTiming => {
    const phases = timings.map(pick);
    const measured = phases.filter((phase) => phase.status === "measured");
    return measured.length
      ? {
          status: "measured",
          ms: measured.reduce((total, phase) => total + phase.ms, 0),
        }
      : (phases[0] ?? { status: "unavailable", ms: 0 });
  };
  const phases = {
    build: sum((timing) => timing.phases.build),
    serverStart: sum((timing) => timing.phases.serverStart),
    capture: sum((timing) => timing.phases.capture),
    probe: sum((timing) => timing.phases.probe),
    checks: sum((timing) => timing.phases.checks),
  };
  const candidates: Array<[TimingPhase, number]> = [
    ["build", phases.build.ms],
    ["server start", phases.serverStart.ms],
    ["capture", Math.max(0, phases.capture.ms - phases.probe.ms)],
    ["probe", phases.probe.ms],
    ["checks", phases.checks.ms],
  ];
  return {
    totalMs,
    phases,
    slowest: candidates.reduce((best, entry) =>
      entry[1] > best[1] ? entry : best,
    )[0],
    probeIncludedInCapture: true,
  };
}
