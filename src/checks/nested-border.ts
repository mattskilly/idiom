import { defaultChecksSettings } from "../schemas/project.js";
import { paintedGate } from "./painted.js";
import {
  isPainted,
  isVisuallyHidden,
  px,
  ran,
  round,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  ObservedElementV2,
} from "./types.js";

/** The widest gap between two frames that still reads as one doubled edge. */
export const MAX_INSET_PX = 4;
const RADIUS_TOLERANCE_PX = 1;
const RULE = "idiom:nested-border";

const sides = ["Top", "Right", "Bottom", "Left"] as const;
const corners = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
] as const;

type Frame = {
  widths: [number, number, number, number];
  /** Top style, "mixed" when sides differ; undefined in captures without styles. */
  style: string | undefined;
  /** Effective corner radii, clamped so pills of any authored size compare equal. */
  radii: [number, number, number, number];
};

function cornerRadius(value: string, element: ObservedElementV2): number {
  const first = value.trim().split(/\s+/)[0] ?? "";
  const short = Math.min(element.rect.width, element.rect.height);
  const raw = first.endsWith("%") ? (px(first) / 100) * short : px(first);
  return Math.max(0, Math.min(raw, short / 2));
}

/** The element's border when all four sides are visible. */
export function frame(element: ObservedElementV2): Frame | undefined {
  const styles = element.styles;
  const widths = sides.map((side) => px(styles[`border${side}Width`]));
  const styleOf = sides.map((side) => styles[`border${side}Style`]);
  const visible = sides.every(
    (side, index) =>
      (widths[index] ?? 0) > 0 &&
      isPainted(styles[`border${side}Color`]) &&
      !["none", "hidden"].includes(styleOf[index] ?? ""),
  );
  if (!visible) return undefined;
  const known = styleOf.every((style) => style !== undefined);
  return {
    widths: widths as Frame["widths"],
    style: !known
      ? undefined
      : new Set(styleOf).size === 1
        ? styleOf[0]
        : "mixed",
    radii: corners.map((corner) =>
      cornerRadius(styles[corner], element),
    ) as Frame["radii"],
  };
}

const hasVisibleBorderSide = (element: ObservedElementV2) =>
  sides.some(
    (side) =>
      px(element.styles[`border${side}Width`]) > 0 &&
      isPainted(element.styles[`border${side}Color`]) &&
      !["none", "hidden"].includes(element.styles[`border${side}Style`] ?? ""),
  );

/** Anything that would put visible paint between or beside the two frames. */
export function paints(element: ObservedElementV2): boolean {
  const shadow = element.styles.boxShadow?.trim() ?? "";
  return (
    isPainted(element.styles.backgroundColor) ||
    hasVisibleBorderSide(element) ||
    (shadow !== "" && shadow !== "none") ||
    element.directText.trim() !== ""
  );
}

/** Per-side gap from outer's border inner edge to inner's border outer edge. */
function insets(
  outer: ObservedElementV2,
  outerFrame: Frame,
  inner: ObservedElementV2,
) {
  const o = outer.rect;
  const i = inner.rect;
  const [top, right, bottom, left] = outerFrame.widths;
  return {
    top: round(i.y - (o.y + top)),
    right: round(o.x + o.width - right - (i.x + i.width)),
    bottom: round(o.y + o.height - bottom - (i.y + i.height)),
    left: round(i.x - (o.x + left)),
  };
}

const hugs = (gaps: ReturnType<typeof insets>) =>
  Object.values(gaps).every((gap) => gap >= -0.5 && gap <= MAX_INSET_PX);

const isPill = (element: ObservedElementV2, value: Frame) =>
  value.radii.every(
    (r) =>
      r >=
      Math.min(element.rect.width, element.rect.height) / 2 -
        RADIUS_TOLERANCE_PX,
  );

/**
 * Corners match when equal, when the inner corner is concentric with the
 * outer one (outer radius less the gap between them), or when both are pills.
 */
