import type { ColorScheme } from "../schemas/project.js";
import type { FileClass, StyleScope } from "./classify.js";

/** Work the gate left out to fit its budget; never dropped silently. */
export type GateSkip = {
  kind: "probe-controls" | "viewport" | "scheme" | "probe" | "state";
  flow: string;
  state?: string | undefined;
  viewport?: string | undefined;
  scheme?: ColorScheme | undefined;
  reason: string;
  estimatedMs: number;
};

/** How a state entered the gate: its own route, an import, or a fallback. */
export type GateRank = "route" | "import" | "fallback";

export type GateStatePlan = {
  flow: string;
  state: string;
  rank: GateRank;
  /** Flow declaration order; later states trim first within a rank. */
  order: number;
  viewports: string[];
  schemes: ColorScheme[];
  /** The style scope widened this state past one viewport or scheme. */
  expandedViewports: string[];
  expandedSchemes: ColorScheme[];
  /** Probed this run (after trimming). */
  probe: boolean;
  /** Estimated controls the probe clicks, from the reference run. */
  probeControls: number;
  /** The reference run whose fingerprints scope the probe, if any. */
  region?: { runId: string; controls: number } | undefined;
};

export type GateServer =
  | { mode: "reused"; verified: boolean; reason: string }
  | { mode: "production-reuse"; reason: string }
  | { mode: "fresh"; reason: string };

export type GateEstimate = {
  totalMs: number;
  buildMs: number;
  startMs: number;
  captureMs: number;
  probeMs: number;
  checksMs: number;
  /** Some numbers are defaults because no stored run measured them. */
  noHistory: boolean;
};

export type GateFile = FileClass & {
  kind?: "route" | "import" | "global" | "unresolved" | undefined;
  routes?: string[] | undefined;
  states?: string[] | undefined;
};

export type GatePlan = {
  skipped: false;
  base: string;
  baseReason: string;
  graph: { complete: boolean; reasons: string[] };
  files: GateFile[];
  styleScope: StyleScope;
  states: GateStatePlan[];
  tuples: Array<{
    flow: string;
    state: string;
    viewport: string;
    scheme: ColorScheme;
  }>;
  server: GateServer;
  estimate: GateEstimate;
  budgetMs: number;
  skippedWork: GateSkip[];
  /** The probe allotment after trimming, ms; undefined = the flow's own. */
  probeBudgetMs?: number | undefined;
  minimumExceedsBudget: boolean;
  /** Per-flow baseline availability: false gates open findings instead. */
  baselines: Record<string, boolean>;
  /** Per-flow: what new findings are judged against (the build's base). */
  comparisons: Record<string, GateComparisonPlan>;
  notes: string[];
  /** Flows with at least one affected state, before budget trimming. */
  flows: string[];
  /** Every validated flow id. */
  allFlows: string[];
};

export type GateSkipResult = {
  skipped: true;
  base: string;
  reason: string;
  line: string;
  files: GateFile[];
  /** Every validated flow id. */
  allFlows: string[];
};

/** What a gated flow's report carries under **Build gate**. */
export type GateReportSection = {
  plan: string;
  skippedWork: GateSkip[];
  estimateMs: number;
  budgetMs: number;
};

/**
 * How one gated flow's findings are judged: against a stored record that
 * already speaks for the base, a cached or fresh capture of the base, or,
 * when the base capture does not fit the budget, the nearest stored baseline
 * behind it (fallback) or nothing (none: open findings are gated).
 */
export type GateComparisonPlan = {
  mode: "baseline" | "base-cache" | "base-capture" | "fallback" | "none";
  base: string;
  /** The stored baseline leaned on, when not captured at the base. */
  baselineCommit?: string | undefined;
  behindBase?: number | undefined;
  /** Planned tuples no stored record covers (captured at the base). */
  missingTuples: number;
  /** Estimated base capture, worktree preparation included. */
  estimateMs?: number | undefined;
  /** Measured base capture, after the run. */
  baseCaptureMs?: number | undefined;
};
