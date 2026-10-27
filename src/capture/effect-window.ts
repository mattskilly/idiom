import type { Page, Request } from "playwright";
import { ignoredRequest } from "./request-policy.js";

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
  };
};

/**
 * Observe 150ms of inactivity, bounded by the former fixed effect window.
 * With `pendingMs`, a window that reaches its bound while requests it saw
 * start are still in flight keeps waiting for them (and 150ms of quiet), up
 * to `pendingMs` in total, so late content lands inside the window.
 * Ignored requests, navigations and streams (EventSource, WebSocket) never
 * extend it.
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
      };
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
      const open = () => {
        const elapsed = performance.now() - begun;
        if (elapsed < maximumMs) return true;
        // At the bound, only requests this window saw start extend it.
        if (!extended) extended = awaited.size > 0;
        return extended && elapsed < pendingMs;
      };
      while (open()) {
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
