import type { Page, Route } from "playwright";
import { RELEASE_ADJACENCY_MS } from "../checks/loading-state.js";
import type { ActionTimeline, FailureReplay } from "../checks/types.js";
import {
  type ReplayRequest,
  requestIdentity,
  responseAt,
} from "./failure-identity.js";
import { type FeedbackWindow, installFeedback } from "./feedback.js";
import type { HeldItem } from "./loading.js";
import type { TimelineCollector } from "./timeline.js";

export const MAX_FAILURE_REPLAYS = 6;
export type FailureSettings = {
  mode: "status" | "network";
  status: number;
  feedbackWithinMs: number;
};
export const DEFAULT_FAILURE: FailureSettings = {
  mode: "status",
  status: 500,
  feedbackWithinMs: 2000,
};
export type FailureEligibility = FailureReplay["eligibility"];

/** Positive response/result evidence, independent of either loading judgment. */
export function failureEligibility(
  original: ActionTimeline,
  slow?: ActionTimeline,
): FailureEligibility | undefined {
  if (
    original.status === "unavailable" ||
    original.truncated.length ||
    original.requests.some((r) => r.resourceType === "document")
  )
    return;
  if (slow?.held) {
    const held = slow.held;
    if (
      !held.dispatched ||
      slow.status === "unavailable" ||
      slow.truncated.length ||
      held.requests.some((r) => r.navigation)
    )
      return;
    const change = held.mainChangeAfterReleaseAt;
    const first = held.firstMainChange;
    // A progress affordance may precede the result; an independent result may not.
    const pendingFirst =
      first &&
      held.indicators.some(
        (i) =>
          i.selector === first.selector &&
          (i.progressText ||
            ["spinner", "skeleton", "busy", "progressbar"].includes(i.kind)),
      );
    if (
      change !== null &&
      first &&
      (first.time >= (held.releasedAt ?? Infinity) || pendingFirst)
    ) {
      const request = held.requests.find(
        (r) =>
          ["fetch", "xhr"].includes(r.resourceType) &&
          r.forwarded &&
          r.releasedAt !== null &&
          change >= r.releasedAt &&
          change - r.releasedAt <= RELEASE_ADJACENCY_MS,
      );
      if (request?.releasedAt != null)
        return {
          basis: "release",
          responseAt: request.releasedAt,
          changeAt: change,
          selector: first.selector,
        };
    }
    if (held.requests.some((r) => r.forwarded)) return;
  }
  // Normal timelines expose structural visible results. Text-only results are
  // established by the held watcher instead, which has a dispatch/noise baseline.
  const region = original.effectRegion.commonAncestor;
  const changes = original.mutations.filter(
    (m) =>
      m.type === "insert" &&
      m.rect &&
      m.rect.width > 0 &&
      m.rect.height > 0 &&
      m.selector !== original.selector &&
      (!original.selector || !m.selector.startsWith(`${original.selector} `)) &&
      (!region ||
        m.selector.startsWith(region) ||
        original.visibleChanges?.some(
          (c) => c.selector === m.selector && c.container === region,
        )),
  );
  const first = changes[0];
  if (!first) return;
  const request = original.requests.find(
    (r) =>
      ["fetch", "xhr"].includes(r.resourceType) &&
      r.outcome === "ok" &&
      responseAt(r, original) !== null &&
      first.time >= (responseAt(r, original) ?? Infinity) &&
      first.time - (responseAt(r, original) ?? 0) <= RELEASE_ADJACENCY_MS,
  );
  if (request?.endTime != null)
    return {
      basis: "response",
      responseAt: responseAt(request, original) ?? request.endTime,
      changeAt: first.time,
      selector: first.selector,
    };
}
/** Restrict injection to the requests adjacent to the established result. */
export function eligibleFailureRequests(
  original: ActionTimeline,
  slow: ActionTimeline | undefined,
  eligibility: FailureEligibility,
  privateRequests: ReplayRequest[],
): ReplayRequest[] {
  const signatures =
    eligibility.basis === "release"
      ? (slow?.held?.requests ?? []).filter(
          (r) =>
            !r.navigation &&
            r.releasedAt !== null &&
            eligibility.changeAt >= r.releasedAt &&
            eligibility.changeAt - r.releasedAt <= RELEASE_ADJACENCY_MS,
        )
      : original.requests.filter(
          (r) =>
            responseAt(r, original) !== null &&
            r.outcome === "ok" &&
            eligibility.changeAt >= (responseAt(r, original) ?? Infinity) &&
            eligibility.changeAt - (responseAt(r, original) ?? 0) <=
              RELEASE_ADJACENCY_MS,
        );
  return privateRequests.filter((r) =>
    signatures.some((s) => {
      const exact = requestIdentity(s);
      return (
        exact !== undefined &&
        exact.method === r.method &&
        exact.resourceType === r.resourceType &&
        exact.url === r.url
      );
    }),
  );
}
export function failureKey(
  selector: string,
  requests: ReadonlyArray<{ method: string; path?: string; url?: string }>,
): string {
  return `${selector}|${[...new Set(requests.map((r) => `${r.method} ${r.path ?? new URL(r.url ?? "").pathname}`))].sort().join("|")}`;
}

