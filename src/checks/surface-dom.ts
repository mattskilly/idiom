import type { Rect } from "./types.js";

type SurfaceDom = {
  selector(el: Element): string;
  box(el: Element): Rect;
  intersect(a: Rect, b: Rect): Rect;
  visible(el: Element): Rect | undefined;
  opacity(el: Element): number;
  matches(el: Element, selectors: string[], wrappers?: boolean): boolean;
};
declare global {
  interface Window {
    __idiomSurface: SurfaceDom;
  }
}

/** Serializable helpers shared by the two collectors; visibility deliberately retains opacity-zero media. */
export function installSurfaceDom(): void {
  const box = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const intersect = (a: Rect, b: Rect): Rect => {
    const x = Math.max(a.x, b.x),
      y = Math.max(a.y, b.y);
    return {
      x,
      y,
      width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
      height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
    };
  };
  const selector = (el: Element): string => {
    if (
      el.id &&
      !/^radix-|^headlessui-|:r\w+:|«r[0-9a-z]+»|_r_\w+_/.test(el.id)
    ) {
      const s = `#${CSS.escape(el.id)}`;
      if (document.querySelectorAll(s).length === 1) return s;
    }
    for (const key of [
      "data-testid",
      "data-test",
      "data-id",
      "name",
      "aria-label",
      "role",
    ]) {
      const value = el.getAttribute(key);
      if (!value) continue;
      const s = `${el.tagName.toLowerCase()}[${key}=${JSON.stringify(value)}]`;
      if (document.querySelectorAll(s).length === 1) return s;
    }
    const parts: string[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const tag = n.tagName.toLowerCase();
      const siblings: Element[] = n.parentElement
        ? [...n.parentElement.children].filter((c) => c.tagName === n?.tagName)
        : [];
      parts.unshift(
        siblings.length > 1
          ? `${tag}:nth-of-type(${siblings.indexOf(n) + 1})`
          : tag,
      );
    }
    return parts.join(" > ");
  };
  const visible = (el: Element): Rect | undefined => {
    if (!el.isConnected || el.closest("[inert], [hidden]")) return;
    let r = box(el);
    let escaping: "absolute" | "fixed" | undefined;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (
        s.display === "none" ||
        s.visibility === "hidden" ||
        s.visibility === "collapse" ||
        s.contentVisibility === "hidden"
      )
        return;
      if (
        n instanceof HTMLDetailsElement &&
        !n.open &&
        !n.querySelector("summary")?.contains(el)
      )
        return;
      const containsFixed =
        s.display !== "contents" &&
        (s.transform !== "none" ||
          s.perspective !== "none" ||
          s.filter !== "none" ||
          (s.backdropFilter !== "" && s.backdropFilter !== "none") ||
          [s.translate, s.rotate, s.scale].some((v) => v && v !== "none") ||
          /\b(layout|paint|strict|content)\b/.test(s.contain) ||
          /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter|contain)\b/.test(
            s.willChange,
          ));
      if (
        escaping &&
        (containsFixed ||
          (escaping === "absolute" &&
            s.position !== "static" &&
            s.display !== "contents"))
      )
        escaping = undefined;
      const clips = !escaping && s.display !== "contents";
      const contained = /\b(paint|strict|content)\b/.test(s.contain);
      const clipX = contained || /(hidden|clip|scroll|auto)/.test(s.overflowX);
      const clipY = contained || /(hidden|clip|scroll|auto)/.test(s.overflowY);
      if (
        clips &&
        n !== el &&
        n !== document.scrollingElement &&
        (clipX || clipY)
      ) {
        const b = box(n);
        const sx =
          n instanceof HTMLElement && n.offsetWidth > 0
            ? b.width / n.offsetWidth
            : 1;
        const sy =
          n instanceof HTMLElement && n.offsetHeight > 0
            ? b.height / n.offsetHeight
            : 1;
        r = intersect(r, {
          x: clipX ? b.x + n.clientLeft * sx : r.x,
          y: clipY ? b.y + n.clientTop * sy : r.y,
          width: clipX ? n.clientWidth * sx : r.width,
          height: clipY ? n.clientHeight * sy : r.height,
        });
      }
      if (clips && /^inset\(/.test(s.clipPath)) {
        const values = s.clipPath.slice(6, -1).split(/\s+/);
        const b = box(n);
        const edge = (i: number, size: number) => {
          const v = values[i] ?? values[i % 2] ?? values[0] ?? "0";
          return (
            (Number.parseFloat(v) || 0) * (v.endsWith("%") ? size / 100 : 1)
          );
        };
        r = intersect(r, {
          x: b.x + edge(3, b.width),
          y: b.y + edge(0, b.height),
          width: Math.max(0, b.width - edge(1, b.width) - edge(3, b.width)),
          height: Math.max(0, b.height - edge(0, b.height) - edge(2, b.height)),
        });
      }
      if (
        clips &&
        ["absolute", "fixed"].includes(s.position) &&
        s.clip !== "auto" &&
        /^rect\(/.test(s.clip)
      ) {
        const v = s.clip.match(/[\d.-]+(?=px)/g)?.map(Number);
        if (v?.length === 4) {
          const b = box(n);
          r = intersect(r, {
            x: b.x + (v[3] ?? 0),
            y: b.y + (v[0] ?? 0),
            width: (v[1] ?? 0) - (v[3] ?? 0),
            height: (v[2] ?? 0) - (v[0] ?? 0),
          });
        }
      }
      if (s.position === "fixed") escaping = "fixed";
      else if (s.position === "absolute" && escaping !== "fixed")
        escaping = "absolute";
    }
    const root = document.documentElement;
    r = intersect(r, {
      x: -scrollX,
      y: -scrollY,
      width: Math.max(root.scrollWidth, innerWidth),
      height: Math.max(root.scrollHeight, innerHeight),
    });
    return r.width > 0 && r.height > 0 ? r : undefined;
  };
  const opacity = (el: Element): number => {
    let alpha = 1;
    for (let n: Element | null = el; n; n = n.parentElement)
      alpha *= Number(getComputedStyle(n).opacity);
    return Math.max(0, Math.min(1, alpha));
  };
  const matches = (
    el: Element,
    selectors: string[],
    wrappers = true,
  ): boolean =>
    selectors.some((s) => {
      try {
        return wrappers ? el.closest(s) !== null : el.matches(s);
      } catch {
        return false;
      }
    });
  window.__idiomSurface = {
    selector,
    box,
    intersect,
    visible,
    opacity,
    matches,
  };
}
