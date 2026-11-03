import {
  isOffScreen,
  isSpacingEligible,
  isVisuallyHidden,
  verify,
} from "./shared.js";
import type {
  CheckTuple,
  FindingCandidate,
  ObservationArtifactV2,
  ObservedElementV2,
  RunDeterministicCheck,
} from "./types.js";

type Side = "boundary-above" | "boundary-below";
type InteractiveKind = "button" | "link" | "input";
type BoundarySource = "viewport" | "container" | "rule" | "border";

type Boundary = {
  coordinate: number;
  x: number;
  width: number;
  path: string;
  selector: string;
  source: BoundarySource;
  edge: "top" | "bottom";
  /** A container edge with no padding or border that its content reaches. */
  hugs?: boolean;
};

type Placement = {
  tuple: CheckTuple;
  element: ObservedElementV2;
  kind: InteractiveKind;
  side: Side;
  clearance: number;
  boundary: Boundary;
  cohort: string;
};

type QualifiedOutlier = {
  placement: Placement;
  prevailing: number;
  support: number;
  exemplar: Placement;
};

type PlacementGroup = {
  clearance?: number;
  placements: Placement[];
};

const semanticContainers = new Set([
  "body",
  "main",
  "section",
  "article",
  "nav",
  "header",
  "footer",
  "form",
  "dialog",
]);

function tupleCoordinate(tuple: CheckTuple): string {
  return `${tuple.state}/${tuple.viewport}${tuple.colorSchemeAxis ? `/${tuple.colorScheme ?? "light"}` : ""}`;
}

function tupleSortKey(tuple: CheckTuple): string {
  return `${tuple.flow}\0${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? ""}\0${tuple.metadataPath}`;
}

