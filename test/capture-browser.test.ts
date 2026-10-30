import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";
import { expect, test, vi } from "vitest";
import {
  captureReferenceUrl,
  createBrowserLauncher,
  deterministicContextOptions,
} from "../src/capture/browser.js";
import { runCapture, sanitizeDerivedResult } from "../src/capture/run.js";
import type { TupleResult } from "../src/capture/types.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import {
  loadTokenDeclarations,
  normalizeTokenDeclarations,
  observePage,
} from "../src/checks/observe.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type { ObservationArtifact } from "../src/checks/types.js";
import { initProject } from "../src/commands/init.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { screenshotPlacement } from "../src/review/crops.js";
import { flowSchema } from "../src/schemas/flow.js";
import { checksConfigSchema, projectSchema } from "../src/schemas/project.js";

const project = projectSchema.parse({
  version: 1,
  app: { name: "browser", framework: "other" },
  server: {
    build: "build",
    start: "start",
    readyUrl: "http://127.0.0.1:3001/",
    port: 3001,
    env: {},
  },
  viewports: [{ name: "phone", width: 390, height: 844 }],
  capture: {
    timezoneId: "America/New_York",
    locale: "en-US",
    colorScheme: "dark",
    reducedMotion: true,
    fullPage: true,
    settleMs: 125,
  },
  design: {},
  model: { provider: "anthropic", model: "unused" },
});

const state = flowSchema.parse({
  id: "browser",
  title: "Browser",
  intent: [],
  setup: [],
  states: [
    {
      id: "state",
      description: "browser state",
      url: "/state",
      expect: {
        status: 200,
        textPresent: ["Expected text"],
        selectorPresent: ["#present"],
        selectorAbsent: ["#absent"],
      },
      mask: ["#must-not-be-used"],
    },
  ],
}).states[0];

const observations = {
  version: 1 as const,
  viewport: { width: 390, height: 844 },
  document: {
    scrollWidth: 390,
    scrollHeight: 844,
    clientWidth: 390,
    clientHeight: 844,
  },
  elements: [],
  headings: [],
  tokens: { status: "not-configured" as const },
};

test("setup route redaction changes saved text while Chromium sees the private rendered state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-private-route-"));
  let raw: TupleResult | undefined;
  let browser: Browser | undefined;
  try {
    await initProject({ project: directory, yes: true });
    const port = await freePort();
    const script = join(directory, "server.mjs");
    await writeFile(
      script,
      `import { createServer } from 'node:http';
      createServer((req, res) => {
        const url = 'http://' + req.headers.host + req.url;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html lang="en"><title>Private route</title><main>' +
          '<h1>private-slug</h1><p><b>Bold</b></p><button aria-label="private-slug">Open</button>' +
          '<script type="application/json">' + JSON.stringify({ url, params: { code: 'private-slug' } }) + '</script>' +
          '<script>console.log("private-slug")</script></main></html>');
      }).listen(Number(process.env.PORT), '127.0.0.1');`,
    );
    const capturedProject = projectSchema.parse({
      ...project,
      server: {
        build: "node -e 0",
        start: `node '${script}'`,
        readyUrl: `http://127.0.0.1:${port}/`,
        port,
        env: {},
      },
      capture: { ...project.capture, settleMs: 0 },
      checks: { probe: { enabled: false } },
    });
    const flow = flowSchema.parse({
      id: "private-route",
      title: "Private route",
      intent: [],
      setup: [
        {
          run: "node -e 'console.log(process.env.SETUP_URL)'",
          captureStdout: true,
          env: {
            SETUP_URL: `http://127.0.0.1:${port}/b/book/available/block/button/ran/private-slug`,
          },
        },
      ],
      states: [
        {
          id: "derived",
          description: "Private page",
          urlFrom: { source: "setup-stdout", pattern: "(http[^\\s]+)" },
          expect: {
            status: 200,
            textPresent: ["private-slug"],
            selectorPresent: ['button[aria-label="private-slug"]'],
          },
        },
      ],
    });
    browser = await chromium.launch({ headless: true });
    const activeBrowser = browser;
    const result = await runCapture({
      projectDirectory: directory,
      project: capturedProject,
      flow,
      dependencies: {
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "fixture", dirty: false }),
        browserLauncher: async () => {
          const session = await createBrowserLauncher({
            launch: async () => activeBrowser,
          })();
          return {
            ...session,
            capture: async (tuple) => {
              expect(tuple.navigationUrl).toMatch(
                /\/b\/book\/available\/block\/button\/ran\/private-slug$/,
              );
              raw = await session.capture(tuple);
              expect(raw.ok).toBe(true);
              expect(raw.mismatches).toEqual([]);
              expect(raw.dom).toContain(tuple.navigationUrl);
              expect(raw.dom).toContain('"code":"private-slug"');
              expect(
                raw.console.some((record) => record.text === "private-slug"),
              ).toBe(true);
              expect(JSON.stringify(raw.axe)).toContain("private-slug");
              return raw;
            },
          };
        },
      },
    });
    expect(result.counts).toEqual({ passed: 1, failed: 0, total: 1 });
    const artifacts = join(result.runDirectory, "derived", "phone");
    for (const file of ["dom.html", "console.jsonl", "axe.json"]) {
      const text = await readFile(join(artifacts, file), "utf8");
      expect(text, file).not.toContain("private-slug");
      expect(text, file).toContain("setup-stdout:derived");
    }
    // Route segments b and button are tag names: the markup stays parseable.
    const dom = await readFile(join(artifacts, "dom.html"), "utf8");
    expect(dom).toContain("<p><b>Bold</b></p>");
    expect(dom).toMatch(
      /<button aria-label="[^"]*setup-stdout:derived[^"]*">Open<\/button>/,
    );
    const saved = observationArtifactSchema.parse(
      JSON.parse(await readFile(join(artifacts, "observations.json"), "utf8")),
    );
    if (!raw?.ok) throw new Error("missing raw capture");
    const original = observationArtifactSchema.parse(raw.observations);
    if (saved.version !== 2 || original.version !== 2)
      throw new Error("expected v2 observations");
    expect(
      original.elements.some((element) => element.styles.display === "block"),
    ).toBe(true);
    expect(
      original.elements.some(
        (element) =>
          element.signals?.renderedContent?.textEvidence?.status ===
          "available",
      ),
    ).toBe(true);
    expect(saved.elements.map((element) => element.styles)).toEqual(
      original.elements.map((element) => element.styles),
    );
    expect(saved.elements.map((element) => element.tag)).toEqual(
      original.elements.map((element) => element.tag),
    );
    expect(
      saved.elements
        .map((element) => element.selector)
        .filter((selector) => !selector.includes("setup-stdout")),
    ).toEqual(
      original.elements
        .map((element) => element.selector)
        .filter((selector) => !selector.includes("private-slug")),
    );
    const structuralSignals = (artifact: typeof original) =>
      artifact.elements.map(({ signals }) => ({
        renderedContent: signals?.renderedContent,
        role: signals?.role,
        motion: signals?.motion,
        appearance: signals?.appearance,
        cursor: signals?.cursor,
      }));
    expect(structuralSignals(saved)).toEqual(structuralSignals(original));
    expect(
      (
        await loadCaptureRun({
          runDirectory: result.runDirectory,
          expectedFlow: flow.id,
        })
      ).tuples,
    ).toHaveLength(1);
    // An element's screenshot-time rect must follow its redacted selector.
    const element = original.elements.find(
      (element) => element.tag === "button",
    );
    if (!element) throw new Error("missing button");
    const selector = '[data-code="private-slug"]';
    const remeasured = { x: 75, y: 80, width: 90, height: 40 };
    const geometry = sanitizeDerivedResult(
      {
        ...raw,
        observations: {
          ...original,
          elements: [{ ...element, selector }],
          screenshot: {
            strategy: "viewport",
            scale: 2,
            width: 780,
            height: 1688,
            drift: {
              observed: { width: 390, height: 844 },
              captured: { width: 390, height: 900 },
            },
            rects: { [selector]: remeasured },
          },
        },
      },
      `http://127.0.0.1:${port}/b/book/available/block/button/ran/private-slug`,
      {
        kind: "setup-stdout",
        origin: `http://127.0.0.1:${port}`,
        source: "setup-stdout",
        pattern: "(http[^\\s]+)",
        append: "",
        template: `http://127.0.0.1:${port}/{setup-stdout:derived}`,
      },
    );
    const checked = observationArtifactSchema.parse(geometry.observations);
    const redactedElement = checked.elements[0];
    if (!redactedElement) throw new Error("missing redacted element");
    expect(redactedElement.selector).not.toContain("private-slug");
    expect(screenshotPlacement(checked).rect(redactedElement)).toEqual(
      remeasured,
    );
    expect(JSON.stringify(checked)).not.toContain("private-slug");
    expect(raw?.screenshot).toBeDefined();
    expect(await readFile(join(artifacts, "screenshot.png"))).toEqual(
      raw?.screenshot,
    );
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error === undefined ? accept() : reject(error))),
  );
  return address.port;
}

/** Capture pages own a CDP session that hides scrollbars before navigation. */
function withScrollbarSession<T extends object>(page: T) {
  const send = vi.fn(async (_method: string, _params?: object) => ({}));
  const session = { send, detach: vi.fn(async () => undefined) };
  let sessions = 0;
  return Object.assign(page, {
    once: vi.fn(),
    isClosed: () => false,
    // Later sessions (filmstrips) stay unavailable, as before this mock.
    context: () => ({
      newCDPSession: async () => {
        sessions += 1;
        if (sessions > 1) throw new Error("no further CDP sessions");
        return session;
      },
    }),
    scrollbarSends: send,
  });
}

