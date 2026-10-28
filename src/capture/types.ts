import type { InferredComponent } from "../checks/design-components.js";
import type { TokenDeclarations } from "../checks/observe.js";
import type {
  ActionTimelineArtifact,
  ObservationArtifact,
  ScreenshotGeometry,
} from "../checks/types.js";
import type { ElectronFlow, ElectronFlowState, Flow } from "../schemas/flow.js";
import type { EffectiveInvariant } from "../schemas/invariant.js";
import type { ColorScheme, Project } from "../schemas/project.js";

export type ProductionBuild = { kind: "production"; id: string };

export type SourceIdentity = {
  commit: string;
  dirty: boolean;
};

export type SelectedViewport = Project["viewports"][number];
export type SelectedColorScheme = ColorScheme;
export type FlowState = Flow["states"][number];

export type CaptureTupleSelection = {
  state: string;
  viewport: string;
  colorScheme?: SelectedColorScheme | undefined;
};

export type LiteralMetadataUrl = {
  kind: "literal";
  origin: string;
  url: string;
  /** The configured origin console, DOM and axe text was rewritten to. */
  canonicalOrigin?: string;
};

export type SetupMetadataUrl = {
  kind: "setup-stdout";
  origin: string;
  source: "setup-stdout";
  pattern: string;
  append: string;
  template: string;
  /** The configured origin console, DOM and axe text was rewritten to. */
  canonicalOrigin?: string;
};

export type MetadataUrl = LiteralMetadataUrl | SetupMetadataUrl;

export type ResolvedState = {
  state: FlowState;
  navigationUrl: string;
  sanitizationAliases?: string[];
  metadataUrl: MetadataUrl;
};

export type StateResolution =
  | { ok: true; value: ResolvedState }
  | { ok: false; state: FlowState; message: string };

export type ExpectationMismatch = {
  kind: "status" | "text-present" | "selector-present" | "selector-absent";
  expected: string | number;
  actual?: string | number | undefined;
};

export type ConsoleRecord = {
  type: string;
  text: string;
  healthAllowed?: boolean;
  location?: { url: string; lineNumber: number; columnNumber: number };
};

export type TupleCapture = {
  ok: true;
  probeMs?: number | undefined;
  status: number | null;
  dom: string;
  screenshot: Buffer;
  /** How `screenshot` was taken; absent when a reused shot carried none. */
  screenshotGeometry?: ScreenshotGeometry | undefined;
  console: ConsoleRecord[];
  axe: unknown;
  observations?: ObservationArtifact | undefined;
  /** Action timelines; written to timelines.json, never into observations. */
  timelines?: ActionTimelineArtifact | undefined;
  filmstrips?: import("./filmstrips.js").FilmstripCapture | undefined;
  mismatches: ExpectationMismatch[];
  startedAt: string;
  endedAt: string;
};

export type TupleFailureStage =
  | "launch"
  | "window"
  | "navigation"
  | "state"
  | "step"
  | "expectation"
  | "observations"
  | "dom"
  | "axe"
  | "screenshot"
  | "console";

export type TupleFailure = {
  ok: false;
  probeMs?: number | undefined;
  stage: TupleFailureStage;
  message: string;
  status?: number | null | undefined;
  dom?: string | undefined;
  screenshot?: Buffer | undefined;
  screenshotGeometry?: ScreenshotGeometry | undefined;
  console: ConsoleRecord[];
  axe?: unknown;
  observations?: ObservationArtifact | undefined;
  timelines?: ActionTimelineArtifact | undefined;
  filmstrips?: import("./filmstrips.js").FilmstripCapture | undefined;
  mismatches: ExpectationMismatch[];
  startedAt: string;
  endedAt: string;
};

export type TupleResult = TupleCapture | TupleFailure;

export type FilmstripRequest = CaptureTupleSelection & {
  identity: import("../checks/filmstrip-schema.js").FilmstripIdentity;
  offsetsMs: number[];
};

