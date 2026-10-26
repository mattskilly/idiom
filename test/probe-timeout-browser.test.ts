import { type Browser, chromium, type Download, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { probeControls } from "../src/capture/probe.js";
import type { ProbeArtifact } from "../src/checks/types.js";
// @ts-expect-error Local JS fixture intentionally runs directly in Node too.
import { fixtureServer } from "./fixtures/probe-timeouts/server.mjs";

let browser: Browser;
let fixture: {
  url: string;
  counts: Map<string, number>;
  close(): Promise<void>;
};
beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await fixtureServer();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});
const restore = async (page: Page) => {
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
};
const find = (artifact: ProbeArtifact, selector: string) =>
  artifact.results.find((result) => result.selector === selector);

test.each([false, true])(
  "native UI and hanging routes finish once, then downstream controls run (intent %s)",
  async (respectControlIntent) => {
    fixture.counts.clear();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const downloads: Download[] = [];
      page.on("download", (download) => downloads.push(download));
      await restore(page);
      const events: string[] = [];
      const result = await probeControls({
        page,
        restore,
        skip: ["#menu"],
        maxControls: 30,
        waitMs: 30,
        controlTimeoutMs: 1800,
        stateTimeoutMs: 16000,
        respectControlIntent,
        onProbeProgress: (event) => events.push(event.phase),
      });
      expect(result.status, result.reason).toBe("ran");
      for (const [selector, effect] of [
        ["#print", "print"],
        ["#confirm", "dialog"],
        ["#fetch", "network"],
        ["#navigate", "navigation"],
        ["#alert", "dialog"],
        ["#prompt", "dialog"],
        ["#beforeunload", "navigation"],
        ["#popup", "popup"],
        ["#upload", "filechooser"],
        ["#download", "download"],
      ] as const) {
        const control = find(result, selector);
        expect(control, selector).toBeDefined();
        expect(
          control?.status === "timed-out" || control?.effects.includes(effect),
          selector,
        ).toBe(true);
        expect(control?.elapsedMs, selector).toBeLessThan(2100);
        expect(
          fixture.counts.get(selector.slice(1)) ?? 0,
          selector,
        ).toBeLessThanOrEqual(1);
      }
      expect(find(result, "#working")?.effects).toContain("dom");
      expect(find(result, "#dead")?.effects).toEqual([]);
      expect(context.pages()).toHaveLength(1);
      expect(downloads).toHaveLength(1);
      expect(await downloads[0]?.failure()).toMatch(/cancel/i);
      expect(await context.pages()[0]?.locator("#file").inputValue()).toBe("");
      expect(events[0]).toBe("initialization");
      expect(events.at(-1)).toBe("complete");
    } finally {
      await context.close();
    }
  },
  25000,
);

