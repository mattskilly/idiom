import { observationArtifactSchema } from "../../checks/artifact-schema.js";
import type {
  ExpandedObservedStyles,
  ObservationArtifactV2,
  ObservedElementV2,
  Rect,
} from "../../checks/types.js";
import {
  type FigmaColor,
  type FigmaNode,
  type FigmaPaint,
  type FigmaVariables,
  isVariableAlias,
} from "./types.js";
import { figmaNodeLink } from "./url.js";

const AUTO_NAME =
  /^(Frame|Group|Rectangle|Ellipse|Vector|Text|Line|Polygon|Star|Instance|Component|Section|Image|Union|Subtract)( \d+)?$/;
const VECTOR_TYPES = new Set([
  "VECTOR",
  "ELLIPSE",
  "LINE",
  "STAR",
  "REGULAR_POLYGON",
  "BOOLEAN_OPERATION",
]);
const SKIPPED_TYPES = new Set(["SLICE", "STICKY", "CONNECTOR"]);
const WRAPPER_TYPES = new Set(["FRAME", "INSTANCE", "COMPONENT"]);
const TRANSPARENT = "rgba(0, 0, 0, 0)";

const px = (value: number) => `${Math.round(value * 100) / 100}px`;
const round = (value: number) => Math.round(value * 100) / 100;
const channel = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value * 255)));
function cssColor(color: FigmaColor, opacity = 1): string {
  const alpha = Math.round((color.a ?? 1) * opacity * 1000) / 1000;
  const rgb = `${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}`;
  return alpha >= 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${alpha})`;
}
const visible = (node: { visible?: boolean | undefined }) =>
  node.visible !== false;
/** The topmost visible solid paint; Figma lists paints bottom to top. */
function solid(paints: FigmaPaint[] | undefined): FigmaPaint | undefined {
  return [...(paints ?? [])]
    .reverse()
    .find((paint) => visible(paint) && paint.type === "SOLID" && paint.color);
}
const paintColor = (paint: FigmaPaint | undefined) =>
  paint?.color ? cssColor(paint.color, paint.opacity ?? 1) : undefined;

export const isAutoName = (name: string) => AUTO_NAME.test(name.trim());
export function inferredRole(name: string): string {
  if (/\b(?:button|btn|cta)\b/i.test(name)) return "button";
  if (/\blink\b/i.test(name)) return "link";
  if (/\b(?:input|field|textbox)\b/i.test(name)) return "textbox";
  return "";
}

function baseStyles(): ExpandedObservedStyles {
  return {
    color: "rgb(0, 0, 0)",
    backgroundColor: TRANSPARENT,
    borderTopColor: "rgb(0, 0, 0)",
    borderRightColor: "rgb(0, 0, 0)",
    borderBottomColor: "rgb(0, 0, 0)",
    borderLeftColor: "rgb(0, 0, 0)",
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderTopStyle: "none",
    borderRightStyle: "none",
    borderBottomStyle: "none",
    borderLeftStyle: "none",
    outlineColor: "rgb(0, 0, 0)",
    outlineWidth: "0px",
    outlineStyle: "none",
    fill: "rgb(0, 0, 0)",
    stroke: "none",
    borderTopLeftRadius: "0px",
    borderTopRightRadius: "0px",
    borderBottomRightRadius: "0px",
    borderBottomLeftRadius: "0px",
    overflowX: "visible",
    overflowY: "visible",
    position: "static",
    display: "block",
    visibility: "visible",
    opacity: "1",
    fontFamily: "",
    fontSize: "16px",
    fontWeight: "400",
    lineHeight: "normal",
    letterSpacing: "normal",
    textAlign: "start",
    textDecorationLine: "none",
    textTransform: "none",
    whiteSpace: "normal",
    wordBreak: "normal",
    paddingTop: "0px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
    marginTop: "0px",
    marginRight: "0px",
    marginBottom: "0px",
    marginLeft: "0px",
    gap: "normal",
    flexDirection: "row",
    justifyContent: "normal",
    alignItems: "normal",
    gridTemplateColumns: "none",
    boxShadow: "none",
    transform: "none",
    zIndex: "auto",
  };
}

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;
function boxStyles(node: FigmaNode, styles: ExpandedObservedStyles) {
  const stroke = solid(node.strokes);
  if (stroke) {
    const color = paintColor(stroke) ?? "rgb(0, 0, 0)";
    for (const side of SIDES) {
      const weight =
        node.individualStrokeWeights?.[
          side.toLowerCase() as "top" | "right" | "bottom" | "left"
        ] ??
        node.strokeWeight ??
        1;
      styles[`border${side}Width`] = px(weight);
      styles[`border${side}Style`] = weight > 0 ? "solid" : "none";
      styles[`border${side}Color`] = color;
    }
  }
  const radii = node.rectangleCornerRadii ?? [
    node.cornerRadius ?? 0,
    node.cornerRadius ?? 0,
    node.cornerRadius ?? 0,
    node.cornerRadius ?? 0,
  ];
  styles.borderTopLeftRadius = px(radii[0] ?? 0);
  styles.borderTopRightRadius = px(radii[1] ?? 0);
  styles.borderBottomRightRadius = px(radii[2] ?? 0);
  styles.borderBottomLeftRadius = px(radii[3] ?? 0);
  if (node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL") {
    styles.display = "flex";
    styles.flexDirection = node.layoutMode === "HORIZONTAL" ? "row" : "column";
    styles.gap = px(node.itemSpacing ?? 0);
  }
  styles.paddingTop = px(node.paddingTop ?? 0);
  styles.paddingRight = px(node.paddingRight ?? 0);
  styles.paddingBottom = px(node.paddingBottom ?? 0);
  styles.paddingLeft = px(node.paddingLeft ?? 0);
  if (node.opacity !== undefined) styles.opacity = String(round(node.opacity));
}
function textStyles(text: FigmaNode, styles: ExpandedObservedStyles) {
  const style = text.style ?? {};
  if (style.fontFamily !== undefined) styles.fontFamily = style.fontFamily;
  if (style.fontSize !== undefined) styles.fontSize = px(style.fontSize);
  if (style.fontWeight !== undefined)
    styles.fontWeight = String(style.fontWeight);
  styles.lineHeight =
    style.lineHeightUnit === "INTRINSIC_%" || style.lineHeightPx === undefined
      ? "normal"
      : px(style.lineHeightPx);
  if (style.letterSpacing !== undefined)
    styles.letterSpacing = px(style.letterSpacing);
  styles.textAlign =
    (
      {
        LEFT: "left",
        CENTER: "center",
        RIGHT: "right",
        JUSTIFIED: "justify",
      } as Record<string, string>
    )[style.textAlignHorizontal ?? ""] ?? "start";
  styles.color = paintColor(solid(text.fills)) ?? "rgb(0, 0, 0)";
}

/** `{ property: variableName }` for each alias that resolves locally. */
function boundNames(
  node: FigmaNode,
  text: FigmaNode | undefined,
  vector: boolean,
  variables: FigmaVariables | undefined,
): Record<string, string> {
  if (!variables) return {};
  const names: Record<string, string> = {};
  const name = (alias: unknown) =>
    isVariableAlias(alias)
      ? variables.meta.variables[alias.id]?.name
      : undefined;
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const paintAlias = (owner: FigmaNode, key: "fills" | "strokes") =>
    first(owner.boundVariables?.[key]) ??
    solid(owner[key])?.boundVariables?.color;
  const set = (property: string, alias: unknown) => {
    const resolved = name(alias);
    if (resolved) names[property] = resolved;
  };
  set(vector ? "fill" : "backgroundColor", paintAlias(node, "fills"));
  set("borderColor", paintAlias(node, "strokes"));
  if (text) set("color", paintAlias(text, "fills"));
  const bound = node.boundVariables ?? {};
  set("gap", bound.itemSpacing);
  set("borderWidth", bound.strokeWeight);
  for (const [key, property] of [
    ["topLeftRadius", "borderTopLeftRadius"],
    ["topRightRadius", "borderTopRightRadius"],
    ["bottomRightRadius", "borderBottomRightRadius"],
    ["bottomLeftRadius", "borderBottomLeftRadius"],
    ["paddingTop", "paddingTop"],
    ["paddingRight", "paddingRight"],
    ["paddingBottom", "paddingBottom"],
    ["paddingLeft", "paddingLeft"],
  ] as const)
    set(property, bound[key]);
  const textBound = text?.boundVariables ?? {};
  for (const key of ["fontSize", "fontWeight", "lineHeight", "fontFamily"])
    set(key, first(textBound[key]));
  return names;
}

export type FigmaObservationOptions = {
  viewport: { width: number; height: number };
  fileKey: string;
  variables?: FigmaVariables | undefined;
};

/**
 * Normalise a Figma frame into the comparison core's element model. The frame
 * becomes a synthetic transparent `html` plus a `body` carrying the frame
 * itself, so the matcher seeds both roots exactly as for an HTML design.
 */
export function figmaObservation(
  frame: FigmaNode,
  options: FigmaObservationOptions,
): ObservationArtifactV2 {
  const origin = frame.absoluteBoundingBox ?? {
    x: 0,
    y: 0,
    width: options.viewport.width,
    height: options.viewport.height,
  };
  const elements: ObservedElementV2[] = [];
  const signals = (
    rect: Rect,
    role: string,
    name: string,
    extra: { lineCount?: number; hasGraphic?: boolean } = {},
  ): NonNullable<ObservedElementV2["signals"]> => ({
    role,
    name,
    described: false,
    appearance: "none",
    cursor: "auto",
    hasGraphic: extra.hasGraphic ?? false,
    lineCount: extra.lineCount ?? 0,
    contentBox: rect,
    transition: "",
    animation: "",
    focused: false,
    repeatedItem: false,
  });
  const element = (fields: {
    selector: string;
    tag: string;
    path: string;
    ancestors: string[];
    rect: Rect;
    styles: ExpandedObservedStyles;
    attributes: Record<string, string>;
    text?: string;
    interactive?: boolean;
    signals?: ObservedElementV2["signals"];
  }): ObservedElementV2 => ({
    selector: fields.selector,
    tag: fields.tag,
    text: fields.text ?? "",
    visible: true,
    interactive: fields.interactive ?? false,
    enabled: true,
    rect: fields.rect,
    scrollWidth: fields.rect.width,
    scrollHeight: fields.rect.height,
    clientWidth: fields.rect.width,
    clientHeight: fields.rect.height,
    outOfFlow: false,
    ancestorSelectors: fields.ancestors,
    styles: fields.styles,
    hitTestWith: [],
    ...(fields.signals ? { signals: fields.signals } : {}),
    structuralPath: fields.path,
    directText: fields.text ?? "",
    attributes: fields.attributes,
    temporal: false,
    stableIslandPath: fields.path,
    relativeRect: fields.rect,
  });
  const relative = (node: FigmaNode): Rect | undefined => {
    const box = node.absoluteBoundingBox;
    if (!box) return undefined;
    return {
      x: round(box.x - origin.x),
      y: round(box.y - origin.y),
      width: round(box.width),
      height: round(box.height),
    };
  };
  const figmaAttributes = (
    node: FigmaNode,
    path: string[],
    variables: Record<string, string>,
  ) => {
    const name = node.name?.trim() ?? "";
    return {
      "data-idiom-source": "figma",
      "data-figma-id": node.id,
      ...(name && !isAutoName(name) ? { "data-figma-name": name } : {}),
      "data-figma-path": path.join(" / "),
      "data-figma-link": figmaNodeLink(options.fileKey, node.id),
      ...(Object.keys(variables).length
        ? {
            "data-figma-variables": JSON.stringify(
              Object.fromEntries(
                Object.entries(variables).sort(([a], [b]) =>
                  a.localeCompare(b),
                ),
              ),
            ),
          }
        : {}),
    };
  };
  const rootRect: Rect = {
    x: 0,
    y: 0,
    width: options.viewport.width,
    height: round(origin.height),
  };
  elements.push(
    element({
      selector: "figma:root",
      tag: "html",
      path: "figma",
      ancestors: [],
      rect: rootRect,
      styles: baseStyles(),
      attributes: { "data-idiom-source": "figma" },
    }),
  );
  const frameStyles = baseStyles();
  boxStyles(frame, frameStyles);
  frameStyles.opacity = "1";
  frameStyles.backgroundColor = paintColor(solid(frame.fills)) ?? TRANSPARENT;
  const frameName = frame.name?.trim() ?? "";
  const bodySelector = `figma:${frame.id}`;
  elements.push(
    element({
      selector: bodySelector,
      tag: "body",
      path: "figma/0",
      ancestors: ["figma:root"],
      rect: rootRect,
      styles: frameStyles,
      attributes: {
        ...figmaAttributes(
          frame,
          [frameName || frame.id],
          boundNames(frame, undefined, false, options.variables),
        ),
        "data-figma-frame-width": String(round(origin.width)),
      },
      signals: signals(rootRect, "", frameName),
    }),
  );
  const walk = (
    node: FigmaNode,
    path: string,
    ancestors: string[],
    names: string[],
  ) => {
    let index = 0;
    for (const child of node.children ?? []) {
      if (
        !visible(child) ||
        child.opacity === 0 ||
        SKIPPED_TYPES.has(child.type)
      )
        continue;
      const rect = relative(child);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const childPath = `${path}/${index++}`,
        selector = `figma:${child.id}`,
        layer = child.name?.trim() ?? "",
        layerNames = [...names, layer || child.id];
      const visibleKids = (child.children ?? []).filter(
        (kid) => visible(kid) && kid.opacity !== 0,
      );
      const folded =
        WRAPPER_TYPES.has(child.type) &&
        visibleKids.length === 1 &&
        visibleKids[0]?.type === "TEXT"
          ? visibleKids[0]
          : undefined;
      const text = child.type === "TEXT" ? child : folded;
      const vector = VECTOR_TYPES.has(child.type);
      const styles = baseStyles();
      boxStyles(child, styles);
      if (vector) {
        styles.fill = paintColor(solid(child.fills)) ?? "none";
        styles.stroke = paintColor(solid(child.strokes)) ?? "none";
        for (const side of SIDES) {
          styles[`border${side}Width`] = "0px";
          styles[`border${side}Style`] = "none";
        }
      } else if (child.type !== "TEXT")
        styles.backgroundColor = paintColor(solid(child.fills)) ?? TRANSPARENT;
      if (child.type === "TEXT")
        for (const side of SIDES) {
          styles[`border${side}Width`] = "0px";
          styles[`border${side}Style`] = "none";
        }
      if (text) textStyles(text, styles);
      const characters = text?.characters?.replace(/\s+/g, " ").trim() ?? "";
      const hint = layer && !isAutoName(layer) ? layer : "";
      const role = inferredRole(
        `${layer} ${child.type === "INSTANCE" ? (child.componentId ?? "") : ""}`,
      );
      const lineHeight = Number.parseFloat(styles.lineHeight);
      elements.push(
        element({
          selector,
          tag: vector ? "svg" : child.type === "TEXT" ? "span" : "div",
          path: childPath,
          ancestors,
          rect,
          styles,
          attributes: figmaAttributes(
            child,
            layerNames,
            boundNames(child, text, vector, options.variables),
          ),
          text: characters,
          interactive: role !== "",
          signals: signals(rect, role, hint || characters, {
            hasGraphic: vector,
            lineCount: characters
              ? Math.max(
                  1,
                  Math.round(
                    rect.height /
                      (Number.isFinite(lineHeight) && lineHeight > 0
                        ? lineHeight
                        : Number.parseFloat(styles.fontSize) * 1.2),
                  ),
                )
              : 0,
          }),
        }),
      );
      if (!folded && !vector)
        walk(child, childPath, [selector, ...ancestors], layerNames);
    }
  };
  walk(frame, "figma/0", [bodySelector, "figma:root"], [frameName || frame.id]);
  const height = round(origin.height);
  return observationArtifactSchema.parse({
    version: 2,
    viewport: options.viewport,
    document: {
      scrollWidth: options.viewport.width,
      scrollHeight: height,
      clientWidth: options.viewport.width,
      clientHeight: options.viewport.height,
    },
    headings: [],
    tokens: { status: "not-configured" },
    elements,
    maskMembership: [],
  }) as ObservationArtifactV2;
}
