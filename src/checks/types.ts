import type { ConsoleRecord, ExpectationMismatch } from "../capture/types.js";
import type { LoadedDesign } from "../design/types.js";
import type { DesignDriftConfig } from "../schemas/design.js";
import type { DesignDriftEvidence } from "../schemas/finding.js";
import type { EffectiveInvariant } from "../schemas/invariant.js";
import type { ColorScheme } from "../schemas/project.js";
import type {
  ActionTimeline,
  ActionTimelineArtifact,
  HeldReplay,
  PendingIndicatorKind,
  VisibleChange,
} from "./artifact-schema.js";
import type {
  LivenessArtifact,
  TouchReachabilityArtifact,
} from "./dynamic-schema.js";

export const deterministicCheckIds = [
  "overflow-clip",
  "responsive-break",
  "contrast",
  "a11y-label",
  "target-size",
  "heading-structure",
  "token-drift",
  "console-error",
  "missing-state",
  "spacing-rhythm",
  "unexplained-control",
  "text-centering",
  "adjacent-gap",
  "dead-affordance",
  "dead-control",
  "duplicate-entry",
  "component-size",
  "copy-lint",
  "glyph-icon",
  "error-text",
  "native-control",
  "layout-invariants",
  "group-invariants",
  "selected-state",
  "dialog-shell",
  "disguised-control",
  "fresh-state",
  "mirrored-control",
  "motion",
  "element-overlap",
  "clipped-text",
  "field-group",
  "scale-conformance",
  "control-anatomy",
  "luminance-parity",
  "frame",
  "primary-region",
  "alarm-at-rest",
  "cross-surface-naming",
  "published-budget",
  "empty-state",
  "progress-affordance",
  "page-content",
  "band-edges",
  "word-break",
  "shell-visibility",
  "compound-control",
  "sibling-chrome",
  "touch-reachability",
  "liveness",
  "media-fill",
  "collection-actions",
  "font-loading",
  "broken-link",
  "focus-visible",
  "line-length",
  "orphan-word",
  "image-distortion",
  "broken-image",
  "layout-shift",
  "interaction-shift",
  "design-drift",
  "loading-state-missing",
  "double-submit",
] as const;

export type DeterministicCheckId = (typeof deterministicCheckIds)[number];

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ObservedStyles = {
  color: string;
  backgroundColor: string;
  borderTopColor: string;
  borderRightColor: string;
  borderBottomColor: string;
  borderLeftColor: string;
  borderTopWidth: string;
  borderRightWidth: string;
  borderBottomWidth: string;
  borderLeftWidth: string;
  outlineColor: string;
  outlineWidth: string;
  outlineStyle?: string | undefined;
  /** Absent in captures that predate ring-offset measurement. */
  outlineOffset?: string | undefined;
  /** Absent in captures that predate mock-up detection. */
  userSelect?: string | undefined;
  textOverflow?: string | undefined;
  fill: string;
  stroke: string;
  borderTopLeftRadius: string;
  borderTopRightRadius: string;
  borderBottomRightRadius: string;
  borderBottomLeftRadius: string;
  overflowX: string;
  overflowY: string;
  position: string;
};

export type ExpandedObservedStyles = ObservedStyles & {
  borderTopStyle?: string | undefined;
  borderRightStyle?: string | undefined;
  borderBottomStyle?: string | undefined;
  borderLeftStyle?: string | undefined;
  display: string;
  visibility: string;
  opacity: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  textAlign: string;
  textDecorationLine: string;
  textTransform: string;
  whiteSpace: string;
  wordBreak: string;
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  marginTop: string;
  marginRight: string;
  marginBottom: string;
  marginLeft: string;
  gap: string;
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
  gridTemplateColumns: string;
  boxShadow: string;
  transform: string;
  zIndex: string;
};

export type PaintedFact =
  | { value: true }
  | { value: false; reason: string; boundary?: string | undefined };

export type ObservedElement = {
  selector: string;
  tag: string;
  text: string;
  visible: boolean;
  painted?: PaintedFact | undefined;
  /** Contributors and scroll extent excluding wholly unpainted content. */
  paintedContent?:
    | {
        selectors: string[];
        width: number;
        height: number;
        /**
         * Painted text/control contributors partly cut off by this box;
         * marquee tracks excluded. Absent on captures that predate it.
         */
        clipped?:
          | { text: string[]; interactive: string[]; marquee: string[] }
          | undefined;
      }
    | undefined;
  interactive: boolean;
  enabled: boolean;
  headingLevel?: number | undefined;
  rect: Rect;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  outOfFlow: boolean;
  inlineTextTarget?: boolean | undefined;
  /** Clickable fragments of associated native checkbox/radio labels; absent in legacy captures. */
  targetSizeLabels?: Array<{ selector: string; rects: Rect[] }> | undefined;
  ancestorSelectors: string[];
  authoredProperties?: string[] | undefined;
  styles: ObservedStyles;
  hitTestWith: string[];
};

export type TokenObservation =
  | { status: "not-configured" }
  | {
      status: "configured";
      source: string;
      declarations: Record<string, string>;
      normalizedValues: string[];
      typedValues?:
        | Array<{
            kind: "color" | "radius" | "spacing" | "control-height" | "other";
            value: string;
            name?: string | undefined;
            theme?: string | undefined;
          }>
        | undefined;
    };