function radiiMatch(
  outer: ObservedElementV2,
  outerFrame: Frame,
  inner: ObservedElementV2,
  innerFrame: Frame,
  gaps: ReturnType<typeof insets>,
): boolean {
  if (isPill(outer, outerFrame) && isPill(inner, innerFrame)) return true;
  const [top, right, bottom, left] = outerFrame.widths;
  const offsets = [
    Math.max(gaps.top + top, gaps.left + left),
    Math.max(gaps.top + top, gaps.right + right),
    Math.max(gaps.bottom + bottom, gaps.right + right),
    Math.max(gaps.bottom + bottom, gaps.left + left),
  ];
  return outerFrame.radii.every((radius, corner) => {
    const own = innerFrame.radii[corner] ?? 0;
    const concentric = Math.max(0, radius - (offsets[corner] ?? 0));
    return (
      Math.abs(radius - own) <= RADIUS_TOLERANCE_PX ||
      Math.abs(concentric - own) <= RADIUS_TOLERANCE_PX
    );
  });
}

function describe(element: ObservedElementV2, value: Frame): string {
  const pill = isPill(element, value);
  const max = Math.max(...value.radii);
  const shape = pill
    ? "pill"
    : max <= 0.5
      ? "square"
      : `${round(max)}px-radius`;
  return value.style === undefined || value.style === "solid"
    ? shape
    : `${shape} ${value.style}`;
}

const focusSourced = (element: ObservedElementV2) =>
  sides.some((side) =>
    element.styleSources?.[`border${side}Color`]?.selector.includes(":focus"),
  );

/** Same pattern observe.ts uses for a selection outline's ownerState; keep in step. */
const selectedClass = /(?:^|[-_:])(?:selected|active|current)(?:$|[-_])/i;

/** What marks the element selected (`aria-pressed`, `class:is-selected`), if anything. */
export function selectionMarker(
  element: ObservedElementV2,
): string | undefined {
  const attributes = element.attributes ?? {};
  for (const name of ["aria-selected", "aria-checked", "aria-pressed"])
    if (attributes[name] === "true") return name;
  if (attributes.checked !== undefined) return "checked";
  const token = (attributes.class ?? "")
    .split(/\s+/)
    .find((value) => value !== "" && selectedClass.test(value));
  return token === undefined ? undefined : `class:${token}`;
}

const mediaTags = new Set(["img", "picture", "video", "canvas", "svg"]);
const isMedia = (element: ObservedElementV2) =>
  mediaTags.has(element.tag) || element.attributes?.role === "img";

/** A framed media element, or a framed text-less wrapper around one. */
function isMediaRing(
  element: ObservedElementV2,
  elements: readonly ObservedElementV2[],
): boolean {
  if (frame(element) === undefined) return false;
  if (isMedia(element)) return true;
  if (element.directText.trim() !== "") return false;
  return elements.some(
    (other) =>
      other.ancestorSelectors.includes(element.selector) && isMedia(other),
  );
}

const contains = (outer: ObservedElementV2, inner: ObservedElementV2) =>
  inner.rect.x >= outer.rect.x - 0.5 &&
  inner.rect.y >= outer.rect.y - 0.5 &&
  inner.rect.x + inner.rect.width <= outer.rect.x + outer.rect.width + 0.5 &&
  inner.rect.y + inner.rect.height <= outer.rect.y + outer.rect.height + 0.5;

