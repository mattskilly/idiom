import type { Page } from "playwright";
import type { MenuRowSample, ProbeMenu, Rect } from "../checks/types.js";
import type { Deadline } from "./deadline.js";

const MAX_ITEMS = 40;
const MAX_DISABLED_SAMPLES = 3;
const SETTLE_CAP_MS = 250;

/**
 * Where a probe trigger sits, in document coordinates, and the probe path of
 * the toolbar, menubar, group or row holding it (its parent when it has
 * none). Measured before the click: clicking can move or hide it.
 */
export async function triggerBox(
  page: Page,
  path: string,
): Promise<{ trigger: Rect; group: string } | undefined> {
  return page
    .evaluate((selector) => {
      const pathOf = (element: Element): string => {
        const parts: string[] = [];
        for (
          let current: Element | null = element;
          current !== null && current !== document.documentElement;
          current = current.parentElement
        ) {
          const parent: Element | null = current.parentElement;
          const tag = current.tagName.toLowerCase();
          if (parent === null) {
            parts.unshift(tag);
            break;
          }
          const index =
            [...parent.children]
              .filter((child) => child.tagName === current?.tagName)
              .indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${index})`);
        }
        return `html > ${parts.join(" > ")}`;
      };
      const element = document.querySelector(selector);
      if (element === null) return undefined;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return undefined;
      const container =
        element.parentElement?.closest(
          "[role=toolbar], [role=menubar], [role=group], [role=row]",
        ) ?? element.parentElement;
      return {
        trigger: {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        },
        group: container === null ? "html" : pathOf(container),
      };
    }, path)
    .catch(() => undefined);
}

/**
 * The visible rows of an opened menu or listbox, and, when any row is
 * disabled, how up to three disabled rows and the first enabled row change
 * colour under the pointer. Undefined when the root holds no rows.
 */
export async function menuInventory(
  page: Page,
  root: string,
  deadline: Deadline,
): Promise<Omit<ProbeMenu, "trigger" | "group"> | undefined> {
  const items = await page
    .evaluate(
      ({ root, max }) => {
        const pathOf = (element: Element): string => {
          if (element.id !== "" && /^[A-Za-z][\w-]*$/.test(element.id))
            return `#${element.id}`;
          const parts: string[] = [];
          for (
            let current: Element | null = element;
            current !== null && current !== document.documentElement;
            current = current.parentElement
          ) {
            const parent: Element | null = current.parentElement;
            const tag = current.tagName.toLowerCase();
            if (parent === null) {
              parts.unshift(tag);
              break;
            }
            const index =
              [...parent.children]
                .filter((child) => child.tagName === current?.tagName)
                .indexOf(current) + 1;
            parts.unshift(`${tag}:nth-of-type(${index})`);
          }
          return `html > ${parts.join(" > ")}`;
        };
        const roots = [...document.querySelectorAll(root)];
        const rows: Array<{
          name: string;
          disabled: boolean;
          selector: string;
        }> = [];
        const seen = new Set<Element>();
        for (const container of roots)
          for (const row of container.querySelectorAll(
            "[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option]",
          )) {
            if (seen.has(row) || rows.length >= max) continue;
            seen.add(row);
            if (!row.checkVisibility({ checkOpacity: true })) continue;
            const box = row.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) continue;
            const label =
              row.getAttribute("aria-label") ??
              (row as HTMLElement).innerText ??
              row.textContent ??
              "";
            const disabled =
              row.getAttribute("aria-disabled") === "true" ||
              row.hasAttribute("disabled") ||
              row.matches(":disabled") ||
              row.querySelector(":disabled, [aria-disabled=true]") !== null;
            rows.push({
              name: label.replace(/\s+/g, " ").trim().slice(0, 120),
              disabled,
              selector: pathOf(row),
            });
          }
        return rows;
      },
      { root, max: MAX_ITEMS },
    )
    .catch(() => undefined);
  if (items === undefined || items.length === 0) return undefined;
  if (!items.some((item) => item.disabled)) return { root, items };
  const reference = items.find((item) => !item.disabled);
  const targets = [
    ...items.filter((item) => item.disabled).slice(0, MAX_DISABLED_SAMPLES),
    ...(reference === undefined ? [] : [reference]),
  ];
  const hover: MenuRowSample[] = [];
  for (const target of targets) {
    deadline.check();
    if (deadline.remaining() < 500) break;
    const sample = await hoverSample(page, target.selector).catch(
      () => undefined,
    );
    if (sample !== undefined)
      hover.push({
        selector: target.selector,
        disabled: target.disabled,
        ...sample,
      });
  }
  return { root, items, hover };
}

async function hoverSample(
  page: Page,
  selector: string,
): Promise<Omit<MenuRowSample, "selector" | "disabled"> | undefined> {
  const read = () =>
    page.evaluate((selector) => {
      const row = document.querySelector(selector);
      if (row === null) return undefined;
      const style = getComputedStyle(row);
      const box = row.getBoundingClientRect();
      return {
        colors: { backgroundColor: style.backgroundColor, color: style.color },
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      };
    }, selector);
  const rest = await read();
  if (rest === undefined) return undefined;
  // A raw pointer move: actionability checks would stall on disabled rows.
  await page.mouse.move(rest.x, rest.y);
  await page.evaluate(
    async ({ selector, cap }) => {
      const row = document.querySelector(selector);
      if (row === null) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const running = row
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined));
      if (running.length === 0) return;
      await Promise.race([
        Promise.all(running),
        new Promise((resolve) => setTimeout(resolve, cap)),
      ]);
    },
    { selector, cap: SETTLE_CAP_MS },
  );
  const hovered = await read();
  if (hovered === undefined) return undefined;
  return { rest: rest.colors, hovered: hovered.colors };
}
