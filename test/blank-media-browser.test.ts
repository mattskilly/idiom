import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import {
  disposeLoadingObservation,
  readLoadingObservation,
  startLoadingObservation,
} from "../src/capture/loading-stuck.js";
import { collectPageEvidence } from "../src/capture/page.js";
import { captureScreenshot } from "../src/capture/screenshot.js";
import { sampleBlankMedia } from "../src/capture/visual-blank.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { loadingStuckCheck } from "../src/checks/loading-stuck.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { visualBlankCheck } from "../src/checks/visual-blank.js";
import { inventoryBlankMedia } from "../src/checks/visual-blank-dom.js";
import { flowSchema, isWebFlow } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { evidenceTuple } from "./blank-media-support.js";

const config = checksConfigFrom();
const fixture = (name: string) =>
  readFile(join(import.meta.dirname, "fixtures/blank-media", name), "utf8");
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});
async function media(page: Page, masks: string[] = []) {
  const inventory = await inventoryBlankMedia(
    page,
    [".configured-swatch"],
    masks,
  );
  const shot = await captureScreenshot(page, { fullPage: true });
  return sampleBlankMedia(
    inventory,
    () => PNG.sync.read(shot.buffer),
    640,
    shot.geometry,
  );
}
function state(changes = {}) {
  const flow = flowSchema.parse({
    id: "blank",
    title: "Blank",
    setup: [],
    intent: [],
    states: [
      { id: "normal", description: "Normal", url: "/", expect: {}, ...changes },
    ],
  });
  if (!isWebFlow(flow) || !flow.states[0]) throw Error("web state");
  return flow.states[0];
}

test("real composited media inventory detects lone blanks and preserves passing near misses", async () => {
  const page = await browser.newPage({
    viewport: { width: 680, height: 1200 },
    deviceScaleFactor: 2,
  });
  try {
    await page.setContent(await fixture("surfaces.html"));
    await page
      .locator("#real-thumbnail")
      .evaluate((el: HTMLImageElement) => el.decode());
    const evidence = await media(page, [
      "#masked-wrapper",
      "#mask-intersection",
    ]);
    const result = visualBlankCheck.run({
      tuple: evidenceTuple({ visualBlank: evidence }),
      config,
      tuples: [],
      narrowViewport: false,
    });
    const selectors = result.candidates.map((c) => c.selectorHint).sort();
    expect(selectors).toEqual(
      [
        "#empty-canvas",
        "#blank-frame",
        "#empty-video",
        "#blank-picture",
        "#blank-background",
        "#placeholder",
        "#transparent",
        "#covered",
        "#pseudo-covered",
        "#boundary",
      ].sort(),
    );
    expect(result.candidates.every((c) => c.severity === "minor")).toBe(true);
    expect(
      evidence.records.find((r) => r.selector === "#inline-picture")?.kind,
    ).toBe("picture");
    expect(
      evidence.records.find((r) => r.selector === "#scaled-painted")?.pixels,
    ).toBeDefined();
    expect(
      evidence.records.find((r) => r.selector === "#paint-contained"),
    ).toBeUndefined();
    expect(
      evidence.records.find((r) => r.selector === "#fixed-escape")?.pixels,
    ).toBeDefined();
    expect(
      evidence.records.find((r) => r.selector === "#contents-child")?.pixels,
    ).toBeDefined();
    expect(
      evidence.records.find(
        (r) => r.selector === 'canvas[data-testid="durable-surface"]',
      )?.pixels,
    ).toBeDefined();
    expect(
      evidence.records.find((r) => r.selector === "#covered")?.overlay,
    ).toMatchObject({ alpha: 0.98, coverage: 1 });
    expect(
      evidence.records.find((r) => r.selector === "#transparent")?.opacity,
    ).toBe(0.005);
    expect(
      evidence.records.find((r) => r.selector === "#swatch")?.exempt,
    ).toContain("colour");
    expect(
      evidence.records.find((r) => r.selector === "#configured")?.exempt,
    ).toContain("configured");
    expect(
      evidence.records.filter((r) =>
        [
          "#hidden",
          "#clipped",
          "#too-small",
          "#too-short",
          "#populated",
        ].includes(r.selector),
      ),
    ).toEqual([]);
    expect(evidence.records.find((r) => r.selector === "#masked")?.masked).toBe(
      true,
    );
    expect(
      evidence.records.find((r) => r.selector === "#intersecting-mask")?.masked,
    ).toBe(true);
    const tuple = evidenceTuple({ visualBlank: evidence });
    const offline = observationArtifactSchema.parse(
      JSON.parse(JSON.stringify(tuple.observations)),
    );
    expect(
      visualBlankCheck.run({
        tuple: { ...tuple, observations: offline },
        config,
        tuples: [],
        narrowViewport: false,
      }).candidates,
    ).toEqual(result.candidates);
  } finally {
    await page.close();
  }
});

