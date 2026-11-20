import type { ExpectationMismatch } from "../capture/types.js";
import { IdiomError, RunFailure } from "../errors.js";

/**
 * Unattended runs (nightly, the gate, the verify step and, later, watch)
 * never fail quietly. A setup break that stops a trustworthy review becomes a
 * typed condition: one actionable line, one exit 2, one triage ticket per
 * distinct cause, and an entry `idiom doctor` lists until a run clears it.
 */
export type UnattendedMode = "nightly" | "gate" | "verify" | "watch";

export type ConditionCause = "app-start" | "baseline" | "expectation";

export type Condition = {
  /** The cause's identity across runs: `app-start`, `baseline:<flow>`, `expectation:<flow>/<state>`. */
  key: string;
  cause: ConditionCause;
  mode: UnattendedMode;
  /** The flows affected; one for baseline and expectation conditions. */
  flows: string[];
  state?: string | undefined;
  /** The original cause id, such as `server-timeout` or `baseline-stale`. */
  subcause: string;
  /** What happened, on one line. */
  what: string;
  /** How to fix it, on one line. */
  fix: string;
  /** Extra lines for the ticket body: coordinates, mismatches, detail. */
  detail?: string[] | undefined;
  /** Expectation conditions: the `viewport/scheme` coordinates that broke. */
  coordinates?: string[] | undefined;
};

/**
 * A scope a run fully exercised without observing its condition. With
 * coordinates, it clears an expectation only when every coordinate that
 * broke was captured cleanly.
 */
export type ClearedScope = { key: string; coordinates?: string[] | undefined };