test("isolates each tuple, captures truthful artifacts, and reports every mismatch", async () => {
  if (state === undefined) throw new Error("missing state");
  const viewport = project.viewports[0];
  if (viewport === undefined) throw new Error("missing viewport");
  const handlers = new Map<string, (value: never) => void>();
  const screenshot = vi.fn(async () => Buffer.from("png"));
  const page = withScrollbarSession({
    on: vi.fn((event: string, handler: (value: never) => void) => {
      handlers.set(event, handler);
    }),
    goto: vi.fn(async () => {
      handlers.get("console")?.({
        type: () => "error",
        text: () => "console failure",
        location: () => ({ url: "local.js", lineNumber: 2, columnNumber: 3 }),
      } as never);
      handlers.get("pageerror")?.(new Error("page failure") as never);
      return { status: () => 404 };
    }),
    waitForTimeout: vi.fn(async () => undefined),
    locator: vi.fn((selector: string) => ({
      innerText: async () => "different text",
      count: async () => (selector === "#absent" ? 2 : 0),
    })),
    content: vi.fn(async () => "<html>captured</html>"),
    evaluate: vi.fn(async () => observations),
    screenshot,
    close: vi.fn(async () => undefined),
  });
  const context = {
    newPage: vi.fn(async () => page as unknown as Page),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    version: () => "Chromium 1",
    newContext: vi.fn(async () => context as unknown as BrowserContext),
    close: vi.fn(async () => undefined),
  };
  const axe = { testEngine: { name: "axe" }, violations: [] };
  const launcher = createBrowserLauncher({
    launch: async () => browser as unknown as Browser,
    createAxe: () => ({ analyze: async () => axe }),
    now: () => new Date("2026-08-14T12:00:00.000Z"),
  });
  const session = await launcher();
  const result = await session.capture({
    project,
    state,
    viewport,
    navigationUrl: "http://127.0.0.1:3001/state",
  });

  expect(browser.newContext).toHaveBeenCalledWith({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "America/New_York",
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  expect(page.waitForTimeout).toHaveBeenCalledWith(125);
  // State capture keeps today's scrollbar-free layout, set before navigating.
  expect(page.scrollbarSends).toHaveBeenCalledWith(
    "Emulation.setScrollbarsHidden",
    { hidden: true },
  );
  expect(page.scrollbarSends.mock.invocationCallOrder[0]).toBeLessThan(
    page.goto.mock.invocationCallOrder[0] ?? 0,
  );
  expect(screenshot).toHaveBeenCalledWith({
    fullPage: true,
    animations: "disabled",
    type: "png",
  });
  expect(JSON.stringify(screenshot.mock.calls)).not.toContain(
    "must-not-be-used",
  );
  expect(result).toMatchObject({
    ok: true,
    status: 404,
    axe,
    observations,
    mismatches: [
      { kind: "status" },
      { kind: "text-present" },
      { kind: "selector-present" },
      { kind: "selector-absent" },
    ],
    console: [
      { type: "error", text: "console failure" },
      { type: "pageerror", text: "page failure" },
    ],
  });
  expect(context.close).toHaveBeenCalledOnce();
  await session.close();
  expect(browser.close).toHaveBeenCalledOnce();
});

test("touch viewports set hasTouch without changing ordinary context options", () => {
  expect(
    deterministicContextOptions(project, {
      name: "desktop",
      width: 1440,
      height: 900,
      touch: true,
    }).hasTouch,
  ).toBe(true);
  expect(
    deterministicContextOptions(project, {
      name: "desktop",
      width: 1440,
      height: 900,
      touch: false,
    }),
  ).not.toHaveProperty("hasTouch");
  expect(
    projectSchema.safeParse({
      ...project,
      viewports: [{ name: "desktop", width: 1440, height: 900, touch: "yes" }],
    }).success,
  ).toBe(false);
});

test("compact editor chrome uses measured input capabilities at each viewport", async () => {
  if (state === undefined) throw new Error("missing state");
  const html = await readFile(
    join(import.meta.dirname, "fixtures/target-size/compact-chrome.html"),
    "utf8",
  );
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(html);
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  const session = await createBrowserLauncher({
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  const configured = projectSchema.parse({
    ...project,
    viewports: [
      { name: "desktop", width: 1440, height: 900 },
      { name: "touch", width: 1440, height: 900, touch: true },
      { name: "mobile", width: 390, height: 844 },
    ],
    checks: { targetSize: { fine: 24, coarse: 44, narrowBelow: 768 } },
  });
  const config = checksConfigFrom(checksConfigSchema.parse(configured.checks));
  try {
    for (const viewport of configured.viewports) {
      const result = await session.capture({
        project: configured,
        state,
        viewport,
        navigationUrl: `http://127.0.0.1:${address.port}/`,
      });
      expect(result.ok).toBe(true);
      const observed = observationArtifactSchema.parse(result.observations);
      if (observed.version !== 2) throw new Error("no v2");
      expect(observed.input?.maxTouchPoints).toBe(viewport.touch ? 1 : 0);
      // Chromium reports coarse/none for hasTouch and fine/hover otherwise.
      expect(observed.input).toMatchObject(
        viewport.touch
          ? { pointer: "coarse", hover: "none" }
          : { pointer: "fine", hover: "hover" },
      );
      const found = runDeterministicChecks(
        [
          {
            flow: "editor",
            state: "ready",
            viewport: viewport.name,
            width: viewport.width,
            height: viewport.height,
            metadataPath: "metadata.json",
            artifactPaths: ["observations.json"],
            commit: "abc123",
            createdAt: "2026-10-24T00:00:00.000Z",
            observations: observed,
            axe: { violations: [] },
            console: [],
            mismatches: [],
          },
        ],
        undefined,
        config,
      ).candidates.filter(
        ({ candidate }) => candidate.category === "target-size",
      );
      expect(found).toHaveLength(viewport.name === "desktop" ? 0 : 5);
      if (viewport.touch)
        expect(
          found.every(({ candidate }) =>
            candidate.explanation.includes("(touch, minimum 44)"),
          ),
        ).toBe(true);
    }
  } finally {
    await session.close();
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
}, 30_000);

test("observed browser geometry detects and clears the settings spacing outlier", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  try {
    await page.setContent(
      await readFile(
        join(import.meta.dirname, "fixtures/spacing-rhythm/settings.html"),
        "utf8",
      ),
    );
    const review = async () => {
      const current = await observePage(page, {
        status: "not-configured",
      });
      return runDeterministicChecks([
        {
          flow: "settings",
          state: "account",
          viewport: "desktop",
          width: 800,
          height: 800,
          metadataPath: "account/desktop/metadata.json",
          screenshotPath: "account/desktop/screenshot.png",
          artifactPaths: [
            "account/desktop/metadata.json",
            "account/desktop/observations.json",
          ],
          commit: "abc123",
          createdAt: "2026-08-27T12:00:00.000Z",
          observations: current,
          axe: { violations: [] },
          console: [],
          mismatches: [],
        },
      ]).candidates.filter(
        ({ candidate }) => candidate.category === "spacing-rhythm",
      );
    };
    const cramped = await review();
    expect(cramped).toHaveLength(1);
    expect(cramped[0]?.candidate).toMatchObject({
      explanation: expect.stringContaining(
        "prevailing clearance is 16 CSS px, supported by 3 observed placements",
      ),
      verification: {
        check: "spacing-rhythm",
        params: { fullFlow: true },
      },
    });
    expect(cramped[0]?.candidate.selectorHint).toContain("boundary-below");

    await page.addStyleTag({
      content: "section.outlier { padding-bottom: 16px; }",
    });
    expect(await review()).toEqual([]);

    await page.locator("section.outlier").evaluate((section) => {
      const help = document.createElement("p");
      help.textContent = "Your plan renews monthly.";
      help.style.height = "480px";
      section.append(help);
    });
    expect(
      await page.evaluate(() => document.scrollingElement?.scrollHeight),
    ).toBeGreaterThan(800);
    expect(await review()).toEqual([]);
  } finally {
    await page.close();
    await browser.close();
  }
}, 30_000);

test("side-by-side copy height is not mistaken for control clearance", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  try {
    await page.setContent(
      await readFile(
        join(import.meta.dirname, "fixtures/spacing-rhythm/side-by-side.html"),
        "utf8",
      ),
    );
    const observed = await observePage(page, { status: "not-configured" });
    const candidates = runDeterministicChecks([
      {
        flow: "settings",
        state: "account",
        viewport: "desktop",
        width: 1280,
        height: 900,
        metadataPath: "account/desktop/metadata.json",
        screenshotPath: "account/desktop/screenshot.png",
        artifactPaths: ["account/desktop/observations.json"],
        commit: "abc123",
        createdAt: "2026-08-27T12:00:00.000Z",
        observations: observed,
        axe: { violations: [] },
        console: [],
        mismatches: [],
      },
    ]).candidates.filter(
      ({ candidate }) => candidate.category === "spacing-rhythm",
    );
    expect(candidates).toEqual([]);
  } finally {
    await page.close();
    await browser.close();
  }
}, 30_000);

test("URL references reject non-success HTTP responses without taking a screenshot", async () => {
  const viewport = project.viewports[0];
  if (viewport === undefined) throw new Error("missing viewport");
  const screenshot = vi.fn(async () => Buffer.from("png"));
  const page = withScrollbarSession({
    goto: vi.fn(async () => ({ status: () => 404 })),
    waitForTimeout: vi.fn(async () => undefined),
    screenshot,
    close: vi.fn(async () => undefined),
  });
  const context = {
    newPage: vi.fn(async () => page as unknown as Page),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context as unknown as BrowserContext),
    close: vi.fn(async () => undefined),
  };

  await expect(
    captureReferenceUrl({
      url: "https://example.test/missing",
      project,
      viewport,
      launch: async () => browser as unknown as Browser,
    }),
  ).rejects.toThrow("HTTP 404");
  expect(screenshot).not.toHaveBeenCalled();
  expect(page.close).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
  expect(browser.close).toHaveBeenCalledOnce();
});

test("turns screenshot exceptions into typed failures and still closes context", async () => {
  if (state === undefined) throw new Error("missing state");
  const viewport = project.viewports[0];
  if (viewport === undefined) throw new Error("missing viewport");
  const page = withScrollbarSession({
    on: vi.fn(),
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => undefined,
    locator: (selector: string) => ({
      innerText: async () => "Expected text",
      count: async () => (selector === "#present" ? 1 : 0),
    }),
    content: async () => "<html></html>",
    evaluate: async () => observations,
    screenshot: async () => {
      throw new Error("png failed");
    },
    close: async () => undefined,
  });
  const context = {
    newPage: async () => page as unknown as Page,
    close: vi.fn(async () => undefined),
  };
  const browser = {
    version: () => "Chromium 1",
    newContext: async () => context as unknown as BrowserContext,
    close: async () => undefined,
  };
  const session = await createBrowserLauncher({
    launch: async () => browser as unknown as Browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  await expect(
    session.capture({
      project,
      state,
      viewport,
      navigationUrl: "http://127.0.0.1:3001/state",
    }),
  ).resolves.toMatchObject({
    ok: false,
    stage: "screenshot",
    message: "png failed",
  });
  expect(context.close).toHaveBeenCalledOnce();
});

test("URL references use flow capture context pins with a viewport-bounded screenshot", async () => {
  const viewport = project.viewports[0];
  if (viewport === undefined) throw new Error("missing viewport");
  const screenshot = vi.fn(async () => Buffer.from("png"));
  const page = withScrollbarSession({
    goto: vi.fn(async () => ({ status: () => 200 })),
    waitForTimeout: vi.fn(async () => undefined),
    screenshot,
    close: vi.fn(async () => undefined),
  });
  const context = {
    newPage: vi.fn(async () => page as unknown as Page),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context as unknown as BrowserContext),
    close: vi.fn(async () => undefined),
  };

  await expect(
    captureReferenceUrl({
      url: "https://example.test/reference",
      project,
      viewport,
      launch: async () => browser as unknown as Browser,
    }),
  ).resolves.toEqual(Buffer.from("png"));
  expect(browser.newContext).toHaveBeenCalledWith({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "America/New_York",
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  expect(page.goto).toHaveBeenCalledWith("https://example.test/reference");
  expect(page.waitForTimeout).toHaveBeenCalledWith(125);
  expect(screenshot).toHaveBeenCalledWith({
    fullPage: false,
    animations: "disabled",
    type: "png",
  });
  expect(page.close).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
  expect(browser.close).toHaveBeenCalledOnce();
});

test("applies the selected scheme attribute before inline application boot", async () => {
  if (state === undefined) throw new Error("missing state");
  const viewport = project.viewports[0];
  if (viewport === undefined) throw new Error("missing viewport");
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><head><script>
      document.documentElement.setAttribute(
        "data-boot-theme",
        document.documentElement.getAttribute("data-theme") ?? "missing",
      );
    </script></head><body>Expected text<div id="present"></div></body></html>`);
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing HTTP address");
  const browser = await chromium.launch({ headless: true });
  const session = await createBrowserLauncher({
    launch: async () => browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  const attributedProject = projectSchema.parse({
    ...project,
    colorSchemes: ["light", "dark"],
    capture: { ...project.capture, colorSchemeAttribute: "data-theme" },
  });
  try {
    for (const colorScheme of ["light", "dark"] as const) {
      const result = await session.capture({
        project: attributedProject,
        state,
        viewport,
        colorScheme,
        navigationUrl: `http://127.0.0.1:${address.port}/`,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.dom).toContain(`data-theme="${colorScheme}"`);
      expect(result.dom).toContain(`data-boot-theme="${colorScheme}"`);
      expect(
        result.console.filter((record) => record.type === "pageerror"),
      ).toEqual([]);
    }
  } finally {
    await session.close();
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error === undefined ? accept() : reject(error))),
    );
  }
}, 30_000);

