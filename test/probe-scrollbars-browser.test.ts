import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  captureReferenceUrl,
  createBrowserLauncher,
} from "../src/capture/browser.js";
import { probeControls } from "../src/capture/probe.js";
import {
  ScrollbarController,
  scrollbarLaunchOptions,
} from "../src/capture/scrollbars.js";
import type { BrowserLauncher, TupleResult } from "../src/capture/types.js";
import { scrollbarShift } from "../src/checks/interaction-shift.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type {
  ActionTimelineArtifact,
  ObservationArtifactV2,
} from "../src/checks/types.js";
import { flowSchema } from "../src/schemas/flow.js";
import { type ColorScheme, projectSchema } from "../src/schemas/project.js";
import { tupleFor } from "./motion-support.js";

/**
 * Probe clicks see real layout scrollbars, through the production capture
 * path, while state capture keeps today's scrollbar-free pixels.
 */
const fixtures = fileURLToPath(
  new URL("fixtures/benchmark/interaction-shift-scrollbar/", import.meta.url),
);

const tall = (head: string, body = "") =>
  `<!doctype html><html><head><style>body{margin:0;font:16px/1.5 system-ui}section{height:2400px;background:linear-gradient(#e0f0ff,#204060)}</style>${head}</head><body><h1>Plans</h1>${body}<section></section></body></html>`;
const short = `<!doctype html><html><head><style>body{margin:0;font:16px/1.5 system-ui}</style></head><body><h1>Plans</h1><p>Fits the viewport.</p></body></html>`;
// Same lock as before.html, with authored scrollbar styling ahead of it.
const authored = (css: string, html: string) =>
  html.replace("<head>", `<head><style>${css}</style>`);
const csp =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'";

const pages = new Map<string, { html: string; headers?: object }>();
const hits = new Map<string, number>();
const measured: string[] = [];
let server: ReturnType<typeof createServer>;
let origin: string;
let browser: Browser;
beforeAll(async () => {
  const read = (name: string) => readFile(join(fixtures, name), "utf8");
  const before = await read("before.html");
  for (const name of ["before", "after", "compensated", "compensated-scroller"])
    pages.set(`/${name}`, { html: await read(`${name}.html`) });
  pages.set("/styled", {
    html: tall(
      "<style>html{scrollbar-gutter:stable}::-webkit-scrollbar{width:15px;background:#eee}::-webkit-scrollbar-thumb{background:#888}</style>",
    ),
  });
  pages.set("/tall", { html: tall("") });
  pages.set("/short", { html: short });
  pages.set("/authored-zero", {
    html: authored("::-webkit-scrollbar{width:0}", before),
  });
  pages.set("/authored-8", {
    html: authored("::-webkit-scrollbar{width:8px}", before),
  });
  pages.set("/hidden", {
    html: authored("html{scrollbar-width:none}", before),
  });
  pages.set("/existing-margin", {
    html: before.replace("body { margin: 0;", "body { margin: 0 15px 0 0;"),
  });
  const compensated = await read("compensated.html");
  pages.set("/compensated-margin", {
    html: compensated.replace(
      /if \(width > 0\) document\.body\.style\.paddingRight = .*;/,
      `if (width > 0) {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync('body[data-scroll-locked]{margin:0 ' + width + 'px 0 0 !important}');
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          document.body.setAttribute('data-scroll-locked', '1');
        }`,
    ),
  });
  const style = /<style>([\s\S]*?)<\/style>/.exec(before)?.[1] ?? "";
  pages.set("/plans.css", {
    html: style,
    headers: { "content-type": "text/css" },
  });
  pages.set("/csp", {
    html: before.replace(
      /<style>[\s\S]*?<\/style>/,
      '<link rel="stylesheet" href="/plans.css">',
    ),
    headers: { "content-security-policy": csp },
  });
  // A control whose navigation a beforeunload handler vetoes retires the
  // page, so "Compare plans" is probed on a replacement page.
  for (const name of ["before", "compensated", "compensated-scroller"]) {
    pages.set(name === "before" ? "/replace" : `/replace-${name}`, {
      html: (await read(`${name}.html`)).replace(
        '<button id="open"',
        `<button id="details" type="button" onclick="addEventListener('beforeunload',(e)=>{e.preventDefault();e.returnValue=''});location.href='/after'">Show details</button>\n  <button id="open"`,
      ),
    });
  }
  server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://fixture.test");
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
      if (url.pathname === "/measured") {
        measured.push(url.search);
        response.writeHead(204).end();
        return;
      }
      const page = pages.get(url.pathname);
      response.writeHead(page === undefined ? 404 : 200, {
        "content-type": "text/html",
        ...page?.headers,
      });
      response.end(page?.html ?? "missing");
    },
  );
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch(scrollbarLaunchOptions);
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((accept) => server.close(() => accept()));
});

