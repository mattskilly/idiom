import type { Page } from "playwright";
import type {
  DismissalMethod,
  DismissalTest,
  ProbeDismissal,
} from "../checks/types.js";
import type { Deadline } from "./deadline.js";

/** Opened overlays whose dismissal is tested per state. */
export const MAX_DISMISSALS = 12;
/** The least of a control's budget one dismissal test may start with. */
export const DISMISSAL_TEST_MIN_MS = 1200;

export const dismissalBudgetReason =
  "probe budget (no time left in the control's budget)";
export const dismissalLimitReason = `dismissal limit (${MAX_DISMISSALS} per state)`;

/** Where the outside and iframe clicks land, read with the panel open. */
type Classified = {
  open: boolean;
  overlay: boolean;
  native?: "dialog" | "popover" | undefined;
  role?: string | undefined;
  explicit?: string | undefined;
  outside?: { x: number; y: number } | undefined;
  iframe?: { x: number; y: number; selector: string; name: string } | undefined;
};

/**
 * Classify the open panel and find its click points: an empty,
 * non-interactive point outside the panel and trigger (farthest from the
 * panel), and a point inside the largest visible same-origin iframe.
 * Self-contained: it is serialized.
 */
async function classify(
  page: Page,
  trigger: string,
  root: string,
  explicit: string[],
): Promise<Classified> {
  return await page.evaluate(
    ({ trigger, root, explicit }) => {
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
      const visible = (element: Element) => {
        if (!element.checkVisibility({ checkOpacity: true })) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const interactive = (element: Element): boolean => {
        if (
          element.closest(
            'a[href], button, input, select, textarea, label, summary, iframe, video, audio, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=switch], [role=radio], [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true], [onclick]',
          ) !== null
        )
          return true;
        const view = element.ownerDocument.defaultView;
        return view?.getComputedStyle(element).cursor === "pointer";
      };
      const panel = document.querySelector(root);
      const control = document.querySelector(trigger);
      if (panel === null || !visible(panel))
        return { open: false, overlay: false };
      const tag = panel.tagName.toLowerCase();
      const role = panel.getAttribute("role") ?? tag;
      const native =
        panel instanceof HTMLDialogElement
          ? ("dialog" as const)
          : panel.hasAttribute("popover")
            ? ("popover" as const)
            : undefined;
      const topLayer =
        panel.matches(":popover-open") ||
        (panel instanceof HTMLDialogElement && panel.open);
      let positioned = false;
      for (
        let current: Element | null = panel;
        current !== null &&
        current !== document.body &&
        current !== document.documentElement &&
        !(control !== null && current.contains(control));
        current = current.parentElement
      ) {
        if (
          ["absolute", "fixed"].includes(getComputedStyle(current).position)
        ) {
          positioned = true;
          break;
        }
      }
      const overlay =
        topLayer ||
        positioned ||
        ["menu", "listbox", "dialog", "alertdialog"].includes(role) ||
        panel.getAttribute("aria-modal") === "true";
      let exempt: string | undefined;
      if (panel.closest("[role=alertdialog]") !== null) exempt = "alertdialog";
      else {
        for (const selector of explicit) {
          let matched = false;
          try {
            matched =
              panel.closest(selector) !== null ||
              panel.querySelector(selector) !== null;
          } catch {
            matched = false;
          }
          if (matched) {
            exempt = `explicitDismiss ${selector}`;
            break;
          }
        }
        const closedby = panel.getAttribute("closedby")?.toLowerCase();
        if (
          exempt === undefined &&
          panel instanceof HTMLDialogElement &&
          (closedby === "none" || closedby === "closerequest")
        )
          exempt = `closedby="${closedby}"`;
      }
      const panelRect = panel.getBoundingClientRect();
      const triggerRect = control?.getBoundingClientRect();
      const near = (rect: DOMRect | undefined, x: number, y: number) =>
        rect !== undefined &&
        rect.width > 0 &&
        x >= rect.left - 8 &&
        x <= rect.right + 8 &&
        y >= rect.top - 8 &&
        y <= rect.bottom + 8;
      const outsideOf = (element: Element) =>
        !panel.contains(element) &&
        !(
          control !== null &&
          (control === element || control.contains(element))
        );
      const width = window.innerWidth;
      const height = window.innerHeight;
      let outside: { x: number; y: number } | undefined;
      let farthest = -1;
      for (let row = 0; row < 16; row += 1) {
        for (let column = 0; column < 24; column += 1) {
          const x = Math.round(((column + 0.5) * width) / 24);
          const y = Math.round(((row + 0.5) * height) / 16);
          if (near(panelRect, x, y) || near(triggerRect, x, y)) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit === null) continue;
          // A modal's ::backdrop hit reports the dialog itself.
          if (hit !== panel && !outsideOf(hit)) continue;
          if (hit !== panel && interactive(hit)) continue;
          const dx = Math.max(panelRect.left - x, 0, x - panelRect.right);
          const dy = Math.max(panelRect.top - y, 0, y - panelRect.bottom);
          const distance = dx * dx + dy * dy;
          if (distance > farthest) {
            farthest = distance;
            outside = { x, y };
          }
        }
      }
      let iframe:
        | { x: number; y: number; selector: string; name: string }
        | undefined;
      let largest = 0;
      for (const frame of document.querySelectorAll("iframe")) {
        if (!visible(frame) || !outsideOf(frame)) continue;
        let inner: Document | null = null;
        try {
          inner = frame.contentDocument;
        } catch {
          inner = null;
        }
        if (inner === null) continue;
        const rect = frame.getBoundingClientRect();
        const left = Math.max(rect.left, 0);
        const top = Math.max(rect.top, 0);
        const right = Math.min(rect.right, width);
        const bottom = Math.min(rect.bottom, height);
        if (right - left < 24 || bottom - top < 24) continue;
        const area = (right - left) * (bottom - top);
        if (area <= largest) continue;
        const points: Array<[number, number]> = [
          [0.5, 0.5],
          [0.25, 0.25],
          [0.75, 0.25],
          [0.25, 0.75],
          [0.75, 0.75],
        ];
        for (const [fx, fy] of points) {
          const x = Math.round(left + (right - left) * fx);
          const y = Math.round(top + (bottom - top) * fy);
          if (near(panelRect, x, y) || near(triggerRect, x, y)) continue;
          if (document.elementFromPoint(x, y) !== frame) continue;
          const style = getComputedStyle(frame);
          const innerX =
            x -
            rect.left -
            frame.clientLeft -
            Number.parseFloat(style.paddingLeft);
          const innerY =
            y -
            rect.top -
            frame.clientTop -
            Number.parseFloat(style.paddingTop);
          const target = inner.elementFromPoint(innerX, innerY);
          if (target !== null && interactive(target)) continue;
          const label =
            frame.getAttribute("title")?.trim() ||
            frame.getAttribute("name")?.trim() ||
            frame.id ||
            "";
          iframe = { x, y, selector: pathFor(frame), name: label };
          largest = area;
          break;
        }
      }
      return {
        open: true,
        overlay,
        native,
        role,
        ...(exempt === undefined ? {} : { explicit: exempt }),
        ...(outside === undefined ? {} : { outside }),
        ...(iframe === undefined ? {} : { iframe }),
      };
    },
    { trigger, root, explicit },
  );
}