test.each([
  {
    colorScheme: "light" as const,
    normalizedValues: [
      "6px",
      "rgb(10, 124, 82)",
      "rgb(16, 18, 16)",
      "rgb(44, 55, 66)",
      "rgb(87, 92, 87)",
    ],
    renderedValues: {
      "#fg": "rgb(16, 18, 16)",
      "#fg-secondary": "rgb(16, 18, 16)",
      "#muted": "rgb(87, 92, 87)",
      "#accent": "rgb(10, 124, 82)",
      "#direct": "rgb(44, 55, 66)",
    },
  },
  {
    colorScheme: "dark" as const,
    normalizedValues: [
      "6px",
      "rgb(174, 181, 174)",
      "rgb(210, 211, 212)",
      "rgb(235, 238, 235)",
      "rgb(88, 214, 166)",
    ],
    renderedValues: {
      "#fg": "rgb(235, 238, 235)",
      "#fg-secondary": "rgb(235, 238, 235)",
      "#muted": "rgb(174, 181, 174)",
      "#accent": "rgb(88, 214, 166)",
      "#direct": "rgb(210, 211, 212)",
    },
  },
])(
  "resolves light-dark tokens through a full $colorScheme capture run",
  async ({ colorScheme, normalizedValues, renderedValues }) => {
    const fixtureDirectory = join(
      import.meta.dirname,
      "fixtures",
      "token-drift",
    );
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "idiom-token-drift-"),
    );
    const runDirectory = join(temporaryDirectory, "run");
    const port = await freePort();
    const capturedProject = projectSchema.parse({
      version: 1,
      app: { name: "token-drift", framework: "other" },
      server: {
        build: "node -e 0",
        start: `node ${JSON.stringify(join(fixtureDirectory, "server.mjs"))}`,
        readyUrl: `http://127.0.0.1:${port}/`,
        port,
        env: { PORT: String(port) },
      },
      viewports: [{ name: "phone", width: 390, height: 844 }],
      capture: { colorScheme, settleMs: 0 },
      design: { tokensFile: "theme.css" },
      model: { provider: "anthropic", model: "unused" },
    });
    const capturedFlow = flowSchema.parse({
      id: "token-drift",
      title: "Token drift",
      intent: [],
      setup: [],
      states: [
        {
          id: "state",
          description: "token fixture",
          url: "/",
          expect: {
            status: 200,
            textPresent: ["Foreground", "Undeclared color"],
          },
        },
      ],
    });
    const viewport = capturedProject.viewports[0];
    if (viewport === undefined) throw new Error("missing viewport");
    const browser = await chromium.launch({ headless: true });
    try {
      const result = await runCapture({
        projectDirectory: fixtureDirectory,
        project: capturedProject,
        flow: capturedFlow,
        out: runDirectory,
        dependencies: {
          browserLauncher: createBrowserLauncher({
            launch: async () => browser,
            createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
          }),
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
        },
      });
      expect(result.counts).toEqual({ passed: 1, failed: 0, total: 1 });
      const capturedObservations = observationArtifactSchema.parse(
        JSON.parse(
          await readFile(
            join(runDirectory, "state", "phone", "observations.json"),
            "utf8",
          ),
        ),
      );

      expect(capturedObservations.tokens).toMatchObject({
        status: "configured",
        source: "theme.css",
        normalizedValues,
      });
      for (const [selector, color] of Object.entries(renderedValues)) {
        expect(
          capturedObservations.elements.find(
            (element) => element.selector === selector,
          )?.styles.color,
        ).toBe(color);
      }

      const tokenDrift = runDeterministicChecks([
        {
          flow: "browser",
          state: "state",
          viewport: "phone",
          width: viewport.width,
          height: viewport.height,
          metadataPath: "state/phone/metadata.json",
          artifactPaths: ["state/phone/metadata.json"],
          commit: "abc123",
          createdAt: "2026-08-14T12:00:00.000Z",
          observations: capturedObservations,
          axe: { violations: [] },
          console: [],
          mismatches: [],
        },
      ]).candidates.filter(
        ({ candidate }) => candidate.category === "token-drift",
      );
      expect(tokenDrift.map(({ candidate }) => candidate.selectorHint)).toEqual(
        ["#undeclared::color"],
      );
    } finally {
      if (browser.isConnected()) await browser.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  },
  30_000,
);