const configured = (colorScheme: ColorScheme = "light") =>
  projectSchema.parse({
    version: 1,
    app: { name: "scrollbars", framework: "other" },
    server: {
      build: "build",
      start: "start",
      readyUrl: "http://127.0.0.1:3001/",
      port: 3001,
      env: {},
    },
    viewports: [{ name: "desktop", width: 1024, height: 700 }],
    capture: { fullPage: true, settleMs: 50, colorScheme },
    checks: { probe: { enabled: true, waitMs: 150, controlTimeoutMs: 4000 } },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });

const stateFor = (path: string) => {
  const state = flowSchema.parse({
    id: "plans",
    title: "Plans",
    intent: [],
    setup: [],
    states: [{ id: "plans", description: "Plans", url: path, expect: {} }],
  }).states[0];
  if (!state) throw new Error("missing state");
  return state;
};

/** The production launcher (default launch) unless today's launch is given. */
async function capture(
  path: string,
  options: {
    probe?: boolean;
    colorScheme?: ColorScheme;
    launcher?: BrowserLauncher;
  } = {},
): Promise<TupleResult> {
  const session = await (
    options.launcher ??
    createBrowserLauncher({
      createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    })
  )();
  try {
    return await session.capture({
      project: configured(options.colorScheme),
      state: stateFor(path),
      viewport: { name: "desktop", width: 1024, height: 700 },
      navigationUrl: `${origin}${path}`,
      probe: options.probe ?? true,
    });
  } finally {
    await session.close();
  }
}

function ok(result: TupleResult) {
  if (!result.ok) throw new Error(`${result.stage}: ${result.message}`);
  return result;
}

function shifts(result: TupleResult) {
  const captured = ok(result);
  return runDeterministicChecks(
    [
      {
        ...tupleFor(captured.observations as ObservationArtifactV2),
        timelines: captured.timelines,
      },
    ],
    undefined,
    checksConfigFrom(configured().checks),
  )
    .candidates.map(({ candidate }) => candidate)
    .filter((candidate) => candidate.category === "interaction-shift");
}

const clicks = (timelines: ActionTimelineArtifact | undefined, name: string) =>
  (timelines?.actions ?? []).filter(
    (action) => action.source === "probe-click" && action.name === name,
  );

/** Root gutter before and after the first probe click on "Compare plans". */
function gutters(result: TupleResult): number[] {
  const [click] = clicks(ok(result).timelines, "Compare plans");
  expect(click?.rootScroll?.length).toBeGreaterThan(0);
  return (click?.rootScroll ?? []).map((sample) => sample.gutter);
}

const gutter = (page: Page) =>
  page.evaluate(() => window.innerWidth - document.documentElement.clientWidth);

