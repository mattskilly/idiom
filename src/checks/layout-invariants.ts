import { createHash } from "node:crypto";
import {
  type EffectiveInvariant,
  type InvariantEdge,
  type InvariantShare,
  invariantLabel,
  isGroupInvariant,
  type LayoutInvariant,
  parseInvariantEdge,
} from "../schemas/invariant.js";
import { ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate, Rect } from "./types.js";

/** Declaration identity excludes measurements, tuple coordinates and array position. */
function identity(
  d: LayoutInvariant,
  origin: EffectiveInvariant["origin"],
): string {
  const canonical = {
    scope: origin.scope,
    id: origin.id,
    name: d.name ?? null,
    optional: d.optional,
    tolerance: d.tolerance,
    ...("share" in d
      ? { share: d.share, selector: d.selector, within: d.within ?? null }
      : "selector" in d
        ? {
            selector: d.selector,
            width: d.width ?? null,
            height: d.height ?? null,
          }
        : "align" in d
          ? { align: d.align, selectors: [...d.selectors].sort() }
          : { edge: d.edge, equals: d.equals, offset: d.offset }),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 20);
}
function shareValue(rect: Rect, share: InvariantShare): number {
  return share === "width" || share === "height"
    ? rect[share]
    : edgeValue(rect, share);
}
const contains = (outer: Rect, inner: Rect) => {
  const x = inner.x + inner.width / 2;
  const y = inner.y + inner.height / 2;
  return (
    x >= outer.x &&
    x <= outer.x + outer.width &&
    y >= outer.y &&
    y <= outer.y + outer.height
  );
};
function innermost<T extends { rect: Rect }>(
  containers: T[],
  rect: Rect,
): T | undefined {
  let best: T | undefined;
  for (const container of containers)
    if (
      contains(container.rect, rect) &&
      (best === undefined ||
        container.rect.width * container.rect.height <
          best.rect.width * best.rect.height)
    )
      best = container;
  return best;
}
function edgeValue(rect: Rect, side: InvariantEdge): number {
  switch (side) {
    case "top":
      return rect.y;
    case "right":
      return rect.x + rect.width;
    case "bottom":
      return rect.y + rect.height;
    case "left":
      return rect.x;
  }
}
// Keep comparison geometry unrounded; preserve fractional CSS pixels in diagnostics.
const number = (value: number) => String(Number(value.toFixed(6)));