test("fails capture when declared color tokens resolve to nothing even though radii do", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-color-tokens-"));
  const browser = await chromium.launch({ headless: true });
  try {
    await writeFile(
      join(directory, "theme.css"),
      `@theme inline {
  --color-bg: var(--bg);
  --color-ink: var(--ink);
  --radius-sm: 4px;
  --radius-lg: 12px;
}
`,
    );
    await writeFile(
      join(directory, "radii.css"),
      ":root { --radius-sm: 4px; }\n",
    );
    const declarations = await loadTokenDeclarations(directory, "theme.css");
    const page = await browser.newPage();

    await page.setContent(
      "<style>:root{color-scheme: light; --bg: light-dark(rgb(250, 250, 250), rgb(10, 10, 10)); --ink: light-dark(rgb(20, 20, 20), rgb(240, 240, 240));}</style><body><p>x</p></body>",
    );
    const resolved = await normalizeTokenDeclarations(page, declarations);
    expect(
      resolved.status === "configured" && resolved.normalizedValues,
    ).toEqual(["12px", "4px", "rgb(20, 20, 20)", "rgb(250, 250, 250)"]);

    await page.setContent("<body><p>x</p></body>");
    for (const attempt of [
      normalizeTokenDeclarations(page, declarations),
      observePage(page, declarations),
    ]) {
      const error = await attempt.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("color-token resolution");
      expect(message).toContain("--color-bg");
      expect(message).not.toContain(
        "no usable custom-property color or radius values",
      );
    }

    const radiiOnly = await normalizeTokenDeclarations(
      page,
      await loadTokenDeclarations(directory, "radii.css"),
    );
    expect(
      radiiOnly.status === "configured" && radiiOnly.normalizedValues,
    ).toEqual(["4px"]);

    await expect(
      normalizeTokenDeclarations(
        page,
        await loadTokenDeclarations(directory, undefined, [
          {
            name: "--brand",
            value: "#123456",
            kind: "color",
            source: { path: "DESIGN.md", key: "colors.brand" },
          },
        ]),
      ),
    ).resolves.toMatchObject({ status: "configured" });
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("collects stable live observations and makes 320px defects appear and disappear", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 600 } });
  try {
    await page.setContent(`
        <style>
          :root { --ink: #111827; }
          button { box-sizing: border-box; width: 40px; height: 40px; }
          input.small-input { box-sizing: border-box; width: 40px; height: 40px; }
          a.padded-link { padding: 4px; }
          a.block-link { display: block; width: 40px; }
          .hidden { display: none; }
          .overlap { margin-left: -24px; }
          .card {
            color: var(--ink);
            & .title { color: #ff0000; }
          }
          .trailing-declaration {
            &:hover { color: var(--ink); }
            color: rgb(9, 9, 9);
          }
          .sr-only {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border-width: 0;
          }
          .panel { outline: none; }
          .ellipsis {
            width: 120px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .drawer {
            position: fixed;
            left: 0;
            width: 280px;
            transform: translateX(-100%);
          }
          .drawer a { display: block; height: 36px; }
          @media (min-width: 1px) { .grouped { color: #00ff00; } }
          @media (prefers-color-scheme: dark) {
            .inactive-media { color: #ff0000; }
          }
          @supports (idiom-not-a-property: yes) {
            .inactive-supports { color: #ff0000; }
          }
          .container { container-type: inline-size; width: 200px; }
          @container (min-width: 900px) {
            .inactive-container { color: #ff0000; }
          }
          @layer fixture { .layered { color: #123456; } }
        </style>
        <h1>Visible title</h1>
        <div class="hidden"><h1>Hidden title</h1></div>
        <a id="no-href">Not a link</a>
        <div id="negative-tab" tabindex="-1">Focus management</div>
        <button class="primary">Stable class</button>
        <button class="Button_root__x1f3q">Generated class</button>
        <div><div><div><div><div><div><button>Deep target</button></div></div></div></div></div></div>
        <button id="overlap-a">A</button><button id="overlap-b" class="overlap">B</button>
        <h2>Section</h2><h4>Deep heading</h4>
        <div class="card"><span class="title">Nested title</span></div>
        <div class="trailing-declaration">Trailing nested declaration</div>
        <a class="sr-only" href="#main">Skip to content</a>
        <div class="panel">No painted outline</div>
        <div class="ellipsis">A deliberately truncated navigation label</div>
        <p>Read our <a class="terms-link" href="/terms">terms of service</a> and <a class="privacy-link" href="/privacy">privacy policy</a> before booking.</p>
        <footer><a class="footer-link" href="/support">Support</a></footer>
        <a class="padded-link" href="/padded">Padded</a>
        <a class="block-link" href="/block">Block</a>
        <input class="small-input" aria-label="Short code">
        <nav class="drawer"><a class="drawer-link" href="/account">Account</a></nav>
        <div class="grouped">Grouped rule</div>
        <div class="inactive-media">Inactive media rule</div>
        <div class="inactive-supports">Inactive supports rule</div>
        <div class="container"><div class="inactive-container">Inactive container rule</div></div>
        <div class="layered">Layered rule</div>
        <main class="flattened-wrappers" style="position: absolute; left: 1000px; top: 0">
          <div class="wrapper-a" style="display: contents"><p class="wrapped-a">Alpha</p></div>
          <div class="wrapper-b" style="display: contents"><p class="wrapped-b">Beta</p></div>
        </main>
      `);
    const axe = {
      violations: [
        {
          id: "heading-order",
          impact: "moderate",
          nodes: [{ target: ["h4"], html: "<h4>Deep heading</h4>" }],
        },
      ],
    };
    const capturedTokens = {
      status: "configured" as const,
      source: "theme.css",
      declarations: { "--ink": "#111827" },
      normalizedValues: ["rgb(17, 24, 39)"],
    };
    const observed = await observePage(page, capturedTokens, axe, [
      ".card",
      ".missing",
    ]);
    expect(observed.version).toBe(2);
    expect(observed.version === 2 && observed.invariants).toEqual([]);
    expect(observationArtifactSchema.parse(observed).version).toBe(2);
    if (observed.version !== 2) throw new Error("expected version 2");
    expect(observed.maskMembership).toEqual([
      {
        selector: ".card",
        paths: [expect.stringContaining("div[")],
      },
      { selector: ".missing", paths: [] },
    ]);
    const wrapperA = observed.elements.find(
      (element) => element.selector === "div.wrapper-a",
    );
    const wrapperB = observed.elements.find(
      (element) => element.selector === "div.wrapper-b",
    );
    const wrappedA = observed.elements.find(
      (element) => element.selector === "p.wrapped-a",
    );
    const wrappedB = observed.elements.find(
      (element) => element.selector === "p.wrapped-b",
    );
    expect(wrapperA).toMatchObject({ visible: false });
    expect(wrapperB).toMatchObject({ visible: false });
    expect(wrapperA?.legacyRenderedPath).toBeUndefined();
    expect(wrapperB?.legacyRenderedPath).toBeUndefined();
    expect(wrappedA?.structuralPath).not.toBe(wrappedA?.legacyRenderedPath);
    expect(wrappedB?.structuralPath).not.toBe(wrappedB?.legacyRenderedPath);
    expect([
      wrappedA?.legacyRenderedPath,
      wrappedB?.legacyRenderedPath,
    ]).toEqual([
      "html[0]/body[0]/main[0]/p[0]",
      "html[0]/body[0]/main[0]/p[1]",
    ]);
    const wrappedMasks = await observePage(page, capturedTokens, axe, [
      ".wrapped-a",
      ".wrapped-b",
    ]);
    if (wrappedMasks.version !== 2) throw new Error("expected version 2");
    expect(wrappedMasks.maskMembership).toEqual([
      { selector: ".wrapped-a", paths: [wrappedA?.legacyRenderedPath] },
      { selector: ".wrapped-b", paths: [wrappedB?.legacyRenderedPath] },
    ]);
    expect(
      observed.elements.find((element) => element.selector === "span.title"),
    ).toMatchObject({
      directText: "Nested title",
      attributes: { class: "title" },
      temporal: false,
    });
    await expect(
      observePage(page, capturedTokens, axe, [":not("]),
    ).rejects.toThrow("invalid mask selector");
    await expect(
      normalizeTokenDeclarations(page, {
        status: "configured",
        source: "fonts-only.css",
        declarations: {
          "--font-sans": "Inter, sans-serif",
          "--duration": "150ms",
        },
        values: ["Inter, sans-serif", "150ms"],
      }),
    ).rejects.toThrow(
      'fonts-only.css" contains no usable custom-property color or radius values',
    );

    for (const element of observed.elements) {
      expect(
        await page.locator(element.selector).count(),
        element.selector,
      ).toBe(1);
    }
    expect(
      observed.elements.find((element) => element.text === "Stable class")
        ?.selector,
    ).toBe("button.primary");
    expect(
      observed.elements.find((element) => element.text === "Generated class")
        ?.selector,
    ).not.toContain("Button_root__x1f3q");
    expect(
      observed.elements.find((element) => element.text === "Deep target")
        ?.selector,
    ).toMatch(/^body > /);
    expect(observed.headings.filter(({ level }) => level === 1)).toHaveLength(
      1,
    );
    expect(
      observed.elements.find((element) => element.selector === "#no-href")
        ?.interactive,
    ).toBe(false);
    expect(
      observed.elements.find((element) => element.selector === "#negative-tab")
        ?.interactive,
    ).toBe(false);
    expect(
      observed.elements.find((element) => element.selector === "#overlap-a")
        ?.hitTestWith,
    ).toContain("#overlap-b");
    expect(
      observed.elements.find((element) => element.selector === "span.title")
        ?.authoredProperties,
    ).toContain("color");
    expect(
      observed.elements.find(
        (element) => element.selector === "div.trailing-declaration",
      )?.authoredProperties,
    ).toContain("color");
    expect(
      observed.elements.find(
        (element) => element.selector === "div.inactive-media",
      )?.authoredProperties,
    ).not.toContain("color");
    expect(
      observed.elements.find(
        (element) => element.selector === "div.inactive-supports",
      )?.authoredProperties,
    ).not.toContain("color");
    expect(
      observed.elements.find(
        (element) => element.selector === "div.inactive-container",
      )?.authoredProperties,
    ).not.toContain("color");
    expect(
      observed.elements.find((element) => element.selector === "div.layered")
        ?.authoredProperties,
    ).toContain("color");
    expect(
      observed.elements.find((element) => element.selector === "a.sr-only"),
    ).toMatchObject({
      visible: true,
      outOfFlow: true,
      rect: { width: 1, height: 1 },
    });
    expect(
      observed.elements.find((element) => element.selector === "div.panel")
        ?.styles.outlineStyle,
    ).toBe("none");
    expect(
      observed.elements.find((element) => element.selector === "div.ellipsis")
        ?.styles.textOverflow,
    ).toBe("ellipsis");
    expect(
      observed.elements.find((element) => element.selector === "a.terms-link")
        ?.inlineTextTarget,
    ).toBe(true);
    expect(
      observed.elements.find((element) => element.selector === "a.footer-link")
        ?.inlineTextTarget,
    ).toBe(true);
    expect(
      observed.elements.find((element) => element.selector === "a.padded-link")
        ?.inlineTextTarget,
    ).toBe(false);
    expect(
      observed.elements.find((element) => element.selector === "a.block-link")
        ?.inlineTextTarget,
    ).toBe(false);
    expect(
      observed.elements.find(
        (element) => element.selector === 'input[aria-label="Short code"]',
      )?.inlineTextTarget,
    ).toBe(false);
    expect(
      observed.elements.find((element) => element.selector === "a.drawer-link"),
    ).toMatchObject({
      visible: true,
      outOfFlow: true,
      rect: { x: -280, width: 280, height: 36 },
    });

    const review = (current: ObservationArtifact) =>
      runDeterministicChecks([
        {
          flow: "browser",
          state: "state",
          viewport: "arbitrary-name",
          width: 320,
          height: 600,
          metadataPath: "state/arbitrary-name/metadata.json",
          artifactPaths: ["state/arbitrary-name/metadata.json"],
          commit: "abc123",
          createdAt: "2026-08-14T12:00:00.000Z",
          observations: current,
          axe,
          console: [],
          mismatches: [],
        },
      ]);
    const degraded = review(observed);
    const selectorForText = (text: string) =>
      observed.elements.find(
        (element) => element.tag === "button" && element.text === text,
      )?.selector;
    expect(
      degraded.candidates
        .filter(({ candidate }) => candidate.category === "target-size")
        .map(({ candidate }) => candidate.selectorHint),
    ).toEqual([
      "button.primary",
      selectorForText("Generated class"),
      selectorForText("Deep target"),
      "#overlap-a",
      "#overlap-b",
      "a.padded-link",
      "a.block-link",
      'input[aria-label="Short code"]',
    ]);
    expect(
      degraded.candidates.filter(
        ({ candidate }) => candidate.rule === "idiom:heading-level-skip",
      ),
    ).toHaveLength(0);
    expect(
      degraded.candidates
        .filter(({ candidate }) => candidate.category === "token-drift")
        .map(({ candidate }) => candidate.selectorHint),
    ).toEqual(
      expect.arrayContaining([
        "span.title::color",
        "div.trailing-declaration::color",
        "div.grouped::color",
        "div.layered::color",
      ]),
    );
    expect(
      degraded.candidates.some(
        ({ candidate }) =>
          candidate.selectorHint === "div.inactive-media::color" ||
          candidate.selectorHint === "div.inactive-supports::color" ||
          candidate.selectorHint === "div.inactive-container::color",
      ),
    ).toBe(false);
    expect(
      degraded.candidates.some(
        ({ candidate }) =>
          candidate.selectorHint === "a.sr-only" ||
          candidate.selectorHint === "div.panel::outlineColor" ||
          candidate.selectorHint === "div.ellipsis" ||
          candidate.selectorHint === "a.terms-link" ||
          candidate.selectorHint === "a.privacy-link" ||
          candidate.selectorHint === "a.footer-link" ||
          candidate.selectorHint === "a.drawer-link",
      ),
    ).toBe(false);

    await page.addStyleTag({
      content:
        "button, input.small-input { width: 44px; height: 44px; } a.padded-link, a.block-link { box-sizing: border-box; display: inline-block; min-width: 44px; min-height: 44px; }",
    });
    const restored = review(await observePage(page, capturedTokens, axe));
    expect(
      restored.candidates.some(
        ({ candidate }) => candidate.category === "target-size",
      ),
    ).toBe(false);
  } finally {
    await page.close();
    await browser.close();
  }
}, 30_000);

