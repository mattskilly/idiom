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
    const result = ran(this.id, candidates);
    if (examined > 0)
      result.coverage = {
        ...result.coverage,
        reason: `${examined} nested frame${examined === 1 ? "" : "s"} examined`,
      };
    return gate.result(result);
  },
};
