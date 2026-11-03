import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";

/**
 * A blank page outside the captured application, where token values resolve
 * without app styles reaching the probes and without mutating the observed
 * document. One session serves a whole observation and is opened lazily.
 */
export type IsolatedTokenSession = {
  get(options?: IsolatedPageOptions): Promise<Page>;
  close(): Promise<void>;
};

export type IsolatedPageOptions = {
  /** The captured page's `prefers-color-scheme`. */
  colorScheme: "light" | "dark";
  /** The captured page's `<meta name="color-scheme">` content. */
  meta?: string | undefined;
};

const attribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function shell(meta: string | undefined): string {
  return `<!doctype html><html><head><meta http-equiv='Content-Security-Policy' content="default-src 'none'; style-src 'unsafe-inline'">${meta === undefined ? "" : `<meta name="color-scheme" content="${attribute(meta)}">`}</head><body></body></html>`;
}

export function createIsolatedTokenSession(page: Page): IsolatedTokenSession {
  let opened:
    | Promise<{ page: Page; context: BrowserContext; launched?: Browser }>
    | undefined;
  const open = async (options: IsolatedPageOptions) => {
    // A separate context: no app CSS, scripts, init scripts, routes or
    // context page listeners. Electron and persistent contexts have no
    // browser to share, so they get a throwaway one.
    const shared = page.context().browser();
    const launched =
      shared === null ? await chromium.launch({ headless: true }) : undefined;
    let context: BrowserContext | undefined;
    try {
      context = await (shared ?? (launched as Browser)).newContext({
        colorScheme: options.colorScheme,
      });
      const isolated = await context.newPage();
      await isolated.route("**/*", (route) => route.abort());
      await isolated.setContent(shell(options.meta));
      return { page: isolated, context, ...(launched ? { launched } : {}) };
    } catch (error) {
      await context?.close().catch(() => undefined);
      await launched?.close().catch(() => undefined);
      throw error;
    }
  };
  return {
    get(options = { colorScheme: "light" }) {
      opened ??= open(options);
      return opened.then((session) => session.page);
    },
    async close() {
      const current = opened;
      opened = undefined;
      const session = await current?.catch(() => undefined);
      if (session === undefined) return;
      await session.context.close().catch(() => undefined);
      await session.launched?.close().catch(() => undefined);
    },
  };
}