test("observes declarations authored in applicable imported stylesheets", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 600 } });
  const sheets: Record<string, string> = {
    "/base.css":
      '@import url("/deep.css"); .imported { color: rgb(201, 35, 61); }',
    "/deep.css": ".deep-imported { background-color: #00ff00; }",
    "/wide.css": ".wide-only { color: #ff0000; }",
    "/grid.css": ".supported-import { color: #ff0000; }",
    "/nope.css": ".unsupported-import { color: #ff0000; }",
  };
  try {
    await page.route("http://idiom.test/**", async (route) => {
      const { pathname } = new URL(route.request().url());
      const css = sheets[pathname];
      if (css !== undefined)
        return route.fulfill({ contentType: "text/css", body: css });
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html>
          <style>
            @import url("/base.css");
            @import url("/wide.css") (min-width: 900px);
            @import url("/grid.css") supports(display: grid);
            @import url("/nope.css") supports(idiom-not-a-property: yes);
            @import url("http://other.test/remote.css");
            .local { color: #222222; }
          </style>
          <p class="imported">Imported</p>
          <p class="deep-imported">Deep imported</p>
          <p class="wide-only">Wide only</p>
          <p class="supported-import">Supported import</p>
          <p class="unsupported-import">Unsupported import</p>
          <p class="cross-origin">Cross origin</p>
          <p class="local">Local</p>`,
      });
    });
    await page.route("http://other.test/**", (route) =>
      route.fulfill({
        contentType: "text/css",
        body: ".cross-origin { color: #ff0000; }",
      }),
    );
    await page.goto("http://idiom.test/");
    const observed = await observePage(page, {
      status: "configured",
      source: "theme.css",
      declarations: { "--ink": "#111827" },
      normalizedValues: ["rgb(17, 24, 39)"],
    });
    if (observed.version !== 2) throw new Error("expected version 2");
    const element = (selector: string) => {
      const found = observed.elements.find(
        (candidate) => candidate.selector === selector,
      );
      if (found === undefined) throw new Error(`missing ${selector}`);
      return found;
    };
    expect(element("p.imported").authoredProperties).toContain("color");
    expect(element("p.deep-imported").authoredProperties).toContain(
      "backgroundColor",
    );
    expect(element("p.supported-import").authoredProperties).toContain("color");
    expect(element("p.wide-only").authoredProperties).not.toContain("color");
    expect(element("p.unsupported-import").authoredProperties).not.toContain(
      "color",
    );
    expect(element("p.cross-origin").authoredProperties).not.toContain("color");
    expect(element("p.local").authoredProperties).toContain("color");
    expect(element("p.imported").styleSources?.color).toMatchObject({
      sheet: "base.css",
      selector: ".imported",
    });

    const tokenDrift = runDeterministicChecks([
      {
        flow: "imports",
        state: "loaded",
        viewport: "phone",
        width: 320,
        height: 600,
        metadataPath: "loaded/phone/metadata.json",
        artifactPaths: ["loaded/phone/metadata.json"],
        commit: "abc123",
        createdAt: "2026-10-30T12:00:00.000Z",
        observations: observed,
        axe: { violations: [] },
        console: [],
        mismatches: [],
      },
    ]).candidates.filter(
      ({ candidate }) => candidate.category === "token-drift",
    );
    expect(tokenDrift.map(({ candidate }) => candidate.selectorHint)).toContain(
      `${element("p.imported").selector}::color`,
    );
  } finally {
    await page.close();
    await browser.close();
  }
}, 30_000);

test("live invariant membership keeps hidden, offscreen, missing and pseudo-class selectors", async () => {
  const { effectiveInvariants, invariantSchema } = await import(
    "../src/schemas/invariant.js"
  );
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>#hidden{display:none} #offscreen{position:absolute;left:-500px;top:0;width:40px;height:64px}</style>
      <main><div id="actual" data-kind="controls" style="height:85px">Controls</div><div id="hidden">Hidden</div><div id="offscreen">Offscreen</div></main>`);
    const authored = 'main > [data-kind="controls"]:not(.hidden)';
    const declarations = [
      { selector: authored, height: 64 },
      { selector: "#hidden", height: 0 },
      { selector: "#offscreen", width: 40 },
      { selector: ".gone", height: 64 },
      { edge: `${authored}:top`, equals: `${authored}:bottom`, offset: -85 },
    ].map((input) => invariantSchema.parse(input));
    const observed = await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      {
        invariants: effectiveInvariants(
          { id: "studio", invariants: declarations },
          { id: "ready" },
        ),
      },
    );
    expect(observed.version).toBe(2);
    if (observed.version !== 2) throw new Error("expected v2");
    expect(observed.invariants?.[0]?.selectors[0]).toMatchObject({
      selector: authored,
      matches: [{ selector: "#actual", rect: { height: 85 } }],
    });
    expect(observed.invariants?.[1]?.selectors[0]?.matches).toMatchObject([
      { selector: "#hidden", rect: { width: 0, height: 0 } },
    ]);
    expect(observed.invariants?.[2]?.selectors[0]?.matches).toMatchObject([
      { rect: { x: -500, width: 40 } },
    ]);
    expect(observed.invariants?.[3]?.selectors[0]?.matches).toEqual([]);
    expect(observed.invariants?.[4]?.selectors).toHaveLength(1);
    expect(observationArtifactSchema.parse(observed)).toEqual(observed);
    await expect(
      observePage(page, { status: "not-configured" }, undefined, [], {
        invariants: effectiveInvariants(
          {
            id: "studio",
            invariants: [
              invariantSchema.parse({
                name: "bad selector",
                selector: ":not(",
                height: 64,
                optional: true,
              }),
            ],
          },
          { id: "ready" },
        ),
      }),
    ).rejects.toThrow('invalid invariant selector ":not(" in bad selector');
  } finally {
    await browser.close();
  }
});

