import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page, type Request } from "playwright";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { writeTupleArtifacts } from "../src/capture/artifacts.js";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { runCapture, sanitizeDerivedResult } from "../src/capture/run.js";
import type { CaptureScope } from "../src/capture/scope.js";
import type { BrowserSession } from "../src/capture/types.js";
import {
  resolveWebHealth,
  WebStepFailure,
  WebStepRunner,
} from "../src/capture/web-steps.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import {
  buildReviewCoverage,
  buildVerificationCoverage,
  renderCoverageHtml,
  renderCoverageMarkdown,
} from "../src/report/coverage.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { flowSchema, isWebFlow, type WebStep } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const fixture = join(import.meta.dirname, "fixtures/web-flow-steps");
let temporary: string;
let logFile: string;
let child: ChildProcess;
let baseUrl: string;
let browser: Browser;
let session: BrowserSession;
const emptyAllow = { urls: [], console: [] };

async function freePort() {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("no port");
  await new Promise<void>((accept) => server.close(() => accept()));
  return address.port;
}
function projectAt(port: number, settleMs = 0) {
  return projectSchema.parse({
    version: 1,
    app: { name: "web steps", framework: "other" },
    server: {
      build: "node -e 0",
      start: `node ${JSON.stringify(join(fixture, "server.mjs"))}`,
      port,
      readyUrl: `http://127.0.0.1:${port}/`,
      env: { PORT: String(port), SERVER_LOG: logFile },
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: { settleMs },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
}
function flowWith(
  steps: unknown[],
  url = "/editor",
  health: unknown = {},
  stateHealth: unknown = {},
) {
  const flow = flowSchema.parse({
    id: "steps",
    title: "Web steps",
    intent: [],
    setup: [],
    health,
    states: [
      {
        id: "final",
        description: "Final state",
        url,
        steps,
        expect: {},
        health: stateHealth,
      },
    ],
  });
  if (!isWebFlow(flow)) throw Error("expected web flow");
  return flow;
}
async function capture(
  steps: unknown[],
  mode = "healthy",
  options: {
    health?: unknown;
    stateHealth?: unknown;
    settleMs?: number;
    probe?: boolean;
    analyze?: (page: Page) => Promise<unknown>;
  } = {},
) {
  const project = projectAt(Number(new URL(baseUrl).port), options.settleMs);
  const flow = flowWith(
    steps,
    `/editor?mode=${mode}`,
    options.health,
    options.stateHealth,
  );
  const state = flow.states[0];
  const viewport = project.viewports[0];
  if (!state || !viewport) throw Error("missing fixture tuple");
  const active = options.analyze
    ? await createBrowserLauncher({
        launch: async () => browser,
        createAxe: (page) => ({
          analyze: () => options.analyze?.(page) as Promise<unknown>,
        }),
      })()
    : session;
  return active.capture({
    project,
    state,
    viewport,
    navigationUrl: new URL(state.url ?? "/", baseUrl).href,
    health: resolveWebHealth(temporary, flow.health, state.health),
    probe: options.probe,
  });
}
const publish = { action: "click", selector: "#submit" };

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "idiom-web-steps-"));
  logFile = join(temporary, "server.log");
  await writeFile(logFile, "ERROR preexisting startup failure\n");
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(fixture, "server.mjs")], {
    env: { ...process.env, PORT: String(port), SERVER_LOG: logFile },
    stdio: "ignore",
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(baseUrl);
      break;
    } catch {
      if (attempt > 100) throw Error("fixture server did not start");
      await new Promise((accept) => setTimeout(accept, 25));
    }
  }
  browser = await chromium.launch({ headless: true });
  session = await createBrowserLauncher({
    launch: async () => browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
}, 20_000);
afterAll(async () => {
  await session?.close();
  child?.kill();
  await rm(temporary, { recursive: true, force: true });
});

test("a four-step form flow reaches and captures the editor", async () => {
  const flow = flowWith(
    [
      { action: "click", selector: "#new" },
      { action: "fill", selector: "#title", value: "My page" },
      { action: "select", selector: "#template", label: "Basic" },
      { action: "click", selector: "#create" },
    ],
    "/",
  );
  const project = projectAt(Number(new URL(baseUrl).port));
  const state = flow.states[0];
  const viewport = project.viewports[0];
  if (!state || !viewport) throw Error("missing tuple");
  const result = await session.capture({
    project,
    state,
    viewport,
    navigationUrl: baseUrl,
  });
  expect(result).toMatchObject({ ok: true, status: 200, mismatches: [] });
  expect(result.dom).toContain("Editor ready");
  expect(result.screenshot?.length).toBeGreaterThan(100);
});

test("every web step and the state load get an action timeline", async () => {
  const flow = flowWith(
    [
      { action: "click", selector: "#new" },
      { action: "fill", selector: "#title", value: "My page" },
      { action: "select", selector: "#template", label: "Basic" },
      { action: "click", selector: "#create" },
    ],
    "/",
  );
  const project = projectAt(Number(new URL(baseUrl).port));
  const state = flow.states[0];
  const viewport = project.viewports[0];
  if (!state || !viewport) throw Error("missing tuple");
  const result = await session.capture({
    project,
    state,
    viewport,
    navigationUrl: `${baseUrl}/?token=secret`,
  });
  expect(result.ok).toBe(true);
  const actions = result.timelines?.actions ?? [];
  expect(actions.map((action) => action.id)).toEqual([
    "load",
    "step-1",
    "step-2",
    "step-3",
    "step-4",
  ]);
  expect(actions.map((action) => action.kind)).toEqual([
    "navigation",
    "click",
    "fill",
    "select",
    "click",
  ]);
  const [load, first] = actions;
  if (!load || !first) throw Error("missing timelines");
  expect(load.name).toBe("/");
  // The load window closes where the user's first action begins.
  expect(load.startedAt + load.durationMs).toBeLessThanOrEqual(
    first.startedAt + 1,
  );
  expect(first.effectRegion.control).toBe("#new");
  expect(JSON.stringify(result.timelines)).not.toContain("secret");
  expect(JSON.stringify(result.observations)).not.toContain("__idiomTimeline");
});

