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
    /** Captured at a synthetic intermediate width (intermediateWidths). */
    intermediate?: true | undefined;
    steps?: TupleStepTimings | undefined;
  }>;
  probe: PhaseTiming;
  checks: PhaseTiming;
  /** Wall clock from browser launch to the last tuple settled; absent in older runs. */
  capture?: PhaseTiming | undefined;
  historical?: boolean | undefined;
};
/** Milliseconds per step of one tuple; `checks` comes from review. */
export type TupleStepTimings = {
  capture?: number | undefined;
  probe?: number | undefined;
  artifacts?: number | undefined;
  secretScan?: number | undefined;
  checks?: number | undefined;
};
export type SlowTuple = {
  state: string;
  viewport: string;
  colorScheme: "light" | "dark";
  /** Sum of the tuple's steps (or its measured total when it has none). */
  ms: number;
  steps: TupleStepTimings;
};
const stepNames = [
  "capture",
  "probe",
  "artifacts",
  "secretScan",
  "checks",
] as const;

/**
 * The n tuples that took longest, each with its step breakdown. `checks`
 * maps `state\0viewport\0scheme` to the review's per-tuple check time.
 */
export function slowTupleSteps(
  timings: Pick<RunTimings, "tuples"> | undefined,
  checks: ReadonlyMap<string, number> = new Map(),
  n = 5,
): SlowTuple[] {
  return (timings?.tuples ?? [])
    .map((tuple) => {
      const check = checks.get(
        `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme}`,
      );
      const steps: TupleStepTimings = {
        ...(tuple.steps ?? {}),
        ...(check === undefined ? {} : { checks: check }),
      };
      const summed = stepNames.reduce(
        (sum, name) => sum + (steps[name] ?? 0),
        0,
      );
      return {
        state: tuple.state,
        viewport: tuple.viewport,
        colorScheme: tuple.colorScheme,
        ms: tuple.steps === undefined ? tuple.total.ms + (check ?? 0) : summed,
        steps,
      };
    })
    .sort(
      (a, b) =>
        b.ms - a.ms ||
        `${a.state}/${a.viewport}/${a.colorScheme}`.localeCompare(
          `${b.state}/${b.viewport}/${b.colorScheme}`,
        ),
    )
    .slice(0, n);
}

const stepLabel: Record<(typeof stepNames)[number], string> = {
  capture: "capture",
  probe: "probe",
  artifacts: "artifacts",
  secretScan: "secret scan",
  checks: "checks",
};

