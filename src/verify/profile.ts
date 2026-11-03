import { createHash } from "node:crypto";
import type {
  ObservationArtifact,
  ObservationArtifactV2,
  ObservedElement,
  ObservedStyles,
  Rect,
} from "../checks/types.js";
import { IdiomError } from "../errors.js";

export const NON_CONTENT_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "template",
  "noscript",
]);
const TEMPORAL =
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\b|\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]m)?\b|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/gi;

/** Capture caps subtree text here; a v1 record reaching it has unknown text. */
export const TEXT_BOUNDARY = 500;

export type ProfileKind = "v2-full" | "v1-compatible";

export type ProfileRecord = {
  path: string;
  selector: string;
  tag: string;
  text?: string | undefined;
  attributes?: Record<string, string> | undefined;
  styles: Record<string, string | undefined>;
  geometry?: Rect | undefined;
};

export type ProfileReductions = {
  excludedNonRendered: number;
  textSuppressedBoundary: number;
  /** Paths whose text this side suppressed at the boundary (v1 only). */
  boundaryPaths: string[];
  textSuppressedTemporal: number;
  textSuppressedMask: number;
  geometrySuppressed: number;
  maskStatus: Array<{
    selector: string;
    status: "exact" | "widened" | "temporal-mask-fallback";
    paths: string[];
  }>;
};

export type SemanticProfile = {
  kind: ProfileKind;
  records: ProfileRecord[];
  signature: string;
  reductions: ProfileReductions;
};

export function normalizedText(value: string): string {
  return value.replace(TEMPORAL, "<temporal>").replace(/\s+/g, " ").trim();
}

export function containsTemporal(value: string): boolean {
  const result = TEMPORAL.test(value);
  TEMPORAL.lastIndex = 0;
  return result;
}

const BARE_TEMPORAL_COMPONENT =
  /^(?:(\d{1,2})(?:st|nd|rd|th)?|(?:19|20)\d{2})$/i;

/**
 * A bare day of month (1–31, optional ordinal) or 19xx/20xx year. Alone it is
 * not temporal: callers require a dated context before classifying it.
 */
export function bareTemporalComponent(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 8) return false;
  const match = BARE_TEMPORAL_COMPONENT.exec(trimmed);
  if (match === null) return false;
  const day = match[1];
  if (day === undefined) return true;
  const date = Number(day);
  return date >= 1 && date <= 31;
}

/**
 * Temporal classification has a bounded cost on any amount of text. Each
 * element's own text is tested once (linear in captured text, no sample
 * window), and a temporal source marks its ancestors into a set, stopping at
 * the first prefix already marked. A bare day or year counts only when the
 * element itself, or one of its nearest CONTEXT_DEPTH ancestors (never body or
 * html), carries a date or time in its *own* text or attributes, or is a
 * `<time>`: an anchored match on short text plus at most CONTEXT_DEPTH
 * lookups, never a subtree scan. Own facts only, because subtree context let a
 * date anywhere in a shared form make a sibling count temporal. Known limit: a
 * calendar whose only date signal is a sibling heading, with no label on the
 * grid or day buttons, is not recognized.
 */
const CONTEXT_DEPTH = 4;

function parentPath(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  return index === -1 ? undefined : path.slice(0, index);
}

function attributesTemporal(attributes: Record<string, string>): boolean {
  return Object.values(attributes).some(containsTemporal);
}

function markAncestors(sources: Iterable<string>): Set<string> {
  const marked = new Set<string>();
  for (const source of sources) {
    let path: string | undefined = source;
    while (path !== undefined && !marked.has(path)) {
      marked.add(path);
      path = parentPath(path);
    }
  }
  return marked;
}

function stableAttributes(
  attributes: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => !containsTemporal(value)),
  );
}

function stableV2Styles(
  styles: ObservationArtifactV2["elements"][number]["styles"],
  volatile: boolean,
): Record<string, string | undefined> {
  if (!volatile) return styles;
  const {
    gridTemplateColumns: _gridTemplateColumns,
    transform: _transform,
    ...stable
  } = styles;
  return stable;
}

function signature(records: ProfileRecord[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        records.map(({ selector: _selector, ...record }) => record),
      ),
    )
    .digest("hex");
}

/**
 * The profile signature with text omitted at `paths`, so a compared pair can
 * share boundary suppression. Equals `profile.signature` for an empty set.
 */
