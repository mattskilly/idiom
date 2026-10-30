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
      this.script = await this.page.addInitScript((key: string) => {
        // Constructed sheets work under restrictive style-src CSP. A layer and
        // zero specificity let normal author scrollbar sizing/hiding win.
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(
          "@layer idiom-probe-scrollbars { :where(*)::-webkit-scrollbar { width: 15px; height: 15px; } }",
        );
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
      }, this.key);
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

  async capture(): Promise<void> {
    const script = this.script;
    this.script = undefined;
    await this.bounded(async () => {
      await script?.dispose();
      if (this.page.isClosed()) return;
      await this.page.evaluate((key) => {
        const cleanup = Reflect.get(window, key);
        if (typeof cleanup === "function") cleanup();
      }, this.key);
      await this.session.send("Emulation.setScrollbarsHidden", {
        hidden: true,
      });
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