/** "Slowest tuples:" then one line per tuple with its steps. */
export function renderSlowTuples(slow: SlowTuple[]): string {
  if (slow.length === 0) return "";
  return [
    "Slowest tuples:",
    ...slow.map((tuple) => {
      const parts = stepNames.flatMap((name) =>
        tuple.steps[name] === undefined
          ? []
          : [`${stepLabel[name]} ${formatDuration(tuple.steps[name] ?? 0)}`],
      );
      return `  ${tuple.state}/${tuple.viewport}/${tuple.colorScheme} ${formatDuration(tuple.ms)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
    }),
  ].join("\n");
}

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
        `  capture ${tuple.state}/${tuple.viewport}/${tuple.colorScheme}${tuple.intermediate ? " (intermediate width)" : ""}: ${phase(tuple.total)}; probe (included): ${phase(tuple.probe)}`,
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
/** Capture time spent at intermediate widths, part of `capture`. */
export type IntermediateWidthTiming = {
  ms: number;
  states: Array<{ state: string; widths: number; ms: number }>;
};
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
  /** Capture time added by intermediate widths; absent when none ran. */
  intermediateWidths?: IntermediateWidthTiming | undefined;
};

/** Intermediate-width tuples' capture time, grouped by state in run order. */
export function intermediateWidthTiming(
  tuples: RunTimings["tuples"],
): IntermediateWidthTiming | undefined {
  const states = new Map<string, { widths: number; ms: number }>();
  for (const tuple of tuples) {
    if (tuple.intermediate !== true) continue;
    const entry = states.get(tuple.state) ?? { widths: 0, ms: 0 };
    entry.widths += 1;
    entry.ms += tuple.total.ms;
    states.set(tuple.state, entry);
  }
  if (states.size === 0) return undefined;
  const list = [...states].map(([state, entry]) => ({ state, ...entry }));
  return {
    ms: list.reduce((sum, entry) => sum + entry.ms, 0),
    states: list,
  };
}

/** "intermediate widths +3.1s: editor +1.6s over 2 widths, …". */
export function intermediateWidthText(timing: IntermediateWidthTiming): string {
  const shown = timing.states
    .slice(0, 3)
    .map(
      (entry) =>
        `${entry.state} +${formatDuration(entry.ms)} over ${entry.widths} width${entry.widths === 1 ? "" : "s"}`,
    );
  const more = timing.states.length - shown.length;
  return `intermediate widths +${formatDuration(timing.ms)}: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

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
  const intermediate = historical
    ? undefined
    : intermediateWidthTiming(timings?.tuples ?? []);
  return {
    totalMs: Math.max(0, totalMs),
    phases,
    slowest,
    probeIncludedInCapture: true,
    ...(historical ? { historical: true } : {}),
    ...(intermediate ? { intermediateWidths: intermediate } : {}),
  };
}

const phaseText = (label: string, phase: PhaseTiming) =>
  phase.status === "measured"
    ? `${label} ${formatDuration(phase.ms)}`
    : `${label} ${phase.status === "unsupported" ? "n/a" : phase.status}`;

/** The last line of every check: one glance at why a run was slow. */
export function renderTimingLine(timing: CheckTiming, label?: string): string {
  const { phases } = timing;
  const probeText =
    phases.probe.status === "measured"
      ? `probe ${formatDuration(phases.probe.ms)}`
      : phases.probe.status === "skipped" ||
          phases.probe.status === "unsupported"
        ? undefined
        : `probe ${phases.probe.status}`;
  const details = [
    probeText,
    timing.intermediateWidths
      ? intermediateWidthText(timing.intermediateWidths)
      : undefined,
  ].filter((part) => part !== undefined);
  const probe = details.length ? ` (${details.join("; ")})` : "";
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
  const intermediateStates = timings.flatMap(
    (timing) => timing.intermediateWidths?.states ?? [],
  );
  return {
    totalMs,
    phases,
    slowest: candidates.reduce((best, entry) =>
      entry[1] > best[1] ? entry : best,
    )[0],
    probeIncludedInCapture: true,
    ...(intermediateStates.length
      ? {
          intermediateWidths: {
            ms: intermediateStates.reduce((sum, entry) => sum + entry.ms, 0),
            states: intermediateStates,
          },
        }
      : {}),
  };
}

/** Where the build gate's wall clock went, phase by phase. */
export type GateTimingBreakdown = {
  /** Servers the gate started (a lease counts once), base included. */
  servers: number;
  /** Servers already running that the gate reused. */
  serversReused: number;
  /** Build + start of every server the gate started. */
  serverStartMs: number;
  /** Base capture minus its server start; 0 when none ran. */
  baseCaptureMs: number;
  /** How the base was settled: captured, stored records, or not at all. */
  baseCapture: "captured" | "baseline" | "cached" | "skipped" | "none";
  /** Head capture minus the probe. */
  captureMs: number;
  probeMs: number;
  checksMs: number;
  /** Head capture time spent at intermediate widths, inside `captureMs`. */
  intermediateWidths?: IntermediateWidthTiming | undefined;
};
export type GateTiming = CheckTiming & { gate: GateTimingBreakdown };

/** The gate's last line: server start, base capture, captures, probe, checks. */
export function renderGateTimingLine(timing: GateTiming): string {
  const gate = timing.gate;
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  const server =
    gate.servers === 0
      ? `server start reused${gate.serversReused ? ` (${plural(gate.serversReused, "server")})` : ""}`
      : `server start ${formatDuration(gate.serverStartMs)} (${plural(gate.servers, "server")}${gate.serversReused ? `, ${gate.serversReused} reused` : ""})`;
  const base =
    gate.baseCapture === "captured"
      ? `base capture ${formatDuration(gate.baseCaptureMs)}`
      : gate.baseCapture === "skipped" || gate.baseCapture === "none"
        ? "base capture skipped"
        : `base capture ${formatDuration(0)} (${gate.baseCapture})`;
  const phases: Array<[string, number]> = [
    ["server start", gate.serverStartMs],
    ["base capture", gate.baseCaptureMs],
    ["captures", gate.captureMs],
    ["probe", gate.probeMs],
    ["checks", gate.checksMs],
  ];
  const slowest = phases.reduce((best, entry) =>
    entry[1] > best[1] ? entry : best,
  )[0];
  return `Timing: ${formatDuration(timing.totalMs)} — ${[
    server,
    base,
    `captures ${formatDuration(gate.captureMs)}${gate.intermediateWidths ? ` (${intermediateWidthText(gate.intermediateWidths)})` : ""}`,
    `probe ${formatDuration(gate.probeMs)}`,
    `checks ${formatDuration(gate.checksMs)}`,
  ].join(", ")}; slowest: ${slowest}`;
}
