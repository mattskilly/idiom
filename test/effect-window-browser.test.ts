import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { beginEffectWindow } from "../src/capture/effect-window.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

test("a quiet effect window ends early, while DOM activity resets it and continuous activity reaches its cap", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><p>Ready</p>");
    const quiet = await beginEffectWindow(page, 1000);
    const begun = performance.now();
    try {
      await quiet.wait();
    } finally {
      await quiet.dispose();
    }
    expect(performance.now() - begun).toBeLessThan(700);
    const active = await beginEffectWindow(page, 450);
    await page.evaluate(() => {
      const timer = setInterval(() => {
        const paragraph = document.querySelector("p");
        if (paragraph) paragraph.textContent = String(performance.now());
      }, 50);
      setTimeout(() => clearInterval(timer), 650);
    });
    const started = performance.now();
    try {
      await active.wait();
    } finally {
      await active.dispose();
    }
    expect(performance.now() - started).toBeGreaterThanOrEqual(425);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await page.evaluate(() => "__idiomQuiet" in window)).toBe(false);
  } finally {
    await page.close();
  }
});

test("pending network activity holds the effect window until it finishes", async () => {
  const page = await browser.newPage();
  try {
    await page.route("https://quiet.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><p>Ready</p>",
      }),
    );
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("https://quiet.test/data", async (route) => {
      await held;
      await route.fulfill({ body: "done" });
    });
    await page.goto("https://quiet.test/");
    const window = await beginEffectWindow(page, 1200);
    try {
      await page.evaluate(() => {
        void fetch("/data");
      });
      let completed = false;
      const waiting = window.wait().then(() => {
        completed = true;
      });
      await page.waitForTimeout(250);
      expect(completed).toBe(false);
      release?.();
      await waiting;
      expect(completed).toBe(true);
    } finally {
      release?.();
      await window.dispose();
    }
  } finally {
    await page.close();
  }
});