test("supports select value (rather than matching a label), press, waits, URLs and duplicate visible text", async () => {
  const result = await capture([
    { action: "expectUrl", path: "/editor" },
    { action: "expectUrl", pattern: "/editor[?]mode=" },
    { action: "expectText", text: "Published page" },
    { action: "waitFor", selector: "#loading", state: "hidden" },
    { action: "waitFor", selector: "#code" },
    { action: "fill", selector: "#code", value: "abc" },
    { action: "press", selector: "#code", key: "Tab" },
  ]);
  expect(result.ok).toBe(true);
  const valueFlow = flowWith(
    [
      { action: "select", selector: "#template", value: "Basic" },
      { action: "click", selector: "#create" },
      { action: "expectUrl", pattern: "template=Basic$" },
    ],
    "/templates",
  );
  const project = projectAt(Number(new URL(baseUrl).port));
  const state = valueFlow.states[0];
  const viewport = project.viewports[0];
  if (!state || !viewport) throw Error("missing tuple");
  expect(
    (
      await session.capture({
        project,
        state,
        viewport,
        navigationUrl: `${baseUrl}/templates`,
      })
    ).ok,
  ).toBe(true);
}, 15_000);

test.each([false, true])(
  "delayed HTTP 500 belongs to click even with following action: %s",
  async (following) => {
    const result = await capture(
      [publish, ...(following ? [{ action: "click", selector: "#next" }] : [])],
      "broken",
    );
    expect(result).toMatchObject({
      ok: false,
      stage: "step",
      status: 200,
      message: expect.stringMatching(/Step 1 \(click\).*500.*\/broken/),
    });
    expect(result.screenshot?.length).toBeGreaterThan(100);
    expect(await (await fetch(`${baseUrl}/next-count`)).text()).toBe("0");
  },
);

test.each(["timer", "quiet", "console", "pageerror"])(
  "catches delayed %s activity before advancing",
  async (mode) => {
    const result = await capture(
      [publish, { action: "click", selector: "#next" }],
      mode,
    );
    expect(result).toMatchObject({
      ok: false,
      stage: "step",
      message: expect.stringContaining("Step 1 (click)"),
    });
  },
);

test("keeps final ownership through settle and awaited axe evidence", async () => {
  expect(await capture([publish], "settle", { settleMs: 600 })).toMatchObject({
    ok: false,
    stage: "step",
    message: expect.stringContaining("settle failure"),
  });
  expect(
    await capture([publish], "healthy", {
      analyze: async (page) => {
        await page.evaluate(() => {
          setTimeout(() => console.error("evidence failure"), 30);
        });
        await page.waitForTimeout(100);
        return { violations: [] };
      },
    }),
  ).toMatchObject({
    ok: false,
    stage: "step",
    message: expect.stringContaining("evidence failure"),
  });
});

test("allow rules merge and persist marked Chromium resource errors into stored review", async () => {
  const result = await capture([publish], "missing", {
    health: { allow: { console: ["expected console"] } },
    stateHealth: { allow: { urls: ["/missing$"] } },
  });
  expect(result.ok).toBe(true);
  const marked = result.console.find((record) => record.text.includes("404"));
  expect(marked).toMatchObject({
    type: "error",
    healthAllowed: true,
    location: { url: `${baseUrl}/missing` },
  });
  const flow = flowWith([publish]);
  const project = projectAt(Number(new URL(baseUrl).port));
  const state = flow.states[0];
  const viewport = project.viewports[0];
  if (!state || !viewport) throw Error("missing tuple");
  const directory = join(temporary, "marked");
  await mkdir(directory);
  const sanitized = sanitizeDerivedResult(result, `${baseUrl}/editor`, {
    kind: "setup-stdout",
    origin: baseUrl,
    source: "setup-stdout",
    pattern: "url=(.*)",
    append: "",
    template: `${baseUrl}/stable-editor`,
  });
  expect(
    sanitized.console.find((record) => record.text.includes("404"))
      ?.healthAllowed,
  ).toBe(true);
  await writeTupleArtifacts({
    stagingDirectory: directory,
    tuple: { flow, state, viewport, result: sanitized },
    source: { commit: "abc", dirty: false },
    browserVersion: "test",
    fallbackTimestamp: new Date().toISOString(),
  });
  const raw = await readFile(
    join(directory, "final/desktop/console.jsonl"),
    "utf8",
  );
  expect(raw).toContain('"healthAllowed":true');
  const loaded = await loadCaptureRun({
    runDirectory: directory,
    expectedFlow: "steps",
  });
  expect(loaded.tuples[0]?.console).toEqual(sanitized.console);
  expect(
    runDeterministicChecks(loaded.tuples).candidates.filter(
      ({ candidate }) => candidate.category === "console-error",
    ),
  ).toEqual([]);
  await writeFile(
    join(directory, "final/desktop/console.jsonl"),
    '{"type":"error","text":"x","healthAllowed":"true"}\n',
  );
  await expect(
    loadCaptureRun({ runDirectory: directory, expectedFlow: "steps" }),
  ).rejects.toThrow("healthAllowed must be a boolean");
  expect(await capture([publish], "missing")).toMatchObject({
    ok: false,
    stage: "step",
  });
  expect(
    await capture([publish], "console", {
      health: { allow: { urls: ["/missing$"] } },
    }),
  ).toMatchObject({ ok: false, stage: "step" });
});

