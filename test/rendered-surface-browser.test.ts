import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observeRenderedSurface } from "../src/capture/rendered-surface.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

test("forwardRef and memo components are named through their inner render function", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<div id="a" class="toolbar-root"></div><div id="b"></div><div id="c"></div>',
    );
    await page.evaluate(() => {
      function Toolbar() {}
      function Panel() {}
      const attach = (id: string, type: unknown) => {
        const element = document.getElementById(id) as unknown as Record<
          string,
          unknown
        >;
        element.__reactFiber$test = { type, return: null };
      };
      // forwardRef without a displayName, memo around a function component,
      // and an anonymous forwardRef that has no name to read.
      attach("a", {
        $$typeof: Symbol.for("react.forward_ref"),
        render: Toolbar,
      });
      attach("b", { $$typeof: Symbol.for("react.memo"), type: Panel });
      attach("c", {
        $$typeof: Symbol.for("react.forward_ref"),
        render: () => null,
      });
    });
    const surface = await observeRenderedSurface(page);
    expect(surface?.components).toEqual(["Panel", "Toolbar"]);
  } finally {
    await page.close();
  }
});
