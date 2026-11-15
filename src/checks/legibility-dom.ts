import type { Page } from "playwright";
import type {
  ControlGapObservation,
  ControlGapPartKind,
  CrampedPaddingObservation,
  EdgeTextObservation,
  GeometryScan,
  HeadingRhythmObservation,
  HiddenAtRestScan,
  NegativeSpacingObservation,
  NumericColumnObservation,
  RaggedRowObservation,
  Rect,
  TypeLegibilityObservation,
} from "./types.js";

export type LegibilityToggles = {
  hiddenAtRest: boolean;
  edgeText: boolean;
  crampedPadding: boolean;
  headingRhythm: boolean;
  typeLegibility: boolean;
  numericAlign: boolean;
  raggedRow: boolean;
  controlGap: boolean;
  negativeSpacing: boolean;
};

/** What observe passes for the legibility scans: the toggles and the negative-spacing scope. */
export type LegibilityOptions = LegibilityToggles & {
  /** negative-spacing: judge interface text only (default), or all painted text. */
  negativeSpacingScope?: "interface" | "all" | undefined;
};

export type LegibilityInput = {
  selectorFor: (element: Element) => string;
  /** Elements a state declares hidden on purpose; they and their subtrees are skipped. */
  exempt: readonly Element[];
  enabled: LegibilityToggles;
  /** negative-spacing: "interface" judges controls and chrome; "all" judges every painted text. */
  spacingScope?: "interface" | "all" | undefined;
  /** negative-spacing: subtrees judged whatever the scope. */
  spacingInclude?: readonly Element[] | undefined;
  /** negative-spacing: subtrees never judged (wins over include and scope). */
  spacingIgnore?: readonly Element[] | undefined;
  /** control-gap: configured scope selectors and the elements they matched. */
  gapScopes?:
    | ReadonlyArray<{ selector: string; elements: readonly Element[] }>
    | undefined;
};

export type LegibilityResult = {
  hiddenAtRest?: HiddenAtRestScan;
  edgeTexts?: GeometryScan<EdgeTextObservation>;
  crampedPaddings?: GeometryScan<CrampedPaddingObservation>;
  headingRhythms?: GeometryScan<HeadingRhythmObservation>;
  typeLegibility?: GeometryScan<TypeLegibilityObservation>;
  numericColumns?: GeometryScan<NumericColumnObservation>;
  raggedRows?: GeometryScan<RaggedRowObservation>;
  controlGaps?: GeometryScan<ControlGapObservation>;
  negativeSpacings?: GeometryScan<NegativeSpacingObservation>;
};

export type LegibilityWindow = Window & {
  __idiomLegibility?: (input: LegibilityInput) => LegibilityResult;
};

/** The thresholds the legibility and layout scans use, in CSS px unless stated. */
export const legibilityLimits = {
  /** hidden-at-rest: effective opacity under this is invisible. */
  hiddenOpacity: 0.1,
  /** hidden-at-rest: more than this share (count or area) hidden is reported. */
  hiddenShare: 0.2,
  /** edge-text: minimum distance from the viewport's side. */
  edgeMin: 16,
  /** edge-text: minimum at viewports narrower than `narrowWidth`. */
  edgeMinNarrow: 12,
  narrowWidth: 480,
  /** cramped-padding: minimum distance from the container's inner edge. */
  paddingMin: 4,
  /** cramped-padding: containers shorter than this are chips and badges. */
  chipHeight: 24,
  /** type-legibility: body text under this size. */
  bodyMinSize: 12,
  /** type-legibility: UI text under this size. */
  uiMinSize: 11,
  /** type-legibility: line-height over font size under this, on multi-line body text. */
  minLeading: 1.2,
  /** type-legibility: all-caps runs longer than this many characters. */
  capsRun: 30,
  /** type-legibility: letter-spacing beyond ± this many em on body text. */
  maxTracking: 0.1,
  /** Body text: the nearest block's text is at least this many characters. */
  bodyChars: 40,
  /** numeric-align: a column needs this many numeric cells. */
  numericMinCells: 3,
  /** numeric-align: and more than this share of its non-empty cells numeric. */
  numericShare: 0.5,
  /** ragged-row: card bottoms in one row differing by more than this. */
  raggedSpread: 8,
  /** ragged-row: tops within this are one visual row. */
  rowTolerance: 2,
  /** ragged-row: a card is at least this wide and tall. */
  cardMinWidth: 80,
  cardMinHeight: 40,
  /** control-gap: part gaps under this are recorded; the check filters by its configured minimum. */
  controlGapCeiling: 12,
  /** control-gap: a chip, pill or toolbar item is at most this tall. */
  controlMaxHeight: 40,
  /** control-gap: and a chip or pill at most this wide. */
  controlMaxWidth: 480,
  /** Text blocks scanned per state before the scans report partial. */
  maxBlocks: 2000,
} as const;