describe("the fixture pair through production capture", () => {
  test("an uncompensated lock is measured while its public finding is withheld", async () => {
    const result = await capture("/before");
    expect(gutters(result)).toEqual([15, 0]);
    // The probe's setup replay and teardown record no action of their own.
    expect(
      ok(result).timelines?.actions.map((action) => [
        action.source,
        action.name,
      ]),
    ).toEqual([
      ["load", "/before"],
      ["probe-click", "Compare plans"],
      ["probe-hover", "Compare plans"],
    ]);
    const [click] = clicks(ok(result).timelines, "Compare plans");
    if (!click) throw new Error("missing click");
    expect(scrollbarShift(click)).toMatchObject({
      direction: "removed",
      gutter: 15,
    });
    expect(shifts(result)).toEqual([]);
  }, 60_000);

  test("a library that measures the root and gives the width back is clean", async () => {
    measured.length = 0;
    const result = await capture("/compensated");
    // It measured a real gutter at the click and applied that width.
    expect(measured).toContain("?source=root&width=15");
    const samples = clicks(ok(result).timelines, "Compare plans")[0]
      ?.rootScroll;
    expect(samples?.[0]?.gutter).toBe(15);
    expect(samples?.at(-1)).toMatchObject({ gutter: 0, compensation: true });
    expect(shifts(result)).toEqual([]);
  }, 60_000);

  test("a library that caches an off-screen scroller's width at startup is clean", async () => {
    measured.length = 0;
    const result = await capture("/compensated-scroller");
    // Capture's own load measures nothing; the probe's fresh document, in
    // probe mode, gives the temporary scroller the same width as the root.
    expect(measured[0]).toBe("?source=scroller&width=0");
    expect(measured).toContain("?source=scroller&width=15");
    expect(gutters(result)[0]).toBe(15);
    const [click] = clicks(ok(result).timelines, "Compare plans");
    if (!click) throw new Error("missing click");
    expect(click.rootScroll?.at(-1)?.compensation).toBe(true);
    expect(scrollbarShift(click)).toBeUndefined();
    expect(shifts(result)).toEqual([]);
  }, 60_000);

  test("body margin compensation in an adopted stylesheet is measured and clean", async () => {
    const result = await capture("/compensated-margin");
    const samples = clicks(ok(result).timelines, "Compare plans")[0]
      ?.rootScroll;
    expect(samples?.[0]).toMatchObject({ gutter: 15, compensation: false });
    expect(samples?.at(-1)).toMatchObject({ gutter: 0, compensation: true });
    expect(shifts(result)).toEqual([]);
  }, 60_000);

  test("an existing body margin is not scroll-lock compensation", async () => {
    const result = await capture("/existing-margin");
    const samples = clicks(ok(result).timelines, "Compare plans")[0]
      ?.rootScroll;
    expect(samples?.map((sample) => sample.compensation)).toEqual([
      false,
      false,
    ]);
    const [click] = clicks(ok(result).timelines, "Compare plans");
    if (!click) throw new Error("missing click");
    expect(scrollbarShift(click)).toMatchObject({ gutter: 15 });
    expect(shifts(result)).toEqual([]);
  }, 60_000);

  test("a stable gutter stays clean", async () => {
    const result = await capture("/after");
    // The gutter reading drops, but the reserved space keeps content still.
    expect(gutters(result)).toEqual([15, 0]);
    expect(
      clicks(ok(result).timelines, "Compare plans")[0]?.rootScroll?.every(
        (sample) => sample.stableGutter,
      ),
    ).toBe(true);
    expect(shifts(result)).toEqual([]);
  }, 60_000);
});