test("captures all invariant tuples, then reviews stored declarations after the browser closes and flow edits", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { initProject } = await import("../src/commands/init.js");
  const { runReview } = await import("../src/review/run.js");
  const { loadCaptureRun } = await import("../src/review/artifacts.js");
  const directory = await mkdtemp(join(tmpdir(), "idiom-invariant-grid-"));
  const port = await freePort();
  try {
    await initProject({ project: directory, yes: true });
    const html = `<!doctype html><html lang="en"><title>Chrome layout</title><style>
      body{margin:0;background:#fff;color:#111}
      .drawer-head{position:absolute;top:48px;left:0;width:100px;height:64px}
      .ed-controls{position:absolute;top:48px;left:100px;width:200px;height:64px}
      .canvas{position:absolute;top:128px;left:100px;width:200px;height:200px}
      @media(max-width:500px) and (prefers-color-scheme:dark){.ed-controls{height:85px}}
      </style><header class="drawer-head">Drawer</header><header class="ed-controls">Controls</header><main class="canvas"><h1>Canvas</h1></main></html>`;
    const script = join(directory, "server.mjs");
    await writeFile(
      script,
      `import { createServer } from 'node:http'; createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(${JSON.stringify(html)})}).listen(Number(process.env.PORT),'127.0.0.1');`,
    );
    const capturedProject = projectSchema.parse({
      ...project,
      server: {
        build: "node -e 0",
        start: `node '${script}'`,
        readyUrl: `http://127.0.0.1:${port}/`,
        port,
        env: { PORT: String(port) },
      },
      viewports: [
        { name: "phone", width: 390, height: 600 },
        { name: "desktop", width: 800, height: 600 },
      ],
      colorSchemes: ["light", "dark"],
      capture: { ...project.capture, settleMs: 0 },
    });
    const flow = flowSchema.parse({
      id: "studio",
      title: "Studio",
      setup: [],
      intent: [],
      invariants: [
        { name: "controls", selector: ".ed-controls", height: 64 },
        { align: "bottom", selectors: [".drawer-head", ".ed-controls"] },
        { edge: ".canvas:top", equals: ".ed-controls:bottom", offset: 16 },
      ],
      states: [{ id: "editor", description: "Editor", url: "/", expect: {} }],
    });
    await writeFile(
      join(directory, ".idiom/project.json"),
      JSON.stringify(capturedProject),
    );
    const flowPath = join(directory, ".idiom/flows/studio.json");
    await writeFile(flowPath, JSON.stringify(flow));
    const browser = await chromium.launch({ headless: true });
    let closed = false;
    const capture = await runCapture({
      projectDirectory: directory,
      project: capturedProject,
      flow,
      dependencies: {
        snapshotSource: async () => ({ commit: "fixture", dirty: false }),
        browserLauncher: async () => {
          const session = await createBrowserLauncher({
            launch: async () => browser,
            createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
          })();
          return {
            ...session,
            version: session.version,
            capture: session.capture.bind(session),
            close: async () => {
              await session.close();
              closed = true;
            },
          };
        },
      },
    });
    expect(capture.counts).toEqual({ passed: 4, failed: 0, total: 4 });
    expect(closed).toBe(true);
    const loaded = await loadCaptureRun({
      runDirectory: capture.runDirectory,
      expectedFlow: "studio",
      legacyColorScheme: "light",
    });
    expect(loaded.tuples).toHaveLength(4);
    for (const tuple of loaded.tuples) {
      expect(
        tuple.observations?.version === 2 && tuple.observations.invariants,
      ).toHaveLength(3);
      const findings = runDeterministicChecks([tuple]).candidates.filter(
        ({ candidate }) => candidate.category === "layout-invariants",
      );
      expect(findings).toHaveLength(
        tuple.viewport === "phone" && tuple.colorScheme === "dark" ? 3 : 0,
      );
    }
    const review = async () => {
      const result = await runReview({
        project: directory,
        flow: "studio",
        from: loaded.runId,
        deterministicOnly: true,
      });
      return JSON.parse(await readFile(result.findingsPath, "utf8"));
    };
    const findings = (await review()).filter(
      (finding: { category: string }) =>
        finding.category === "layout-invariants",
    );
    expect(findings).toHaveLength(3);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          explanation: "controls height 85, expected 64",
          flow: "studio",
          state: "editor",
          viewport: "phone",
          colorScheme: "dark",
          evidence: expect.objectContaining({
            artifacts: expect.arrayContaining([
              "editor/phone/dark/observations.json",
            ]),
          }),
        }),
        expect.objectContaining({
          explanation: expect.stringContaining(
            "bottom edges differ: .drawer-head 112, .ed-controls 133",
          ),
        }),
      ]),
    );
    await writeFile(
      flowPath,
      JSON.stringify({
        ...flow,
        invariants: [
          { name: "controls", selector: ".ed-controls", height: 85 },
        ],
      }),
    );
    expect(
      (await review()).filter(
        (finding: { category: string }) =>
          finding.category === "layout-invariants",
      ),
    ).toEqual(findings);
    await writeFile(flowPath, JSON.stringify({ ...flow, invariants: [] }));
    expect(
      (await review()).filter(
        (finding: { category: string }) =>
          finding.category === "layout-invariants",
      ),
    ).toEqual(findings);

    // Invalid CSS uses the existing observations capture failure stage, even when optional.
    const invalid = flowSchema.parse({
      ...flow,
      invariants: [
        { name: "invalid", selector: ":not(", height: 64, optional: true },
      ],
    });
    const failed = await runCapture({
      projectDirectory: directory,
      project: capturedProject,
      flow: invalid,
      tuples: [{ state: "editor", viewport: "phone", colorScheme: "dark" }],
      dependencies: {
        snapshotSource: async () => ({ commit: "fixture", dirty: false }),
        browserLauncher: createBrowserLauncher({
          createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
        }),
      },
    });
    expect(failed.counts.failed).toBe(1);
    const failure = await loadCaptureRun({
      runDirectory: failed.runDirectory,
      expectedFlow: "studio",
    });
    expect(failure.tuples[0]?.failure).toMatchObject({
      stage: "observations",
      message: expect.stringContaining(
        'invalid invariant selector ":not(" in invalid',
      ),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("light/dark capture persists paint and frame evidence that review replays from the run id (#9, #32)", async () => {
  const { writeFile, readdir } = await import("node:fs/promises");
  const { initProject } = await import("../src/commands/init.js");
  const { runReview } = await import("../src/review/run.js");
  const { loadCaptureRun } = await import("../src/review/artifacts.js");
  const { fixture } = await import("./benchmark-support.js");
  const directory = await mkdtemp(join(tmpdir(), "idiom-luminance-"));
  const port = await freePort();
  try {
    await initProject({ project: directory, yes: true });
    const pages = {
      before: await fixture("luminance-before.html"),
      after: await fixture("luminance-after.html"),
    };
    const script = join(directory, "server.mjs");
    await writeFile(
      script,
      `import { createServer } from 'node:http'; const pages = ${JSON.stringify(pages)}; createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(pages[req.url.slice(1)] ?? '')}).listen(Number(process.env.PORT),'127.0.0.1');`,
    );
    const capturedProject = projectSchema.parse({
      ...project,
      server: {
        build: "node -e 0",
        start: `node '${script}'`,
        readyUrl: `http://127.0.0.1:${port}/before`,
        port,
        env: { PORT: String(port) },
      },
      viewports: [{ name: "desktop", width: 1440, height: 900 }],
      colorSchemes: ["light", "dark"],
      capture: { ...project.capture, settleMs: 0 },
      checks: { frame: { selector: "#page-frame" } },
    });
    await writeFile(
      join(directory, ".idiom/project.json"),
      JSON.stringify(capturedProject),
    );
    const review = async (page: "before" | "after") => {
      const flow = flowSchema.parse({
        id: page,
        title: page,
        setup: [],
        intent: [],
        states: [
          { id: "editor", description: "Editor", url: `/${page}`, expect: {} },
        ],
      });
      await writeFile(
        join(directory, `.idiom/flows/${page}.json`),
        JSON.stringify(flow),
      );
      const capture = await runCapture({
        projectDirectory: directory,
        project: capturedProject,
        flow,
        dependencies: {
          snapshotSource: async () => ({ commit: "fixture", dirty: false }),
          browserLauncher: createBrowserLauncher({
            launch: async () => chromium.launch({ headless: true }),
            createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
          }),
        },
      });
      expect(capture.counts).toEqual({ passed: 2, failed: 0, total: 2 });
      const listing = async () =>
        Promise.all(
          ["light", "dark"].map((scheme) =>
            readFile(
              join(
                capture.runDirectory,
                "editor/desktop",
                scheme,
                "observations.json",
              ),
              "utf8",
            ),
          ),
        );
      const stored = await listing();
      for (const text of stored)
        observationArtifactSchema.parse(JSON.parse(text));
      const runs = await readdir(join(capture.runDirectory, ".."));
      const result = await runReview({
        project: directory,
        flow: page,
        from: (
          await loadCaptureRun({
            runDirectory: capture.runDirectory,
            expectedFlow: page,
            legacyColorScheme: "light",
          })
        ).runId,
        deterministicOnly: true,
      });
      expect(await listing()).toEqual(stored);
      expect(await readdir(join(capture.runDirectory, ".."))).toEqual(runs);
      const findings: Array<{
        category: string;
        rule?: string;
        colorScheme?: string;
        explanation: string;
        evidence: { artifacts: string[] };
      }> = JSON.parse(await readFile(result.findingsPath, "utf8"));
      return findings.filter((finding) =>
        ["luminance-parity", "frame"].includes(finding.category),
      );
    };
    const before = await review("before");
    expect(before.map((finding) => finding.explanation)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("#title keeps a light background"),
        expect.stringContaining("primary action #publish"),
        expect.stringContaining("frame #page-frame does not stand apart"),
      ]),
    );
    const parity = before.find((finding) =>
      finding.explanation.includes("#title"),
    );
    expect(parity?.colorScheme).toBe("dark");
    expect(parity?.evidence.artifacts).toEqual(
      expect.arrayContaining([
        "editor/desktop/light/observations.json",
        "editor/desktop/dark/observations.json",
      ]),
    );
    expect(await review("after")).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a published tuple records failed image requests; other tuples record no image evidence", async () => {
  if (state === undefined) throw new Error("missing state");
  const viewport = project.viewports[0];
  if (viewport === undefined) throw new Error("missing viewport");
  const server = createHttpServer((request, response) => {
    if (request.url === "/missing.png") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><html lang="en"><body>Expected text<div id="present"></div><img src="/missing.png" alt="Hero"></body></html>',
    );
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing HTTP address");
  const browser = await chromium.launch({ headless: true });
  const session = await createBrowserLauncher({
    launch: async () => browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  const navigationUrl = `http://127.0.0.1:${address.port}/`;
  try {
    const published = await session.capture({
      project,
      state,
      viewport,
      navigationUrl,
      published: true,
    });
    expect(published.observations?.version).toBe(2);
    if (published.observations?.version !== 2) throw new Error("no v2");
    expect(published.observations.failedImageRequests).toEqual([
      { url: `${navigationUrl}missing.png`, reason: "HTTP 404" },
    ]);
    expect(published.observations.images).toEqual([
      expect.objectContaining({
        src: "/missing.png",
        currentSrc: `${navigationUrl}missing.png`,
        complete: true,
        naturalWidth: 0,
      }),
    ]);
    const plain = await session.capture({
      project,
      state,
      viewport,
      navigationUrl,
    });
    expect(plain.observations).toBeDefined();
    expect(Object.keys(plain.observations ?? {})).not.toContain("images");
    expect(Object.keys(plain.observations ?? {})).not.toContain(
      "failedImageRequests",
    );
  } finally {
    await session.close();
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error === undefined ? accept() : reject(error))),
    );
  }
}, 30_000);

test("captures and persists opted-in intent evidence while a disabled probe stays absent (#54)", async () => {
  const { writeTupleArtifacts } = await import("../src/capture/artifacts.js");
  const directory = await mkdtemp(join(tmpdir(), "idiom-control-intent-"));
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html lang="en"><title>Intent capture</title><body>
      <button id="desktop" aria-pressed="true">Desktop</button>
      <button id="upload" onclick="document.getElementById('file').click()">Upload image</button>
      <input id="file" type="file" hidden><button id="dead">Inert</button>
    </body></html>`);
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing HTTP address");
  const browser = await chromium.launch({ headless: true });
  const session = await createBrowserLauncher({
    launch: async () => browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  const capturedProject = projectSchema.parse({
    ...project,
    capture: { ...project.capture, settleMs: 0 },
    checks: { probe: { respectControlIntent: true, waitMs: 20 } },
  });
  const flow = flowSchema.parse({
    id: "intent",
    title: "Intent",
    intent: [],
    setup: [],
    states: [
      {
        id: "editor",
        description: "Editor",
        url: "/",
        probe: true,
        expect: {},
      },
    ],
  });
  const capturedState = flow.states[0];
  const viewport = capturedProject.viewports[0];
  if (!capturedState || !viewport) throw new Error("missing tuple");
  try {
    for (const enabled of [true, false]) {
      const result = await session.capture({
        project: capturedProject,
        state: capturedState,
        viewport,
        navigationUrl: `http://127.0.0.1:${address.port}/`,
        probe: enabled && capturedState.probe,
      });
      expect(result.ok).toBe(true);
      const stagingDirectory = join(directory, String(enabled));
      await writeTupleArtifacts({
        stagingDirectory,
        tuple: { flow, state: capturedState, viewport, result },
        source: { commit: "fixture", dirty: false },
        browserVersion: session.version,
        fallbackTimestamp: "2026-10-24T00:00:00.000Z",
      });
      const stored = observationArtifactSchema.parse(
        JSON.parse(
          await readFile(
            join(stagingDirectory, "editor/phone/observations.json"),
            "utf8",
          ),
        ),
      );
      expect(stored.version).toBe(2);
      if (stored.version !== 2) throw new Error("expected v2");
      if (enabled) {
        expect(stored.probe?.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              selector: "#desktop",
              effects: [],
              skipped: "already selected: aria-pressed",
            }),
            expect.objectContaining({
              selector: "#upload",
              effects: ["filechooser"],
              primary: true,
            }),
            expect.objectContaining({ selector: "#dead", effects: [] }),
          ]),
        );
      } else expect(stored.probe).toBeUndefined();
    }
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
}, 30_000);