export function signatureWithoutText(
  profile: SemanticProfile,
  paths: ReadonlySet<string>,
): string {
  return signature(
    profile.records.map((record) => {
      if (!paths.has(record.path)) return record;
      const { text: _text, ...rest } = record;
      return rest;
    }),
  );
}

function beneath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function affectedByMask(path: string, masks: string[]): boolean {
  return masks.some((mask) => beneath(path, mask) || beneath(mask, path));
}

function relativeRect(rect: Rect, parent?: Rect): Rect {
  return {
    x: rect.x - (parent?.x ?? 0),
    y: rect.y - (parent?.y ?? 0),
    width: rect.width,
    height: rect.height,
  };
}

function v1CompatibleStyles(styles: ObservedElement["styles"]): ObservedStyles {
  return {
    color: styles.color,
    backgroundColor: styles.backgroundColor,
    borderTopColor: styles.borderTopColor,
    borderRightColor: styles.borderRightColor,
    borderBottomColor: styles.borderBottomColor,
    borderLeftColor: styles.borderLeftColor,
    borderTopWidth: styles.borderTopWidth,
    borderRightWidth: styles.borderRightWidth,
    borderBottomWidth: styles.borderBottomWidth,
    borderLeftWidth: styles.borderLeftWidth,
    outlineColor: styles.outlineColor,
    outlineWidth: styles.outlineWidth,
    outlineStyle: styles.outlineStyle,
    textOverflow: styles.textOverflow,
    fill: styles.fill,
    stroke: styles.stroke,
    borderTopLeftRadius: styles.borderTopLeftRadius,
    borderTopRightRadius: styles.borderTopRightRadius,
    borderBottomRightRadius: styles.borderBottomRightRadius,
    borderBottomLeftRadius: styles.borderBottomLeftRadius,
    overflowX: styles.overflowX,
    overflowY: styles.overflowY,
    position: styles.position,
  };
}

function baseReductions(): ProfileReductions {
  return {
    excludedNonRendered: 0,
    textSuppressedBoundary: 0,
    boundaryPaths: [],
    textSuppressedTemporal: 0,
    textSuppressedMask: 0,
    geometrySuppressed: 0,
    maskStatus: [],
  };
}

function v2MaskPaths(artifact: ObservationArtifactV2): string[] {
  return artifact.maskMembership.flatMap(({ paths }) => paths);
}

function buildV2(artifact: ObservationArtifactV2): SemanticProfile {
  const reductions = baseReductions();
  const masks = v2MaskPaths(artifact);
  type Element = ObservationArtifactV2["elements"][number];
  const pathOf = (element: Element) =>
    element.legacyRenderedPath ?? element.structuralPath;
  const byStructural = new Map(
    artifact.elements.map((element) => [element.structuralPath, element]),
  );
  const contentful = (element: Element) =>
    element.visible && !NON_CONTENT_TAGS.has(element.tag);
  const ownContext = (element: Element) =>
    element.tag === "time" || attributesTemporal(element.attributes);
  const contextual = (element: Element): boolean => {
    if (!bareTemporalComponent(element.directText)) return false;
    if (ownContext(element)) return true;
    let path = parentPath(element.structuralPath);
    for (let step = 0; step < CONTEXT_DEPTH && path !== undefined; step += 1) {
      const ancestor = byStructural.get(path);
      if (
        ancestor === undefined ||
        ancestor.tag === "body" ||
        ancestor.tag === "html"
      )
        return false;
      if (
        contentful(ancestor) &&
        (ownContext(ancestor) || containsTemporal(ancestor.directText))
      )
        return true;
      path = parentPath(path);
    }
    return false;
  };
  const temporalSet = markAncestors(
    artifact.elements
      .filter(
        (element) =>
          contentful(element) &&
          (element.temporal ||
            containsTemporal(element.directText) ||
            contextual(element)),
      )
      .map(pathOf),
  );
  const isTemporal = (element: Element) => temporalSet.has(pathOf(element));
  const volatile = artifact.elements.filter(
    (element) => affectedByMask(pathOf(element), masks) || isTemporal(element),
  );
  reductions.maskStatus = artifact.maskMembership.map((entry) => ({
    selector: entry.selector,
    status: entry.paths.length === 0 ? "temporal-mask-fallback" : "exact",
    paths: entry.paths,
  }));
  const records = artifact.elements.flatMap((element): ProfileRecord[] => {
    if (!element.visible || NON_CONTENT_TAGS.has(element.tag)) {
      reductions.excludedNonRendered += 1;
      return [];
    }
    const path = element.legacyRenderedPath ?? element.structuralPath;
    const masked = affectedByMask(path, masks);
    const temporal = isTemporal(element);
    const volatileRecord = masked || temporal;
    let text: string | undefined = normalizedText(element.directText);
    if (masked) {
      reductions.textSuppressedMask += 1;
      text = undefined;
    } else if (temporal) {
      reductions.textSuppressedTemporal += 1;
      text = undefined;
    }
    const reflowAffected = volatile.some(
      (source) =>
        !source.outOfFlow &&
        !element.outOfFlow &&
        source.stableIslandPath === element.stableIslandPath &&
        element.rect.y >= source.rect.y,
    );
    const geometry =
      masked || temporal || reflowAffected ? undefined : element.relativeRect;
    if (geometry === undefined) reductions.geometrySuppressed += 1;
    return [
      {
        path,
        selector: element.selector,
        tag: element.tag,
        ...(text === undefined ? {} : { text }),
        ...(volatileRecord
          ? {}
          : { attributes: stableAttributes(element.attributes) }),
        styles: stableV2Styles(element.styles, volatileRecord),
        ...(geometry === undefined ? {} : { geometry }),
      },
    ];
  });
  return {
    kind: "v2-full",
    records,
    signature: signature(records),
    reductions,
  };
}

