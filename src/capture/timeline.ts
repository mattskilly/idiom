import type { Disposable, Page, Request } from "playwright";
import { linkRecording, recordingKey } from "../checks/temporal-evidence.js";
import type {
  ActionTimeline,
  ActionTimelineArtifact,
  MotionArtifact,
} from "../checks/types.js";
import {
  ensureVisibilityDom,
  installVisibilityDom,
} from "../checks/visibility-dom.js";
import { rememberRequest, rememberResponse } from "./failure-identity.js";
import type { FilmstripCapture } from "./filmstrips.js";
import { ignoredRequest } from "./request-policy.js";

/**
 * Hard caps on one action's timeline. Whenever a cap stops recording, its
 * name is listed in the action's `truncated` and the action is partial.
 */
export const TIMELINE_LIMITS = {
  frames: 60,
  elements: 250,
  changesPerFrame: 80,
  shifts: 50,
  mutations: 60,
  animations: 40,
  requests: 60,
  actions: 240,
  visibleChanges: 40,
} as const;

/** Elements snapshotted at the start of an action for visible changes. */
const SNAPSHOT_ELEMENTS = 4000;

type Truncation = ActionTimeline["truncated"][number];
type TimelineIdentity = Pick<
  ActionTimeline,
  "source" | "kind" | "selector" | "name" | "stepIndex" | "confirmation"
>;
/** What the page records; the collector adds identity, timing and requests. */
type RawTimeline = Pick<
  ActionTimeline,
  | "url"
  | "clockOrigin"
  | "shifts"
  | "frames"
  | "mutations"
  | "animations"
  | "viewTransition"
  | "effectRegion"
  | "fromUrl"
  | "reducedMotion"
  | "visibleChanges"
> & { truncated: Truncation[]; notes: string[] };
type RecorderConfig = {
  token: string;
  load: boolean;
  trigger?: string | undefined;
  limits: typeof TIMELINE_LIMITS;
  /** Extra motion surface selectors (`checks.motion.selectors`). */
  surfaces?: string[] | undefined;
  snapshotElements?: number | undefined;
};
type TimelineWindow = Window & {
  __idiomTimeline?: { token: string; finish(): RawTimeline; dispose(): void };
};

/**
 * The in-page recorder. Serializable: it runs through page.evaluate and as an
 * init script, so it closes over nothing in this module. It only observes —
 * observers, passive listeners and an animation-frame loop — and never
 * mutates the document, dispatches input or changes emulation.
 */
