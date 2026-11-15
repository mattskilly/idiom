import type { CDPSession, Disposable, LaunchOptions, Page } from "playwright";

/**
 * Chromium's launch-time hide flag cannot be undone per page, so capture
 * browsers launch without it and every page hides scrollbars over CDP instead
 * (byte-identical state screenshots), leaving probe clicks free to show them.
 */
export const scrollbarLaunchOptions = {
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
} satisfies LaunchOptions;

/**
 * Capture browsers leave SIGINT and SIGTERM to Idiom. Capture ownership turns
 * either signal into an abort that records the interruption and closes the
 * browser; Playwright's own handlers would race that teardown, and on SIGINT
 * Playwright calls `process.exit(130)` before the record is sealed. SIGHUP,
 * which Idiom does not handle, stays with Playwright.
 */
export const captureLaunchOptions = {
  ...scrollbarLaunchOptions,
  handleSIGINT: false,
  handleSIGTERM: false,
} satisfies LaunchOptions;

/**
 * The probe's classic-scrollbar sheet. A layer and zero specificity let
 * normal author scrollbar sizing and hiding win.
 */
export const probeScrollbarCss =
  "@layer idiom-probe-scrollbars { :where(*)::-webkit-scrollbar { width: 15px; height: 15px; } }";

/** Page-local emulation: capture stays hidden; only click replays get a gutter. */
export class ScrollbarController {
  private script: Disposable | undefined;
  private readonly key = `__idiomScrollbars_${crypto.randomUUID()}`;
  private disposed = false;

  private constructor(
    private readonly page: Page,
    private readonly session: CDPSession,
  ) {}

  static async create(page: Page): Promise<ScrollbarController> {
    const session = await page.context().newCDPSession(page);
    const controller = new ScrollbarController(page, session);
    page.once("close", () => void controller.dispose());
    try {
      await session.send("Emulation.setScrollbarsHidden", { hidden: true });
      return controller;
    } catch (error) {
      await controller.dispose();
      throw error;
    }
  }

  /** Must precede the guarded restore, so application startup measures it too. */
  async probe(): Promise<() => Promise<void>> {
    try {
      await this.session.send("Emulation.setScrollbarsHidden", {
        hidden: false,
      });
      this.script = await this.page.addInitScript(
        ({ key, css }: { key: string; css: string }) => {
          if (window !== window.top && self.origin === "null") return;
          // Constructed sheets work under restrictive style-src CSP.
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          Object.defineProperty(window, key, {
            configurable: true,
            value: () => {
              document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
                (entry) => entry !== sheet,
              );
              Reflect.deleteProperty(window, key);
            },
          });
        },
        { key: this.key, css: probeScrollbarCss },
      );
      if (this.disposed) {
        await this.script.dispose().catch(() => undefined);
        throw new Error("scrollbar page closed during preparation");
      }
      return () => this.capture();
    } catch (error) {
      await this.capture();
      throw error;
    }
  }

  /**
   * Shows classic scrollbars on the current document for `work` (a
   * measurement after the state's evidence is saved), then hides them again
   * in the order `capture()` documents.
   */
  async measure<T>(work: () => Promise<T>): Promise<T> {
    const key = `${this.key}_measure`;
    try {
      await this.session.send("Emulation.setScrollbarsHidden", {
        hidden: false,
      });
      await this.page.evaluate(
        ({ key, css }) => {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          Object.defineProperty(window, key, {
            configurable: true,
            value: () => {
              document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
                (entry) => entry !== sheet,
              );
              Reflect.deleteProperty(window, key);
            },
          });
        },
        { key, css: probeScrollbarCss },
      );
      return await work();
    } finally {
      await this.bounded(async () => {
        if (this.page.isClosed()) return;
        await this.session.send("Emulation.setScrollbarsHidden", {
          hidden: true,
        });
        await this.page.evaluate((key) => {
          const cleanup = Reflect.get(window, key);
          if (typeof cleanup === "function") cleanup();
        }, key);
      });
    }
  }

  async capture(): Promise<void> {
    const script = this.script;
    this.script = undefined;
    await this.bounded(async () => {
      await script?.dispose();
      if (this.page.isClosed()) return;
      // Hide first: removing the sheet rebuilds the scrollbars, and they must
      // be rebuilt under the hidden emulation or they keep their gutter.
      await this.session.send("Emulation.setScrollbarsHidden", {
        hidden: true,
      });
      await this.page.evaluate((key) => {
        const cleanup = Reflect.get(window, key);
        if (typeof cleanup === "function") cleanup();
      }, this.key);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.bounded(async () => {
      await this.script?.dispose().catch(() => undefined);
      this.script = undefined;
      await this.session.detach();
    });
  }

  private async bounded(work: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work().catch(() => {
          void this.page.close().catch(() => undefined);
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            void this.page.close().catch(() => undefined);
            resolve();
          }, 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