describe("state capture keeps today's pixels", () => {
  // Today's environment: the default launch with Chromium's hide flag.
  const today = createBrowserLauncher({
    launch: () => chromium.launch({ headless: true }),
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  });
  test.each([
    ["/styled", "light"],
    ["/styled", "dark"],
    ["/tall", "dark"],
    ["/short", "light"],
    ["/before", "light"],
  ] as const)(
    "%s (%s) screenshots are byte-identical with probe off and on",
    async (path, colorScheme) => {
      const expected = ok(
        await capture(path, { colorScheme, probe: false, launcher: today }),
      );
      for (const probe of [false, true]) {
        const actual = ok(await capture(path, { colorScheme, probe }));
        let mismatch: string | undefined;
        if (!actual.screenshot.equals(expected.screenshot)) {
          mismatch = await mkdtemp(join(tmpdir(), "idiom-scrollbar-pixels-"));
          await writeFile(join(mismatch, "expected.png"), expected.screenshot);
          await writeFile(join(mismatch, "actual.png"), actual.screenshot);
        }
        expect(actual.screenshot.equals(expected.screenshot), mismatch).toBe(
          true,
        );
        expect(actual.screenshotGeometry).toEqual(expected.screenshotGeometry);
        const document = (actual.observations as ObservationArtifactV2)
          .document;
        expect(document).toEqual(
          (expected.observations as ObservationArtifactV2).document,
        );
        expect(document.clientWidth).toBe(1024);
      }
    },
    60_000,
  );

  test("concurrent probe and capture pages keep their own gutters", async () => {
    const expected = ok(await capture("/styled", { probe: false }));
    const session = await createBrowserLauncher({
      createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    })();
    try {
      const project = configured();
      const viewport = { name: "desktop", width: 1024, height: 700 };
      const [probed, ...plain] = await Promise.all([
        session.capture({
          project,
          state: stateFor("/before"),
          viewport,
          navigationUrl: `${origin}/before`,
          probe: true,
        }),
        ...[0, 1, 2].map(() =>
          session.capture({
            project,
            state: stateFor("/styled"),
            viewport,
            navigationUrl: `${origin}/styled`,
          }),
        ),
      ]);
      if (!probed) throw new Error("missing probe");
      expect(gutters(probed)).toEqual([15, 0]);
      for (const result of plain)
        expect(ok(result).screenshot.equals(expected.screenshot)).toBe(true);
    } finally {
      await session.close();
    }
  }, 90_000);

  test("reference captures and measurement pages retain the hidden layout", async () => {
    const project = configured();
    const viewport = project.viewports[0];
    if (!viewport) throw new Error("missing viewport");
    const options = { url: `${origin}/styled`, project, viewport };
    const expected = await captureReferenceUrl(options);
    const actual = await captureReferenceUrl({
      ...options,
      launch: () => chromium.launch(scrollbarLaunchOptions),
    });
    expect(actual.equals(expected)).toBe(true);

    const session = await createBrowserLauncher()();
    const previous = await createBrowserLauncher({
      launch: () => chromium.launch({ headless: true }),
    })();
    try {
      if (!session.measure || !previous.measure)
        throw new Error("missing measurement support");
      const input = {
        project,
        viewport,
        state: stateFor("/styled"),
        navigationUrl: options.url,
      };
      const rects = await session.measure(input, ["section"]);
      expect(rects).toBeDefined();
      // An authored stable gutter can reserve layout space even with hidden
      // scrollbars. Compare against the original capture environment itself.
      expect(rects).toEqual(await previous.measure(input, ["section"]));
    } finally {
      await session.close();
      await previous.close();
    }
  }, 30_000);
});

describe("the probe-only scrollbar default", () => {
  test.each([
    ["/authored-zero", [0, 0], 0],
    ["/hidden", [0, 0], 0],
    ["/authored-8", [8, 0], 1],
    ["/csp", [15, 0], 1],
  ] as const)(
    "%s keeps author scrollbar sizing (gutters %j)",
    async (path, expected, detected) => {
      const result = await capture(path);
      expect(gutters(result)).toEqual(expected);
      const [click] = clicks(ok(result).timelines, "Compare plans");
      if (!click) throw new Error("missing click");
      expect(scrollbarShift(click) ? 1 : 0).toBe(detected);
      expect(shifts(result)).toEqual([]);
    },
    60_000,
  );

  test("a short page has no gutter to lose", async () => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 700 },
    });
    try {
      const page = await context.newPage();
      const controller = await ScrollbarController.create(page);
      const dispose = await controller.probe();
      await page.goto(`${origin}/short`);
      expect(await gutter(page)).toBe(0);
      await page.goto(`${origin}/tall`);
      expect(await gutter(page)).toBe(15);
      await dispose();
      // The next navigation is back in the hidden capture environment.
      await page.goto(`${origin}/tall`);
      expect(await gutter(page)).toBe(0);
      expect(
        await page.evaluate(() => document.adoptedStyleSheets.length),
      ).toBe(0);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("cleanup removes only the probe's own sheet", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("h1 { color: rgb(1, 2, 3); }");
        document.adoptedStyleSheets = [sheet];
      });
      const controller = await ScrollbarController.create(page);
      const dispose = await controller.probe();
      await page.goto(`${origin}/tall`);
      expect(
        await page.evaluate(() => document.adoptedStyleSheets.length),
      ).toBe(2);
      await dispose();
      expect(
        await page.evaluate(() => [
          document.adoptedStyleSheets.length,
          getComputedStyle(document.querySelector("h1") as Element).color,
        ]),
      ).toEqual([1, "rgb(1, 2, 3)"]);
      // Without the sheet a hidden page has no gutter even before reloading.
      expect(await gutter(page)).toBe(0);
    } finally {
      await context.close();
    }
  }, 30_000);
});