type LegacyNode = {
  element: ObservedElement;
  index: number;
  parent?: LegacyNode | undefined;
  path: string;
};

function reconstructLegacy(elements: ObservedElement[]): LegacyNode[] {
  const indexed = elements.map((element, index) => ({ element, index }));
  const eligible = indexed.filter(
    ({ element }) => element.visible && !NON_CONTENT_TAGS.has(element.tag),
  );
  const bySelector = new Map<
    string,
    Array<{ element: ObservedElement; index: number }>
  >();
  for (const item of indexed) {
    const values = bySelector.get(item.element.selector) ?? [];
    values.push(item);
    bySelector.set(item.element.selector, values);
  }
  const eligibleIndices = new Set(eligible.map(({ index }) => index));
  const nodes: LegacyNode[] = [];
  const nodeByIndex = new Map<number, LegacyNode>();
  for (const item of eligible) {
    let parent: LegacyNode | undefined;
    for (const ancestorSelector of item.element.ancestorSelectors) {
      const matches = bySelector.get(ancestorSelector) ?? [];
      if (matches.length !== 1)
        throw new IdiomError(
          `legacy projection cannot resolve recorded ancestor ${JSON.stringify(ancestorSelector)} for ${item.element.selector}`,
        );
      const match = matches[0];
      if (match === undefined || match.index >= item.index)
        throw new IdiomError(
          `legacy projection ancestor ${JSON.stringify(ancestorSelector)} is not before ${item.element.selector} in document order`,
        );
      if (!eligibleIndices.has(match.index)) continue;
      parent = nodeByIndex.get(match.index);
      if (parent === undefined)
        throw new IdiomError(
          `legacy projection rendered ancestor ${JSON.stringify(ancestorSelector)} is unavailable for ${item.element.selector}`,
        );
      break;
    }
    if (parent === undefined && item.element.tag !== "html") {
      parent =
        [...nodes]
          .reverse()
          .find((node) =>
            item.element.tag === "body"
              ? node.element.tag === "html"
              : node.element.tag === "body" || node.element.tag === "html",
          ) ?? undefined;
    }
    const sibling = nodes.filter(
      (node) => node.parent === parent && node.element.tag === item.element.tag,
    ).length;
    const path = `${parent === undefined ? "" : `${parent.path}/`}${item.element.tag}[${sibling}]`;
    const node = { ...item, parent, path };
    nodes.push(node);
    nodeByIndex.set(item.index, node);
  }
  return nodes;
}

function transferMasks(
  nodes: LegacyNode[],
  membership: ObservationArtifactV2["maskMembership"] | undefined,
): ProfileReductions["maskStatus"] {
  const available = new Set(nodes.map(({ path }) => path));
  return (membership ?? []).map(({ selector, paths }) => {
    const transferred: string[] = [];
    let widened = false;
    for (const path of paths) {
      let candidate = path;
      while (!available.has(candidate) && candidate.includes("/")) {
        candidate = candidate.slice(0, candidate.lastIndexOf("/"));
        widened = true;
      }
      if (available.has(candidate)) transferred.push(candidate);
    }
    return {
      selector,
      status:
        transferred.length === 0
          ? "temporal-mask-fallback"
          : widened
            ? "widened"
            : "exact",
      paths: [...new Set(transferred)],
    };
  });
}

