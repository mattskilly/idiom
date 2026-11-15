import type { Page } from "playwright";
import type { ProbePalette } from "../checks/types.js";
import { type Deadline, DeadlineExpired } from "./deadline.js";

/** Containers a command palette renders as. */
const PALETTE_ROOTS = [
  "dialog[open]",
  "[role=dialog]",
  "[role=alertdialog]",
  "[role=listbox]",
  "[role=menu]",
  "[aria-modal=true]",
  "[popover]:popover-open",
];
const MAX_ENTRIES = 60;
const POLL_MS = 50;
const MAX_WAIT_MS = 1500;

/** Visible candidate roots, as probe paths; blurs focus first when asked. */
async function visibleRoots(page: Page, blur: boolean): Promise<string[]> {
  return page.evaluate(
    ({ selectors, blur }) => {
      if (blur) (document.activeElement as HTMLElement | null)?.blur?.();
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
      const found = new Set<string>();
      for (const selector of selectors) {
        let matches: Element[] = [];
        try {
          matches = [...document.querySelectorAll(selector)];
        } catch {
          continue;
        }
        for (const element of matches) {
          if (!element.checkVisibility({ checkOpacity: true })) continue;
          const box = element.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) continue;
          found.add(pathOf(element));
        }
      }
      return [...found];
    },
    { selectors: PALETTE_ROOTS, blur },
  );
}

/** The visible entries of an opened palette: options, menu items and links. */
async function paletteEntries(
  page: Page,
  root: string,
): Promise<ProbePalette["entries"]> {
  return page.evaluate(
    ({ root, max }) => {
      const container = document.querySelector(root);
      if (container === null) return [];
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
      const hrefOf = (row: Element): string | undefined => {
        const anchor = row.matches("a[href]")
          ? row
          : (row.closest("a[href]") ?? row.querySelector("a[href]"));
        const raw = anchor?.getAttribute("href");
        if (raw === null || raw === undefined) return undefined;
        try {
          const url = new URL(raw, location.href);
          return url.protocol === "http:" || url.protocol === "https:"
            ? url.href
            : undefined;
        } catch {
          return undefined;
        }
      };
      const rowSelector = "[role=option], [role=menuitem]";
      const entries: Array<{ name: string; selector: string; href?: string }> =
        [];
      const seen = new Set<Element>();
      for (const row of container.querySelectorAll(`${rowSelector}, a[href]`)) {
        if (seen.has(row) || entries.length >= max) continue;
        seen.add(row);
        // A link inside an option is that option's destination, not a second entry.
        const owner = row.matches(rowSelector)
          ? row
          : row.parentElement?.closest(rowSelector);
        if (owner !== row && owner && container.contains(owner)) continue;
        if (!row.checkVisibility({ checkOpacity: true })) continue;
        const box = row.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) continue;
        const label =
          row.getAttribute("aria-label") ??
          (row as HTMLElement).innerText ??
          row.textContent ??
          "";
        const href = hrefOf(row);
        entries.push({
          name: label.replace(/\s+/g, " ").trim().slice(0, 120),
          selector: pathOf(row),
          ...(href === undefined ? {} : { href }),
        });
      }
      return entries;
    },
    { root, max: MAX_ENTRIES },
  );
}

/**
 * Press the configured command palette shortcut once on the state as
 * loaded, read what opens, then close it with Escape. The shortcut is
 * pressed exactly as configured (Playwright key syntax), with no platform
 * remapping.
 */
export async function probeCommandPalette(
  page: Page,
  options: { shortcut: string; waitMs: number; deadline: Deadline },
): Promise<ProbePalette> {
  const { shortcut, deadline } = options;
  const base = { shortcut, entries: [] };
  try {
    if (deadline.remaining() < 500)
      return {
        ...base,
        status: "not-reached",
        reason: "the state's probe budget ran out before the palette",
      };
    const before = new Set(await deadline.run(() => visibleRoots(page, true)));
    await deadline.run(() => page.keyboard.press(shortcut));
    const limit = Math.min(Math.max(options.waitMs * 3, 150), MAX_WAIT_MS);
    const started = performance.now();
    let root: string | undefined;
    for (;;) {
      const now = await deadline.run(() => visibleRoots(page, false));
      root = now.find((path) => !before.has(path));
      if (root !== undefined || performance.now() - started >= limit) break;
      await deadline.run(() =>
        page.waitForTimeout(Math.min(POLL_MS, deadline.remaining())),
      );
    }
    if (root === undefined)
      return {
        ...base,
        status: "nothing-opened",
        reason: `pressing ${shortcut} opened no dialog, listbox or menu within ${limit} ms`,
      };
    const opened = root;
    const entries = await deadline.run(() => paletteEntries(page, opened));
    await deadline.run(() => page.keyboard.press("Escape"));
    await deadline.run(() =>
      page.waitForTimeout(Math.min(Math.max(options.waitMs, 50), 300)),
    );
    const after = await deadline.run(() => visibleRoots(page, false));
    return {
      shortcut,
      status: "opened",
      root: opened,
      entries,
      closed: !after.includes(opened),
    };
  } catch (error) {
    if (error instanceof DeadlineExpired)
      return {
        ...base,
        status: "not-reached",
        reason: `the state's probe budget ran out (${error.message})`,
      };
    if (deadline.signal.aborted) throw error;
    return {
      ...base,
      status: "failed",
      reason:
        error instanceof Error ? error.message.split("\n")[0] : String(error),
    };
  }
}