function canonical(value: number): number {
  const rounded = Math.round(Math.max(0, value) * 2) / 2;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatClearance(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} CSS px`;
}

function pathContains(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

function overlapsHorizontally(
  element: ObservedElementV2,
  boundary: Boundary,
): boolean {
  return (
    Math.min(element.rect.x + element.rect.width, boundary.x + boundary.width) >
    Math.max(element.rect.x, boundary.x)
  );
}

function transparent(color: string): boolean {
  const normalized = color.trim().toLowerCase().replaceAll(" ", "");
  if (["", "transparent", "none"].includes(normalized)) return true;
  const rgba = normalized.match(/^rgba\([^,]+,[^,]+,[^,]+,([^)]+)\)$/);
  if (rgba !== null) return Number.parseFloat(rgba[1] ?? "1") === 0;
  return /\/0(?:\.0+)?\)$/.test(normalized);
}

function painted(width: string, color: string): boolean {
  return Number.parseFloat(width) > 0 && !transparent(color);
}

/** Visible content a spacing measurement can see. */
function measurable(
  element: ObservedElementV2,
  artifact: ObservationArtifactV2,
): boolean {
  return (
    element.visible &&
    !isVisuallyHidden(element) &&
    isSpacingEligible(element) &&
    !isOffScreen(element, artifact)
  );
}

/** The top and bottom of each ancestor path's measurable content, in one pass. */
function contentExtents(
  artifact: ObservationArtifactV2,
): Map<string, { top: number; bottom: number }> {
  const extents = new Map<string, { top: number; bottom: number }>();
  for (const element of artifact.elements) {
    if (
      !measurable(element, artifact) ||
      element.rect.width <= 0 ||
      element.rect.height <= 0
    )
      continue;
    const top = element.rect.y;
    const bottom = element.rect.y + element.rect.height;
    const segments = element.structuralPath.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const path = segments.slice(0, depth).join("/");
      const extent = extents.get(path);
      if (extent === undefined) extents.set(path, { top, bottom });
      else {
        extent.top = Math.min(extent.top, top);
        extent.bottom = Math.max(extent.bottom, bottom);
      }
    }
  }
  return extents;
}

/**
 * A container edge with no padding or painted border on that side, which its
 * content reaches. Only a control that itself reaches it looks past it.
 */
function hugs(
  container: ObservedElementV2,
  edge: "top" | "bottom",
  extents: Map<string, { top: number; bottom: number }>,
): boolean {
  const { styles, rect } = container;
  const [padding, width, color] =
    edge === "top"
      ? [styles.paddingTop, styles.borderTopWidth, styles.borderTopColor]
      : [
          styles.paddingBottom,
          styles.borderBottomWidth,
          styles.borderBottomColor,
        ];
  if (Number.parseFloat(padding) > 0.5 || painted(width, color)) return false;
  const content = extents.get(container.structuralPath);
  if (content === undefined) return false;
  return edge === "top"
    ? Math.abs(content.top - rect.y) <= 0.5
    : Math.abs(content.bottom - (rect.y + rect.height)) <= 0.5;
}

function boundaries(artifact: ObservationArtifactV2): Boundary[] {
  const result: Boundary[] = [];
  const extents = contentExtents(artifact);
  if (artifact.document.scrollHeight <= artifact.document.clientHeight) {
    result.push(
      {
        coordinate: 0,
        x: 0,
        width: artifact.viewport.width,
        path: "@viewport",
        selector: "viewport",
        source: "viewport",
        edge: "top",
      },
      {
        coordinate: artifact.viewport.height,
        x: 0,
        width: artifact.viewport.width,
        path: "@viewport",
        selector: "viewport",
        source: "viewport",
        edge: "bottom",
      },
    );
  }
  const pushEdges = (element: ObservedElementV2, source: BoundarySource) => {
    for (const edge of ["top", "bottom"] as const) {
      result.push({
        coordinate:
          edge === "top"
            ? element.rect.y
            : element.rect.y + element.rect.height,
        x: element.rect.x,
        width: element.rect.width,
        path: element.structuralPath,
        selector: element.selector,
        source,
        edge,
        ...(source === "container" && hugs(element, edge, extents)
          ? { hugs: true }
          : {}),
      });
    }
  };
  for (const element of [...artifact.elements].sort((left, right) =>
    left.structuralPath.localeCompare(right.structuralPath),
  )) {
    if (!measurable(element, artifact) || element.rect.width <= 0) continue;
    if (element.tag === "hr") pushEdges(element, "rule");
    if (semanticContainers.has(element.tag)) pushEdges(element, "container");
    if (painted(element.styles.borderTopWidth, element.styles.borderTopColor)) {
      result.push({
        coordinate: element.rect.y,
        x: element.rect.x,
        width: element.rect.width,
        path: element.structuralPath,
        selector: element.selector,
        source: "border",
        edge: "top",
      });
    }
    if (
      painted(
        element.styles.borderBottomWidth,
        element.styles.borderBottomColor,
      )
    ) {
      result.push({
        coordinate: element.rect.y + element.rect.height,
        x: element.rect.x,
        width: element.rect.width,
        path: element.structuralPath,
        selector: element.selector,
        source: "border",
        edge: "bottom",
      });
    }
  }
  return result.sort(
    (left, right) =>
      left.coordinate - right.coordinate ||
      left.source.localeCompare(right.source) ||
      left.path.localeCompare(right.path) ||
      left.edge.localeCompare(right.edge),
  );
}

function interactiveKind(
  element: ObservedElementV2,
  artifact: ObservationArtifactV2,
): InteractiveKind | undefined {
  if (!measurable(element, artifact) || !element.interactive) return undefined;
  if (element.tag === "button") return "button";
  if (element.tag === "a") return "link";
  if (element.tag === "input") return "input";
  return undefined;
}

/**
 * A hugging container's edge that this element itself reaches is the
 * element's own edge, so the measurement looks past it. Content between the
 * element and that edge (a padded row) makes the edge a real boundary.
 */
function reachesHuggingEdge(
  element: ObservedElementV2,
  boundary: Boundary,
  side: Side,
): boolean {
  if (boundary.hugs !== true) return false;
  if (!pathContains(boundary.path, element.structuralPath)) return false;
  const edge =
    side === "boundary-above"
      ? element.rect.y
      : element.rect.y + element.rect.height;
  return Math.abs(edge - boundary.coordinate) <= 0.5;
}

function nearestBoundary(
  element: ObservedElementV2,
  available: Boundary[],
  artifact: ObservationArtifactV2,
  side: Side,
): Boundary | undefined {
  const start = element.rect.y;
  const end = element.rect.y + element.rect.height;
  const viewportBottom = available.find(
    (boundary) => boundary.path === "@viewport" && boundary.edge === "bottom",
  )?.coordinate;
  const nearest = available
    .filter((boundary) => {
      if (
        boundary.path === element.structuralPath ||
        pathContains(element.structuralPath, boundary.path) ||
        !overlapsHorizontally(element, boundary) ||
        reachesHuggingEdge(element, boundary, side)
      )
        return false;
      if (
        boundary.source === "viewport" &&
        (end <= 0 || (viewportBottom !== undefined && start >= viewportBottom))
      )
        return false;
      return side === "boundary-above"
        ? boundary.coordinate <= start
        : boundary.coordinate >= end;
    })
    .sort((left, right) => {
      const leftDistance =
        side === "boundary-above"
          ? start - left.coordinate
          : left.coordinate - end;
      const rightDistance =
        side === "boundary-above"
          ? start - right.coordinate
          : right.coordinate - end;
      return (
        leftDistance - rightDistance ||
        left.source.localeCompare(right.source) ||
        left.path.localeCompare(right.path) ||
        left.edge.localeCompare(right.edge)
      );
    })[0];
  if (nearest === undefined) return undefined;
  const interveningContent = artifact.elements.some((other) => {
    if (
      !measurable(other, artifact) ||
      other.rect.width <= 0 ||
      other.rect.height <= 0 ||
      other.structuralPath === element.structuralPath ||
      pathContains(element.structuralPath, other.structuralPath) ||
      pathContains(other.structuralPath, element.structuralPath) ||
      Math.min(nearest.x + nearest.width, other.rect.x + other.rect.width) <=
        Math.max(nearest.x, other.rect.x)
    )
      return false;
    return side === "boundary-above"
      ? other.rect.y < start &&
          other.rect.y + other.rect.height > nearest.coordinate
      : other.rect.y + other.rect.height > end &&
          other.rect.y < nearest.coordinate;
  });
  return interveningContent ? undefined : nearest;
}

function derivePlacements(tuple: CheckTuple): Placement[] {
  const artifact = tuple.observations;
  if (artifact?.version !== 2) return [];
  const available = boundaries(artifact);
  // Scroll clips: containers whose content runs past their visible edge.
  // Where a row meets such an edge (or the viewport fold of a fixed app
  // shell) the clearance is wherever scrolling stopped, not a spacing choice.
  const clips = artifact.elements.filter(
    (element) =>
      element.visible &&
      element.scrollHeight > element.clientHeight + 1 &&
      ["auto", "scroll", "hidden", "clip"].includes(element.styles.overflowY),
  );
  const foldY = artifact.viewport.height;
  const clipped = (element: ObservedElementV2) => {
    const top = element.rect.y;
    const bottom = element.rect.y + element.rect.height;
    const shell =
      artifact.document.scrollHeight <= artifact.document.clientHeight;
    if (shell && top < foldY - 0.5 && bottom > foldY + 0.5) return true;
    return clips.some((clip) => {
      if (!pathContains(clip.structuralPath, element.structuralPath))
        return false;
      return (
        top < clip.rect.y - 0.5 || bottom > clip.rect.y + clip.rect.height + 0.5
      );
    });
  };
  const atClipEdge = (element: ObservedElementV2, boundary: Boundary) =>
    clips.some(
      (clip) =>
        pathContains(clip.structuralPath, element.structuralPath) &&
        (boundary.path === clip.structuralPath ||
          Math.abs(boundary.coordinate - clip.rect.y) <= 0.5 ||
          Math.abs(boundary.coordinate - (clip.rect.y + clip.rect.height)) <=
            0.5 ||
          Math.abs(boundary.coordinate - foldY) <= 0.5),
    );
  const placements: Placement[] = [];
  for (const element of [...artifact.elements].sort((left, right) =>
    left.structuralPath.localeCompare(right.structuralPath),
  )) {
    const kind = interactiveKind(element, artifact);
    if (kind === undefined) continue;
    if (clipped(element)) continue;
    for (const side of ["boundary-above", "boundary-below"] as const) {
      const boundary = nearestBoundary(element, available, artifact, side);
      if (boundary === undefined) continue;
      if (side === "boundary-below" && atClipEdge(element, boundary)) continue;
      const clearance = canonical(
        side === "boundary-above"
          ? element.rect.y - boundary.coordinate
          : boundary.coordinate - (element.rect.y + element.rect.height),
      );
      placements.push({
        tuple,
        element,
        kind,
        side,
        clearance,
        boundary,
        cohort: `${artifact.viewport.width}x${artifact.viewport.height}\0${kind}\0${side}`,
      });
    }
  }
  return placements;
}

function placementSortKey(placement: Placement): string {
  return `${placement.cohort}\0${tupleSortKey(placement.tuple)}\0${placement.element.structuralPath}\0${placement.boundary.path}\0${placement.boundary.edge}`;
}

function sharpOutlier(value: number, prevailing: number): boolean {
  if (value === prevailing) return false;
  if (value === 0 || prevailing === 0) return true;
  return value <= prevailing / 2 || value >= prevailing * 2;
}

function supportIdentity(placement: Placement): string {
  return `${placement.tuple.flow}\0${placement.element.structuralPath}\0${placement.element.selector}\0${placement.boundary.source}\0${placement.boundary.path}\0${placement.boundary.selector}\0${placement.boundary.edge}`;
}

function groupDistinctPlacements(placements: Placement[]): PlacementGroup[] {
  const byIdentity = new Map<string, Placement[]>();
  for (const placement of placements) {
    const identity = supportIdentity(placement);
    const group = byIdentity.get(identity) ?? [];
    group.push(placement);
    byIdentity.set(identity, group);
  }
  const groups: PlacementGroup[] = [];
  for (const [, group] of [...byIdentity].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    group.sort((left, right) =>
      placementSortKey(left).localeCompare(placementSortKey(right)),
    );
    const clearances = new Set(group.map(({ clearance }) => clearance));
    const clearance = group[0]?.clearance;
    groups.push({
      placements: group,
      ...(clearances.size === 1 && clearance !== undefined
        ? { clearance }
        : {}),
    });
  }
  return groups;
}

function preferredExemplar(
  groups: PlacementGroup[],
  outlier: Placement,
): Placement | undefined {
  const outlierTuple = tupleSortKey(outlier.tuple);
  const outlierScheme = outlier.tuple.colorScheme ?? "light";
  return groups
    .flatMap(({ placements }) => placements)
    .sort((left, right) => {
      const leftTuple = tupleSortKey(left.tuple);
      const rightTuple = tupleSortKey(right.tuple);
      const leftPreference =
        leftTuple === outlierTuple
          ? 0
          : (left.tuple.colorScheme ?? "light") === outlierScheme
            ? 1
            : 2;
      const rightPreference =
        rightTuple === outlierTuple
          ? 0
          : (right.tuple.colorScheme ?? "light") === outlierScheme
            ? 1
            : 2;
      return (
        leftPreference - rightPreference ||
        placementSortKey(left).localeCompare(placementSortKey(right))
      );
    })[0];
}

function qualify(placements: Placement[]): QualifiedOutlier[] {
  const cohorts = new Map<string, Placement[]>();
  for (const placement of placements) {
    const values = cohorts.get(placement.cohort) ?? [];
    values.push(placement);
    cohorts.set(placement.cohort, values);
  }
  const results: QualifiedOutlier[] = [];
  for (const cohort of [...cohorts].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const groups = groupDistinctPlacements(cohort[1]);
    const counts = new Map<number, PlacementGroup[]>();
    for (const group of groups) {
      if (group.clearance === undefined) continue;
      const matching = counts.get(group.clearance) ?? [];
      matching.push(group);
      counts.set(group.clearance, matching);
    }
    const ranked = [...counts].sort(
      ([leftValue, left], [rightValue, right]) =>
        right.length - left.length || leftValue - rightValue,
    );
    const prevailingEntry = ranked[0];
    if (prevailingEntry === undefined) continue;
    const [prevailing, prevailingGroups] = prevailingEntry;
    const support = prevailingGroups.length;
    const otherSupport = groups.length - support;
    if (
      support < 3 ||
      support < otherSupport * 2 ||
      (ranked[1]?.[1].length ?? 0) === support
    )
      continue;
    for (const group of groups) {
      for (const placement of group.placements) {
        if (!sharpOutlier(placement.clearance, prevailing)) continue;
        const exemplar = preferredExemplar(prevailingGroups, placement);
        if (exemplar !== undefined)
          results.push({ placement, prevailing, support, exemplar });
      }
    }
  }
  return results;
}

function boundaryDescription(boundary: Boundary): string {
  if (boundary.source === "viewport")
    return `the viewport ${boundary.edge} edge`;
  const source =
    boundary.source === "rule"
      ? "rule"
      : boundary.source === "border"
        ? `${boundary.edge} border`
        : `container ${boundary.edge} edge`;
  return `${source} at ${boundary.selector}`;
}

function stableIdentity(placement: Placement): string {
  return `${placement.element.structuralPath}\0${placement.kind}\0${placement.side}`;
}

function candidateFor(outlier: QualifiedOutlier): FindingCandidate {
  const { placement, prevailing, support, exemplar } = outlier;
  const direction = placement.side === "boundary-above" ? "above" : "below";
  return {
    targetSelectors: [placement.element.selector],
    category: "spacing-rhythm",
    severity: "minor",
    rule: "idiom:spacing-rhythm-outlier",
    selectorHint: `${placement.element.selector}::${placement.side}[${placement.element.structuralPath}]`,
    explanation: `${placement.element.selector} has ${formatClearance(placement.clearance)} clearance ${direction} it to ${boundaryDescription(placement.boundary)} at ${tupleCoordinate(placement.tuple)}. The prevailing clearance is ${formatClearance(prevailing)}, supported by ${support} observed placements; for example ${exemplar.element.selector} to ${boundaryDescription(exemplar.boundary)} at ${tupleCoordinate(exemplar.tuple)}.`,
    acceptance: [
      `${placement.element.selector}'s ${direction} clearance no longer sharply diverges from the run-derived prevailing clearance for comparable ${placement.kind} placements.`,
    ],
    verification: verify("spacing-rhythm", {
      placement: {
        structuralPath: placement.element.structuralPath,
        kind: placement.kind,
        side: placement.side,
      },
      fullFlow: true,
    }),
    evidenceTuples: [...new Set([placement.tuple, exemplar.tuple])],
  };
}