function timelineRecorder(config: RecorderConfig): void {
  type Rect = { x: number; y: number; width: number; height: number };
  type Point = { x: number; y: number };
  type Frame = RawTimeline["frames"][number];
  type Entry = {
    element: Element;
    selector: string;
    /** Scrolling ancestors, innermost first; null window means fixed. */
    chain: Element[];
    window: boolean;
    rect: Rect;
    offset: Point;
  };
  const scope = window as TimelineWindow & {
    __idiomVisibility?: { painted(element: Element): { value: boolean } };
  };
  if (config.load && window !== window.top) return;
  scope.__idiomTimeline?.dispose();
  const limits = config.limits;
  // A load timeline starts at navigation; an action's at this call.
  const startMark = config.load ? 0 : performance.now();
  const now = () => performance.now() - startMark;
  const notes = new Set<string>();
  const truncated = new Set<Truncation>();
  const cut = (name: Truncation) => truncated.add(name);

  // Copied verbatim from observe's selectorFor so timeline selectors join
  // observation selectors; a parity test pins the two together.
  const generatedClass = (value: string): boolean =>
    /__[A-Za-z0-9_-]{5,}$/.test(value) ||
    /^(?:css|jsx|sc|emotion|styled)[-_][A-Za-z0-9_-]{5,}$/i.test(value) ||
    /^[a-f0-9]{8,}$/i.test(value);
  const stableAttributes = [
    "data-testid",
    "data-test",
    "data-id",
    "name",
    "aria-label",
    "role",
  ];
  const selectorFor = (element: Element): string => {
    if (element === document.documentElement) return "html";
    if (element === document.body) return "body";
    // Framework-generated ids (React useId, Radix, Headless UI) change
    // between renders and builds, so they never anchor a selector.
    const generatedId =
      /(?:^|[-_])(?::r[0-9a-z]+:|«r[0-9a-z]+»|_r_[0-9a-z]+_)|^radix-|^headlessui-/.test(
        element.id,
      );
    if (element.id && !generatedId) {
      const candidate = `#${CSS.escape(element.id)}`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    for (const name of stableAttributes) {
      const value = element.getAttribute(name);
      if (value) {
        const candidate = `${element.tagName.toLowerCase()}[${name}=${JSON.stringify(value)}]`;
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      }
    }
    const classes = [...element.classList]
      .filter((value) => !generatedClass(value))
      .sort()
      .slice(0, 3);
    if (classes.length > 0) {
      const candidate = `${element.tagName.toLowerCase()}${classes.map((value) => `.${CSS.escape(value)}`).join("")}`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    const parts: string[] = [];
    let current: Element | null = element;
    while (current !== null && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (candidate) => candidate.tagName === current?.tagName,
          )
        : [];
      parts.unshift(
        siblings.length > 1
          ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})`
          : tag,
      );
      current = current.parentElement;
    }
    return `body > ${parts.join(" > ")}`;
  };
  const box = (r: DOMRectReadOnly): Rect => ({
    x: r.x,
    y: r.y,
    width: Math.max(0, r.width),
    height: Math.max(0, r.height),
  });
  const painted = (element: Element): boolean => {
    const helper = scope.__idiomVisibility;
    if (helper) {
      try {
        return helper.painted(element).value;
      } catch {
        // Fall through to the approximation below.
      }
    }
    notes.add("painted facts unavailable; approximate visibility");
    const r = element.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      )
        return false;
    }
    return true;
  };

  // Scroll compensation: an element's offset is the window scroll (unless it
  // is fixed) plus the scroll of each scrolling ancestor.
  const scrollers = new Map<
    Element,
    {
      selector: string;
      x: number;
      y: number;
      recordedX: number;
      recordedY: number;
    }
  >();
  const scrollable = (element: Element, style: CSSStyleDeclaration) =>
    /^(auto|scroll|hidden)$/.test(style.overflowY) ||
    /^(auto|scroll|hidden)$/.test(style.overflowX)
      ? element.scrollHeight > element.clientHeight ||
        element.scrollWidth > element.clientWidth
      : false;
  const chainOf = (element: Element): { chain: Element[]; window: boolean } => {
    const chain: Element[] = [];
    for (
      let current: Element | null = element;
      current &&
      current !== document.body &&
      current !== document.documentElement;
      current = current.parentElement
    ) {
      const style = getComputedStyle(current);
      if (current !== element && scrollable(current, style)) {
        chain.push(current);
        if (!scrollers.has(current))
          scrollers.set(current, {
            selector: selectorFor(current),
            x: current.scrollLeft,
            y: current.scrollTop,
            recordedX: current.scrollLeft,
            recordedY: current.scrollTop,
          });
      }
      if (style.position === "fixed") return { chain, window: false };
    }
    return { chain, window: true };
  };
  const offsetOf = (
    entry: Pick<Entry, "chain" | "window">,
    scroll = { x: window.scrollX, y: window.scrollY },
  ): Point => {
    let x = entry.window ? scroll.x : 0;
    let y = entry.window ? scroll.y : 0;
    for (const scroller of entry.chain) {
      const position = scrollers.get(scroller);
      x += position?.x ?? 0;
      y += position?.y ?? 0;
    }
    return { x, y };
  };

  const entries = new Map<Element, Entry>();
  let band: Point = { x: window.scrollX, y: window.scrollY };
  type Band = { top: number; bottom: number; left: number; right: number };
  /** Half a viewport beyond each edge of the current viewport. */
  const viewportBand = (): Band => ({
    top: -0.5 * window.innerHeight,
    bottom: 1.5 * window.innerHeight,
    left: -0.5 * window.innerWidth,
    right: 1.5 * window.innerWidth,
  });
  const inBand = (r: DOMRect, area: Band) =>
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > area.top &&
    r.top < area.bottom &&
    r.right > area.left &&
    r.left < area.right;
  const track = (element: Element): Entry | undefined => {
    if (entries.size >= limits.elements) {
      cut("elements");
      return undefined;
    }
    const placement = chainOf(element);
    const entry: Entry = {
      element,
      selector: selectorFor(element),
      ...placement,
      rect: box(element.getBoundingClientRect()),
      offset: offsetOf(placement),
    };
    entries.set(element, entry);
    return entry;
  };
  const candidate = (element: Element, area = viewportBand()) =>
    !entries.has(element) &&
    !(element instanceof SVGElement && !(element instanceof SVGSVGElement)) &&
    inBand(element.getBoundingClientRect(), area) &&
    painted(element);
  /** Join painted elements in the band, in document order, up to the cap. */
  const discover = (area = viewportBand()): Entry[] => {
    const joined: Entry[] = [];
    if (!document.body) return joined;
    band = { x: window.scrollX, y: window.scrollY };
    for (const element of document.body.querySelectorAll("*")) {
      if (!candidate(element, area)) continue;
      const entry = track(element);
      if (!entry) break;
      joined.push(entry);
    }
    return joined;
  };
  const sampleOf = (entry: Entry): Frame["elements"][number] => ({
    selector: entry.selector,
    rect: entry.rect,
    offset: entry.offset,
  });

  // Recording state.
  const frames: Frame[] = [];
  const shifts: RawTimeline["shifts"] = [];
  const mutations: RawTimeline["mutations"] = [];
  const animations: RawTimeline["animations"] = [];
  /** Index-aligned with `animations`: the element each one animates. */
  const animationTargets: Element[] = [];
  const viewTransition: RawTimeline["viewTransition"] = { used: false };
  const anchors = new Set<Element>();
  const inserted = new WeakSet<Node>();
  const pendingJoins: Element[] = [];
  let started = false;
  let dirty = true;
  let stopped = false;
  let frame = 0;
  const markDirty = () => {
    dirty = true;
  };

  let baseline = new Set<Animation>();
  const animationRecords = new Map<
    Animation,
    RawTimeline["animations"][number]
  >();
  const animationCleanup: Array<() => void> = [];
  const kebab = (key: string) =>
    key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  /** Record newly started animations; returns whether one is running. */
  const scanAnimations = (): boolean => {
    let running = false;
    for (const animation of document.getAnimations()) {
      if (baseline.has(animation)) continue;
      if (animation.playState === "running") running = true;
      if (animationRecords.has(animation)) continue;
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect) || !effect.target) continue;
      if (animationRecords.size >= limits.animations) {
        cut("animations");
        baseline.add(animation);
        continue;
      }
      const keyframes = effect.getKeyframes();
      const properties = [
        ...new Set(keyframes.flatMap((keyframe) => Object.keys(keyframe))),
      ]
        .filter(
          (key) =>
            !["offset", "computedOffset", "easing", "composite"].includes(
              key,
            ) &&
            new Set(keyframes.map((keyframe) => JSON.stringify(keyframe[key])))
              .size > 1,
        )
        .map(kebab)
        .sort();
      const timing = effect.getTiming();
      const duration = timing.duration;
      const pseudoElement = effect.pseudoElement ?? undefined;
      const record: RawTimeline["animations"][number] = {
        target: selectorFor(effect.target),
        ...(pseudoElement ? { pseudoElement } : {}),
        kind:
          "transitionProperty" in animation
            ? "transition"
            : "animationName" in animation
              ? "animation"
              : "web-animation",
        properties:
          "transitionProperty" in animation && properties.length === 0
            ? [String(animation.transitionProperty)]
            : properties,
        durationMs:
          typeof duration === "number" && Number.isFinite(duration)
            ? duration
            : null,
        delayMs:
          typeof timing.delay === "number" && Number.isFinite(timing.delay)
            ? timing.delay
            : 0,
        iterations:
          timing.iterations === Number.POSITIVE_INFINITY
            ? "infinite"
            : (timing.iterations ?? 1),
        startTime: now(),
        endTime: null,
      };
      if (pseudoElement?.startsWith("::view-transition")) {
        viewTransition.used = true;
        viewTransition.kind ??= "same-document";
      }
      animationRecords.set(animation, record);
      animations.push(record);
      animationTargets.push(effect.target);
      const ended = () => {
        record.endTime ??= now();
      };
      animation.addEventListener("finish", ended);
      animation.addEventListener("cancel", ended);
      animationCleanup.push(() => {
        animation.removeEventListener("finish", ended);
        animation.removeEventListener("cancel", ended);
      });
    }
    return running;
  };

  const onShifts = (list: PerformanceEntry[]) => {
    for (const raw of list) {
      const entry = raw as PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
        sources?: Array<{
          node?: Node | null;
          previousRect: DOMRectReadOnly;
          currentRect: DOMRectReadOnly;
        }>;
      };
      dirty = true;
      if (shifts.length >= limits.shifts) {
        cut("shifts");
        continue;
      }
      // Every entry is kept, including those after recent input.
      shifts.push({
        time: entry.startTime - startMark,
        value: entry.value,
        hadRecentInput: entry.hadRecentInput,
        sources: (entry.sources ?? []).flatMap((source) => {
          const node = source.node;
          const element =
            node instanceof Element ? node : (node?.parentElement ?? null);
          return element?.isConnected
            ? [
                {
                  selector: selectorFor(element),
                  previousRect: box(source.previousRect),
                  currentRect: box(source.currentRect),
                },
              ]
            : [];
        }),
      });
    }
  };
  let shiftObserver: PerformanceObserver | undefined;
  try {
    shiftObserver = new PerformanceObserver((list) =>
      onShifts(list.getEntries()),
    );
    shiftObserver.observe({ type: "layout-shift", buffered: config.load });
  } catch {
    notes.add("layout-shift entries unavailable in this browser");
  }

  /** Where each removed element was attached, for detached ancestry. */
  const removedParent = new WeakMap<Element, Element>();
  /** Elements whose own text nodes changed during the action. */
  const textTargets = new Set<Element>();
  const onMutations = (records: MutationRecord[]) => {
    if (!started) return;
    dirty = true;
    const time = now();
    for (const record of records) {
      if (record.type !== "childList") continue;
      const target = record.target;
      if (
        target instanceof Element &&
        [...record.addedNodes, ...record.removedNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE,
        )
      )
        textTargets.add(target);
      if (target instanceof Element)
        for (const node of record.removedNodes)
          if (node instanceof Element && !removedParent.has(node))
            removedParent.set(node, target);
      const within = (node: Node) => {
        for (let p = node.parentNode; p; p = p.parentNode)
          if (inserted.has(p)) return true;
        return false;
      };
      for (const node of record.addedNodes) {
        if (!(node instanceof Element) || within(node)) continue;
        inserted.add(node);
        if (target instanceof Element && target.isConnected)
          anchors.add(target);
        if (pendingJoins.length < limits.elements) pendingJoins.push(node);
        else cut("elements");
        if (mutations.length >= limits.mutations) {
          cut("mutations");
          continue;
        }
        mutations.push({
          time,
          type: "insert",
          selector: node.isConnected
            ? selectorFor(node)
            : `${target instanceof Element ? selectorFor(target) : "body"} > ${node.tagName.toLowerCase()}`,
          rect: node.isConnected ? box(node.getBoundingClientRect()) : null,
        });
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        // A removal inside an already-removed subtree is part of that one.
        if (!(target instanceof Element) || !target.isConnected) continue;
        anchors.add(target);
        const tracked = entries.get(node);
        if (mutations.length >= limits.mutations) {
          cut("mutations");
          continue;
        }
        mutations.push({
          time,
          type: "remove",
          selector:
            tracked?.selector ??
            `${selectorFor(target)} > ${node.tagName.toLowerCase()}`,
          rect: tracked?.rect ?? null,
        });
      }
    }
  };
  const mutationObserver = new MutationObserver(onMutations);

  /**
   * Record elements whose scroll-compensated geometry changed, scroll, and
   * joins. While the frame cap is reached nothing is committed, so the final
   * sample (which always has a slot) still holds each element's end state.
   */
  const sample = (final: boolean) => {
    if (!started) return;
    const full = frames.length >= limits.frames - (final ? 0 : 1);
    if (full && final) return;
    const time = now();
    const scroll = { x: window.scrollX, y: window.scrollY };
    const changedScrollers: Frame["scrollers"] = [];
    for (const [element, last] of scrollers) {
      if (!element.isConnected) continue;
      const x = element.scrollLeft;
      const y = element.scrollTop;
      if (x !== last.recordedX || y !== last.recordedY)
        changedScrollers.push({
          selector: last.selector,
          x,
          y,
        });
      last.x = x;
      last.y = y;
    }
    type Change = {
      entry: Entry;
      rect: Rect;
      offset: Point;
      dx: number;
      dy: number;
      resized: boolean;
    };
    const changes = new Map<Element, Change>();
    for (const entry of entries.values()) {
      if (!entry.element.isConnected) continue;
      const rect = box(entry.element.getBoundingClientRect());
      const offset = offsetOf(entry, scroll);
      const dx = rect.x + offset.x - (entry.rect.x + entry.offset.x);
      const dy = rect.y + offset.y - (entry.rect.y + entry.offset.y);
      const resized =
        Math.abs(rect.width - entry.rect.width) > 0.5 ||
        Math.abs(rect.height - entry.rect.height) > 0.5;
      if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5 && !resized) {
        // Pure scroll: keep the latest viewport position without a record.
        entry.rect = rect;
        entry.offset = offset;
        continue;
      }
      changes.set(entry.element, { entry, rect, offset, dx, dy, resized });
    }
    const scrolled =
      scroll.x !== frames.at(-1)?.scroll.x ||
      scroll.y !== frames.at(-1)?.scroll.y;
    const rescan =
      Math.abs(scroll.y - band.y) > 0.25 * window.innerHeight ||
      Math.abs(scroll.x - band.x) > 0.25 * window.innerWidth;
    const pending = pendingJoins.length > 0;
    if (
      !final &&
      changes.size === 0 &&
      changedScrollers.length === 0 &&
      !scrolled &&
      !rescan &&
      !pending
    )
      return;
    if (full) {
      cut("frames");
      return;
    }
    for (const last of scrollers.values()) {
      last.recordedX = last.x;
      last.recordedY = last.y;
    }
    // A descendant moving rigidly with its nearest tracked ancestor is
    // represented by that ancestor.
    const recorded: Entry[] = [];
    for (const change of changes.values()) {
      change.entry.rect = change.rect;
      change.entry.offset = change.offset;
      let ancestor: Change | undefined;
      for (
        let parent = change.entry.element.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        if (!entries.has(parent)) continue;
        ancestor = changes.get(parent);
        break;
      }
      if (
        !change.resized &&
        ancestor &&
        Math.abs(ancestor.dx - change.dx) <= 0.5 &&
        Math.abs(ancestor.dy - change.dy) <= 0.5
      )
        continue;
      if (recorded.length >= limits.changesPerFrame) {
        cut("changes");
        continue;
      }
      recorded.push(change.entry);
    }
    const joined: Entry[] = [];
    // Inserted subtrees join while the tracked set is under its cap.
    for (const element of pendingJoins.splice(0)) {
      if (!element.isConnected) continue;
      for (const descendant of [element, ...element.querySelectorAll("*")]) {
        if (!candidate(descendant)) continue;
        const entry = track(descendant);
        if (!entry) break;
        joined.push(entry);
      }
    }
    // The area the user sees after a scroll is tracked too.
    if (rescan) joined.push(...discover());
    const elements = [...recorded, ...joined].map(sampleOf);
    if (elements.length > limits.changesPerFrame) cut("changes");
    frames.push({
      time,
      scroll,
      scrollers: changedScrollers,
      elements: elements.slice(0, limits.changesPerFrame),
    });
  };

  const trigger = (() => {
    if (!config.trigger) return null;
    try {
      return document.querySelector(config.trigger);
    } catch {
      return null;
    }
  })();
  // Visible changes: what the action made appear, disappear or resize,
  // classified while the live DOM (ancestry, ARIA, hidden reveals) exists.
  type VisibleChange = NonNullable<RawTimeline["visibleChanges"]>[number];
  type Kind = VisibleChange["kind"];
  const overlayDefaults =
    "dialog, aside, details, [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=region], [aria-modal=true], [popover], [role=tooltip]";
  const surfaceSelector = [
    overlayDefaults,
    ...(config.surfaces ?? []).filter((selector) => {
      try {
        document.querySelector(selector);
        return true;
      } catch {
        return false;
      }
    }),
  ].join(", ");
  const isSurface = (element: Element) => {
    try {
      return element.matches(surfaceSelector);
    } catch {
      return false;
    }
  };
  const toggleState = (element: Element): string =>
    JSON.stringify([
      ...[
        "open",
        "hidden",
        "aria-hidden",
        "inert",
        "data-state",
        "aria-expanded",
      ].map((name) => element.getAttribute(name)),
      (() => {
        try {
          return element.matches(":popover-open");
        } catch {
          return false;
        }
      })(),
    ]);
  const shown = (element: Element): Rect | undefined => {
    if (element instanceof SVGElement && !(element instanceof SVGSVGElement))
      return undefined;
    const r = element.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return undefined;
    const check = (
      element as Element & {
        checkVisibility?: (options: object) => boolean;
      }
    ).checkVisibility;
    if (check) {
      if (
        !check.call(element, { checkOpacity: true, checkVisibilityCSS: true })
      )
        return undefined;
    } else if (!painted(element)) return undefined;
    return box(r);
  };
  const inView = (r: Rect, area = viewportBand()) =>
    r.width > 0 &&
    r.height > 0 &&
    r.y + r.height > area.top &&
    r.y < area.bottom &&
    r.x + r.width > area.left &&
    r.x < area.right;
  type Start = {
    fromUrl: string;
    reducedMotion: boolean;
    visible: Map<Element, Rect>;
    /** Document-order bound of the snapshot when it hit its cap. */
    last: Element | undefined;
    toggles: Map<Element, string>;
    controls: Element[];
    /** Targets of animations already running when the action began. */
    running: Element[];
  };
  let start: Start | undefined;
  const snapshotStart = () => {
    if (config.load || !document.body) return;
    const visible = new Map<Element, Rect>();
    let last: Element | undefined;
    const cap = config.snapshotElements ?? 4000;
    let scanned = 0;
    for (const element of document.body.querySelectorAll("*")) {
      if (scanned >= cap) {
        cut("visibleChanges");
        break;
      }
      scanned += 1;
      last = element;
      const rect = shown(element);
      if (rect) visible.set(element, rect);
    }
    const toggles = new Map<Element, string>();
    try {
      for (const element of document.querySelectorAll(surfaceSelector))
        toggles.set(element, toggleState(element));
    } catch {
      // An unreadable selector list leaves no toggle facts.
    }
    const running = document.getAnimations().flatMap((animation) => {
      const target =
        animation.effect instanceof KeyframeEffect
          ? animation.effect.target
          : null;
      return target && (animation.playState === "running" || animation.pending)
        ? [target]
        : [];
    });
    start = {
      running,
      fromUrl: location.pathname,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      visible,
      last: scanned >= cap ? last : undefined,
      toggles,
      controls: trigger
        ? [
            ...new Set(
              ["aria-controls", "aria-owns"].flatMap((name) =>
                (trigger.getAttribute(name) ?? "").split(/\s+/).filter(Boolean),
              ),
            ),
          ].flatMap((id) => {
            const element = document.getElementById(id);
            return element ? [element] : [];
          })
        : [],
    };
  };
  const visibleChanges = (): VisibleChange[] => {
    const before = start;
    if (!before || !document.body) return [];
    const parentOf = (element: Element): Element | null =>
      element.parentElement ?? removedParent.get(element) ?? null;
    const lineage = (element: Element): Element[] => {
      const chain: Element[] = [];
      for (
        let current = parentOf(element);
        current &&
        current !== document.body &&
        current !== document.documentElement;
        current = parentOf(current)
      )
        chain.push(current);
      return chain;
    };
    const within = (element: Element, ancestor: Element) =>
      element === ancestor || lineage(element).includes(ancestor);
    const closestVia = (element: Element, selector: string) => {
      for (const candidate of [element, ...lineage(element)]) {
        try {
          if (candidate.matches(selector)) return candidate;
        } catch {
          return undefined;
        }
      }
      return undefined;
    };
    const known = (element: Element) =>
      !before.last ||
      !!(
        before.last.compareDocumentPosition(element) &
        Node.DOCUMENT_POSITION_PRECEDING
      ) ||
      before.last === element;
    // Appeared: visible now, absent from the start, under no appeared ancestor.
    const appeared = new Map<Element, Rect>();
    const endVisible = new Map<Element, Rect>();
    for (const element of document.body.querySelectorAll("*")) {
      const rect = shown(element);
      if (!rect) continue;
      endVisible.set(element, rect);
      if (before.visible.has(element)) continue;
      if (!known(element) && !inserted.has(element)) {
        let fresh = false;
        for (let p = element.parentNode; p; p = p.parentNode)
          if (inserted.has(p)) fresh = true;
        if (!fresh) continue;
      }
      appeared.set(element, rect);
    }
    const appearedRoots = [...appeared].filter(
      ([element]) => !lineage(element).some((a) => appeared.has(a)),
    );
    // Disappeared: visible at the start, detached or hidden now.
    const gone = new Set<Element>();
    for (const element of before.visible.keys())
      if (!element.isConnected || !endVisible.has(element)) gone.add(element);
    const goneRoots = [...gone].filter(
      (element) => !lineage(element).some((a) => gone.has(a)),
    );
    // Overlay surfaces that opened, closed or toggled belong to the overlay path.
    const active = new Set<Element>();
    for (const [element, state] of before.toggles)
      if (
        !element.isConnected ||
        toggleState(element) !== state ||
        appeared.has(element) ||
        gone.has(element)
      )
        active.add(element);
    try {
      for (const element of document.querySelectorAll(surfaceSelector))
        if (!before.toggles.has(element)) active.add(element);
    } catch {
      // No surfaces readable.
    }
    const currentTrigger = (() => {
      if (!config.trigger) return null;
      try {
        return document.querySelector(config.trigger);
      } catch {
        return null;
      }
    })();
    const triggers = [trigger, currentTrigger].filter(
      (element): element is Element => element !== null,
    );
    const inTrigger = (element: Element) =>
      triggers.some((t) => within(element, t));
    const area = (r: Rect) => r.width * r.height;
    const holdsSurface = (element: Element, rect: Rect) => {
      if (!element.isConnected) return false;
      try {
        for (const surface of element.querySelectorAll(surfaceSelector)) {
          const r = endVisible.get(surface) ?? before.visible.get(surface);
          if (r && area(r) >= 0.5 * area(rect)) return true;
        }
      } catch {
        return false;
      }
      return false;
    };
    const inActive = (element: Element) =>
      [element, ...lineage(element)].some((a) => active.has(a));
    type Root = {
      element: Element;
      direction: VisibleChange["direction"];
      before: Rect | null;
      after: Rect | null;
    };
    // Most of the change is on screen (or it fills most of the screen).
    const onScreen = (r: Rect) => {
      const width =
        Math.min(r.x + r.width, window.innerWidth) - Math.max(r.x, 0);
      const height =
        Math.min(r.y + r.height, window.innerHeight) - Math.max(r.y, 0);
      const shown = Math.max(0, width) * Math.max(0, height);
      return (
        shown >= 0.5 * Math.min(area(r), window.innerWidth * window.innerHeight)
      );
    };
    const covered = (targets: Element[], element: Element, rect: Rect) =>
      targets.some((target) => {
        if (target === element || lineage(element).includes(target))
          return true;
        if (!element.isConnected || !element.contains(target)) return false;
        const r = target.getBoundingClientRect();
        return r.width * r.height >= 0.5 * area(rect);
      });
    // Pressing a control that swaps for another is control feedback.
    const interactive =
      "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=menuitem], [role=option]";
    const isInteractive = (element: Element) => {
      try {
        return element.matches(interactive);
      } catch {
        return false;
      }
    };
    // Out-of-flow layers (dropdowns, portals, loading overlays, decorative
    // backdrops) are overlays, judged by the overlay rule.
    const floating = (element: Element) =>
      element.isConnected &&
      /^(?:fixed|absolute)$/.test(getComputedStyle(element).position);
    const roots: Root[] = [];
    for (const [element, rect] of appearedRoots)
      if (inView(rect))
        roots.push({ element, direction: "in", before: null, after: rect });
    for (const element of goneRoots) {
      const rect = before.visible.get(element);
      if (rect && inView(rect))
        roots.push({ element, direction: "out", before: rect, after: null });
    }
    const presence = roots.filter(
      (root) =>
        onScreen(root.before ?? root.after ?? box(new DOMRect())) &&
        !isInteractive(root.element) &&
        // An entrance already under way when the action began is not its effect.
        !covered(
          before.running,
          root.element,
          root.before ?? root.after ?? box(new DOMRect()),
        ) &&
        !inTrigger(root.element) &&
        !isSurface(root.element) &&
        !holdsSurface(
          root.element,
          root.before ?? root.after ?? box(new DOMRect()),
        ) &&
        !inActive(root.element),
    );
    // Resized: visible at both ends with a height change. A resize next to
    // any appearance or overlay toggle (even an excluded one) is its
    // reflow, so it only stands alone; sideways reflow is never an expander.
    const main = document.querySelector("main, [role=main]");
    const isControlled = (element: Element) =>
      before.controls.includes(element);
    const resized: Root[] = [];
    if (roots.length === 0 && active.size === 0)
      for (const [element, rect] of before.visible) {
        const now = endVisible.get(element);
        if (
          !now ||
          element === document.body ||
          element === document.documentElement
        )
          continue;
        if (Math.abs(now.height - rect.height) < 4) continue;
        if (!inView(now) || !onScreen(now)) continue;
        if (inTrigger(element) || inActive(element)) continue;
        if (covered(before.running, element, now)) continue;
        if (
          triggers.some((t) => element.contains(t)) &&
          !isControlled(element) &&
          element !== main
        )
          continue;
        resized.push({
          element,
          direction: "resize",
          before: rect,
          after: now,
        });
      }
    const delta = (root: Root) =>
      Math.abs((root.after?.height ?? 0) - (root.before?.height ?? 0));
    // Keep the innermost of a chain resizing together.
    const regions = resized.filter(
      (region) =>
        !resized.some(
          (other) =>
            other !== region &&
            region.element.contains(other.element) &&
            Math.abs(delta(other) - delta(region)) <= 1,
        ),
    );
    const all = [...presence, ...regions];
    // Classification, first match wins.
    const routed = location.pathname !== before.fromUrl;
    const live =
      "[role=status], [role=alert], [role=log], [aria-live]:not([aria-live=off]), output";
    const lists =
      "ul, ol, [role=list], tbody, [role=rowgroup], [role=grid], [role=table], [role=feed]";
    const sameShape = (a: Element, b: Element) =>
      a.tagName === b.tagName &&
      [...a.classList]
        .filter((c) => !generatedClass(c))
        .sort()
        .join(" ") ===
        [...b.classList]
          .filter((c) => !generatedClass(c))
          .sort()
          .join(" ");
    const classified: Array<Root & { kind: Kind; container: Element }> = [];
    const parents = new Map<Element, Set<VisibleChange["direction"]>>();
    for (const root of presence) {
      const parent = parentOf(root.element);
      if (!parent) continue;
      const directions = parents.get(parent) ?? new Set();
      directions.add(root.direction);
      parents.set(parent, directions);
    }
    const routeRoots: Root[] = [];
    for (const root of all) {
      const element = root.element;
      const parent = parentOf(element) ?? element;
      const rect = root.after ?? root.before;
      if (
        routed &&
        (main
          ? within(element, main)
          : !!rect &&
            area(rect) >= 0.5 * window.innerWidth * window.innerHeight)
      ) {
        routeRoots.push(root);
        continue;
      }
      // Content replaced within one parent is a swap, whatever it holds.
      if (
        root.direction !== "resize" &&
        (parents.get(parent)?.size ?? 0) > 1 &&
        !floating(element)
      ) {
        classified.push({ ...root, kind: "content-swap", container: parent });
        continue;
      }
      // A live region, or a host that just appeared around one (a toast stack).
      const hosted =
        element.isConnected && root.direction !== "resize" && rect
          ? (element.querySelector(live) ?? undefined)
          : undefined;
      const hostedRect = hosted?.getBoundingClientRect();
      const status =
        closestVia(element, live) ??
        (hosted && rect && hostedRect && hostedRect.height >= 0.5 * rect.height
          ? hosted
          : undefined);
      if (status) {
        classified.push({
          ...root,
          kind: "status",
          container:
            status === element
              ? parent
              : element.contains(status)
                ? element
                : status,
        });
        continue;
      }
      if (root.direction === "resize") {
        classified.push({
          ...root,
          kind: "expand-collapse",
          container: element,
        });
        continue;
      }
      if (floating(element)) continue;
      const target =
        before.controls.find((control) => within(element, control)) ??
        closestVia(element, "[role=tabpanel]");
      if (target) {
        const swap =
          target.matches("[role=tabpanel]") ||
          (parents.get(parentOf(target) ?? target)?.size ?? 0) > 1 ||
          (target !== element && (parents.get(parent)?.size ?? 0) > 1);
        classified.push({
          ...root,
          kind: swap ? "content-swap" : "expand-collapse",
          container: swap
            ? target === element
              ? parent
              : (parentOf(target) ?? target)
            : target,
        });
        continue;
      }
      if (parent.matches(lists)) {
        classified.push({ ...root, kind: "list-item", container: parent });
        continue;
      }
      if ((parents.get(parent)?.size ?? 0) > 1) {
        classified.push({ ...root, kind: "content-swap", container: parent });
        continue;
      }
      const alike = [...parent.children].filter(
        (child) => child !== element && sameShape(child, element),
      );
      if (alike.length >= 2) {
        classified.push({ ...root, kind: "list-item", container: parent });
        continue;
      }
      classified.push({ ...root, kind: "expand-collapse", container: parent });
    }
    if (routeRoots.length) {
      const widest = routeRoots.reduce((a, b) =>
        area(b.after ?? b.before ?? box(new DOMRect())) >
        area(a.after ?? a.before ?? box(new DOMRect()))
          ? b
          : a,
      );
      const container = main ?? widest.element;
      classified.push({
        element: container,
        direction: "in",
        before: widest.before,
        after: widest.after,
        kind: "route",
        container,
      });
    }
    const extentOf = (root: Root) =>
      root.direction === "resize"
        ? delta(root)
        : Math.min(
            (root.after ?? root.before)?.width ?? 0,
            (root.after ?? root.before)?.height ?? 0,
          );
    const inline = new Set([
      "span",
      "a",
      "b",
      "strong",
      "em",
      "i",
      "small",
      "code",
      "abbr",
      "sup",
      "sub",
      "time",
      "mark",
      "label",
      "data",
      "output",
    ]);
    const textOnlyOf = (root: Root & { kind: Kind }) => {
      const element = root.element;
      if (root.kind === "route") return false;
      if (root.direction === "resize")
        return (
          [...textTargets].some((t) => element.contains(t)) &&
          !presence.some((p) => element.contains(p.element))
        );
      if (element.children.length > 0) return false;
      const inlineLevel = (leaf: Element) =>
        leaf.isConnected
          ? /^(?:inline|contents)$/.test(getComputedStyle(leaf).display)
          : inline.has(leaf.tagName.toLowerCase());
      if (inlineLevel(element)) return true;
      if (element.isConnected) return false;
      // A detached leaf swapped for an inline twin (a re-rendered counter).
      return presence.some(
        (other) =>
          other.element !== element &&
          other.direction !== root.direction &&
          parentOf(other.element) === parentOf(element) &&
          other.element.tagName === element.tagName &&
          other.element.children.length === 0 &&
          inlineLevel(other.element),
      );
    };
    const covers = (target: Element, element: Element, rect: Rect | null) => {
      if (target === element || lineage(element).includes(target)) return true;
      if (!rect || !element.isConnected || !element.contains(target))
        return false;
      const r = target.getBoundingClientRect();
      return r.width * r.height >= 0.5 * area(rect);
    };
    const selectorOf = (element: Element) => {
      if (element.isConnected) return selectorFor(element);
      const tracked = entries.get(element)?.selector;
      if (tracked) return tracked;
      const parent = parentOf(element);
      const tag = element.tagName.toLowerCase();
      return parent?.isConnected ? `${selectorFor(parent)} > ${tag}` : tag;
    };
    const nameOf = (element: Element): string =>
      (
        element.getAttribute("aria-label") ||
        (element.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim() ||
        element.querySelector("h1,h2,h3,h4,[role=heading]")?.textContent ||
        element.tagName.toLowerCase()
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
    const changes: VisibleChange[] = [];
    for (const root of classified) {
      const extent = extentOf(root);
      if (extent < 4) continue;
      if (changes.length >= limits.visibleChanges) {
        cut("visibleChanges");
        break;
      }
      const rect = root.after ?? root.before;
      const element = root.kind === "route" ? root.element : root.element;
      const container = selectorOf(root.container);
      const indices = animationTargets.flatMap((target, index) =>
        covers(target, element, rect) ||
        (root.kind === "route" &&
          routeRoots.some((r) =>
            covers(target, r.element, r.after ?? r.before),
          ))
          ? [index]
          : [],
      );
      const tweened = (target: Element) => (styleFrames.get(target) ?? 0) >= 3;
      const progressive =
        tweened(element) ||
        lineage(element).some(tweened) ||
        [...styleFrames.keys()].some(
          (target) =>
            target !== element &&
            tweened(target) &&
            covers(target, element, rect),
        );
      changes.push({
        selector: selectorOf(element),
        container,
        containerName: nameOf(root.container),
        kind: root.kind,
        key: `${root.kind}|${container}`,
        direction: root.direction,
        before: root.before,
        after: root.after,
        extent:
          root.kind === "route"
            ? Math.max(...routeRoots.map(extentOf))
            : extent,
        textOnly: textOnlyOf(root),
        animations: indices,
        progressive,
      });
    }
    return changes;
  };
  const begin = () => {
    if (started || !document.body) return;
    started = true;
    baseline = new Set(config.load ? [] : document.getAnimations());
    // Playwright scrolls an out-of-view control into view and clicks within
    // one frame, so the area around the control is tracked first, from the
    // start, rather than re-derived after the scroll.
    const at = trigger?.getBoundingClientRect();
    if (at && !inBand(at, viewportBand()))
      discover({
        top: at.top - window.innerHeight,
        bottom: at.bottom + window.innerHeight,
        left: Math.min(at.left, 0) - 0.5 * window.innerWidth,
        right: Math.max(at.right, window.innerWidth) + 0.5 * window.innerWidth,
      });
    discover();
    const first: Frame = {
      time: now(),
      scroll: { x: window.scrollX, y: window.scrollY },
      scrollers: [...scrollers.values()].map(({ selector, x, y }) => ({
        selector,
        x,
        y,
      })),
      elements: [...entries.values()].map(sampleOf),
    };
    frames.push(first);
    mutationObserver.observe(document, { childList: true, subtree: true });
    snapshotStart();
    dirty = false;
  };
  // Init scripts run before body exists. The frame loop starts tracking as
  // soon as a body is available, including visible changes during parsing.
  begin();

  // Inline style written on 3+ frames is a script-driven tween.
  const styleDirty = new Set<Element>();
  const styleFrames = new Map<Element, number>();
  const observedDirty = new MutationObserver((records) => {
    markDirty();
    if (!started || config.load) return;
    for (const record of records) {
      if (
        record.type === "attributes" &&
        record.attributeName === "style" &&
        record.target instanceof Element
      )
        styleDirty.add(record.target);
      else if (record.type === "characterData" && record.target.parentElement)
        textTargets.add(record.target.parentElement);
    }
  });
  observedDirty.observe(document, {
    attributes: true,
    characterData: true,
    subtree: true,
  });
  const eventNames = ["transitionrun", "animationstart"];
  for (const name of eventNames)
    document.addEventListener(name, markDirty, {
      capture: true,
      passive: true,
    });
  document.addEventListener("scroll", markDirty, {
    capture: true,
    passive: true,
  });
  window.addEventListener("scroll", markDirty, { passive: true });
  const onReveal = (event: Event) => {
    if ((event as Event & { viewTransition?: unknown }).viewTransition) {
      viewTransition.used = true;
      viewTransition.kind = "cross-document";
    }
  };
  if (config.load) {
    window.addEventListener("pagereveal", onReveal);
    window.addEventListener("pageswap", onReveal);
  }

  const deadline = performance.now() + 30_000;
  const tick = () => {
    if (stopped) return;
    if (config.load && performance.now() > deadline) {
      notes.add("load timeline reached its 30 second recording bound");
      const raw = scope.__idiomTimeline?.finish();
      // Keep the bounded snapshot available to the collector, with every
      // observer and listener already disconnected.
      if (raw)
        scope.__idiomTimeline = {
          token: config.token,
          finish: () => raw,
          dispose: () => {
            if (scope.__idiomTimeline?.token === config.token)
              delete scope.__idiomTimeline;
          },
        };
      return;
    }
    begin();
    const running = started && scanAnimations();
    if (dirty || running) {
      dirty = false;
      sample(false);
    }
    for (const element of styleDirty)
      if (styleFrames.size < 500 || styleFrames.has(element))
        styleFrames.set(element, (styleFrames.get(element) ?? 0) + 1);
    styleDirty.clear();
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  const controls = trigger
    ? [
        ...new Set(
          ["aria-controls", "aria-owns"].flatMap((name) =>
            (trigger.getAttribute(name) ?? "").split(/\s+/).filter(Boolean),
          ),
        ),
      ].flatMap((id) => {
        const element = document.getElementById(id);
        return element ? [selectorFor(element)] : [];
      })
    : [];
  const control = trigger ? selectorFor(trigger) : undefined;

  const dispose = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    shiftObserver?.disconnect();
    mutationObserver.disconnect();
    observedDirty.disconnect();
    for (const cleanup of animationCleanup) cleanup();
    for (const name of eventNames)
      document.removeEventListener(name, markDirty, { capture: true });
    document.removeEventListener("scroll", markDirty, { capture: true });
    window.removeEventListener("scroll", markDirty);
    window.removeEventListener("pagereveal", onReveal);
    window.removeEventListener("pageswap", onReveal);
    if (scope.__idiomTimeline?.token === config.token)
      delete scope.__idiomTimeline;
  };
  const commonAncestor = (): string | undefined => {
    const connected = [...anchors].filter((element) => element.isConnected);
    let common: Element | null = connected[0] ?? null;
    for (const element of connected.slice(1))
      while (common && !common.contains(element)) common = common.parentElement;
    return common ? selectorFor(common) : undefined;
  };
  scope.__idiomTimeline = {
    token: config.token,
    dispose,
    finish: () => {
      begin();
      if (shiftObserver) onShifts(shiftObserver.takeRecords());
      onMutations(mutationObserver.takeRecords());
      if (started) scanAnimations();
      sample(true);
      const ancestor = commonAncestor();
      let changes: VisibleChange[] | undefined;
      try {
        changes = start ? visibleChanges() : undefined;
      } catch (error) {
        notes.add(
          `visible changes unavailable: ${String(error).split("\n")[0]}`,
        );
      }
      dispose();
      return {
        url: location.pathname,
        ...(start
          ? { fromUrl: start.fromUrl, reducedMotion: start.reducedMotion }
          : {}),
        ...(changes ? { visibleChanges: changes } : {}),
        clockOrigin: performance.timeOrigin + startMark,
        truncated: [...truncated],
        notes: [...notes],
        shifts,
        frames,
        mutations,
        animations,
        viewTransition,
        effectRegion: {
          ...(control ? { control } : {}),
          controls,
          ...(ancestor ? { commonAncestor: ancestor } : {}),
        },
      };
    },
  };
}

type RequestRecord = ActionTimeline["requests"][number];

type TimelineExtras = Pick<ActionTimeline, "held" | "failure">;

function unavailableAction(
  identity: TimelineIdentity,
  reason: string,
  extras: TimelineExtras = {},
): ActionTimeline {
  return {
    ...extras,
    ...identity,
    url: "",
    startedAt: Date.now(),
    durationMs: 0,
    settled: false,
    status: "unavailable",
    reason: `timeline unavailable: ${reason.split("\n")[0]}`,
    truncated: [],
    shifts: [],
    frames: [],
    mutations: [],
    animations: [],
    requests: [],
    viewTransition: { used: false },
    effectRegion: { controls: [] },
  };
}

export type TimelineHandle = {
  key: string;
  finishVisual(motion?: MotionArtifact): Promise<void>;
  /** Ends the window; `settled` is false when it ended at its bound. */
  finish(reason?: string, settled?: boolean): Promise<void>;
  dispose(): Promise<void>;
};

/**
 * Records what the user experiences between an action and the end of the
 * existing effect window. Visual tails finish separately after these facts freeze.
 */
export class TimelineCollector {
  private actions: ActionTimeline[] = [];
  private pending = new Set<TimelineHandle>();
  private load: TimelineHandle | undefined;
  private visualTails: Promise<void>[] = [];
  private clock: () => number;
  private surfaces: string[];
  constructor(
    private page: Page,
    private options: {
      clock?: (() => number) | undefined;
      /** `checks.motion.selectors`: changes on these belong to overlays. */
      motionSelectors?: string[] | undefined;
      filmstrips?: FilmstripCapture | undefined;
      filmstripPage?: Page | undefined;
    } = {},
  ) {
    this.clock = options.clock ?? (() => performance.now());
    this.surfaces = options.motionSelectors ?? [];
  }

  get recorded(): number {
    return this.actions.length;
  }

  /** The most recently finished action, as recorded. */
  lastAction(): ActionTimeline | undefined {
    return this.actions.at(-1);
  }

  /**
   * `extras` is read when the action finishes: a slow replay attaches the
   * held facts it gathered, even when the window ends unavailable.
   */
  async start(
    identity: TimelineIdentity,
    extras?: () => TimelineExtras,
  ): Promise<TimelineHandle> {
    const token = `${Date.now()}:${Math.random()}`;
    let failure: string | undefined;
    await ensureVisibilityDom(this.page).catch(() => undefined);
    const requests = this.watch();
    const visualCleanup = await this.options.filmstrips?.start(
      this.page,
      identity,
      token,
      this.options.filmstripPage,
    );
    const handle = this.handle(
      identity,
      token,
      requests,
      () => failure,
      visualCleanup,
      extras,
    );
    try {
      await this.page.evaluate(timelineRecorder, {
        token,
        load: false,
        trigger: identity.selector,
        limits: TIMELINE_LIMITS,
        surfaces: this.surfaces,
        snapshotElements: SNAPSHOT_ELEMENTS,
      });
    } catch (error) {
      failure = `timeline instrumentation unavailable: ${String(error).split("\n")[0]}`;
    }
    return handle;
  }

  /**
   * Install the load recorder before navigation. It is finished by the first
   * web step, or once the state has settled, whichever comes first.
   */
  async beginLoad(identity: TimelineIdentity): Promise<void> {
    const token = `${Date.now()}:${Math.random()}`;
    const scripts: Disposable[] = [];
    let failure: string | undefined;
    const requests = this.watch();
    const visualCleanup = await this.options.filmstrips?.start(
      this.page,
      identity,
      token,
      this.options.filmstripPage,
    );
    try {
      scripts.push(await this.page.addInitScript(installVisibilityDom));
      scripts.push(
        await this.page.addInitScript(timelineRecorder, {
          token,
          load: true,
          limits: TIMELINE_LIMITS,
        }),
      );
    } catch (error) {
      failure = `timeline instrumentation unavailable: ${String(error).split("\n")[0]}`;
    }
    this.load = this.handle(
      identity,
      token,
      requests,
      () => failure,
      async () => {
        await visualCleanup?.();
        // Later restore navigations on this page are not part of the load.
        await Promise.all(
          scripts.map((script) => script.dispose().catch(() => undefined)),
        );
      },
    );
  }

  async finishLoad(
    reason?: string,
    settled = false,
    background = false,
  ): Promise<void> {
    const load = this.load;
    if (!load) return;
    this.load = undefined;
    try {
      await load.finish(reason, settled);
      const visual = load.finishVisual();
      if (background) this.visualTails.push(visual);
      else await visual;
    } finally {
      await load.dispose();
    }
  }

  async waitVisual(): Promise<void> {
    await Promise.all(this.visualTails.splice(0));
  }

  /** Preserve partial evidence when an attempt's deadline interrupts its work. */
  async finishPending(reason: string): Promise<void> {
    await Promise.all(
      [...this.pending].map(async (handle) => {
        await handle.finish(reason, false);
        await handle.finishVisual();
      }),
    );
  }

  private watch() {
    const begun = this.clock();
    const records = new Map<Request, RequestRecord>();
    let dropped = false;
    let navigated = false;
    const at = () => this.clock() - begun;
    const onRequest = (request: Request) => {
      if (ignoredRequest(request)) return;
      if (records.size >= TIMELINE_LIMITS.requests) {
        dropped = true;
        return;
      }
      let path = "";
      try {
        path = new URL(request.url()).pathname;
      } catch {
        path = request.url().split(/[?#]/)[0] ?? "";
      }
      const record: RequestRecord = {
        method: request.method(),
        resourceType: request.resourceType(),
        path,
        startTime: at(),
        endTime: null,
        status: null,
        outcome: "pending",
      };
      records.set(request, record);
      const type = request.resourceType();
      if (type === "fetch" || type === "xhr")
        rememberRequest(record, {
          method: request.method(),
          url: request.url(),
          resourceType: type,
        });
    };
    const onFinished = (request: Request) => {
      const record = records.get(request);
      if (!record) return;
      record.endTime = at();
      const timing = request.timing();
      if (timing.responseEnd >= 0)
        rememberResponse(record, timing.startTime + timing.responseEnd);
      record.outcome = "ok";
      void request
        .response()
        .then((response) => {
          if (response) record.status = response.status();
        })
        .catch(() => undefined);
    };
    const onFailed = (request: Request) => {
      const record = records.get(request);
      if (!record) return;
      record.endTime = at();
      record.outcome = /ERR_BLOCKED_BY_CLIENT/.test(
        request.failure()?.errorText ?? "",
      )
        ? "blocked"
        : "failed";
    };
    const onNavigated = (frame: { parentFrame(): unknown }) => {
      if (frame.parentFrame() === null) navigated = true;
    };
    const page = this.page;
    try {
      page.on("request", onRequest);
      page.on("requestfinished", onFinished);
      page.on("requestfailed", onFailed);
      page.on("framenavigated", onNavigated);
    } catch {
      // A page whose deadline has expired records no requests.
    }
    return {
      begun,
      startedAt: Date.now(),
      stop: async () => {
        try {
          page.off("request", onRequest);
          page.off("requestfinished", onFinished);
          page.off("requestfailed", onFailed);
          page.off("framenavigated", onNavigated);
        } catch {
          // Nothing to remove from a page that never accepted listeners.
        }
        // Statuses resolve from responses that have already arrived.
        await Promise.all(
          [...records].map(async ([request, record]) => {
            if (record.outcome !== "ok" || record.status !== null) return;
            const response = await request.response().catch(() => null);
            if (response) record.status = response.status();
          }),
        );
        return {
          requests: [...records.values()],
          dropped,
          navigated,
          durationMs: Math.max(0, at()),
        };
      },
    };
  }

  private handle(
    identity: TimelineIdentity,
    token: string,
    requests: ReturnType<TimelineCollector["watch"]>,
    failureReason: () => string | undefined,
    cleanup?: () => Promise<void>,
    extras: () => TimelineExtras = () => ({}),
  ): TimelineHandle {
    let finishing: Promise<void> | undefined;
    let disposed = false;
    let recorded = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      this.pending.delete(handle);
      // An aborted action may be disposed without ever calling finish().
      // Its network listeners must not leak into later action windows.
      await requests.stop();
      try {
        await this.page.evaluate((token) => {
          const active = (window as TimelineWindow).__idiomTimeline;
          if (active?.token === token) active.dispose();
        }, token);
      } catch {
        // Deadline-bound pages may throw synchronously after retirement.
      }
      await cleanup?.();
    };
    const handle: TimelineHandle = {
      key: token,
      finishVisual: async (motion) => {
        const action = this.actions.find((a) => recordingKey(a) === token);
        if (action) await this.options.filmstrips?.finish(action, motion);
      },
      finish: (reason, settled = true) => {
        if (finishing) return finishing;
        finishing = (async () => {
          let raw: RawTimeline | null = null;
          const failure = failureReason();
          let error: string | undefined = failure;
          if (!failure && reason !== "non-html document")
            try {
              raw = await this.page.evaluate((token) => {
                const active = (window as TimelineWindow).__idiomTimeline;
                if (active?.token !== token) return null;
                return active.finish();
              }, token);
            } catch (caught) {
              error = String(caught).split("\n")[0];
            }
          const network = await requests.stop();
          const truncated = new Set<Truncation>(raw?.truncated ?? []);
          if (network.dropped) truncated.add("requests");
          const reasons = [
            ...(reason ? [reason] : []),
            ...(raw?.notes ?? []),
            ...(truncated.size
              ? [`timeline truncated: ${[...truncated].join(", ")}`]
              : []),
          ];
          const base = linkRecording(
            {
              ...identity,
              ...extras(),
              startedAt: requests.startedAt,
              durationMs: network.durationMs,
              settled,
              truncated: [...truncated],
              requests: network.requests,
            },
            token,
          );
          if (raw) {
            const { notes: _notes, truncated: _truncated, ...facts } = raw;
            this.actions.push({
              ...base,
              ...facts,
              status: reasons.length ? "partial" : "ran",
              ...(reasons.length ? { reason: reasons.join("; ") } : {}),
            });
          } else {
            const navigation =
              identity.source !== "load" && !failure && network.navigated;
            this.actions.push({
              ...base,
              url: "",
              status: navigation ? "partial" : "unavailable",
              reason: [
                ...(reason ? [reason] : []),
                navigation
                  ? "document navigated during the action; in-page timeline unavailable"
                  : (error ??
                    reason ??
                    "document navigation invalidated the timeline"),
              ].join("; "),
              shifts: [],
              frames: [],
              mutations: [],
              animations: [],
              viewTransition: { used: false },
              effectRegion: {
                ...(identity.selector ? { control: identity.selector } : {}),
                controls: [],
              },
            });
          }
          recorded = true;
          const action = this.actions.at(-1);
          if (action) {
            linkRecording(action, token);
            this.options.filmstrips?.freeze(action);
          }
          await dispose();
        })().catch(async (caught: unknown) => {
          // Recording never fails the capture it observes.
          if (!recorded)
            this.actions.push(
              linkRecording(
                unavailableAction(identity, String(caught), extras()),
                token,
              ),
            );
          await dispose().catch(() => undefined);
        });
        return finishing;
      },
      dispose,
    };
    this.pending.add(handle);
    return handle;
  }

  evidence(reason?: string): ActionTimelineArtifact {
    const actions = [...this.actions];
    const incomplete = actions.filter((action) => action.status !== "ran");
    const reasons = [
      ...new Set([
        ...(reason ? [reason] : []),
        ...(actions.length > TIMELINE_LIMITS.actions
          ? [`timeline truncated: actions beyond ${TIMELINE_LIMITS.actions}`]
          : []),
        ...incomplete.flatMap((action) =>
          action.reason ? [action.reason] : [],
        ),
      ]),
    ];
    const capped = actions.slice(0, TIMELINE_LIMITS.actions);
    return {
      version: 1,
      status:
        actions.length === 0 ||
        actions.every((action) => action.status === "unavailable")
          ? "unavailable"
          : reasons.length
            ? "partial"
            : "ran",
      ...(reasons.length
        ? { reason: reasons.join("; ") }
        : actions.length === 0
          ? { reason: "no recorded actions" }
          : {}),
      limits: { ...TIMELINE_LIMITS },
      truncated: { actions: actions.length - capped.length },
      actions: capped,
    };
  }
}

const sourceRank = {
  load: 0,
  "web-step": 1,
  "probe-click": 2,
  "probe-hover": 2.5,
  "slow-replay": 3,
  "failure-replay": 4,
} as const;
function ordered(actions: ActionTimeline[]): ActionTimeline[] {
  return actions
    .map((action, index) => ({ action, index }))
    .sort(
      (a, b) =>
        sourceRank[a.action.source] - sourceRank[b.action.source] ||
        (a.action.source === "web-step"
          ? (a.action.stepIndex ?? 0) - (b.action.stepIndex ?? 0)
          : 0) ||
        (a.action.source === "slow-replay"
          ? Number(a.action.held?.of === "probe-click") -
              Number(b.action.held?.of === "probe-click") ||
            (a.action.held?.of === "web-step"
              ? (a.action.stepIndex ?? 0) - (b.action.stepIndex ?? 0)
              : 0)
          : 0) ||
        (a.action.source === "failure-replay"
          ? Number(a.action.failure?.of === "probe-click") -
              Number(b.action.failure?.of === "probe-click") ||
            (a.action.stepIndex ?? 0) - (b.action.stepIndex ?? 0)
          : 0) ||
        a.action.startedAt - b.action.startedAt ||
        a.index - b.index,
    )
    .map(({ action }) => action);
}

/** Merge per-attempt artifacts; empty collections never degrade the status. */
export function mergeTimelines(
  ...artifacts: Array<ActionTimelineArtifact | undefined>
): ActionTimelineArtifact | undefined {
  const defined = artifacts.filter(
    (artifact): artifact is ActionTimelineArtifact => artifact !== undefined,
  );
  if (defined.length === 0) return undefined;
  const present = defined.filter((artifact) => artifact.actions.length > 0);
  if (present.length === 0) return defined[0];
  const all = ordered(present.flatMap((artifact) => artifact.actions));
  const actions = all.slice(0, TIMELINE_LIMITS.actions);
  const dropped =
    present.reduce((sum, artifact) => sum + artifact.truncated.actions, 0) +
    all.length -
    actions.length;
  const reasons = [
    ...new Set(present.flatMap((artifact) => artifact.reason ?? [])),
    ...(all.length > actions.length
      ? [`timeline truncated: actions beyond ${TIMELINE_LIMITS.actions}`]
      : []),
  ];
  return {
    version: 1,
    status: present.every((artifact) => artifact.status === "unavailable")
      ? "unavailable"
      : reasons.length || present.some((artifact) => artifact.status !== "ran")
        ? "partial"
        : "ran",
    ...(reasons.length ? { reason: reasons.join("; ") } : {}),
    limits: { ...TIMELINE_LIMITS },
    truncated: { actions: dropped },
    actions,
  };
}

/**
 * Stable ids: "load", "step-<n>", "probe-<n>" numbering probe clicks by
 * start time, then held replays: "slow-step-<n>" for a web step and
 * "slow-probe-<k>" numbering replayed probe clicks by start time. Pure and
 * idempotent; also orders load, steps, probe, then held replays.
 */
export function withTimelineIds(
  artifact: ActionTimelineArtifact | undefined,
): ActionTimelineArtifact | undefined {
  if (artifact === undefined) return undefined;
  let probe = 0;
  let hover = 0;
  let slowProbe = 0;
  let failureProbe = 0;
  const idOf = (action: ActionTimeline): string => {
    switch (action.source) {
      case "load":
        return "load";
      case "web-step":
        return `step-${action.stepIndex ?? 0}`;
      case "probe-hover":
        return `hover-${++hover}`;
      case "probe-click":
        return `probe-${++probe}`;
      case "failure-replay":
        return action.failure?.of === "web-step"
          ? `failure-step-${action.stepIndex ?? 0}`
          : `failure-probe-${++failureProbe}`;
      case "slow-replay":
        return action.held?.of === "web-step"
          ? `slow-step-${action.stepIndex ?? 0}`
          : `slow-probe-${++slowProbe}`;
    }
  };
  return {
    ...artifact,
    actions: ordered(artifact.actions).map((action) =>
      linkRecording(
        {
          ...action,
          id: idOf(action),
        },
        recordingKey(action),
      ),
    ),
  };
}
