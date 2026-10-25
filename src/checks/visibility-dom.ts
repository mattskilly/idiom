import type { Page } from "playwright";
import type { Rect, VisibilityGeometry } from "./types.js";

type VisibilityQuery = { selector: string; within?: string | undefined };
type VisibilityResult = {
  visible: boolean;
  reason?: string;
  boundary?: string;
};

type VisibilityDom = {
  measure(element: Element, within?: Element): VisibilityGeometry;
  extent(element: Element, stop: Element): Rect | undefined;
  client(element: Element): Rect;
};
declare global {
  interface Window {
    __idiomVisibility: VisibilityDom;
  }
}

/**
 * Install and optionally measure in one browser evaluation so document
 * navigation cannot separate helper installation from its use.
 * All geometry is viewport-relative.
 */
function installVisibilityDom(
  query?: VisibilityQuery,
): VisibilityResult | undefined {
  const box = (r: DOMRect): Rect => ({
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  });
  const intersect = (a: Rect, b: Rect, x = true, y = true): Rect => {
    const left = x ? Math.max(a.x, b.x) : a.x;
    const top = y ? Math.max(a.y, b.y) : a.y;
    return {
      x: left,
      y: top,
      width: x
        ? Math.max(0, Math.min(a.x + a.width, b.x + b.width) - left)
        : a.width,
      height: y
        ? Math.max(0, Math.min(a.y + a.height, b.y + b.height) - top)
        : a.height,
    };
  };
  const client = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    const sx =
      el instanceof HTMLElement && el.offsetWidth > 0
        ? r.width / el.offsetWidth
        : 1;
    const sy =
      el instanceof HTMLElement && el.offsetHeight > 0
        ? r.height / el.offsetHeight
        : 1;
    return {
      x: r.x + el.clientLeft * sx,
      y: r.y + el.clientTop * sy,
      width: el.clientWidth * sx,
      height: el.clientHeight * sy,
    };
  };
  const name = (el: Element) =>
    el.id
      ? `#${CSS.escape(el.id)}`
      : `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${CSS.escape(c)}`).join("")}`;
  const containsFixed = (s: CSSStyleDeclaration) =>
    s.transform !== "none" ||
    s.perspective !== "none" ||
    [s.translate, s.rotate, s.scale].some((v) => v && v !== "none") ||
    s.filter !== "none" ||
    (s.backdropFilter !== "" && s.backdropFilter !== "none") ||
    /\b(layout|paint|strict|content)\b/.test(s.contain) ||
    /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter|contain)\b/.test(
      s.willChange,
    ) ||
    ["auto", "hidden"].includes(s.contentVisibility);
  const paintClip = (el: Element, r: Rect): Rect => {
    const s = getComputedStyle(el);
    let result = r;
    // Legacy sr-only patterns clip paint without removing scroll geometry.
    if (s.clip !== "auto" && ["absolute", "fixed"].includes(s.position)) {
      const values = s.clip
        .match(/^rect\((.*)\)$/)?.[1]
        ?.split(/[,\s]+/)
        .filter(Boolean);
      if (values?.length === 4) {
        const edge = (index: number, fallback: number) =>
          values[index] === "auto"
            ? fallback
            : Number.parseFloat(values[index] ?? "0");
        const top = edge(0, 0),
          right = edge(1, r.width),
          bottom = edge(2, r.height),
          left = edge(3, 0);
        result = intersect(result, {
          x: r.x + left,
          y: r.y + top,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
        });
      }
    }
    const inset = s.clipPath
      .match(/^inset\(([^)]+)\)$/)?.[1]
      ?.split(/\s+round\s+/)[0]
      ?.split(/\s+/);
    if (inset && inset.length >= 1 && inset.length <= 4) {
      const values = [
        inset[0],
        inset[1] ?? inset[0],
        inset[2] ?? inset[0],
        inset[3] ?? inset[1] ?? inset[0],
      ];
      const edges = values.map(
        (v, i) =>
          Number.parseFloat(v ?? "0") *
          (v?.endsWith("%") ? (i % 2 ? r.width : r.height) / 100 : 1),
      );
      const [t = 0, right = 0, b = 0, l = 0] = edges;
      result = intersect(result, {
        x: r.x + l,
        y: r.y + t,
        width: Math.max(0, r.width - l - right),
        height: Math.max(0, r.height - t - b),
      });
    }
    return result;
  };
  const clipped = (element: Element, stop?: Element, paint = true) => {
    let result = box(element.getBoundingClientRect());
    let boundary: string | undefined;
    let escaping: "absolute" | "fixed" | undefined;
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      const s = getComputedStyle(current);
      if (
        escaping &&
        (containsFixed(s) ||
          (escaping === "absolute" && s.position !== "static"))
      )
        escaping = undefined;
      if (current === stop)
        return { rect: result, boundary, contributes: escaping === undefined };
      const before = result;
      if (!escaping) {
        if (
          paint &&
          ((s.clip !== "auto" && ["absolute", "fixed"].includes(s.position)) ||
            s.clipPath.startsWith("inset("))
        )
          result = intersect(
            result,
            paintClip(current, box(current.getBoundingClientRect())),
          );
        if (
          current !== element &&
          current !== document.body &&
          current !== document.documentElement
        ) {
          const contained = /\b(paint|strict|content)\b/.test(s.contain);
          const x = contained || s.overflowX !== "visible";
          const y = contained || s.overflowY !== "visible";
          if (x || y) result = intersect(result, client(current), x, y);
        }
      }
      if (
        before.width > 0 &&
        before.height > 0 &&
        (result.width === 0 || result.height === 0)
      )
        boundary = name(current);
      if (s.position === "fixed") escaping = "fixed";
      else if (s.position === "absolute" && escaping !== "fixed")
        escaping = "absolute";
    }
    return { rect: result, boundary, contributes: escaping !== "fixed" };
  };
  const measure = (element: Element, within?: Element): VisibilityGeometry => {
    const rect = box(element.getBoundingClientRect());
    const base = { rect, client: client(element) };
    const invisible = (
      reason: string,
      boundary: string,
    ): VisibilityGeometry => ({
      ...base,
      visible: { ...rect, width: 0, height: 0 },
      rendered: false,
      reason,
      boundary,
    });
    if (within && within !== element && !within.contains(element))
      return invisible("target is outside declared boundary", name(within));
    if (
      element.getClientRects().length === 0 ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      return invisible("target has no positive-area layout box", name(element));
    if (getComputedStyle(element).visibility !== "visible")
      return invisible("target is CSS-hidden", name(element));
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      const s = getComputedStyle(current);
      if (
        s.display === "none" ||
        Number(s.opacity) === 0 ||
        s.contentVisibility === "hidden"
      )
        return invisible("target is CSS-hidden", name(current));
    }
    const clip = clipped(element);
    let visible = clip.rect;
    let boundary = clip.boundary;
    if (within) {
      visible = intersect(visible, client(within));
      if (visible.width <= 0 || visible.height <= 0) boundary ??= name(within);
    }
    visible = intersect(visible, {
      x: 0,
      y: 0,
      width: innerWidth,
      height: innerHeight,
    });
    if (visible.width <= 0 || visible.height <= 0)
      return {
        ...base,
        visible,
        rendered: true,
        reason: "target is outside visible bounds",
        boundary: boundary ?? "viewport",
      };
    return { ...base, visible, rendered: true };
  };
  window.__idiomVisibility = {
    measure,
    client,
    extent: (element, stop) => {
      if (element.getClientRects().length === 0) return undefined;
      const result = clipped(element, stop, false);
      return result.contributes &&
        result.rect.width > 0 &&
        result.rect.height > 0
        ? result.rect
        : undefined;
    },
  };
  if (query === undefined) return;
  const { selector, within } = query;
  try {
    const targets = document.querySelectorAll(selector);
    if (targets.length !== 1)
      return {
        visible: false,
        reason: `target matches ${targets.length} elements`,
        boundary: selector,
      };
    let boundary: Element | undefined;
    if (within !== undefined) {
      const boundaries = document.querySelectorAll(within);
      if (boundaries.length !== 1)
        return {
          visible: false,
          reason: `boundary matches ${boundaries.length} elements`,
          boundary: within,
        };
      boundary = boundaries[0];
    }
    const target = targets[0];
    if (!target)
      return {
        visible: false,
        reason: "target missing",
        boundary: selector,
      };
    const result = window.__idiomVisibility.measure(target, boundary);
    return {
      visible:
        result.rendered &&
        result.visible.width > 0 &&
        result.visible.height > 0,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.boundary ? { boundary: result.boundary } : {}),
    };
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "SyntaxError"))
      throw error;
    return {
      visible: false,
      reason: `invalid selector: ${String(error)}`,
      boundary: within ?? selector,
    };
  }
}

export async function ensureVisibilityDom(page: Page): Promise<void> {
  await page.evaluate(installVisibilityDom, undefined);
}

export async function targetVisibility(
  page: Page,
  selector: string,
  within?: string,
): Promise<VisibilityResult> {
  const result = await page.evaluate(installVisibilityDom, {
    selector,
    within,
  });
  if (result === undefined)
    throw new Error("visibility measurement did not return a result");
  return result;
}
