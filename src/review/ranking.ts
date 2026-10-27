import { tupleCoordinate, tupleCoordinateKey } from "../baseline/coordinate.js";
import {
  type CheckTuple,
  deterministicCheckIds,
  type ObservedElementV2,
} from "../checks/types.js";
import type { Finding } from "../schemas/finding.js";

/** Fixed presentation policy; additions to the category schema require a value. */
export const categorySalience = {
  "overflow-clip": 4,
  "responsive-break": 4,
  contrast: 4,
  "a11y-label": 4,
  "target-size": 1,
  "heading-structure": 4,
  "token-drift": 7,
  "console-error": 4,
  "missing-state": 9,
  "spacing-rhythm": 1,
  "unexplained-control": 7,
  "text-centering": 7,
  "adjacent-gap": 7,
  "dead-affordance": 9,
  "dead-control": 9,
  "duplicate-entry": 9,
  "component-size": 7,
  "copy-lint": 4,
  "glyph-icon": 4,
  "error-text": 9,
  "native-control": 4,
  "layout-invariants": 4,
  "group-invariants": 4,
  "selected-state": 4,
  "dialog-shell": 4,
  "disguised-control": 4,
  "fresh-state": 4,
  "mirrored-control": 4,
  motion: 4,
  "element-overlap": 9,
  "clipped-text": 9,
  "field-group": 4,
  "scale-conformance": 7,
  "control-anatomy": 1,
  "luminance-parity": 4,
  frame: 4,
  "primary-region": 4,
  "alarm-at-rest": 4,
  "cross-surface-naming": 4,
  "published-budget": 4,
  "empty-state": 4,
  "progress-affordance": 4,
  "page-content": 4,
  "band-edges": 4,
  "word-break": 4,
  "shell-visibility": 4,
  "compound-control": 4,
  "sibling-chrome": 4,
  "touch-reachability": 4,
  liveness: 9,
  "media-fill": 4,
  "collection-actions": 4,
  "font-loading": 4,
  "broken-link": 4,
  "focus-visible": 4,
  "line-length": 4,
  "orphan-word": 4,
  "image-distortion": 4,
  "broken-image": 4,
  "layout-shift": 4,
  "interaction-shift": 4,
  "design-drift": 4,
  "loading-state-missing": 4,
  "double-submit": 4,
  hierarchy: 4,
  density: 4,
  "brand-alignment": 4,
  "generic-pattern": 4,
  "reference-mismatch": 4,
  "spec-mismatch": 4,
  "direction-drift": 4,
  "offer-change": 4,
  "unsupported-claim": 4,
} satisfies Record<Finding["category"], number>;

export function salienceFor(category: string, rule?: string): number {
  if (!rule) return 4;
  if (category === "dead-affordance" && rule === "idiom:placeholder-link")
    return 4;
  if (
    (category === "overflow-clip" &&
      ["idiom:input-value-truncated", "idiom:element-content-clipped"].includes(
        rule,
      )) ||
    (category === "disguised-control" && rule === "idiom:input-rejects-text")
  )
    return 9;
  return Object.hasOwn(categorySalience, category)
    ? categorySalience[category as Finding["category"]]
    : 4;
}

const deterministicCategories: ReadonlySet<string> = new Set(
  deterministicCheckIds,
);
/** Undefined means the caller must preserve the independent/sibling fallback. */
export function ruleFamily(
  category: string,
  rule?: string,
): string | undefined {
  if (!rule || !deterministicCategories.has(category)) return undefined;
  if (
    category === "adjacent-gap" &&
    ["idiom:adjacent-elements-touch", "idiom:focus-ring-collision"].includes(
      rule,
    )
  )
    return "adjacent-gap";
  if (
    category === "overflow-clip" &&
    ["idiom:input-value-truncated", "idiom:element-content-clipped"].includes(
      rule,
    )
  )
    return "clipping";
  return rule;
}

// Both versions share geometry; V2 signals remain optional for old captures.
export type RankingElement = Pick<
  import("../checks/types.js").ObservedElement,
  "selector" | "visible" | "rect" | "ancestorSelectors"
> & {
  tag?: string | undefined;
  interactive?: boolean | undefined;
  attributes?: ObservedElementV2["attributes"] | undefined;
  styles?: Partial<ObservedElementV2["styles"]> | undefined;
  styleSources?: ObservedElementV2["styleSources"];
  signals?: ObservedElementV2["signals"];
};
export type IssueRankingTuple = {
  state: string;
  viewport: { width: number; height: number };
  elements: ReadonlyMap<string, RankingElement>;
  primaryRegions: ReadonlySet<string>;
  /** Selector → declared component name (checks.components), for grouping. */
  components?: ReadonlyMap<string, string> | undefined;
  /** Declared token values when a token file is configured. */
  tokens?: Record<string, string> | undefined;
};
export type IssueRankingContext = ReadonlyMap<string, IssueRankingTuple>;

