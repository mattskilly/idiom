import type { Page, Route } from "playwright";
import type {
  ActionTimeline,
  HeldReplay,
  PendingIndicatorKind,
  ProbeSafetyPolicy,
} from "../checks/types.js";
import { beginEffectWindow } from "./effect-window.js";
import { rememberRequest, requestIdentity } from "./failure-identity.js";
import { type FeedbackWindow, installFeedback } from "./feedback.js";
import { ignoredRequest, probeRequestAllowed } from "./request-policy.js";
import type { TimelineCollector } from "./timeline.js";

/** The one coverage note for an action that submits by document navigation. */
export const NAVIGATION_NOTE = "main-frame document navigation";
const contextGone =
  /Execution context was destroyed|Cannot find context with specified id/;
/** Held replays per probed state; each costs a restore plus the hold. */
export const MAX_HELD_REPLAYS = 6;
/** Mutations while idle before the action mark a subtree as noisy. */
const NOISE_SAMPLE_MS = 250;
const MAX_HELD_REQUESTS = 60;

type WatcherConfig = { token: string; selector: string; action: string };
type Indicator = HeldReplay["indicators"][number];
type Change = { time: number; selector: string };
/** What the page reports; times are ms since dispatch on the page clock. */
type PendingFacts = {
  dispatched: boolean;
  classificationDeadline: number | null;
  elapsed: number | null;
  indicators: Indicator[];
  firstChange: Change | null;
  firstMainChange: Change | null;
  changeAfterReleaseAt: number | null;
  mainChangeAfterReleaseAt: number | null;
  mainSelector: string;
  mainEmpty: { from: number; to: number | null } | null;
  routeChange: { from: string; to: string; time: number } | null;
  trigger: { connected: boolean; enabled: boolean };
};
type PendingWindow = Window & {
  __idiomPending?: {
    token: string;
    bind(element: Element): void;
    freeze(): void;
    released(): number | null;
    retain(): number | null;
    read(cutoff?: number): PendingFacts;
    dispose(): void;
  };
};

type NoiseWindow = Window & {
  __idiomNoiseLog?: {
    periodic(anchors?: number[]): Element[];
    provisional(anchors?: number[]): Array<{ root: Element; deadline: number }>;
  };
};

/**
 * Init script for held-replay pages: from document start, records batches of
 * mutations and trusted input times, and reports the subtrees that change on
 * a regular period on their own, such as tickers and autoplaying carousels
 * slower than the pending watcher's noise sample. Serializable; it only
 * observes.
 */
