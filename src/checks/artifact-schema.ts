import { z } from "zod";
import {
  invariantOriginSchema,
  invariantSchema,
  invariantSelectors,
  isGroupInvariant,
} from "../schemas/invariant.js";
import {
  livenessArtifactSchema,
  touchReachabilityArtifactSchema,
} from "./dynamic-schema.js";

const finite = z.number().finite();
const dimension = finite.nonnegative();

const rectSchema = z
  .object({ x: finite, y: finite, width: dimension, height: dimension })
  .strict();

const stylesSchema = z
  .object({
    color: z.string(),
    backgroundColor: z.string(),
    borderTopColor: z.string(),
    borderRightColor: z.string(),
    borderBottomColor: z.string(),
    borderLeftColor: z.string(),
    borderTopWidth: z.string(),
    borderRightWidth: z.string(),
    borderBottomWidth: z.string(),
    borderLeftWidth: z.string(),
    outlineColor: z.string(),
    outlineWidth: z.string(),
    outlineStyle: z.string().optional(),
    outlineOffset: z.string().optional(),
    userSelect: z.string().optional(),
    textOverflow: z.string().optional(),
    fill: z.string(),
    stroke: z.string(),
    borderTopLeftRadius: z.string(),
    borderTopRightRadius: z.string(),
    borderBottomRightRadius: z.string(),
    borderBottomLeftRadius: z.string(),
    overflowX: z.string(),
    overflowY: z.string(),
    position: z.string(),
  })
  .strict();

const expandedStylesSchema = stylesSchema.extend({
  borderTopStyle: z.string().optional(),
  borderRightStyle: z.string().optional(),
  borderBottomStyle: z.string().optional(),
  borderLeftStyle: z.string().optional(),
  display: z.string(),
  visibility: z.string(),
  opacity: z.string(),
  fontFamily: z.string(),
  fontSize: z.string(),
  fontWeight: z.string(),
  lineHeight: z.string(),
  letterSpacing: z.string(),
  textAlign: z.string(),
  textDecorationLine: z.string(),
  textTransform: z.string(),
  whiteSpace: z.string(),
  wordBreak: z.string(),
  paddingTop: z.string(),
  paddingRight: z.string(),
  paddingBottom: z.string(),
  paddingLeft: z.string(),
  marginTop: z.string(),
  marginRight: z.string(),
  marginBottom: z.string(),
  marginLeft: z.string(),
  gap: z.string(),
  flexDirection: z.string(),
  justifyContent: z.string(),
  alignItems: z.string(),
  gridTemplateColumns: z.string(),
  boxShadow: z.string(),
  transform: z.string(),
  zIndex: z.string(),
});

