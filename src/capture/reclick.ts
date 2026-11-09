import type { Page } from "playwright";
import type { ProbeReclick, Rect } from "../checks/types.js";
import type { Deadline } from "./deadline.js";
import {
  DISMISSAL_TEST_MIN_MS,
  dismissalBudgetReason,
  panelOpen,
  waitFor,
} from "./dismissal.js";

/** Opened panels whose opener is clicked a second time, per state. */
export const MAX_RECLICKS = 12;
/** How far (edge distance, px) a close control may sit from the opener. */
export const RECLICK_NEARBY_PX = 24;
export const reclickLimitReason = `re-click limit (${MAX_RECLICKS} per state)`;

export type ReclickOptions = {
  /** Probe path of the control that opened the panel. */
  trigger: string;
  root: string;
  /** The opener's box before it was clicked, in document coordinates. */
  original: Rect;
  waitMs: number;
  deadline: Deadline;
  /** Open the panel again after an earlier test closed it. */
  reopen: (page: Page) => Promise<void>;
};

type Located = {
  modal: boolean;
  sameSpot: boolean;
  hit: boolean;
  /** Viewport point at the original centre. */
  point: { x: number; y: number };
  closeNearby?: { selector: string; name: string } | undefined;
};

/**
 * Where the opener is now, whether a click at its original centre still
 * lands on it, whether the panel is modal, and the first close-equivalent
 * control within 24px of the opener's original box. Self-contained.
 */
async function locate(
  page: Page,
  trigger: string,
  root: string,
  original: Rect,
): Promise<Located> {
  return await page.evaluate(
    ({ trigger, root, original, nearbyPx }) => {
      const pathFor = (element: Element): string => {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current !== null && current !== document.documentElement) {
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
          current = parent;
        }
        return `html > ${parts.join(" > ")}`;
      };
      const control = document.querySelector(trigger);
      const panel = document.querySelector(root);
      let modal = false;
      for (
        let current: Element | null = panel;
        current !== null;
        current = current.parentElement
      ) {
        if (current.getAttribute("aria-modal") === "true") modal = true;
        if (current instanceof HTMLDialogElement && current.matches(":modal"))
          modal = true;
        if (modal) break;
      }
      const point = {
        x: original.x + original.width / 2 - window.scrollX,
        y: original.y + original.height / 2 - window.scrollY,
      };
      let sameSpot = false;
      let hit = false;
      if (control !== null) {
        const rect = control.getBoundingClientRect();
        const now = {
          left: rect.left + window.scrollX,
          top: rect.top + window.scrollY,
          right: rect.right + window.scrollX,
          bottom: rect.bottom + window.scrollY,
        };
        sameSpot =
          Math.abs(now.left - original.x) <= 4 &&
          Math.abs(now.top - original.y) <= 4 &&
          Math.abs(now.right - (original.x + original.width)) <= 4 &&
          Math.abs(now.bottom - (original.y + original.height)) <= 4;
        const inside =
          point.x >= 0 &&
          point.y >= 0 &&
          point.x < window.innerWidth &&
          point.y < window.innerHeight;
        if (inside) {
          const target = document.elementFromPoint(point.x, point.y);
          hit =
            target !== null && (target === control || control.contains(target));
        }
      }
      const panelId = panel?.id ?? "";
      const closeName = /\b(close|dismiss|hide|collapse|cancel|done|back)\b/i;
      const closeGlyph = /^[×✕✖✗xX]$/;
      let closeNearby: { selector: string; name: string } | undefined;
      for (const element of document.querySelectorAll(
        'a[href], button, summary, [role=button], [role=link], [role=menuitem], [role=tab], input[type=button], input[type=submit], [tabindex]:not([tabindex="-1"])',
      )) {
        if (
          control !== null &&
          (element === control ||
            control.contains(element) ||
            element.contains(control))
        )
          continue;
        if (!element.checkVisibility({ checkOpacity: true })) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const left = rect.left + window.scrollX;
        const top = rect.top + window.scrollY;
        const dx = Math.max(
          original.x - (left + rect.width),
          left - (original.x + original.width),
          0,
        );
        const dy = Math.max(
          original.y - (top + rect.height),
          top - (original.y + original.height),
          0,
        );
        if (Math.hypot(dx, dy) > nearbyPx) continue;
        const name = (
          element.getAttribute("aria-label") ||
          (element as HTMLElement).innerText ||
          element.getAttribute("title") ||
          (element as HTMLInputElement).value ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        const controls = (element.getAttribute("aria-controls") ?? "").split(
          /\s+/,
        );
        if (
          closeName.test(name) ||
          closeGlyph.test(name) ||
          element.getAttribute("aria-expanded") === "true" ||
          (panelId !== "" && controls.includes(panelId))
        ) {
          closeNearby = { selector: pathFor(element), name: name.slice(0, 60) };
          break;
        }
      }
      return {
        modal,
        sameSpot,
        hit,
        point,
        ...(closeNearby === undefined ? {} : { closeNearby }),
      };
    },
    { trigger, root, original, nearbyPx: RECLICK_NEARBY_PX },
  );
}

