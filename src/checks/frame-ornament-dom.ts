import type { Page } from "playwright";
import type {
  EmptyFrameObservation,
  GlyphOverlapObservation,
  Rect,
  RowOrnamentObservation,
} from "./types.js";

export type FrameOrnamentInput = {
  selectorFor: (element: Element) => string;
  /** Elements marked intentionally empty; they and their subtrees are skipped. */
  exempt: readonly Element[];
  /** Source of the unicode glyph character class (glyph-icon's). */
  glyphSource: string;
  enabled: {
    emptyFrame: boolean;
    rowOrnament: boolean;
    glyphOverIcon: boolean;
  };
};

export type FrameOrnamentResult = {
  emptyFrames?: EmptyFrameObservation[];
  rowOrnaments?: RowOrnamentObservation[];
  glyphOverlaps?: GlyphOverlapObservation[];
};

export type FrameOrnamentWindow = Window & {
  __idiomFrameOrnaments?: (input: FrameOrnamentInput) => FrameOrnamentResult;
};

/** The thresholds the three scans use, in CSS px unless stated. */
export const frameOrnamentLimits = {
  frameMinWidth: 48,
  frameMinHeight: 24,
  iconMax: 32,
  glyphMax: 16,
  glyphControlMax: 64,
  glyphOverlapRatio: 0.25,
  chipMaxWidth: 160,
  chipMaxHeight: 40,
  chipMaxChars: 24,
  markMax: 16,
  minItems: 5,
  itemShare: 0.8,
  primaryCoverage: 0.6,
} as const;