export const nestedBorderCheck: DeterministicCheck = {
  id: "nested-border",
  run({ tuple, config }) {
    const settings = config.nestedBorder ?? defaultChecksSettings.nestedBorder;
    if (!settings.enabled) return skipped(this.id, "nestedBorder");
    const observation = v2Observations(tuple);
    if (observation === undefined)
      return unavailable(
        this.id,
        "nested borders need v2 observations (recapture with this version)",
      );
    const gate = paintedGate(tuple, [RULE]);
    const index = new Map<string, ObservedElementV2>();
    for (const element of observation.elements)
      if (
        element.visible &&
        !isVisuallyHidden(element) &&
        !["html", "body"].includes(element.tag) &&
        element.rect.width >= 4 &&
        element.rect.height >= 4 &&
        gate.allows(RULE, element)
      )
        index.set(element.selector, element);
    const elements = [...index.values()];
    const candidates: FindingCandidate[] = [];
    const seen = new Set<string>();
    let examined = 0;
    for (const inner of elements) {
      const innerFrame = frame(inner);
      if (!innerFrame) continue;
      const outer = inner.ancestorSelectors
        .map((selector) => index.get(selector))
        .find((ancestor) => ancestor !== undefined && paints(ancestor));
      if (outer === undefined) continue;
      const outerFrame = frame(outer);
      if (!outerFrame) continue;
      const gaps = insets(outer, outerFrame, inner);
      if (!hugs(gaps)) continue;
      examined += 1;
      if (outer.directText.trim() !== "") continue;
      if (focusSourced(outer) || focusSourced(inner)) continue;
      const crowded = elements.some(
        (other) =>
          other !== inner &&
          other.ancestorSelectors.includes(outer.selector) &&
          !other.ancestorSelectors.includes(inner.selector) &&
          paints(other),
      );
      if (crowded) continue;
      const radiusDiffers = !radiiMatch(
        outer,
        outerFrame,
        inner,
        innerFrame,
        gaps,
      );
      const styleDiffers =
        outerFrame.style !== undefined &&
        innerFrame.style !== undefined &&
        outerFrame.style !== innerFrame.style;
      if (!radiusDiffers && !styleDiffers) continue;
      const fingerprint = `nested-border:${outer.selector}|${inner.selector}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const maxInset = Math.max(0, ...Object.values(gaps));
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: outer.selector,
        fingerprintHint: fingerprint,
        explanation: `${inner.selector} draws its own ${describe(inner, innerFrame)} border ${maxInset}px inside ${outer.selector}'s ${describe(outer, outerFrame)} border, so the edge reads doubled and mismatched.`,
        acceptance: [
          `Only one of ${outer.selector} and ${inner.selector} draws a border, or both share the same radius and style.`,
        ],
        verification: verify(this.id, {
          selectors: [outer.selector, inner.selector],
          insets: gaps,
          outerRadii: outerFrame.radii.map((r) => round(r)),
          innerRadii: innerFrame.radii.map((r) => round(r)),
          ...(outerFrame.style === undefined
            ? {}
            : { outerStyle: outerFrame.style }),
          ...(innerFrame.style === undefined
            ? {}
            : { innerStyle: innerFrame.style }),
        }),
      });
    }
    // A selected choice whose selection border rings a bordered photo or
    // icon: two concentric rings however far apart and whatever their shapes.
    for (const outer of elements) {
      const marker = selectionMarker(outer);
      if (marker === undefined) continue;
      const outerFrame = frame(outer);
      if (!outerFrame) continue;
      const rings = elements.filter(
        (other) =>
          other !== outer &&
          other.ancestorSelectors.includes(outer.selector) &&
          isMediaRing(other, elements),
      );
      const outermost = rings.filter(
        (ring) =>
          !rings.some(
            (other) =>
              other !== ring && ring.ancestorSelectors.includes(other.selector),
          ),
      );
      if (outermost.length !== 1) continue;
      const inner = outermost[0] as ObservedElementV2;
      const innerFrame = frame(inner);
      if (!innerFrame) continue;
      if (!contains(outer, inner)) continue;
      examined += 1;
      if (focusSourced(outer) || focusSourced(inner)) continue;
      const fingerprint = `nested-border:${outer.selector}|${inner.selector}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: outer.selector,
        fingerprintHint: fingerprint,
        explanation: `${outer.selector} is selected (${marker}) and draws its ${describe(outer, outerFrame)} selection border around ${inner.selector}, which draws its own ${describe(inner, innerFrame)} border, so the choice shows two rings.`,
        acceptance: [
          `While ${outer.selector} is selected, only one of ${outer.selector} and ${inner.selector} draws a ring.`,
        ],
        verification: verify(this.id, {
          selectors: [outer.selector, inner.selector],
          marker,
          insets: insets(outer, outerFrame, inner),
          outerRadii: outerFrame.radii.map((r) => round(r)),
          innerRadii: innerFrame.radii.map((r) => round(r)),
        }),
      });
    }
    const result = ran(this.id, candidates);
    if (examined > 0)
      result.coverage = {
        ...result.coverage,
        reason: `${examined} nested frame${examined === 1 ? "" : "s"} examined`,
      };
    return gate.result(result);
  },
};
