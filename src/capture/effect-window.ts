import type { Page, Request } from "playwright";
import { analyticsRequest, ignoredRequest } from "./request-policy.js";

/**
 * How long a probe click may wait for content its own requests bring: long
 * enough to see data that arrives after the 500ms late-shift boundary.
 */
export const LATE_CONTENT_WINDOW_MS = 2000;

type QuietWindow = {
  __idiomQuiet?: {
    token: string;
    last: number;
    url: string;
    observer: MutationObserver;
    activity(): void;
    /** keepalive fetches the page started, and whether anything awaited one. */
    keepalive: Array<{ url: string; waited: boolean }>;
    fetch: typeof fetch;
  };
};

/**
 * Observe 150ms of inactivity, bounded by the former fixed effect window.
 * With `pendingMs`, a window that reaches its bound while requests it saw
 * start are still in flight keeps waiting for them (and 150ms of quiet), up
 * to `pendingMs` in total, so late content lands inside the window.
 * Ignored requests, navigations, streams (EventSource, WebSocket), analytics
 * and beacon requests, and keepalive fetches nothing awaits never extend it.
 */
export async function beginEffectWindow(
  page: Page,
  maximumMs: number,
  options: { pendingMs?: number | undefined } = {},
) {
  const token = `${Date.now()}:${Math.random()}`;
  let networkAt = performance.now();
  const pending = new Set<Request>();
  const awaited = new Set<Request>();
  const request = (value: Request) => {
    pending.add(value);
    networkAt = performance.now();
    if (
      !ignoredRequest(value) &&
      !analyticsRequest(value) &&
      !["document", "eventsource", "websocket"].includes(value.resourceType())
    )
      awaited.add(value);
  };
  const finished = (value: Request) => {
    pending.delete(value);
    awaited.delete(value);
    networkAt = performance.now();
  };
  const dispose = async () => {
    page.off("request", request);
    page.off("requestfinished", finished);
    page.off("requestfailed", finished);
    await page
      .evaluate((token) => {
        const scope = window as QuietWindow;
        const state = scope.__idiomQuiet;
        if (!state || state.token !== token) return;
        state.observer.disconnect();
        if (window.fetch !== state.fetch) window.fetch = state.fetch;
        document.removeEventListener("focusin", state.activity, true);
        document.removeEventListener("focusout", state.activity, true);
        delete scope.__idiomQuiet;
      }, token)
      .catch(() => undefined);
  };
  page.on("request", request);
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  try {
    await page.evaluate((token) => {
      const state = {
        token,
        last: performance.now(),
        url: location.href,
        observer: undefined as unknown as MutationObserver,
        activity: () => {
          state.last = performance.now();
        },
        keepalive: [] as Array<{ url: string; waited: boolean }>,
        fetch: window.fetch,
      };
      // A keepalive fetch whose result nothing reads is a beacon. Awaiting
      // it or passing a fulfilment handler to then() counts as reading it;
      // catch() alone does not.
      const original = state.fetch;
      window.fetch = function (
        this: unknown,
        ...args: Parameters<typeof fetch>
      ) {
        const promise = original.apply(this, args);
        const [input, init] = args;
        const keepalive =
          init?.keepalive ?? (input instanceof Request && input.keepalive);
        if (!keepalive) return promise;
        let url: string;
        try {
          url = new URL(
            input instanceof Request ? input.url : String(input),
            location.href,
          ).href;
        } catch {
          return promise;
        }
        const entry = { url, waited: false };
        if (state.keepalive.length < 50) state.keepalive.push(entry);
        const then = promise.then;
        Object.defineProperties(promise, {
          // biome-ignore lint/suspicious/noThenProperty: observes who reads this one keepalive fetch; delegates to the native then().
          then: {
            configurable: true,
            writable: true,
            value(this: Promise<Response>, ...handlers: unknown[]) {
              if (typeof handlers[0] === "function") entry.waited = true;
              return Reflect.apply(then, this, handlers);
            },
          },
          // `await` adopts a native promise without reading then(); an
          // instance constructor makes it resolve through the method above.
          constructor: { configurable: true, writable: true, value: undefined },
        });
        return promise;
      } as typeof fetch;
      state.observer = new MutationObserver(state.activity);
      state.observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      document.addEventListener("focusin", state.activity, true);
      document.addEventListener("focusout", state.activity, true);
      (window as QuietWindow).__idiomQuiet = state;
    }, token);
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    dispose,
    /** Resolves true when the page went quiet, false at the bound. */
    async wait(): Promise<boolean> {
      const begun = performance.now();
      networkAt = Math.max(networkAt, begun);
      // Clicking itself starts the window even when it causes no activity.
      await page
        .evaluate((token) => {
          const state = (window as QuietWindow).__idiomQuiet;
          if (state?.token === token) state.last = performance.now();
        }, token)
        .catch(() => undefined);
      const pendingMs = Math.max(maximumMs, options.pendingMs ?? maximumMs);
      let extended = false;
      let beacons = false;
      const open = async () => {
        const elapsed = performance.now() - begun;
        if (elapsed < maximumMs) return true;
        // At the bound, only requests this window saw start extend it, and
        // not keepalive fetches nothing awaits.
        if (!beacons && awaited.size > 0) {
          beacons = true;
          const unread = await page
            .evaluate((token) => {
              const state = (window as QuietWindow).__idiomQuiet;
              return state?.token === token
                ? state.keepalive
                    .filter((entry) => !entry.waited)
                    .map((entry) => entry.url)
                : [];
            }, token)
            .catch(() => [] as string[]);
          for (const value of [...awaited])
            if (unread.includes(value.url())) awaited.delete(value);
        }
        if (!extended) extended = awaited.size > 0;
        return extended && elapsed < pendingMs;
      };
      while (await open()) {
        const quiet = await page
          .evaluate((token) => {
            const state = (window as QuietWindow).__idiomQuiet;
            if (!state || state.token !== token) return false;
            if (state.url !== location.href) {
              state.url = location.href;
              state.activity();
            }
            return performance.now() - state.last >= 150;
          }, token)
          .catch(() => false);
        if (quiet && pending.size === 0 && performance.now() - networkAt >= 150)
          return true;
        // Extended for awaited requests: once they are done and the page is
        // quiet, stop, still unsettled when other requests remain.
        if (
          extended &&
          quiet &&
          awaited.size === 0 &&
          performance.now() - networkAt >= 150
        )
          return false;
        const remaining =
          (extended ? pendingMs : maximumMs) - (performance.now() - begun);
        if (remaining > 0) await page.waitForTimeout(Math.min(25, remaining));
      }
      return false;
    },
  };
}
