import {
  contrastRatio,
  effectiveBackground,
  isBounded,
  isVisuallyHidden,
  parseColor,
  px,
  relation,
  round,
} from "../checks/shared.js";
import type { CheckTuple, ObservedElementV2, Rect } from "../checks/types.js";
import { tupleLabel } from "../critique/context.js";
import type { GeometryRow, SurfaceGeometry } from "../critique/types.js";

/** Rows per screenshot; the prompt says how many were left out. */
export const MAX_GEOMETRY_ROWS = 60;
const SMALL_GRAPHIC = 48;
const NAME_LIMIT = 40;

const truncate = (value: string) =>
  value.length > NAME_LIMIT ? `${value.slice(0, NAME_LIMIT - 1)}…` : value;

const size = (rect: Rect) => `${round(rect.width)}×${round(rect.height)}`;

function radius(element: ObservedElementV2): string {
  const { styles, rect } = element;
  const values = [
    styles.borderTopLeftRadius,
    styles.borderTopRightRadius,
    styles.borderBottomRightRadius,
    styles.borderBottomLeftRadius,
  ].map(px);
  const half = Math.min(rect.width, rect.height) / 2;
  const labels = values.map((value) =>
    value <= 0 ? "0" : half > 0 && value >= half ? "full" : `${round(value)}px`,
  );
  return new Set(labels).size === 1 ? (labels[0] ?? "0") : "mixed";
}

function contrast(
  element: ObservedElementV2,
  bySelector: ReadonlyMap<string, ObservedElementV2>,
): number | undefined {
  const text = element.signals?.paint?.text;
  if (text?.status === "measured" && text.samples.length > 0)
    return round(
      Math.min(
        ...text.samples.map((sample) =>
          contrastRatio(sample.foreground, sample.background),
        ),
      ),
      2,
    );
  if (element.directText.trim() === "") return undefined;
  const foreground = parseColor(element.styles.color);
  if (foreground === undefined || foreground.a < 0.05) return undefined;
  return round(
    contrastRatio(foreground, effectiveBackground(element, bySelector)),
    2,
  );
}

function selected(element: ObservedElementV2): boolean {
  if (!element.visible || isVisuallyHidden(element)) return false;
  if (element.rect.width <= 0 || element.rect.height <= 0) return false;
  if (element.interactive) return true;
  const small =
    element.rect.width <= SMALL_GRAPHIC && element.rect.height <= SMALL_GRAPHIC;
  // Dots, badges and swatches: small painted marks with no text of their own.
  if (small && element.text.trim() === "" && isBounded(element)) return true;
  const signals = element.signals;
  if (signals === undefined) return false;
  return signals.repeatedItem || (signals.hasGraphic && small);
}

/**
 * The measured geometry of one captured screenshot: heights, widths, radii,
 * gaps and contrast for the elements a design sweep cares about, so the model
 * compares numbers instead of estimating pixels. Undefined observations or
 * pre-signal captures report why instead of an empty table.
 */
export function surfaceGeometry(tuple: CheckTuple): SurfaceGeometry {
  const base = {
    label: tupleLabel(tuple),
    state: tuple.state,
    viewport: tuple.viewport,
    ...(tuple.colorSchemeAxis ? { colorScheme: tuple.colorScheme } : {}),
  };
  const observation = tuple.observations;
  if (observation === undefined)
    return {
      ...base,
      unavailable: "observations.json is unavailable",
      rows: [],
      omittedRows: 0,
      components: [],
    };
  if (observation.version !== 2)
    return {
      ...base,
      unavailable: "observations predate element signals (recapture)",
      rows: [],
      omittedRows: 0,
      components: [],
    };
  const bySelector = new Map(
    observation.elements.map((element) => [element.selector, element]),
  );
  const chosen = observation.elements
    .filter(selected)
    .sort(
      (left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x,
    );
  const kept = chosen.slice(0, MAX_GEOMETRY_ROWS);
  const rows = kept.map((element): GeometryRow => {
    let nearest: GeometryRow["gapToNearest"];
    for (const other of kept) {
      if (other === element) continue;
      const facing = relation(element.rect, other.rect);
      if (facing === undefined || facing.gap < 0) continue;
      if (nearest === undefined || facing.gap < nearest.px)
        nearest = {
          px: round(facing.gap),
          neighbour: other.selector,
          axis: facing.axis,
        };
    }
    const measured = contrast(element, bySelector);
    const name = (
      element.signals?.name ||
      element.signals?.title ||
      element.attributes.title ||
      element.text
    ).trim();
    const classes = (element.attributes.class ?? "")
      .trim()
      .split(/\s+/)
      .join(" ");
    return {
      selector: element.selector,
      ...(classes === "" ? {} : { class: truncate(classes) }),
      role: element.signals?.role ?? element.tag,
      name: truncate(name),
      size: size(element.rect),
      radius: radius(element),
      ...(nearest === undefined ? {} : { gapToNearest: nearest }),
      ...(measured === undefined ? {} : { contrast: measured }),
    };
  });
  return {
    ...base,
    rows,
    omittedRows: chosen.length - kept.length,
    components: (observation.components ?? []).map((component) => ({
      name: component.name,
      selector: component.selector,
      expected: `${component.width}×${component.height}`,
      rendered: component.rects.map(size),
    })),
  };
}