test("console text allowances apply to console and page errors", async () => {
  for (const mode of ["console", "pageerror"]) {
    const result = await capture([publish], mode, {
      health: { allow: { console: ["renderer broken"] } },
      stateHealth: { allow: { console: ["uncaught fixture"] } },
    });
    expect(result.ok).toBe(true);
    expect(result.console.some((record) => record.healthAllowed)).toBe(true);
  }
});

test("server log ignores old errors and catches new post-response lines", async () => {
  await writeFile(logFile, "ERROR old failure\n");
  expect(
    (
      await capture([publish], "healthy", {
        health: { serverLog: "server.log" },
      })
    ).ok,
  ).toBe(true);
  const result = await capture([publish], "log", {
    health: { serverLog: "server.log", allow: { console: [".*"] } },
  });
  expect(result).toMatchObject({
    ok: false,
    stage: "step",
    message: expect.stringContaining("ERROR delayed server failure"),
  });
  expect(
    await capture([publish], "healthy", {
      health: { serverLog: "absent.log" },
    }),
  ).toMatchObject({
    ok: false,
    stage: "step",
    message: expect.stringContaining("is missing"),
  });
  expect(
    await capture([publish], "healthy", { health: { serverLog: "." } }),
  ).toMatchObject({
    ok: false,
    stage: "step",
    message: expect.stringContaining("not a regular file"),
  });
});

test("failure artifacts load as failed coverage and blockers; later states still capture", async () => {
  const port = await freePort();
  const project = projectAt(port);
  const flow = flowWith(
    [
      { action: "expectText", text: "Editor ready" },
      { action: "fill", selector: "#code", value: "page" },
      { action: "press", selector: "#code", key: "Tab" },
      publish,
    ],
    "/editor?mode=broken",
  );
  flow.states.push({
    ...(flow.states[0] as NonNullable<(typeof flow.states)[0]>),
    id: "following",
    url: "/editor",
    steps: [],
  });
  const directory = join(temporary, "run");
  const result = await runCapture({
    projectDirectory: temporary,
    project,
    flow,
    out: directory,
    dependencies: {
      browserLauncher: createBrowserLauncher({
        createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
      }),
      snapshotSource: async () => ({ commit: "abc", dirty: false }),
      inheritedEnvironment: { PATH: process.env.PATH },
    },
  });
  expect(result.counts).toEqual({ passed: 1, failed: 1, total: 2 });
  const baseline = await readFile(join(directory, "baseline.md"), "utf8");
  expect(baseline).toMatch(/Step 4 \(click\).*500/);
  expect(baseline).toContain("final/desktop/screenshot.png");
  const loaded = await loadCaptureRun({
    runDirectory: directory,
    expectedFlow: "steps",
  });
  expect(loaded.tuples.find((tuple) => tuple.state === "final")).toMatchObject({
    failure: { stage: "step" },
    screenshotPath: expect.stringContaining("screenshot.png"),
  });
  expect(runDeterministicChecks(loaded.tuples).candidates).toContainEqual(
    expect.objectContaining({
      candidate: expect.objectContaining({
        category: "missing-state",
        severity: "blocker",
      }),
    }),
  );
  expect(
    buildReviewCoverage({
      flow,
      project,
      tuples: loaded.tuples,
      commit: "abc",
    }),
  ).toMatchObject({ selectedTuples: 2, successfulTuples: 1 });
}, 20_000);

function mockPage(action: () => Promise<unknown> = async () => undefined) {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, {
    goto: vi.fn(async () => ({ status: () => 200 })),
    locator: vi.fn(() => ({ click: vi.fn(action) })),
    screenshot: vi.fn(async () => Buffer.from("failure screenshot")),
  });
  return page;
}
const clickStep: WebStep[] = [{ action: "click", selector: "button" }];

test("caps pending body completion, exempts allowed background requests, and removes listeners/timers", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    for (const allowed of [false, true]) {
      const page = mockPage(async () => {
        page.emit("request", request);
      });
      const request = { url: () => "http://fixture/background" } as Request;
      const runner = new WebStepRunner(
        page as unknown as Page,
        { allow: { urls: allowed ? ["/background$"] : [], console: [] } },
        {},
      );
      const result = runner
        .reach("http://fixture/", clickStep)
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(5_100);
      const value = await result;
      if (allowed) expect(value).toBe(200);
      else
        expect(value).toMatchObject({
          message: expect.stringContaining(
            "pending URLs: http://fixture/background",
          ),
        });
      await runner.dispose();
      expect(page.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    }
  } finally {
    vi.useRealTimers();
  }
});

test("health failure beats an action timeout and preserves diagnostics if screenshot fails", async () => {
  const page = mockPage(async () => {
    page.emit("pageerror", new Error("first diagnostic"));
    await new Promise(() => {});
  });
  page.screenshot.mockRejectedValue(new Error("screenshot unavailable"));
  const runner = new WebStepRunner(
    page as unknown as Page,
    { allow: emptyAllow },
    {},
  );
  try {
    const failure = await runner
      .reach("http://fixture/", clickStep)
      .catch((error) => error);
    expect(failure).toBeInstanceOf(WebStepFailure);
    expect(failure).toMatchObject({
      message: "Step 1 (click): uncaught page error: first diagnostic",
      screenshot: undefined,
    });
  } finally {
    await runner.dispose();
  }
  expect(page.eventNames()).toEqual([]);
});

