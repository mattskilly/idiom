import type { Page } from "playwright";
import type {
  BrowserDefaultLegendObservation,
  BrowserDefaultLinkObservation,
  ChromeTokenUseObservation,
  GeometryScan,
  NativeScrollbarObservation,
} from "./types.js";

export type ChromeDefaultsInput = {
  selectorFor: (element: Element) => string;
  /** Author style rules the observe pass collected (cross-origin skipped). */
  rules: ReadonlyArray<{ selector: string; style: CSSStyleDeclaration }>;
  /** Author stylesheets whose rules could not be read. */
  unreadableSheets: number;
  /** Whether an author rule or the inline style sets `color` on the element. */
  authoredColor: (element: Element) => boolean;
  /** Chrome-like token names from the configured tokens file. */
  chromeTokens: readonly string[];
  /** The tokens file's custom-property declarations. */
  tokenDeclarations: Readonly<Record<string, string>>;
  enabled: {
    nativeScrollbar: boolean;
    browserDefaultStyle: boolean;
    unusedToken: boolean;
  };
};

export type ChromeDefaultsResult = {
  browserDefaultLinks?: {
    count: number;
    records: BrowserDefaultLinkObservation[];
  };
  browserDefaultLegends?: {
    count: number;
    records: BrowserDefaultLegendObservation[];
  };
  chromeTokenUse?: ChromeTokenUseObservation;
};

export type NativeScrollbarMeasurement = {
  scan: GeometryScan<NativeScrollbarObservation>;
  /** False when a filled textarea could not be put back as it was. */
  restored: boolean;
};

export type ChromeDefaultsWindow = Window & {
  __idiomChromeDefaults?: {
    scan(input: ChromeDefaultsInput): ChromeDefaultsResult;
    measure(): NativeScrollbarMeasurement;
  };
};

/** Thresholds the scans use, in CSS px unless stated. */
export const chromeDefaultsLimits = {
  /** Ancestors above the scroller searched for a styled box. */
  boxAncestors: 3,
  /** A gutter narrower than this is not a space-taking scrollbar. */
  minGutter: 1,
  /** Records kept per scan. */
  maxRecords: 50,
  /** Lines written into a textarea: at least this many… */
  minFillLines: 40,
  /** …and never more than this many. */
  maxFillLines: 400,
} as const;