test("a hung restore retires its page, keeps earlier evidence, and never resumes against the replacement", async () => {
  const context = await browser.newContext();
  let release!: () => void;
  try {
    const page = await context.newPage();
    const html =
      '<button id="first" onclick="this.textContent=\'done\'">First</button><button id="hung">Hung</button><button id="last" onclick="this.textContent=\'done\'">Last</button>';
    await page.setContent(html);
    let calls = 0;
    let retired: Page | undefined;
    const result = await probeControls({
      page,
      skip: [],
      maxControls: 10,
      waitMs: 0,
      controlTimeoutMs: 700,
      // The independent replay budget is 15s. Leave room for its expiry
      // and a replacement attempt, rather than expiring the whole state first.
      stateTimeoutMs: 25000,
      restore: async (active) => {
        calls += 1;
        if (calls === 1) {
          retired = active;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        await active.setContent(html);
      },
    });
    expect(find(result, "#first")?.status).toBe("completed");
    expect(find(result, "#hung")).toMatchObject({
      status: "timed-out",
      timeoutScope: "control",
      skipped: expect.stringContaining("timed-out"),
      persistent: true,
    });
    expect(find(result, "#last")?.effects).toContain("dom");
    const snapshot = JSON.stringify(result);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(JSON.stringify(result)).toBe(snapshot);
    await expect(async () =>
      retired?.evaluate(() => document.title),
    ).rejects.toThrow();
    expect(context.pages()).toHaveLength(1);
  } finally {
    release?.();
    await context.close();
  }
}, 30000);

test("waitMs is part of the control budget and timeouts do not retry", async () => {
  const context = await browser.newContext();
  try {
    fixture.counts.clear();
    const page = await context.newPage();
    await restore(page);
    const result = await probeControls({
      page,
      restore,
      skip: [],
      maxControls: 2,
      waitMs: 2000,
      controlTimeoutMs: 500,
      stateTimeoutMs: 2500,
    });
    // Every control past maxControls is reported, never silently dropped.
    const attempted = result.results.filter(
      (control) => control.status !== "not-reached",
    );
    expect(attempted).toHaveLength(2);
    expect(
      result.results
        .filter((control) => control.status === "not-reached")
        .every(
          (control) =>
            control.skipped === "not reached: checks.probe.maxControls",
        ),
    ).toBe(true);
    expect(
      attempted.every(
        (control) => control.status === "timed-out" && !control.signature,
      ),
    ).toBe(true);
    // Click-audit beacons are asynchronous, so the last one can land after
    // the probe has already returned.
    await expect.poll(() => fixture.counts.get("print")).toBe(1);
    await expect.poll(() => fixture.counts.get("confirm")).toBe(1);
  } finally {
    await context.close();
  }
}, 6000);

test("state expiration before enumeration records html and returns promptly", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await restore(page);
    const evaluate = page.evaluate.bind(page);
    page.evaluate = (() => new Promise(() => {})) as Page["evaluate"];
    const started = performance.now();
    const result = await probeControls({
      page,
      restore,
      skip: [],
      maxControls: 10,
      waitMs: 0,
      controlTimeoutMs: 2000,
      stateTimeoutMs: 100,
    });
    expect(result).toMatchObject({
      status: "timed-out",
      selector: "html",
      results: [],
    });
    expect(performance.now() - started).toBeLessThan(600);
    page.evaluate = evaluate;
  } finally {
    await context.close();
  }
}, 3000);

test("state budget wins inside a control and preserves its selector", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await restore(page);
    // Keep the first action active so the state deadline, rather than the
    // quiet-window shortcut, ends its observation. Native print is suppressed.
    await page.locator("#print").evaluate((button) => {
      button.addEventListener("click", () => {
        let tick = 0;
        setInterval(() => {
          button.setAttribute("data-tick", String(++tick));
        }, 25);
      });
    });
    const result = await probeControls({
      page,
      restore,
      skip: [],
      maxControls: 10,
      waitMs: 3000,
      controlTimeoutMs: 5000,
      stateTimeoutMs: 600,
    });
    expect(result).toMatchObject({ status: "timed-out", selector: "#print" });
    const attempted = result.results.filter(
      (control) => control.status !== "not-reached",
    );
    expect(attempted).toHaveLength(1);
    expect(attempted[0]).toMatchObject({
      selector: "#print",
      status: "timed-out",
      timeoutScope: "state",
    });
    // The rest of the queue is reported as unreached, not dropped.
    expect(result.results.length).toBeGreaterThan(1);
    expect(
      result.results
        .slice(1)
        .every(
          (control) =>
            control.status === "not-reached" &&
            /^not reached: (?:state budget|checks\.probe\.maxControls)$/.test(
              control.skipped ?? "",
            ),
        ),
    ).toBe(true);
    expect(
      result.results.some(
        (control) => control.skipped === "not reached: state budget",
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
}, 3000);

test("nested menu restoration consumes the item's budget and later controls survive", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const html =
      '<button id="menu" onclick="document.querySelector(\'#items\').hidden=false">Menu</button><div id="items" role="menu" aria-label="Tools" hidden><button id="nested" role="menuitem">Nested</button></div><button id="last" onclick="this.textContent=\'worked\'">Last</button>';
    await page.setContent(html);
    let restores = 0;
    const result = await probeControls({
      page,
      skip: [],
      maxControls: 5,
      waitMs: 0,
      controlTimeoutMs: 800,
      stateTimeoutMs: 5000,
      restore: async (active) => {
        restores += 1;
        if (restores === 1) await new Promise(() => {});
        await active.setContent(html);
      },
    });
    expect(find(result, "#nested")).toMatchObject({
      status: "timed-out",
      persistent: false,
      timeoutScope: "control",
    });
    expect(find(result, "#last")?.effects).toContain("dom");
  } finally {
    await context.close();
  }
}, 8000);

