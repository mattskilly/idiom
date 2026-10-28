import type { Page } from "playwright";
import type { FocusVisibleObservation, GeometryScan } from "../checks/types.js";
import { parkPointer } from "./touch.js";

export type FocusSweepOptions = {
  /** Most Tab stops to take; the scan is partial when reached. */
  maxStops: number;
  /** Selectors whose controls (and descendants) are not judged. */
  ignore: string[];
  /** Wall-clock budget for the sweep; the scan is partial when exceeded. */
  budgetMs?: number | undefined;
  monotonicNow?: (() => number) | undefined;
};

type Stop =
  | { kind: "end" }
  | { kind: "skip" }
  | { kind: "record"; record: FocusVisibleObservation };

/**
 * Tabs through the page and records, for each keyboard focus stop, which
 * painted properties changed against the resting state. Runs after saved
 * evidence (focus rings never reach the screenshot) and restores the page.
 */
export async function sweepFocusVisible(
  page: Page,
  options: FocusSweepOptions,
): Promise<GeometryScan<FocusVisibleObservation>> {
  const now = options.monotonicNow ?? (() => performance.now());
  const started = now();
  await parkPointer(page);
  await page.evaluate((ignore: string[]) => {
    const properties = [
      "outlineStyle",
      "outlineWidth",
      "outlineColor",
      "boxShadow",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "backgroundColor",
      "color",
      "textDecorationLine",
      "opacity",
      "transform",
      "clip",
      "clipPath",
    ] as const;
    const read = (style: CSSStyleDeclaration, pseudo: boolean) => {
      const values: Record<string, string> = {};
      for (const property of properties) values[property] = style[property];
      // An outline only paints when it has a style and a width.
      if (
        values.outlineStyle === "none" ||
        Number.parseFloat(values.outlineWidth ?? "0") <= 0
      ) {
        values.outlineStyle = "none";
        values.outlineWidth = "0px";
        values.outlineColor = "";
      }
      if (pseudo) values.content = style.content;
      return values;
    };
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
    const selectorFor = (element: Element) =>
      element.id ? `#${CSS.escape(element.id)}` : pathFor(element);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const style = document.createElement("style");
    style.textContent =
      "*,*::before,*::after{transition:none!important;animation:none!important}";
    document.head.append(style);
    const focusable = [
      ...document.querySelectorAll(
        'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]',
      ),
    ];
    type Related = { key: string; element: Element; pseudo?: string };
    const related = (element: Element): Related[] => {
      const nodes: Related[] = [
        { key: "self", element },
        { key: "self::before", element, pseudo: "::before" },
        { key: "self::after", element, pseudo: "::after" },
      ];
      let parent = element.parentElement;
      for (let depth = 1; depth <= 3 && parent; depth++) {
        nodes.push({ key: `parent${depth}`, element: parent });
        parent = parent.parentElement;
      }
      if (element.nextElementSibling)
        nodes.push({ key: "sibling", element: element.nextElementSibling });
      const labels = (element as HTMLInputElement).labels;
      for (const [index, label] of [...(labels ?? [])].entries())
        nodes.push({ key: `label${index + 1}`, element: label });
      return nodes;
    };
    // Movement alone is not an indicator: Tab scrolls the page and scroll
    // containers, which moves fixed and scrolled controls without any
    // visible change. Only a control parked out of reach at rest (a skip
    // link above or left of the document, or collapsed to a pixel) counts
    // as revealed when focus brings it on screen.
    const outOfReach = (r: DOMRect) =>
      r.width <= 1 ||
      r.height <= 1 ||
      r.right + scrollX <= 0 ||
      r.bottom + scrollY <= 0;
    const onScreen = (r: DOMRect) =>
      !outOfReach(r) &&
      r.right > 0 &&
      r.bottom > 0 &&
      r.left < innerWidth &&
      r.top < innerHeight;
    const snapshot = (element: Element) => ({
      parked: outOfReach(element.getBoundingClientRect()),
      entries: related(element).map(({ key, element: node, pseudo }) => ({
        key,
        node,
        pseudo,
        values: read(
          getComputedStyle(node, pseudo ?? null),
          pseudo !== undefined,
        ),
      })),
    });
    const snapshots = new WeakMap<Element, ReturnType<typeof snapshot>>();
    for (const element of focusable) {
      const rect = element.getBoundingClientRect();
      const computed = getComputedStyle(element);
      if (
        computed.display === "none" ||
        computed.visibility === "hidden" ||
        (rect.width <= 0 && rect.height <= 0 && !element.matches("input"))
      )
        continue;
      snapshots.set(element, snapshot(element));
    }
    const ignored = (element: Element) =>
      ignore.some((selector) => {
        try {
          return element.closest(selector) !== null;
        } catch {
          return false;
        }
      });
    let first: Element | undefined;
    const visited = new Set<Element>();
    (window as unknown as { __idiomFocusSweep: unknown }).__idiomFocusSweep = {
      style,
      scroll: { x: scrollX, y: scrollY },
      step: () => {
        let active: Element | null = document.activeElement;
        while (active?.shadowRoot?.activeElement)
          active = active.shadowRoot.activeElement;
        if (
          active === null ||
          active === document.body ||
          active === document.documentElement
        )
          return { kind: "end" };
        if (first === undefined) first = active;
        else if (active === first) return { kind: "end" };
        if (visited.has(active) || active.tagName === "IFRAME")
          return { kind: "skip" };
        visited.add(active);
        const before = snapshots.get(active);
        if (before === undefined || ignored(active)) return { kind: "skip" };
        const changed: string[] = [];
        for (const entry of before.entries) {
          if (!entry.node.isConnected) continue;
          const current = read(
            getComputedStyle(entry.node, entry.pseudo ?? null),
            entry.pseudo !== undefined,
          );
          for (const [property, value] of Object.entries(entry.values))
            if (current[property] !== value)
              changed.push(`${entry.key}.${property}`);
        }
        const r = active.getBoundingClientRect();
        if (before.parked && onScreen(r)) changed.push("self.rect");
        let proxy: string | undefined;
        if (r.width < 2 || r.height < 2) {
          const stand = before.entries.find(
            (entry) =>
              entry.pseudo === undefined &&
              (entry.key === "sibling" || entry.key.startsWith("label")) &&
              entry.node.getBoundingClientRect().width >= 2,
          );
          if (stand) proxy = selectorFor(stand.node);
        }
        const name = (
          active.getAttribute("aria-label") ??
          ((active as HTMLElement).innerText ||
            active.getAttribute("title") ||
            (active as HTMLInputElement).placeholder ||
            "")
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        return {
          kind: "record",
          record: {
            selector: selectorFor(active),
            name,
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            changed,
            ...(proxy === undefined ? {} : { proxy }),
          },
        };
      },
    };
  }, options.ignore);
  const records: FocusVisibleObservation[] = [];
  let reason: string | undefined;
  try {
    for (let stop = 0; ; stop++) {
      if (stop >= options.maxStops) {
        reason = `focus sweep stopped after ${options.maxStops} stops`;
        break;
      }
      if (
        options.budgetMs !== undefined &&
        now() - started > options.budgetMs
      ) {
        reason = "focus sweep time budget exhausted";
        break;
      }
      const trialStarted = now();
      await page.keyboard.press("Tab");
      const result = (await page.evaluate(() =>
        (
          window as unknown as { __idiomFocusSweep: { step: () => unknown } }
        ).__idiomFocusSweep.step(),
      )) as Stop;
      if (result.kind === "end") break;
      if (result.kind === "record")
        records.push({ ...result.record, elapsedMs: now() - trialStarted });
    }
  } finally {
    await page
      .evaluate(() => {
        const sweep = (
          window as unknown as {
            __idiomFocusSweep?: {
              style: HTMLStyleElement;
              scroll: { x: number; y: number };
            };
          }
        ).__idiomFocusSweep;
        if (sweep === undefined) return;
        sweep.style.remove();
        (document.activeElement as HTMLElement | null)?.blur?.();
        scrollTo(sweep.scroll.x, sweep.scroll.y);
        delete (window as unknown as { __idiomFocusSweep?: unknown })
          .__idiomFocusSweep;
      })
      .catch(() => undefined);
  }
  return reason === undefined
    ? { status: "ran", records }
    : { status: "partial", reason, records };
}