// Serialized by Playwright: self-contained, no runtime imports. Requires
// window.__idiomVisibility (installed by ensureVisibilityDom).
export function installChromeDefaultsDom(limits: typeof chromeDefaultsLimits) {
  const w = window as ChromeDefaultsWindow;
  type Pending = {
    element: Element;
    selector: string;
    kind: "scroller" | "textarea";
    axes: Array<"vertical" | "horizontal">;
    box: string;
    boxReason: "radius" | "background";
    radius: number;
  };
  let pending: Pending[] = [];
  let unreadable = 0;

  const transparent = (color: string): boolean => {
    if (color === "transparent") return true;
    const match = /^rgba?\(([^)]*)\)$/.exec(color.trim());
    if (!match) return false;
    const parts = (match[1] ?? "").split(/[\s,/]+/).filter(Boolean);
    return parts.length >= 4 && Number.parseFloat(parts[3] ?? "1") === 0;
  };

  /** Top-level alternatives of a selector list (commas outside brackets). */
  const splitList = (selector: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let quote = "";
    let current = "";
    for (const character of selector) {
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "(" || character === "[") depth += 1;
      else if (character === ")" || character === "]") depth -= 1;
      else if (character === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
      current += character;
    }
    if (current.trim() !== "") parts.push(current.trim());
    return parts;
  };

  /**
   * A base selector that is empty or ends in a combinator matches anything
   * there. Trailing whitespace is the descendant combinator, so
   * `.panel ::-webkit-scrollbar` styles `.panel *`, not `.panel`.
   */
  const completeBase = (base: string): string => {
    const trimmed = base.trim();
    return trimmed === "" || /[>+~]$/.test(trimmed) || /\s$/.test(base)
      ? `${trimmed} *`
      : trimmed;
  };

  const inProbeLayer = (style: CSSStyleDeclaration): boolean => {
    let rule: CSSRule | null = style.parentRule;
    while (rule) {
      if (
        typeof CSSLayerBlockRule !== "undefined" &&
        rule instanceof CSSLayerBlockRule &&
        rule.name === "idiom-probe-scrollbars"
      )
        return true;
      rule = rule.parentRule;
    }
    return false;
  };

  const scan = (input: ChromeDefaultsInput): ChromeDefaultsResult => {
    const { selectorFor } = input;
    unreadable = input.unreadableSheets;
    pending = [];
    const painted = (element: Element): boolean =>
      window.__idiomVisibility.painted(element).value;

    // Base selectors of author ::-webkit-scrollbar rules: an element one of
    // them matches has its scrollbar styled.
    const webkitBases: string[] = [];
    for (const rule of input.rules) {
      if (!rule.selector.includes("::-webkit-scrollbar")) continue;
      if (inProbeLayer(rule.style)) continue;
      for (const alternative of splitList(rule.selector)) {
        const index = alternative.indexOf("::-webkit-scrollbar");
        if (index < 0) continue;
        webkitBases.push(completeBase(alternative.slice(0, index)));
      }
    }
    const webkitStyled = (element: Element): boolean =>
      webkitBases.some((base) => {
        try {
          return element.matches(base);
        } catch {
          // An unparseable base cannot rule styling out.
          return true;
        }
      });
    const scrollbarUnstyled = (element: Element): boolean => {
      const style = getComputedStyle(element);
      return (
        style.getPropertyValue("scrollbar-width") === "auto" &&
        style.getPropertyValue("scrollbar-color") === "auto" &&
        !webkitStyled(element)
      );
    };

    const canvas = (() => {
      for (const element of [document.body, document.documentElement]) {
        if (!element) continue;
        const color = getComputedStyle(element).backgroundColor;
        if (!transparent(color)) return color;
      }
      return "rgb(255, 255, 255)";
    })();
    const radiusOf = (style: CSSStyleDeclaration): number =>
      Math.max(
        ...[
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ].map((value) => Number.parseFloat(value) || 0),
      );
    const styledBox = (
      element: Element,
    ):
      | { box: string; boxReason: "radius" | "background"; radius: number }
      | undefined => {
      let current: Element | null = element;
      for (
        let step = 0;
        current && step <= limits.boxAncestors;
        step += 1, current = current.parentElement
      ) {
        if (current === document.body || current === document.documentElement)
          return undefined;
        const style = getComputedStyle(current);
        const radius = radiusOf(style);
        if (radius > 0)
          return { box: selectorFor(current), boxReason: "radius", radius };
        if (
          style.backgroundImage !== "none" ||
          (!transparent(style.backgroundColor) &&
            style.backgroundColor !== canvas)
        )
          return { box: selectorFor(current), boxReason: "background", radius };
      }
      return undefined;
    };

    if (input.enabled.nativeScrollbar && unreadable === 0) {
      const documentScroller = document.scrollingElement;
      let textarea: Pending | undefined;
      for (const element of document.querySelectorAll("body *")) {
        if (
          element === documentScroller ||
          element === document.body ||
          element === document.documentElement
        )
          continue;
        const tag = element.localName;
        if (tag === "select" || tag === "iframe") continue;
        if (tag === "textarea") {
          if (textarea) continue;
          const area = element as HTMLTextAreaElement;
          if (area.disabled || !painted(area)) continue;
          const overflowY = getComputedStyle(area).overflowY;
          if (overflowY === "hidden" || overflowY === "clip") continue;
          if (!scrollbarUnstyled(area)) continue;
          const box = styledBox(area);
          if (!box) continue;
          textarea = {
            element: area,
            selector: selectorFor(area),
            kind: "textarea",
            axes: ["vertical"],
            ...box,
          };
          continue;
        }
        if (!(element instanceof HTMLElement)) continue;
        const style = getComputedStyle(element);
        const scrolls = (value: string) =>
          value === "auto" || value === "scroll";
        const axes: Array<"vertical" | "horizontal"> = [];
        if (
          scrolls(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 1
        )
          axes.push("vertical");
        if (
          scrolls(style.overflowX) &&
          element.scrollWidth > element.clientWidth + 1
        )
          axes.push("horizontal");
        if (axes.length === 0) continue;
        if (element.clientWidth === 0 || element.clientHeight === 0) continue;
        if (!painted(element)) continue;
        if (!scrollbarUnstyled(element)) continue;
        const box = styledBox(element);
        if (!box) continue;
        pending.push({
          element,
          selector: selectorFor(element),
          kind: "scroller",
          axes,
          ...box,
        });
      }
      if (textarea) pending.push(textarea);
    }

    const result: ChromeDefaultsResult = {};

    if (input.enabled.browserDefaultStyle) {
      const defaults = new Set(["rgb(0, 0, 238)", "rgb(85, 26, 139)"]);
      const records: BrowserDefaultLinkObservation[] = [];
      let count = 0;
      for (const link of document.querySelectorAll("a[href]")) {
        const color = getComputedStyle(link).color;
        if (!defaults.has(color)) continue;
        if (!painted(link)) continue;
        if (input.authoredColor(link)) continue;
        count += 1;
        if (records.length < limits.maxRecords)
          records.push({
            selector: selectorFor(link),
            color,
            text: (link.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 80),
          });
      }
      result.browserDefaultLinks = { count, records };

      // A legend notched into its fieldset's painted top border: the
      // browser's default fieldset look, in place of a styled heading.
      const legends: BrowserDefaultLegendObservation[] = [];
      let legendCount = 0;
      const visibleText = (element: Element): boolean => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!/\S/.test(node.textContent ?? "")) continue;
          const parent = node.parentElement;
          if (!parent || !painted(parent)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const r = range.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      };
      for (const fieldset of document.querySelectorAll("fieldset")) {
        if (fieldset.getAttribute("aria-hidden") === "true") continue;
        if (
          fieldset.closest(
            'article, [contenteditable]:not([contenteditable="false"])',
          )
        )
          continue;
        if (!painted(fieldset)) continue;
        const fs = getComputedStyle(fieldset);
        const borderTop = Number.parseFloat(fs.borderTopWidth) || 0;
        if (
          borderTop <= 0 ||
          ["none", "hidden"].includes(fs.borderTopStyle) ||
          transparent(fs.borderTopColor)
        )
          continue;
        const legend = [...fieldset.children].find(
          (child) => child.localName === "legend",
        );
        if (!legend || !painted(legend)) continue;
        const ls = getComputedStyle(legend);
        if (ls.float !== "none") continue;
        if (ls.position === "absolute" || ls.position === "fixed") continue;
        if (!visibleText(legend)) continue;
        const f = fieldset.getBoundingClientRect();
        const l = legend.getBoundingClientRect();
        if (!(l.top < f.top + borderTop && l.bottom > f.top)) continue;
        legendCount += 1;
        if (legends.length < limits.maxRecords)
          legends.push({
            selector: selectorFor(legend),
            fieldset: selectorFor(fieldset),
            text: (legend.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 80),
          });
      }
      result.browserDefaultLegends = { count: legendCount, records: legends };
    }

    if (input.enabled.unusedToken) {
      const candidates = [...new Set(input.chromeTokens)].sort();
      const references = (text: string): string[] =>
        [...text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map(
          (match) => match[1] as string,
        );
      const statePseudo =
        /:(?:hover|focus-visible|focus-within|focus|active|visited|checked|disabled|placeholder-shown|invalid|before|after|first-line|first-letter)(?![\w-])/g;
      const pseudoElement = /::[\w-]+(?:\([^)]*\))?(?::[\w-]+(?:\([^)]*\))?)*/g;
      const live = (selector: string): boolean => {
        const base = completeBase(
          selector.replace(pseudoElement, "").replace(statePseudo, ""),
        );
        try {
          return document.querySelector(base) !== null;
        } catch {
          return true;
        }
      };
      const seeds = new Set<string>();
      const edges = new Map<string, Set<string>>();
      const addEdges = (name: string, value: string) => {
        let set = edges.get(name);
        if (!set) {
          set = new Set();
          edges.set(name, set);
        }
        for (const reference of references(value)) set.add(reference);
      };
      for (const [name, value] of Object.entries(input.tokenDeclarations))
        addEdges(name, value);
      for (const rule of input.rules) {
        if (inProbeLayer(rule.style)) continue;
        if (!live(rule.selector)) continue;
        for (const property of rule.style)
          if (property.startsWith("--"))
            addEdges(property, rule.style.getPropertyValue(property));
        // Shorthands holding var() serialize only in cssText.
        const ordinary = rule.style.cssText.replace(
          /(?:^|;)\s*--[A-Za-z0-9_-]+\s*:[^;]*/g,
          ";",
        );
        for (const reference of references(ordinary)) seeds.add(reference);
      }
      for (const element of document.querySelectorAll("[style]"))
        for (const reference of references(element.getAttribute("style") ?? ""))
          seeds.add(reference);
      const used = new Set<string>();
      const queue = [...seeds];
      while (queue.length > 0) {
        const name = queue.pop() as string;
        if (used.has(name)) continue;
        used.add(name);
        for (const next of edges.get(name) ?? []) queue.push(next);
      }
      result.chromeTokenUse = {
        candidates: candidates.slice(0, 200),
        used: candidates.filter((name) => used.has(name)).slice(0, 200),
        complete: unreadable === 0,
      };
    }
    return result;
  };

  const measure = (): NativeScrollbarMeasurement => {
    if (unreadable > 0)
      return {
        scan: {
          status: "partial",
          reason: `${unreadable} stylesheet${unreadable === 1 ? "" : "s"} could not be read; scrollbar styling cannot be ruled out`,
          records: [],
        },
        restored: true,
      };
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;left:-10000px;top:0;width:100px;height:100px;overflow:scroll;visibility:hidden;border:0;padding:0;";
    const inner = document.createElement("div");
    inner.style.cssText = "width:200px;height:200px;";
    probe.append(inner);
    (document.body ?? document.documentElement).append(probe);
    const selfTest = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    if (selfTest < limits.minGutter)
      return {
        scan: {
          status: "partial",
          reason: "the browser did not show classic scrollbars",
          records: [],
        },
        restored: true,
      };

    const records: NativeScrollbarObservation[] = [];
    let restored = true;
    for (const candidate of pending) {
      const element = candidate.element as HTMLElement;
      if (!element.isConnected) continue;
      let saved:
        | {
            value: string;
            start: number | null;
            end: number | null;
            direction: "forward" | "backward" | "none" | null;
            top: number;
            left: number;
          }
        | undefined;
      const area =
        candidate.kind === "textarea"
          ? (element as HTMLTextAreaElement)
          : undefined;
      try {
        if (area) {
          saved = {
            value: area.value,
            start: area.selectionStart,
            end: area.selectionEnd,
            direction: area.selectionDirection,
            top: area.scrollTop,
            left: area.scrollLeft,
          };
          const style = getComputedStyle(area);
          const lineHeight =
            Number.parseFloat(style.lineHeight) ||
            (Number.parseFloat(style.fontSize) || 16) * 1.2;
          const lines = Math.min(
            limits.maxFillLines,
            Math.max(
              limits.minFillLines,
              Math.ceil(area.clientHeight / lineHeight) + 10,
            ),
          );
          area.value = Array.from(
            { length: lines },
            (_, index) => `${index + 1}`,
          ).join("\n");
        }
        const style = getComputedStyle(element);
        const border = (side: string) =>
          Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) ||
          0;
        const axes: Array<"vertical" | "horizontal"> = [];
        let gutter = 0;
        if (
          candidate.axes.includes("vertical") &&
          element.scrollHeight > element.clientHeight + 1
        ) {
          const size =
            element.offsetWidth -
            element.clientWidth -
            border("left") -
            border("right");
          if (size >= limits.minGutter) {
            axes.push("vertical");
            gutter = Math.max(gutter, size);
          }
        }
        if (
          candidate.axes.includes("horizontal") &&
          element.scrollWidth > element.clientWidth + 1
        ) {
          const size =
            element.offsetHeight -
            element.clientHeight -
            border("top") -
            border("bottom");
          if (size >= limits.minGutter) {
            axes.push("horizontal");
            gutter = Math.max(gutter, size);
          }
        }
        if (axes.length > 0) {
          const rect = element.getBoundingClientRect();
          records.push({
            selector: candidate.selector,
            kind: candidate.kind,
            axes,
            gutter: Math.round(gutter * 100) / 100,
            rect: {
              x: rect.x + scrollX,
              y: rect.y + scrollY,
              width: rect.width,
              height: rect.height,
            },
            box: candidate.box,
            boxReason: candidate.boxReason,
            radius: candidate.radius,
            filled: area !== undefined,
          });
        }
      } finally {
        if (area && saved) {
          area.value = saved.value;
          try {
            area.setSelectionRange(
              saved.start ?? 0,
              saved.end ?? saved.start ?? 0,
              saved.direction ?? "none",
            );
          } catch {
            // Selection is unavailable on some input states.
          }
          area.scrollTop = saved.top;
          area.scrollLeft = saved.left;
          if (area.value !== saved.value) restored = false;
        }
      }
    }
    records.sort((left, right) =>
      left.selector < right.selector
        ? -1
        : left.selector > right.selector
          ? 1
          : 0,
    );
    return {
      scan: { status: "ran", records: records.slice(0, limits.maxRecords) },
      restored,
    };
  };

  w.__idiomChromeDefaults = { scan, measure };
}

export async function ensureChromeDefaultsDom(page: Page): Promise<void> {
  await page.evaluate(installChromeDefaultsDom, chromeDefaultsLimits);
}