/**
 * Whether the panel is still open: its root renders, the trigger is not
 * `aria-expanded="false"`, a dialog keeps `open` and a popover stays open.
 */
async function panelOpen(
  page: Page,
  trigger: string,
  root: string,
): Promise<boolean> {
  return await page.evaluate(
    ({ trigger, root }) => {
      const panel = document.querySelector(root);
      if (panel === null || !panel.checkVisibility({ checkOpacity: true }))
        return false;
      const rect = panel.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (
        document.querySelector(trigger)?.getAttribute("aria-expanded") ===
        "false"
      )
        return false;
      if (panel instanceof HTMLDialogElement && !panel.open) return false;
      if (panel.hasAttribute("popover") && !panel.matches(":popover-open"))
        return false;
      return true;
    },
    { trigger, root },
  );
}

/** Poll every 50ms until the panel reaches `open`, or the window ends. */
async function waitFor(
  page: Page,
  trigger: string,
  root: string,
  open: boolean,
  windowMs: number,
): Promise<boolean> {
  const end = performance.now() + windowMs;
  for (;;) {
    if ((await panelOpen(page, trigger, root)) === open) return true;
    if (performance.now() >= end) return false;
    await page.waitForTimeout(50);
  }
}

/**
 * Put focus where a person pressing Escape has it: on the trigger or inside
 * the panel. Returns whether the probe had to focus the trigger, and the
 * panel's id, read while it is open.
 */