const elementSchema = z
  .object({
    selector: z.string().min(1),
    tag: z.string().min(1),
    text: z.string(),
    visible: z.boolean(),
    painted: z
      .discriminatedUnion("value", [
        z.object({ value: z.literal(true) }).strict(),
        z
          .object({
            value: z.literal(false),
            reason: z.string().min(1),
            boundary: z.string().min(1).optional(),
          })
          .strict(),
      ])
      .optional(),
    paintedContent: z
      .object({
        selectors: z.array(z.string()),
        width: dimension,
        height: dimension,
        clipped: z
          .object({
            text: z.array(z.string()),
            interactive: z.array(z.string()),
            marquee: z.array(z.string()),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    interactive: z.boolean(),
    enabled: z.boolean(),
    headingLevel: z.number().int().min(1).max(6).optional(),
    rect: rectSchema,
    scrollWidth: dimension,
    scrollHeight: dimension,
    clientWidth: dimension,
    clientHeight: dimension,
    outOfFlow: z.boolean(),
    inlineTextTarget: z.boolean().optional(),
    targetSizeLabels: z
      .array(
        z
          .object({
            selector: z.string().min(1),
            rects: z.array(rectSchema),
          })
          .strict(),
      )
      .optional(),
    ancestorSelectors: z.array(z.string()),
    authoredProperties: z.array(z.string()).optional(),
    styles: stylesSchema,
    hitTestWith: z.array(z.string()),
  })
  .strict();

export const motionStylesSchema = z
  .object({
    transitionProperty: z.string(),
    transitionDuration: z.string(),
    transitionDelay: z.string(),
    animationName: z.string(),
    animationDuration: z.string(),
    animationDelay: z.string(),
    animationIterationCount: z.string(),
    animationPlayState: z.string(),
  })
  .strict();
const motionSampleSchema = z
  .object({
    rect: rectSchema,
    opacity: finite.min(0).max(1),
    rendered: z.boolean(),
    transform: z.string(),
    state: z.string(),
    transition: z.string(),
    animation: z.string(),
    motion: motionStylesSchema.optional(),
  })
  .strict();
const motionEffectSchema = z
  .object({
    kind: z.enum(["transition", "animation", "web-animation"]),
    property: z.string().min(1),
    name: z.string(),
    durationMs: finite.nonnegative().nullable(),
    timing: z.enum(["finite", "infinite", "unsupported"]),
    delayMs: finite,
    started: z.boolean(),
    canceled: z.boolean(),
  })
  .strict()
  .refine(
    (e) =>
      e.timing === "finite" ? e.durationMs !== null : e.durationMs === null,
    "finite effects require a duration; non-finite effects require null",
  );
export const motionArtifactSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["ran", "partial", "unavailable"]),
    reason: z.string().min(1).optional(),
    reducedMotion: z.boolean(),
    actions: z.array(
      z
        .object({
          elapsedMs: z.number().finite().nonnegative().optional(),
          source: z.enum(["probe-hover", "probe-click", "web-step"]),
          timelineId: z.string().min(1).optional(),
          selector: z.string().min(1),
          name: z.string(),
          stepIndex: z.number().int().positive().optional(),
          status: z.enum(["ran", "partial", "unavailable"]),
          reason: z.string().min(1).optional(),
          changes: z.array(
            z
              .object({
                selector: z.string().min(1),
                name: z.string(),
                role: z.string(),
                tag: z.string(),
                ownerSelector: z.string().min(1),
                ownerName: z.string(),
                surface: z.boolean(),
                tooltip: z.boolean(),
                before: motionSampleSchema.nullable(),
                after: motionSampleSchema.nullable(),
                changed: z.array(
                  z.enum([
                    "presence",
                    "size",
                    "position",
                    "opacity",
                    "transform",
                  ]),
                ),
                toggled: z.boolean(),
                direction: z.enum(["expand", "collapse", "change"]),
                animated: z.boolean().nullable(),
                reason: z.string().min(1).optional(),
                effects: z.array(motionEffectSchema),
              })
              .strict()
              .refine(
                (change) => change.animated !== null || !!change.reason,
                "unknown animation evidence requires a reason",
              ),
          ),
        })
        .strict()
        .refine(
          (action) => action.status === "ran" || !!action.reason,
          "incomplete action requires a reason",
        ),
    ),
  })
  .strict()
  .refine(
    (artifact) => artifact.status === "ran" || !!artifact.reason,
    "incomplete motion collection requires a reason",
  );

const timelineStatusSchema = z.enum(["ran", "partial", "unavailable"]);
/**
 * One visible change root an action produced, classified in-page where the
 * live DOM (ancestry, ARIA, hidden reveals) is still available. Policy —
 * thresholds, preference, grouping — stays in the motion check.
 */
export const visibleChangeSchema = z
  .object({
    /** The appeared/disappeared root, or the resized region. */
    selector: z.string().min(1),
    /** The grouping surface: a panel slot, list, live region or `main`. */
    container: z.string().min(1),
    containerName: z.string().max(120),
    kind: z.enum([
      "content-swap",
      "expand-collapse",
      "list-item",
      "status",
      "route",
    ]),
    /** `${kind}|${container}`: how the probe and the check group changes. */
    key: z.string().min(1),
    direction: z.enum(["in", "out", "resize"]),
    before: rectSchema.nullable(),
    after: rectSchema.nullable(),
    /** Pixels: the smaller side of an appearing box, or a resize delta. */
    extent: finite.nonnegative(),
    /** Only text changed (counters, echoes); never a snap. */
    textOnly: z.boolean(),
    /** Indices into this action's `animations` covering the change. */
    animations: z.array(z.number().int().nonnegative()),
    /** Inline style changed over 3+ frames: a script-driven tween. */
    progressive: z.boolean(),
  })
  .strict();
const timelinePointSchema = z.object({ x: finite, y: finite }).strict();
/**
 * What the user experienced during one action. Times are milliseconds since
 * the action started: in-page facts on the page clock, request times on the
 * capture process clock. The two clocks differ by one evaluate round trip.
 */
const pendingIndicatorKindSchema = z.enum([
  "progressbar",
  "busy",
  "spinner",
  "status-text",
  "control-text",
  "progress-text",
  "skeleton",
  "trigger-disabled",
  "trigger-busy",
  "trigger-pressed",
]);
const heldChangeSchema = z
  .object({ time: finite, selector: z.string().min(1) })
  .strict();
const heldIndicatorSchema = z
  .object({
    kind: pendingIndicatorKindSchema,
    selector: z.string().min(1),
    time: finite,
    text: z.string().max(80).optional(),
  })
  .strict();
/**
 * What the probe's held replay saw while the action's requests were held.
 * In-page times (indicators, changes, releases) are milliseconds since the
 * action was dispatched, on the page clock; request start times are on the
 * capture process clock, since the action began.
 */
export const heldReplaySchema = z
  .object({
    of: z.enum(["web-step", "probe-click"]),
    delayMs: z.number().int().positive(),
    withinMs: z.number().int().positive(),
    /** False when the action's dispatch was never observed in the page. */
    dispatched: z.boolean(),
    requests: z.array(
      z
        .object({
          method: z.string().min(1),
          path: z.string(),
          resourceType: z.string(),
          startTime: finite,
          releasedAt: finite.nullable(),
          /** The guard let it through after the hold (a safe method). */
          forwarded: z.boolean(),
          /** A main-frame document navigation. */
          navigation: z.boolean(),
        })
        .strict(),
    ),
    releasedAt: finite.nullable(),
    indicator: heldIndicatorSchema.nullable(),
    indicators: z
      .array(
        heldIndicatorSchema
          .extend({ inMain: z.boolean(), progressText: z.boolean() })
          .strict(),
      )
      .max(12),
    firstChange: heldChangeSchema.nullable(),
    firstMainChange: heldChangeSchema.nullable(),
    changedAfterRelease: z.boolean(),
    changeAfterReleaseAt: finite.nullable(),
    mainChangedAfterRelease: z.boolean(),
    mainChangeAfterReleaseAt: finite.nullable(),
    mainSelector: z.string().min(1),
    mainEmpty: z
      .object({ from: finite, to: finite.nullable() })
      .strict()
      .nullable(),
    routeChange: z
      .object({ from: z.string(), to: z.string(), time: finite })
      .strict()
      .nullable(),
    trigger: z
      .object({
        checkedAt: finite.nullable(),
        enabled: z.boolean().nullable(),
      })
      .strict(),
    secondActivation: z
      .object({
        attempted: z.boolean(),
        at: finite.optional(),
        reason: z.string().optional(),
        duplicates: z.array(
          z
            .object({
              method: z.string().min(1),
              path: z.string(),
              time: finite,
            })
            .strict(),
        ),
      })
      .strict(),
    notes: z.array(z.string()),
  })
  .strict();
export type HeldReplay = z.infer<typeof heldReplaySchema>;
export type PendingIndicatorKind = z.infer<typeof pendingIndicatorKindSchema>;

/** Failure facts use page-clock milliseconds since trusted dispatch. Request
 * startTime alone uses the process clock since replay activation. Null is unknown. */
export const failureReplaySchema = z
  .object({
    of: z.enum(["web-step", "probe-click"]),
    sourceAction: z.string(),
    mode: z.enum(["status", "network"]),
    status: z.number().int().min(400).max(599),
    feedbackWithinMs: z.number().int().positive(),
    eligibility: z
      .object({
        basis: z.enum(["response", "release"]),
        responseAt: finite,
        changeAt: finite,
        selector: z.string(),
      })
      .strict(),
    dispatched: z.boolean(),
    navigated: z.boolean(),
    requests: z
      .array(
        z
          .object({
            method: z.string(),
            path: z.string(),
            resourceType: z.enum(["fetch", "xhr"]),
            startTime: finite,
            injectedAt: finite.nullable(),
            delivered: z.boolean(),
          })
          .strict(),
      )
      .max(60),
    observationStart: finite.nullable(),
    observationEnd: finite.nullable(),
    feedback: z
      .array(
        z
          .object({
            time: finite,
            selector: z.string(),
            text: z.string().max(160),
            kind: z.enum(["alert", "status", "live", "invalid", "error"]),
          })
          .strict(),
      )
      .max(40),
    changes: z.array(heldChangeSchema).max(40),
    trigger: z
      .object({
        disabled: z.boolean().nullable(),
        busy: z.boolean().nullable(),
        hidden: z.boolean().nullable(),
        inert: z.boolean().nullable(),
        initiallyEnabled: z.boolean().nullable(),
      })
      .strict(),
    pending: z
      .array(
        z.object({ selector: z.string(), text: z.string().max(160) }).strict(),
      )
      .max(40)
      .nullable(),
    main: z
      .object({
        selector: z.string(),
        initiallyEmpty: z.boolean().nullable(),
        empty: z.boolean().nullable(),
      })
      .strict(),
    retry: z.array(z.string()).max(40).nullable(),
    complete: z.boolean(),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  })
  .strict();
export type FailureReplay = z.infer<typeof failureReplaySchema>;

export const actionTimelineSchema = z
  .object({
    id: z.string().min(1).optional(),
    source: z.enum([
      "load",
      "web-step",
      "probe-click",
      "probe-hover",
      "slow-replay",
      "failure-replay",
    ]),
    kind: z.string().min(1),
    selector: z.string().min(1).optional(),
    name: z.string(),
    stepIndex: z.number().int().positive().optional(),
    /** Document path only; never the query. */
    url: z.string(),
    /** Epoch milliseconds. */
    startedAt: finite,
    /** Epoch origin of the in-page timeline clock. */
    clockOrigin: finite.optional(),
    durationMs: finite.nonnegative(),
    /** False when the window ended at its bound rather than at quiet. */
    settled: z.boolean(),
    status: timelineStatusSchema,
    reason: z.string().min(1).optional(),
    truncated: z.array(
      z.enum([
        "frames",
        "elements",
        "changes",
        "shifts",
        "mutations",
        "animations",
        "requests",
        "visibleChanges",
      ]),
    ),
    /** Document path when the window began (detects client-side routes). */
    fromUrl: z.string().optional(),
    /** The prefers-reduced-motion preference the window was recorded under. */
    reducedMotion: z.boolean().optional(),
    /**
     * A probe replay, under normal motion, of the preceding window with the
     * same source and selector. Evidence for motion snaps only: not a user
     * action of its own.
     */
    confirmation: z.literal(true).optional(),
    /** Every layout-shift entry, including those after recent input. */
    shifts: z.array(
      z
        .object({
          time: finite,
          value: finite.nonnegative(),
          hadRecentInput: z.boolean(),
          sources: z.array(
            z
              .object({
                selector: z.string().min(1),
                previousRect: rectSchema,
                currentRect: rectSchema,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    /**
     * frames[0] is the baseline of the tracked set; later frames hold only
     * elements whose scroll-compensated position or size changed, or that
     * joined the tracked set after a scroll.
     */
    frames: z.array(
      z
        .object({
          time: finite,
          scroll: timelinePointSchema,
          scrollers: z.array(
            z
              .object({ selector: z.string().min(1), x: finite, y: finite })
              .strict(),
          ),
          elements: z.array(
            z
              .object({
                selector: z.string().min(1),
                /** Viewport-relative. */
                rect: rectSchema,
                /** Cumulative scroll of the element's scroll chain. */
                offset: timelinePointSchema,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    mutations: z.array(
      z
        .object({
          time: finite,
          type: z.enum(["insert", "remove"]),
          selector: z.string().min(1),
          rect: rectSchema.nullable(),
        })
        .strict(),
    ),
    animations: z.array(
      z
        .object({
          target: z.string().min(1),
          pseudoElement: z.string().min(1).optional(),
          kind: z.enum(["transition", "animation", "web-animation"]),
          properties: z.array(z.string()),
          durationMs: finite.nonnegative().nullable(),
          delayMs: finite,
          iterations: z.union([finite.nonnegative(), z.literal("infinite")]),
          startTime: finite,
          endTime: finite.nullable(),
        })
        .strict(),
    ),
    requests: z.array(
      z
        .object({
          method: z.string().min(1),
          resourceType: z.string(),
          path: z.string(),
          startTime: finite,
          endTime: finite.nullable(),
          status: z.number().int().nullable(),
          outcome: z.enum(["ok", "failed", "blocked", "pending"]),
        })
        .strict(),
    ),
    viewTransition: z
      .object({
        used: z.boolean(),
        kind: z.enum(["same-document", "cross-document"]).optional(),
      })
      .strict(),
    effectRegion: z
      .object({
        control: z.string().min(1).optional(),
        controls: z.array(z.string().min(1)),
        commonAncestor: z.string().min(1).optional(),
      })
      .strict(),
    /**
     * Whether the page scrolls: the baseline, then each change (at most 8).
     * `gutter` is the measured innerWidth - clientWidth (0 without layout
     * scrollbars, as in headless capture).
     */
    rootScroll: z
      .array(
        z
          .object({
            time: finite,
            gutter: finite.nonnegative(),
            scrollable: z.boolean(),
            stableGutter: z.boolean(),
            /** What made the page stop scrolling, e.g. `body overflow: hidden`. */
            lockedBy: z.string().min(1).optional(),
            compensation: z.boolean(),
          })
          .strict(),
      )
      .optional(),
    /** Present exactly on `slow-replay` actions. */
    held: heldReplaySchema.optional(),
    failure: failureReplaySchema.optional(),
    visibleChanges: z.array(visibleChangeSchema).optional(),
  })
  .strict()
  .refine(
    (action) => action.status === "ran" || !!action.reason,
    "incomplete timeline requires a reason",
  )
  .refine(
    (action) =>
      (action.source === "slow-replay") === (action.held !== undefined),
    "held facts belong to exactly the slow-replay actions",
  )
  .refine(
    (action) =>
      (action.source === "failure-replay") === (action.failure !== undefined),
    "failure facts belong to exactly the failure-replay actions",
  );
export const actionTimelineArtifactSchema = z
  .object({
    version: z.literal(1),
    status: timelineStatusSchema,
    reason: z.string().min(1).optional(),
    limits: z
      .object({
        frames: z.number().int().positive(),
        elements: z.number().int().positive(),
        changesPerFrame: z.number().int().positive(),
        shifts: z.number().int().positive(),
        mutations: z.number().int().positive(),
        animations: z.number().int().positive(),
        requests: z.number().int().positive(),
        actions: z.number().int().positive(),
        visibleChanges: z.number().int().positive().optional(),
      })
      .strict(),
    /** Actions dropped beyond limits.actions. */
    truncated: z.object({ actions: z.number().int().nonnegative() }).strict(),
    actions: z.array(actionTimelineSchema),
  })
  .strict()
  .refine(
    (artifact) => artifact.status === "ran" || !!artifact.reason,
    "incomplete timeline collection requires a reason",
  )
  .refine(
    (artifact) => artifact.actions.length <= artifact.limits.actions,
    "timeline actions exceed their recorded limit",
  );
export type ActionTimeline = z.infer<typeof actionTimelineSchema>;
export type VisibleChange = z.infer<typeof visibleChangeSchema>;
export type ActionTimelineArtifact = z.infer<
  typeof actionTimelineArtifactSchema
>;

const rgbSchema = z
  .object({
    r: finite.min(0).max(255),
    g: finite.min(0).max(255),
    b: finite.min(0).max(255),
  })
  .strict();
const alphaSchema = finite.min(0).max(1);
const unavailablePaintSchema = z
  .object({ status: z.literal("unavailable"), reason: z.string().min(1) })
  .strict();
const paintColorSchema = z
  .object({ color: rgbSchema, sources: z.array(z.string().min(1)) })
  .strict();
const paintSchema = z
  .object({
    background: z.discriminatedUnion("status", [
      paintColorSchema.extend({ status: z.literal("measured") }),
      unavailablePaintSchema,
    ]),
    surface: z.boolean(),
    primaryAction: z.boolean(),
    text: z
      .discriminatedUnion("status", [
        z
          .object({
            status: z.literal("measured"),
            samples: z
              .array(
                z
                  .object({
                    foreground: rgbSchema,
                    background: rgbSchema,
                    sources: z.array(z.string().min(1)),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
        z.object({ status: z.literal("none") }).strict(),
        unavailablePaintSchema,
      ])
      .optional(),
  })
  .strict();
const pointSchema = z.object({ x: finite, y: finite }).strict();
const edgeBase = {
  side: z.enum(["top", "right", "bottom", "left"]),
  insidePoint: pointSchema,
  outsidePoint: pointSchema,
};
const frameEdgeSchema = z.discriminatedUnion("status", [
  z.object({ ...edgeBase, status: z.literal("offscreen") }).strict(),
  z
    .object({
      ...edgeBase,
      status: z.literal("unavailable"),
      reason: z.string().min(1),
      occluder: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...edgeBase,
      status: z.literal("measured"),
      inside: paintColorSchema,
      surround: paintColorSchema,
      border: z.union([
        z
          .object({
            status: z.literal("measured").optional(),
            width: dimension,
            style: z.string().min(1),
            paint: paintColorSchema.optional(),
            color: rgbSchema,
            alpha: alphaSchema,
          })
          .strict(),
        unavailablePaintSchema
          .extend({ width: dimension, style: z.string().min(1) })
          .strict(),
      ]),
      shadows: z.discriminatedUnion("status", [
        z
          .object({
            status: z.literal("measured"),
            samples: z
              .array(
                paintColorSchema
                  .extend({
                    inset: z.boolean(),
                    distance: dimension,
                    backdrop: rgbSchema,
                  })
                  .strict(),
              )
              .optional(),
            layers: z.array(
              z
                .object({
                  color: rgbSchema,
                  paint: paintColorSchema.optional(),
                  alpha: alphaSchema,
                  extent: finite,
                  inset: z.boolean(),
                  clipped: z.boolean(),
                })
                .strict(),
            ),
          })
          .strict(),
        unavailablePaintSchema,
      ]),
    })
    .strict(),
]);

const explanationTextSchema = z
  .object({
    selector: z.string().min(1),
    text: z.string().trim().min(1),
  })
  .strict();

export const explanationArtifactSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["ran", "partial"]),
    reason: z.string().min(1).optional(),
    records: z.array(
      z
        .object({
          selector: z.string().min(1),
          elapsedMs: z.number().finite().nonnegative().optional(),
          controlId: z.string().min(1).optional(),
          trigger: z.enum(["hover", "focus"]),
          source: z.enum(["probe", "capture"]),
          status: z.enum(["observed", "absent", "unavailable"]),
          reason: z.string().min(1).optional(),
          tooltips: z.array(explanationTextSchema),
        })
        .strict()
        .refine(
          (record) =>
            record.status === "observed"
              ? record.tooltips.length > 0
              : record.tooltips.length === 0,
          "only observed records have nonempty tooltip evidence",
        )
        .refine(
          (record) =>
            record.status !== "unavailable" || record.reason !== undefined,
          "unavailable evidence requires a reason",
        ),
    ),
  })
  .strict()
  .refine(
    (artifact) =>
      artifact.status !== "partial" || artifact.reason !== undefined,
    "partial evidence requires a reason",
  );

const signalsSchema = z
  .object({
    explanation: z
      .object({
        controlId: z.string().min(1).optional(),
        inViewport: z.boolean().optional(),
        nativeDisabled: z.boolean().optional(),
        visibleText: z.string(),
        descriptions: z.array(explanationTextSchema),
      })
      .strict()
      .optional(),
    paint: paintSchema.optional(),
    frameEdges: z.array(frameEdgeSchema).optional(),
    role: z.string(),
    name: z.string(),
    described: z.boolean(),
    title: z.string().optional(),
    href: z.string().optional(),
    controls: z.string().optional(),
    haspopup: z.string().optional(),
    appearance: z.string(),
    cursor: z.string(),
    hasGraphic: z.boolean(),
    renderedContent: z
      .object({
        text: z.boolean(),
        directText: z.boolean(),
        graphic: z.boolean(),
        textEvidence: z
          .discriminatedUnion("status", [
            z
              .object({
                status: z.literal("available"),
                font: z
                  .object({ fontSize: z.string(), fontWeight: z.string() })
                  .strict()
                  .nullable(),
              })
              .strict(),
            z
              .object({
                status: z.literal("unavailable"),
                reason: z.string().min(1),
              })
              .strict(),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    lineCount: z.number().int().min(0),
    textRect: rectSchema.optional(),
    inkCenterY: finite.optional(),
    labelInk: z
      .object({
        text: z.string(),
        lineCount: z.number().int().min(0),
        textRect: rectSchema.optional(),
        inkCenterY: finite.optional(),
        glyph: z.literal(true).optional(),
      })
      .strict()
      .optional(),
    contentBox: rectSchema,
    transition: z.string(),
    animation: z.string(),
    motion: motionStylesSchema.optional(),
    nodeId: z.string().optional(),
    focused: z.boolean(),
    repeatedItem: z.boolean(),
    viewportIntersection: rectSchema.optional(),
    adornment: z
      .discriminatedUnion("status", [
        z
          .object({
            status: z.literal("measured"),
            source: z.literal("background"),
            rect: rectSchema,
          })
          .strict(),
        z.object({ status: z.literal("none") }).strict(),
        z
          .object({
            status: z.literal("unmeasured"),
            reason: z.string().min(1),
          })
          .strict(),
      ])
      .optional(),
    alarm: z
      .object({ context: z.boolean(), iconHint: z.string().optional() })
      .strict()
      .optional(),
    value: z.string().optional(),
  })
  .strict();

const probeCollectionSchema = z
  .object({
    elapsedMs: z.number().finite().nonnegative().optional(),
    selector: z.string().min(1),
    item: z.string().min(1).optional(),
    menus: z.array(
      z
        .object({
          trigger: z.enum(["button", "contextmenu"]),
          name: z.string(),
          items: z.array(z.string()),
        })
        .strict(),
    ),
    reason: z.string().optional(),
  })
  .strict();

const countSchema = z.number().int().nonnegative();
const probeSafetySchema = z
  .object({
    policy: z.literal("third-party"),
    origins: z.array(z.string().min(1)),
    requests: z
      .object({
        sent: z.record(z.string().min(1), countSchema),
        blocked: z.record(z.string().min(1), countSchema),
      })
      .strict(),
    blocked: z
      .object({
        crossOriginNavigation: countSchema,
        formSubmission: countSchema,
        download: countSchema,
        popup: countSchema,
        windowOpen: countSchema,
        beforeunload: countSchema,
        permission: countSchema,
      })
      .strict(),
    skipped: z.object({ destructive: countSchema }).strict(),
  })
  .strict();

const probeSchema = z
  .object({
    safety: probeSafetySchema.optional(),
    failureReplay: z
      .object({
        mode: z.enum(["status", "network"]),
        status: z.number().int().min(400).max(599),
        feedbackWithinMs: z.number().int().positive(),
        queued: countSchema,
        ran: countSchema,
        /** Web-step failure replays copied from the state that ran them. */
        reused: countSchema.optional(),
        completed: z.array(z.string()),
        notes: z.array(z.string()),
      })
      .strict()
      .optional(),
    heldReplay: z
      .object({
        delayMs: z.number().int().positive(),
        queued: countSchema,
        ran: countSchema,
        /** Web-step held replays copied from the state that ran them. */
        reused: countSchema.optional(),
        notes: z.array(z.string()),
      })
      .strict()
      .optional(),
    status: z.enum(["ran", "partial", "timed-out"]),
    selector: z.string().min(1).optional(),
    step: z.string().min(1).optional(),
    reason: z.string().optional(),
    explanations: explanationArtifactSchema.optional(),
    motion: motionArtifactSchema.optional(),
    collections: z.array(probeCollectionSchema).optional(),
    results: z.array(
      z
        .object({
          selector: z.string().min(1),
          name: z.string(),
          effects: z.array(
            z.enum([
              "dom",
              "focus",
              "navigation",
              "dialog",
              "network",
              "popup",
              "clipboard",
              "aria",
              "filechooser",
              "picker",
              "print",
              "download",
            ]),
          ),
          signature: z.string().optional(),
          persistent: z.boolean(),
          repeated: z.boolean().optional(),
          region: z.string().optional(),
          primary: z.boolean().optional(),
          skipped: z.string().optional(),
          elapsedMs: finite.nonnegative().optional(),
          status: z.enum(["completed", "timed-out", "not-reached"]).optional(),
          timeoutScope: z.enum(["control", "state"]).optional(),
          reusedFrom: z.string().min(1).optional(),
          replayRequired: z.boolean().optional(),
          timings: z
            .object({
              clickMs: finite.nonnegative(),
              effectWindowMs: finite.nonnegative(),
              restoreCheckMs: finite.nonnegative(),
              escapeMs: finite.nonnegative(),
              replayMs: finite.nonnegative(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

const componentSchema = z
  .object({
    name: z.string().min(1),
    selector: z.string(),
    width: finite.positive(),
    height: finite.positive(),
    tolerance: z
      .object({
        ratio: finite.min(0),
        px: finite.min(0),
        mode: z.enum(["tighter", "looser"]).optional(),
      })
      .strict(),
    rects: z.array(rectSchema.extend({ selector: z.string().min(1) })),
    inferred: z
      .object({
        source: z.string().min(1),
        words: z.array(z.string().min(1)).min(1),
        axis: z.enum(["width", "height"]).optional(),
        matchedBy: z.literal("modifier").optional(),
      })
      .strict()
      .optional(),
    unresolved: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (component) => component.selector !== "" || component.unresolved === true,
    { message: "selector is required unless the component is unresolved" },
  );

const invariantObservationSchema = z
  .object({
    declaration: invariantSchema,
    origin: invariantOriginSchema,
    selectors: z.array(
      z
        .object({
          selector: z.string().trim().min(1),
          matches: z.array(
            z
              .object({ selector: z.string().min(1), rect: rectSchema })
              .strict(),
          ),
        })
        .strict(),
    ),
    groups: z
      .array(
        z
          .object({
            list: z.string().min(1),
            owner: z
              .object({
                selector: z.string().min(1),
                value: z.string().nullable(),
              })
              .strict()
              .nullable(),
            items: z.array(
              z
                .object({
                  selector: z.string().min(1),
                  label: z.string(),
                  value: z.string().nullable(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .refine(
    ({ declaration, groups }) =>
      isGroupInvariant(declaration) === (groups !== undefined),
    "group evidence must be present exactly for group declarations",
  )
  .refine(({ declaration, selectors }) => {
    const required = invariantSelectors(declaration);
    return (
      selectors.length === required.length &&
      new Set(selectors.map((entry) => entry.selector)).size ===
        required.length &&
      required.every((selector) =>
        selectors.some((entry) => entry.selector === selector),
      )
    );
  }, "selector evidence must cover each authored selector exactly once");

const selectionGroupSchema = z
  .object({
    container: z.string().min(1),
    role: z.string(),
    memberRole: z.string(),
    single: z.boolean(),
    members: z.array(
      z
        .object({
          selector: z.string().min(1),
          control: z.string().min(1),
          selected: z.boolean(),
          source: z.enum([
            "aria-selected",
            "aria-checked",
            "aria-pressed",
            "checked",
          ]),
          nativeIndicator: z.boolean(),
          decoration: z.record(z.string(), z.string()),
          paintedDecoration: z.record(z.string(), z.string()).optional(),
          decorationOwners: z.array(z.string()).optional(),
        })
        .strict(),
    ),
  })
  .strict();

const dialogSchema = z
  .object({
    selector: z.string().min(1),
    modal: z.boolean(),
    labelledBy: z.array(z.string().min(1)),
    submit: z.array(z.string().min(1)),
  })
  .strict();

const overlapKind = z.enum(["interactive", "text"]);

const overlapSchema = z
  .object({
    a: z.string().min(1),
    b: z.string().min(1),
    kinds: z.tuple([overlapKind, overlapKind]),
    rect: rectSchema,
    partial: z.array(z.string().min(1)),
    samples: z.number().int().min(0),
    hits: z.number().int().min(0),
  })
  .strict();

const clippedTextSchema = z
  .object({
    selector: z.string().min(1),
    owner: z.string().min(1),
    axis: z.enum(["x", "y", "both"]),
    overflow: z.object({ x: dimension, y: dimension }).strict(),
    lines: z.number().int().min(0),
    visibleLines: z.number().int().min(0),
    cut: z.enum(["mid-word", "word-boundary", "sliced-line", "hidden-lines"]),
    visibleText: z.string().max(80),
    text: z.string().max(160),
  })
  .strict();

const fieldGroupSchema = z
  .object({
    container: z.string().min(1),
    region: z.string().min(1),
    members: z.array(
      z
        .object({
          selector: z.string().min(1),
          role: z.enum(["label", "control", "helper"]),
          rect: rectSchema,
        })
        .strict(),
    ),
  })
  .strict();

const emptyRegionsSchema = z
  .object({
    configured: z.array(
      z
        .object({
          selector: z.string().min(1),
          matched: z.number().int().min(0),
        })
        .strict(),
    ),
    auto: z.boolean(),
    regions: z.array(
      z
        .object({
          selector: z.string().min(1),
          source: z.enum(["configured", "list", "table", "feed"]),
          configured: z.string().min(1).optional(),
          rect: rectSchema,
          scope: z.enum(["region", "adjacent"]),
          cta: z.array(z.string().min(1)).max(5),
          text: z.string().max(160),
        })
        .strict(),
    ),
  })
  .strict();

const mediaBandSchema = z
  .object({ depth: finite.min(0).max(1), color: rgbSchema })
  .strict()
  .nullable();
const mediaFrameSchema = z
  .object({
    selector: z.string().min(1),
    kind: z.enum(["img", "iframe", "video", "canvas"]),
    frame: rectSchema,
    group: z.string().min(1),
    backdrop: z.array(rgbSchema).min(1).max(2),
    loaded: z.boolean(),
    bands: z
      .discriminatedUnion("status", [
        z
          .object({
            status: z.literal("measured"),
            top: mediaBandSchema,
            bottom: mediaBandSchema,
            left: mediaBandSchema,
            right: mediaBandSchema,
            blank: z.boolean(),
          })
          .strict(),
        z
          .object({ status: z.literal("unavailable"), reason: z.string() })
          .strict(),
      ])
      .optional(),
  })
  .strict();
const collectionSchema = z
  .object({
    selector: z.string().min(1),
    matched: z.number().int().min(0),
    invalid: z.literal(true).optional(),
    items: z.array(
      z
        .object({
          selector: z.string().min(1),
          rect: rectSchema,
          open: z.boolean(),
          controls: z.array(z.string()).max(30),
          menuTriggers: z.array(
            z
              .object({ selector: z.string().min(1), name: z.string() })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

const progressArtifactSchema = z
  .object({
    version: z.literal(1),
    withinMs: z.number().int().positive(),
    steps: z.array(
      z
        .object({
          stepIndex: z.number().int().positive(),
          action: z.enum(["click", "fill", "press", "select"]),
          selector: z.string().min(1),
          status: z.enum(["ran", "unavailable"]),
          reason: z.string().optional(),
          firstMs: dimension.nullable(),
          affordance: z
            .object({
              kind: z.enum([
                "progressbar",
                "busy",
                "spinner",
                "status-text",
                "control-text",
                "progress-text",
              ]),
              selector: z.string().min(1),
              text: z.string().max(80).optional(),
            })
            .strict()
            .optional(),
          observedMs: dimension,
          settledMs: dimension.optional(),
        })
        .strict(),
    ),
  })
  .strict();

const styleSourceSchema = z
  .object({
    sheet: z.string(),
    selector: z.string(),
    tokens: z.array(z.string()).optional(),
    unresolved: z.array(z.string()).optional(),
  })
  .strict();

const elementV2Schema = elementSchema.extend({
  styleSources: z.record(z.string(), styleSourceSchema).optional(),
  signals: signalsSchema.optional(),
  structuralPath: z.string().min(1),
  legacyRenderedPath: z.string().min(1).optional(),
  directText: z.string(),
  attributes: z.record(z.string(), z.string()),
  temporal: z.boolean(),
  stableIslandPath: z.string().min(1),
  relativeRect: rectSchema,
  styles: expandedStylesSchema,
});

const headingSchema = z
  .object({
    selector: z.string().min(1),
    level: z.number().int().min(1).max(6),
    text: z.string(),
    axeTargets: z.array(z.string()).optional(),
  })
  .strict();

const tokenSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-configured") }).strict(),
  z
    .object({
      status: z.literal("configured"),
      source: z.string().min(1),
      declarations: z
        .record(z.string(), z.string())
        .refine((value) => Object.keys(value).length > 0),
      normalizedValues: z.array(z.string()),
      typedValues: z
        .array(
          z
            .object({
              kind: z.enum([
                "color",
                "radius",
                "spacing",
                "control-height",
                "other",
              ]),
              value: z.string(),
              name: z.string().optional(),
              theme: z.string().optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
]);

const observationCommon = {
  viewport: z
    .object({ width: finite.positive(), height: finite.positive() })
    .strict(),
  document: z
    .object({
      contentType: z.string().trim().min(1).optional(),
      scrollWidth: dimension,
      scrollHeight: dimension,
      clientWidth: dimension,
      clientHeight: dimension,
    })
    .strict(),
  headings: z.array(headingSchema),
  tokens: tokenSchema,
};

const observationArtifactV1Schema = z
  .object({
    version: z.literal(1),
    ...observationCommon,
    elements: z.array(elementSchema),
  })
  .strict();

const identifier = z.string().trim().min(1);
const offset = z.number().int().nonnegative();
const bandEdgeSchema = z
  .object({
    selector: identifier,
    rect: rectSchema,
    fullBleedMedia: z.boolean(),
    content: z
      .object({
        left: finite,
        right: finite,
        selectors: z.array(identifier).min(1),
      })
      .strict()
      .refine((v) => v.right >= v.left, "content edges must be ordered")
      .nullable(),
  })
  .strict();
const wordFragmentSchema = z
  .object({
    selector: identifier,
    node: offset,
    start: offset,
    end: offset,
    text: z.string().min(1).max(160),
    rect: rectSchema,
  })
  .strict()
  .refine(
    (v) => v.end > v.start && v.end - v.start === v.text.length,
    "fragment offsets must match text",
  );
const wordBreakSchema = z
  .object({
    selector: identifier,
    word: z.string().min(1).max(160),
    text: z.string().max(160),
    start: offset,
    end: offset,
    before: wordFragmentSchema,
    after: wordFragmentSchema,
  })
  .strict()
  .refine(
    (v) => v.end > v.start && v.end - v.start === v.word.length,
    "word offsets must match text",
  );
const geometryScan = <T extends z.ZodType>(record: T) =>
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("ran"), records: z.array(record) }).strict(),
    z
      .object({
        status: z.enum(["partial", "unavailable"]),
        reason: identifier,
        records: z.array(record),
      })
      .strict(),
  ]);
const failedRequestSchema = z
  .object({ url: z.string(), reason: z.string() })
  .strict();
const fontObservationSchema = z
  .object({
    status: z.enum(["ran", "unavailable"]),
    reason: z.string().optional(),
    faces: z.array(
      z
        .object({
          family: z.string(),
          status: z.enum(["unloaded", "loading", "loaded", "error"]),
          weight: z.string(),
          style: z.string(),
          urls: z.array(z.string()),
        })
        .strict(),
    ),
    used: z.array(
      z
        .object({
          family: z.string(),
          selectors: z.array(identifier).max(5),
          fallback: z.boolean(),
        })
        .strict(),
    ),
    failedRequests: z.array(failedRequestSchema),
  })
  .strict();
const linkResultSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("ok"), code: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      status: z.literal("broken"),
      code: z.number().int().nonnegative().nullable(),
      reason: z.string(),
    })
    .strict(),
  z.object({ status: z.literal("unchecked"), reason: z.string() }).strict(),
]);
const linkSchema = z
  .object({
    selector: identifier,
    text: z.string().max(80),
    href: z.string().min(1),
    sameOrigin: z.boolean(),
    result: linkResultSchema.optional(),
  })
  .strict();
const focusVisibleSchema = z
  .object({
    elapsedMs: z.number().finite().nonnegative().optional(),
    selector: identifier,
    name: z.string(),
    rect: rectSchema,
    changed: z.array(z.string()),
    proxy: identifier.optional(),
  })
  .strict();
const lineLengthSchema = z
  .object({
    selector: identifier,
    chars: z.number().nonnegative(),
    width: z.number().nonnegative(),
    charWidth: z.number().positive(),
    lines: z.number().int().nonnegative(),
    text: z.string().max(160),
  })
  .strict();
const orphanWordSchema = z
  .object({
    selector: identifier,
    word: z.string().min(1),
    lines: z.number().int().min(2),
    text: z.string().max(160),
    rect: rectSchema.optional(),
    lastLine: rectSchema.optional(),
    ink: z
      .discriminatedUnion("status", [
        z
          .object({
            status: z.literal("measured"),
            share: z.number().min(0).max(1),
          })
          .strict(),
        z
          .object({ status: z.literal("unavailable"), reason: z.string() })
          .strict(),
      ])
      .optional(),
  })
  .strict();
const imageRenderSchema = z
  .object({
    selector: identifier,
    src: z.string().max(200),
    naturalWidth: z.number().nonnegative(),
    naturalHeight: z.number().nonnegative(),
    rendered: rectSchema,
    objectFit: z.string(),
    distortion: z.number().nonnegative(),
    broken: z.boolean(),
  })
  .strict();
const layoutShiftSchema = z
  .object({
    elapsedMs: z.number().finite().nonnegative().optional(),
    status: z.enum(["ran", "unavailable"]),
    reason: z.string().optional(),
    score: z.number().nonnegative(),
    entries: z
      .array(
        z
          .object({
            value: z.number().nonnegative(),
            startTime: z.number(),
            sources: z.array(identifier),
          })
          .strict(),
      )
      .max(150),
  })
  .strict();
const visibilityGeometrySchema = z
  .object({
    rect: rectSchema,
    client: rectSchema,
    visible: rectSchema,
    rendered: z.boolean(),
    reason: z.string().optional(),
    boundary: z.string().optional(),
  })
  .strict();
const shellVisibilitySchema = z
  .object({
    shell: z.discriminatedUnion("status", [
      z.object({ status: z.literal("not-configured") }).strict(),
      z
        .object({
          status: z.enum(["missing", "ambiguous", "invalid"]),
          selector: z.string().min(1),
          count: z.number().int().nonnegative(),
        })
        .strict(),
      z
        .object({
          status: z.literal("measured"),
          selector: z.string().min(1),
          rect: rectSchema,
          client: rectSchema,
          viewport: rectSchema,
          scrollHeight: dimension,
          clientHeight: dimension,
          extending: z.array(
            z
              .object({
                selector: z.string().min(1),
                rect: rectSchema,
                description: z.string().optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    ]),
    overlays: z.array(
      z
        .object({
          selector: z.string().min(1),
          status: z.enum(["measured", "invalid"]),
          matches: z.array(
            visibilityGeometrySchema.extend({
              selector: z.string().min(1),
              ancestors: z.array(z.string()),
            }),
          ),
        })
        .strict(),
    ),
  })
  .strict();

const sizeSchema = z.object({ width: dimension, height: dimension }).strict();

const screenshotGeometrySchema = z
  .object({
    strategy: z.enum(["viewport", "full-page", "tiled"]),
    scale: finite.positive(),
    width: dimension,
    height: dimension,
    tiles: z.number().int().positive().optional(),
    drift: z
      .object({ observed: sizeSchema, captured: sizeSchema })
      .strict()
      .optional(),
    rects: z.record(z.string().min(1), rectSchema).optional(),
  })
  .strict()
  .refine(
    (value) => value.tiles === undefined || value.strategy === "tiled",
    "tiles are recorded only for tiled screenshots",
  )
  .refine(
    (value) => value.rects === undefined || value.drift !== undefined,
    "screenshot rects are recorded only when layout drifted",
  );

const observationArtifactV2Schema = z
  .object({
    version: z.literal(2),
    rootFontSize: finite.positive().optional(),
    theme: z.string().optional(),
    ...observationCommon,
    input: z
      .object({
        pointer: z.enum(["fine", "coarse", "none"]),
        hover: z.enum(["hover", "none"]),
        maxTouchPoints: z.number().int().min(0),
      })
      .strict()
      .optional(),
    elements: z.array(elementV2Schema),
    maskMembership: z.array(
      z
        .object({
          selector: z.string(),
          paths: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    components: z.array(componentSchema).optional(),
    invariants: z.array(invariantObservationSchema).optional(),
    shellVisibility: shellVisibilitySchema.optional(),
    probe: probeSchema.optional(),
    explanations: explanationArtifactSchema.optional(),
    motion: motionArtifactSchema.optional(),
    selectionGroups: z.array(selectionGroupSchema).optional(),
    dialogs: z.array(dialogSchema).optional(),
    fresh: z.boolean().optional(),
    selectorMarks: z
      .array(
        z
          .object({
            purpose: z.enum([
              "history",
              "unsaved",
              "disguised-ignore",
              "mirrored",
              "primary-action",
              "luminance-ignore",
              "frame",
              "scale-control",
              "scale-card",
              "scale-panel",
              "scale-chip",
              "scale-divider",
              "primary-region",
              "alarm-ignore",
              "naming",
              "cta",
              "adjacent-region",
              "sibling-region",
            ]),
            selector: z.string().min(1),
            matches: z.array(z.string().min(1)),
            invalid: z.literal(true).optional(),
          })
          .strict(),
      )
      .optional(),
    overlaps: z.array(overlapSchema).optional(),
    clippedText: z.array(clippedTextSchema).optional(),
    bandEdges: geometryScan(bandEdgeSchema).optional(),
    wordBreaks: geometryScan(wordBreakSchema).optional(),
    fieldGroups: z.array(fieldGroupSchema).optional(),
    images: z
      .array(
        z
          .object({
            selector: z.string().min(1),
            src: z.string(),
            currentSrc: z.string(),
            complete: z.boolean(),
            naturalWidth: z.number().nonnegative(),
            naturalHeight: z.number().nonnegative(),
            visible: z.boolean(),
          })
          .strict(),
      )
      .optional(),
    failedImageRequests: z
      .array(z.object({ url: z.string(), reason: z.string() }).strict())
      .optional(),
    emptyRegions: emptyRegionsSchema.optional(),
    progress: progressArtifactSchema.optional(),
    touchReachability: touchReachabilityArtifactSchema.optional(),
    liveness: livenessArtifactSchema.optional(),
    mediaFrames: z.array(mediaFrameSchema).optional(),
    mediaFill: z
      .object({ tolerance: z.number().int().min(0).max(64) })
      .strict()
      .optional(),
    collections: z.array(collectionSchema).optional(),
    fonts: fontObservationSchema.optional(),
    links: geometryScan(linkSchema).optional(),
    focusVisible: geometryScan(focusVisibleSchema).optional(),
    lineLengths: geometryScan(lineLengthSchema).optional(),
    orphanWords: geometryScan(orphanWordSchema).optional(),
    imageRenders: geometryScan(imageRenderSchema).optional(),
    layoutShift: layoutShiftSchema.optional(),
    screenshot: screenshotGeometrySchema.optional(),
  })
  .strict();

export const observationArtifactSchema = z.discriminatedUnion("version", [
  observationArtifactV1Schema,
  observationArtifactV2Schema,
]);
