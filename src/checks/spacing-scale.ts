import { pixelTolerance, spacingOnScale } from "../system/learn/normalize.js";
import { isVisuallyHidden, verify } from "./shared.js";
import type {
  CheckTuple,
  FindingCandidate,
  ObservedElement,
  ObservedElementV2,
  ScalesConfig,
} from "./types.js";

const tupleSortKey = (tuple: CheckTuple) =>
  [tuple.flow, tuple.state, tuple.viewport, tuple.colorScheme ?? "light"].join(
    "\0",
  );

export { pixelTolerance };
/** Authored computed spacing only; geometric clearances are intentionally absent. */
export function authoredSpacing(
  element: ObservedElement,
): Array<{ property: string; px: number }> {
  if (
    !element.visible ||
    isVisuallyHidden(element) ||
    element.authoredProperties === undefined
  )
    return [];
  if (!("gap" in element.styles)) return [];
  const styles = element.styles as ObservedElementV2["styles"];
  const result: Array<{ property: string; px: number }> = [];
  const authored = new Set(element.authoredProperties);
  const add = (property: string, value: string, shorthand: string) => {
    if (!authored.has(property) && !authored.has(shorthand)) return;
    if (!/^-?[\d.]+px$/.test(value)) return;
    const px = Math.abs(Number(value.slice(0, -2)));
    if (px > 0 && Number.isFinite(px)) result.push({ property, px });
  };
  for (const family of ["padding", "margin"] as const)
    for (const side of ["Top", "Right", "Bottom", "Left"] as const)
      add(`${family}${side}`, styles[`${family}${side}`], family);
  const axes = styles.gap.trim().split(/\s+/);
  add("rowGap", axes[0] ?? "", "gap");
  add("columnGap", axes[1] ?? axes[0] ?? "", "gap");
  return result;
}

export type SpacingMember = {
  tuple: CheckTuple;
  element: ObservedElementV2;
  selector: string;
  property: string;
  px: number;
};

/** Every authored off-scale spacing longhand, in tuple then element order. */
export function spacingOccurrences(
  tuples: readonly CheckTuple[],
  scale: ScalesConfig["spacing"],
): SpacingMember[] {
  const members: SpacingMember[] = [];
  if (!scale?.length) return members;
  for (const tuple of [...tuples].sort((a, b) =>
    tupleSortKey(a).localeCompare(tupleSortKey(b)),
  )) {
    if (tuple.observations?.version !== 2) continue;
    for (const element of tuple.observations.elements)
      for (const { property, px } of authoredSpacing(element)) {
        if (spacingOnScale(px, scale)) continue;
        members.push({
          tuple,
          element,
          selector: element.selector,
          property,
          px,
        });
      }
  }
  return members;
}

/** One candidate per off-scale value, owned by its first tuple. */
export function spacingCandidates(
  members: readonly SpacingMember[],
  scale: ScalesConfig["spacing"],
): Map<CheckTuple, FindingCandidate[]> {
  const output = new Map<CheckTuple, FindingCandidate[]>();
  if (!scale?.length) return output;
  const groups = new Map<string, SpacingMember[]>();
  for (const member of members) {
    const key = `${Math.round(member.px * 1000) / 1000}px`;
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }
  for (const [value, members] of groups) {
    const first = members[0];
    if (!first) continue;
    const selectors = [...new Set(members.map((m) => m.selector))];
    const candidate: FindingCandidate = {
      category: "scale-conformance",
      severity: "minor",
      rule: "idiom:off-scale-spacing",
      selectorHint: first.selector,
      fingerprintHint: `scale:spacing:${value}`,
      explanation: `${selectors.length} elements use authored spacing ${value}, outside checks.scales.spacing (${JSON.stringify(scale)}). For example ${selectors.slice(0, 3).join(", ")}.`,
      acceptance: [`Use a declared spacing value in place of ${value}.`],
      verification: verify("scale-conformance", {
        property: "spacing",
        value,
        scale,
        targets: [
          ...new Map(
            members.map(({ selector, property }) => [
              `${selector}\0${property}`,
              { selector, property },
            ]),
          ).values(),
        ],
      }),
      evidenceTuples: [...new Set(members.map((m) => m.tuple))],
    };
    output.set(first.tuple, [...(output.get(first.tuple) ?? []), candidate]);
  }
  return output;
}

export function spacingFindings(
  tuples: readonly CheckTuple[],
  scale: ScalesConfig["spacing"],
): Map<CheckTuple, FindingCandidate[]> {
  return spacingCandidates(spacingOccurrences(tuples, scale), scale);
}