for (const change of [
  "append",
  "truncate",
  "rotate",
  "create",
  "split",
] as const) {
  test(`continuous log cursor handles ${change}`, async () => {
    const path = join(temporary, `${change}.log`);
    if (change !== "create")
      await writeFile(path, "old content that is longer than replacement\n");
    const page = mockPage(async () => {
      if (change === "rotate") await rename(path, `${path}.old`);
      if (change === "append") await appendFile(path, "ERROR appended\n");
      else if (change === "split") {
        await appendFile(path, "ERR");
        setTimeout(() => {
          void appendFile(path, "OR split \u00e9\n");
        }, 80);
      } else await writeFile(path, "ERROR new\n");
    });
    const runner = new WebStepRunner(
      page as unknown as Page,
      { allow: emptyAllow, serverLog: path },
      {},
    );
    try {
      await expect(runner.reach("http://fixture/", clickStep)).rejects.toThrow(
        /Step 1 \(click\): server log: ERROR/,
      );
    } finally {
      await runner.dispose();
    }
    expect(page.eventNames()).toEqual([]);
  });
}

test("probe restoration replays the declared state before the next control", async () => {
  const project = projectAt(Number(new URL(baseUrl).port));
  const flow = flowWith([{ action: "click", selector: "#open" }], "/probe");
  const state = flow.states[0];
  const viewport = project.viewports[0];
  if (!state || !viewport) throw Error("missing tuple");
  const result = await session.capture({
    project,
    state,
    viewport,
    navigationUrl: `${baseUrl}/probe`,
    probe: true,
  });
  expect(result.ok).toBe(true);
  expect(result.observations?.version).toBe(2);
  if (result.observations?.version !== 2)
    throw Error("expected v2 observations");
  expect(result.observations.probe?.status).toBe("ran");
  expect(result.observations.probe?.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        selector: "#first",
        name: "First control",
        effects: expect.arrayContaining(["dom"]),
      }),
      expect.objectContaining({
        selector: "#second",
        name: "Second control",
        effects: expect.arrayContaining(["dom"]),
      }),
    ]),
  );
});

