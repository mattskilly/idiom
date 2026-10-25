import type { Page } from "playwright";

/** Browser-only helpers shared by static and temporal explanation collection. */
export type ExplanationDom = {
  document: Document;
  identity(element: Element): string;
  text(element: Element, excludeTooltips?: boolean): string;
  visible(element: Element): boolean;
  fingerprint(element: Element): string;
};
export type ExplanationDomWindow = Window & {
  __idiomExplanationDom?: ExplanationDom;
};

// Playwright serializes this function, so all runtime dependencies stay inside it.
export function installExplanationDom(documentId: string): void {
  const scope = window as ExplanationDomWindow;
  if (scope.__idiomExplanationDom?.document === document) return;
  const identities = new WeakMap<Element, string>();
  let nextId = 0;
  type Box = { left: number; top: number; right: number; bottom: number };
  const positive = (box: Box) => box.right > box.left && box.bottom > box.top;
  const intersect = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const offset = (value: string, size: number): number =>
    value.endsWith("%")
      ? (Number.parseFloat(value) * size) / 100
      : Number.parseFloat(value);
  const clipFor = (owner: Element, textPaint = true): Box | undefined => {
    if (getComputedStyle(owner).visibility !== "visible") return undefined;
    // Full-page captures paint the whole scrollable document, so the root clip
    // is its extent rather than the initial viewport.
    const root = document.documentElement;
    const body = document.body;
    let clip: Box = {
      left: -scrollX,
      top: -scrollY,
      right: Math.max(root.scrollWidth, innerWidth) - scrollX,
      bottom: Math.max(root.scrollHeight, innerHeight) - scrollY,
    };
    // Root overflow (and body overflow propagated to it) clips the viewport,
    // which the document extent already stands in for.
    const viewportOverflow = (element: Element): boolean =>
      element === root ||
      (element === body &&
        getComputedStyle(root).overflowX === "visible" &&
        getComputedStyle(root).overflowY === "visible");
    let current: Element | null = owner;
    while (current) {
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        Number(style.opacity) <= 0 ||
        /opacity\(0(?:%|\.0*)?\)/.test(style.filter)
      )
        return undefined;
      if (style.display !== "contents") {
        const rect = current.getBoundingClientRect();
        if (
          style.clip !== "auto" &&
          ["absolute", "fixed"].includes(style.position)
        ) {
          const values = style.clip
            .replace(/^rect\(|\)$/g, "")
            .split(/[,\s]+/)
            .filter(Boolean);
          if (values.length !== 4) return undefined;
          const [top, right, bottom, left] = values.map((value, index) =>
            value === "auto"
              ? index === 0 || index === 3
                ? 0
                : index === 1
                  ? rect.width
                  : rect.height
              : Number.parseFloat(value),
          );
          if (
            [top, right, bottom, left].some(
              (value) => value === undefined || !Number.isFinite(value),
            )
          )
            return undefined;
          clip = intersect(clip, {
            left: rect.left + (left ?? 0),
            top: rect.top + (top ?? 0),
            right: rect.left + (right ?? 0),
            bottom: rect.top + (bottom ?? 0),
          });
        }
        if (style.clipPath !== "none") {
          const inset = /^inset\(([^)]+)\)$/.exec(style.clipPath);
          // Do not skip a possibly visible control merely because its shape
          // cannot establish positive text paint (for example an SVG mask).
          if (!inset && textPaint) return undefined;
          if (inset) {
            const values =
              (inset[1] ?? "")
                .split(/\s+round\s+/)[0]
                ?.trim()
                .split(/\s+/) ?? [];
            if (values.length < 1 || values.length > 4) return undefined;
            const top = offset(values[0] ?? "", rect.height);
            const right = offset(values[1] ?? values[0] ?? "", rect.width);
            const bottom = offset(values[2] ?? values[0] ?? "", rect.height);
            const left = offset(
              values[3] ?? values[1] ?? values[0] ?? "",
              rect.width,
            );
            if (![top, right, bottom, left].every(Number.isFinite))
              return undefined;
            clip = intersect(clip, {
              left: rect.left + left,
              top: rect.top + top,
              right: rect.right - right,
              bottom: rect.bottom - bottom,
            });
          }
        }
        if (style.display !== "inline" && !viewportOverflow(current)) {
          const html = current as HTMLElement;
          const scaleX = html.offsetWidth ? rect.width / html.offsetWidth : 1;
          const scaleY = html.offsetHeight
            ? rect.height / html.offsetHeight
            : 1;
          const left = rect.left + current.clientLeft * scaleX;
          const top = rect.top + current.clientTop * scaleY;
          if (["hidden", "clip", "scroll", "auto"].includes(style.overflowX)) {
            clip.left = Math.max(clip.left, left);
            clip.right = Math.min(
              clip.right,
              left + current.clientWidth * scaleX,
            );
          }
          if (["hidden", "clip", "scroll", "auto"].includes(style.overflowY)) {
            clip.top = Math.max(clip.top, top);
            clip.bottom = Math.min(
              clip.bottom,
              top + current.clientHeight * scaleY,
            );
          }
        }
      }
      if (!positive(clip)) return undefined;
      current = current.parentElement;
    }
    return clip;
  };
  const alpha = (color: string): number => {
    if (color === "transparent") return 0;
    const slash = /\/\s*([\d.]+)(%)?\s*\)$/.exec(color);
    if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
    const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(color);
    return rgba ? Number(rgba[1]) : 1;
  };
  const text = (element: Element, excludeTooltips = false): string => {
    const parts: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const owner = node.parentElement;
      if (
        owner &&
        node.textContent?.trim() &&
        !(excludeTooltips && owner.closest("[role=tooltip]"))
      ) {
        const clip = clipFor(owner);
        const style = getComputedStyle(owner);
        const fill =
          style.getPropertyValue("-webkit-text-fill-color") || style.color;
        if (clip && alpha(fill) > 0) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = [...range.getClientRects()];
          if (rects.some((rect) => positive(intersect(rect, clip)))) {
            if (
              rects.every(
                (rect) =>
                  rect.left >= clip.left &&
                  rect.top >= clip.top &&
                  rect.right <= clip.right &&
                  rect.bottom <= clip.bottom,
              )
            )
              parts.push(node.textContent);
            else {
              // A clipped sentence cannot contribute words that never paint.
              let painted = "";
              for (let index = 0; index < node.textContent.length; index++) {
                range.setStart(node, index);
                range.setEnd(node, index + 1);
                if (
                  [...range.getClientRects()].some((rect) =>
                    positive(intersect(rect, clip)),
                  )
                )
                  painted += node.textContent[index];
              }
              parts.push(painted);
            }
          }
        }
      }
      node = walker.nextNode();
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };
  scope.__idiomExplanationDom = {
    document,
    text,
    identity(element) {
      let id = identities.get(element);
      if (!id) {
        id = `${documentId}:${++nextId}`;
        identities.set(element, id);
      }
      return id;
    },
    visible(element) {
      const clip = clipFor(element, false);
      return (
        clip !== undefined &&
        [...element.getClientRects()].some((rect) =>
          positive(intersect(rect, clip)),
        )
      );
    },
    fingerprint(element) {
      return JSON.stringify([
        element.tagName,
        ...["role", "aria-label", "title", "href", "aria-disabled"].map(
          (name) => element.getAttribute(name),
        ),
        (element.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? ""),
        text(element, true),
        element.matches(":disabled"),
      ]);
    },
  };
}

// Page-local installation epochs distinguish navigations while keeping identical
// capture sequences reproducible. DOM node ordinals distinguish replacements.
const installations = new WeakMap<Page, number>();
export async function ensureExplanationDom(page: Page): Promise<void> {
  const epoch = (installations.get(page) ?? 0) + 1;
  installations.set(page, epoch);
  await page.evaluate(installExplanationDom, `document-${epoch}`);
}