export function installNoiseRecorder(): void {
  const scope = window as NoiseWindow;
  if (scope.__idiomNoiseLog) return;
  const BATCH_GAP_MS = 100;
  const MIN_PERIOD_MS = 250;
  const MAX_BATCHES = 200;
  const MAX_ROOTS = 50;
  const MAX_TARGETS = 20;
  type Batch = { time: number; root: Element; targets: Element[] };
  const batches: Batch[] = [];
  const roots = new Set<Element>();
  const inputs: number[] = [];
  const pending = new Map<
    Element,
    { start: number; last: number; targets: Set<Element> }
  >();
  for (const type of ["pointerdown", "keydown", "input"])
    window.addEventListener(
      type,
      (event) => {
        if (!event.isTrusted) return;
        inputs.push(performance.now());
        if (inputs.length > 20) inputs.shift();
      },
      true,
    );
  const ancestors = (element: Element) => {
    const chain: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement)
      chain.push(node);
    return chain;
  };
  const commonAncestor = (targets: Element[]): Element | null => {
    const [first, ...rest] = targets;
    if (!first) return null;
    let chain = ancestors(first);
    for (const target of rest) {
      const own = new Set(ancestors(target));
      chain = chain.filter((element) => own.has(element));
    }
    return chain[0] ?? null;
  };
  const flush = (now: number) => {
    for (const [root, batch] of pending) {
      if (now - batch.last <= BATCH_GAP_MS) continue;
      pending.delete(root);
      if (!root.isConnected) continue;
      batches.push({
        time: batch.start,
        root,
        targets: [...batch.targets].filter((target) => target.isConnected),
      });
    }
    // Pending and completed batches share one storage budget.
    while (batches.length + pending.size > MAX_BATCHES) batches.shift();
  };
  const observer = new MutationObserver((records) => {
    // Initial HTML construction is not a sample of a running mutation stream.
    if (document.readyState === "loading") return;
    const now = performance.now();
    flush(now);
    const connected = records.flatMap((record) => {
      const element =
        record.target instanceof Element
          ? record.target
          : record.target.parentElement;
      return element?.isConnected ? [element] : [];
    });
    // Find the delivery's actual root before truncating its retained targets.
    const root = commonAncestor(connected);
    if (root === null) return;
    if (!roots.has(root)) {
      if (roots.size >= MAX_ROOTS) return;
      roots.add(root);
    }
    let batch = pending.get(root);
    if (!batch) {
      batch = { start: now, last: now, targets: new Set() };
      pending.set(root, batch);
    }
    batch.last = now;
    for (const target of connected) {
      if (batch.targets.size >= MAX_TARGETS) break;
      batch.targets.add(target);
    }
    while (batches.length + pending.size > MAX_BATCHES) batches.shift();
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  /** The period of the first run of three batches with regular gaps. */
  const period = (times: number[]): { from: number; ms: number } | null => {
    for (let index = 2; index < times.length; index++) {
      const start = times[index - 2] ?? 0;
      const a = (times[index - 1] ?? 0) - start;
      const b = (times[index] ?? 0) - (times[index - 1] ?? 0);
      if (
        a >= MIN_PERIOD_MS &&
        b >= MIN_PERIOD_MS &&
        Math.max(a, b) <= 1.33 * Math.min(a, b)
      )
        return { from: start, ms: (a + b) / 2 };
    }
    return null;
  };
  // A timer the page started in response to input (or to a response) ticks
  // in phase with it. A subtree that first changed after such an anchor, in
  // phase with it, is the action's own doing, not noise.
  const caused = (times: number[], ms: number, anchors: number[]) => {
    const tolerance = Math.max(60, 0.12 * ms);
    return anchors.some((anchor) => {
      const first = times.find((time) => time >= anchor);
      if (first === undefined || times.some((time) => time < anchor))
        return false;
      const phase = (first - anchor) % ms;
      return phase <= tolerance || ms - phase <= tolerance;
    });
  };
  const broad = (element: Element) =>
    element === document.documentElement ||
    element === document.body ||
    element.matches("main, [role=main]");
  scope.__idiomNoiseLog = {
    periodic: (extra = []) => {
      flush(performance.now());
      const anchors = [...inputs, ...extra];
      // Each batch belongs to the lowest element containing all its changes;
      // a root's own batches decide, so a ticker inside an app shell never
      // makes the shell periodic, and the action's own updates nested in an
      // older subtree are not mixed with it.
      const periodic = [...roots].filter((root) => {
        const times = batches
          .filter((batch) => batch.root === root)
          .map((batch) => batch.time);
        const found = period(times);
        return found !== null && !caused(times, found.ms, anchors);
      });
      return periodic.flatMap((root) =>
        broad(root)
          ? batches
              .filter((batch) => batch.root === root)
              .flatMap((batch) => batch.targets)
              .filter((target) => !broad(target))
          : [root],
      );
    },
    provisional: (extra = []) => {
      const now = performance.now();
      flush(now);
      const anchors = [...inputs, ...extra];
      return [...roots].flatMap((root) => {
        if (!root.isConnected || broad(root)) return [];
        const times = batches
          .filter((batch) => batch.root === root)
          .map((batch) => batch.time);
        const open = pending.get(root);
        if (open) times.push(open.start);
        // A completed run is already classified, including action-caused runs.
        const found = period(times);
        if (found !== null) {
          if (!open || caused(times, found.ms, anchors)) return [];
          // A third sample in an open batch is not yet in periodic(). Keep
          // observing until that same batch closes, without double counting it.
          const completed = times.slice(0, -1);
          return period(completed) === null
            ? [{ root, deadline: open.last + BATCH_GAP_MS + 1 }]
            : [];
        }
        if (times.length < 2) return [];
        const last = times[times.length - 1] ?? 0;
        const gap = last - (times[times.length - 2] ?? 0);
        if (gap < MIN_PERIOD_MS || caused(times, gap, anchors)) return [];
        // The next sample can arrive within the existing regularity tolerance;
        // allow its batch to close. Never renew an expired opportunity.
        const deadline = last + gap * 1.33 + BATCH_GAP_MS + 1;
        return deadline > now ? [{ root, deadline }] : [];
      });
    },
  };
}

/**
 * The in-page pending watcher. Serializable: it closes over nothing in this
 * module. Shared feedback predicates are installed in the document first.
 * Before the action it samples which subtrees mutate on their own; it arms
 * on the action's dispatch at the trigger and records, relative to it, what
 * the user could see while the action's requests were held. It only
 * observes; it never changes the document.
 */
function pendingWatcher(config: WatcherConfig): void {
  type Kind = PendingIndicatorKind;
  const scope = window as PendingWindow;
  scope.__idiomPending?.dispose();
  const { action, selector } = config;
  let startedAt: number | null = null;
  let frozen = false;
  let releasedAt: number | null = null;
  const since = () => (startedAt === null ? 0 : performance.now() - startedAt);

  const {
    rendered,
    selectorFor,
    normalize,
    textOf,
    progressText,
    skeletal,
    mainOf,
    actionEvents: eventsFor,
    dispatchTarget,
    animationTarget,
    indicatorBaseline,
    scanIndicators,
    addedProgressText,
    noiseSet,
    structuralNoise,
  } = (window as unknown as FeedbackWindow).__idiomFeedback;
  const transient =
    /^(?:data-(?:focus|hover|press|active|focus-visible)[\w-]*|tabindex)$/;
  const tooltipish = (element: Element) =>
    element.closest("[role=tooltip], [data-radix-popper-content-wrapper]") !==
    null;
  const elementOf = (node: Node | null): Element | null =>
    node === null ? null : node instanceof Element ? node : node.parentElement;

  // Noise: subtrees that mutate or animate while nobody acts (tickers,
  // carousels, clocks). Their later changes are not feedback.
  const noisy = noiseSet();
  const isNoisy = noisy.has;
  // Carousels and tickers: marked by general patterns, or seen changing on a
  // regular period since the page loaded (slower than the sample below).
  for (const element of structuralNoise()) noisy.add(element);
  for (const element of (window as NoiseWindow).__idiomNoiseLog?.periodic() ??
    [])
    noisy.add(element);

  let mainElement: Element | null = mainOf();
  const mainSelectorOf = (element: Element | null) =>
    element === null || element === document.body
      ? "body"
      : element.matches("main")
        ? "main"
        : "[role=main]";
  const empty = (element: Element | null) => {
    if (element === null || !element.isConnected) return true;
    if (
      normalize(
        element instanceof HTMLElement
          ? element.innerText
          : element.textContent,
      ) !== ""
    )
      return false;
    for (const media of element.querySelectorAll(
      "img, svg, canvas, video, picture, iframe, input, select, textarea, button",
    ))
      if (rendered(media)) return false;
    return true;
  };
  const inMain = (element: Element) =>
    mainElement === null ||
    mainElement === document.body ||
    mainElement.contains(element);

  let trigger: Element | null = null;
  try {
    trigger = document.querySelector(selector);
  } catch {
    // Playwright-only selectors are bound from the locator.
  }
  const triggerFlags = () => ({
    disabled:
      trigger !== null &&
      ((trigger as HTMLButtonElement).disabled === true ||
        trigger.getAttribute("aria-disabled") === "true"),
    busy: trigger?.getAttribute("aria-busy") === "true",
    pressed: trigger?.getAttribute("aria-pressed") === "true",
  });
  let triggerAtArm = triggerFlags();
  let triggerText = trigger ? textOf(trigger) : "";
  let baseline: ReturnType<typeof indicatorBaseline> = {
    progress: new WeakSet(),
    animations: new WeakSet(),
    status: new WeakMap(),
  };

  const route = () =>
    location.pathname + (location.hash.startsWith("#/") ? location.hash : "");
  let routeFrom = route();
  let routeChange: PendingFacts["routeChange"] = null;
  const onRoute = () => {
    if (startedAt === null || routeChange !== null) return;
    const to = route();
    if (to !== routeFrom) routeChange = { from: routeFrom, to, time: since() };
  };
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  history.pushState = function (...args: Parameters<History["pushState"]>) {
    const result = originalPush.apply(this, args);
    onRoute();
    return result;
  };
  history.replaceState = function (
    ...args: Parameters<History["replaceState"]>
  ) {
    const result = originalReplace.apply(this, args);
    onRoute();
    return result;
  };
  window.addEventListener("popstate", onRoute);
  window.addEventListener("hashchange", onRoute);

  // Indicators and changes are chosen when read: a slow ticker is only
  // recognisable as periodic once it has rotated a few times, by which time
  // its first rotation may already have looked like feedback. Kinds the noise
  // filter applies to keep a few elements each, in the order seen.
  const filterable = new Set<Kind>(["spinner", "status-text", "progress-text"]);
  const candidates: Array<{ element: Element; indicator: Indicator }> = [];
  const record = (kind: Kind, element: Element, text?: string) => {
    if (startedAt === null) return false;
    const same = candidates.filter(
      (candidate) => candidate.indicator.kind === kind,
    );
    if (
      same.length >= (filterable.has(kind) ? 5 : 1) ||
      same.some((candidate) => candidate.element === element)
    )
      return false;
    const label = (text ?? textOf(element)).slice(0, 80);
    candidates.push({
      element,
      indicator: {
        kind,
        selector: selectorFor(element),
        time: since(),
        ...(label ? { text: label } : {}),
        inMain: inMain(element),
        progressText: progressText(label),
      },
    });
    return false;
  };
  type Seen = Change & { element: Element; main: boolean };
  const early: Seen[] = [];
  const late: Seen[] = [];
  let retained: { candidates: number; early: number; late: number } | undefined;
  const MAX_CHANGES = 50;
  const keep = (list: Seen[], entry: Seen) => {
    if (
      list.length < MAX_CHANGES ||
      (entry.main && list.filter((seen) => seen.main).length < MAX_CHANGES)
    )
      list.push(entry);
  };
  /** Subtrees seen changing on a regular period of their own by now. */
  const periodicNoise = () => {
    const anchors =
      startedAt !== null && releasedAt !== null ? [startedAt + releasedAt] : [];
    const noise = new Set(
      (window as NoiseWindow).__idiomNoiseLog?.periodic(anchors) ?? [],
    );
    const provisional =
      (window as NoiseWindow).__idiomNoiseLog?.provisional(anchors) ?? [];
    const has = (element: Element) => {
      if (noise.size === 0) return false;
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      )
        if (noise.has(current)) return true;
      return false;
    };
    return { has, provisional };
  };
  let mainEmpty: PendingFacts["mainEmpty"] = null;

  // Prior visibility belongs to this action, not to a currently visible
  // parent. Sample before application handlers and refresh only affected
  // subtrees after each batch. Bound work and retained state on large pages.
  const visibilityLimit = 10_000;
  const priorRendered = new Map<Element, boolean>();
  const rememberVisibility = (root: Element) => {
    const remember = (element: Element) => {
      if (priorRendered.has(element) || priorRendered.size < visibilityLimit)
        priorRendered.set(element, rendered(element));
    };
    remember(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let count = 0;
    while (count++ < visibilityLimit) {
      const element = walker.nextNode();
      if (!(element instanceof Element)) break;
      remember(element);
    }
  };

  const scan = () => {
    if (startedAt === null) return;
    scanIndicators(baseline, {
      trigger,
      triggerText,
      skipTrigger: true,
      rebusyBaseline: false,
      isNoisy,
      onTrigger: (trigger) => {
        const flags = triggerFlags();
        if (flags.disabled && !triggerAtArm.disabled)
          record("trigger-disabled", trigger);
        if (flags.busy && !triggerAtArm.busy) record("trigger-busy", trigger);
        if (flags.pressed && !triggerAtArm.pressed)
          record("trigger-pressed", trigger);
      },
      visit: record,
    });
  };

  const changed = (record: MutationRecord): Element | null => {
    const element = elementOf(record.target);
    if (element === null || tooltipish(element)) return null;
    if (record.type === "attributes") {
      const name = record.attributeName ?? "";
      if (transient.test(name)) return null;
      if (record.oldValue === element.getAttribute(name)) return null;
      return rendered(element) || priorRendered.get(element) === true
        ? element
        : null;
    }
    if (record.type === "characterData")
      return rendered(element) &&
        normalize(record.target.textContent) !== normalize(record.oldValue)
        ? element
        : null;
    if (!rendered(element)) return null;
    for (const node of record.addedNodes) {
      if (node instanceof Element) {
        if (rendered(node)) return node;
      } else if (normalize(node.textContent) !== "") return element;
    }
    for (const node of record.removedNodes)
      if (
        node instanceof Element
          ? priorRendered.get(node) === true
          : normalize(node.textContent) !== ""
      )
        return element;
    return null;
  };
  const onMutations = (records: MutationRecord[]) => {
    if (startedAt === null) {
      if (frozen) return;
      noisy.markRecords(records, [document.body]);
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element)
            for (const element of structuralNoise(node)) noisy.add(element);
      return;
    }
    const time = since();
    const current = mainOf();
    const replaced = current !== mainElement;
    mainElement = current;
    const isEmpty = empty(mainElement);
    if (isEmpty && mainEmpty === null) mainEmpty = { from: time, to: null };
    else if (!isEmpty && mainEmpty !== null && mainEmpty.to === null)
      mainEmpty.to = time;
    for (const mutation of records) {
      // Indicators carried by the mutation itself.
      addedProgressText(
        [mutation],
        (kind, element, text) =>
          !isNoisy(element) && record(kind, element, text),
        (node) => {
          if (node instanceof Element)
            for (const candidate of [
              node,
              ...[...node.querySelectorAll("*")].slice(0, 50),
            ])
              if (skeletal(candidate) && rendered(candidate)) {
                record("skeleton", candidate);
                break;
              }
        },
      );
      // Visible content change.
      const element = changed(mutation);
      if (element === null || isNoisy(element)) continue;
      if (isEmpty) continue;
      const selector = selectorFor(element);
      const mainReplaced =
        replaced &&
        [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) =>
            node instanceof Element && node.matches("main, [role=main]"),
        );
      const main =
        (inMain(element) || mainReplaced) &&
        !(
          trigger !== null &&
          (trigger === element || trigger.contains(element))
        );
      keep(releasedAt !== null && time >= releasedAt ? late : early, {
        time,
        selector,
        element,
        main,
      });
    }
    // Keep the previous batch intact while classifying every record. An
    // ancestor's class/style change can also hide or reveal descendants.
    for (const mutation of records) {
      const element = elementOf(mutation.target);
      if (element) rememberVisibility(element);
    }
    for (const element of priorRendered.keys())
      if (!element.isConnected) priorRendered.delete(element);
    scan();
  };
  const observer = new MutationObserver(onMutations);
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
  });
  // Finite animations running while idle are noise too.
  const noiseAnimations = setInterval(() => {
    if (startedAt !== null || frozen) return;
    for (const animation of document.getAnimations()) {
      const target = animationTarget(animation);
      if (target && animation.playState === "running") noisy.add(target);
    }
  }, 50);
  const interval = setInterval(scan, 50);

  const actionEvents = eventsFor(action);
  const onAction = (event: Event) => {
    if (
      startedAt !== null ||
      ((action === "click" || action === "press") && !event.isTrusted)
    )
      return;
    const target = dispatchTarget(event, trigger, selector, action);
    if (!target) return;
    onMutations(observer.takeRecords());
    startedAt = performance.now();
    trigger = target;
    // Rebaseline at dispatch, before the application's own handlers run.
    rememberVisibility(document.documentElement);
    baseline = indicatorBaseline({ visibleAnimationsOnly: false });
    triggerText = textOf(target);
    triggerAtArm = triggerFlags();
    mainElement = mainOf();
    routeFrom = route();
    if (empty(mainElement)) mainEmpty = { from: 0, to: null };
    for (const type of actionEvents)
      window.removeEventListener(type, onAction, true);
  };
  for (const type of actionEvents)
    window.addEventListener(type, onAction, true);

  const settled = (noise: (element: Element) => boolean, cutoff = Infinity) => {
    const indicators: Indicator[] = [];
    const kinds = new Set<Kind>();
    for (const { element, indicator } of candidates.slice(
      0,
      retained?.candidates,
    )) {
      if (
        indicator.time > cutoff ||
        kinds.has(indicator.kind) ||
        indicators.length >= 12
      )
        continue;
      if (filterable.has(indicator.kind) && noise(element)) continue;
      kinds.add(indicator.kind);
      indicators.push(indicator);
    }
    const change = (seen: Seen | undefined): Change | null =>
      seen ? { time: seen.time, selector: seen.selector } : null;
    const quiet = [
      ...early.slice(0, retained?.early),
      ...late.slice(0, retained?.late),
    ].filter(({ element, time }) => time <= cutoff && !noise(element));
    const after = late.filter(({ element }) => !noise(element));
    return {
      indicators,
      firstChange: change(quiet[0]),
      firstMainChange: change(quiet.find(({ main }) => main)),
      changeAfterReleaseAt: after[0]?.time ?? null,
      mainChangeAfterReleaseAt: after.find(({ main }) => main)?.time ?? null,
    };
  };
  scope.__idiomPending = {
    token: config.token,
    bind: (element) => {
      if (startedAt === null) {
        trigger = element;
        triggerText = textOf(element);
        triggerAtArm = triggerFlags();
      }
    },
    freeze: () => {
      onMutations(observer.takeRecords());
      frozen = true;
    },
    released: () => {
      if (startedAt === null) return null;
      onMutations(observer.takeRecords());
      const time = since();
      releasedAt ??= time;
      return time;
    },
    retain: () => {
      onMutations(observer.takeRecords());
      scan();
      // Counts also distinguish deliveries at the same page-clock timestamp.
      retained = {
        candidates: candidates.length,
        early: early.length,
        late: late.length,
      };
      return startedAt === null ? null : since();
    },
    read: (cutoff = Infinity) => {
      onMutations(observer.takeRecords());
      scan();
      const element = trigger;
      const noise = periodicNoise();
      const relevant = [
        ...early.slice(0, retained?.early).filter(({ time }) => time <= cutoff),
        ...late.slice(0, retained?.late).filter(({ time }) => time <= cutoff),
        ...candidates
          .slice(0, retained?.candidates)
          .filter(
            ({ indicator }) =>
              indicator.time <= cutoff && filterable.has(indicator.kind),
          ),
      ];
      const deadlines = noise.provisional
        .filter(({ root }) =>
          relevant.some(
            ({ element }) =>
              !isNoisy(element) &&
              !noise.has(element) &&
              root.contains(element),
          ),
        )
        .map(({ deadline }) => deadline);
      return {
        dispatched: startedAt !== null,
        elapsed: startedAt === null ? null : since(),
        ...settled(noise.has, cutoff),
        classificationDeadline: deadlines.length
          ? Math.min(...deadlines)
          : null,
        mainSelector: mainSelectorOf(mainElement),
        mainEmpty: mainEmpty === null ? null : { ...mainEmpty },
        routeChange,
        trigger: {
          connected: element?.isConnected === true,
          enabled:
            element?.isConnected === true &&
            rendered(element) &&
            !triggerFlags().disabled &&
            element.closest("[inert]") === null,
        },
      };
    },
    dispose: () => {
      observer.disconnect();
      clearInterval(interval);
      clearInterval(noiseAnimations);
      for (const type of actionEvents)
        window.removeEventListener(type, onAction, true);
      window.removeEventListener("popstate", onRoute);
      window.removeEventListener("hashchange", onRoute);
      if (history.pushState !== originalPush) history.pushState = originalPush;
      if (history.replaceState !== originalReplace)
        history.replaceState = originalReplace;
      if (scope.__idiomPending?.token === config.token)
        delete scope.__idiomPending;
    },
  };
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const heldTypes = new Set(["fetch", "xhr", "document"]);