test("visible explanation timeout shares the click budget and never clicks that control", async () => {
  const context = await browser.newContext();
  const clicks: string[] = [];
  await context.exposeFunction("recordClick", (id: string) => clicks.push(id));
  try {
    const page = await context.newPage();
    const html =
      // Hovering the glyph persists a change, so its focus sample needs the
      // (hung) full replay rather than the cheap restore ladder.
      '<button id="glyph" aria-label="Help" onmouseenter="document.body.dataset.visited=\'yes\'" onclick="window.recordClick(\'glyph\')">?</button><button id="last" onclick="window.recordClick(\'last\');this.textContent=\'worked\'">Last</button>';
    await page.setContent(html);
    let restores = 0;
    const result = await probeControls({
      page,
      skip: [],
      maxControls: 5,
      waitMs: 0,
      explanation: "visible",
      controlTimeoutMs: 800,
      stateTimeoutMs: 5000,
      restore: async (active) => {
        restores += 1;
        if (restores === 1) await new Promise(() => {});
        await active.setContent(html);
      },
    });
    expect(find(result, "#glyph")).toMatchObject({ status: "timed-out" });
    expect(find(result, "#last")?.status).toBe("completed");
    expect(clicks).toEqual(["last"]);
    expect(result.explanations?.status).toBe("partial");
  } finally {
    await context.close();
  }
}, 8000);

test("read-only collection timeout names the actual trigger and retains incomplete coverage", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const html =
      '<ul><li id="item">Document<button id="more" aria-haspopup="menu" onclick="document.querySelector(\'#items\').hidden=false">More</button></li></ul><div id="items" role="menu" hidden><button role="menuitem" onclick="throw Error(\'must never click\')">Delete</button></div>';
    await page.setContent(html);
    let restores = 0;
    const result = await probeControls({
      page,
      skip: ["button"],
      collections: ["#item"],
      maxControls: 5,
      waitMs: 0,
      controlTimeoutMs: 700,
      stateTimeoutMs: 5000,
      restore: async (active) => {
        restores += 1;
        if (restores === 2) await new Promise(() => {});
        await active.setContent(html);
      },
    });
    expect(find(result, "#more")).toMatchObject({
      status: "timed-out",
      timeoutScope: "control",
    });
    expect(result.collections?.[0]?.reason).toContain("#more");
    expect(result.results.some((result) => result.name === "Delete")).toBe(
      false,
    );
  } finally {
    await context.close();
  }
}, 8000);

test("control evaluation can never settle while its replacement finishes", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const html =
      '<button id="hung">Hung</button><button id="last" onclick="this.textContent=\'worked\'">Last</button>';
    await page.setContent(html);
    const evaluate = page.evaluate.bind(page);
    page.evaluate = ((fn: unknown, ...args: unknown[]) => {
      if (String(fn).includes("navigator.clipboard"))
        return new Promise(() => {});
      return (evaluate as (...args: unknown[]) => Promise<unknown>)(
        fn,
        ...args,
      );
    }) as Page["evaluate"];
    const result = await probeControls({
      page,
      skip: [],
      maxControls: 5,
      waitMs: 0,
      controlTimeoutMs: 700,
      stateTimeoutMs: 4000,
      restore: async (active) => {
        await active.setContent(html);
      },
    });
    expect(find(result, "#hung")?.status).toBe("timed-out");
    expect(find(result, "#last")?.effects).toContain("dom");
  } finally {
    await context.close();
  }
}, 7000);

