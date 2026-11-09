import type { Page } from "playwright";
import type { IndicatorSnapshot } from "../checks/types.js";

/** Graphics read per snapshot. */
export const MAX_INDICATOR_GRAPHICS = 12;

/**
 * Read what could show a disclosure trigger as collapsed or expanded: its
 * open state, a summary's native marker, its visible text, and the graphics
 * inside it, in its own pseudo-elements, and in an adjacent non-interactive
 * sibling. Each graphic's signature folds in its geometry, its composed
 * transform up to the trigger and its visibility, so two snapshots differ
 * when any indicator rotates, swaps, appears or disappears. `undefined` when
 * the path does not resolve. Self-contained: it is serialized.
 */
export async function readIndicator(
  page: Page,
  path: string,
): Promise<IndicatorSnapshot | undefined> {
  return await page
    .evaluate(
      ({ path, limit }) => {
        const trigger = document.querySelector(path);
        if (trigger === null) return undefined;
        const round = (value: string) =>
          value.replace(/-?\d+\.\d+/g, (number) =>
            String(Math.round(Number(number) * 100) / 100),
          );
        const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
        const interactiveSelector =
          'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=switch], [role=checkbox], [tabindex]:not([tabindex="-1"])';
        const details =
          trigger.tagName.toLowerCase() === "summary" &&
          trigger.parentElement instanceof HTMLDetailsElement
            ? trigger.parentElement
            : undefined;
        const expanded =
          details !== undefined
            ? details.open
              ? "open"
              : "closed"
            : trigger.getAttribute("aria-expanded");
        const triggerStyle = getComputedStyle(trigger);
        const marker =
          details !== undefined &&
          triggerStyle.display === "list-item" &&
          triggerStyle.listStyleType !== "none";
        const text = collapse(
          (trigger as HTMLElement).innerText ?? trigger.textContent ?? "",
        ).slice(0, 120);
        const visual = (style: CSSStyleDeclaration) =>
          [
            style.display,
            style.visibility,
            round(style.opacity),
            round(style.transform),
            style.rotate,
            style.scale,
          ].join(",");
        /** Transforms of the element and its ancestors up to `stop`. */
        const composed = (element: Element, stop: Element | null) => {
          const parts: string[] = [];
          for (
            let current: Element | null = element;
            current !== null && current !== stop;
            current = current.parentElement
          )
            parts.push(visual(getComputedStyle(current)));
          return parts.join("/");
        };
        const geometry = (element: Element): string => {
          const tag = element.tagName.toLowerCase();
          if (tag === "img")
            return `img:${(element as HTMLImageElement).currentSrc}`;
          if (element instanceof SVGElement) {
            const shapes = [
              ...(tag === "svg" ? [] : [element]),
              ...element.querySelectorAll(
                "path, circle, ellipse, rect, line, polyline, polygon, use",
              ),
            ];
            return shapes
              .map((shape) =>
                [
                  "d",
                  "points",
                  "x",
                  "y",
                  "width",
                  "height",
                  "r",
                  "cx",
                  "cy",
                  "x1",
                  "y1",
                  "x2",
                  "y2",
                  "href",
                  "xlink:href",
                  "transform",
                ]
                  .map((name) => shape.getAttribute(name) ?? "")
                  .join("|"),
              )
              .map(round)
              .join(";");
          }
          const style = getComputedStyle(element);
          return `box:${style.backgroundImage}|${style.maskImage}|${collapse(element.textContent ?? "")}`;
        };
        const graphicVisible = (element: Element) => {
          if (
            !element.checkVisibility({
              checkOpacity: true,
              checkVisibilityCSS: true,
            })
          )
            return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const glyphOnly = (element: Element) => {
          if (element.children.length > 0) return false;
          const own = collapse(element.textContent ?? "");
          return (
            own.length > 0 && [...own].length <= 2 && !/[\p{L}\p{N}]/u.test(own)
          );
        };
        const graphics: IndicatorSnapshot["graphics"] = [];
        const push = (graphic: IndicatorSnapshot["graphics"][number]) => {
          if (graphics.length < limit) graphics.push(graphic);
        };
        const pseudo = (
          element: Element,
          where: "before" | "after" | "sibling" | "inside",
          stop: Element | null,
        ) => {
          for (const which of ["::before", "::after"] as const) {
            const style = getComputedStyle(element, which);
            if (style.content === "none" || style.content === "normal")
              continue;
            const visible =
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity) > 0;
            const borders = [
              style.borderTopWidth,
              style.borderRightWidth,
              style.borderBottomWidth,
              style.borderLeftWidth,
              style.borderTopColor,
              style.borderRightColor,
              style.borderBottomColor,
              style.borderLeftColor,
            ].join(" ");
            push({
              where:
                where === "inside" || where === "sibling"
                  ? where
                  : which === "::before"
                    ? "before"
                    : "after",
              signature: `${which}:${style.content}|${style.backgroundImage}|${style.maskImage}|${borders}|${visual(style)}|${composed(element, stop)}`,
              visible,
            });
          }
        };
        const scan = (
          scope: Element,
          where: "inside" | "sibling",
          stop: Element | null,
        ) => {
          const candidates: Element[] = [];
          const walk = (element: Element) => {
            for (const child of element.children) {
              if (graphics.length + candidates.length >= limit) return;
              const tag = child.tagName.toLowerCase();
              if (tag === "svg" || tag === "img") {
                candidates.push(child);
                continue;
              }
              const style = getComputedStyle(child);
              if (
                style.backgroundImage !== "none" ||
                (style.maskImage !== "none" && style.maskImage !== "") ||
                glyphOnly(child)
              )
                candidates.push(child);
              else walk(child);
            }
          };
          if (where === "sibling") {
            const tag = scope.tagName.toLowerCase();
            const style = getComputedStyle(scope);
            if (
              tag === "svg" ||
              tag === "img" ||
              style.backgroundImage !== "none" ||
              (style.maskImage !== "none" && style.maskImage !== "") ||
              glyphOnly(scope)
            )
              candidates.push(scope);
            else walk(scope);
            pseudo(scope, "sibling", stop);
          } else walk(scope);
          for (const element of candidates)
            push({
              where,
              signature: `${geometry(element)}|${composed(element, stop)}`,
              visible: graphicVisible(element),
            });
          if (where === "inside")
            for (const element of scope.querySelectorAll("*")) {
              if (graphics.length >= limit) break;
              if (element instanceof SVGElement) continue;
              const before = getComputedStyle(element, "::before").content;
              const after = getComputedStyle(element, "::after").content;
              if (
                (before !== "none" && before !== "normal") ||
                (after !== "none" && after !== "normal")
              )
                pseudo(element, "inside", stop);
            }
        };
        pseudo(trigger, "before", trigger.parentElement);
        scan(trigger, "inside", trigger);
        const box = trigger.getBoundingClientRect();
        for (const sibling of [
          trigger.previousElementSibling,
          trigger.nextElementSibling,
        ]) {
          if (sibling === null || graphics.length >= limit) continue;
          if (
            sibling.matches(interactiveSelector) ||
            sibling.querySelector(interactiveSelector) !== null
          )
            continue;
          const rect = sibling.getBoundingClientRect();
          const dx = Math.max(box.left - rect.right, rect.left - box.right, 0);
          const dy = Math.max(box.top - rect.bottom, rect.top - box.bottom, 0);
          if (Math.max(dx, dy) > 8) continue;
          scan(sibling, "sibling", sibling.parentElement);
        }
        return { expanded, marker, text, graphics };
      },
      { path, limit: MAX_INDICATOR_GRAPHICS },
    )
    .catch(() => undefined);
}
