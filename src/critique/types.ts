import type { Rect } from "../checks/types.js";
import type { Decision } from "../schemas/decision.js";
import type {
  AdvisoryAspect,
  Finding,
  PageFocusArea,
} from "../schemas/finding.js";
import type { RuleOverride } from "../schemas/rules.js";
import type {
  DecisionObservation,
  RulingResolution,
} from "../schemas/ruling.js";

export type ScreenshotRef = {
  label: string;
  path: string;
  readPath: string;
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark" | undefined;
};

/**
 * An intended design image, captured at its app tuple's viewport width, with
 * the regions where it visibly differs from that tuple's screenshot.
 */
export type DesignImageRef = {
  /** `<tuple label>/design`; findings cite it in `references`. */
  label: string;
  /** The app screenshot label this design image is intended for. */
  designFor: string;
  path: string;
  readPath: string;
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark" | undefined;
  /** CSS px; design y = app y + offset. */
  offset: number;
  regions: Array<{ id: string; rect: Rect; elements: string[] }>;
};

/**
 * A magnified cut-out of a captured screenshot. Crops are viewing aids, not
 * citation coordinates: findings still cite the parent screenshot label.
 */
export type CropRef = {
  label: string;
  /** The screenshot label this crop magnifies. */
  screenshot: string;
  path: string;
  readPath: string;
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark" | undefined;
  /** The CSS-px region of the parent screenshot. */
  rect: Rect;
};

/** One measured element on a surface, in CSS px from the capture. */
export type GeometryRow = {
  selector: string;
  class?: string | undefined;
  role: string;
  name: string;
  size: string;
  radius: string;
  gapToNearest?:
    | { px: number; neighbour: string; axis: "horizontal" | "vertical" }
    | undefined;
  contrast?: number | undefined;
};

export type SurfaceGeometry = {
  label: string;
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark" | undefined;
  /** Why no rows were measured (older or missing observations). */
  unavailable?: string | undefined;
  rows: GeometryRow[];
  /** Rows past the cap that were left out. */
  omittedRows: number;
  components: Array<{
    name: string;
    selector: string;
    expected: string;
    rendered: string[];
  }>;
};

export type DomExcerpt = {
  label: string;
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark" | undefined;
  content: string;
};

export type ReferenceRef =
  | {
      label: string;
      polarity: "reference" | "anti-reference";
      kind: "image";
      readPath: string;
      mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      note?: string | undefined;
      sourceKind?: "url" | "file" | undefined;
      source?: string | undefined;
      capturedAt?: string | undefined;
      viewport?: { name: string; width: number; height: number } | undefined;
    }
  | {
      label: string;
      polarity: "reference" | "anti-reference";
      kind: "text";
      content: string;
    };

export {
  type AdvisoryAspect,
  advisoryAspects,
  type PageFocusArea,
  pageFocusAreas,
} from "../schemas/finding.js";

/** The pattern an advisory design-intent review judges against its intent. */
export type PatternCritiqueContext = {
  id: string;
  intent: string;
  /** The paired design reference's label, when one exists. */
  reference?: string | undefined;
  aspects: readonly AdvisoryAspect[];
};

/** Page review context: the page's sections and numbered brief/direction. */
export type PageCritiqueContext = {
  url: string;
  sections: Array<{
    id: string;
    role: "hero" | "body" | "final" | "footer" | "page";
    heading?: string | undefined;
    selector: string;
  }>;
  brief?: { path: string; lines: string[] } | undefined;
  direction?: { path: string; lines: string[] } | undefined;
  focus: PageFocusArea[];
  /** Advisory pattern review only: what the pattern is meant to be. */
  pattern?: PatternCritiqueContext | undefined;
};

export type BriefCitation = {
  source: "brief" | "direction";
  line: number;
  excerpt: string;
};

export type CritiqueInput = {
  flow: string;
  surface?: string | undefined;
  intent: string[];
  screenshots: ScreenshotRef[];
  domExcerpts: DomExcerpt[];
  productMd: string;
  designMd: string;
  references: ReferenceRef[];
  priorDecisions: Decision[];
  priorRules?: RuleOverride[] | undefined;
  deterministicFindings: Finding[];
  modelCandidateAllowance: number;
  decisionObservationAllowance: number;
  rulingResolutions: RulingResolution[];
  /** Present only for `idiom review --page`; flow prompts are unchanged without it. */
  page?: PageCritiqueContext | undefined;
  /** Sweep only: zoomed crops of this request's screenshots. */
  crops?: CropRef[] | undefined;
  /** Sweep only: measured geometry per screenshot. */
  geometry?: SurfaceGeometry[] | undefined;
  /** Tuples whose intended design is an image; HTML and site designs are not sent. */
  designImages?: DesignImageRef[] | undefined;
  /** Sweep only: the configured design spec (`design.specFile`). */
  spec?: { file: string; content: string } | undefined;
};

export type ModelFindingCandidate = {
  category:
    | "hierarchy"
    | "density"
    | "brand-alignment"
    | "generic-pattern"
    | "reference-mismatch"
    | "direction-drift"
    | "offer-change"
    | "unsupported-claim"
    | "spec-mismatch"
    | "design-drift";
  severity: "blocker" | "major" | "minor";
  confidence: number;
  rule: string;
  selectorHint: string;
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark" | undefined;
  screenshots: string[];
  references: string[];
  explanation: string;
  suggestedArea: string;
  acceptance: string[];
  /** Page review only: the section id, brief/direction citations, fix and focus. */
  section?: string | undefined;
  citations?: BriefCitation[] | undefined;
  fix?: string | undefined;
  focus?: PageFocusArea | undefined;
  /** Advisory pattern review only: the design aspect a finding concerns. */
  aspect?: AdvisoryAspect | undefined;
};

export interface CritiqueAdapter {
  critique(input: CritiqueInput): Promise<CritiqueResult>;
}

export type CritiqueResult = {
  findings: ModelFindingCandidate[];
  decisionObservations: DecisionObservation[];
  discardedDecisionObservations: number;
};

export function critiqueResult(options: {
  findings: ModelFindingCandidate[];
  decisionObservations?: DecisionObservation[] | undefined;
  discardedDecisionObservations?: number | undefined;
}): CritiqueResult {
  return {
    findings: options.findings,
    decisionObservations: options.decisionObservations ?? [],
    discardedDecisionObservations: options.discardedDecisionObservations ?? 0,
  };
}