/** The scope a run fully exercised: the condition key it may clear. */
export function appStartKey(): string {
  return "app-start";
}
export function baselineKey(flow: string): string {
  return `baseline:${flow}`;
}
export function expectationKey(flow: string, state: string): string {
  return `expectation:${flow}/${state}`;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function subject(condition: Condition): string {
  if (condition.cause === "expectation")
    return `${condition.flows[0] ?? "?"}/${condition.state ?? "?"}`;
  return condition.flows.join(", ") || "project";
}

/** `idiom <mode>: <cause>: <subject>: <what happened> — fix: <how>`, always one line. */
export function conditionLine(condition: Condition): string {
  return oneLine(
    `idiom ${condition.mode}: ${condition.cause}: ${subject(condition)}: ${condition.what} — fix: ${condition.fix}`,
  );
}

/** The ticket title: `Idiom cannot <run|compare|review> <subject>: <short what>`. */
export function conditionTitle(condition: Condition): string {
  const verb =
    condition.cause === "app-start"
      ? "run"
      : condition.cause === "baseline"
        ? "compare"
        : "review";
  const what = oneLine(condition.what);
  return `Idiom cannot ${verb} ${subject(condition)}: ${what.length > 80 ? `${what.slice(0, 77)}…` : what}`;
}

const SERVER_CAUSES = new Set([
  "server-exited",
  "server-timeout",
  "server-spawn",
  "port-pinned",
  "port-in-use",
]);

/**
 * A run failure that is one of the unattended causes, else undefined: other
 * refusals (browser launch, dirty tree, invalid config) keep their own path.
 */
export function fromRunFailure(
  error: unknown,
  options: { mode: UnattendedMode; flow: string },
): Condition | undefined {
  if (!(error instanceof RunFailure)) return undefined;
  if (error.stage === "server" || SERVER_CAUSES.has(error.cause))
    return {
      key: appStartKey(),
      cause: "app-start",
      mode: options.mode,
      flows: [options.flow],
      subcause: error.cause,
      what: oneLine(error.headline),
      fix: /\bidiom doctor\b/.test(error.hint)
        ? oneLine(error.hint).replaceAll("<flow>", options.flow)
        : `${oneLine(error.hint)}; diagnose with idiom doctor ${options.flow}`,
      ...(error.detail === undefined || error.detail === ""
        ? {}
        : { detail: error.detail.split(/\r?\n/).slice(0, 20) }),
    };
  if (error.cause === "baseline-missing")
    return baselineMissing({
      mode: options.mode,
      flow: options.flow,
      what: error.headline,
    });
  return undefined;
}

export function baselineMissing(options: {
  mode: UnattendedMode;
  flow: string;
  what: string;
}): Condition {
  return {
    key: baselineKey(options.flow),
    cause: "baseline",
    mode: options.mode,
    flows: [options.flow],
    subcause: "baseline-missing",
    what: oneLine(options.what),
    fix: `idiom baseline record ${options.flow} on a clean main and commit .idiom/baselines`,
  };
}

/** Several flows that could not start the app are one condition. */
export function mergeAppStart(conditions: readonly Condition[]): Condition[] {
  const merged: Condition[] = [];
  for (const condition of conditions) {
    const existing = merged.find((entry) => entry.key === condition.key);
    if (existing === undefined) {
      merged.push({ ...condition, flows: [...condition.flows] });
      continue;
    }
    for (const flow of condition.flows)
      if (!existing.flows.includes(flow)) existing.flows.push(flow);
    if (existing.cause === "expectation" && condition.detail)
      existing.detail = [
        ...new Set([...(existing.detail ?? []), ...condition.detail]),
      ];
  }
  return merged;
}

/** The baseline facts a recorded comparison reports. */
export type BaselineFacts = {
  stale?: { reason: string } | undefined;
  /** True when the baseline holds none of the tuples this run checked. */
  coversNone?: boolean | undefined;
};

/** A baseline that expired (checks config changed) or covers nothing checked. */
export function fromBaseline(options: {
  mode: UnattendedMode;
  flow: string;
  baseline: BaselineFacts | undefined;
}): Condition | undefined {
  const { baseline, flow } = options;
  if (baseline === undefined) return undefined;
  if (baseline.stale !== undefined)
    return {
      key: baselineKey(flow),
      cause: "baseline",
      mode: options.mode,
      flows: [flow],
      subcause: "baseline-stale",
      what: `baseline is stale: ${oneLine(baseline.stale.reason)}`,
      fix: `idiom baseline advance ${flow} (or baseline record) on main and commit it`,
    };
  if (baseline.coversNone === true)
    return {
      key: baselineKey(flow),
      cause: "baseline",
      mode: options.mode,
      flows: [flow],
      subcause: "baseline-uncovered",
      what: "the recorded baseline covers none of the checked states",
      fix: `idiom baseline record ${flow} on a clean main and commit .idiom/baselines`,
    };
  return undefined;
}

/** The gate found no comparison at all: no baseline and no base capture. */
export function fromGateComparison(options: {
  flow: string;
  comparison: { mode: string; base: string } | undefined;
}): Condition | undefined {
  if (options.comparison?.mode !== "none") return undefined;
  return baselineMissing({
    mode: "gate",
    flow: options.flow,
    what: `no baseline reachable from base ${options.comparison.base.slice(0, 12)} and no base capture`,
  });
}

/** A captured coordinate whose declared expectation no longer matches. */
export type BrokenCoverage = {
  state: string;
  viewport: string;
  colorScheme: string;
  mismatches: ExpectationMismatch[];
};

function mismatchText(mismatch: ExpectationMismatch): string {
  return `${mismatch.kind} ${JSON.stringify(mismatch.expected)}${mismatch.actual === undefined ? "" : ` (saw ${JSON.stringify(mismatch.actual)})`}`;
}

/** One condition per state whose expectation stopped matching. */
export function fromBrokenCoverage(options: {
  mode: UnattendedMode;
  flow: string;
  broken: readonly BrokenCoverage[] | undefined;
  /** The flow manifest, relative to the project. */
  flowFile?: string | undefined;
}): Condition[] {
  const byState = new Map<string, BrokenCoverage[]>();
  for (const entry of options.broken ?? [])
    byState.set(entry.state, [...(byState.get(entry.state) ?? []), entry]);
  const file = options.flowFile ?? `.idiom/flows/${options.flow}.json`;
  return [...byState].map(([state, entries]) => {
    const expectations = [
      ...new Set(
        entries.flatMap((entry) => entry.mismatches.map(mismatchText)),
      ),
    ];
    const coordinates = entries.map(
      (entry) => `${entry.viewport}/${entry.colorScheme}`,
    );
    return {
      key: expectationKey(options.flow, state),
      cause: "expectation",
      mode: options.mode,
      flows: [options.flow],
      state,
      subcause: [
        ...new Set(
          entries.flatMap((entry) => entry.mismatches.map((m) => m.kind)),
        ),
      ].join(","),
      coordinates,
      what: `expect no longer matches at ${coordinates.join(", ")}: ${expectations.join("; ")}`,
      fix: `fix the app, or update the state's steps/expect in ${file}; confirm with idiom capture ${options.flow} --states ${state}`,
      detail: [
        ...coordinates.map((coordinate) => `coordinate: ${coordinate}`),
        ...expectations.map((text) => `expected: ${text}`),
      ],
    };
  });
}

/** The structural slice of a check summary that says what a run exercised. */
export type ExercisedSummary = {
  coverage?:
    | {
        states: string[];
        failedTuples?: CoverageCoordinate[] | undefined;
        unresolvedTuples?: CoverageCoordinate[] | undefined;
      }
    | undefined;
  scope?: { selected: CoverageCoordinate[] } | undefined;
  baseline?: BaselineFacts | undefined;
  brokenCoverage?: BrokenCoverage[] | undefined;
};
type CoverageCoordinate = {
  state: string;
  viewport: string;
  colorScheme?: string | undefined;
};

/**
 * What one checked flow clears: its baseline when it compared against a
 * usable one, and each state captured cleanly at the coordinates it ran.
 */
export function clearedScopes(options: {
  flow: string;
  summary: ExercisedSummary;
  legacyColorScheme: string;
  /** Whether the baseline counts for this mode (the gate's base capture does). */
  baselineUsable: boolean;
}): ClearedScope[] {
  const { summary, flow } = options;
  const cleared: ClearedScope[] = [];
  if (options.baselineUsable) cleared.push({ key: baselineKey(flow) });
  const coverage = summary.coverage;
  if (coverage === undefined) return cleared;
  const bad = new Set(
    [
      ...(coverage.failedTuples ?? []),
      ...(coverage.unresolvedTuples ?? []),
      ...(summary.brokenCoverage ?? []),
    ].map((tuple) => tuple.state),
  );
  for (const state of coverage.states) {
    if (bad.has(state)) continue;
    const coordinates = (summary.scope?.selected ?? [])
      .filter((tuple) => tuple.state === state)
      .map(
        (tuple) =>
          `${tuple.viewport}/${tuple.colorScheme ?? options.legacyColorScheme}`,
      );
    cleared.push({ key: expectationKey(flow, state), coordinates });
  }
  return cleared;
}

/** A command that stopped on unattended conditions; the CLI reports them. */
export class ConditionsRaised extends IdiomError {
  readonly conditions: Condition[];
  readonly cleared: ClearedScope[];

  constructor(conditions: Condition[], cleared: ClearedScope[] = []) {
    super(conditions.map(conditionLine).join("\n"));
    this.name = "ConditionsRaised";
    this.conditions = conditions;
    this.cleared = cleared;
  }
}