// Serialized by Playwright: self-contained, no runtime imports. Requires
// window.__idiomVisibility (installed by ensureVisibilityDom).
export function installFrameOrnamentDom(limits: typeof frameOrnamentLimits) {
  const w = window as FrameOrnamentWindow;
  w.__idiomFrameOrnaments = (input) => {
    const { selectorFor } = input;
    const styles = new Map<Element, CSSStyleDeclaration>();
    const style = (element: Element) => {
      let value = styles.get(element);
      if (!value) {
        value = getComputedStyle(element);
        styles.set(element, value);
      }
      return value;
    };
    const facts = new Map<
      Element,
      ReturnType<typeof window.__idiomVisibility.painted>
    >();
    const fact = (element: Element) => {
      let value = facts.get(element);
      if (!value) {
        value = window.__idiomVisibility.painted(element);
        facts.set(element, value);
      }
      return value;
    };
    const painted = (element: Element): boolean => fact(element).value;
    /**
     * Painted, or about to be: content faded to opacity 0 (a scroll reveal)
     * and an image that has no box until it loads are still content.
     */
    const present = (element: Element): boolean => {
      const known = fact(element);
      return (
        known.value ||
        known.reason === "opacity-0" ||
        (known.reason === "zero-area" && element.matches(mediaSelector))
      );
    };
    const box = (element: Element): Rect => {
      const r = element.getBoundingClientRect();
      return {
        x: Math.round(r.x * 100) / 100,
        y: Math.round(r.y * 100) / 100,
        width: Math.round(r.width * 100) / 100,
        height: Math.round(r.height * 100) / 100,
      };
    };
    const alpha = (color: string): number => {
      const value = color.trim();
      if (value === "" || value === "transparent") return 0;
      const rgba = value.match(/^rgba\((.*)\)$/);
      if (rgba) {
        const parts = (rgba[1] ?? "").split(/[\s,/]+/).filter(Boolean);
        return parts.length >= 4 ? Number(parts[3]) : 1;
      }
      const slash = value.match(/\/\s*([\d.]+%?)\s*\)$/);
      if (slash?.[1])
        return slash[1].endsWith("%")
          ? Number(slash[1].slice(0, -1)) / 100
          : Number(slash[1]);
      return 1;
    };
    const sides = ["top", "right", "bottom", "left"] as const;
    const cap = (side: string) => side[0]?.toUpperCase() + side.slice(1);
    const borderSides = (element: Element) => {
      const s = style(element) as unknown as Record<string, string>;
      return sides.filter((side) => {
        const name = cap(side);
        return (
          Number.parseFloat(s[`border${name}Width`] ?? "0") > 0 &&
          !["none", "hidden"].includes(s[`border${name}Style`] ?? "none") &&
          alpha(s[`border${name}Color`] ?? "") > 0
        );
      });
    };
    const hasBorder = (element: Element) => borderSides(element).length > 0;
    const fillOf = (element: Element) => {
      const color = style(element).backgroundColor;
      return alpha(color) > 0 ? color : undefined;
    };
    const parentFill = (element: Element): string => {
      for (
        let current = element.parentElement;
        current;
        current = current.parentElement
      ) {
        const fill = fillOf(current);
        if (fill !== undefined) return fill;
      }
      return "rgb(255, 255, 255)";
    };
    const imageNone = (value: string | undefined) =>
      value === undefined || value === "" || value === "none";
    /** A pseudo-element that draws something: text, an icon glyph or a shape. */
    const pseudoDraws = (element: Element, which: "::before" | "::after") => {
      const s = getComputedStyle(element, which);
      const content = s.content;
      if (!content || content === "none" || content === "normal") return false;
      if (s.display === "none") return false;
      if (content !== '""' && content !== "''") return true;
      return (
        alpha(s.backgroundColor) > 0 ||
        !imageNone(s.backgroundImage) ||
        !imageNone(s.getPropertyValue("mask-image")) ||
        !imageNone(s.getPropertyValue("-webkit-mask-image")) ||
        Number.parseFloat(s.borderTopWidth) > 0 ||
        Number.parseFloat(s.borderBottomWidth) > 0 ||
        Number.parseFloat(s.borderLeftWidth) > 0 ||
        Number.parseFloat(s.borderRightWidth) > 0
      );
    };
    const pseudoText = (element: Element) => {
      for (const which of ["::before", "::after"] as const) {
        const content = getComputedStyle(element, which).content;
        if (
          content &&
          content !== "none" &&
          content !== "normal" &&
          content !== '""' &&
          content !== "''"
        )
          return content;
      }
      return undefined;
    };
    const mediaSelector =
      "img, picture, video, canvas, iframe, object, embed, input, select, textarea, meter, progress, svg, [role='img']";
    const interactiveSelector =
      'a[href], button, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]';
    const focusableSelector = `${interactiveSelector}, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])`;
    const textOf = (element: Element) =>
      (element.textContent ?? "").replace(/\s+/g, " ").trim();
    const fits = (element: Element, max: number) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.width <= max && r.height <= max;
    };
    /** svg (outermost), img, role=img, an icon-font glyph or an image-drawn box. */
    const isIcon = (element: Element, max: number): boolean => {
      const tag = element.localName;
      if (tag === "svg")
        return (
          element.parentElement?.closest("svg") == null && fits(element, max)
        );
      if (element.closest("svg") !== null) return false;
      if (tag === "img" || element.getAttribute("role") === "img")
        return fits(element, max);
      if (!fits(element, max)) return false;
      if (textOf(element) !== "" && element.children.length > 0) return false;
      if (pseudoText(element) !== undefined && textOf(element) === "")
        return true;
      const s = style(element);
      return (
        textOf(element) === "" &&
        (!imageNone(s.backgroundImage) ||
          !imageNone(s.getPropertyValue("mask-image")) ||
          !imageNone(s.getPropertyValue("-webkit-mask-image")))
      );
    };
    const iconIdentity = (element: Element): string => {
      if (element instanceof HTMLImageElement)
        return `img:${element.currentSrc || element.src}`;
      if (element.localName === "svg") {
        const use = element.querySelector("use");
        const href =
          use?.getAttribute("href") ?? use?.getAttribute("xlink:href") ?? null;
        if (href) return `use:${href}`;
        const markup = element.innerHTML.replace(/\s+/g, " ").trim();
        let hash = 5381;
        for (let i = 0; i < markup.length; i += 1)
          hash = ((hash * 33) ^ markup.charCodeAt(i)) >>> 0;
        return `svg:${hash.toString(36)}:${markup.length}`;
      }
      const pseudo = pseudoText(element);
      const s = style(element);
      if (pseudo !== undefined) return `font:${pseudo}:${s.fontFamily}`;
      const image = !imageNone(s.backgroundImage)
        ? s.backgroundImage
        : s.getPropertyValue("mask-image") ||
          s.getPropertyValue("-webkit-mask-image");
      return `image:${image}`;
    };
    const iconName = (element: Element): string => {
      const label =
        element.getAttribute("aria-label") ??
        element.getAttribute("title") ??
        element.getAttribute("alt") ??
        element.querySelector("title")?.textContent ??
        "";
      if (label.trim() !== "") return label.trim().slice(0, 80);
      const words = [...element.classList]
        .flatMap((value) => value.split(/[-_\s]+/))
        .filter(
          (word) =>
            /^[a-z]{3,}$/i.test(word) &&
            !/^(?:icon|icons|svg|img|glyph|lucide|feather|material|symbols|outlined|rounded|fa|fas|far|fab|small|large|inline|block)$/i.test(
              word,
            ),
        );
      return words.length > 0 ? words.slice(0, 3).join(" ") : "icon";
    };
    const exempt = input.exempt;
    const isExempt = (element: Element) =>
      exempt.some((root) => root === element || root.contains(element));

    // ---- empty-frame -------------------------------------------------------
    const hasContent = (frame: Element): boolean => {
      if (pseudoDraws(frame, "::before") || pseudoDraws(frame, "::after"))
        return true;
      const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!/\S/.test(node.textContent ?? "")) continue;
        const parent = node.parentElement;
        if (!parent || !present(parent)) continue;
        if (alpha(style(parent).color) <= 0) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      for (const media of frame.querySelectorAll(mediaSelector)) {
        if (media.parentElement?.closest("svg") && media.localName !== "svg")
          continue;
        if (present(media)) return true;
      }
      for (const control of frame.querySelectorAll(focusableSelector))
        if (present(control)) return true;
      for (const element of frame.querySelectorAll("*")) {
        if (element.closest("svg")) continue;
        const s = style(element);
        if (s.display === "none") continue;
        const draws =
          !imageNone(s.backgroundImage) ||
          !imageNone(s.getPropertyValue("mask-image")) ||
          !imageNone(s.getPropertyValue("-webkit-mask-image")) ||
          pseudoDraws(element, "::before") ||
          pseudoDraws(element, "::after");
        if (draws && present(element)) return true;
      }
      return false;
    };
    const selfExempt = (element: Element, s: CSSStyleDeclaration): boolean => {
      const tag = element.localName;
      if (["html", "body", "hr", "td", "th", "br", "wbr"].includes(tag))
        return true;
      if (element.matches(mediaSelector) || element.closest("svg") !== null)
        return true;
      if (element.matches(focusableSelector)) return true;
      if (
        element.closest(
          `a[href], button, summary, label, [role="button"], [role="link"], [role="tab"], [role="option"], [role="menuitem"], [role="gridcell"], [role="cell"], [role="columnheader"], [role="rowheader"]`,
        )
      )
        return true;
      const role = element.getAttribute("role") ?? "";
      if (["img", "progressbar", "meter", "separator", "slider"].includes(role))
        return true;
      if ((element.getAttribute("aria-label") ?? "").trim() !== "") return true;
      if ((element.getAttribute("title") ?? "").trim() !== "") return true;
      if (
        element.closest(
          "progress, meter, [role='progressbar'], [role='meter'], [aria-busy='true'], [class*='skeleton' i], [class*='shimmer' i], [class*='placeholder' i]",
        )
      )
        return true;
      if (!imageNone(s.backgroundImage)) return true;
      if (typeof element.getAnimations === "function")
        if (element.getAnimations().length > 0) return true;
      return false;
    };
    const scanEmptyFrames = (): EmptyFrameObservation[] => {
      const records: EmptyFrameObservation[] = [];
      const reported: Element[] = [];
      const all = document.body ? document.body.querySelectorAll("*") : [];
      for (const element of all) {
        if (records.length >= 50) break;
        const s = style(element);
        if (s.display === "none" || s.display === "contents") continue;
        const r = element.getBoundingClientRect();
        if (r.width < limits.frameMinWidth || r.height < limits.frameMinHeight)
          continue;
        const borders = borderSides(element);
        const fill = fillOf(element);
        const filled = fill !== undefined && fill !== parentFill(element);
        if (borders.length === 0 && !filled) continue;
        if (reported.some((outer) => outer.contains(element))) continue;
        if (selfExempt(element, s)) continue;
        if (
          (s.position === "fixed" || s.position === "absolute") &&
          borders.length === 0
        )
          continue;
        if (borders.length === 0 && element.closest("[aria-hidden='true']"))
          continue;
        if (isExempt(element)) continue;
        if (!painted(element)) continue;
        if (hasContent(element)) continue;
        reported.push(element);
        const hiddenChildren = [...element.children].filter(
          (child) =>
            ![
              "script",
              "style",
              "template",
              "link",
              "meta",
              "noscript",
            ].includes(child.localName) && !painted(child),
        ).length;
        records.push({
          selector: selectorFor(element),
          rect: box(element),
          paint:
            borders.length > 0 && filled
              ? "both"
              : borders.length > 0
                ? "border"
                : "background",
          borderSides: [...borders],
          hiddenChildren,
        });
      }
      return records;
    };

    // ---- collections (row ornaments) -----------------------------------------
    type Kind = RowOrnamentObservation["collectionKind"];
    type Collection = { container: Element; kind: Kind; items: Element[] };
    const owned = (container: Element, selector: string, owner: string) =>
      [...container.querySelectorAll(selector)].filter(
        (item) => item.parentElement?.closest(owner) === container,
      );
    const gatherCollections = (): Collection[] => {
      const found: Collection[] = [];
      const add = (container: Element, kind: Kind, items: Element[]) => {
        if (found.length >= 100) return;
        const shown = items.filter(painted);
        if (shown.length >= limits.minItems && painted(container))
          found.push({ container, kind, items: shown });
      };
      for (const list of document.querySelectorAll("ul, ol"))
        add(
          list,
          "list",
          [...list.children].filter((child) => child.localName === "li"),
        );
      for (const list of document.querySelectorAll("[role='list']"))
        add(list, "list", owned(list, "[role='listitem']", "[role='list']"));
      for (const table of document.querySelectorAll("table")) {
        const rows = [...(table as HTMLTableElement).rows].filter(
          (row) =>
            row.closest("table") === table &&
            row.parentElement?.localName !== "thead" &&
            ![...row.cells].every((cell) => cell.localName === "th"),
        );
        add(table, "table", rows);
      }
      for (const grid of document.querySelectorAll(
        "[role='grid'], [role='treegrid'], [role='table']",
      ))
        add(
          grid,
          grid.getAttribute("role") === "table" ? "table" : "grid",
          owned(
            grid,
            "[role='row']",
            "[role='grid'], [role='treegrid'], [role='table']",
          ).filter((row) => !row.querySelector("[role='columnheader']")),
        );
      for (const feed of document.querySelectorAll("[role='feed']"))
        add(feed, "feed", owned(feed, "article", "[role='feed']"));
      for (const tablist of document.querySelectorAll("[role='tablist']"))
        add(
          tablist,
          "tablist",
          owned(tablist, "[role='tab']", "[role='tablist']"),
        );
      for (const menu of document.querySelectorAll(
        "[role='menu'], [role='menubar']",
      ))
        add(
          menu,
          "menu",
          owned(
            menu,
            "[role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio']",
            "[role='menu'], [role='menubar']",
          ),
        );
      const claimed = new Set(found.flatMap((collection) => collection.items));
      for (const rail of document.querySelectorAll(
        "nav, [role='navigation'], [role='toolbar']",
      )) {
        const controls = [...rail.querySelectorAll("a[href], button")].filter(
          (control) => painted(control),
        );
        // A control already judged as part of a claimed item (the rail's
        // own list) is not judged again; only the leftovers can make a rail.
        const leftovers = controls.filter((control) => {
          for (
            let current: Element | null = control;
            current && current !== rail;
            current = current.parentElement
          )
            if (claimed.has(current)) return false;
          return true;
        });
        if (leftovers.length < limits.minItems) continue;
        add(rail, "rail", leftovers);
      }
      return found;
    };
    const primaryControl = (item: Element): Element | undefined => {
      if (item.matches(interactiveSelector)) return item;
      const controls = [...item.querySelectorAll(interactiveSelector)].filter(
        painted,
      );
      const r = item.getBoundingClientRect();
      const area = r.width * r.height;
      const covering = controls.find((control) => {
        const c = control.getBoundingClientRect();
        return area > 0 && c.width * c.height >= limits.primaryCoverage * area;
      });
      if (covering) return covering;
      // A lone control is the item's own only when it carries the item's
      // label; a per-row action (copy, menu, delete) beside it is not.
      const only = controls.length === 1 ? controls[0] : undefined;
      const label = textOf(item).length;
      return only !== undefined && label > 0 && textOf(only).length >= label / 2
        ? only
        : undefined;
    };
    type Decoration = {
      element: Element;
      kind: RowOrnamentObservation["kind"];
      slot: string;
      signature: string;
      text: string;
      name: string;
      width: number;
      height: number;
    };
    const slotPath = (item: Element, element: Element) => {
      const parts: string[] = [];
      for (
        let current: Element | null = element;
        current && current !== item;
        current = current.parentElement
      ) {
        const parent: Element | null = current.parentElement;
        const index = parent ? [...parent.children].indexOf(current) + 1 : 0;
        parts.unshift(`${current.localName}[${index}]`);
      }
      return parts.join("/");
    };
    const decorationsOf = (item: Element): Decoration[] => {
      const primary = primaryControl(item);
      const owner = (element: Element) => {
        for (
          let current: Element | null = element.parentElement;
          current;
          current = current.parentElement
        ) {
          if (current.matches(interactiveSelector)) return current;
          if (current === item) return undefined;
        }
        return undefined;
      };
      const chips: Element[] = [];
      const others: Array<{ element: Element; kind: "icon" | "mark" }> = [];
      for (const element of item.querySelectorAll("*")) {
        if (element.matches(focusableSelector)) continue;
        if (["td", "th", "tr", "li"].includes(element.localName)) continue;
        if (element.parentElement?.closest("svg")) continue;
        const control = owner(element);
        if (control !== undefined && control !== primary) continue;
        const r = element.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const s = style(element);
        const fillOrBorder = alpha(s.backgroundColor) > 0 || hasBorder(element);
        const text = textOf(element);
        if (isIcon(element, limits.iconMax)) {
          if (painted(element)) others.push({ element, kind: "icon" });
          continue;
        }
        if (
          fillOrBorder &&
          r.width <= limits.chipMaxWidth &&
          r.height <= limits.chipMaxHeight &&
          text.length >= 1 &&
          text.length <= limits.chipMaxChars &&
          painted(element)
        ) {
          chips.push(element);
          continue;
        }
        if (
          fillOrBorder &&
          text === "" &&
          element.children.length === 0 &&
          r.width <= limits.markMax &&
          r.height <= limits.markMax &&
          painted(element)
        )
          others.push({ element, kind: "mark" });
      }
      // Leaf-most chips only; icons and marks inside a chip belong to it.
      const leafChips = chips.filter(
        (chip) =>
          !chips.some((other) => other !== chip && chip.contains(other)),
      );
      const decorations: Decoration[] = [];
      for (const chip of leafChips) {
        const s = style(chip);
        const r = chip.getBoundingClientRect();
        const text = textOf(chip);
        decorations.push({
          element: chip,
          kind: "chip",
          slot: `chip:${slotPath(item, chip)}`,
          signature: [
            "chip",
            text,
            Math.round(r.width),
            Math.round(r.height),
            s.backgroundColor,
            s.color,
            s.borderTopColor,
          ].join("|"),
          text,
          name: text,
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
      }
      for (const { element, kind } of others) {
        if (leafChips.some((chip) => chip.contains(element))) continue;
        const s = style(element);
        const r = element.getBoundingClientRect();
        decorations.push({
          element,
          kind,
          slot: `${kind}:${slotPath(item, element)}`,
          signature: [
            kind,
            Math.round(r.width),
            Math.round(r.height),
            s.backgroundColor,
            s.color,
            s.borderTopColor,
            kind === "icon" ? iconIdentity(element) : "",
          ].join("|"),
          text: "",
          name: kind === "icon" ? iconName(element) : "dot",
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
      }
      return decorations;
    };
    const scanRowOrnaments = (): RowOrnamentObservation[] => {
      const records: RowOrnamentObservation[] = [];
      for (const collection of gatherCollections()) {
        const items = collection.items.slice(0, 300);
        const slots = new Map<
          string,
          { signatures: Set<string>; items: Set<Element>; first: Decoration }
        >();
        for (const item of items)
          for (const decoration of decorationsOf(item)) {
            const slot = slots.get(decoration.slot);
            if (slot) {
              slot.signatures.add(decoration.signature);
              slot.items.add(item);
            } else
              slots.set(decoration.slot, {
                signatures: new Set([decoration.signature]),
                items: new Set([item]),
                first: decoration,
              });
          }
        const bySignature = new Map<
          string,
          { count: number; first: Decoration }
        >();
        for (const slot of slots.values()) {
          if (slot.signatures.size !== 1) continue;
          const count = slot.items.size;
          if (count < Math.ceil(limits.itemShare * items.length)) continue;
          const known = bySignature.get(slot.first.signature);
          if (!known || known.count < count)
            bySignature.set(slot.first.signature, { count, first: slot.first });
        }
        const container = selectorFor(collection.container);
        for (const { count, first } of bySignature.values()) {
          if (records.length >= 100) break;
          records.push({
            collection: container,
            collectionKind: collection.kind,
            items: items.length,
            count,
            kind: first.kind,
            text: first.text.slice(0, 80),
            example: selectorFor(first.element),
            name: first.name.slice(0, 80),
            width: first.width,
            height: first.height,
          });
        }
      }
      return records;
    };

    // ---- glyph-over-icon -----------------------------------------------------
    const glyphText = new RegExp(`^(?:${input.glyphSource})+$`, "u");
    const scanGlyphOverlaps = (): GlyphOverlapObservation[] => {
      const records: GlyphOverlapObservation[] = [];
      for (const control of document.querySelectorAll(interactiveSelector)) {
        if (records.length >= 50) break;
        const cr = control.getBoundingClientRect();
        if (
          cr.width <= 0 ||
          cr.height <= 0 ||
          cr.width >= limits.glyphControlMax ||
          cr.height >= limits.glyphControlMax
        )
          continue;
        if (!painted(control)) continue;
        const descendants = [...control.querySelectorAll("*")].filter(
          (element) =>
            !element.parentElement?.closest("svg") &&
            !element.matches(focusableSelector),
        );
        const glyphs = descendants.filter((element) => {
          const r = element.getBoundingClientRect();
          if (
            r.width <= 0 ||
            r.height <= 0 ||
            r.width >= limits.glyphMax ||
            r.height >= limits.glyphMax
          )
            return false;
          const text = textOf(element);
          if (/^\d+\+?$/.test(text)) return false;
          if (
            element.closest("[role='status'], [aria-live]") !== null &&
            control.contains(element.closest("[role='status'], [aria-live]"))
          )
            return false;
          const symbol =
            element.children.length === 0 &&
            text.length > 0 &&
            text.length <= 2 &&
            glyphText.test(text);
          return (
            (isIcon(element, limits.glyphMax) || symbol) && painted(element)
          );
        });
        let best: GlyphOverlapObservation | undefined;
        for (const glyph of glyphs) {
          const g = glyph.getBoundingClientRect();
          for (const icon of descendants) {
            if (icon === glyph || icon.contains(glyph) || glyph.contains(icon))
              continue;
            if (!isIcon(icon, limits.iconMax)) continue;
            const i = icon.getBoundingClientRect();
            if (i.width * i.height <= g.width * g.height) continue;
            const width = Math.min(g.right, i.right) - Math.max(g.left, i.left);
            const height =
              Math.min(g.bottom, i.bottom) - Math.max(g.top, i.top);
            if (width <= 0 || height <= 0) continue;
            const smaller = Math.min(g.width * g.height, i.width * i.height);
            const ratio = (width * height) / smaller;
            if (ratio <= limits.glyphOverlapRatio) continue;
            if (!painted(icon)) continue;
            if (best === undefined || ratio > best.ratio)
              best = {
                control: selectorFor(control),
                glyph: selectorFor(glyph),
                icon: selectorFor(icon),
                controlRect: box(control),
                glyphRect: box(glyph),
                iconRect: box(icon),
                overlap: {
                  width: Math.round(width * 100) / 100,
                  height: Math.round(height * 100) / 100,
                },
                ratio: Math.min(1, Math.round(ratio * 1000) / 1000),
              };
          }
        }
        if (best) records.push(best);
      }
      return records;
    };

    return {
      ...(input.enabled.emptyFrame ? { emptyFrames: scanEmptyFrames() } : {}),
      ...(input.enabled.rowOrnament
        ? { rowOrnaments: scanRowOrnaments() }
        : {}),
      ...(input.enabled.glyphOverIcon
        ? { glyphOverlaps: scanGlyphOverlaps() }
        : {}),
    };
  };
}

export async function ensureFrameOrnamentDom(page: Page): Promise<void> {
  await page.evaluate(installFrameOrnamentDom, frameOrnamentLimits);
}