test("production capture persists tooltip probe evidence and actual Tab/state focus evidence", async () => {
  const html = `<!doctype html><html lang="en"><title>Visible explanations</title><body><style>
    [role=tooltip]{display:none} #help:is(:hover,:focus)+[role=tooltip]{display:block}
    </style><button id="start">Start</button><button id="help" aria-disabled="true" aria-label="Help topics" aria-describedby="tip">?</button><span id="tip" role="tooltip">Help topics</span></body></html>`;
  const server = createHttpServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  const browser = await chromium.launch({ headless: true });
  const session = await createBrowserLauncher({
    launch: async () => browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  const configured = projectSchema.parse({
    ...project,
    checks: { explanation: "visible", probe: { enabled: true, waitMs: 100 } },
  });
  const navigationUrl = `http://127.0.0.1:${address.port}/`;
  const base = {
    project: configured,
    viewport: { name: "desktop", width: 800, height: 600 },
    navigationUrl,
  };
  try {
    const state = flowSchema.parse({
      id: "tips",
      title: "Tips",
      intent: [],
      setup: [],
      states: [{ id: "ready", description: "Ready", url: "/", expect: {} }],
    }).states[0];
    if (!state) throw new Error("state missing");
    const sampled = await session.capture({ ...base, state, probe: true });
    expect(sampled.ok).toBe(true);
    const observations = observationArtifactSchema.parse(
      JSON.parse(JSON.stringify(sampled.observations)),
    );
    if (observations.version !== 2) throw new Error("v2 missing");
    expect(
      observations.explanations?.records
        .filter((r) => r.selector === "#help" && r.status === "observed")
        .map((r) => r.trigger)
        .sort(),
    ).toEqual(["focus", "hover"]);
    expect(
      observations.probe?.results.some((result) => result.selector === "#help"),
    ).toBe(false);
    const { tupleFor } = await import("./motion-support.js");
    const { checksConfigFrom } = await import("../src/checks/registry.js");
    expect(
      runDeterministicChecks(
        [tupleFor(observations)],
        undefined,
        checksConfigFrom(configured.checks),
      ).candidates.filter(
        ({ candidate }) => candidate.category === "unexplained-control",
      ),
    ).toEqual([]);
    for (const declaration of [
      { steps: [{ action: "press", selector: "#start", key: "Tab" }] },
      { focus: "#help" },
    ]) {
      const focusState = flowSchema.parse({
        id: "tips",
        title: "Tips",
        intent: [],
        setup: [],
        states: [
          {
            id: "focused",
            description: "Focused",
            url: "/",
            expect: {},
            ...declaration,
          },
        ],
      }).states[0];
      if (!focusState) throw new Error("state missing");
      const captured = await session.capture({
        ...base,
        state: focusState,
        probe: false,
      });
      expect(captured.ok).toBe(true);
      const artifact = observationArtifactSchema.parse(
        JSON.parse(JSON.stringify(captured.observations)),
      );
      if (artifact.version !== 2) throw new Error("v2 missing");
      expect(artifact.probe).toBeUndefined();
      expect(
        artifact.explanations?.records.filter(
          (r) => r.selector === "#help" && r.status === "observed",
        ),
      ).toMatchObject([{ trigger: "focus", source: "capture" }]);
      expect(
        artifact.explanations?.records.some(
          (r) =>
            r.selector === "#help" &&
            r.trigger === "hover" &&
            r.status === "observed",
        ),
      ).toBe(false);
      expect(
        artifact.elements.find((e) => e.selector === "#help")?.signals
          ?.explanation?.descriptions,
      ).toEqual([{ selector: "#tip", text: "Help topics" }]);
    }
  } finally {
    await session.close();
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
}, 60_000);

test.each(["navigation", "replacement"])(
  "production capture keeps modalities attached to the final control after %s",
  async (change) => {
    const finalLabel =
      change === "replacement" ? "Help action" : "Different action";
    const previousLabel =
      change === "replacement" ? "Help action" : "Previous action";
    const final = `<style>[role=tooltip]{display:none}#help:hover+[role=tooltip]{display:block}</style><button id="help" aria-label="${finalLabel}">?</button><span role="tooltip">Different action</span>`;
    const html = `<!doctype html><body><style>[role=tooltip]{display:none}#help:focus+[role=tooltip]{display:block}</style>
    <button id="help" aria-label="${previousLabel}">?</button><span role="tooltip">Previous action</span>
    <script>document.querySelector('#help').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();${change === "navigation" ? "location.href='/final'" : `document.body.innerHTML=${JSON.stringify(final)}`}}});</script>`;
    const server = createHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        request.url === "/final" ? `<!doctype html><body>${final}` : html,
      );
    });
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    const browser = await chromium.launch({ headless: true });
    const session = await createBrowserLauncher({
      launch: async () => browser,
      createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    })();
    try {
      const configured = projectSchema.parse({
        ...project,
        checks: {
          explanation: "visible",
          probe: { enabled: true, waitMs: 100 },
        },
      });
      const state = flowSchema.parse({
        id: "tips",
        title: "Tips",
        intent: [],
        setup: [],
        states: [
          {
            id: "final",
            description: "Final",
            url: "/",
            expect: {},
            steps: [
              { action: "press", selector: "#help", key: "Shift" },
              { action: "press", selector: "#help", key: "Enter" },
              ...(change === "navigation"
                ? [{ action: "expectUrl", path: "/final" }]
                : []),
            ],
          },
        ],
      }).states[0];
      if (!state) throw new Error("missing state");
      const captured = await session.capture({
        project: configured,
        state,
        viewport: { name: "desktop", width: 800, height: 600 },
        navigationUrl: `http://127.0.0.1:${address.port}/`,
        probe: true,
      });
      expect(captured.ok).toBe(true);
      const artifact = observationArtifactSchema.parse(
        JSON.parse(JSON.stringify(captured.observations)),
      );
      if (artifact.version !== 2) throw new Error("v2 missing");
      const controlId = artifact.elements.find(
        (element) => element.selector === "#help",
      )?.signals?.explanation?.controlId;
      expect(controlId).toBeDefined();
      expect(
        artifact.explanations?.records.find(
          (record) =>
            record.source === "capture" &&
            record.trigger === "focus" &&
            record.status === "observed",
        )?.controlId,
      ).not.toBe(controlId);
      expect(
        artifact.explanations?.records.find(
          (record) =>
            record.source === "probe" &&
            record.trigger === "hover" &&
            record.status === "observed",
        )?.controlId,
      ).toBe(controlId);
      const { tupleFor } = await import("./motion-support.js");
      const { checksConfigFrom } = await import("../src/checks/registry.js");
      const findings = runDeterministicChecks(
        [tupleFor(artifact)],
        undefined,
        checksConfigFrom(configured.checks),
      ).candidates.map((c) => c.candidate);
      expect(
        findings
          .filter((c) => c.category === "unexplained-control")
          .map((c) => c.selectorHint),
      ).toEqual(["#help"]);
      expect(
        artifact.explanations?.records.some(
          (r) =>
            r.selector === "#help" &&
            r.trigger === "hover" &&
            r.status === "observed",
        ),
      ).toBe(true);
      expect(
        artifact.explanations?.records.some(
          (r) =>
            r.selector === "#help" &&
            r.trigger === "focus" &&
            r.status === "absent",
        ),
      ).toBe(true);
    } finally {
      await session.close();
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
    }
  },
  60000,
);

