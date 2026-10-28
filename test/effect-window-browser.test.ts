import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  beginEffectWindow,
  LATE_CONTENT_WINDOW_MS,
} from "../src/capture/effect-window.js";
import { TimelineCollector } from "../src/capture/timeline.js";

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

/**
 * The probe's late-content window (file-198): a click whose own request is
 * still in flight at the bound waits for it, so content that arrives after
 * 500ms lands inside the click's action timeline.
 */
async function lateContentPage(delayMs: number | "never") {
  const page = await browser.newPage();
  await page.route("https://late.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><style>body{margin:0;font:16px sans-serif}</style>
        <button id="load">Load</button><div id="slot"></div><p id="after">After</p>
        <button id="noop">Nothing</button>
        <script>
          document.getElementById("load").addEventListener("click", async () => {
            const text = await (await fetch("/data")).text();
            const block = document.createElement("div");
            block.id = "late";
            block.style.height = "80px";
            block.textContent = text;
            document.getElementById("slot").append(block);
          });
        </script>`,
    }),
  );
  await page.route("https://late.test/data", async (route) => {
    if (delayMs === "never") return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ body: "Results" }).catch(() => undefined);
  });
  await page.goto("https://late.test/");
  return page;
}

test("a click's own request extends the window until its content arrives", async () => {
  const page = await lateContentPage(700);
  try {
    const collector = new TimelineCollector(page);
    const recording = await collector.start({
      source: "probe-click",
      kind: "click",
      selector: "#load",
      name: "Load",
    });
    const window = await beginEffectWindow(page, 150, {
      pendingMs: LATE_CONTENT_WINDOW_MS,
    });
    const started = performance.now();
    let settled: boolean;
    try {
      await page.locator("#load").click({ noWaitAfter: true });
      settled = await window.wait();
      await recording.finish(undefined, settled);
    } finally {
      await window.dispose();
      await recording.dispose();
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThan(700);
    expect(elapsed).toBeLessThan(1300);
    expect(settled).toBe(true);
    const [action] = collector.evidence().actions;
    const late = action?.mutations.find((entry) => entry.selector === "#late");
    expect(late?.time).toBeGreaterThan(500);
    expect(action?.shifts.length).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});

test("a click without a request still ends at its bound", async () => {
  const page = await lateContentPage(700);
  try {
    const window = await beginEffectWindow(page, 150, {
      pendingMs: LATE_CONTENT_WINDOW_MS,
    });
    const started = performance.now();
    try {
      await page.locator("#noop").click({ noWaitAfter: true });
      await window.wait();
    } finally {
      await window.dispose();
    }
    expect(performance.now() - started).toBeLessThan(600);
  } finally {
    await page.close();
  }
});

test("a request that never resolves ends the window at the late-content bound, unsettled", async () => {
  const page = await lateContentPage("never");
  try {
    const window = await beginEffectWindow(page, 150, {
      pendingMs: LATE_CONTENT_WINDOW_MS,
    });
    const started = performance.now();
    let settled: boolean;
    try {
      await page.locator("#load").click({ noWaitAfter: true });
      settled = await window.wait();
    } finally {
      await window.dispose();
    }
    const elapsed = performance.now() - started;
    expect(settled).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(LATE_CONTENT_WINDOW_MS - 50);
    expect(elapsed).toBeLessThan(LATE_CONTENT_WINDOW_MS + 600);
  } finally {
    await page.close();
  }
});

/**
 * Analytics in the probe window (file-198): beacons, keepalive fetches
 * nothing awaits and requests to well-known analytics endpoints are not
 * content, so they never extend a click's late-content window.
 */
async function beaconPage(handler: string) {
  const page = await browser.newPage();
  await page.route("https://beacon.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><button id="go">Go</button><div id="slot"></div>
        <script>document.getElementById("go").addEventListener("click", ${handler});</script>`,
    }),
  );
  const slow = async (route: import("playwright").Route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ body: "ok" }).catch(() => undefined);
  };
  await page.route("https://beacon.test/collect", slow);
  await page.route("https://beacon.test/data", slow);
  await page.route("https://www.google-analytics.com/**", slow);
  await page.goto("https://beacon.test/");
  return page;
}
async function clickWindow(handler: string) {
  const page = await beaconPage(handler);
  try {
    const effect = await beginEffectWindow(page, 150, {
      pendingMs: LATE_CONTENT_WINDOW_MS,
    });
    const started = performance.now();
    try {
      await page.locator("#go").click({ noWaitAfter: true });
      await effect.wait();
    } finally {
      await effect.dispose();
    }
    const restored = await page.evaluate(
      () => !window.fetch.toString().includes("keepalive"),
    );
    return { elapsed: performance.now() - started, restored };
  } finally {
    await page.close();
  }
}

test.each([
  ["sendBeacon", `() => navigator.sendBeacon("/collect", "event")`],
  [
    "an unawaited keepalive fetch",
    `() => { fetch("/collect", { method: "POST", body: "e", keepalive: true }).catch(() => {}); }`,
  ],
  [
    "a known analytics endpoint",
    `() => { fetch("https://www.google-analytics.com/g/collect?v=2", { mode: "no-cors" }).catch(() => {}); }`,
  ],
])("%s does not extend the window", async (_name, handler) => {
  const { elapsed, restored } = await clickWindow(handler);
  expect(elapsed).toBeLessThan(900);
  expect(restored).toBe(true);
});

test.each([
  [
    "an awaited keepalive fetch",
    `async () => { const text = await (await fetch("/data", { keepalive: true })).text(); document.getElementById("slot").textContent = text; }`,
  ],
  [
    "a then()-read keepalive fetch",
    `() => { fetch("/data", { keepalive: true }).then((r) => r.text()).then((t) => { document.getElementById("slot").textContent = t; }); }`,
  ],
  [
    "a plain fetch",
    `async () => { const text = await (await fetch("/data")).text(); document.getElementById("slot").textContent = text; }`,
  ],
])("%s still extends the window", async (_name, handler) => {
  const { elapsed } = await clickWindow(handler);
  expect(elapsed).toBeGreaterThan(1400);
  expect(elapsed).toBeLessThan(LATE_CONTENT_WINDOW_MS + 600);
});