async function focusBeforeEscape(
  page: Page,
  trigger: string,
  root: string,
): Promise<{ focusedTrigger: boolean; panelId: string }> {
  const state = await page.evaluate(
    ({ trigger, root }) => {
      const control = document.querySelector(trigger);
      const panel = document.querySelector(root);
      const active = document.activeElement;
      const placed =
        active !== null &&
        active !== document.body &&
        ((control !== null &&
          (control === active || control.contains(active))) ||
          panel?.contains(active) === true);
      return { placed, panelId: panel?.id ?? "" };
    },
    { trigger, root },
  );
  if (state.placed) return { focusedTrigger: false, panelId: state.panelId };
  await page
    .locator(trigger)
    .first()
    .focus({ timeout: 500 })
    .catch(() => undefined);
  return { focusedTrigger: true, panelId: state.panelId };
}

/** Where focus went after Escape closed the panel. */
async function readFocus(
  page: Page,
  trigger: string,
  panelId: string,
): Promise<{ returned: boolean; active: string; activeSelector?: string }> {
  return await page.evaluate(
    ({ trigger, panelId }) => {
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
      const active = document.activeElement;
      if (
        active === null ||
        active === document.body ||
        active === document.documentElement
      )
        return { returned: false, active: "body" };
      const control = document.querySelector(trigger);
      const name = (
        active.getAttribute("aria-label") ??
        ((active as HTMLElement).innerText ||
          active.getAttribute("title") ||
          "")
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      const described = `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ""}${name ? ` "${name}"` : ""}`;
      const gone =
        control === null ||
        !control.isConnected ||
        !control.checkVisibility({ checkOpacity: true });
      const references =
        panelId !== "" &&
        ["aria-controls", "aria-owns"].some((attribute) =>
          (active.getAttribute(attribute) ?? "").split(/\s+/).includes(panelId),
        );
      const returned =
        (control !== null &&
          (control === active || control.contains(active))) ||
        gone ||
        references;
      return { returned, active: described, activeSelector: pathFor(active) };
    },
    { trigger, panelId },
  );
}

export type DismissalOptions = {
  /** Probe path of the control that opened the panel. */
  trigger: string;
  root: string;
  /** The disclosure kind; native dialogs and popovers are read from the DOM. */
  kind?: "popup" | "expanded" | undefined;
  /** Flow `explicitDismiss` selectors. */
  explicit: string[];
  waitMs: number;
  deadline: Deadline;
  /** Open the panel again after a test closed it. */
  reopen: (page: Page) => Promise<void>;
};

/**
 * Test how an opened overlay closes: Escape first (on the opening the probe's
 * own click made, so focus is where the app put it), then an empty point
 * outside, then a click into a same-origin iframe. The panel is reopened
 * between tests that closed it; the last test leaves the page for the
 * restore ladder. `disturbed`: a click navigated or opened a window.
 */
export async function testDismissal(
  page: Page,
  options: DismissalOptions,
): Promise<{ dismissal: ProbeDismissal; disturbed: boolean }> {
  const { trigger, root, deadline } = options;
  const windowMs = Math.max(options.waitMs, 400);
  const first = await classify(page, trigger, root, options.explicit);
  const kind = first.native ?? options.kind ?? "dialog";
  const base = {
    trigger,
    root,
    kind,
    ...(first.role === undefined ? {} : { role: first.role }),
    ...(first.explicit === undefined ? {} : { explicit: first.explicit }),
  } satisfies Partial<ProbeDismissal>;
  if (!first.open)
    return {
      dismissal: {
        ...base,
        status: "not-applicable",
        reason: "panel not open",
        tests: [],
      },
      disturbed: false,
    };
  if (!first.overlay)
    return {
      dismissal: {
        ...base,
        status: "not-applicable",
        reason: "in-flow disclosure, not a popover",
        tests: [],
      },
      disturbed: false,
    };
  const methods: DismissalMethod[] = ["escape", "outside", "iframe"];
  const tests: DismissalTest[] = [];
  let stop:
    | { outcome: "not-reached" | "not-tested"; reason: string }
    | undefined;
  let disturbed = false;
  /** Whether the panel is open for the next test. */
  let open = true;
  const enough = () => deadline.remaining() >= DISMISSAL_TEST_MIN_MS;
  const reopen = async (): Promise<boolean> => {
    if (!enough()) {
      stop = { outcome: "not-reached", reason: dismissalBudgetReason };
      return false;
    }
    await options.reopen(page).catch(() => undefined);
    if (await waitFor(page, trigger, root, true, windowMs)) return true;
    stop = { outcome: "not-tested", reason: "could not reopen" };
    return false;
  };
  for (const method of methods) {
    if (method !== "escape") {
      // Skips known with the panel open need no reopen.
      if (first.explicit !== undefined) {
        tests.push({
          method,
          outcome: "not-tested",
          reason: `exempt: ${first.explicit}`,
        });
        continue;
      }
      if ((method === "outside" ? first.outside : first.iframe) === undefined) {
        tests.push({
          method,
          outcome: "not-tested",
          reason:
            method === "outside"
              ? "no empty point outside the panel"
              : "no visible same-origin iframe",
        });
        continue;
      }
    }
    if (stop === undefined && !open) open = await reopen();
    if (stop === undefined && !enough())
      stop = { outcome: "not-reached", reason: dismissalBudgetReason };
    if (stop !== undefined) {
      tests.push({ method, outcome: stop.outcome, reason: stop.reason });
      continue;
    }
    if (method === "escape") {
      const { focusedTrigger, panelId } = await focusBeforeEscape(
        page,
        trigger,
        root,
      );
      await page.keyboard.press("Escape");
      const closed = await waitFor(page, trigger, root, false, windowMs);
      open = !closed;
      if (!closed) {
        tests.push({ method, outcome: "stayed-open" });
        continue;
      }
      const focus = await readFocus(page, trigger, panelId);
      tests.push({
        method,
        outcome: "closed",
        focus: { ...focus, ...(focusedTrigger ? { focusedTrigger } : {}) },
      });
      continue;
    }
    // Layout may move after a reopen: find the point again.
    const points = await classify(page, trigger, root, options.explicit);
    const target = method === "outside" ? points.outside : points.iframe;
    if (target === undefined) {
      tests.push({
        method,
        outcome: "not-tested",
        reason:
          method === "outside"
            ? "no empty point outside the panel"
            : "no visible same-origin iframe",
      });
      continue;
    }
    const point = { x: target.x, y: target.y };
    const frame =
      method === "iframe" && points.iframe
        ? { selector: points.iframe.selector, name: points.iframe.name }
        : undefined;
    const url = page.url();
    let popups = 0;
    const onPopup = () => {
      popups += 1;
    };
    page.on("popup", onPopup);
    let closed = false;
    try {
      await page.mouse.click(point.x, point.y);
      closed = await waitFor(page, trigger, root, false, windowMs);
    } finally {
      page.off("popup", onPopup);
    }
    if (page.url() !== url || popups > 0) {
      disturbed = true;
      tests.push({
        method,
        outcome: "inconclusive",
        reason: page.url() !== url ? "navigated" : "opened a window",
        point,
        ...(frame === undefined ? {} : { iframe: frame }),
      });
      stop = { outcome: "not-tested", reason: "an earlier test left the page" };
      continue;
    }
    open = !closed;
    tests.push({
      method,
      outcome: closed ? "closed" : "stayed-open",
      point,
      ...(frame === undefined ? {} : { iframe: frame }),
    });
  }
  const unreached = tests.filter((test) => test.outcome === "not-reached");
  const status =
    unreached.length === 0
      ? "tested"
      : tests.every(
            (test) =>
              test.outcome === "not-reached" || test.outcome === "not-tested",
          )
        ? "not-reached"
        : "partial";
  return {
    dismissal: {
      ...base,
      status,
      ...(status === "tested" ? {} : { reason: dismissalBudgetReason }),
      tests,
    },
    disturbed,
  };
}