export function buildIssueRankingContext(
  tuples: readonly CheckTuple[],
): IssueRankingContext {
  const context = new Map<string, IssueRankingTuple>();
  for (const tuple of tuples) {
    const observation = tuple.observations;
    if (!observation) continue;
    const elements = new Map<string, RankingElement>(
      observation.elements.map((element) => [element.selector, element]),
    );
    const marked =
      observation.version === 2
        ? (observation.selectorMarks ?? [])
            .filter((mark) => mark.purpose === "primary-region")
            .flatMap((mark) => mark.matches)
            .filter((selector) => elements.has(selector))
        : [];
    const primaryRegions = new Set(
      marked.length
        ? marked
        : observation.elements
            .filter(
              (element) =>
                element.tag === "main" ||
                (element as RankingElement).signals?.role === "main",
            )
            .map((element) => element.selector),
    );
    const components = new Map<string, string>();
    if (observation.version === 2)
      for (const component of observation.components ?? []) {
        if (component.unresolved) continue;
        for (const rect of component.rects)
          if (!components.has(rect.selector))
            components.set(rect.selector, component.name);
      }
    context.set(tupleCoordinateKey(tupleCoordinate(tuple)), {
      state: tuple.state,
      viewport: observation.viewport,
      elements,
      primaryRegions,
      components,
      ...(observation.tokens?.status === "configured"
        ? { tokens: observation.tokens.declarations }
        : {}),
    });
  }
  return context;
}

export type RankingExplanation = {
  selector?: string | undefined;
  coordinate?: string | undefined;
  areaRatio: number;
  aboveFold: boolean;
  primaryRegion: boolean;
  primaryAction: boolean;
  states: number;
  places: number;
  geometryAvailable: boolean;
  /** Root-cause breadth factor applied on top of the winning symptom. */
  breadth?: number | undefined;
};

/** A root cause outranks its best symptom by up to 25% for breadth. */
export function rootCauseBreadth(symptoms: number): number {
  return 1 + 0.25 * Math.min(1, Math.log2(Math.max(1, symptoms)) / 3);
}
export function affectedCounts(
  coordinates: readonly string[],
  context?: IssueRankingContext,
) {
  const places = new Set(coordinates);
  return {
    states: new Set(
      [...places].map((key) => context?.get(key)?.state ?? key.split("/")[0]),
    ).size,
    places: places.size,
  };
}
export function scoreGroup(
  group: {
    category: string;
    rule?: string | undefined;
    selector?: string | undefined;
    coordinates: string[];
  },
  counts: { states: number; places: number },
  context?: IssueRankingContext,
) {
  let explanation: RankingExplanation = {
    selector: group.selector,
    areaRatio: 0,
    aboveFold: false,
    primaryRegion: false,
    primaryAction: false,
    ...counts,
    geometryAvailable: false,
  };
  let base = 1;
  let primaryAction = false;
  for (const coordinate of new Set(group.coordinates)) {
    const tuple = context?.get(coordinate);
    const target =
      group.selector === undefined
        ? undefined
        : tuple?.elements.get(group.selector);
    primaryAction ||= target?.signals?.paint?.primaryAction === true;
    if (!tuple || !target?.visible) continue;
    const { width, height } = tuple.viewport;
    const rect = target.rect;
    if (
      ![width, height, rect.x, rect.y, rect.width, rect.height].every(
        Number.isFinite,
      ) ||
      width <= 0 ||
      height <= 0 ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      continue;
    const intersectionWidth = Math.max(
      0,
      Math.min(width, rect.x + rect.width) - Math.max(0, rect.x),
    );
    const intersectionHeight = Math.max(
      0,
      Math.min(height, rect.y + rect.height) - Math.max(0, rect.y),
    );
    const areaRatio = Math.max(
      0,
      Math.min(1, (intersectionWidth / width) * (intersectionHeight / height)),
    );
    const aboveFold = areaRatio > 0;
    const primaryRegion =
      aboveFold &&
      (tuple.primaryRegions.has(target.selector) ||
        target.ancestorSelectors.some((selector) =>
          tuple.primaryRegions.has(selector),
        ));
    const action = aboveFold && target.signals?.paint?.primaryAction === true;
    const candidate = aboveFold
      ? 1 + Math.sqrt(areaRatio) + 0.5 + 0.5 * Number(primaryRegion || action)
      : 1;
    if (
      candidate > base ||
      (!explanation.geometryAvailable && candidate === base)
    ) {
      base = candidate;
      explanation = {
        selector: group.selector,
        coordinate,
        areaRatio,
        aboveFold,
        primaryRegion,
        primaryAction: action,
        ...counts,
        geometryAvailable: true,
      };
    }
  }
  const prominence =
    base +
    0.25 * Math.min(1, Math.log2(Math.max(1, counts.states)) / 3) +
    0.25 * Math.min(1, Math.log2(Math.max(1, counts.places)) / 6);
  const salience = salienceFor(group.category, group.rule);
  return {
    salience,
    prominence,
    score: salience * prominence,
    explanation,
    primaryAction,
  };
}