test("continuous observer records resolved, hidden, replaced and late indicators independently", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(await fixture("loading.html"));
    await startLoadingObservation(page, 500, []);
    await page.evaluate(() => {
      document.querySelector("#resolves")?.setAttribute("aria-busy", "false");
      document.querySelector("#removed")?.remove();
      (document.querySelector("#hidden-later") as HTMLElement).style.display =
        "none";
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      document
        .querySelector("#replacement")
        ?.replaceWith(
          document.querySelector("#replacement")?.cloneNode(true) as Node,
        );
      const late = document.createElement("div");
      late.id = "late";
      late.className = "spinner";
      document.body.append(late);
    });
    const evidence = await readLoadingObservation(page, true);
    if (!evidence) throw Error("observer");
    const result = loadingStuckCheck.run({
      tuple: evidenceTuple({ loadingStuck: evidence }),
      config,
      tuples: [],
      narrowViewport: false,
    });
    expect(result.candidates.map((c) => c.selectorHint).sort()).toEqual(
      [
        "#spinner",
        "#skeleton",
        "#labelled-skeleton",
        "#busy",
        "#progress",
        "#native",
        "#nested",
      ].sort(),
    );
    expect(
      evidence.records.filter((r) => r.selector === "#replacement"),
    ).toHaveLength(2);
    expect(
      evidence.records.find((r) => r.selector === "#resolves"),
    ).toMatchObject({ active: false });
    expect(
      evidence.records.find((r) => r.selector === "#late")?.ageMs,
    ).toBeLessThan(500);
    await disposeLoadingObservation(page);
    expect(await readLoadingObservation(page)).toBeUndefined();
  } finally {
    await page.close();
  }
});

test("an initially empty observation window does not give late indicators a full age", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<body>Ready</body>");
    await startLoadingObservation(page, 200, []);
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "spinner";
      el.style.cssText = "width:30px;height:30px";
      document.body.append(el);
    });
    const evidence = await readLoadingObservation(page, true);
    if (!evidence) throw Error("observer");
    expect(evidence.observedMs).toBeGreaterThanOrEqual(200);
    expect(
      loadingStuckCheck.run({
        tuple: evidenceTuple({ loadingStuck: evidence }),
        config,
        tuples: [],
        narrowViewport: false,
      }).candidates,
    ).toEqual([]);
  } finally {
    await disposeLoadingObservation(page);
    await page.close();
  }
});