export type BrowserTuple = CaptureHooks & {
  filmstripBudget?: import("./filmstrips.js").FilmstripBudget | undefined;
  filmstripRequests?: FilmstripRequest[] | undefined;
  designReference?: import("../design/source.js").DesignSource | undefined;
  shell?: string | undefined;
  /** Reuse an equal-layout screenshot while collecting this tuple's own evidence. */
  reuseScreenshot?: Buffer | undefined;
  reuseScreenshotGeometry?: ScreenshotGeometry | undefined;
  invariants?: EffectiveInvariant[] | undefined;
  project: Project;
  state: FlowState;
  viewport: SelectedViewport;
  colorScheme?: SelectedColorScheme | undefined;
  navigationUrl: string;
  health?: import("./web-steps.js").ResolvedWebHealth | undefined;
  tokens?: TokenDeclarations | undefined;
  /** Component sizes inferred from DESIGN.md, resolved to selectors in observe. */
  designComponents?: InferredComponent[] | undefined;
  probe?: boolean | undefined;
  enumerateProbe?: boolean | undefined;
  probeBudget?: import("./probe-budget.js").ProbeBudgetLease | undefined;
  /**
   * Flow-scoped probe results: a control already probed at an earlier state
   * is reused instead of clicked again.
   */
  failureReplays?: string[] | undefined;
  probeLedger?: import("./probe-ledger.js").ProbeLedger | undefined;
  /** Flow-scoped held replays of web steps: each is replayed once per flow. */
  replayLedger?: import("./replay-ledger.js").ReplayLedger | undefined;
  /**
   * `third-party`: arbitrary URLs (quick review). Only safe-method requests,
   * no cross-origin top-level navigation, no submission or permission
   * prompts; the probe artifact carries a `safety` ledger.
   */
  probeSafety?: "third-party" | undefined;
  /**
   * One wall-clock allowance for the focus sweep and the click probe
   * together, overriding `checks.probe.stateTimeoutMs` for this tuple. The
   * sweep may use at most a third of it.
   */
  probePageBudgetMs?: number | undefined;
  /** A published flow's tuple: record images and failed image requests. */
  published?: boolean | undefined;
};

export interface BrowserSession {
  readonly version: string;
  /** Supports capture(enumerateProbe): return read-only probe candidates. */
  readonly planProbes?: boolean;
  capture(tuple: BrowserTuple): Promise<TupleResult>;
  /**
   * Reach a tuple's state in a throwaway page and return a layout signature:
   * the rounded rects of every element each selector matches. Undefined when
   * the state cannot be reached; such a tuple is captured normally.
   */
  measure?(
    tuple: BrowserTuple,
    selectors: string[],
  ): Promise<string | undefined>;
  close(): Promise<void>;
}

export type BrowserLauncher = (
  options?: CaptureHooks,
) => Promise<BrowserSession>;

export type ElectronTuple = CaptureHooks & {
  shell?: string | undefined;
  invariants?: EffectiveInvariant[] | undefined;
  project: Project;
  state: ElectronFlowState;
  viewport: SelectedViewport;
  colorScheme?: SelectedColorScheme | undefined;
  tokens?: TokenDeclarations | undefined;
};

export type ElectronCaptureResult = {
  result: TupleResult;
  version: string;
};

export interface ElectronSession {
  readonly effectiveEnvironment: NodeJS.ProcessEnv;
  capture(tuple: ElectronTuple): Promise<ElectronCaptureResult>;
  close(): Promise<void>;
}

export type ElectronLauncher = (
  options: CaptureHooks & {
    projectDirectory: string;
    flow: ElectronFlow;
    dataDirectory: string;
    inheritedEnvironment: NodeJS.ProcessEnv;
  },
) => Promise<ElectronSession>;

export type CaptureCounts = {
  passed: number;
  failed: number;
  total: number;
};

export type CaptureRunResult = {
  scope?: import("./run-record.js").RunRecord | undefined;
  timings?: import("./timings.js").RunTimings | undefined;
  build?: ProductionBuild | undefined;
  reportPath: string;
  runDirectory: string;
  counts: CaptureCounts;
};

export type CaptureActivity = {
  state: string;
  viewport: string;
  colorScheme: string;
  step: string;
};
export type ProbeProgress = {
  state?: string | undefined;
  viewport?: string | undefined;
  colorScheme?: string | undefined;
  completed: number;
  selector: string;
  phase: string;
};
export type CaptureHooks = {
  signal?: AbortSignal | undefined;
  onActivity?: ((step: string) => void) | undefined;
  onProbeProgress?: ((event: ProbeProgress) => void) | undefined;
};