test("timeout evidence cannot create dead-control or duplicate-entry findings", async () => {
  const { observePage } = await import("../src/checks/observe.js");
  const { deadControlCheck } = await import("../src/checks/dead-control.js");
  const { duplicateEntryCheck } = await import(
    "../src/checks/duplicate-entry.js"
  );
  const page = await browser.newPage();
  try {
    await page.setContent('<button id="hung">Hung</button>');
    const observations = await observePage(page, { status: "not-configured" });
    if (observations.version !== 2) throw new Error("missing V2 evidence");
    observations.probe = {
      status: "timed-out",
      reason: "state timed-out: #hung",
      results: [
        {
          selector: "#hung",
          name: "Hung",
          persistent: true,
          effects: [],
          elapsedMs: 500,
          status: "timed-out",
          timeoutScope: "state",
          skipped: "timed-out: observe",
        },
      ],
    };
    const context = { tuple: { observations } } as Parameters<
      typeof deadControlCheck.run
    >[0];
    expect(deadControlCheck.run(context)).toMatchObject({
      candidates: [],
      coverage: { reason: "state timed-out: #hung" },
    });
    expect(duplicateEntryCheck.run(context).candidates).toEqual([]);
    observations.probe.results.push({
      selector: "#dead",
      name: "Dead",
      persistent: true,
      effects: [],
    });
    for (const selector of ["#one", "#two"])
      observations.probe.results.push({
        selector,
        name: "Settings",
        persistent: true,
        effects: ["dom"],
        signature: "open:dialog:Settings",
      });
    expect(
      deadControlCheck
        .run(context)
        .candidates.map((result) => result.selectorHint),
    ).toEqual(["#dead"]);
    expect(duplicateEntryCheck.run(context).candidates).toHaveLength(1);
  } finally {
    await page.close();
  }
});

test("static DOM, observations and screenshot are saved before the disposable probe", async () => {
  const { createBrowserLauncher } = await import("../src/capture/browser.js");
  const { projectSchema } = await import("../src/schemas/project.js");
  const { flowSchema } = await import("../src/schemas/flow.js");
  let screenshotSaved = false;
  let initialProgress = false;
  const project = projectSchema.parse({
    version: 1,
    app: { name: "Fixture", framework: "other" },
    server: {
      port: Number(new URL(fixture.url).port),
      readyUrl: fixture.url,
      build: "unused",
      start: "unused",
      env: {},
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: { settleMs: 0 },
    checks: { probe: { maxControls: 2, waitMs: 0 } },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "fixture",
    title: "Fixture",
    intent: [],
    setup: [],
    states: [{ id: "editor", description: "Editor", url: "/", expect: {} }],
  });
  const session = await createBrowserLauncher({
    createAxe: (page) => {
      const screenshot = page.screenshot.bind(page);
      page.screenshot = (async (options) => {
        const image = await screenshot(options);
        screenshotSaved = true;
        return image;
      }) as Page["screenshot"];
      return { analyze: async () => ({ violations: [] }) };
    },
  })();
  try {
    const state = flow.states[0];
    const viewport = project.viewports[0];
    if (!state || !viewport) throw new Error("missing fixture coordinate");
    const result = await session.capture({
      project,
      state,
      viewport,
      navigationUrl: fixture.url,
      probe: true,
      onProbeProgress: (event) => {
        if (event.phase === "initialization") {
          initialProgress = true;
          expect(screenshotSaved).toBe(true);
        }
      },
    });
    expect(result.ok).toBe(true);
    expect(initialProgress).toBe(true);
    expect(result.screenshot?.length).toBeGreaterThan(100);
    expect(result.dom).toContain('id="spinner" role="status" hidden=""');
    expect(
      result.observations?.version === 2 &&
        result.observations.probe?.results[0]?.effects,
    ).toContain("print");
  } finally {
    await session.close();
  }
}, 7000);
