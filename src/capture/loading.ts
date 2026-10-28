import type { Page, Route } from "playwright";
import type {
  HeldReplay,
  PendingIndicatorKind,
  ProbeSafetyPolicy,
} from "../checks/types.js";
import { beginEffectWindow } from "./effect-window.js";
import { rememberRequest, requestIdentity } from "./failure-identity.js";
import { type FeedbackWindow, installFeedback } from "./feedback.js";
import { ignoredRequest, probeRequestAllowed } from "./request-policy.js";
import type { TimelineCollector } from "./timeline.js";

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
    read(): PendingFacts;
    dispose(): void;
  };
};

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
    progressSelector,
    statusSelector,
    progressText,
    skeletal,
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
  const noisy = new Set<Element>();
  const isNoisy = (element: Element) => {
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    )
      if (noisy.has(current)) return true;
    return false;
  };

  const mainOf = () =>
    document.querySelector("main, [role=main]") ?? document.body;
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
  let progressBaseline = new WeakSet<Element>();
  let animationBaseline = new WeakSet<Animation>();
  let statusBaseline = new WeakMap<Element, string>();
  const infinite = (animation: Animation) =>
    animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY;
  const animationTarget = (animation: Animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return target instanceof Element ? target : null;
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

  const indicators: Indicator[] = [];
  const seen = new Set<Kind>();
  const record = (kind: Kind, element: Element, text?: string) => {
    if (startedAt === null || seen.has(kind) || indicators.length >= 12) return;
    seen.add(kind);
    const label = (text ?? textOf(element)).slice(0, 80);
    indicators.push({
      kind,
      selector: selectorFor(element),
      time: since(),
      ...(label ? { text: label } : {}),
      inMain: inMain(element),
      progressText: progressText(label),
    });
  };
  let firstChange: Change | null = null;
  let firstMainChange: Change | null = null;
  let changeAfterReleaseAt: number | null = null;
  let mainChangeAfterReleaseAt: number | null = null;
  let mainEmpty: PendingFacts["mainEmpty"] = null;

  const scan = () => {
    if (startedAt === null) return;
    for (const element of document.querySelectorAll(progressSelector)) {
      if (progressBaseline.has(element) || !rendered(element)) continue;
      if (element === trigger) continue;
      record(
        element.getAttribute("aria-busy") === "true" &&
          !element.matches("[role=progressbar], progress")
          ? "busy"
          : "progressbar",
        element,
      );
    }
    for (const animation of document.getAnimations()) {
      if (!infinite(animation) || animationBaseline.has(animation)) continue;
      const target = animationTarget(animation);
      if (target && rendered(target) && !isNoisy(target))
        record("spinner", target);
    }
    for (const region of document.querySelectorAll(statusSelector)) {
      if (!rendered(region)) continue;
      const text = textOf(region);
      if (text !== "" && text !== (statusBaseline.get(region) ?? ""))
        record("status-text", region, text);
    }
    if (trigger?.isConnected) {
      const flags = triggerFlags();
      if (flags.disabled && !triggerAtArm.disabled)
        record("trigger-disabled", trigger);
      if (flags.busy && !triggerAtArm.busy) record("trigger-busy", trigger);
      if (flags.pressed && !triggerAtArm.pressed)
        record("trigger-pressed", trigger);
      if (rendered(trigger)) {
        const text = textOf(trigger);
        if (text !== "" && text !== triggerText)
          record("control-text", trigger, text);
      }
    }
  };

  const changed = (record: MutationRecord): Element | null => {
    const element = elementOf(record.target);
    if (element === null || tooltipish(element)) return null;
    if (record.type === "attributes") {
      const name = record.attributeName ?? "";
      if (transient.test(name)) return null;
      if (record.oldValue === element.getAttribute(name)) return null;
      return rendered(element) || rendered(element.parentElement)
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
      if (node instanceof Element || normalize(node.textContent) !== "")
        return element;
    return null;
  };
  const onMutations = (records: MutationRecord[]) => {
    if (startedAt === null) {
      if (frozen) return;
      for (const record of records) {
        const element = elementOf(record.target);
        if (element && element !== document.body) noisy.add(element);
      }
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
      const nodes =
        mutation.type === "characterData"
          ? [mutation.target]
          : mutation.type === "attributes"
            ? []
            : [...mutation.addedNodes];
      for (const node of nodes) {
        const element = elementOf(node);
        if (element === null || !rendered(element)) continue;
        const text = normalize(
          node instanceof HTMLElement ? node.innerText : node.textContent,
        );
        if (progressText(text)) record("progress-text", element, text);
        if (node instanceof Element)
          for (const candidate of [
            node,
            ...[...node.querySelectorAll("*")].slice(0, 50),
          ])
            if (skeletal(candidate) && rendered(candidate)) {
              record("skeleton", candidate);
              break;
            }
      }
      if (
        mutation.type === "attributes" &&
        mutation.target instanceof Element &&
        (mutation.attributeName === "class" ||
          mutation.attributeName?.startsWith("data-")) &&
        skeletal(mutation.target) &&
        rendered(mutation.target)
      )
        record("skeleton", mutation.target);
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
      firstChange ??= { time, selector };
      if (main) firstMainChange ??= { time, selector };
      if (releasedAt !== null && time >= releasedAt) {
        changeAfterReleaseAt ??= time;
        if (main) mainChangeAfterReleaseAt ??= time;
      }
    }
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

  const actionEvents =
    action === "click"
      ? ["pointerdown", "click"]
      : action === "press"
        ? ["keydown"]
        : action === "select"
          ? ["input", "change"]
          : ["keydown", "beforeinput", "input"];
  const onAction = (event: Event) => {
    if (
      startedAt !== null ||
      ((action === "click" || action === "press") && !event.isTrusted)
    )
      return;
    let dispatchTarget = trigger;
    if (
      trigger !== null &&
      (action === "fill" || action === "select") &&
      !trigger.matches("input, textarea, select") &&
      !(trigger instanceof HTMLElement && trigger.isContentEditable)
    )
      dispatchTarget = trigger.closest("label")?.control ?? trigger;
    const target = event.composedPath().find((node): node is Element => {
      if (!(node instanceof Element)) return false;
      if (node === dispatchTarget) return true;
      try {
        return node.matches(selector);
      } catch {
        return false;
      }
    });
    if (!target) return;
    onMutations(observer.takeRecords());
    startedAt = performance.now();
    trigger = target;
    // Rebaseline at dispatch, before the application's own handlers run.
    progressBaseline = new WeakSet(
      [...document.querySelectorAll(progressSelector)].filter(rendered),
    );
    animationBaseline = new WeakSet(
      document.getAnimations().filter((animation) => infinite(animation)),
    );
    statusBaseline = new WeakMap();
    for (const region of document.querySelectorAll(statusSelector))
      statusBaseline.set(region, rendered(region) ? textOf(region) : "");
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
    read: () => {
      onMutations(observer.takeRecords());
      scan();
      const element = trigger;
      return {
        dispatched: startedAt !== null,
        elapsed: startedAt === null ? null : since(),
        indicators: [...indicators],
        firstChange,
        firstMainChange,
        changeAfterReleaseAt,
        mainChangeAfterReleaseAt,
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
  const read = () =>
    page.evaluate((token) => {
      const active = (window as PendingWindow).__idiomPending;
      return active?.token === token ? active.read() : null;
    }, token);
  /** Feedback seen up to the second activation; later feedback is its own. */
  let before: PendingFacts | null = null;
  const apply = (latest: PendingFacts | null) => {
    if (latest === null) return;
    const facts: PendingFacts = before
      ? {
          ...latest,
          dispatched: before.dispatched,
          indicators: before.indicators,
          firstChange: before.firstChange,
          firstMainChange: before.firstMainChange,
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
  let hold: Awaited<ReturnType<typeof createHoldRoute>> | undefined;
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
    const effectWindow = await beginEffectWindow(page, Math.max(delayMs, 1000));
    let settled = false;
    try {
      settled = await effectWindow.wait();
    } finally {
      await effectWindow.dispose();
    }
    apply(await read());
    await handle.finish(undefined, settled);
  } catch (error) {
    held.notes.push(`held replay failed: ${String(error).split("\n")[0]}`);
    apply(await read().catch(() => null));
    await handle.finish("held replay interrupted", false);
    throw error;
  } finally {
    await hold?.dispose();
    await page
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

/** Whether a recorded action sent requests a held replay can hold. */
export function heldCandidate(
  requests: ReadonlyArray<{ resourceType: string }>,
): boolean {
  return requests.some((request) => heldTypes.has(request.resourceType));
}