/**
 * Click the opener of an open panel a second time and see whether the panel
 * closes. Not clicked when the panel is modal or the opener is covered or
 * has moved; then only a nearby close control is recorded. Leaves the page
 * for the restore ladder. `disturbed`: the click navigated or opened a window.
 */
export async function testReclick(
  page: Page,
  options: ReclickOptions,
): Promise<{ reclick: ProbeReclick; disturbed: boolean }> {
  const { trigger, root, deadline } = options;
  const base = { trigger, root };
  const windowMs = Math.max(options.waitMs, 400);
  if (deadline.remaining() < DISMISSAL_TEST_MIN_MS)
    return {
      reclick: {
        ...base,
        outcome: "not-reached",
        reason: dismissalBudgetReason,
      },
      disturbed: false,
    };
  if (!(await panelOpen(page, trigger, root))) {
    await options.reopen(page).catch(() => undefined);
    if (!(await waitFor(page, trigger, root, true, windowMs)))
      return {
        reclick: { ...base, outcome: "not-tested", reason: "could not reopen" },
        disturbed: false,
      };
  }
  if (deadline.remaining() < DISMISSAL_TEST_MIN_MS)
    return {
      reclick: {
        ...base,
        outcome: "not-reached",
        reason: dismissalBudgetReason,
      },
      disturbed: false,
    };
  const located = await locate(page, trigger, root, options.original);
  const nearby =
    located.closeNearby === undefined
      ? {}
      : { closeNearby: located.closeNearby };
  if (located.modal)
    return {
      reclick: {
        ...base,
        outcome: "not-tested",
        reason: "modal panel: the opener is not reachable",
        ...nearby,
      },
      disturbed: false,
    };
  if (!located.sameSpot || !located.hit)
    return {
      reclick: {
        ...base,
        outcome: "not-tested",
        reason: "opener covered or moved",
        ...nearby,
      },
      disturbed: false,
    };
  const url = page.url();
  let popups = 0;
  const onPopup = () => {
    popups += 1;
  };
  page.on("popup", onPopup);
  let closed = false;
  try {
    await page.mouse.click(located.point.x, located.point.y);
    closed = await waitFor(page, trigger, root, false, windowMs);
  } finally {
    page.off("popup", onPopup);
  }
  if (page.url() !== url || popups > 0)
    return {
      reclick: {
        ...base,
        outcome: "inconclusive",
        reason: page.url() !== url ? "navigated" : "opened a window",
      },
      disturbed: true,
    };
  return {
    reclick: {
      ...base,
      outcome: closed ? "closed" : "stayed-open",
      ...(closed ? {} : nearby),
    },
    disturbed: false,
  };
}
