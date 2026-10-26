import type { Page, Request } from "playwright";

type QuietWindow = {
  __idiomQuiet?: {
    token: string;
    last: number;
    url: string;
    observer: MutationObserver;
    activity(): void;
  };
};

/** Observe 150ms of inactivity, bounded by the former fixed effect window. */
export async function beginEffectWindow(page: Page, maximumMs: number) {
  const token = `${Date.now()}:${Math.random()}`;
  let networkAt = performance.now();
  const pending = new Set<Request>();
  const request = (value: Request) => {
    pending.add(value);
    networkAt = performance.now();
  };
  const finished = (value: Request) => {
    pending.delete(value);
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
    async wait() {
      const begun = performance.now();
      networkAt = Math.max(networkAt, begun);
      // Clicking itself starts the window even when it causes no activity.
      await page
        .evaluate((token) => {
          const state = (window as QuietWindow).__idiomQuiet;
          if (state?.token === token) state.last = performance.now();
        }, token)
        .catch(() => undefined);
      while (performance.now() - begun < maximumMs) {
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
          return;
        const remaining = maximumMs - (performance.now() - begun);
        if (remaining > 0) await page.waitForTimeout(Math.min(25, remaining));
      }
    },
  };
}