test("non-HTML captures save usable evidence and replay without document findings while HTML controls still report", async () => {
  const { cp, writeFile } = await import("node:fs/promises");
  const { AxeBuilder } = await import("@axe-core/playwright");
  const { initProject } = await import("../src/commands/init.js");
  const { loadCaptureRun } = await import("../src/review/artifacts.js");
  const directory = await mkdtemp(join(tmpdir(), "idiom-non-html-"));
  try {
    await initProject({ project: directory, yes: true });
    await cp(
      join(import.meta.dirname, "fixtures/route-flow-generation/server.mjs"),
      join(directory, "server.mjs"),
    );
    const port = await freePort();
    const configured = projectSchema.parse({
      ...project,
      server: {
        build: "node -e 0",
        start: "node server.mjs",
        readyUrl: `http://127.0.0.1:${port}/`,
        port,
        env: { PORT: String(port) },
      },
      capture: { ...project.capture, settleMs: 500 },
    });
    const types = {
      "og.png": "image/png",
      data: "application/json",
      // Chromium represents an RSS response as a plain-text document.
      feed: "text/plain",
      xml: "application/xml",
    };
    const flow = flowSchema.parse({
      id: "mime",
      title: "MIME capture",
      intent: [],
      setup: [],
      states: [
        ...Object.keys(types),
        "mime-client",
        "no-h1",
        "multiple-h1",
      ].map((id) => ({
        id: id.replace(".", "-"),
        description: id,
        url: `/${id}`,
        expect: {},
        probe: true,
      })),
    });
    await writeFile(
      join(directory, ".idiom/project.json"),
      JSON.stringify(configured),
    );
    const analyzed: string[] = [];
    const capture = await runCapture({
      projectDirectory: directory,
      project: configured,
      flow,
      dependencies: {
        snapshotSource: async () => ({ commit: "fixture", dirty: false }),
        browserLauncher: createBrowserLauncher({
          createAxe: (page) => ({
            analyze: async () => {
              analyzed.push(new URL(page.url()).pathname);
              return new AxeBuilder({ page }).analyze();
            },
          }),
        }),
      },
    });
    expect(capture.counts).toEqual({ passed: 7, failed: 0, total: 7 });
    expect([...new Set(analyzed)].sort()).toEqual(["/multiple-h1", "/no-h1"]);
    const loaded = await loadCaptureRun({
      runDirectory: capture.runDirectory,
      expectedFlow: "mime",
      legacyColorScheme: "dark",
    });
    expect(loaded.tuples).toHaveLength(7);
    for (const tuple of loaded.tuples) {
      const observed = observationArtifactSchema.parse(tuple.observations);
      const nonHtml = !["no-h1", "multiple-h1"].includes(tuple.state);
      const findings = runDeterministicChecks([tuple]).candidates.map(
        ({ candidate }) => candidate,
      );
      if (nonHtml) {
        expect(observed.document.contentType).toBe(
          tuple.state === "mime-client"
            ? "application/json"
            : types[
                tuple.state === "og-png"
                  ? "og.png"
                  : (tuple.state as keyof typeof types)
              ],
        );
        expect(observed.elements).toEqual([]);
        expect(observed.headings).toEqual([]);
        expect(observed.tokens).toEqual({ status: "not-configured" });
        expect(observed.version === 2 && observed.probe).toBeUndefined();
        expect(tuple.axe).toEqual({ violations: [] });
        expect(
          findings.filter(
            (candidate) =>
              candidate.category === "heading-structure" ||
              /landmark|region/.test(candidate.rule),
          ),
        ).toEqual([]);
      } else {
        expect(observed.document.contentType).toBe("text/html");
        expect(
          findings.some((candidate) =>
            tuple.state === "multiple-h1"
              ? candidate.rule === "idiom:multiple-h1"
              : ["idiom:missing-h1", "axe:page-has-heading-one"].includes(
                  candidate.rule,
                ),
          ),
        ).toBe(true);
      }
      for (const name of ["dom.html", "screenshot.png", "console.jsonl"]) {
        const path = tuple.artifactPaths.find((path) =>
          path.endsWith(`/${name}`),
        );
        expect(path).toBeDefined();
        expect(
          (await readFile(join(capture.runDirectory, path as string))).length,
        ).toBeGreaterThanOrEqual(name === "console.jsonl" ? 0 : 1);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

test.each([0, 1000])(
  "web launcher threads animationSettleMs=%i to shared evidence",
  async (bound) => {
    const html = await readFile(
      join(import.meta.dirname, "fixtures/painted-visibility/entrance.html"),
      "utf8",
    );
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing port");
    const session = await createBrowserLauncher({
      createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    })();
    const configured = projectSchema.parse({
      ...project,
      capture: {
        ...project.capture,
        settleMs: 0,
        reducedMotion: false,
        animationSettleMs: bound,
      },
    });
    const target = flowSchema.parse({
      id: "f",
      title: "f",
      intent: [],
      setup: [],
      states: [
        { id: "entrance", description: "entrance", url: "/", expect: {} },
      ],
    }).states[0];
    if (!target || !configured.viewports[0]) throw new Error("missing tuple");
    try {
      const result = await session.capture({
        project: configured,
        state: target,
        viewport: configured.viewports[0],
        navigationUrl: `http://127.0.0.1:${address.port}/`,
      });
      expect(result.ok).toBe(true);
      expect(
        result.observations?.elements.find((e) => e.selector === "#entrance")
          ?.painted?.value,
      ).toBe(bound > 0);
    } finally {
      await session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("ordinary capture keeps an active repeated ticker quiet through settling", async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><style>
      body { margin:40px; font:20px/30px Arial; }
      #strip { width:180px; overflow:hidden; }
      #track { display:flex; width:max-content; animation:ticker 1000s linear infinite; }
      span { flex:none; white-space:nowrap; }
      @keyframes ticker { from { transform:translateX(0%); } to { transform:translateX(-50%); } }
      </style><div id="strip"><div id="track"><span id="ticker-text">Fresh curry made daily for everyone</span><span>Fresh curry made daily for everyone</span></div></div>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing port");
  const session = await createBrowserLauncher({
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  const configured = projectSchema.parse({
    ...project,
    capture: { ...project.capture, reducedMotion: false, settleMs: 0 },
  });
  const target = flowSchema.parse({
    id: "ticker",
    title: "ticker",
    intent: [],
    setup: [],
    states: [{ id: "ticker", description: "ticker", url: "/", expect: {} }],
  }).states[0];
  if (!target || !configured.viewports[0]) throw new Error("missing tuple");
  try {
    const result = await session.capture({
      project: configured,
      state: target,
      viewport: configured.viewports[0],
      navigationUrl: `http://127.0.0.1:${address.port}/`,
    });
    expect(result.ok).toBe(true);
    const observation = observationArtifactSchema.parse(result.observations);
    expect(
      observation.elements.find((e) => e.selector === "#ticker-text")?.rect
        .width,
    ).toBeGreaterThan(180);
    expect(
      observation.elements.find((e) => e.selector === "#ticker-text")?.painted
        ?.value,
    ).toBe(true);
    expect(observation.version === 2 && observation.clippedText).toEqual([]);
    expect(result.screenshot?.length).toBeGreaterThan(0);
  } finally {
    await session.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("native target labels capture only associated exposed clickable fragments", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  try {
    await page.setContent(
      await readFile(
        join(import.meta.dirname, "fixtures/target-size/exemptions.html"),
        "utf8",
      ),
    );
    const observed = observationArtifactSchema.parse(
      JSON.parse(
        JSON.stringify(await observePage(page, { status: "not-configured" })),
      ),
    );
    const owner = (id: string) => {
      const element = observed.elements.find(
        (element) => element.selector === `#${id}`,
      );
      if (!element) throw new Error(`missing ${id}`);
      return element;
    };
    for (const id of [
      "explicit",
      "wrapping",
      "multiple",
      "below",
      "new-owner",
    ]) {
      expect(owner(id).targetSizeLabels?.length).toBe(
        id === "multiple" ? 2 : 1,
      );
      expect(
        owner(id).targetSizeLabels?.some((label) =>
          label.rects.some((rect) => rect.width >= 24 && rect.height >= 24),
        ),
      ).toBe(true);
    }
    for (const id of [
      "hidden",
      "pointer",
      "wrong",
      "sr",
      "disabled",
      "transformed",
      "clip-path",
      "closed",
      "reassigned",
    ])
      expect(owner(id).targetSizeLabels).toEqual([]);
    expect(owner("clipped").targetSizeLabels?.[0]?.rects).toEqual([
      expect.objectContaining({ width: 10, height: 10 }),
    ]);
    expect(owner("below").targetSizeLabels?.[0]?.rects[0]?.y).toBeGreaterThan(
      900,
    );
    expect(
      owner("wrapped").targetSizeLabels?.[0]?.rects.length,
    ).toBeGreaterThan(1);
    expect(
      owner("wrapped").targetSizeLabels?.[0]?.rects.every(
        (rect) => rect.height < 24,
      ),
    ).toBe(true);
    expect(
      owner("nested").targetSizeLabels?.[0]?.rects.every(
        (rect) => rect.width < 24,
      ),
    ).toBe(true);
    const check = (width: number, current = observed) =>
      runDeterministicChecks([
        {
          console: [],
          mismatches: [],
          flow: "labels",
          state: "ready",
          viewport: "desktop",
          width,
          height: 900,
          metadataPath: "metadata.json",
          artifactPaths: ["observations.json"],
          commit: "abc123",
          createdAt: "2026-10-26T00:00:00.000Z",
          observations: current,
        },
      ])
        .candidates.filter(
          ({ candidate }) => candidate.category === "target-size",
        )
        .map(({ candidate }) => candidate.selectorHint);
    expect(check(1280)).not.toContain("#explicit");
    expect(check(1280)).not.toContain("#explicit-label");
    expect(check(1280)).toContain("#small");
    for (const id of [
      "explicit",
      "wrapping",
      "small",
      "clipped",
      "nested",
      "wrapped",
      "distant",
    ])
      expect(check(390)).toContain(`#${id}`);
    const legacy = structuredClone(observed);
    for (const element of legacy.elements) delete element.targetSizeLabels;
    expect(check(1280, legacy)).toContain("#explicit");
    // Browser activation confirms ownership, including independent nested links.
    await page.locator("#explicit-label").click();
    expect(await page.locator("#explicit").isChecked()).toBe(true);
    await page.locator("#wrapping-label").click({ position: { x: 70, y: 20 } });
    expect(await page.locator("#wrapping").isChecked()).toBe(true);
    await page.locator("#terms").click();
    expect(await page.locator("#nested").isChecked()).toBe(false);
    await page.locator("#second").click();
    expect(await page.locator("#multiple").isChecked()).toBe(true);
  } finally {
    await browser.close();
  }
}, 30_000);
