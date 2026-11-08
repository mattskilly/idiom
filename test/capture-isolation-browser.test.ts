import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import type { BrowserSession } from "../src/capture/types.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

let server: Server;
let baseUrl: string;
let browser: Browser;
let session: BrowserSession;

beforeAll(async () => {
  const fixtures = join(import.meta.dirname, "fixtures/capture");
  const pages = {
    "/": await readFile(join(fixtures, "sandboxed-srcdoc.html")),
    "/motion": await readFile(join(fixtures, "motion-opt-in.html")),
  };
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    response.setHeader("Content-Type", "text/html");
    response.end(pages[path as keyof typeof pages] ?? "");
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
  session = await createBrowserLauncher({
    launch: async () => browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
});

afterAll(async () => {
  await session?.close();
  await browser?.close().catch(() => undefined);
  await new Promise<void>((accept) => server?.close(() => accept()));
});

const project = projectSchema.parse({
  version: 1,
  app: { name: "sandboxed", framework: "other" },
  server: {
    build: "node -e 0",
    start: "node -e 0",
    readyUrl: "http://127.0.0.1:1/",
    port: 1,
    env: {},
  },
  viewports: [{ name: "desktop", width: 800, height: 600 }],
  capture: { settleMs: 0, colorSchemeAttribute: "data-theme" },
  // Isolation and motion contracts are measured apart from the loading window.
  checks: { loadingStuck: { enabled: false } },
  design: {},
  model: { provider: "anthropic", model: "unused" },
});

function routeState(health: unknown = {}) {
  const flow = flowSchema.parse({
    id: "embed",
    title: "Embed",
    intent: [],
    setup: [],
    health,
    states: [{ id: "page", description: "Page", url: "/", expect: {} }],
  });
  const state = flow.states[0];
  if (!state) throw Error("missing state");
  return state;
}

async function capture(
  query: string,
  options: { probe?: boolean; allow?: string[] } = {},
) {
  const state = routeState();
  const viewport = project.viewports[0];
  if (!viewport) throw Error("missing viewport");
  return session.capture({
    project,
    state,
    viewport,
    navigationUrl: `${baseUrl}/${query}`,
    probe: options.probe,
    health: {
      allow: { urls: [], console: options.allow ?? [] },
    },
  });
}

test("Idiom's own init scripts raise nothing from a sandboxed srcdoc frame", async () => {
  const result = await capture("", { probe: true });
  expect(result.ok).toBe(true);
  expect(result.console).toEqual([]);
});

test("a real top-document console error is still recorded", async () => {
  const result = await capture("?fail", { probe: true });
  expect(result.console).toEqual([
    expect.objectContaining({ type: "error", text: "top document failure" }),
  ]);
  expect(result.console[0]?.healthAllowed).toBeUndefined();
});

test("health.allow applies to a route state with no steps", async () => {
  const result = await capture("?fail", { allow: ["top document failure"] });
  expect(result.console).toEqual([
    expect.objectContaining({
      text: "top document failure",
      healthAllowed: true,
    }),
  ]);
});

function stepState(steps: unknown[]) {
  const flow = flowSchema.parse({
    id: "motion",
    title: "Motion",
    intent: [],
    setup: [],
    states: [
      { id: "page", description: "Page", url: "/motion", steps, expect: {} },
    ],
  });
  const state = flow.states[0];
  if (!state) throw Error("missing state");
  return state;
}

async function motionText(
  state: ReturnType<typeof stepState>,
  options: { project?: boolean; tuple?: boolean },
) {
  const configured = projectSchema.parse({
    ...project,
    capture: {
      ...project.capture,
      ...(options.project === undefined
        ? {}
        : { hideWebdriver: options.project }),
    },
  });
  const viewport = configured.viewports[0];
  if (!viewport) throw Error("missing viewport");
  const result = await session.capture({
    project: configured,
    state,
    viewport,
    navigationUrl: `${baseUrl}/motion`,
    hideWebdriver: options.tuple,
  });
  expect(result.ok).toBe(true);
  return result.dom?.match(/motion (on|off)/)?.[0];
}

test("hideWebdriver lets an automation-aware app run its motion in route and step flows", async () => {
  const route = routeState();
  const steps = stepState([{ action: "click", selector: "#again" }]);
  // Without the option, behaviour is unchanged.
  expect(await motionText(route, {})).toBe("motion off");
  expect(await motionText(steps, {})).toBe("motion off");
  // Project-wide, and per flow (the resolved tuple value wins).
  expect(await motionText(route, { project: true })).toBe("motion on");
  expect(await motionText(steps, { tuple: true })).toBe("motion on");
  expect(await motionText(steps, { project: true, tuple: false })).toBe(
    "motion off",
  );
});

test("hideWebdriver is optional with no default, so existing configs parse unchanged", () => {
  expect("hideWebdriver" in project.capture).toBe(false);
  expect(stepState([])).not.toHaveProperty("hideWebdriver");
  expect(
    flowSchema.parse({
      id: "f",
      title: "F",
      intent: [],
      setup: [],
      hideWebdriver: true,
      states: [],
    }),
  ).toMatchObject({ hideWebdriver: true });
});