function buildV1(
  artifact: ObservationArtifact,
  maskMembership?: ObservationArtifactV2["maskMembership"],
): SemanticProfile {
  const reductions = baseReductions();
  const nodes = reconstructLegacy(artifact.elements);
  reductions.excludedNonRendered = artifact.elements.length - nodes.length;
  reductions.maskStatus = transferMasks(nodes, maskMembership);
  const masks = reductions.maskStatus.flatMap(({ paths }) => paths);
  const children = new Map<LegacyNode, LegacyNode[]>();
  for (const node of nodes) {
    if (node.parent === undefined) continue;
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node);
    children.set(node.parent, siblings);
  }
  // v1 text is subtree innerText; removing each child's text approximates the
  // node's own text. Capped text is unknown, so it gives no context.
  const ownTexts = new Map<LegacyNode, string>();
  const ownText = (node: LegacyNode): string => {
    const known = ownTexts.get(node);
    if (known !== undefined) return known;
    let text = node.element.text;
    if (text.length === TEXT_BOUNDARY) text = "";
    else
      for (const child of children.get(node) ?? []) {
        if (child.element.text.length > 0)
          text = text.replace(child.element.text, "");
      }
    ownTexts.set(node, text);
    return text;
  };
  const contextual = (node: LegacyNode): boolean => {
    if (!bareTemporalComponent(node.element.text)) return false;
    let ancestor = node.parent;
    for (
      let step = 0;
      step < CONTEXT_DEPTH && ancestor !== undefined;
      step += 1
    ) {
      if (ancestor.element.tag === "body" || ancestor.element.tag === "html")
        return false;
      if (
        ancestor.element.tag === "time" ||
        containsTemporal(ownText(ancestor))
      )
        return true;
      ancestor = ancestor.parent;
    }
    return false;
  };
  const temporalPaths = nodes
    .filter((node) => containsTemporal(node.element.text) || contextual(node))
    .map(({ path }) => path);
  const volatileNodes = nodes.filter(
    ({ path }) =>
      affectedByMask(path, masks) ||
      temporalPaths.some((temporal) => beneath(temporal, path)),
  );
  const records = nodes.map(({ element, parent, path }): ProfileRecord => {
    const boundary = element.text.length === TEXT_BOUNDARY;
    const maskAffected = affectedByMask(path, masks);
    const temporalAffected = temporalPaths.some((temporal) =>
      beneath(temporal, path),
    );
    let text: string | undefined = normalizedText(element.text);
    if (boundary) {
      reductions.textSuppressedBoundary += 1;
      reductions.boundaryPaths.push(path);
      text = undefined;
    } else if (maskAffected) {
      reductions.textSuppressedMask += 1;
      text = undefined;
    } else if (temporalAffected) {
      reductions.textSuppressedTemporal += 1;
      text = undefined;
    }
    const reflowAffected = volatileNodes.some(
      ({ element: source, parent: sourceParent }) =>
        sourceParent === parent &&
        !source.outOfFlow &&
        !element.outOfFlow &&
        element.rect.y >= source.rect.y,
    );
    const suppressGeometry = maskAffected || temporalAffected || reflowAffected;
    if (suppressGeometry) reductions.geometrySuppressed += 1;
    return {
      path,
      selector: element.selector,
      tag: element.tag,
      ...(text === undefined ? {} : { text }),
      styles: v1CompatibleStyles(element.styles),
      ...(suppressGeometry
        ? {}
        : { geometry: relativeRect(element.rect, parent?.element.rect) }),
    };
  });
  return {
    kind: "v1-compatible",
    records,
    signature: signature(records),
    reductions,
  };
}

export function buildSemanticProfile(options: {
  artifact: ObservationArtifact;
  kind: ProfileKind;
  maskMembership?: ObservationArtifactV2["maskMembership"] | undefined;
}): SemanticProfile {
  if (options.kind === "v2-full") {
    if (options.artifact.version !== 2)
      throw new IdiomError("v2-full comparison requires observation version 2");
    return buildV2(options.artifact);
  }
  return buildV1(options.artifact, options.maskMembership);
}

export function assertMaskAgreement(
  first: ObservationArtifact,
  second: ObservationArtifact,
): void {
  if (first.version !== 2 || second.version !== 2)
    throw new IdiomError("mask calibration requires version-2 observations");
  if (
    JSON.stringify(first.maskMembership) !==
    JSON.stringify(second.maskMembership)
  )
    throw new IdiomError(
      "current captures disagree on browser-evaluated mask membership",
    );
}
