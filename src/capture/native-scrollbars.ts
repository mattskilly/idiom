import type { Page } from "playwright";
import type {
  ChromeDefaultsWindow,
  NativeScrollbarMeasurement,
} from "../checks/chrome-defaults-dom.js";
import type { ScrollbarController } from "./scrollbars.js";

/**
 * Measures the scroller candidates observe selected, with classic
 * scrollbars shown for the measurement only. Runs after the state's
 * evidence is saved and before the probe.
 */
export async function measureNativeScrollbars(
  page: Page,
  controller: Pick<ScrollbarController, "measure">,
): Promise<NativeScrollbarMeasurement> {
  try {
    const measured = await controller.measure(() =>
      page.evaluate(() =>
        (window as ChromeDefaultsWindow).__idiomChromeDefaults?.measure(),
      ),
    );
    return (
      measured ?? {
        scan: {
          status: "partial",
          reason: "scrollbar scan unavailable",
          records: [],
        },
        restored: true,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      scan: {
        status: "partial",
        reason: `scrollbar measurement failed: ${message.split("\n")[0]}`,
        records: [],
      },
      restored: false,
    };
  }
}