test("primary capture reaches hung resources through DOM readiness and explicit waits (default 5000ms)", async () => {
  const html = await fixture("hung.html");
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/never")) return;
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const url = `http://127.0.0.1:${address.port}`;
  const session = await createBrowserLauncher({
    launch: async () => browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  try {
    const project = projectSchema.parse({
      version: 1,
      app: { name: "Pending", framework: "other" },
      design: {},
      server: {
        env: {},
        build: "true",
        start: "true",
        port: address.port,
        readyUrl: url,
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: { settleMs: 0 },
      model: { provider: "anthropic", model: "unused" },
    });
    const viewport = project.viewports[0];
    if (!viewport) throw Error("viewport");
    const result = await session.capture({
      project,
      viewport,
      navigationUrl: url,
      state: state({ steps: [{ action: "waitFor", selector: "#ready" }] }),
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.screenshot?.length).toBeGreaterThan(100);
    if (result.observations?.version !== 2) throw Error("observations");
    expect(result.observations.loadingStuck).toMatchObject({
      status: "ran",
      windowMs: 5000,
      intentional: false,
    });
    expect(result.observations.loadingStuck?.observedMs).toBeGreaterThanOrEqual(
      5000,
    );
    const tuple = { ...evidenceTuple(), observations: result.observations };
    expect(
      visualBlankCheck
        .run({ tuple, config, tuples: [], narrowViewport: false })
        .candidates.map((c) => c.selectorHint)
        .sort(),
    ).toEqual(["#hung-iframe", "#hung-thumbnail", "#tinted"]);
    expect(
      loadingStuckCheck
        .run({ tuple, config, tuples: [], narrowViewport: false })
        .candidates.map((c) => c.selectorHint),
    ).toEqual(["#tinted"]);
  } finally {
    // BrowserSession owns the injected browser. Close the pages, keep the shared
    // browser alive for the remaining tests, and destroy all hanging HTTP sockets.
    for (const context of browser.contexts()) await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20000);

test("without the loading window, capture waits for load so a slow valid image is not blank", async () => {
  const image = PNG.sync.write(
    Object.assign(new PNG({ width: 200, height: 120 }), {
      data: Buffer.from(
        Array.from({ length: 200 * 120 }, (_, i) => [
          (i * 7) % 256,
          (i * 13) % 256,
          (i % 200) + 40,
          255,
        ]).flat(),
      ),
    }),
  );
  const server = createServer((request, response) => {
    if (request.url === "/hero.png") {
      setTimeout(() => {
        response.setHeader("Content-Type", "image/png");
        response.end(image);
      }, 3000);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><html lang="en"><title>Slow</title><body style="background:#fff"><img id="hero" alt="Hero" src="/hero.png" width="400" height="240"></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const url = `http://127.0.0.1:${address.port}`;
  const session = await createBrowserLauncher({
    launch: async () => browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  try {
    const project = projectSchema.parse({
      version: 1,
      app: { name: "Slow", framework: "other" },
      design: {},
      server: {
        env: {},
        build: "true",
        start: "true",
        port: address.port,
        readyUrl: url,
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: { settleMs: 0 },
      checks: { loadingStuck: { enabled: false } },
      model: { provider: "anthropic", model: "unused" },
    });
    const viewport = project.viewports[0];
    if (!viewport) throw Error("viewport");
    const result = await session.capture({
      project,
      viewport,
      navigationUrl: url,
      state: state(),
    });
    expect(result.ok).toBe(true);
    if (result.observations?.version !== 2) throw Error("observations");
    expect(result.observations.loadingStuck).toBeUndefined();
    expect(
      result.observations.visualBlank?.records.find(
        (r) => r.selector === "#hero",
      )?.pixels,
    ).toBeDefined();
    const tuple = { ...evidenceTuple(), observations: result.observations };
    expect(
      visualBlankCheck.run({ tuple, config, tuples: [], narrowViewport: false })
        .candidates,
    ).toEqual([]);
  } finally {
    for (const context of browser.contexts()) await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20000);

async function collect(
  page: Page,
  changes: Partial<Parameters<typeof collectPageEvidence>[0]> = {},
) {
  return collectPageEvidence({
    page,
    state: state(),
    settleMs: 0,
    animationSettleMs: 0,
    reachStage: "state",
    reach: async () => 200,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    collectConsole: async () => [],
    tokens: { status: "not-configured" },
    screenshotOptions: { fullPage: true },
    now: () => new Date(),
    observe: { loadingStuck: true, visualBlank: config.visualBlank },
    ...changes,
  });
}
test("intentional loading exempts only loading and state evidence freezes before probe", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<canvas id="blank" width="160" height="100"></canvas><div class="spinner" style="width:20px;height:20px"></div>',
    );
    const result = await collect(page, {
      state: state({ loading: true }),
      probe: async () => {
        await page.evaluate(() => document.querySelector("canvas")?.remove());
        return { status: "ran", results: [] };
      },
    });
    expect(result.ok).toBe(true);
    if (result.observations?.version !== 2) throw Error("observations");
    expect(result.observations.loadingStuck?.intentional).toBe(true);
    expect(
      visualBlankCheck.run({
        tuple: { ...evidenceTuple(), observations: result.observations },
        config,
        tuples: [],
        narrowViewport: false,
      }).candidates,
    ).toHaveLength(1);
    expect(await readLoadingObservation(page)).toBeUndefined();
  } finally {
    await page.close();
  }
});
test("abort during loading wait disconnects the observer", async () => {
  const page = await browser.newPage(),
    controller = new AbortController();
  try {
    await page.setContent(
      '<div class="spinner" style="width:20px;height:20px"></div>',
    );
    const timer = setTimeout(
      () => controller.abort(new Error("cancel loading")),
      150,
    );
    try {
      await expect(
        collect(page, { signal: controller.signal }),
      ).rejects.toThrow("cancel loading");
    } finally {
      clearTimeout(timer);
    }
    expect(await readLoadingObservation(page)).toBeUndefined();
  } finally {
    await page.close();
  }
});

test("poster and painted video frames pass screenshot analysis", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<canvas id="source" width="160" height="100"></canvas><video id="poster" width="160" height="100"></video><video id="frame" muted width="160" height="100"></video>',
    );
    await page.evaluate(async () => {
      const source = document.querySelector<HTMLCanvasElement>("#source");
      if (!source) throw Error("canvas");
      const ctx = source.getContext("2d");
      if (!ctx) throw Error("ctx");
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, 80, 100);
      ctx.fillStyle = "blue";
      ctx.fillRect(80, 0, 80, 100);
      const poster = document.querySelector<HTMLVideoElement>("#poster"),
        frame = document.querySelector<HTMLVideoElement>("#frame");
      if (!poster || !frame) throw Error("videos");
      poster.poster = source.toDataURL();
      frame.srcObject = source.captureStream(30);
      const painted = new Promise<void>((resolve) =>
        frame.requestVideoFrameCallback(() => resolve()),
      );
      await frame.play();
      await painted;
    });
    const evidence = await media(page);
    expect(
      evidence.records.find((r) => r.selector === "#poster")?.video?.poster,
    ).toBe(true);
    expect(
      evidence.records.find((r) => r.selector === "#frame")?.video?.frame,
    ).toBe(true);
    expect(
      visualBlankCheck.run({
        tuple: evidenceTuple({ visualBlank: evidence }),
        config,
        tuples: [],
        narrowViewport: false,
      }).candidates,
    ).toEqual([]);
  } finally {
    await page.close();
  }
});

test("capture replaces an earlier screenshot after loading observation; final evidence stays separate from probe", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<canvas id="media" width="160" height="100"></canvas>',
    );
    const earlier = await page.screenshot();
    const result = await collect(page, {
      state: state({ loadingSettleMs: 150 }),
      reuseScreenshot: earlier,
      reach: async () => {
        await page.evaluate(() => {
          const c = document.querySelector("canvas");
          const ctx = c?.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "red";
            ctx.fillRect(0, 0, 80, 100);
            ctx.fillStyle = "blue";
            ctx.fillRect(80, 0, 80, 100);
          }
        });
        return 200;
      },
      probe: async () => {
        await page.evaluate(() => {
          const d = document.createElement("div");
          d.className = "spinner";
          d.style.cssText = "width:30px;height:30px";
          document.body.append(d);
        });
        return { status: "ran", results: [] };
      },
    });
    expect(result.ok).toBe(true);
    if (result.observations?.version !== 2) throw Error("observations");
    expect(result.screenshot?.equals(earlier)).toBe(false);
    expect(
      result.observations.visualBlank?.records[0]?.pixels?.dominantShare,
    ).toBeLessThan(0.995);
    expect(result.observations.loadingStuck?.records).toEqual([]);
    expect(await readLoadingObservation(page)).toBeUndefined();
  } finally {
    await page.close();
  }
});

test("observer ends intervals on value acquisition and busy toggles, and preserves continuous class updates", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<progress id="progress"></progress><div id="busy" aria-busy="true">Content</div><div id="spinner" class="spinner" style="width:20px;height:20px"></div>',
    );
    await startLoadingObservation(page, 150, []);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      document.querySelector("#progress")?.setAttribute("value", ".4");
      const busy = document.querySelector("#busy");
      busy?.setAttribute("aria-busy", "false");
      busy?.setAttribute("aria-busy", "true");
      document.querySelector("#spinner")?.classList.add("active");
    });
    const evidence = await readLoadingObservation(page, true);
    if (!evidence) throw Error("observer");
    expect(evidence.records.filter((r) => r.selector === "#busy")).toHaveLength(
      2,
    );
    expect(
      evidence.records.find((r) => r.selector === "#progress")?.active,
    ).toBe(false);
    expect(
      loadingStuckCheck
        .run({
          tuple: evidenceTuple({ loadingStuck: evidence }),
          config,
          tuples: [],
          narrowViewport: false,
        })
        .candidates.map((c) => c.selectorHint),
    ).toEqual(["#spinner"]);
  } finally {
    await disposeLoadingObservation(page);
    await page.close();
  }
});