test("literal URL paths do not use glob matching", async () => {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/editor`);
  const runner = new WebStepRunner(page, { allow: emptyAllow }, {});
  // A path containing '*' is a literal pathname. Reject here via a mocked short
  // assertion deadline so this regression does not cost ten seconds.
  const wait = vi
    .spyOn(page, "waitForURL")
    .mockImplementation(async (predicate, options) => {
      expect(options?.timeout).toBe(10_000);
      if (typeof predicate !== "function") throw Error("expected predicate");
      expect(predicate(new URL(`${baseUrl}/editor`))).toBe(false);
      expect(predicate(new URL(`${baseUrl}/edit*`))).toBe(true);
      throw Error("exact path did not match");
    });
  try {
    await expect(
      runner.reach(`${baseUrl}/editor`, [
        { action: "expectUrl", path: "/edit*" },
      ]),
    ).rejects.toThrow("Step 1 (expectUrl): exact path did not match");
  } finally {
    wait.mockRestore();
    await runner.dispose();
    await page.close();
  }
});

test("waitFor and expectText wait for visible targets", async () => {
  const page = await browser.newPage();
  const runner = new WebStepRunner(page, { allow: emptyAllow }, {});
  const goto = vi.spyOn(page, "goto");
  goto.mockImplementation(async () => {
    await page.setContent(
      '<p hidden>Ready</p><div id="target" hidden>Working</div>',
    );
    await page.evaluate(() => {
      setTimeout(() => {
        const target = document.getElementById("target");
        if (target) {
          target.hidden = false;
          target.textContent = "Ready";
        }
      }, 100);
    });
    return null;
  });
  try {
    expect(
      await runner.reach("http://fixture/", [
        { action: "waitFor", selector: "#target", state: "visible" },
        { action: "expectText", text: "Ready" },
      ]),
    ).toBeNull();
  } finally {
    goto.mockRestore();
    await runner.dispose();
    await page.close();
  }
});

test("action errors use the finite action timeout and step failure path", async () => {
  const page = mockPage();
  page.locator.mockImplementation(() => ({
    click: vi.fn(async (...args: unknown[]) => {
      expect(args[0]).toEqual({ timeout: 10_000 });
      throw Error("selector syntax error");
    }),
  }));
  const runner = new WebStepRunner(
    page as unknown as Page,
    { allow: emptyAllow },
    {},
  );
  try {
    await expect(runner.reach("http://fixture/", clickStep)).rejects.toThrow(
      "Step 1 (click): selector syntax error",
    );
  } finally {
    await runner.dispose();
  }
});

test("persistent console activity hits the bounded drain cap", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const page = mockPage(async () => {
      const activity = () => {
        page.emit("console", {
          type: () => "info",
          text: () => "busy",
          location: () => ({ url: "", lineNumber: 0, columnNumber: 0 }),
        });
        timer = setTimeout(activity, 50);
      };
      activity();
    });
    const runner = new WebStepRunner(
      page as unknown as Page,
      { allow: emptyAllow },
      {},
    );
    const result = runner
      .reach("http://fixture/", clickStep)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await result).toMatchObject({
      message: expect.stringContaining("none (persistent activity)"),
    });
    clearTimeout(timer);
    await runner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    clearTimeout(timer);
    vi.useRealTimers();
  }
});

test("a server log cursor spans step handoffs and uses replacement patterns", async () => {
  const path = join(temporary, "handoff.log");
  await writeFile(path, "ERROR startup ignored\n");
  let clicks = 0;
  const page = mockPage(async () => {
    clicks++;
    if (clicks === 1)
      setTimeout(() => {
        void appendFile(path, "CUSTOM later step\n");
      }, 350);
  });
  const runner = new WebStepRunner(
    page as unknown as Page,
    {
      allow: emptyAllow,
      serverLog: path,
      serverErrorPatterns: ["CUSTOM"],
    },
    {},
  );
  try {
    await expect(
      runner.reach("http://fixture/", [...clickStep, ...clickStep]),
    ).rejects.toThrow("Step 2 (click): server log: CUSTOM later step");
  } finally {
    await runner.dispose();
  }
  expect(clicks).toBe(2);
  expect(page.eventNames()).toEqual([]);
});

test("log decoder carries incomplete UTF-8 and disposes its polling timer", async () => {
  const path = join(temporary, "utf8.log");
  await writeFile(path, "");
  const bytes = Buffer.from("CUSTOM café\n");
  const page = mockPage(async () => {
    await appendFile(path, bytes.subarray(0, bytes.length - 2));
    setTimeout(() => {
      void appendFile(path, bytes.subarray(bytes.length - 2));
    }, 90);
  });
  const runner = new WebStepRunner(
    page as unknown as Page,
    {
      allow: emptyAllow,
      serverLog: path,
      serverErrorPatterns: ["café"],
    },
    {},
  );
  try {
    await expect(runner.reach("http://fixture/", clickStep)).rejects.toThrow(
      "café",
    );
  } finally {
    await runner.dispose();
  }
  const calls = page.screenshot.mock.calls.length;
  await appendFile(path, "CUSTOM café\n");
  await new Promise((accept) => setTimeout(accept, 100));
  expect(page.eventNames()).toEqual([]);
  expect(page.screenshot).toHaveBeenCalledTimes(calls);
});

test("final finish drains requests newly started during evidence", async () => {
  expect(
    await capture([publish], "healthy", {
      analyze: async (page) => {
        await page.evaluate(() => {
          void fetch("/broken");
        });
        return { violations: [] };
      },
    }),
  ).toMatchObject({
    ok: false,
    stage: "step",
    message: expect.stringMatching(/Step 1 \(click\).*500.*\/broken/),
  });
});

test("probe replay failure remains partial probe coverage on a passing tuple", async () => {
  const project = projectAt(Number(new URL(baseUrl).port));
  const flow = flowWith(
    [{ action: "click", selector: "#open" }],
    "/probe?brokenReplay",
  );
  const state = flow.states[0];
  const viewport = project.viewports[0];
  if (!state || !viewport) throw Error("missing tuple");
  const result = await session.capture({
    project,
    state,
    viewport,
    navigationUrl: `${baseUrl}/probe?brokenReplay`,
    probe: true,
  });
  expect(result.ok).toBe(true);
  expect(
    result.console.some((record) => record.text.includes("replay failed")),
  ).toBe(false);
  if (result.observations?.version !== 2)
    throw Error("expected v2 observations");
  expect(result.observations.probe).toMatchObject({
    status: "partial",
    reason: expect.stringContaining("replay failed"),
  });
});

test("incomplete log line prefixes do not produce false errors; final unterminated errors are checked", async () => {
  const path = join(temporary, "line-fragments.log");
  await writeFile(path, "");
  const page = mockPage(async () => {
    await appendFile(path, "ERROR");
    setTimeout(() => {
      void appendFile(path, "S=0\n");
    }, 80);
  });
  const runner = new WebStepRunner(
    page as unknown as Page,
    { allow: emptyAllow, serverLog: path },
    {},
  );
  try {
    expect(await runner.reach("http://fixture/", clickStep)).toBe(200);
    await appendFile(path, "FATAL unterminated");
    await expect(runner.finish()).rejects.toThrow("FATAL unterminated");
  } finally {
    await runner.dispose();
  }
});

test.each(["hidden", "visible", "delayed"])(
  "expectText matches rendered text with hidden descendants: %s",
  async (mode) => {
    const project = projectAt(Number(new URL(baseUrl).port));
    const flow = flowWith(
      [{ action: "expectText", text: "Payment successful" }],
      `/text-expectations?mode=${mode}`,
    );
    const state = flow.states[0];
    const viewport = project.viewports[0];
    if (!state || !viewport) throw Error("missing tuple");
    const result = await session.capture({
      project,
      state,
      viewport,
      navigationUrl: new URL(state.url ?? "/", baseUrl).href,
    });
    if (mode === "hidden") {
      expect(result).toMatchObject({
        ok: false,
        stage: "step",
        status: 200,
        message: expect.stringMatching(/Step 1 \(expectText\).*10000ms/),
      });
      expect(result.screenshot?.length).toBeGreaterThan(100);
    } else {
      expect(result).toMatchObject({ ok: true, status: 200, mismatches: [] });
      expect(result.screenshot?.length).toBeGreaterThan(100);
      if (mode === "delayed") {
        // The hidden descendant must have become rendered before capture.
        expect(result.dom).toContain("<span>successful</span>");
      }
    }
  },
  15_000,
);

test.each(["console", "pageerror", "http"])(
  "slow actions get a post-action quiet interval for delayed %s failures",
  async (mode) => {
    const project = projectAt(Number(new URL(baseUrl).port));
    const flow = flowWith(
      [
        { action: "click", selector: "#first" },
        { action: "click", selector: "#next" },
      ],
      `/slow-action?mode=${mode}`,
    );
    const state = flow.states[0];
    const viewport = project.viewports[0];
    if (!state || !viewport) throw Error("missing tuple");
    const nextBefore = Number(
      await (await fetch(`${baseUrl}/next-count`)).text(),
    );
    const result = await session.capture({
      project,
      state,
      viewport,
      navigationUrl: new URL(state.url ?? "/", baseUrl).href,
    });
    const nextAfter = Number(
      await (await fetch(`${baseUrl}/next-count`)).text(),
    );
    expect({
      ok: result.ok,
      failure: result.ok
        ? undefined
        : { stage: result.stage, message: result.message },
      nextExecutions: nextAfter - nextBefore,
    }).toEqual({
      ok: false,
      failure: {
        stage: "step",
        message: expect.stringContaining("Step 1 (click)"),
      },
      nextExecutions: 0,
    });
    if (!result.ok)
      expect(result.message).toContain(
        mode === "http" ? "500" : "first action failed",
      );
    expect(result.screenshot?.length).toBeGreaterThan(100);
  },
);

test.each([
  "visible",
  "nested",
  "delayed",
  "hidden-word",
  "bare",
  "hidden-host",
])(
  "expectText searches rendered text in open shadow roots: %s",
  async (mode) => {
    const project = projectAt(Number(new URL(baseUrl).port));
    const flow = flowWith(
      [{ action: "expectText", text: "Payment successful" }],
      `/shadow-text?mode=${mode}`,
    );
    const state = flow.states[0];
    const viewport = project.viewports[0];
    if (!state || !viewport) throw Error("missing tuple");
    const result = await session.capture({
      project,
      state,
      viewport,
      navigationUrl: new URL(state.url ?? "/", baseUrl).href,
    });
    if (mode === "hidden-host") {
      expect(result).toMatchObject({
        ok: false,
        stage: "step",
        message: expect.stringMatching(/Step 1 \(expectText\).*10000ms/),
      });
    } else {
      expect(result).toMatchObject({ ok: true, status: 200, mismatches: [] });
      if (mode === "delayed")
        expect(result.dom).toContain('data-revealed="true"');
    }
    expect(result.screenshot?.length).toBeGreaterThan(100);
  },
  15_000,
);

function chainedFlow(states: unknown[]) {
  const flow = flowSchema.parse({
    id: "editor",
    title: "Chained states",
    intent: [],
    setup: [],
    states,
  });
  if (!isWebFlow(flow)) throw Error("expected web flow");
  return flow;
}
async function captureRun(
  flow: ReturnType<typeof chainedFlow>,
  out: string,
  scope?: CaptureScope,
) {
  const port = await freePort();
  const project = projectAt(port);
  const directory = join(temporary, out);
  const result = await runCapture({
    projectDirectory: temporary,
    project,
    flow,
    out: directory,
    scope,
    dependencies: {
      browserLauncher: createBrowserLauncher({
        createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
      }),
      snapshotSource: async () => ({ commit: "abc", dirty: false }),
      inheritedEnvironment: { PATH: process.env.PATH },
    },
  });
  const loaded = await loadCaptureRun({
    runDirectory: directory,
    expectedFlow: flow.id,
  });
  return { project, directory, result, loaded };
}
const openVersions = [
  { action: "click", selector: "#history" },
  { action: "click", selector: "#tab-versions" },
];

test("a state reached from another state captures and its dead control is probed", async () => {
  const flow = chainedFlow([
    {
      id: "empty",
      description: "Editor at rest",
      url: "/versions",
      expect: {},
    },
    {
      id: "versions",
      description: "Versions panel",
      from: "empty",
      steps: [
        ...openVersions,
        { action: "fill", selector: "#version-search", value: "Monday" },
        { action: "press", selector: "#version-search", key: "Enter" },
        { action: "focus", selector: "#version-search" },
        { action: "expectText", text: "Results for Monday" },
        { action: "expectText", text: "Name this version" },
      ],
      probe: true,
      expect: {},
    },
  ]);
  const { project, directory, result, loaded } = await captureRun(
    flow,
    "chained",
  );
  expect(result.counts).toEqual({ passed: 2, failed: 0, total: 2 });
  const versions = loaded.tuples.filter((tuple) => tuple.state === "versions");
  expect(versions).toHaveLength(1);
  const dead = runDeterministicChecks(versions).candidates.filter(
    ({ candidate }) => candidate.category === "dead-control",
  );
  expect(dead.map(({ candidate }) => candidate.explanation)).toEqual([
    expect.stringContaining('"Name this version"'),
  ]);
  const metadata = JSON.parse(
    await readFile(join(directory, "versions/desktop/metadata.json"), "utf8"),
  );
  expect(metadata.state).toMatchObject({ id: "versions", from: ["empty"] });
  const coverage = buildReviewCoverage({
    flow,
    project,
    tuples: loaded.tuples,
    commit: "abc",
  });
  expect(coverage.states).toEqual(["empty", "versions"]);
  expect(coverage.stateLabels).toEqual({ versions: "versions from empty" });
  expect(renderCoverageMarkdown(coverage)).toContain(
    "(empty, versions from empty)",
  );
  expect(renderCoverageHtml(coverage)).toContain(
    "(empty, versions from empty)",
  );
  expect(
    buildVerificationCoverage({
      flow,
      project,
      tuples: [{ state: "versions", viewport: "desktop" }],
      successfulTuples: 1,
    }),
  ).toMatchObject({
    states: ["versions"],
    stateLabels: { versions: "versions from empty" },
  });
}, 60_000);

test("a scoped chained state keeps ancestor steps and discloses only its selected coverage", async () => {
  const flow = chainedFlow([
    { id: "empty", description: "Editor", url: "/versions", expect: {} },
    {
      id: "versions",
      description: "Versions panel",
      from: "empty",
      steps: [
        ...openVersions,
        { action: "expectText", text: "Name this version" },
      ],
      probe: true,
      expect: {},
    },
  ]);
  const { project, directory, result, loaded } = await captureRun(
    flow,
    "chained-scoped",
    { states: "versions" },
  );
  expect(result.counts).toEqual({ passed: 1, failed: 0, total: 1 });
  expect(loaded.tuples.map((tuple) => tuple.state)).toEqual(["versions"]);
  expect(loaded.record?.probe.executed).toEqual([
    { state: "versions", viewport: "desktop", colorScheme: "light" },
  ]);
  const coverage = buildReviewCoverage({
    flow,
    project,
    record: loaded.record,
    tuples: loaded.tuples,
    commit: "abc",
  });
  expect(coverage).toMatchObject({
    states: ["versions"],
    stateLabels: { versions: "versions from empty" },
    selectedTuples: 1,
    skippedTuples: 1,
    omittedStates: ["empty"],
  });
  expect(await readFile(join(directory, "baseline.md"), "utf8")).toContain(
    "versions from empty",
  );
}, 60_000);

test("a failing ancestor step fails the chained tuple naming the chain", async () => {
  const flow = chainedFlow([
    {
      id: "draft",
      description: "Draft published with a failing request",
      url: "/editor?mode=broken",
      steps: [{ action: "fill", selector: "#code", value: "page" }, publish],
      expect: {},
    },
    {
      id: "after",
      description: "After publishing",
      from: "draft",
      steps: [{ action: "expectText", text: "Editor ready" }],
      expect: {},
    },
  ]);
  const { directory, result } = await captureRun(flow, "chained-broken");
  expect(result.counts).toEqual({ passed: 0, failed: 2, total: 2 });
  const baseline = await readFile(join(directory, "baseline.md"), "utf8");
  expect(baseline).toMatch(
    /Step 2 \(click\) of "draft" reaching after from draft: .*500/,
  );
  expect(baseline).toMatch(/Step 2 \(click\): .*500/);
}, 60_000);

test("a focus step moves focus to its target", async () => {
  const flow = chainedFlow([
    {
      id: "search",
      description: "Version search focused",
      url: "/versions",
      steps: [
        ...openVersions,
        { action: "focus", selector: "#version-search" },
        { action: "expectText", text: "Searching versions" },
      ],
      expect: {},
    },
  ]);
  const project = projectAt(Number(new URL(baseUrl).port));
  const state = flow.states[0];
  const viewport = project.viewports[0];
  if (!state || !viewport) throw Error("missing tuple");
  const result = await session.capture({
    project,
    state,
    viewport,
    navigationUrl: `${baseUrl}/versions`,
  });
  expect(result).toMatchObject({ ok: true, mismatches: [] });
});

test.each(["keyed", "action"])(
  "expectVisible %s waits for app selection to bring the footer into view",
  async (mode) => {
    const assertion =
      mode === "keyed"
        ? { expectVisible: { selector: "#selected-footer", within: ".canvas" } }
        : {
            action: "expectVisible",
            selector: "#selected-footer",
            within: ".canvas",
          };
    const flow = flowWith(
      [
        {
          action: "click",
          selector: "button[aria-label='Select global footer']",
        },
        assertion,
      ],
      "/shell-after",
    );
    const project = projectAt(Number(new URL(baseUrl).port));
    const state = flow.states[0],
      viewport = project.viewports[0];
    if (!state || !viewport) throw Error("fixture");
    const result = await session.capture({
      project,
      state,
      viewport,
      shell: ".ed-shell",
      navigationUrl: `${baseUrl}/shell-after`,
    });
    expect(result).toMatchObject({ ok: true });
    if (result.observations?.version !== 2) throw Error("v2");
    expect(result.observations.shellVisibility?.shell).toMatchObject({
      status: "measured",
      selector: ".ed-shell",
    });
  },
);

test("expectVisible waits for delayed geometry without scrolling or focusing", async () => {
  const page = await browser.newPage();
  await page.route("**/delayed-visible", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<div id="target" style="display:none">Ready</div><script>setTimeout(()=>document.querySelector('#target').style.display='block',150)</script>`,
    }),
  );
  const runner = new WebStepRunner(page, { allow: emptyAllow }, {});
  try {
    await runner.reach("http://fixture/delayed-visible", [
      { action: "expectVisible", selector: "#target" },
    ]);
    await runner.finish();
    expect(
      await page.evaluate(() => ({
        scroll: scrollY,
        focused: document.activeElement?.tagName,
      })),
    ).toEqual({ scroll: 0, focused: "BODY" });
  } finally {
    await runner.dispose();
    await page.close();
  }
});