/** Registrable domain, approximately: the last two labels; IPs exactly. */
function site(host: string): string {
  if (/^\d+(?:\.\d+){3}$/.test(host) || host.startsWith("[")) return host;
  if (!host.includes(".")) return host;
  return host.split(".").slice(-2).join(".");
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? "";
  }
}

type HeldRequest = HeldReplay["requests"][number];

/**
 * Holds the action's same-site fetch/XHR requests (and a main-frame
 * navigation) for `delayMs`. Registered on the page after the probe's guard,
 * so it runs first. It never sends anything itself: every request goes on
 * to the guard with `route.fallback()`, which forwards safe requests and
 * aborts the rest exactly as it does for any probe click.
 */
export async function createHoldRoute(
  page: Page,
  options: {
    delayMs: number;
    policy: ProbeSafetyPolicy;
    clock: () => number;
    /** Posts a release into the page; returns the page-clock release time. */
    release: () => Promise<number | null>;
  },
) {
  const { delayMs, clock } = options;
  let active = false;
  let begun = 0;
  let capEnd = Number.POSITIVE_INFINITY;
  let duplicatesArmed = false;
  const requests: HeldRequest[] = [];
  const duplicates: HeldReplay["secondActivation"]["duplicates"] = [];
  const holding = new Map<
    HeldRequest,
    { release: () => void; nonSafe: boolean }
  >();
  let site0 = "";
  try {
    site0 = site(new URL(page.url()).hostname);
  } catch {
    // An opaque page holds nothing cross-site.
  }
  const sameSite = (url: string) => {
    try {
      return site(new URL(url).hostname) === site0;
    } catch {
      return false;
    }
  };
  const handler = async (route: Route) => {
    const request = route.request();
    const pass = () => route.fallback().catch(() => undefined);
    if (!active) return pass();
    const type = request.resourceType();
    if (!heldTypes.has(type) || ignoredRequest(request)) return pass();
    let navigation = false;
    if (type === "document") {
      try {
        navigation =
          request.isNavigationRequest() &&
          request.frame().parentFrame() === null;
      } catch {
        navigation = false;
      }
      if (!navigation) return pass();
    } else if (!sameSite(request.url())) return pass();
    const method = request.method().toUpperCase();
    const path = pathOf(request.url());
    const nonSafe = !safeMethods.has(method);
    if (
      duplicatesArmed &&
      nonSafe &&
      [...holding].some(
        ([held, state]) =>
          state.nonSafe && held.method === method && held.path === path,
      )
    ) {
      // The guard aborts it: a duplicate is observed, never sent.
      duplicates.push({ method, path, time: clock() - begun });
      return pass();
    }
    if (requests.length >= MAX_HELD_REQUESTS) return pass();
    const record: HeldRequest = {
      method,
      path,
      resourceType: type,
      startTime: clock() - begun,
      releasedAt: null,
      forwarded: probeRequestAllowed(request, options.policy),
      navigation,
    };
    if (type === "fetch" || type === "xhr")
      rememberRequest(record, {
        method,
        url: request.url(),
        resourceType: type,
      });
    requests.push(record);
    const wait = Math.max(0, Math.min(delayMs, capEnd - clock()));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      holding.set(record, {
        nonSafe,
        release: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
    holding.delete(record);
    // A held navigation is released without an in-page mark: evaluating in
    // a document whose navigation is pending can wait on that navigation.
    if (!navigation)
      record.releasedAt = await Promise.race([
        options.release().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);
    return pass();
  };
  await page.route("**/*", handler);
  return {
    requests,
    duplicates,
    /** Requests from here on are the action's. */
    markActionStarted() {
      begun = clock();
      capEnd = begun + 3 * delayMs;
      active = true;
    },
    /** Same-method, same-path non-safe requests from now on are duplicates. */
    armDuplicates() {
      duplicatesArmed = true;
    },
    since: () => clock() - begun,
    pendingNonSafe: () => [...holding.values()].some((state) => state.nonSafe),
    /** Wait for every hold, including chained ones, bounded by the cap. */
    async waitReleased(page: Page) {
      for (;;) {
        while (holding.size > 0 && clock() < capEnd + 250)
          await page.waitForTimeout(25);
        // Chained requests start shortly after a response arrives.
        await page.waitForTimeout(100);
        if (holding.size === 0 || clock() >= capEnd + 250) break;
      }
      active = false;
    },
    async dispose() {
      active = false;
      for (const state of holding.values()) state.release();
      await page.unroute("**/*", handler).catch(() => undefined);
    },
  };
}

export type HeldItem = {
  of: HeldReplay["of"];
  kind: "click" | "fill" | "press" | "select";
  /** CSS or Playwright selector of the trigger. */
  selector: string;
  name: string;
  stepIndex?: number | undefined;
  /** Anything before the action that is not part of it (a hover). */
  prepare?: ((page: Page) => Promise<void>) | undefined;
  perform(page: Page): Promise<void>;
  /** The same activation again, bounded by `timeoutMs`. */
  repeat?: ((page: Page, timeoutMs: number) => Promise<void>) | undefined;
};

/**
 * Replay one action with its requests held and record what the user sees
 * while they wait, as a `slow-replay` action timeline.
 */
export async function replayHeld(options: {
  /** The (deadline-bound) page the action runs on. */
  page: Page;
  /** The real page, where the hold route is registered. */
  routePage: Page;
  item: HeldItem;
  delayMs: number;
  withinMs: number;
  waitMs: number;
  policy: ProbeSafetyPolicy;
  timeline: TimelineCollector;
  clock: () => number;
}): Promise<void> {
  const { page, item, delayMs, withinMs, clock } = options;
  const token = `${Date.now()}:${Math.random()}`;
  const held: HeldReplay = {
    of: item.of,
    delayMs,
    withinMs,
    dispatched: false,
    requests: [],
    releasedAt: null,
    indicator: null,
    indicators: [],
    firstChange: null,
    firstMainChange: null,
    changedAfterRelease: false,
    changeAfterReleaseAt: null,
    mainChangedAfterRelease: false,
    mainChangeAfterReleaseAt: null,
    mainSelector: "body",
    mainEmpty: null,
    routeChange: null,
    trigger: { checkedAt: null, enabled: null },
    secondActivation: { attempted: false, duplicates: [] },
    notes: [],
  };
  let hold: Awaited<ReturnType<typeof createHoldRoute>> | undefined;
  /** The action submitted by main-frame document navigation. */
  const navigated = () =>
    hold?.requests.some((request) => request.navigation) === true;
  /** Retain the first activation's candidates while allowing later classification. */
  let candidateCutoff: number | undefined;
  const read = () =>
    page
      .evaluate(
        ({ token, cutoff }) => {
          const active = (window as PendingWindow).__idiomPending;
          return active?.token === token ? active.read(cutoff) : null;
        },
        { token, cutoff: candidateCutoff },
      )
      .catch((error: unknown) => {
        if (contextGone.test(String(error)) && navigated()) return null;
        throw error;
      });
  /** Feedback seen up to the second activation; later feedback is its own. */
  let before: PendingFacts | null = null;
  const apply = (latest: PendingFacts | null) => {
    if (latest === null) return;
    const facts: PendingFacts = before
      ? {
          ...latest,
          dispatched: before.dispatched,
        }
      : latest;
    held.dispatched = facts.dispatched;
    held.indicators = facts.indicators;
    held.indicator =
      [...facts.indicators]
        .sort((a, b) => a.time - b.time)
        .map(({ inMain: _inMain, progressText: _progress, ...rest }) => rest)
        .at(0) ?? null;
    held.firstChange = facts.firstChange;
    held.firstMainChange = facts.firstMainChange;
    held.changeAfterReleaseAt = facts.changeAfterReleaseAt;
    held.changedAfterRelease = facts.changeAfterReleaseAt !== null;
    held.mainChangeAfterReleaseAt = facts.mainChangeAfterReleaseAt;
    held.mainChangedAfterRelease = facts.mainChangeAfterReleaseAt !== null;
    held.mainSelector = facts.mainSelector;
    held.mainEmpty = facts.mainEmpty;
    held.routeChange = facts.routeChange;
  };
  const snapshot = (): { held: HeldReplay } => {
    const copy = JSON.parse(JSON.stringify(held)) as HeldReplay;
    for (const [index, record] of copy.requests.entries()) {
      const source = held.requests[index];
      const identity = source && requestIdentity(source);
      if (identity) rememberRequest(record, identity);
    }
    return { held: copy };
  };
  await item.prepare?.(page);
  const handle = await options.timeline.start(
    {
      source: "slow-replay",
      kind: item.kind,
      selector: item.selector,
      name: item.name,
      ...(item.stepIndex === undefined ? {} : { stepIndex: item.stepIndex }),
    },
    snapshot,
  );
  try {
    await page.evaluate(installFeedback);
    await page.evaluate(pendingWatcher, {
      token,
      selector: item.selector,
      action: item.kind,
    });
    await page
      .locator(item.selector)
      .first()
      .evaluate(
        (element, token) => {
          const active = (window as PendingWindow).__idiomPending;
          if (active?.token === token) active.bind(element);
        },
        token,
        { timeout: 1500 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(NOISE_SAMPLE_MS);
    await page.evaluate((token) => {
      const active = (window as PendingWindow).__idiomPending;
      if (active?.token === token) active.freeze();
    }, token);
    hold = await createHoldRoute(options.routePage, {
      delayMs,
      policy: options.policy,
      clock,
      release: () =>
        options.routePage.evaluate((token) => {
          const active = (window as PendingWindow).__idiomPending;
          return active?.token === token ? active.released() : null;
        }, token),
    });
    held.requests = hold.requests;
    held.secondActivation.duplicates = hold.duplicates;
    hold.markActionStarted();
    await item.perform(page);
    let facts = await read();
    if (facts?.elapsed != null && facts.elapsed < withinMs)
      await page.waitForTimeout(Math.ceil(withinMs - facts.elapsed) + 5);
    else if (facts?.elapsed == null)
      await page.waitForTimeout(Math.max(0, withinMs - hold.since()));
    facts = await read();
    // The document that watched the action is gone: there is nothing in-page
    // to judge, and the browser shows its own progress. Say so once.
    if (facts === null && navigated()) {
      held.notes.push(NAVIGATION_NOTE);
      await handle.finish(undefined, false);
      return;
    }
    apply(facts);
    if (facts?.dispatched !== true)
      held.notes.push("action dispatch was not observed at the trigger");
    held.trigger = {
      checkedAt: facts?.elapsed ?? null,
      enabled: facts?.trigger.enabled ?? null,
    };
    const repeatable =
      (item.kind === "click" || item.kind === "press") &&
      item.repeat !== undefined;
    if (repeatable && hold.pendingNonSafe()) {
      if (facts?.trigger.enabled === true) {
        before = facts;
        candidateCutoff =
          (await page.evaluate((token) => {
            const active = (window as PendingWindow).__idiomPending;
            return active?.token === token ? active.retain() : null;
          }, token)) ??
          facts.elapsed ??
          undefined;
        held.notes.push(
          "feedback after the second activation is attributed to it, not recorded",
        );
        hold.armDuplicates();
        const at = hold.since();
        try {
          await item.repeat?.(page, 300);
          held.secondActivation = {
            ...held.secondActivation,
            attempted: true,
            at,
          };
          const until = clock() + 500;
          while (
            hold.duplicates.length === 0 &&
            hold.pendingNonSafe() &&
            clock() < until
          )
            await page.waitForTimeout(25);
        } catch (error) {
          held.secondActivation = {
            ...held.secondActivation,
            attempted: false,
            reason: `second activation failed: ${String(error).split("\n")[0]}`,
          };
        }
      } else
        held.secondActivation = {
          ...held.secondActivation,
          reason: "trigger not enabled while the request was pending",
        };
    }
    await hold.waitReleased(page);
    const releases = hold.requests
      .map((request) => request.releasedAt)
      .filter((value): value is number => value !== null);
    held.releasedAt = releases.length ? Math.min(...releases) : null;
    const observationEnd = clock() + Math.max(delayMs, 1000);
    const effectWindow = await beginEffectWindow(
      page,
      Math.max(0, observationEnd - clock()),
      { cleanupPage: options.routePage },
    );
    let settled = false;
    try {
      settled = await effectWindow.wait();
    } finally {
      await effectWindow.dispose();
    }
    let final = await read();
    // Finish only relevant provisional histories inside the original effect
    // budget. The request hold and the enclosing page deadline remain intact.
    while (
      final?.classificationDeadline !== null &&
      final !== null &&
      clock() < observationEnd
    ) {
      await page.waitForTimeout(Math.min(25, observationEnd - clock()));
      final = await read();
    }
    apply(final);
    await handle.finish(undefined, settled);
  } catch (error) {
    held.notes.push(`held replay failed: ${String(error).split("\n")[0]}`);
    apply(await read().catch(() => null));
    await handle.finish("held replay interrupted", false);
    throw error;
  } finally {
    await hold?.dispose();
    await options.routePage
      .evaluate((token) => {
        const active = (window as PendingWindow).__idiomPending;
        if (active?.token === token) active.dispose();
      }, token)
      .catch(() => undefined);
    await handle.finish("held replay interrupted", false);
    await handle.finishVisual();
    await handle.dispose();
  }
}

/**
 * The web steps a held replay replays: the step's recorded action sent
 * requests a hold can hold, and the step is a click, fill, press or select.
 */
export function heldStepIndexes(
  actions: readonly ActionTimeline[],
  steps: readonly { action: string }[],
): number[] {
  return actions.flatMap((action) => {
    if (action.source !== "web-step" || action.stepIndex === undefined)
      return [];
    if (!heldCandidate(action.requests)) return [];
    const step = steps[action.stepIndex - 1];
    return step && ["click", "fill", "press", "select"].includes(step.action)
      ? [action.stepIndex]
      : [];
  });
}

/** One web step's held replay: the steps through it, from the same URL. */
export function replayKey(
  navigationUrl: string,
  steps: readonly unknown[],
  stepIndex: number,
): string {
  return `${navigationUrl}\0${JSON.stringify(steps.slice(0, stepIndex))}`;
}

/** Whether a recorded action sent requests a held replay can hold. */
export function heldCandidate(
  requests: ReadonlyArray<{ resourceType: string }>,
): boolean {
  return requests.some((request) => heldTypes.has(request.resourceType));
}
