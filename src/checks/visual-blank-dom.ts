import type { Page } from "playwright";
import type { VisualBlankEvidence, VisualBlankRecord } from "./blank-schema.js";
import { installSurfaceDom } from "./surface-dom.js";

export async function inventoryBlankMedia(
  page: Page,
  swatchSelectors: string[],
  masks: string[],
): Promise<VisualBlankEvidence> {
  await page.evaluate(installSurfaceDom);
  return page.evaluate(
    ({ swatchSelectors, masks }): VisualBlankEvidence => {
      const h = window.__idiomSurface;
      const records: VisualBlankRecord[] = [];
      const all = [...document.querySelectorAll("*")];
      const maskRects = masks.flatMap((s) => {
        try {
          return [...document.querySelectorAll(s)].map(h.box);
        } catch {
          return [];
        }
      });
      const alpha = (color: string): number => {
        const m = color.match(/^rgba?\((.*)\)$/);
        if (!m) return 0;
        const values = (m[1] ?? "").split(/[, /]+/);
        return values.length === 4 ? Number(values[3]) : 1;
      };
      // Preselect potential covers once. Media galleries must not re-read
      // every element's computed style for every individual thumbnail.
      const covers = all.flatMap((cover) => {
        const cs = getComputedStyle(cover);
        if (cs.display === "none" || cs.visibility !== "visible") return [];
        const a = alpha(cs.backgroundColor) * h.opacity(cover);
        if (a < 0.98 && cs.backgroundImage === "none") return [];
        const cr = h.visible(cover);
        return cr ? [{ cover, cs, a, cr }] : [];
      });
      for (const el of all) {
        const tag = el.tagName.toLowerCase();
        // A picture's rendered surface is its img, even when picture itself
        // has the default inline line box. Use that surface's selector/rect.
        if (tag === "picture" && el.querySelector("img")) continue;
        const style = getComputedStyle(el);
        const mediaTag = [
          "img",
          "picture",
          "video",
          "canvas",
          "iframe",
        ].includes(tag);
        const token = `${el.className} ${[...el.attributes]
          .filter(
            (a) =>
              a.name.startsWith("data-") &&
              !["false", "off", "0"].includes(a.value),
          )
          .map((a) => `${a.name} ${a.value}`)
          .join(" ")}`;
        const placeholder =
          /(?:^|[\s_-])(?:skeleton|shimmer|placeholder)(?:$|[\s_-])/i.test(
            token,
          ) &&
          !(el.textContent ?? "").trim() &&
          !el.querySelector("img,picture,video,canvas,iframe,input,button,svg");
        if (!mediaTag && style.backgroundImage === "none" && !placeholder)
          continue;
        const rect = h.box(el),
          visible = h.visible(el);
        if (!visible || rect.width < 120 || rect.height < 80) continue;
        const px = (s: string) => Number.parseFloat(s) || 0;
        const sx =
          el instanceof HTMLElement && el.offsetWidth > 0
            ? rect.width / el.offsetWidth
            : 1;
        const sy =
          el instanceof HTMLElement && el.offsetHeight > 0
            ? rect.height / el.offsetHeight
            : 1;
        const left = (px(style.borderLeftWidth) + px(style.paddingLeft)) * sx,
          top = (px(style.borderTopWidth) + px(style.paddingTop)) * sy;
        const interior = {
          x: rect.x + left,
          y: rect.y + top,
          width: Math.max(
            0,
            rect.width -
              left -
              px(style.borderRightWidth) * sx -
              px(style.paddingRight) * sx,
          ),
          height: Math.max(
            0,
            rect.height -
              top -
              px(style.borderBottomWidth) * sy -
              px(style.paddingBottom) * sy,
          ),
        };
        const labelled = (el.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ");
        const labels =
          el instanceof HTMLInputElement
            ? [...(el.labels ?? [])].map((l) => l.textContent).join(" ")
            : "";
        const name = [
          el.getAttribute("aria-label"),
          labelled,
          labels,
          el.getAttribute("title"),
          el.getAttribute("alt"),
          tag === "picture" ? el.querySelector("img")?.alt : undefined,
          el.getAttribute("aria-roledescription"),
          el.getAttribute("role"),
        ]
          .filter(Boolean)
          .join(" ");
        const exempt = h.matches(el, swatchSelectors)
          ? "configured swatch selector"
          : /\b(colou?r|swatch)\b/i.test(name)
            ? `colour swatch: ${name}`
            : undefined;
        const record: VisualBlankRecord = {
          selector: h.selector(el),
          kind: mediaTag
            ? tag === "img" && el.closest("picture")
              ? "picture"
              : (tag as VisualBlankRecord["kind"])
            : placeholder
              ? "placeholder"
              : "background",
          rect,
          interior,
          visible,
          scroll: { x: scrollX, y: scrollY },
          masked:
            h.matches(el, masks) ||
            maskRects.some((m) => {
              const r = h.intersect(m, visible);
              return r.width > 0 && r.height > 0;
            }),
          opacity: h.opacity(el),
          overlay: { alpha: 0, coverage: 0 },
          ...(exempt ? { exempt } : {}),
        };
        if (el instanceof HTMLVideoElement)
          record.video = {
            poster: !!el.poster,
            frame:
              el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              el.videoWidth > 0 &&
              el.videoHeight > 0,
          };
        // Only rectangular, solid painted covers are proved here. Hit testing confirms
        // stacking; the area test, rather than a centre hit, establishes coverage.
        for (const { cover, cs, a, cr } of covers) {
          if (cover === el || el.contains(cover) || cover.contains(el))
            continue;
          const overlap = h.intersect(cr, visible);
          const coverage =
            (overlap.width * overlap.height) / (visible.width * visible.height);
          if (coverage < 0.995) continue;
          const complex =
            a < 0.98 ||
            cs.clipPath !== "none" ||
            cs.transform !== "none" ||
            cs.borderRadius !== "0px" ||
            cs.maskImage !== "none" ||
            cs.mixBlendMode !== "normal" ||
            cs.filter !== "none";
          const points = [
            [0.01, 0.01],
            [0.99, 0.01],
            [0.5, 0.5],
            [0.01, 0.99],
            [0.99, 0.99],
          ];
          const inline =
            cover instanceof HTMLElement || cover instanceof SVGElement
              ? cover.style
              : undefined;
          const old = inline?.getPropertyValue("pointer-events"),
            priority = inline?.getPropertyPriority("pointer-events");
          inline?.setProperty("pointer-events", "auto", "important");
          let front = false;
          try {
            front = points.every(([fx, fy]) => {
              const x = visible.x + visible.width * (fx ?? 0),
                y = visible.y + visible.height * (fy ?? 0);
              if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
                return false;
              const stack = document.elementsFromPoint(x, y);
              const c = stack.indexOf(cover),
                m = stack.findIndex((n) => n === el || el.contains(n));
              return c >= 0 && m >= 0 && c < m;
            });
          } finally {
            if (old) inline?.setProperty("pointer-events", old, priority);
            else inline?.removeProperty("pointer-events");
          }
          if (front && complex)
            record.overlay.uncertainty = "complex cover paint or geometry";
          else if (front)
            record.overlay = {
              alpha: a,
              coverage,
              selector: h.selector(cover),
            };
        }
        // A simple positioned ::after on the media's wrapper can cover it even
        // though hit testing returns that wrapper. Unsupported shapes stay uncertain.
        for (
          let parent = el.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          for (const pseudo of ["::before", "::after"]) {
            const ps = getComputedStyle(parent, pseudo);
            if (
              ps.content === "none" ||
              ps.content === "normal" ||
              ps.display === "none"
            )
              continue;
            const a =
              alpha(ps.backgroundColor) *
              Number(ps.opacity) *
              h.opacity(parent);
            if (a < 0.98 || !["absolute", "fixed"].includes(ps.position))
              continue;
            const pb = h.box(parent);
            if (
              parent !== el.parentElement ||
              (ps.position === "absolute" &&
                getComputedStyle(parent).position === "static")
            ) {
              record.overlay.uncertainty =
                "unsupported pseudo-element containing block";
              continue;
            }
            if (
              ps.transform !== "none" ||
              ps.clipPath !== "none" ||
              ps.borderRadius !== "0px" ||
              !/^\d/.test(ps.width) ||
              !/^\d/.test(ps.height)
            ) {
              record.overlay.uncertainty = "complex pseudo-element geometry";
              continue;
            }
            if (pseudo === "::before" && !(Number(ps.zIndex) > 0)) continue;
            if (
              Number(ps.zIndex) < 0 ||
              ps.left === "auto" ||
              ps.top === "auto"
            )
              continue;
            const r = {
              x:
                (ps.position === "fixed" ? 0 : pb.x + parent.clientLeft) +
                px(ps.left),
              y:
                (ps.position === "fixed" ? 0 : pb.y + parent.clientTop) +
                px(ps.top),
              width: px(ps.width),
              height: px(ps.height),
            };
            const overlap = h.intersect(r, visible),
              coverage =
                (overlap.width * overlap.height) /
                (visible.width * visible.height);
            const mediaZ = Number(style.zIndex) || 0;
            if (coverage >= 0.995 && (Number(ps.zIndex) || 0) >= mediaZ)
              record.overlay = {
                alpha: a,
                coverage,
                selector: `${h.selector(parent)}${pseudo}`,
              };
          }
        }
        for (
          let ancestor: Element | null = el;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const as = getComputedStyle(ancestor);
          const matrix = as.transform
            .match(/^matrix\(([^)]+)\)$/)?.[1]
            ?.split(",")
            .map(Number);
          const axisAligned =
            as.transform === "none" ||
            (matrix?.length === 6 &&
              (matrix[0] ?? 0) > 0 &&
              matrix[1] === 0 &&
              matrix[2] === 0 &&
              (matrix[3] ?? 0) > 0);
          if (
            !axisAligned ||
            (as.clipPath !== "none" && !/^inset\([^)]*\)$/.test(as.clipPath))
          )
            record.unavailable = "complex media geometry";
        }
        records.push(record);
      }
      return {
        status: "ran",
        algorithm: "rgb16-v1",
        dominantThreshold: 0.995,
        opacityThreshold: 0.01,
        overlayAlphaThreshold: 0.98,
        bucketSize: 16,
        edgeInset: 2,
        swatchSelectors,
        records,
      };
    },
    { swatchSelectors, masks },
  );
}