test("expectVisible failure keeps step attribution, failure screenshot, and scroll positions", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const runner = new WebStepRunner(page, { allow: emptyAllow }, {});
  try {
    await expect(
      runner.reach(
        `${baseUrl}/shell-before`,
        [
          {
            action: "click",
            selector: "button[aria-label='Select global footer']",
          },
          {
            action: "expectVisible",
            selector: "#selected-footer",
            within: ".canvas",
          },
        ],
        {
          state: "selected",
          reachedFrom: {
            chain: ["selected", "editor"],
            stepStates: ["selected", "selected"],
          },
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /Step 2 \(expectVisible\).*selected from editor.*target not visible.*#selected-footer.*canvas/,
      ),
      screenshot: expect.any(Buffer),
    });
    expect(
      await page.evaluate(() => ({
        shell: document.querySelector(".ed-shell")?.scrollTop,
        canvas: document.querySelector(".canvas")?.scrollTop,
        document: scrollY,
      })),
    ).toEqual({ shell: 0, canvas: 0, document: 0 });
  } finally {
    await runner.dispose();
    await page.close();
  }
}, 15000);

test("shell and overlay evidence survives a multi-tuple capture with chained and generated states", async () => {
  const port = await freePort();
  const project = projectSchema.parse({
    ...projectAt(port),
    viewports: [
      { name: "desktop", width: 1440, height: 900 },
      { name: "compact", width: 1000, height: 700 },
    ],
    colorSchemes: ["light", "dark"],
    checks: {
      shellVisibility: {
        floatingOverlays: ["#selection-toolbar", "#selection-breadcrumb"],
      },
    },
  });
  const flow = flowSchema.parse({
    id: "shell",
    title: "Shell",
    setup: [],
    intent: [],
    shell: ".ed-shell",
    states: [
      { id: "editor", description: "Editor", url: "/shell-before", expect: {} },
      {
        id: "selected",
        description: "Selected",
        from: "editor",
        steps: [
          {
            action: "click",
            selector: "button[aria-label='Select global footer']",
          },
        ],
        expect: {},
      },
    ],
    toggleRegions: [".ed-shell"],
    toggles: {
      selection: {
        active: [{ expectVisible: { selector: "#selection-toolbar" } }],
        same: [{ expectVisible: { selector: "#selection-toolbar" } }],
      },
    },
  });
  const directory = join(temporary, "shell-evidence");
  const result = await runCapture({
    projectDirectory: temporary,
    project,
    flow,
    out: directory,
    dependencies: {
      browserLauncher: createBrowserLauncher({
        createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
      }),
      snapshotSource: async () => ({ commit: "abc", dirty: false }),
      inheritedEnvironment: { PATH: process.env.PATH },
    },
  });
  expect(result.counts.failed).toBe(0);
  const loaded = await loadCaptureRun({
    runDirectory: directory,
    expectedFlow: "shell",
  });
  expect(loaded.tuples).toHaveLength(24);
  expect(
    loaded.tuples.some((tuple) => tuple.layoutRepresentative !== undefined),
  ).toBe(true);
  for (const tuple of loaded.tuples) {
    const findings = runDeterministicChecks([tuple], undefined, {
      ...checksConfigFrom(),
      shellVisibility: {
        floatingOverlays: ["#selection-toolbar", "#selection-breadcrumb"],
      },
    }).candidates.filter(
      ({ candidate }) => candidate.category === "shell-visibility",
    );
    expect(findings).toHaveLength(2);
    expect(
      tuple.observations?.version === 2 &&
        tuple.observations.shellVisibility?.shell.status,
    ).toBe("measured");
  }
}, 60000);

