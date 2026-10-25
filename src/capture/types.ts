import type { InferredComponent } from "../checks/design-components.js";
import type { TokenDeclarations } from "../checks/observe.js";
import type { ObservationArtifact } from "../checks/types.js";
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
  console: ConsoleRecord[];
  axe: unknown;
  observations?: ObservationArtifact | undefined;
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
  console: ConsoleRecord[];
  axe?: unknown;
  observations?: ObservationArtifact | undefined;
  mismatches: ExpectationMismatch[];
  startedAt: string;
  endedAt: string;
};

export type TupleResult = TupleCapture | TupleFailure;

export type BrowserTuple = CaptureHooks & {
  shell?: string | undefined;
  /** Reuse an equal-layout screenshot while collecting this tuple's own evidence. */
  reuseScreenshot?: Buffer | undefined;
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
  /** A published flow's tuple: record images and failed image requests. */
  published?: boolean | undefined;
};

export interface BrowserSession {
  readonly version: string;
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