describe("probe lifecycle", () => {
  test.each([
    ["/replace", 1],
    ["/replace-compensated", 0],
    ["/replace-compensated-scroller", 0],
  ] as const)(
    "%s: a replacement page's first click still measures the gutter",
    async (path, detected) => {
      hits.clear();
      const result = await capture(path);
      const probe = ok(result);
      const [click] = clicks(probe.timelines, "Compare plans");
      expect(click?.rootScroll?.map((sample) => sample.gutter)).toEqual([
        15, 0,
      ]);
      if (!click) throw new Error("missing click");
      expect(scrollbarShift(click) ? 1 : 0).toBe(detected);
      expect(shifts(result)).toEqual([]);
      // Capture load, the probe's initial replay, then the replacement page.
      expect(hits.get(path)).toBeGreaterThanOrEqual(3);
    },
    60_000,
  );

  /** Calls probeControls directly, prepared the way production capture is. */
  const direct = async (
    run: (
      page: Page,
      prepare: (fail?: boolean) => (page: Page) => Promise<() => Promise<void>>,
      prepared: string[],
    ) => Promise<void>,
  ) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 700 },
    });
    const prepared: string[] = [];
    try {
      const page = await context.newPage();
      const initial = await ScrollbarController.create(page);
      await page.goto(`${origin}/before`);
      const prepare =
        (fail = false) =>
        async (active: Page) => {
          const controller =
            active === page
              ? initial
              : await ScrollbarController.create(active);
          const dispose = await controller.probe();
          prepared.push("prepare");
          if (fail) {
            await dispose();
            throw new Error("preparation failed");
          }
          return async () => {
            prepared.push("dispose");
            await dispose();
          };
        };
      await run(page, prepare, prepared);
    } finally {
      await context.close();
    }
  };

  test("a failed preparation stops the probe without actions", async () => {
    await direct(async (page, prepare, prepared) => {
      const artifact = await probeControls({
        page,
        restore: async (active) => {
          await active.goto(`${origin}/before`);
        },
        preparePage: prepare(true),
        skip: [],
        maxControls: 5,
        waitMs: 50,
        stateTimeoutMs: 10_000,
        onTimelines: () => {
          throw new Error("no action may be recorded");
        },
      });
      expect(artifact.status).toBe("partial");
      expect(artifact.reason).toContain("preparation failed");
      // The preparation undid itself; nothing was left to dispose.
      expect(prepared).toEqual(["prepare"]);
      await page.goto(`${origin}/tall`);
      expect(await gutter(page)).toBe(0);
    });
  }, 30_000);

  test("enumeration skips scrollbar preparation and the extra replay", async () => {
    await direct(async (page, prepare, prepared) => {
      let restored = false;
      const artifact = await probeControls({
        page,
        enumerateOnly: true,
        restore: async () => {
          restored = true;
        },
        preparePage: prepare(),
        skip: [],
        maxControls: 5,
        waitMs: 50,
      });
      expect(artifact.status).toBe("ran");
      expect(prepared).toEqual([]);
      expect(restored).toBe(false);
      expect(await gutter(page)).toBe(0);
    });
  }, 30_000);

  test("a state timeout during the initial replay still cleans up", async () => {
    await direct(async (page, prepare, prepared) => {
      const artifact = await probeControls({
        page,
        restore: async (active) => {
          await active.goto(`${origin}/before`);
          await active.waitForTimeout(5000);
        },
        preparePage: prepare(),
        skip: [],
        maxControls: 5,
        waitMs: 50,
        stateTimeoutMs: 1500,
      });
      expect(artifact.status).toBe("timed-out");
      expect(prepared).toEqual(["prepare", "dispose"]);
      if (!page.isClosed()) {
        await page.goto(`${origin}/tall`);
        expect(await gutter(page)).toBe(0);
      }
    });
  }, 30_000);

  test("an aborted probe still cleans up", async () => {
    await direct(async (page, prepare, prepared) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("cancelled")), 800);
      await probeControls({
        page,
        signal: controller.signal,
        restore: async (active) => {
          await active.goto(`${origin}/before`);
          await active.waitForTimeout(5000);
        },
        preparePage: prepare(),
        skip: [],
        maxControls: 5,
        waitMs: 50,
        stateTimeoutMs: 10_000,
      }).catch(() => undefined);
      expect(prepared).toEqual(["prepare", "dispose"]);
      if (!page.isClosed()) {
        await page.goto(`${origin}/tall`);
        expect(await gutter(page)).toBe(0);
      }
    });
  }, 30_000);
});