export const spacingRhythmCheck: RunDeterministicCheck = {
  id: "spacing-rhythm",
  run(tuples) {
    const orderedTuples = [...tuples].sort((left, right) =>
      tupleSortKey(left).localeCompare(tupleSortKey(right)),
    );
    const coverage = orderedTuples.map((tuple) => ({
      tuple,
      coverage:
        tuple.observations?.version === 2
          ? ({ check: this.id, status: "ran" } as const)
          : ({
              check: this.id,
              status: "unavailable",
              reason:
                tuple.observations === undefined
                  ? "not evaluated: observations.json is unavailable"
                  : "not evaluated: observations version 1 lacks structural geometry",
            } as const),
    }));
    const qualified = qualify(orderedTuples.flatMap(derivePlacements));
    const coalesced = new Map<string, QualifiedOutlier>();
    for (const outlier of qualified) {
      const tuple = outlier.placement.tuple;
      const key = `${tuple.flow}\0${tuple.state}\0${tuple.colorSchemeAxis ? (tuple.colorScheme ?? "light") : ""}\0${stableIdentity(outlier.placement)}`;
      if (!coalesced.has(key)) coalesced.set(key, outlier);
    }
    const candidates = [...coalesced]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, outlier]) => ({
        tuple: outlier.placement.tuple,
        candidate: candidateFor(outlier),
      }));
    return { coverage, candidates };
  },
};