// Serialized by Playwright: self-contained, no runtime imports. Requires
// window.__idiomVisibility (installed by ensureVisibilityDom).
export function installLegibilityDom(limits: typeof legibilityLimits) {
  const w = window as LegibilityWindow;
  w.__idiomLegibility = (input) => {
    const { selectorFor } = input;
    const cw = document.documentElement.clientWidth;
    const ch = document.documentElement.clientHeight;
    const styles = new Map<Element, CSSStyleDeclaration>();
    const style = (element: Element) => {
      let value = styles.get(element);
      if (!value) {
        value = getComputedStyle(element);
        styles.set(element, value);
      }
      return value;
    };
    const facts = new Map<Element, boolean>();
    const painted = (element: Element): boolean => {
      let value = facts.get(element);
      if (value === undefined) {
        value = window.__idiomVisibility.painted(element).value;
        facts.set(element, value);
      }
      return value;
    };
    const r2 = (value: number) => Math.round(value * 100) / 100;
    const half = (value: number) => Math.round(value * 2) / 2;
    const box = (element: Element): Rect => {
      const r = element.getBoundingClientRect();
      return {
        x: r2(r.x),
        y: r2(r.y),
        width: r2(r.width),
        height: r2(r.height),
      };
    };
    type Edges = { left: number; top: number; right: number; bottom: number };
    const rectOf = (e: Edges): Rect => ({
      x: r2(e.left),
      y: r2(e.top),
      width: r2(e.right - e.left),
      height: r2(e.bottom - e.top),
    });
    const clean = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();
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
    const imageNone = (value: string | undefined) =>
      value === undefined || value === "" || value === "none";
    const sides = ["top", "right", "bottom", "left"] as const;
    type Side = (typeof sides)[number];
    const cap = (side: string) => side[0]?.toUpperCase() + side.slice(1);
    const borderWidth = (element: Element, side: Side) =>
      Number.parseFloat(
        (style(element) as unknown as Record<string, string>)[
          `border${cap(side)}Width`
        ] ?? "0",
      ) || 0;
    const borderSides = (element: Element): Side[] => {
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
    const backdrop = (element: Element): string => {
      for (
        let current = element.parentElement;
        current;
        current = current.parentElement
      ) {
        const color = style(current).backgroundColor;
        if (alpha(color) > 0) return color;
      }
      return "rgb(255, 255, 255)";
    };
    /** Its own fill: a background image, or a colour that differs from behind it. */
    const filled = (element: Element): boolean => {
      const s = style(element);
      if (!imageNone(s.backgroundImage)) return true;
      return (
        alpha(s.backgroundColor) >= 0.1 &&
        s.backgroundColor !== backdrop(element)
      );
    };
    const ownFill = (element: Element): boolean => {
      const s = style(element);
      return alpha(s.backgroundColor) > 0 || !imageNone(s.backgroundImage);
    };

    const headingSelector = "h1, h2, h3, h4, h5, h6, [role=heading]";
    const uiSelector =
      "a, button, input, select, textarea, label, summary, option, nav, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox], [role=radio], [role=navigation], [role=toolbar], [role=menubar], [role=tablist]";
    const codeSelector = "pre, code, kbd, samp, svg";
    const skipSelector =
      "script, style, noscript, template, title, svg, textarea, select, option, iframe, object, canvas";
    const overlaySelector =
      "[role=menu], [role=listbox], [role=tooltip], [role=dialog], [role=alertdialog], dialog, [popover]";

    const directTexts = (element: Element): Text[] =>
      [...element.childNodes].filter(
        (node): node is Text =>
          node.nodeType === Node.TEXT_NODE && /\S/.test(node.textContent ?? ""),
      );
    const directText = (element: Element) =>
      clean(
        directTexts(element)
          .map((node) => node.textContent)
          .join(" "),
      );
    const inkCache = new Map<Element, DOMRect[]>();
    const inkRects = (element: Element): DOMRect[] => {
      let value = inkCache.get(element);
      if (value) return value;
      value = [];
      for (const node of directTexts(element)) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects())
          if (rect.width >= 0.5 && rect.height > 0) value.push(rect);
      }
      inkCache.set(element, value);
      return value;
    };
    const union = (rects: readonly DOMRect[]): Edges | undefined =>
      rects.length === 0
        ? undefined
        : {
            left: Math.min(...rects.map((r) => r.left)),
            top: Math.min(...rects.map((r) => r.top)),
            right: Math.max(...rects.map((r) => r.right)),
            bottom: Math.max(...rects.map((r) => r.bottom)),
          };
    /** Rendered lines: distinct rows of ink rects. */
    const lineCount = (rects: readonly DOMRect[]) => {
      const tops: number[] = [];
      for (const rect of [...rects].sort((a, b) => a.top - b.top))
        if (!tops.some((top) => Math.abs(top - rect.top) < rect.height / 2))
          tops.push(rect.top);
      return tops.length;
    };
    const inlineDisplay = (display: string) =>
      display === "contents" ||
      display === "inline" ||
      display.startsWith("ruby");
    const nearestBlock = (element: Element): Element => {
      let current: Element = element;
      while (
        current.parentElement !== null &&
        current !== document.body &&
        inlineDisplay(style(current).display)
      )
        current = current.parentElement;
      return current;
    };
    const isHeading = (element: Element) =>
      element.closest(headingSelector) !== null;
    const isUi = (element: Element) => element.closest(uiSelector) !== null;
    const isCode = (element: Element) => element.closest(codeSelector) !== null;
    const blockChars = new Map<Element, number>();
    const isBody = (element: Element) => {
      if (isHeading(element) || isUi(element) || isCode(element)) return false;
      const block = nearestBlock(element);
      let chars = blockChars.get(block);
      if (chars === undefined) {
        chars = clean(block.textContent).length;
        blockChars.set(block, chars);
      }
      return chars >= limits.bodyChars;
    };
    /** Text drawn for assistive technology only (the sr-only patterns). */
    const visuallyHidden = (element: Element): boolean => {
      for (
        let current: Element | null = element;
        current !== null && current !== document.body;
        current = current.parentElement
      ) {
        const s = style(current);
        if (
          s.clip !== "auto" &&
          s.clip !== "" &&
          ["absolute", "fixed"].includes(s.position)
        )
          return true;
        const inset = s.clipPath.match(/^inset\(\s*([\d.]+)(%|px)?/);
        if (inset?.[1] !== undefined) {
          const amount = Number(inset[1]);
          const r = current.getBoundingClientRect();
          if (
            inset[2] === "%"
              ? amount >= 50
              : amount * 2 >= Math.min(r.width, r.height)
          )
            return true;
        }
        const r = current.getBoundingClientRect();
        if (
          r.width <= 1 &&
          r.height <= 1 &&
          (s.overflow === "hidden" || s.overflow === "clip")
        )
          return true;
      }
      return false;
    };

    // Every element with its own visible text, in document order.
    const blocks: Element[] = [];
    let blocksTruncated = false;
    {
      const seen = new Set<Element>();
      const walker = document.createTreeWalker(
        document.body ?? document.documentElement,
        NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!/\S/.test(node.textContent ?? "")) continue;
        const parent = node.parentElement;
        if (parent === null || seen.has(parent)) continue;
        seen.add(parent);
        if (parent.closest(skipSelector) !== null) continue;
        if (style(parent).display === "none") continue;
        if (blocks.length >= limits.maxBlocks) {
          blocksTruncated = true;
          break;
        }
        blocks.push(parent);
      }
    }
    const truncatedReason = `more than ${limits.maxBlocks} text blocks; scanned the first ${limits.maxBlocks}`;
    const scan = <T>(records: T[], max: number): GeometryScan<T> => {
      if (records.length > max)
        return {
          status: "partial",
          reason: `more than ${max} records; kept the first ${max}`,
          records: records.slice(0, max),
        };
      return blocksTruncated
        ? { status: "partial", reason: truncatedReason, records }
        : { status: "ran", records };
    };
    const inExempt = (element: Element) =>
      input.exempt.some((root) => root === element || root.contains(element));
    const horizontalScroller = (element: Element): Element | undefined => {
      for (
        let current = element.parentElement;
        current !== null && current !== document.body;
        current = current.parentElement
      ) {
        const s = style(current);
        if (
          ["auto", "scroll"].includes(s.overflowX) &&
          current.scrollWidth > current.clientWidth + 1
        )
          return current;
      }
      return undefined;
    };

    // ── hidden-at-rest ────────────────────────────────────────────────
    const scanHiddenAtRest = (): HiddenAtRestScan => {
      const animated = new Set<Element>();
      for (const animation of document.getAnimations()) {
        if (animation.playState !== "running" && !animation.pending) continue;
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (target) animated.add(target);
      }
      const collapsed = new Set<Element>();
      for (const trigger of document.querySelectorAll(
        '[aria-expanded="false"][aria-controls]',
      ))
        for (const id of (trigger.getAttribute("aria-controls") ?? "").split(
          /\s+/,
        )) {
          const target = id === "" ? null : document.getElementById(id);
          if (target) collapsed.add(target);
        }
      const closedDetails = (element: Element) => {
        for (
          let current = element.parentElement;
          current !== null;
          current = current.parentElement
        )
          if (current instanceof HTMLDetailsElement && !current.open) {
            const summary = current.querySelector(":scope > summary");
            if (!summary?.contains(element)) return true;
          }
        return false;
      };
      const clippedAway = (element: Element, rect: DOMRect) => {
        let left = rect.left;
        let top = rect.top;
        let right = rect.right;
        let bottom = rect.bottom;
        for (
          let current = element.parentElement;
          current !== null && current !== document.body;
          current = current.parentElement
        ) {
          const s = style(current);
          const x = s.overflowX !== "visible";
          const y = s.overflowY !== "visible";
          if (!x && !y) continue;
          const r = current.getBoundingClientRect();
          if (x) {
            left = Math.max(left, r.left);
            right = Math.min(right, r.right);
          }
          if (y) {
            top = Math.max(top, r.top);
            bottom = Math.min(bottom, r.bottom);
          }
          if (right <= left || bottom <= top) return true;
        }
        return false;
      };
      let total = 0;
      let hidden = 0;
      let area = 0;
      let hiddenArea = 0;
      let inFlight = 0;
      const records: HiddenAtRestScan["records"] = [];
      for (const element of blocks) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (
          rect.right <= 0 ||
          rect.bottom <= 0 ||
          rect.left >= cw ||
          rect.top >= ch
        )
          continue;
        if (
          inExempt(element) ||
          element.closest('[aria-hidden="true"], [inert]') !== null ||
          closedDetails(element) ||
          [...collapsed].some((target) => target.contains(element)) ||
          visuallyHidden(element)
        )
          continue;
        // Effective opacity and the outermost element hiding it.
        let opacity = 1;
        let opacityRoot: Element | undefined;
        let visibilityRoot: Element | undefined;
        const own = style(element).visibility;
        const invisible = own === "hidden" || own === "collapse";
        for (
          let current: Element | null = element;
          current !== null;
          current = current.parentElement
        ) {
          const s = style(current);
          const value = Number(s.opacity);
          if (value < 1) {
            opacity *= value;
            opacityRoot = current;
          }
          if (
            invisible &&
            (s.visibility === "hidden" || s.visibility === "collapse")
          )
            visibilityRoot = current;
        }
        const isHidden = invisible || opacity < limits.hiddenOpacity;
        if (!isHidden) {
          if (!painted(element)) continue;
        } else if (clippedAway(element, rect)) continue;
        const ink = inkRects(element);
        let inkArea = 0;
        for (const r of ink) {
          const width = Math.min(r.right, cw) - Math.max(r.left, 0);
          const height = Math.min(r.bottom, ch) - Math.max(r.top, 0);
          if (width > 0 && height > 0) inkArea += width * height;
        }
        if (inkArea <= 0) continue;
        if (isHidden) {
          const root = (invisible ? visibilityRoot : opacityRoot) ?? element;
          // Positioned layers (menus, tooltips, toasts, stacked slides) are
          // hidden on purpose until opened; scroll reveals are in flow.
          let overlay = false;
          let moving = false;
          for (
            let current: Element | null = element;
            current !== null;
            current = current.parentElement
          ) {
            const s = style(current);
            if (
              s.position === "absolute" ||
              s.position === "fixed" ||
              current.matches(overlaySelector)
            )
              overlay = true;
            if (animated.has(current)) moving = true;
            if (current === root) break;
          }
          if (overlay) continue;
          if (moving) {
            inFlight += 1;
            continue;
          }
          total += 1;
          area += inkArea;
          hidden += 1;
          hiddenArea += inkArea;
          if (records.length < 20)
            records.push({
              selector: selectorFor(element),
              root: selectorFor(root),
              cause: invisible ? "visibility" : "opacity",
              opacity: Math.max(0, Math.min(1, r2(opacity))),
              rect: box(element),
              text: directText(element).slice(0, 80),
            });
        } else {
          total += 1;
          area += inkArea;
        }
      }
      return {
        status: blocksTruncated ? "partial" : "ran",
        ...(blocksTruncated ? { reason: truncatedReason } : {}),
        total,
        hidden,
        area: Math.round(area),
        hiddenArea: Math.round(hiddenArea),
        inFlight,
        records,
      };
    };

    // ── edge-text ─────────────────────────────────────────────────────
    const fullBleedMedia = (element: Element): boolean => {
      for (
        let current: Element | null = element;
        current !== null && current !== document.body;
        current = current.parentElement
      ) {
        const r = current.getBoundingClientRect();
        const s = style(current);
        if (
          (current.matches("figure, picture, video") ||
            !imageNone(s.backgroundImage)) &&
          r.width >= cw - 1
        )
          return true;
        if (
          (s.position === "absolute" || s.position === "fixed") &&
          current.parentElement !== null
        )
          for (const media of current.parentElement.querySelectorAll(
            "img, video, picture, canvas",
          )) {
            if (current.contains(media)) continue;
            const m = media.getBoundingClientRect();
            if (
              m.width >= cw - 1 &&
              m.left <= r.left + 1 &&
              m.right >= r.right - 1 &&
              m.top <= r.top + 1 &&
              m.bottom >= r.bottom - 1
            )
              return true;
          }
      }
      return false;
    };
    const scanEdgeText = () => {
      const threshold =
        cw < limits.narrowWidth ? limits.edgeMinNarrow : limits.edgeMin;
      const records: EdgeTextObservation[] = [];
      // Judge each block-level container once: a paragraph that opens with
      // an inline element (strong, em, span) has several text parents.
      const byBlock = new Map<Element, DOMRect[]>();
      for (const element of blocks) {
        if (!painted(element) || !isBody(element) || visuallyHidden(element))
          continue;
        const block = nearestBlock(element);
        const rects = byBlock.get(block);
        if (rects === undefined) byBlock.set(block, [...inkRects(element)]);
        else rects.push(...inkRects(element));
      }
      for (const [element, rects] of byBlock) {
        const ink = union(rects);
        if (!ink || ink.left < 0 || ink.right > cw) continue;
        const left = ink.left;
        const right = cw - ink.right;
        if (left >= threshold && right >= threshold) continue;
        if (horizontalScroller(element) || fullBleedMedia(element)) continue;
        const selector = selectorFor(element);
        for (const [side, distance] of [
          ["left", left],
          ["right", right],
        ] as const)
          if (distance >= 0 && distance < threshold)
            records.push({
              selector,
              side,
              distance: r2(distance),
              threshold,
              rect: rectOf(ink),
              text: (directText(element) || clean(element.textContent)).slice(
                0,
                80,
              ),
            });
      }
      return scan(records, 50);
    };

    // ── cramped-padding ───────────────────────────────────────────────
    const scanCrampedPadding = () => {
      const byContainer = new Map<Element, CrampedPaddingObservation>();
      const containerOf = new Map<Element, Element | null>();
      const findContainer = (element: Element): Element | null => {
        const chain: Element[] = [];
        let found: Element | null = null;
        for (
          let current: Element | null = element;
          current !== null && current !== document.body;
          current = current.parentElement
        ) {
          const known = containerOf.get(current);
          if (known !== undefined) {
            found = known;
            break;
          }
          chain.push(current);
          if (filled(current) || borderSides(current).length > 0) {
            found = current;
            break;
          }
        }
        for (const link of chain) containerOf.set(link, found);
        return found;
      };
      for (const element of blocks) {
        if (!painted(element) || isCode(element)) continue;
        const container = findContainer(element);
        if (container === null) continue;
        const s = style(container);
        if (inlineDisplay(s.display)) continue;
        if (container.matches("input, textarea, select")) continue;
        const outer = container.getBoundingClientRect();
        if (outer.height < limits.chipHeight || outer.width >= cw - 1) continue;
        if (
          container.matches("td, th") &&
          !filled(container) &&
          container.closest("table") !== null &&
          style(container.closest("table") as Element).borderCollapse ===
            "collapse"
        )
          continue;
        const ink = union(inkRects(element));
        if (!ink) continue;
        // Content areas run past the glyphs; trim a tenth of each line's
        // height top and bottom so line-height alone does not read as padding.
        const trim = Math.min(
          ...inkRects(element).map((rect) => rect.height * 0.1),
        );
        const inner = {
          top: outer.top + borderWidth(container, "top"),
          right: outer.right - borderWidth(container, "right"),
          bottom: outer.bottom - borderWidth(container, "bottom"),
          left: outer.left + borderWidth(container, "left"),
        };
        const distances: Record<Side, number> = {
          top: ink.top + trim - inner.top,
          right: inner.right - ink.right,
          bottom: inner.bottom - (ink.bottom - trim),
          left: ink.left - inner.left,
        };
        if (Object.values(distances).some((d) => d < 0)) continue;
        const counted: Side[] = filled(container)
          ? [...sides]
          : borderSides(container);
        const scrollX =
          ["auto", "scroll"].includes(s.overflowX) &&
          container.scrollWidth > container.clientWidth + 1;
        const scrollY =
          ["auto", "scroll"].includes(s.overflowY) &&
          container.scrollHeight > container.clientHeight + 1;
        // Controls centre their label vertically and their line box overstates
        // how close it sits, so only their sides judge padding.
        const control = container.matches(
          "button, summary, a, [role=button], [role=tab], [role=menuitem], [role=option], [role=link]",
        );
        let best: { side: Side; distance: number } | undefined;
        for (const side of counted) {
          if (control && (side === "top" || side === "bottom")) continue;
          if (scrollX && (side === "left" || side === "right")) continue;
          if (scrollY && (side === "top" || side === "bottom")) continue;
          const distance = distances[side];
          if (
            distance < limits.paddingMin &&
            (best === undefined || distance < best.distance)
          )
            best = { side, distance };
        }
        if (best === undefined) continue;
        const previous = byContainer.get(container);
        if (previous !== undefined && previous.distance <= best.distance)
          continue;
        byContainer.set(container, {
          container: selectorFor(container),
          selector: selectorFor(element),
          side: best.side,
          distance: r2(best.distance),
          rect: box(container),
          text: directText(element).slice(0, 80),
        });
      }
      return scan([...byContainer.values()], 50);
    };

    // ── heading-rhythm ────────────────────────────────────────────────
    const flowChild = (element: Element) => {
      if (element.matches("script, style, template, br")) return false;
      const s = style(element);
      if (s.position === "absolute" || s.position === "fixed") return false;
      const r = element.getBoundingClientRect();
      return r.height > 0 && r.width > 0 && painted(element);
    };
    const stacks = (parent: Element | null) => {
      if (parent === null) return false;
      const s = style(parent);
      if (["block", "flow-root", "list-item"].includes(s.display)) return true;
      if (s.display.endsWith("flex"))
        return s.flexDirection.startsWith("column");
      return s.display.endsWith("grid");
    };
    const neighbour = (
      heading: Element,
      direction: "above" | "below",
    ): Element | undefined => {
      let current: Element = heading;
      for (let level = 0; level < 4; level += 1) {
        for (
          let sibling =
            direction === "above"
              ? current.previousElementSibling
              : current.nextElementSibling;
          sibling !== null;
          sibling =
            direction === "above"
              ? sibling.previousElementSibling
              : sibling.nextElementSibling
        )
          if (flowChild(sibling))
            return stacks(current.parentElement) ? sibling : undefined;
        const parent = current.parentElement;
        if (parent === null || parent === document.body || level === 3)
          return undefined;
        const side = direction === "above" ? "top" : "bottom";
        const ps = style(parent) as unknown as Record<string, string>;
        if (
          Number.parseFloat(ps[`padding${cap(side)}`] ?? "0") > 0 ||
          borderWidth(parent, side) > 0 ||
          ownFill(parent)
        )
          return undefined;
        current = parent;
      }
      return undefined;
    };
    const endsWithHeading = (element: Element): boolean => {
      let current: Element | null = element;
      for (let depth = 0; current !== null && depth < 8; depth += 1) {
        if (current.matches(headingSelector)) return true;
        let last: Element | null = current.lastElementChild;
        while (last !== null && !flowChild(last))
          last = last.previousElementSibling;
        current = last;
      }
      return false;
    };
    const scanHeadingRhythm = () => {
      const records: HeadingRhythmObservation[] = [];
      for (const heading of document.querySelectorAll(headingSelector)) {
        if (!painted(heading) || isUi(heading)) continue;
        if (heading.parentElement?.closest(headingSelector)) continue;
        const above = neighbour(heading, "above");
        const below = neighbour(heading, "below");
        if (above === undefined || below === undefined) continue;
        const group = heading.closest("header, hgroup");
        if (group !== null && (group.contains(above) || group.contains(below)))
          continue;
        // Only a heading stacked directly under another heading is exempt:
        // the block above is a heading or its last painted content is one.
        // A previous section that merely contains a heading is still judged.
        if (endsWithHeading(above)) continue;
        const h = heading.getBoundingClientRect();
        const a = above.getBoundingClientRect();
        const b = below.getBoundingClientRect();
        const overlaps = (r: DOMRect) => r.left < h.right && r.right > h.left;
        if (!overlaps(a) || !overlaps(b)) continue;
        const gapAbove = half(h.top - a.bottom);
        const gapBelow = half(b.top - h.bottom);
        if (gapAbove < 0 || gapBelow < 0) continue;
        if (gapAbove === 0 && gapBelow === 0) continue;
        if (gapAbove > gapBelow) continue;
        // An eyebrow (a short, smaller kicker) sits tight above on purpose.
        const aboveText = clean(above.textContent);
        const range = document.createRange();
        range.selectNodeContents(above);
        if (
          aboveText.length <= 40 &&
          lineCount(
            [...range.getClientRects()].filter((r) => r.width >= 0.5),
          ) <= 1 &&
          Number.parseFloat(style(above).fontSize) <
            Number.parseFloat(style(heading).fontSize)
        )
          continue;
        const level =
          Number(heading.localName.match(/^h([1-6])$/)?.[1]) ||
          Math.min(
            6,
            Math.max(1, Number(heading.getAttribute("aria-level")) || 2),
          );
        records.push({
          selector: selectorFor(heading),
          level,
          text: clean(heading.textContent).slice(0, 80),
          gapAbove,
          gapBelow,
          above: selectorFor(above),
          below: selectorFor(below),
        });
      }
      return scan(records, 50);
    };

    // ── type-legibility ───────────────────────────────────────────────
    const capsRun = (text: string, uppercase: boolean): number => {
      if (!/\p{L}/u.test(text)) return 0;
      if (uppercase) return text.length;
      let longest = 0;
      let run: string[] = [];
      const close = () => {
        // Trailing words without letters do not extend the run.
        while (run.length > 0 && !/\p{L}/u.test(run[run.length - 1] ?? ""))
          run.pop();
        longest = Math.max(longest, run.join(" ").length);
        run = [];
      };
      for (const word of text.split(" ")) {
        const letters = /\p{L}/u.test(word);
        const lower = /\p{Ll}/u.test(word);
        if (lower) close();
        else if (letters) run.push(word);
        else if (run.length > 0) run.push(word);
      }
      close();
      return longest;
    };
    const scanTypeLegibility = () => {
      const records: TypeLegibilityObservation[] = [];
      for (const element of blocks) {
        if (!painted(element) || isCode(element) || visuallyHidden(element))
          continue;
        const s = style(element);
        const size = Number.parseFloat(s.fontSize);
        if (!(size > 0)) continue;
        const text = directText(element);
        const body = isBody(element);
        const ink = inkRects(element);
        if (ink.length === 0) continue;
        const lines = lineCount(ink);
        const push = (
          reason: TypeLegibilityObservation["reason"],
          value: number,
        ) =>
          records.push({
            selector: selectorFor(element),
            reason,
            value,
            text: text.slice(0, 80),
            rect: box(element),
          });
        // A lone symbol (+, ×, an arrow) is an icon, not text to read.
        const readable = /[\p{L}\p{N}]/u.test(text);
        if (body && readable && size < limits.bodyMinSize)
          push("small-body", half(size));
        if (
          !body &&
          readable &&
          size < limits.uiMinSize &&
          element.closest("sup, sub") === null
        )
          push("small-ui", half(size));
        if (body && lines >= 2 && s.lineHeight !== "normal") {
          const ratio = Number.parseFloat(s.lineHeight) / size;
          if (ratio > 0 && ratio < limits.minLeading - 0.005)
            push("tight-leading", Math.round(ratio * 100) / 100);
        }
        if (body && lines >= 2 && s.textAlign === "justify")
          push("justified", 0);
        const run = capsRun(text, s.textTransform === "uppercase");
        if (run > limits.capsRun) push("all-caps", run);
        if (body) {
          const spacing =
            s.letterSpacing === "normal"
              ? 0
              : Number.parseFloat(s.letterSpacing);
          const em = spacing / size;
          if (Math.abs(em) > limits.maxTracking + 0.005)
            push("letter-spacing", Math.round(em * 100) / 100);
        }
      }
      return scan(records, 100);
    };

    // ── numeric-align ─────────────────────────────────────────────────
    const numberPattern =
      /^[-+−(]?\s*[$€£¥₹]?\s*(?:\d{1,3}(?:[,.   ]\d{3})+|\d+)(?:[.,]\d+)?\s*(?:%|[A-Za-z]{1,3})?\)?$/u;
    const isNumeric = (text: string) =>
      text !== "" &&
      numberPattern.test(text) &&
      !/\d+[-/:]\d+/.test(text) &&
      // A bare year is a date, not a quantity.
      !/^(?:19|20)\d{2}$/.test(text) &&
      (text.match(/\./g) ?? []).length < 2;
    const tabular = (element: Element) => {
      const s = style(element);
      return (
        s.fontVariantNumeric.includes("tabular-nums") ||
        /["']tnum["']/.test(s.fontFeatureSettings) ||
        /mono|courier|menlo|consolas/i.test(s.fontFamily)
      );
    };
    const cellInk = (cell: Element): Edges | undefined => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return union([...range.getClientRects()].filter((r) => r.width >= 0.5));
    };
    const judgeColumn = (
      container: Element,
      kind: "table" | "list",
      column: number,
      cells: Element[],
      header: string,
    ): NumericColumnObservation | undefined => {
      const filledCells = cells.filter(
        (cell) => clean(cell.textContent) !== "",
      );
      const numeric = filledCells.filter((cell) =>
        isNumeric(clean(cell.textContent)),
      );
      if (
        numeric.length < limits.numericMinCells ||
        numeric.length / filledCells.length <= limits.numericShare
      )
        return undefined;
      const inks = numeric
        .map(cellInk)
        .filter((ink): ink is Edges => ink !== undefined);
      if (inks.length < limits.numericMinCells) return undefined;
      const spread = (values: number[]) =>
        Math.max(...values) - Math.min(...values);
      const leftSpread = spread(inks.map((ink) => ink.left));
      const rightSpread = spread(inks.map((ink) => ink.right));
      const problems: NumericColumnObservation["problems"] = [];
      if (leftSpread <= 1 && rightSpread > 2) problems.push("left-aligned");
      else if (leftSpread <= 1 && rightSpread <= 1 && kind === "table") {
        const align = style(numeric[0] as Element).textAlign;
        const rtl = style(numeric[0] as Element).direction === "rtl";
        if (align === "left" || (align === "start" && !rtl))
          problems.push("left-aligned");
      }
      const proportional = numeric.filter((cell) => {
        const texts = [...cell.querySelectorAll("*"), cell].filter(
          (element) => directTexts(element).length > 0,
        );
        return texts.length > 0 && texts.every((element) => !tabular(element));
      });
      if (proportional.length > numeric.length / 2)
        problems.push("proportional-figures");
      if (problems.length === 0) return undefined;
      return {
        container: selectorFor(container),
        kind,
        column,
        header: header.slice(0, 80),
        cells: filledCells.length,
        numeric: numeric.length,
        problems,
        example: clean(numeric[0]?.textContent).slice(0, 80),
      };
    };
    const scanNumericAlign = () => {
      const records: NumericColumnObservation[] = [];
      for (const table of document.querySelectorAll(
        "table, [role=table], [role=grid]",
      )) {
        if (!painted(table)) continue;
        const html = table instanceof HTMLTableElement;
        const rows = html
          ? [...table.rows].filter(
              (row) =>
                row.parentElement?.localName !== "thead" &&
                row.closest("table") === table,
            )
          : [...table.querySelectorAll("[role=row]")].filter(
              (row) =>
                row.closest("[role=table], [role=grid]") === table &&
                row.querySelector("[role=columnheader]") === null,
            );
        const columns: Element[][] = [];
        for (const row of rows) {
          const cells = html
            ? [...(row as HTMLTableRowElement).cells]
            : [...row.children].filter((cell) =>
                cell.matches(
                  "[role=cell], [role=gridcell], [role=rowheader], [role=columnheader]",
                ),
              );
          if (cells.length === 0) continue;
          if (html && cells.every((cell) => cell.localName === "th")) continue;
          if (
            cells.some(
              (cell) =>
                Number(cell.getAttribute("colspan") ?? "1") > 1 ||
                Number(cell.getAttribute("rowspan") ?? "1") > 1,
            )
          )
            continue;
          if (!painted(row)) continue;
          cells.forEach((cell, index) => {
            const column = columns[index] ?? [];
            column.push(cell);
            columns[index] = column;
          });
        }
        const headerCells = html
          ? [...(table.tHead?.rows[0]?.cells ?? [])]
          : [
              ...(table
                .querySelector("[role=row]:has([role=columnheader])")
                ?.querySelectorAll("[role=columnheader]") ?? []),
            ];
        columns.forEach((cells, index) => {
          const record = judgeColumn(
            table,
            "table",
            index,
            cells,
            clean(headerCells[index]?.textContent),
          );
          if (record) records.push(record);
        });
      }
      for (const list of document.querySelectorAll("ul, ol, [role=list]")) {
        if (!painted(list)) continue;
        const items = [...list.children].filter(
          (item) => painted(item) && item.children.length >= 2,
        );
        if (items.length < 3) continue;
        const width = items[0]?.children.length ?? 0;
        if (items.some((item) => item.children.length !== width)) continue;
        const sideBySide = items.every((item) => {
          const [first, second] = [...item.children].map((child) =>
            child.getBoundingClientRect(),
          );
          return (
            first !== undefined &&
            second !== undefined &&
            second.left >= first.right - 1 &&
            second.top < first.bottom &&
            second.bottom > first.top
          );
        });
        if (!sideBySide) continue;
        for (let index = 0; index < width; index += 1) {
          const record = judgeColumn(
            list,
            "list",
            index,
            items.map((item) => item.children[index] as Element),
            "",
          );
          if (record) records.push(record);
        }
      }
      return scan(records, 50);
    };

    // ── ragged-row ────────────────────────────────────────────────────
    const generatedClass = (value: string): boolean =>
      /__[A-Za-z0-9_-]{5,}$/.test(value) ||
      /^(?:css|jsx|sc|emotion|styled)[-_][A-Za-z0-9_-]{5,}$/i.test(value) ||
      /^[a-f0-9]{8,}$/i.test(value);
    const signature = (element: Element) =>
      `${element.tagName}|${[...element.classList]
        .filter((value) => !generatedClass(value))
        .sort()
        .join(".")}`;
    const cardFace = (item: Element): boolean => {
      const drawn = (element: Element) =>
        filled(element) ||
        borderSides(element).length > 0 ||
        style(element).boxShadow !== "none";
      if (drawn(item)) return true;
      if (item.children.length !== 1) return false;
      const child = item.children[0] as Element;
      const a = item.getBoundingClientRect();
      const b = child.getBoundingClientRect();
      return (
        b.width >= a.width * 0.9 && b.height >= a.height * 0.9 && drawn(child)
      );
    };
    const spansRows = (element: Element) => {
      const s = style(element);
      const span = s.gridRowEnd.match(/span\s+(\d+)/);
      if (span && Number(span[1]) > 1) return true;
      const start = Number.parseInt(s.gridRowStart, 10);
      const end = Number.parseInt(s.gridRowEnd, 10);
      return Number.isFinite(start) && Number.isFinite(end) && end - start > 1;
    };
    const scanRaggedRows = () => {
      const records: RaggedRowObservation[] = [];
      const parents = new Set<Element>();
      for (const element of document.body?.querySelectorAll("*") ?? [])
        if (element.childElementCount >= 3) parents.add(element);
      for (const parent of parents) {
        if (!painted(parent)) continue;
        // Multi-column (masonry) layouts align only their first cards.
        const ps = style(parent);
        if (ps.columnCount !== "auto" || ps.columnWidth !== "auto") continue;
        const groups = new Map<string, Element[]>();
        for (const child of parent.children) {
          if (!painted(child)) continue;
          const key = signature(child);
          const group = groups.get(key) ?? [];
          group.push(child);
          groups.set(key, group);
        }
        for (const group of groups.values()) {
          if (group.length < 3) continue;
          const cards = group
            .filter((item) => {
              const r = item.getBoundingClientRect();
              return (
                r.width >= limits.cardMinWidth &&
                r.height >= limits.cardMinHeight &&
                style(item).transform === "none" &&
                style(item).position !== "absolute" &&
                style(item).position !== "fixed" &&
                !spansRows(item) &&
                cardFace(item)
              );
            })
            .map((item) => ({ item, rect: item.getBoundingClientRect() }))
            .sort((a, b) => a.rect.top - b.rect.top);
          const rows: (typeof cards)[] = [];
          for (const card of cards) {
            const row = rows.find(
              (candidate) =>
                Math.abs((candidate[0]?.rect.top ?? 0) - card.rect.top) <=
                limits.rowTolerance,
            );
            if (row) row.push(card);
            else rows.push([card]);
          }
          const scroller = horizontalScroller(parent.children[0] ?? parent);
          const view = scroller?.getBoundingClientRect();
          rows.forEach((row, index) => {
            if (row.length < 2) return;
            if (
              view !== undefined &&
              row.some(
                ({ rect }) =>
                  rect.left < view.left - 1 || rect.right > view.right + 1,
              )
            )
              return;
            const bottoms = row.map(({ rect }) => rect.bottom);
            const spread = Math.max(...bottoms) - Math.min(...bottoms);
            if (spread <= limits.raggedSpread) return;
            const byHeight = [...row].sort(
              (a, b) => a.rect.height - b.rect.height,
            );
            records.push({
              collection: selectorFor(parent),
              row: index,
              items: row.length,
              spread: r2(spread),
              heights: row.map(({ rect }) => r2(rect.height)),
              tallest: selectorFor(
                (byHeight[byHeight.length - 1] as (typeof row)[number]).item,
              ),
              shortest: selectorFor((byHeight[0] as (typeof row)[number]).item),
            });
          });
        }
      }
      return {
        ...(records.length > 50
          ? {
              status: "partial" as const,
              reason: "more than 50 records; kept the first 50",
            }
          : { status: "ran" as const }),
        records: records.slice(0, 50),
      } as GeometryScan<RaggedRowObservation>;
    };

    // ── control-gap and negative-spacing ──────────────────────────────
    const interactiveSelector =
      "button, summary, a[href], [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=switch]";
    const chromeSelector =
      "button, summary, label, nav, [role=button], [role=tab], [role=tablist], [role=menu], [role=menubar], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=listbox], [role=option], [role=switch], [role=checkbox], [role=radio], [role=toolbar], [role=navigation], [role=tooltip]";
    const iconSelector = "svg, img, canvas, picture, [role=img]";
    const drawn = (element: Element) =>
      filled(element) || borderSides(element).length > 0;
    const charsOf = (block: Element) => {
      let chars = blockChars.get(block);
      if (chars === undefined) {
        chars = clean(block.textContent).length;
        blockChars.set(block, chars);
      }
      return chars;
    };
    /** A link set inline in running text: page content, not a control. */
    const proseLink = (element: Element): boolean => {
      if (element.tagName.toLowerCase() !== "a") return false;
      const role = element.getAttribute("role");
      if (role !== null && role !== "link") return false;
      if (style(element).display !== "inline") return false;
      const parent = element.parentElement;
      if (parent === null) return false;
      const block = nearestBlock(parent);
      if (block.closest(uiSelector) !== null) return false;
      if (block.closest(chromeSelector) !== null) return false;
      return charsOf(block) >= limits.bodyChars;
    };
    const controlCache = new Map<Element, boolean>();
    /** A button, chip, pill or toolbar item: the box whose parts control-gap measures. */
    const isControl = (element: Element): boolean => {
      let value = controlCache.get(element);
      if (value !== undefined) return value;
      value = false;
      if (element.matches(interactiveSelector)) value = !proseLink(element);
      else {
        const r = element.getBoundingClientRect();
        const display = style(element).display;
        if (
          [
            "inline-flex",
            "inline-block",
            "inline-grid",
            "flex",
            "grid",
          ].includes(display) &&
          r.height <= limits.controlMaxHeight &&
          r.width <= limits.controlMaxWidth &&
          drawn(element) &&
          !element.matches(headingSelector) &&
          element.querySelector(
            `${headingSelector}, input, select, textarea`,
          ) === null
        )
          value = true;
        else if (
          element.parentElement?.matches("[role=toolbar], [role=menubar]") &&
          r.height <= limits.controlMaxHeight
        )
          value = true;
      }
      controlCache.set(element, value);
      return value;
    };
    const insideControlCache = new Map<Element, boolean>();
    const insideControl = (element: Element): boolean => {
      const chain: Element[] = [];
      let value = false;
      for (
        let current: Element | null = element;
        current !== null && current !== document.body;
        current = current.parentElement
      ) {
        const known = insideControlCache.get(current);
        if (known !== undefined) {
          value = known;
          break;
        }
        chain.push(current);
        if (isControl(current)) {
          value = true;
          break;
        }
      }
      for (const link of chain) insideControlCache.set(link, value);
      return value;
    };
    const within = (roots: readonly Element[] | undefined, element: Element) =>
      (roots ?? []).some((root) => root === element || root.contains(element));
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    const graphemeCount = (text: string) => [...segmenter.segment(text)].length;
    /** The ink of a text node's non-whitespace characters, one rect per box. */
    const textInk = (node: Text): DOMRect[] => {
      const text = node.textContent ?? "";
      const start = text.search(/\S/);
      if (start < 0) return [];
      const end = text.length - (text.match(/\s*$/)?.[0].length ?? 0);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      return [...range.getClientRects()].filter(
        (rect) => rect.width >= 0.5 && rect.height > 0,
      );
    };
    const partSkip = "script, style, noscript, template, br, wbr";
    /** Everything an undrawn nested control paints: its text and icons. */
    const subtreeInk = (element: Element): DOMRect[] => {
      const rects: DOMRect[] = [];
      const visit = (node: Node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const parent = child.parentElement;
            if (parent && painted(parent) && !visuallyHidden(parent))
              rects.push(...textInk(child as Text));
          } else if (child instanceof Element) {
            if (child.matches(partSkip)) continue;
            if (style(child).display === "none") continue;
            if (child.matches(iconSelector)) {
              if (painted(child)) rects.push(child.getBoundingClientRect());
            } else visit(child);
          }
        }
      };
      visit(element);
      return rects;
    };
    type Part = {
      element: Element;
      kind: ControlGapPartKind;
      text: string;
      pieces: Edges[];
    };
    /** Rects grouped into rows (vertical overlap at least half the shorter). */
    const sameRow = (a: Edges, b: Edges) => {
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const shorter = Math.min(a.bottom - a.top, b.bottom - b.top);
      return shorter > 0 && overlap >= shorter / 2;
    };
    const lines = (rects: readonly DOMRect[]): Edges[] => {
      const rows: Edges[] = [];
      for (const rect of [...rects].sort((a, b) => a.top - b.top)) {
        const edges = {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        };
        const row = rows.find((candidate) => sameRow(candidate, edges));
        if (row) {
          row.left = Math.min(row.left, edges.left);
          row.top = Math.min(row.top, edges.top);
          row.right = Math.max(row.right, edges.right);
          row.bottom = Math.max(row.bottom, edges.bottom);
        } else rows.push(edges);
      }
      return rows;
    };
    /** The element a text run flows in, stopping at the control itself. */
    const runBlock = (element: Element, container: Element): Element => {
      let current = element;
      while (
        current !== container &&
        current.parentElement !== null &&
        inlineDisplay(style(current).display)
      )
        current = current.parentElement;
      return current;
    };
    const partsOf = (container: Element): Part[] => {
      const parts: Part[] = [];
      const runs = new Map<Element, { rects: DOMRect[]; text: string[] }>();
      const visit = (node: Node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const parent = child.parentElement;
            if (!parent || !painted(parent) || visuallyHidden(parent)) continue;
            const ink = textInk(child as Text);
            if (ink.length === 0) continue;
            const block = runBlock(parent, container);
            let run = runs.get(block);
            if (run === undefined) {
              run = { rects: [], text: [] };
              runs.set(block, run);
              parts.push({
                element: block,
                kind: "text",
                text: "",
                pieces: [],
              });
            }
            run.rects.push(...ink);
            run.text.push(child.textContent ?? "");
            continue;
          }
          if (!(child instanceof Element)) continue;
          if (child.matches(partSkip)) continue;
          if (style(child).display === "none") continue;
          if (child.matches(iconSelector)) {
            if (!painted(child)) continue;
            const r = child.getBoundingClientRect();
            parts.push({
              element: child,
              kind: "icon",
              text: "",
              pieces: [
                { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
              ],
            });
            continue;
          }
          if (isControl(child)) {
            if (!painted(child) || visuallyHidden(child)) continue;
            const r = child.getBoundingClientRect();
            parts.push({
              element: child,
              kind: "control",
              text: clean(child.textContent),
              pieces: drawn(child)
                ? [
                    {
                      left: r.left,
                      top: r.top,
                      right: r.right,
                      bottom: r.bottom,
                    },
                  ]
                : lines(subtreeInk(child)),
            });
            continue;
          }
          visit(child);
        }
      };
      visit(container);
      for (const part of parts) {
        if (part.kind !== "text") continue;
        const run = runs.get(part.element);
        if (run === undefined) continue;
        part.pieces = lines(run.rects);
        part.text = clean(run.text.join(""));
      }
      return parts.filter((part) => {
        part.pieces = part.pieces.filter(
          (piece) => piece.right > piece.left && piece.bottom > piece.top,
        );
        return part.pieces.length > 0;
      });
    };
    /** Joined groups square the corners they butt together (adjacent-gap's exemption). */
    const squareFacing = (leading: Element, trailing: Element) => {
      const zero = (value: string) => Number.parseFloat(value || "0") === 0;
      const a = style(leading);
      const b = style(trailing);
      return (
        zero(a.borderTopRightRadius) &&
        zero(a.borderBottomRightRadius) &&
        zero(b.borderTopLeftRadius) &&
        zero(b.borderBottomLeftRadius)
      );
    };
    const affix = (part: Part) =>
      part.kind === "text" &&
      graphemeCount(part.text) <= 2 &&
      !/[\p{L}\p{N}]/u.test(part.text);
    const scanControlGaps = () => {
      const candidates = new Set<Element>();
      const root = document.body ?? document.documentElement;
      for (const element of root.querySelectorAll(
        `${interactiveSelector}, [role=toolbar] > *, [role=menubar] > *`,
      ))
        if (isControl(element)) candidates.add(element);
      // Chips and pills: walk up from each text block while boxes stay chip-sized.
      for (const element of blocks)
        for (
          let current: Element | null = element;
          current !== null && current !== document.body;
          current = current.parentElement
        ) {
          const r = current.getBoundingClientRect();
          if (r.height > limits.controlMaxHeight) break;
          if (isControl(current)) candidates.add(current);
        }
      const ordered = [...candidates].sort((a, b) =>
        a === b
          ? 0
          : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1,
      );
      const records: ControlGapObservation[] = [];
      for (const container of ordered) {
        if (
          inExempt(container) ||
          container.closest('[aria-hidden="true"], [inert]') !== null ||
          !painted(container) ||
          visuallyHidden(container)
        )
          continue;
        const parts = partsOf(container);
        if (parts.length < 2) continue;
        const pieces = parts.flatMap((part) =>
          part.pieces.map((edges) => ({ part, edges })),
        );
        pieces.sort((a, b) => a.edges.left - b.edges.left);
        const segmented =
          container.closest("[role=tablist], [role=radiogroup]") !== null ||
          drawn(container);
        const found: ControlGapObservation[] = [];
        const seen = new Set<string>();
        for (let index = 0; index < pieces.length; index += 1) {
          const prev = pieces[index] as (typeof pieces)[number];
          const next = pieces
            .slice(index + 1)
            .find((candidate) => sameRow(prev.edges, candidate.edges));
          if (next === undefined || next.part === prev.part) continue;
          const gap = next.edges.left - prev.edges.right;
          if (gap < -1 || gap >= limits.controlGapCeiling) continue;
          const a = prev.part;
          const b = next.part;
          if (a.kind === "control" && b.kind === "control") {
            if (segmented) continue;
            if (
              gap <= 2 &&
              drawn(a.element) &&
              drawn(b.element) &&
              squareFacing(a.element, b.element)
            )
              continue;
          }
          if (
            a.element.closest("kbd") !== null &&
            b.element.closest("kbd") !== null
          )
            continue;
          if (a.kind === "text" && b.kind === "text" && (affix(a) || affix(b)))
            continue;
          const first = selectorFor(a.element);
          const second = selectorFor(b.element);
          if (first === second) continue;
          const key = `${first}\u0000${second}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const scopes = (input.gapScopes ?? [])
            .filter(({ elements }) =>
              elements.some((scope) => scope.contains(container)),
            )
            .map(({ selector }) => selector);
          found.push({
            control: selectorFor(container),
            first,
            second,
            firstKind: a.kind,
            secondKind: b.kind,
            gap: Math.max(0, half(gap)),
            rect: box(container),
            text: clean(container.textContent).slice(0, 80),
            ...(scopes.length === 0 ? {} : { scopes }),
          });
        }
        records.push(...found);
      }
      return scan(records, 50);
    };

    const spacingScope = input.spacingScope ?? "interface";
    const interfaceText = (element: Element) =>
      element.closest(chromeSelector) !== null ||
      insideControl(element) ||
      (() => {
        const link = element.closest("a");
        return link !== null && !proseLink(link);
      })();
    const spacingInScope = (element: Element) => {
      if (within(input.spacingIgnore, element)) return false;
      if (spacingScope === "all") return true;
      if (within(input.spacingInclude, element)) return true;
      return interfaceText(element);
    };
    const spacingValue = (value: string) =>
      value === "normal" ? 0 : Number.parseFloat(value) || 0;
    const scanNegativeSpacing = () => {
      const records: NegativeSpacingObservation[] = [];
      const seen = new Set<string>();
      const properties = [
        ["letter-spacing", "letterSpacing"],
        ["word-spacing", "wordSpacing"],
      ] as const;
      for (const element of blocks) {
        if (!painted(element) || visuallyHidden(element)) continue;
        for (const [property, key] of properties) {
          const raw = style(element)[key];
          const value = spacingValue(raw);
          if (!(value < -0.005)) continue;
          if (!spacingInScope(element)) continue;
          let rootElement = element;
          for (
            let parent = rootElement.parentElement;
            parent !== null && parent !== document.documentElement;
            parent = parent.parentElement
          ) {
            if (style(parent)[key] !== raw || !spacingInScope(parent)) break;
            rootElement = parent;
          }
          const selector = selectorFor(rootElement);
          const id = `${selector}\u0000${property}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const size = Number.parseFloat(style(rootElement).fontSize) || 16;
          records.push({
            selector,
            property,
            value: r2(value),
            em: r2(value / size),
            text: clean(rootElement.textContent).slice(0, 80),
            rect: box(rootElement),
          });
        }
      }
      return scan(records, 50);
    };

    const { enabled } = input;
    return {
      ...(enabled.hiddenAtRest ? { hiddenAtRest: scanHiddenAtRest() } : {}),
      ...(enabled.edgeText ? { edgeTexts: scanEdgeText() } : {}),
      ...(enabled.crampedPadding
        ? { crampedPaddings: scanCrampedPadding() }
        : {}),
      ...(enabled.headingRhythm ? { headingRhythms: scanHeadingRhythm() } : {}),
      ...(enabled.typeLegibility
        ? { typeLegibility: scanTypeLegibility() }
        : {}),
      ...(enabled.numericAlign ? { numericColumns: scanNumericAlign() } : {}),
      ...(enabled.raggedRow ? { raggedRows: scanRaggedRows() } : {}),
      ...(enabled.controlGap ? { controlGaps: scanControlGaps() } : {}),
      ...(enabled.negativeSpacing
        ? { negativeSpacings: scanNegativeSpacing() }
        : {}),
    };
  };
}

export async function ensureLegibilityDom(page: Page): Promise<void> {
  await page.evaluate(installLegibilityDom, legibilityLimits);
}
