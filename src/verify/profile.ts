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
  const volatile = artifact.elements.filter((element) => {
    const path = element.legacyRenderedPath ?? element.structuralPath;
    const temporal = element.temporal || containsTemporal(element.directText);
    return affectedByMask(path, masks) || temporal;
  });
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
    const temporal = element.temporal || containsTemporal(element.directText);
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
  const temporalPaths = nodes
    .filter(({ element }) => {
      const result = TEMPORAL.test(element.text);
      TEMPORAL.lastIndex = 0;
      return result;
    })
    .map(({ path }) => path);
  const volatileNodes = nodes.filter(
    ({ path }) =>
      affectedByMask(path, masks) ||
      temporalPaths.some((temporal) => beneath(temporal, path)),
  );
  const records = nodes.map(({ element, parent, path }): ProfileRecord => {
    const boundary = element.text.length === 500;
    const maskAffected = affectedByMask(path, masks);
    const temporalAffected = temporalPaths.some((temporal) =>
      beneath(temporal, path),
    );
    let text: string | undefined = normalizedText(element.text);
    if (boundary) {
      reductions.textSuppressedBoundary += 1;
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