export type ObservationArtifactV1 = {
  version: 1;
  viewport: { width: number; height: number };
  document: {
    contentType?: string | undefined;
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  elements: ObservedElement[];
  headings: Array<{
    selector: string;
    level: number;
    text: string;
    axeTargets?: string[] | undefined;
  }>;
  tokens: TokenObservation;
};

export type RGB = { r: number; g: number; b: number };

export type PaintUnavailable = { status: "unavailable"; reason: string };

/** A solid colour and the elements whose paint composited to it. */
export type PaintColor = { color: RGB; sources: string[] };

export type SolidPaint =
  | ({ status: "measured" } & PaintColor)
  | PaintUnavailable;

export type TextPaintSample = {
  foreground: RGB;
  background: RGB;
  sources: string[];
};

export type PaintSignals = {
  /** The opaque colour painted behind the element's content. */
  background: SolidPaint;
  /** The element paints its own fill (not a transparent wrapper). */
  surface: boolean;
  primaryAction: boolean;
  /** Rendered label paint; present only on primary actions. */
  text?:
    | { status: "measured"; samples: TextPaintSample[] }
    | { status: "none" }
    | PaintUnavailable
    | undefined;
};

export type FrameShadow = {
  /** Decoration composited within its actual opacity groups. */
  paint?: PaintColor | undefined;
  color: RGB;
  alpha: number;
  /** How far the shadow paints past (outer) or into (inset) this edge, px. */
  extent: number;
  inset: boolean;
  /** An ancestor's overflow clip removes an outer shadow at this edge. */
  clipped: boolean;
};

/** Legacy measured borders omit status; unsupported border paint records its reason. */
export type FrameBorder = { width: number; style: string } & (
  | {
      status?: "measured" | undefined;
      color: RGB;
      alpha: number;
      paint?: PaintColor | undefined;
    }
  | PaintUnavailable
);

export type FrameEdgeSample = {
  side: "top" | "right" | "bottom" | "left";
  insidePoint: { x: number; y: number };
  outsidePoint: { x: number; y: number };
} & (
  | { status: "offscreen" }
  | { status: "unavailable"; reason: string; occluder?: string | undefined }
  | {
      status: "measured";
      inside: PaintColor;
      surround: PaintColor;
      border: FrameBorder;
      shadows:
        | {
            status: "measured";
            layers: FrameShadow[];
            /** Composited visible shadow bands, in CSS paint order. */
            samples?:
              | Array<
                  PaintColor & {
                    inset: boolean;
                    distance: number;
                    backdrop: RGB;
                  }
                >
              | undefined;
          }
        | PaintUnavailable;
    }
);

/**
 * Optional per-element signals added in idiom 0.3. Artifacts captured by
 * earlier versions omit them, and the checks that need them report coverage
 * "unavailable" instead of guessing.
 */
export type ElementSignals = {
  explanation?:
    | {
        controlId?: string | undefined;
        inViewport?: boolean | undefined;
        nativeDisabled?: boolean | undefined;
        visibleText: string;
        descriptions: Array<{ selector: string; text: string }>;
      }
    | undefined;
  paint?: PaintSignals | undefined;
  frameEdges?: FrameEdgeSample[] | undefined;
  role: string;
  name: string;
  described: boolean;
  title?: string | undefined;
  href?: string | undefined;
  controls?: string | undefined;
  haspopup?: string | undefined;
  appearance: string;
  cursor: string;
  hasGraphic: boolean;
  /** Painted content excluding hidden graphics and clipped accessibility labels. */
  renderedContent?:
    | {
        text: boolean;
        directText: boolean;
        graphic: boolean;
        /** First painted DOM/pseudo text font; absent in older captures. */
        textEvidence?:
          | {
              status: "available";
              font: { fontSize: string; fontWeight: string } | null;
            }
          | { status: "unavailable"; reason: string }
          | undefined;
      }
    | undefined;
  lineCount: number;
  textRect?: Rect | undefined;
  inkCenterY?: number | undefined;
  /**
   * Visible-only label geometry: text nodes that are actually painted
   * (screen-reader labels excluded). A lone non-letter glyph centres on its
   * ink box. Absent in older captures.
   */
  labelInk?:
    | {
        text: string;
        lineCount: number;
        textRect?: Rect | undefined;
        inkCenterY?: number | undefined;
        glyph?: true | undefined;
      }
    | undefined;
  contentBox: Rect;
  transition: string;
  animation: string;
  motion?: MotionStyles | undefined;
  nodeId?: string | undefined;
  focused: boolean;
  repeatedItem: boolean;
  /** Browser-computed viewport intersection for rendered dialog controls. */
  viewportIntersection?: Rect | undefined;
  /**
   * Painted (non-element) chevron of a select-like control. Every select-like
   * in a current capture carries it; absent in older captures.
   */
  adornment?:
    | { status: "measured"; source: "background"; rect: Rect }
    | { status: "none" }
    | { status: "unmeasured"; reason: string }
    | undefined;
  /**
   * Icon-like elements only: whether an error/warning context surrounds the
   * icon (aria-invalid, role=alert, an error message target) and the icon's
   * naming hints. Absent in older captures.
   */
  alarm?: { context: boolean; iconHint?: string | undefined } | undefined;
  /**
   * Select-like elements only: the displayed value (a native select's
   * selected option, a combobox's text or input value). Absent in older
   * captures.
   */
  value?: string | undefined;
};

export type ProbeEffect =
  | "dom"
  | "focus"
  | "navigation"
  | "dialog"
  | "network"
  | "popup"
  | "clipboard"
  | "aria"
  | "filechooser"
  | "picker"
  | "print"
  | "download";

export type ProbeAttemptTimings = {
  clickMs: number;
  effectWindowMs: number;
  restoreCheckMs: number;
  escapeMs: number;
  replayMs: number;
};

export type ProbeResult = {
  timings?: ProbeAttemptTimings | undefined;
  /** This attempt left a persistent change that requires the next replay. */
  replayRequired?: boolean | undefined;
  elapsedMs?: number | undefined;
  /**
   * `not-reached`: the probe never attempted this control (maxControls,
   * state budget, or the nested-menu budget); `skipped` names why.
   */
  status?: "completed" | "timed-out" | "not-reached" | undefined;
  timeoutScope?: "control" | "state" | undefined;
  /**
   * The same control (by role, name, region and selector signature) was
   * probed at this earlier state of the flow; its result is reused here.
   */
  reusedFrom?: string | undefined;
  selector: string;
  name: string;
  effects: ProbeEffect[];
  signature?: string | undefined;
  persistent: boolean;
  /** One of three or more look-alike siblings: a per-row action. */
  repeated?: boolean | undefined;
  /** Nearest landmark or named region, as `role "name"` or `role`. */
  region?: string | undefined;
  /**
   * The click did something beyond moving focus (navigation, an opened
   * region, a non-focus DOM change…). Undefined in artifacts from older
   * probes.
   */
  primary?: boolean | undefined;
  skipped?: string | undefined;
};

export type MotionStyles = {
  transitionProperty: string;
  transitionDuration: string;
  transitionDelay: string;
  animationName: string;
  animationDuration: string;
  animationDelay: string;
  animationIterationCount: string;
  animationPlayState: string;
};

export type MotionSample = {
  rect: Rect;
  opacity: number;
  rendered: boolean;
  transform: string;
  state: string;
  transition: string;
  animation: string;
  motion?: MotionStyles | undefined;
};
export type MotionEffect = {
  kind: "transition" | "animation" | "web-animation";
  property: string;
  name: string;
  durationMs: number | null;
  timing: "finite" | "infinite" | "unsupported";
  delayMs: number;
  started: boolean;
  canceled: boolean;
};
export type MotionChange = {
  selector: string;
  name: string;
  role: string;
  tag: string;
  ownerSelector: string;
  ownerName: string;
  surface: boolean;
  tooltip: boolean;
  before: MotionSample | null;
  after: MotionSample | null;
  changed: Array<"presence" | "size" | "position" | "opacity" | "transform">;
  toggled: boolean;
  direction: "expand" | "collapse" | "change";
  animated: boolean | null;
  reason?: string | undefined;
  effects: MotionEffect[];
};
export type MotionAction = {
  timelineId?: string | undefined;
  source: "probe-hover" | "probe-click" | "web-step";
  selector: string;
  name: string;
  stepIndex?: number | undefined;
  status: "ran" | "partial" | "unavailable";
  reason?: string | undefined;
  changes: MotionChange[];
};
export type MotionArtifact = {
  version: 1;
  status: "ran" | "partial" | "unavailable";
  reason?: string | undefined;
  reducedMotion: boolean;
  actions: MotionAction[];
};

export type {
  ActionTimeline,
  ActionTimelineArtifact,
  HeldReplay,
  PendingIndicatorKind,
  VisibleChange,
};

export type ExplanationRecord = {
  controlId?: string | undefined;
  selector: string;
  trigger: "hover" | "focus";
  source: "probe" | "capture";
  status: "observed" | "absent" | "unavailable";
  reason?: string | undefined;
  tooltips: Array<{ selector: string; text: string }>;
};
export type ExplanationArtifact = {
  version: 1;
  status: "ran" | "partial";
  reason?: string | undefined;
  records: ExplanationRecord[];
};

/** Menus a read-only probe pass opened on a declared collection's first item. */
export type ProbeCollection = {
  selector: string;
  /** Selector of the probed item. */
  item?: string | undefined;
  menus: Array<{
    trigger: "button" | "contextmenu";
    name: string;
    /** Visible menu item names; never clicked. */
    items: string[];
  }>;
  reason?: string | undefined;
};

/**
 * How strictly the probe guards the page. `app` is a configured flow's own
 * app; `third-party` is an arbitrary URL in quick review, where only
 * safe-method requests leave the browser and every escape is blocked.
 */
export type ProbeSafetyPolicy = "app" | "third-party";

/** What a third-party probe sent, blocked and skipped. Counts only. */
export type ProbeSafetyLedger = {
  policy: "third-party";
  /** Origins top-level navigation may stay on. */
  origins: string[];
  /** Routed requests by upper-case HTTP method. */
  requests: {
    sent: Record<string, number>;
    blocked: Record<string, number>;
  };
  blocked: {
    crossOriginNavigation: number;
    formSubmission: number;
    download: number;
    popup: number;
    windowOpen: number;
    beforeunload: number;
    permission: number;
  };
  skipped: { destructive: number };
};

export type ProbeArtifact = {
  /** Present only for third-party (quick review) probes. */
  safety?: ProbeSafetyLedger | undefined;
  /** Read-only enumeration used to allocate this flow before any clicks. */
  candidates?: import("../capture/probe.js").ProbeCandidate[] | undefined;
  selector?: string | undefined;
  step?: string | undefined;
  explanations?: ExplanationArtifact | undefined;
  status: "ran" | "partial" | "timed-out";
  reason?: string | undefined;
  results: ProbeResult[];
  motion?: MotionArtifact | undefined;
  collections?: ProbeCollection[] | undefined;
  /** The held (slow-network) replay of actions that sent requests. */
  heldReplay?:
    | { delayMs: number; queued: number; ran: number; notes: string[] }
    | undefined;
};

export type ComponentObservation = {
  name: string;
  selector: string;
  width: number;
  height: number;
  tolerance: {
    ratio: number;
    px: number;
    mode?: "tighter" | "looser" | undefined;
  };
  rects: Array<Rect & { selector: string }>;
  /**
   * Inferred from a size stated in DESIGN.md rather than declared in
   * checks.components; the selector was resolved at capture from class or
   * aria-label words. A one-axis spec ("24px high") judges only `axis`.
   */
  inferred?:
    | {
        source: string;
        words: string[];
        axis?: "width" | "height" | undefined;
        /**
         * The full word run matched nothing, so a textless element matched
         * the modifier words alone (`override` for "override dot").
         */
        matchedBy?: "modifier" | undefined;
      }
    | undefined;
  /** No class or aria-label words matched; recorded so coverage can say so. */
  unresolved?: true | undefined;
};

export type InvariantObservation = EffectiveInvariant & {
  selectors: Array<{
    selector: string;
    matches: Array<{ selector: string; rect: Rect }>;
  }>;
  /**
   * Group declarations only: raw membership values per matched list (every
   * DOM match, hidden or not), judged offline by the group-invariants check.
   * `owner` is null when a declared owner selector did not match exactly one
   * element; without `owner` in the declaration the list is its own owner.
   */
  groups?:
    | Array<{
        list: string;
        owner: { selector: string; value: string | null } | null;
        items: Array<{ selector: string; label: string; value: string | null }>;
      }>
    | undefined;
};

/**
 * One member of a selection group: the element that carries the selected
 * state (`control`) and the element a reader sees (`selector`), which differ
 * for a visually hidden native radio or checkbox styled through its label.
 */
export type SelectionMember = {
  selector: string;
  control: string;
  selected: boolean;
  source: "aria-selected" | "aria-checked" | "aria-pressed" | "checked";
  /** A rendered native radio/checkbox with appearance ≠ none: the UA paints the state. */
  nativeIndicator: boolean;
  decoration: Record<string, string>;
  paintedDecoration?: Record<string, string> | undefined;
  decorationOwners?: string[] | undefined;
};

export type SelectionGroupObservation = {
  container: string;
  /** Container role, or "" when the group is inferred from siblings. */
  role: string;
  memberRole: string;
  single: boolean;
  members: SelectionMember[];
};

export type DialogObservation = {
  selector: string;
  modal: boolean;
  /** Selectors of rendered aria-labelledby targets. */
  labelledBy: string[];
  /** Selectors of rendered submit buttons whose form is inside the dialog. */
  submit: string[];
};

export type OverlapKind = "interactive" | "text";

/** Two interactive or text elements whose visible boxes intersect. */
export type OverlapObservation = {
  /** Observed selectors, a < b lexically. */
  a: string;
  b: string;
  kinds: [OverlapKind, OverlapKind];
  /** Intersection after ancestor clipping; viewport bounds the hit-test grid. */
  rect: Rect;
  /** Selectors cut by ancestor clipping or a viewport edge (partly visible). */
  partial: string[];
  /** Grid points sampled inside the viewport. */
  samples: number;
  /** Sampled points where elementsFromPoint returned both elements. */
  hits: number;
};

export type ClippedTextObservation = {
  selector: string;
  /** Nearest clipping ancestor (may equal selector). */
  owner: string;
  axis: "x" | "y" | "both";
  /** Pixels beyond the clip box on each axis. */
  overflow: { x: number; y: number };
  lines: number;
  visibleLines: number;
  cut: "mid-word" | "word-boundary" | "sliced-line" | "hidden-lines";
  /** The visible tail, at most 80 characters. */
  visibleText: string;
  /** At most 160 characters. */
  text: string;
};

export type FieldGroupMember = {
  selector: string;
  role: "label" | "control" | "helper";
  rect: Rect;
};

/** A label, its control and the helper/status elements after it. */
export type FieldGroupObservation = {
  /** Nearest common ancestor of label and control. */
  container: string;
  /** Nearest scrolling or dialog region, so groups are compared within one. */
  region: string;
  members: FieldGroupMember[];
};

export type SelectorMarkPurpose =
  | "history"
  | "unsaved"
  | "disguised-ignore"
  | "mirrored"
  | "primary-action"
  | "luminance-ignore"
  | "frame"
  | `scale-${ScaleRole}`
  | "primary-region"
  | "alarm-ignore"
  | "naming"
  | "cta"
  | "adjacent-region"
  | "sibling-region";

/** A configured selector resolved at capture time to observed selectors. */
export type SelectorMark = {
  purpose: SelectorMarkPurpose;
  selector: string;
  matches: string[];
  /** The selector failed to parse at capture; matches is then empty. */
  invalid?: true | undefined;
};

/** A list, table, feed or configured region rendered with no items. */
export type EmptyRegionObservation = {
  selector: string;
  source: "configured" | "list" | "table" | "feed";
  /** The configured region selector this match came from. */
  configured?: string | undefined;
  rect: Rect;
  /** "region" for configured regions; "adjacent" when siblings were searched too. */
  scope: "region" | "adjacent";
  /** Selectors of rendered, enabled CTAs in scope (at most 5). */
  cta: string[];
  /** Explanatory text in scope, normalized, at most 160 chars ("" when none). */
  text: string;
};

export type EmptyRegionsObservation = {
  /** Each configured region selector and how many rendered matches it had. */
  configured: Array<{ selector: string; matched: number }>;
  auto: boolean;
  /** Only regions with no items. */
  regions: EmptyRegionObservation[];
};

/** A solid band measured from one edge of a frame in the screenshot. */
export type MediaBand = {
  /** Fraction of the frame's height (top/bottom) or width (left/right). */
  depth: number;
  color: RGB;
};

export type MediaBands = {
  status: "measured";
  top: MediaBand | null;
  bottom: MediaBand | null;
  left: MediaBand | null;
  right: MediaBand | null;
  /** The whole frame is one solid colour. */
  blank: boolean;
};

/** The visible box of an image, iframe, video or canvas in a repeated card. */
export type MediaFrameObservation = {
  selector: string;
  kind: "img" | "iframe" | "video" | "canvas";
  frame: Rect;
  /** Selector of the repeated items' container (the gallery). */
  group: string;
  /**
   * Opaque colours behind the content: the media's own background, then the
   * nearest opaque ancestor background. Only bands of these colours count, so
   * an image whose own content has margins is not mistaken for a gap.
   */
  backdrop: RGB[];
  loaded: boolean;
  /** Sampled from the screenshot; absent when no screenshot was taken. */
  bands?: MediaBands | { status: "unavailable"; reason: string } | undefined;
};

export type CollectionItemObservation = {
  selector: string;
  rect: Rect;
  /** The item is or contains a link/button, is focusable, or has cursor: pointer. */
  open: boolean;
  /** Names of every descendant control, hidden ones included (at most 30). */
  controls: string[];
  menuTriggers: Array<{ selector: string; name: string }>;
};

export type CollectionObservation = {
  selector: string;
  matched: number;
  /** The selector failed to parse at capture. */
  invalid?: true | undefined;
  /** The first five rendered items. */
  items: CollectionItemObservation[];
};

export type ProgressAffordanceKind =
  | "progressbar"
  | "busy"
  | "spinner"
  | "status-text"
  | "control-text"
  | "progress-text";

/** One web step marked longRunning and what appeared after its action began. */
export type ProgressStep = {
  /** One-based, as in web-step diagnostics. */
  stepIndex: number;
  action: "click" | "fill" | "press" | "select";
  selector: string;
  status: "ran" | "unavailable";
  reason?: string | undefined;
  /** ms after the action began when an affordance first appeared; null if none. */
  firstMs: number | null;
  affordance?:
    | {
        kind: ProgressAffordanceKind;
        selector: string;
        text?: string | undefined;
      }
    | undefined;
  /** How long the watcher ran (at least withinMs unless unavailable). */
  observedMs: number;
  /** When the step's network/DOM activity went quiet, ms after action start. */
  settledMs?: number | undefined;
};

export type ProgressArtifact = {
  version: 1;
  withinMs: number;
  steps: ProgressStep[];
};

/** Where a measured property's winning declaration was authored. */
export type StyleSource = {
  /** Stylesheet path, `<style>[n]`, or `inline`. */
  sheet: string;
  selector: string;
  /** Custom properties the declaration references. */
  tokens?: string[] | undefined;
  /** Referenced custom properties with no value on the element. */
  unresolved?: string[] | undefined;
};

export type ObservedElementV2 = ObservedElement & {
  /** Keyed by camelCase property; absent in older captures. */
  styleSources?: Record<string, StyleSource> | undefined;
  signals?: ElementSignals | undefined;
  structuralPath: string;
  legacyRenderedPath?: string | undefined;
  directText: string;
  attributes: Record<string, string>;
  temporal: boolean;
  stableIslandPath: string;
  relativeRect: Rect;
  styles: ExpandedObservedStyles;
};

/** An `<img>` as the page holds it after a short decode wait. */
export type ImageObservation = {
  selector: string;
  src: string;
  currentSrc: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  visible: boolean;
};

/** An image request that failed outright or answered 400 or above. */
export type FailedImageRequest = { url: string; reason: string };
/** A subresource request that failed outright or answered 400 or above. */
export type FailedRequest = FailedImageRequest;

/** Declared web fonts, the families visible text uses, and failed font requests. */
export type FontObservation = {
  status: "ran" | "unavailable";
  reason?: string | undefined;
  faces: Array<{
    family: string;
    status: "unloaded" | "loading" | "loaded" | "error";
    weight: string;
    style: string;
    urls: string[];
  }>;
  used: Array<{ family: string; selectors: string[]; fallback: boolean }>;
  failedRequests: FailedRequest[];
};

export type LinkCheckResult =
  | { status: "ok"; code: number }
  | { status: "broken"; code: number | null; reason: string }
  | { status: "unchecked"; reason: string };

export type LinkObservation = {
  selector: string;
  text: string;
  /** Absolute URL, fragment stripped. */
  href: string;
  sameOrigin: boolean;
  result?: LinkCheckResult | undefined;
};

export type FocusVisibleObservation = {
  selector: string;
  name: string;
  rect: Rect;
  /** `node.property` keys that changed on focus; [] means focus is invisible. */
  changed: string[];
  /** The visible stand-in when the focused element itself is visually hidden. */
  proxy?: string | undefined;
};

export type LineLengthObservation = {
  selector: string;
  /** Maximum grapheme count on a measured rendered text line. */
  chars: number;
  /** Widest measured rendered text line, in CSS pixels. */
  width: number;
  /** Descriptive average text-line width per counted grapheme; not an estimate. */
  charWidth: number;
  /** Number of nonempty measured rendered text lines. */
  lines: number;
  text: string;
};

/** Pixel ink under a rect of the stored screenshot. */
export type InkMeasurement =
  | {
      status: "measured";
      /** Share of samples that differ from the rect's modal colour. */
      share: number;
    }
  | { status: "unavailable"; reason: string };

export type OrphanWordObservation = {
  selector: string;
  word: string;
  lines: number;
  text: string;
  /** Union of the owner's measured, painted word rects (viewport-relative, like element rects). */
  rect?: Rect | undefined;
  /** The stranded word's own rect. */
  lastLine?: Rect | undefined;
  /** Ink under `lastLine` in the stored screenshot; absent on older captures. */
  ink?: InkMeasurement | undefined;
};

export type ImageRenderObservation = {
  selector: string;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Content box. */
  rendered: Rect;
  objectFit: string;
  /** |renderedRatio / naturalRatio − 1|; 0 when not measured. */
  distortion: number;
  broken: boolean;
};

export type LayoutShiftObservation = {
  status: "ran" | "unavailable";
  reason?: string | undefined;
  /** Largest session window (Core Web Vitals CLS). */
  score: number;
  entries: Array<{ value: number; startTime: number; sources: string[] }>;
};

export type GeometryScan<T> =
  | { status: "ran"; records: T[] }
  | { status: "partial" | "unavailable"; reason: string; records: T[] };

export type BandEdgeObservation = {
  selector: string;
  rect: Rect;
  fullBleedMedia: boolean;
  content: { left: number; right: number; selectors: string[] } | null;
};

export type WordFragment = {
  selector: string;
  node: number;
  start: number;
  end: number;
  text: string;
  rect: Rect;
};
export type WordBreakObservation = {
  selector: string;
  word: string;
  text: string;
  start: number;
  end: number;
  before: WordFragment;
  after: WordFragment;
};
export type VisibilityGeometry = {
  rect: Rect;
  client: Rect;
  visible: Rect;
  rendered: boolean;
  reason?: string | undefined;
  boundary?: string | undefined;
};
export type ShellVisibilityObservation = {
  shell:
    | { status: "not-configured" }
    | {
        status: "missing" | "ambiguous" | "invalid";
        selector: string;
        count: number;
      }
    | {
        status: "measured";
        selector: string;
        rect: Rect;
        client: Rect;
        viewport: Rect;
        scrollHeight: number;
        clientHeight: number;
        extending: Array<{
          selector: string;
          rect: Rect;
          description?: string | undefined;
        }>;
      };
  overlays: Array<{
    selector: string;
    status: "measured" | "invalid";
    matches: Array<
      VisibilityGeometry & { selector: string; ancestors: string[] }
    >;
  }>;
};

export type ObservationArtifactV2 = Omit<
  ObservationArtifactV1,
  "version" | "elements"
> & {
  version: 2;
  rootFontSize?: number | undefined;
  theme?: string | undefined;
  /** Captured input capabilities; absent in older observations. */
  input?:
    | {
        pointer: "fine" | "coarse" | "none";
        hover: "hover" | "none";
        maxTouchPoints: number;
      }
    | undefined;
  elements: ObservedElementV2[];
  maskMembership: Array<{ selector: string; paths: string[] }>;
  components?: ComponentObservation[] | undefined;
  invariants?: InvariantObservation[] | undefined;
  shellVisibility?: ShellVisibilityObservation | undefined;
  probe?: ProbeArtifact | undefined;
  explanations?: ExplanationArtifact | undefined;
  motion?: MotionArtifact | undefined;
  selectionGroups?: SelectionGroupObservation[] | undefined;
  dialogs?: DialogObservation[] | undefined;
  /** Set only when the flow declared the state `fresh` (first load). */
  fresh?: boolean | undefined;
  selectorMarks?: SelectorMark[] | undefined;
  overlaps?: OverlapObservation[] | undefined;
  clippedText?: ClippedTextObservation[] | undefined;
  fieldGroups?: FieldGroupObservation[] | undefined;
  /** Collected only for published flows. */
  images?: ImageObservation[] | undefined;
  failedImageRequests?: FailedImageRequest[] | undefined;
  emptyRegions?: EmptyRegionsObservation | undefined;
  progress?: ProgressArtifact | undefined;
  bandEdges?: GeometryScan<BandEdgeObservation> | undefined;
  wordBreaks?: GeometryScan<WordBreakObservation> | undefined;
  touchReachability?: TouchReachabilityArtifact | undefined;
  liveness?: LivenessArtifact | undefined;
  /** Gallery frames; [] when sampling ran and found none. */
  mediaFrames?: MediaFrameObservation[] | undefined;
  /** Measurement parameters used when sampling mediaFrames. */
  mediaFill?: { tolerance: number } | undefined;
  collections?: CollectionObservation[] | undefined;
  fonts?: FontObservation | undefined;
  links?: GeometryScan<LinkObservation> | undefined;
  focusVisible?: GeometryScan<FocusVisibleObservation> | undefined;
  lineLengths?: GeometryScan<LineLengthObservation> | undefined;
  orphanWords?: GeometryScan<OrphanWordObservation> | undefined;
  imageRenders?: GeometryScan<ImageRenderObservation> | undefined;
  layoutShift?: LayoutShiftObservation | undefined;
  /** How the tuple screenshot was taken; absent in older observations. */
  screenshot?: ScreenshotGeometry | undefined;
};

/**
 * Where crops are cut from: the screenshot's strategy and device scale, and,
 * when layout moved between observing and screenshotting, each observed
 * selector's rect re-measured at screenshot time.
 */
export type ScreenshotGeometry = {
  strategy: "viewport" | "full-page" | "tiled";
  /** Device px per CSS px. */
  scale: number;
  /** CSS px of the captured image. */
  width: number;
  height: number;
  tiles?: number | undefined;
  drift?:
    | {
        observed: { width: number; height: number };
        captured: { width: number; height: number };
      }
    | undefined;
  rects?: Record<string, Rect> | undefined;
};

export type ObservationArtifact = ObservationArtifactV1 | ObservationArtifactV2;

export type CoverageStatus = "ran" | "skipped" | "unavailable";

export type CheckCoverage = {
  check: DeterministicCheckId;
  paintedSkipped?: Record<string, number> | undefined;
  /** Records dropped because the stored screenshot shows no ink where they were measured. */
  inkSkipped?: Record<string, number> | undefined;
  status: CoverageStatus;
  reason?: string | undefined;
};

export type FindingCandidate = {
  fix?: string | undefined;
  designDrift?: DesignDriftEvidence | undefined;
  category: DeterministicCheckId;
  severity: "blocker" | "major" | "minor";
  rule: string;
  selectorHint: string;
  /** Optional identity for multi-element checks; selectorHint remains the crop target. */
  fingerprintHint?: string | undefined;
  explanation: string;
  acceptance: string[];
  verification: {
    check: DeterministicCheckId;
    params?: Record<string, unknown>;
  };
  domSnippet?: string | undefined;
  consoleExcerpt?: string | undefined;
  axeNodes?: unknown[] | undefined;
  evidenceTuples?: CheckTuple[] | undefined;
  /** An action timeline id in the candidate's tuple. */
  timeline?: string | undefined;
};

export type CheckTuple = {
  /** The first design reference; `designs` holds every one when several apply. */
  design?: LoadedDesign | undefined;
  designs?: LoadedDesign[] | undefined;
  /** Why the state's declared references did not apply to this tuple. */
  designNotApplicable?: string | undefined;
  layoutRepresentative?: string | undefined;
  combination?: string | undefined;
  flow: string;
  state: string;
  viewport: string;
  colorScheme?: ColorScheme | undefined;
  colorSchemeAxis?: boolean | undefined;
  width: number;
  height: number;
  metadataPath: string;
  screenshotPath?: string | undefined;
  artifactPaths: string[];
  commit: string;
  createdAt: string;
  observations?: ObservationArtifact | undefined;
  /** Absent for runs captured before action timelines were recorded. */
  timelines?: ActionTimelineArtifact | undefined;
  filmstrips?: import("./filmstrip-schema.js").FilmstripManifest | undefined;
  axe?: unknown;
  console: ConsoleRecord[];
  consoleAvailable?: boolean | undefined;
  documentResponse?:
    | {
        url: string;
        actualStatus: number;
        expectedStatus: number;
      }
    | undefined;
  mismatches: ExpectationMismatch[];
  failure?: { stage: string; message: string } | undefined;
  /**
   * The declared sibling-group key: `sibling:<name>` from a state's
   * siblingGroup, or `group:<flow>:<label>` from its flow-scoped group.
   */
  siblings?: string | undefined;
  /** Present only on a published flow's tuples. */
  published?:
    | {
        maxDiffRatio?: number | undefined;
        pixel?:
          | {
              status: "measured";
              ratio: number;
              differentPixels: number;
              totalPixels: number;
              baseline: string;
            }
          | { status: "no-baseline" }
          | { status: "unavailable"; reason: string }
          | undefined;
      }
    | undefined;
  platform?:
    | {
        platform: string;
        architecture: string;
        release: string;
        browserVersion: string;
      }
    | undefined;
};

export type CheckResult = {
  coverage: CheckCoverage;
  candidates: FindingCandidate[];
};

export type LinksConfig = {
  enabled: boolean;
  external: boolean;
  timeoutMs: number;
  budgetMs: number;
  concurrency: number;
  ignore: string[];
};

export type ChecksConfig = {
  /** The craft checks below read their defaults when a setting is absent. */
  fonts?: { enabled: boolean } | undefined;
  links?: LinksConfig | undefined;
  focusVisible?: { enabled: boolean; ignore: string[] } | undefined;
  lineLength?: { enabled: boolean; max: number } | undefined;
  orphanWord?: { enabled: boolean; maxChars: number } | undefined;
  images?: { enabled: boolean; distortionTolerance: number } | undefined;
  layoutShift?: { enabled: boolean; max: number } | undefined;
  interactionShift?: { enabled: boolean; minDistance: number } | undefined;
  designDrift?: DesignDriftConfig | undefined;
  /** Recorded `decide --choose` answers, applied where design references disagree. */
  designChoices?: import("../design/decide.js").DesignChoice[] | undefined;
  bandEdges?: { enabled: boolean; tolerance: number } | undefined;
  wordBreak?: { enabled: boolean } | undefined;
  touchReachability?: { ignore: string[] } | undefined;
  liveness?:
    | { selectors: string[]; auto: boolean; ignore: string[] }
    | undefined;
  shellVisibility?: { floatingOverlays: string[] } | undefined;
  mediaFill: {
    auto: boolean;
    bandThreshold: number;
    tolerance: number;
    ignore: string[];
  };
  collections: CollectionDeclaration[];
  /** Undefined leaves compound-control skipped. */
  compoundControls?: { tokenMax: number; minInset: number } | undefined;
  /** Chrome regions compared across declared sibling states. */
  siblingChrome: { regions: string[] };
  explanation: "default" | "visible";
  /** Undefined uses input-class defaults: fine 24px, coarse 44px, narrow below 768px. */
  targetSize?:
    | { fine: number; coarse: number; narrowBelow: number }
    | undefined;
  motion: {
    maxMs: number;
    durations: number[];
    selectors: string[];
    /** Smallest visible change (px) a content snap must reach. */
    minExtentPx: number;
  };
  minGap: number;
  adjacentGap: { indicatorMax: number };
  centeringTolerance: number;
  copy: {
    locale?: "en-US" | "en-GB" | "en-CA" | "en-AU" | undefined;
    glossary: Array<{ term: string; preferred?: string | undefined }>;
    retired?: Array<{ term: string; preferred: string }> | undefined;
    jargon?: Array<{ term: string; preferred: string }> | undefined;
    schemaWords: string[];
    /** Optional so hand-built configs stay valid; read as `?? []`. */
    properNouns?: string[] | undefined;
  };
  glyphAllow: string[];
  errorPatterns: string[];
  selectedState: { minColorDelta: number };
  disguisedControl: { placeholderPatterns: string[] };
  freshState: { historyNames: string[]; unsavedPatterns: string[] };
  mirrored: MirroredPair[];
  fieldGroups: { inner: number; between: number };
  scales: ScalesConfig;
  luminanceParity: { primarySelectors: string[]; ignore: string[] };
  frame: { selector?: string | undefined; minLuminanceDelta: number };
  primaryRegion?:
    | { selector: string; minShare: number | Record<string, number> }
    | undefined;
  alarm: { colors: string[]; brand: string[] };
  naming: { surfaces: Record<string, string> };
  progressWithinMs: number;
  /** Optional so hand-built configs stay valid; read as `?? 1500`. */
  loading?: { delayMs: number } | undefined;
  emptyState: {
    regions: Array<{ selector: string; items: string }>;
    auto: boolean;
    ignore: string[];
  };
  /**
   * Page review (`idiom review --page` or checks.page). Undefined for flows
   * that did not opt in; page-content then reports coverage skipped.
   */
  page?:
    | {
        brief?: { text: string } | undefined;
        ctaSelectors: string[];
        placeholderPatterns: string[];
        claimsAllow: string[];
      }
    | undefined;
};

export type CollectionAction = "open" | "rename" | "delete";

export type CollectionDeclaration = {
  selector: string;
  name?: string | undefined;
  actions: CollectionAction[];
};

export type RadiusRole = "control" | "card" | "panel" | "chip";
export type ScaleRole = RadiusRole | "divider";
export type RadiusValue = number | "full";

export type ScalesConfig = {
  spacing: Array<number | { multipleOf: number }>;
  controlHeights: number[];
  radius: Record<RadiusRole, RadiusValue[]>;
  border: Record<"divider" | "control", string[]>;
  roles: Record<ScaleRole, string[]>;
};

export type MirroredPair = {
  name: string;
  a: string;
  b: string;
  axis: "vertical" | "horizontal";
};

export type CheckContext = {
  tuple: CheckTuple;
  narrowViewport: boolean;
  config: ChecksConfig;
  /** Every tuple in the run, for checks that compare across states. */
  tuples?: readonly CheckTuple[] | undefined;
};

export type DeterministicCheck = {
  id: DeterministicCheckId;
  run(context: CheckContext): CheckResult;
};

export type RunCheckResult = {
  coverage: Array<{ tuple: CheckTuple; coverage: CheckCoverage }>;
  candidates: Array<{ tuple: CheckTuple; candidate: FindingCandidate }>;
};

export type RunDeterministicCheck = {
  id: DeterministicCheckId;
  run(tuples: CheckTuple[], config?: ChecksConfig): RunCheckResult;
};