export const layoutInvariantsCheck: DeterministicCheck = {
  id: "layout-invariants",
  run({ tuple }) {
    const observations = tuple.observations;
    if (observations?.version !== 2 || observations.invariants === undefined)
      return unavailable(
        this.id,
        "layout invariant evidence is unavailable; recapture to measure declared invariants",
      );
    const candidates: FindingCandidate[] = [];
    for (const assertion of observations.invariants) {
      const { declaration: d, selectors } = assertion;
      // Grouping is judged by the group-invariants check.
      if (isGroupInvariant(d)) continue;
      const label = invariantLabel(assertion);
      const key = identity(d, assertion.origin);
      const emit = (
        suffix: string,
        explanation: string,
        selector: string,
        neighbour?: string,
        measured?: unknown,
        selectorHint = selector,
      ) => {
        candidates.push({
          category: this.id,
          severity: "major",
          rule: `idiom:layout-invariants:${suffix}:${key}`,
          selectorHint,
          explanation,
          acceptance: [
            `Satisfy ${label}: ${JSON.stringify(d)} (CSS pixels, tolerance ${d.tolerance}).`,
          ],
          verification: verify(this.id, {
            selector,
            ...(neighbour === undefined ? {} : { neighbour }),
            invariant: d,
            origin: assertion.origin,
            measured,
          }),
        });
      };
      const missing = selectors
        .filter(({ matches }) => matches.length === 0)
        .sort((a, b) => a.selector.localeCompare(b.selector));
      if (missing.length > 0) {
        if (!d.optional)
          emit(
            "missing-selector",
            `${label}: required selector${missing.length > 1 ? "s" : ""} matched no elements: ${missing.map(({ selector }) => selector).join(", ")}`,
            missing[0]?.selector ?? "document",
          );
        continue;
      }
      if ("share" in d) {
        const members = (
          selectors.find(({ selector }) => selector === d.selector)?.matches ??
          []
        ).filter(({ rect }) => rect.width > 0 && rect.height > 0);
        // With `within`, each member joins the innermost container holding
        // its centre; members outside every container are not compared.
        const containers = (
          d.within === undefined
            ? []
            : (selectors.find(({ selector }) => selector === d.within)
                ?.matches ?? [])
        ).filter(({ rect }) => rect.width > 0 && rect.height > 0);
        const groups =
          d.within === undefined
            ? [{ container: undefined, group: members }]
            : containers.map((container) => ({
                container,
                group: members.filter(
                  (member) => innermost(containers, member.rect) === container,
                ),
              }));
        for (const { container, group } of groups) {
          if (group.length < 2) continue;
          const values = group.map((member) => ({
            selector: member.selector,
            value: shareValue(member.rect, d.share),
          }));
          const numbers = values.map(({ value }) => value);
          const spread = Math.max(...numbers) - Math.min(...numbers);
          if (spread <= d.tolerance) continue;
          const sorted = [...numbers].sort((a, b) => a - b);
          const median = sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
          const ordered = [...values].sort((a, b) => a.value - b.value);
          const low = ordered[0];
          const high = ordered.at(-1);
          if (low === undefined || high === undefined) continue;
          const [outlier, other] =
            Math.abs(high.value - median) > Math.abs(low.value - median)
              ? [high, low]
              : [low, high];
          const noun =
            d.share === "width" || d.share === "height"
              ? `${d.share}s`
              : `${d.share} edges`;
          emit(
            "share",
            `${label.replace(/[.!?]$/, "")}: ${noun} ${values.map(({ value }) => number(value)).join(", ")}${container === undefined ? "" : ` in ${container.selector}`} differ by ${number(spread)} (tolerance ${number(d.tolerance)})`,
            outlier.selector,
            other.selector,
            values,
          );
        }
      } else if ("selector" in d) {
        for (const entry of selectors)
          for (const match of entry.matches) {
            for (const axis of ["width", "height"] as const) {
              const expected = d[axis];
              if (expected === undefined) continue;
              const min =
                typeof expected === "number" ? expected : expected.min;
              const max =
                typeof expected === "number" ? expected : expected.max;
              const actual = match.rect[axis];
              if (actual >= min - d.tolerance && actual <= max + d.tolerance)
                continue;
              emit(
                axis,
                `${label} ${axis} ${number(actual)}, expected ${typeof expected === "number" ? number(expected) : `${number(min)}–${number(max)}`}${d.tolerance === 0 ? "" : ` (tolerance ${number(d.tolerance)})`}`,
                match.selector,
                undefined,
                actual,
              );
            }
          }
      } else if ("align" in d) {
        const edges = selectors.flatMap((entry) =>
          entry.matches.map((match) => ({
            authoredSelector: entry.selector,
            selector: match.selector,
            value: edgeValue(match.rect, d.align),
          })),
        );
        const values = edges.map(({ value }) => value);
        if (Math.max(...values) - Math.min(...values) <= d.tolerance) continue;
        // Anchor crops to the extreme pair that actually demonstrates the defect.
        const ordered = [...edges].sort((a, b) => a.value - b.value);
        // Identity follows a canonical participant, independent of which
        // edge is furthest out of alignment in this capture.
        const anchorSelector = [...d.selectors].sort()[0];
        const anchor = selectors.find(
          ({ selector }) => selector === anchorSelector,
        )?.matches[0]?.selector;
        emit(
          "alignment",
          `${d.align} edges differ: ${edges.map(({ authoredSelector, value }) => `${authoredSelector} ${number(value)}`).join(", ")} (${label}); expected spread <= ${number(d.tolerance)}`,
          ordered[0]?.selector ?? d.selectors[0] ?? "document",
          ordered.at(-1)?.selector,
          edges,
          anchor,
        );
      } else {
        const ambiguous = selectors.filter(
          ({ matches }) => matches.length !== 1,
        );
        if (ambiguous.length > 0) {
          emit(
            "ambiguous-selector",
            `${label}: ambiguous offset selector matches: ${ambiguous.map(({ selector, matches }) => `${selector} matched ${matches.length} elements (expected exactly one)`).join(", ")}`,
            ambiguous[0]?.matches[0]?.selector ?? "document",
            undefined,
            ambiguous.map(({ selector, matches }) => ({
              selector,
              count: matches.length,
            })),
          );
          continue;
        }
        const edge = parseInvariantEdge(d.edge);
        const equals = parseInvariantEdge(d.equals);
        const match = selectors.find(
          ({ selector }) => selector === edge.selector,
        )?.matches[0];
        const other = selectors.find(
          ({ selector }) => selector === equals.selector,
        )?.matches[0];
        if (!match || !other) continue;
        const actual = edgeValue(match.rect, edge.edge);
        const reference = edgeValue(other.rect, equals.edge);
        const delta = actual - reference;
        if (Math.abs(delta - d.offset) <= d.tolerance) continue;
        emit(
          "offset",
          `${label}: ${d.edge} ${number(actual)}, ${d.equals} ${number(reference)}; offset ${number(delta)}, expected ${number(d.offset)} (tolerance ${number(d.tolerance)})`,
          match.selector,
          other.selector,
          { edge: actual, equals: reference, offset: delta },
        );
      }
    }
    return ran(this.id, candidates);
  },
};