test("persisted failed visibility assertion remains a missing-state finding", async () => {
  const { loaded } = await captureRun(
    chainedFlow([
      { id: "editor", description: "Editor", url: "/shell-before", expect: {} },
      {
        id: "selected",
        description: "Selected",
        from: "editor",
        steps: [{ expectVisible: { selector: "#selected-footer" } }],
        expect: {},
      },
    ]),
    "shell-step-failure",
  );
  const tuple = loaded.tuples.find((tuple) => tuple.state === "selected");
  expect(tuple?.failure).toMatchObject({
    stage: "step",
    message: expect.stringContaining("target not visible"),
  });
  expect(
    runDeterministicChecks(loaded.tuples).candidates.some(
      ({ candidate }) =>
        candidate.category === "missing-state" &&
        candidate.explanation.includes("target not visible"),
    ),
  ).toBe(true);
}, 20000);

test("expectVisible retries when document navigation destroys a measurement context", async () => {
  const page = await browser.newPage();
  const runner = new WebStepRunner(page, { allow: emptyAllow }, {});
  const evaluate = page.evaluate.bind(page);
  const interrupted = vi
    .spyOn(page, "evaluate")
    .mockImplementationOnce(async () =>
      evaluate(async (destination) => {
        location.assign(destination);
        await new Promise(() => {});
      }, `${baseUrl}/shell-after`),
    );
  try {
    await expect(
      runner.reach(`${baseUrl}/shell-before`, [
        { action: "expectVisible", selector: "#selection-toolbar" },
      ]),
    ).resolves.toBe(200);
    await runner.finish();
    expect(page.url()).toBe(`${baseUrl}/shell-after`);
    expect(interrupted.mock.calls.length).toBeGreaterThan(1);
  } finally {
    interrupted.mockRestore();
    await runner.dispose();
    await page.close();
  }
});

test("expectVisible follows a click's delayed document navigation without an intervening wait", async () => {
  const page = await browser.newPage();
  const runner = new WebStepRunner(page, { allow: emptyAllow }, {});
  const flow = flowWith(
    [
      { action: "click", selector: "#open" },
      { expectVisible: { selector: "#selection-toolbar", within: "body" } },
    ],
    "/visibility-navigation",
  );
  const state = flow.states[0];
  if (!state) throw Error("fixture");
  try {
    await runner.reach(`${baseUrl}/visibility-navigation`, state.steps);
    await runner.finish();
    expect(page.url()).toBe(`${baseUrl}/shell-after`);
  } finally {
    await runner.dispose();
    await page.close();
  }
});