type RecoveryFacts = Pick<
  FailureReplay,
  | "dispatched"
  | "feedback"
  | "changes"
  | "trigger"
  | "pending"
  | "main"
  | "retry"
  | "truncated"
> & { elapsed: number | null; boundary: number | null };
type RecoveryWindow = FeedbackWindow & {
  __idiomRecovery?: {
    token: string;
    bind(element: Element): void;
    fail(): number | null;
    read(): RecoveryFacts;
    dispose(): void;
  };
};

/** Serializable, token-owned recovery observer. Never changes application DOM. */
function recoveryWatcher(config: {
  token: string;
  selector: string;
  action: string;
}): void {
  const scope = window as unknown as RecoveryWindow;
  scope.__idiomRecovery?.dispose();
  const {
    rendered,
    selectorFor,
    normalize,
    textOf,
    progressText,
    skeletal,
    mainOf,
    noiseSet,
  } = scope.__idiomFeedback;
  let trigger: Element | null = null;
  try {
    trigger = document.querySelector(config.selector);
  } catch {
    /* locator bound */
  }
  let started: number | null = null;
  let boundary: number | null = null;
  let region: Element = mainOf();
  let initialEmpty: boolean | null = null;
  let initiallyEnabled: boolean | null = null;
  let truncated = false;
  let regionSelector = "body";
  let pendingBaseline = new WeakSet<Element>();
  const elapsed = () => (started === null ? null : performance.now() - started);
  const noisy = noiseSet();
  const noise = noisy.has;
  const errorWords =
    /\b(error|failed|failure|unable|couldn.t|cannot|can.t|sorry|wrong|try again|went wrong|unsuccessful)\b/i;
  const signals =
    "[role=alert], [role=status], [aria-live]:not([aria-live=off]), [aria-invalid=true]";
  const baseline = new Map<Element, string>();
  const retryBaseline = new Set<Element>();
  const feedback: FailureReplay["feedback"] = [];
  const changes: FailureReplay["changes"] = [];
  const seen = new Set<string>();
  const usable = (e: Element) =>
    rendered(e) &&
    !(e as HTMLButtonElement).disabled &&
    e.getAttribute("aria-disabled") !== "true" &&
    !e.closest("[inert]");
  const nearTrigger = (e: Element) => {
    if (!trigger || !rendered(e)) return false;
    const a = trigger.getBoundingClientRect(),
      b = e.getBoundingClientRect();
    return (
      Math.max(a.top - b.bottom, b.top - a.bottom, 0) <= 120 &&
      Math.max(a.left - b.right, b.left - a.right, 0) <= 160
    );
  };
  const local = (e: Element) =>
    region.contains(e) ||
    (errorWords.test(textOf(e)) && nearTrigger(e)) ||
    !!e.closest("[role=alert], [data-toast], [class*=toast], [class*=banner]");
  const empty = (e: Element) =>
    !rendered(e) ||
    (normalize(e instanceof HTMLElement ? e.innerText : e.textContent) === "" &&
      ![
        ...e.querySelectorAll(
          "button, input, select, textarea, img, svg, canvas, video, iframe",
        ),
      ].some(rendered));
  // Live announcements may be visually clipped for screen readers, but never
  // display:none, aria-hidden or inert. Visibility:hidden is not announced.
  const announced = (e: Element) => {
    for (let node: Element | null = e; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        node.matches("[aria-hidden=true], [inert]")
      )
        return false;
    }
    return e.isConnected;
  };
  // A message is the innermost block of visible text: inline links and
  // emphasis belong to it, while a wrapper around other blocks or controls is
  // not itself one, and hidden descendants lend it no words.
  const message = (e: Element) =>
    e.children.length === 0 ||
    ([...e.children].every((c) => {
      const display = getComputedStyle(c).display;
      return (
        display === "none" ||
        (display.startsWith("inline") &&
          !c.matches("button, [role=button], input, select, textarea"))
      );
    }) &&
      errorWords.test(textOf(e)));
  const retryControls = () =>
    [...document.querySelectorAll("button, a, [role=button]")].filter(
      (e) =>
        local(e) &&
        usable(e) &&
        /\b(retry|try again)\b/i.test(textOf(e)) &&
        !noise(e) &&
        (!retryBaseline.has(e) ||
          e === trigger ||
          !!trigger?.closest("form, section, article")?.contains(e) ||
          (e.getAttribute("aria-controls") === region.id && region.id !== "")),
    );
  const scan = () => {
    if (started === null || boundary === null) return;
    for (const e of document.querySelectorAll(
      `${signals}, main *, [role=main] *, p, small, [class*=error], [data-error], [class*=toast], [class*=toast] *, [class*=banner], [class*=banner] *`,
    )) {
      if (
        noise(e) ||
        e === trigger ||
        trigger?.contains(e) ||
        e.matches("button, a, [role=button]")
      )
        continue;
      const live = e.matches(
        "[role=alert], [role=status], [aria-live]:not([aria-live=off])",
      );
      const invalid = e.matches("[aria-invalid=true]");
      const text = invalid ? "aria-invalid=true" : normalize(e.textContent);
      if (
        !text ||
        text === baseline.get(e) ||
        (progressText(text) && !errorWords.test(text))
      )
        continue;
      if (
        live
          ? !announced(e) || (!local(e) && !errorWords.test(text))
          : !rendered(e) || !local(e)
      )
        continue;
      if (!live && !invalid && (!errorWords.test(text) || !message(e)))
        continue;
      if (invalid && !region.contains(e)) continue;
      const selector = selectorFor(e);
      const key = `${selector}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (feedback.length >= 40) {
        truncated = true;
        continue;
      }
      feedback.push({
        time: elapsed() ?? 0,
        selector,
        text: text.slice(0, 160),
        kind: invalid
          ? "invalid"
          : e.matches("[role=alert]")
            ? "alert"
            : e.matches("[role=status]")
              ? "status"
              : live
                ? "live"
                : "error",
      });
    }
  };
  const observer = new MutationObserver((records) => {
    if (started === null) {
      noisy.markRecords(records, [document.body, region]);
      return;
    }
    scan();
    if (boundary === null) return;
    for (const r of records) {
      if (r.type === "attributes") continue; // focus, busy and hover are not results
      const e = r.target instanceof Element ? r.target : r.target.parentElement;
      if (
        !e ||
        !local(e) ||
        noise(e) ||
        e === trigger ||
        trigger?.contains(e) ||
        !rendered(e) ||
        e.closest("[role=tooltip]")
      )
        continue;
      const text = textOf(e);
      if (
        !text ||
        text === baseline.get(e) ||
        progressText(text) ||
        errorWords.test(text) ||
        e.matches(signals)
      )
        continue;
      // Only newly rendered result content; removal of a spinner and trigger
      // label resets cannot establish a visible outcome.
      const inserted = [...r.addedNodes].some((n) =>
        n instanceof Element
          ? rendered(n) && !skeletal(n) && n !== trigger
          : normalize(n.textContent) !== "",
      );
      if (!inserted && r.type !== "characterData") continue;
      if (changes.length >= 40) {
        truncated = true;
        continue;
      }
      changes.push({ time: elapsed() ?? 0, selector: selectorFor(e) });
    }
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  const events =
    config.action === "click"
      ? ["pointerdown", "click"]
      : config.action === "press"
        ? ["keydown"]
        : ["input", "change", "beforeinput"];
  const arm = (event: Event) => {
    if (
      started !== null ||
      (["click", "press"].includes(config.action) && !event.isTrusted)
    )
      return;
    if (!event.composedPath().some((n) => n === trigger)) return;
    observer.takeRecords();
    started = performance.now();
    region =
      trigger?.closest("form, section, article, main, [role=main]") ??
      document.querySelector("main, [role=main]") ??
      document.body;
    regionSelector = selectorFor(region);
    pendingBaseline = new WeakSet(
      [...region.querySelectorAll("*")].filter(
        (e) =>
          rendered(e) &&
          (e.matches("[role=progressbar], progress, [aria-busy=true]") ||
            skeletal(e) ||
            (e.children.length === 0 && progressText(textOf(e)))),
      ),
    );
    initialEmpty = empty(region);
    initiallyEnabled = trigger !== null && usable(trigger);
    for (const e of document.querySelectorAll("*"))
      baseline.set(
        e,
        e.matches("[aria-invalid=true]")
          ? "aria-invalid=true"
          : rendered(e) || (e.matches(signals) && announced(e))
            ? normalize(e.textContent)
            : "",
      );
    for (const e of retryControls()) retryBaseline.add(e);
  };
  for (const type of events) window.addEventListener(type, arm, true);
  const interval = setInterval(scan, 40);
  scope.__idiomRecovery = {
    token: config.token,
    bind(e) {
      if (started === null) trigger = e;
    },
    fail() {
      boundary = elapsed();
      return boundary;
    },
    read() {
      scan();
      // Resolve a directly replaced trigger using its original stable selector.
      let current = trigger;
      if (!current?.isConnected)
        try {
          current = document.querySelector(config.selector);
        } catch {
          /* unknown */
        }
      if (!region.isConnected)
        region =
          document.querySelector(regionSelector) ??
          document.querySelector("main, [role=main]") ??
          region;
      const pending = [
        ...new Set([
          ...region.querySelectorAll("*"),
          ...(current ? [current, ...current.querySelectorAll("*")] : []),
        ]),
      ].filter(
        (e) =>
          rendered(e) &&
          !noise(e) &&
          !pendingBaseline.has(e) &&
          (e.matches("[role=progressbar], progress, [aria-busy=true]") ||
            skeletal(e) ||
            (e.children.length === 0 && progressText(textOf(e))) ||
            document
              .getAnimations()
              .some(
                (a) =>
                  a.effect?.getTiming().iterations === Infinity &&
                  (a.effect as KeyframeEffect)?.target === e,
              )),
      );
      const retries = retryControls();
      if (pending.length > 40 || retries.length > 40) truncated = true;
      return {
        dispatched: started !== null,
        elapsed: elapsed(),
        boundary,
        feedback: [...feedback],
        changes: [...changes],
        truncated,
        trigger: {
          initiallyEnabled,
          disabled: current
            ? (current as HTMLButtonElement).disabled === true ||
              current.getAttribute("aria-disabled") === "true"
            : null,
          busy: current ? current.getAttribute("aria-busy") === "true" : null,
          hidden: !current || !rendered(current),
          inert: current ? !!current.closest("[inert]") : null,
        },
        pending: pending.slice(0, 40).map((e) => ({
          selector: selectorFor(e),
          text: textOf(e).slice(0, 160),
        })),
        main: {
          selector: selectorFor(region),
          initiallyEmpty: initialEmpty,
          empty: empty(region),
        },
        retry: retries.slice(0, 40).map(selectorFor),
      };
    },
    dispose() {
      observer.disconnect();
      clearInterval(interval);
      for (const type of events) window.removeEventListener(type, arm, true);
      if (scope.__idiomRecovery?.token === config.token)
        delete scope.__idiomRecovery;
    },
  };
}

/** Terminal local injection: matching is private and exact, including origin/query.
 * Overflow only truncates evidence; repeated attempts are still injected. */
export async function createFailureRoute(
  page: Page,
  options: {
    requests: ReplayRequest[];
    settings: FailureSettings;
    clock(): number;
    boundary(): Promise<number | null>;
  },
) {
  let active = true;
  let truncated = false;
  let failed = false;
  let last = options.clock();
  let pending = 0;
  const begun = last;
  const requests: FailureReplay["requests"] = [];
  const handler = async (route: Route) => {
    const request = route.request();
    if (
      !options.requests.some(
        (r) =>
          r.url === request.url() &&
          r.method === request.method() &&
          r.resourceType === request.resourceType(),
      )
    )
      return route.fallback();
    if (!active) return route.abort("failed").catch(() => undefined);
    pending++;
    const record: FailureReplay["requests"][number] = {
      method: request.method(),
      path: new URL(request.url()).pathname,
      resourceType: request.resourceType() as "fetch" | "xhr",
      startTime: options.clock() - begun,
      injectedAt: null,
      delivered: false,
    };
    if (requests.length < 60) requests.push(record);
    else truncated = true;
    try {
      let markTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        record.injectedAt = await Promise.race([
          options.boundary(),
          new Promise<null>((resolve) => {
            markTimer = setTimeout(() => resolve(null), 500);
          }),
        ]);
      } finally {
        clearTimeout(markTimer);
      }
      if (options.settings.mode === "network") await route.abort("failed");
      else
        await route.fulfill({
          status: options.settings.status,
          contentType: "application/json",
          body: '{"error":"Idiom local failure replay"}',
        });
      record.delivered = true;
    } catch {
      failed = true;
      await route.abort("failed").catch(() => undefined);
    } finally {
      last = options.clock();
      pending--;
    }
  };
  await page.route("**/*", handler);
  return {
    requests,
    get truncated() {
      return truncated;
    },
    get failed() {
      return failed;
    },
    quietFor: () => (pending ? 0 : options.clock() - last),
    async dispose() {
      active = false;
      await page.unroute("**/*", handler).catch(() => undefined);
    },
  };
}

export async function replayFailure(options: {
  page: Page;
  routePage: Page;
  item: HeldItem;
  requests: ReplayRequest[];
  eligibility: FailureEligibility;
  settings: FailureSettings;
  timeline: TimelineCollector;
  clock(): number;
}): Promise<void> {
  const { page, item, settings } = options;
  const token = `${Date.now()}:${Math.random()}`;
  const failure: FailureReplay = {
    of: item.of,
    sourceAction: `${item.of}:${item.stepIndex ?? item.selector}`,
    mode: settings.mode,
    status: settings.status,
    feedbackWithinMs: settings.feedbackWithinMs,
    eligibility: options.eligibility,
    dispatched: false,
    navigated: false,
    requests: [],
    observationStart: null,
    observationEnd: null,
    feedback: [],
    changes: [],
    trigger: {
      initiallyEnabled: null,
      disabled: null,
      busy: null,
      hidden: null,
      inert: null,
    },
    pending: null,
    main: { selector: "body", initiallyEmpty: null, empty: null },
    retry: null,
    complete: false,
    truncated: false,
    notes: [],
  };
  const read = () =>
    page.evaluate((token) => {
      const w = (window as unknown as RecoveryWindow).__idiomRecovery;
      return w?.token === token ? w.read() : null;
    }, token);
  const apply = (facts: RecoveryFacts | null) => {
    if (!facts) return;
    const { elapsed, boundary, ...rest } = facts;
    Object.assign(failure, rest);
    failure.observationEnd = elapsed;
    failure.observationStart = boundary;
  };
  await item.prepare?.(page);
  const handle = await options.timeline.start(
    {
      source: "failure-replay",
      kind: item.kind,
      selector: item.selector,
      name: item.name,
      ...(item.stepIndex === undefined ? {} : { stepIndex: item.stepIndex }),
    },
    () => ({ failure: structuredClone(failure) }),
  );
  let route: Awaited<ReturnType<typeof createFailureRoute>> | undefined;
  const navigated = (frame: { parentFrame(): unknown }) => {
    if (frame.parentFrame() === null) failure.navigated = true;
  };
  options.routePage.on("framenavigated", navigated);
  try {
    await page.evaluate(installFeedback);
    await page.evaluate(recoveryWatcher, {
      token,
      selector: item.selector,
      action: item.kind,
    });
    await page
      .locator(item.selector)
      .first()
      .evaluate(
        (e, token) => {
          const w = (window as unknown as RecoveryWindow).__idiomRecovery;
          if (w?.token === token) w.bind(e);
        },
        token,
        { timeout: 1500 },
      );
    await page.waitForTimeout(250);
    route = await createFailureRoute(options.routePage, {
      requests: options.requests,
      settings,
      clock: options.clock,
      boundary: () =>
        options.routePage.evaluate((token) => {
          const w = (window as unknown as RecoveryWindow).__idiomRecovery;
          return w?.token === token ? w.fail() : null;
        }, token),
    });
    failure.requests = route.requests;
    await item.perform(page);
    // Wait through the last injected response, including chained/automatic retries.
    while (route.quietFor() < settings.feedbackWithinMs)
      await page.waitForTimeout(
        Math.min(50, settings.feedbackWithinMs - route.quietFor() + 5),
      );
    apply(await read());
    failure.truncated ||= route.truncated;
    failure.complete =
      !failure.navigated &&
      !route.failed &&
      !failure.truncated &&
      failure.dispatched &&
      failure.observationEnd !== null &&
      failure.requests.length > 0 &&
      failure.requests.every(
        (r) =>
          r.delivered &&
          r.injectedAt !== null &&
          (failure.observationEnd ?? 0) - r.injectedAt >=
            settings.feedbackWithinMs,
      );
    if (!failure.complete)
      failure.notes.push(
        "incomplete recovery window or local injection; absence is unavailable",
      );
    await handle.finish(undefined, true);
  } catch (error) {
    apply(await read().catch(() => null));
    failure.notes.push(
      `failure replay interrupted: ${String(error).split("\n")[0]}`,
    );
    await handle.finish("failure replay interrupted", false);
    throw error;
  } finally {
    await route?.dispose();
    options.routePage.off("framenavigated", navigated);
    await page
      .evaluate((token) => {
        const w = (window as unknown as RecoveryWindow).__idiomRecovery;
        if (w?.token === token) w.dispose();
      }, token)
      .catch(() => undefined);
    await handle.finish("failure replay interrupted", false);
    await handle.finishVisual();
    await handle.dispose();
  }
}