test("collector failure cleans the observer; disabled loading adds no scan", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<div class="spinner" style="width:20px;height:20px"></div>',
    );
    const failed = await collect(page, {
      state: state({ loadingSettleMs: 50 }),
      createAxe: () => ({
        analyze: async () => {
          throw Error("collector failure");
        },
      }),
    });
    expect(failed.ok).toBe(false);
    expect(await readLoadingObservation(page)).toBeUndefined();
    const disabled = await collect(page, {
      observe: { loadingStuck: false, visualBlank: config.visualBlank },
    });
    expect(disabled.ok).toBe(true);
    if (disabled.observations?.version !== 2) throw Error("observations");
    expect(disabled.observations.loadingStuck).toBeUndefined();
    expect(await readLoadingObservation(page)).toBeUndefined();
  } finally {
    await page.close();
  }
});

test("resolved indicators retain final mask membership for conservative acceptance", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<section><div id="busy" aria-busy="true">Loading content</div></section>',
    );
    await startLoadingObservation(page, 100, [".masked"]);
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      document.querySelector("#busy")?.setAttribute("aria-busy", "false");
      document.querySelector("section")?.classList.add("masked");
    });
    const evidence = await readLoadingObservation(page, true);
    expect(evidence?.records).toMatchObject([
      { selector: "#busy", active: false, masked: true },
    ]);
  } finally {
    await disposeLoadingObservation(page);
    await page.close();
  }
});
