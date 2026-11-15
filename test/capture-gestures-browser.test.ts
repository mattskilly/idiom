import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import type { BrowserSession, TupleResult } from "../src/capture/types.js";
import { resolveWebHealth, WebStepRunner } from "../src/capture/web-steps.js";
import {
  flowSchema,
  isWebFlow,
  type WebFlow,
  type WebStep,
} from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import {
  type FixtureServer,
  fixtureCommand,
  spawnFixtureServer,
} from "./support/fixture-server.js";

const fixture = join(import.meta.dirname, "fixtures/web-flow-steps");
let fixtureServer: FixtureServer | undefined;
let baseUrl: string;
let browser: Browser;
let session: BrowserSession;
let flow: WebFlow;

const desktop = { name: "desktop", width: 800, height: 600 };
const phone = { name: "phone", width: 390, height: 844, touch: true };
const schemes = ["light", "dark"] as const;

async function freePort() {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("no port");
  await new Promise<void>((accept) => server.close(() => accept()));
  return address.port;
}

function project() {
  const port = Number(new URL(baseUrl).port);
  return projectSchema.parse({
    version: 1,
    app: { name: "gestures", framework: "other" },
    server: {
      build: "node -e 0",
      start: fixtureCommand(join(fixture, "server.mjs")),
      port,
      readyUrl: `${baseUrl}/`,
      env: { PORT: String(port) },
    },
    viewports: [desktop, phone],
    colorSchemes: [...schemes],
    capture: { settleMs: 0 },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
}

function stateOf(id: string) {
  const state = flow.states.find((candidate) => candidate.id === id);
  if (state === undefined) throw Error(`missing state ${id}`);
  // The fixture never loads lazily; skip the default 5 s loading window.
  return { ...state, loadingSettleMs: 50 };
}

function tupleFor(
  id: string,
  viewport: { name: string; width: number; height: number; touch?: boolean },
  colorScheme: (typeof schemes)[number] = "light",
  probe = false,
) {
  const state = stateOf(id);
  return {
    project: project(),
    state,
    viewport,
    colorScheme,
    navigationUrl: new URL(state.url ?? "/", baseUrl).href,
    health: resolveWebHealth(fixture, flow.health, state.health),
    probe,
  };
}

function okResult(result: TupleResult): TupleResult & { dom: string } {
  expect(result, result.ok ? "" : result.message).toMatchObject({ ok: true });
  return result as TupleResult & { dom: string };
}

beforeAll(async () => {
  const parsed = flowSchema.parse(
    JSON.parse(await readFile(join(fixture, "gestures.flow.json"), "utf8")),
  );
  if (!isWebFlow(parsed)) throw Error("expected web flow");
  flow = parsed;
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  fixtureServer = await spawnFixtureServer(join(fixture, "server.mjs"), {
    env: { PORT: String(port) },
    readyUrl: baseUrl,
  });
  browser = await chromium.launch({ headless: true });
  session = await createBrowserLauncher({
    launch: async () => browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
}, 20_000);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await session?.close();
  await fixtureServer?.stop();
});

test("the nudged state reaches the offset chip from flow steps alone, with identical geometry across two runs", async () => {
  const runs: Array<
    Array<{ screenshot: unknown; geometry: unknown; rects: unknown }>
  > = [];
  for (const _run of [1, 2]) {
    const tuples = [];
    for (const viewport of [desktop, phone])
      for (const scheme of schemes) {
        const tuple = tupleFor("nudged", viewport, scheme);
        const result = okResult(await session.capture(tuple));
        expect(result.dom).toContain("x −6 · y −18");
        expect(result.dom).toMatch(
          /id="offset-chip"[^>]*data-x="-6"[^>]*data-y="-18"/,
        );
        expect(result.dom).toContain('id="toolbar"');
        const rects = await session.measure?.(tuple, [
          "#offset-chip",
          "[data-block=button]",
        ]);
        expect(rects).toBeDefined();
        tuples.push({
          screenshot: result.screenshot,
          geometry:
            result.observations?.version === 2
              ? result.observations.screenshot
              : undefined,
          rects,
        });
      }
    runs.push(tuples);
  }
  const [first, second] = runs;
  // The button moved from (60, 80) by (−6, −18) within the canvas.
  expect(JSON.parse(first?.[0]?.rects as string)[1]).toEqual(["64,62,100,40"]);
  expect(second?.map((tuple) => tuple.rects)).toEqual(
    first?.map((tuple) => tuple.rects),
  );
  expect(second?.map((tuple) => tuple.geometry)).toEqual(
    first?.map((tuple) => tuple.geometry),
  );
  for (const [index, tuple] of (second ?? []).entries())
    expect(
      Buffer.compare(
        tuple.screenshot as Buffer,
        first?.[index]?.screenshot as Buffer,
      ),
    ).toBe(0);
}, 60_000);

test("a held drag stays held through every viewport and scheme's evidence, blocks the probe, and is released afterwards", async () => {
  const dropped: Array<string | undefined> = [];
  const original = WebStepRunner.prototype.releasePointer;
  vi.spyOn(WebStepRunner.prototype, "releasePointer").mockImplementation(
    async function (this: WebStepRunner) {
      const held = this.holdingPointer;
      await original.call(this);
      if (!held) return;
      const page = (this as unknown as { page: Page }).page;
      dropped.push(
        await page.evaluate(() => document.body.dataset.dropped ?? undefined),
      );
    },
  );
  for (const viewport of [desktop, phone])
    for (const scheme of schemes) {
      const result = okResult(
        await session.capture(tupleFor("dragging", viewport, scheme, true)),
      );
      expect(result.dom).toContain('id="drag-preview"');
      expect(result.dom).toMatch(/class="drop-zone over"/);
      expect(result.observations).toMatchObject({
        probe: {
          status: "partial",
          reason: expect.stringContaining("holds a drag"),
        },
      });
    }
  // Every tuple released its drag over the drop zone once evidence was saved.
  expect(dropped).toEqual(["zone", "zone", "zone", "zone"]);
}, 60_000);

test("a state reached from a held drag captures with the preview still held", async () => {
  const result = okResult(await session.capture(tupleFor("chained", desktop)));
  expect(result.dom).toContain('id="drag-preview"');
}, 30_000);

test("hover, Meta+click, double-click and an offset drag each reach their state", async () => {
  const hovered = okResult(
    await session.capture(tupleFor("tile-hover", desktop)),
  );
  expect(hovered.dom).toContain('data-hovered="true"');
  const resting = okResult(
    await session.capture({
      ...tupleFor("tile-hover", desktop),
      state: {
        ...stateOf("tile-hover"),
        steps: [],
        expect: { ...stateOf("tile-hover").expect, selectorPresent: [] },
      },
    }),
  );
  expect(resting.dom).not.toContain('data-hovered="true"');
  expect(
    Buffer.compare(hovered.screenshot as Buffer, resting.screenshot as Buffer),
  ).not.toBe(0);

  const multi = okResult(
    await session.capture(tupleFor("multi-select", desktop)),
  );
  expect(multi.dom).toContain("2 selected");
  expect(multi.dom.match(/class="selected"/g)).toHaveLength(2);

  const editing = okResult(
    await session.capture(tupleFor("inline-edit", desktop)),
  );
  expect(editing.dom).toContain('id="inline-editing"');
  expect(editing.dom).toContain('contenteditable="true"');

  const offset = okResult(
    await session.capture(tupleFor("drag-offset", desktop)),
  );
  expect(offset.dom).toContain('data-dropped="zone"');
  expect(offset.dom).not.toContain('id="drag-preview"');
}, 60_000);

test("the state after a held drag starts clean", async () => {
  okResult(await session.capture(tupleFor("dragging", desktop)));
  const next = okResult(await session.capture(tupleFor("nudged", desktop)));
  expect(next.dom).not.toContain('id="drag-preview"');
  expect(next.dom).not.toContain("data-dropped");
}, 30_000);

async function runnerOn(page: Page) {
  return new WebStepRunner(
    page,
    { allow: { urls: [], console: [] } },
    { animations: "disabled" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { navigation: 10_000, readiness: 1_500, quiet: 2_000 },
  );
}

test("the runner holds a drag until releasePointer, which is idempotent", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const runner = await runnerOn(page);
  try {
    const steps: WebStep[] = [
      {
        action: "drag",
        selector: ".drag-handle",
        target: ".drop-zone",
        hold: true,
      },
    ];
    await runner.reach(`${baseUrl}/gestures`, steps);
    expect(runner.holdingPointer).toBe(true);
    expect(await page.locator("#drag-preview").count()).toBe(1);
    await runner.releasePointer();
    expect(runner.holdingPointer).toBe(false);
    expect(await page.evaluate(() => document.body.dataset.dropped)).toBe(
      "zone",
    );
    await page.evaluate(() => {
      document.body.dataset.dropped = "kept";
    });
    await runner.releasePointer();
    expect(await page.evaluate(() => document.body.dataset.dropped)).toBe(
      "kept",
    );
  } finally {
    await runner.dispose();
    await context.close();
  }
}, 30_000);

test("a drag whose target never appears fails its step and leaves the pointer released", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const runner = await runnerOn(page);
  try {
    await expect(
      runner.reach(`${baseUrl}/gestures`, [
        { action: "click", selector: "[data-block=button]" },
        {
          action: "drag",
          selector: ".drag-handle",
          target: "#nowhere",
          hold: true,
        },
      ]),
    ).rejects.toThrow(/Step 2 \(drag\)/);
    expect(await page.locator("#drag-preview").count()).toBe(0);
    expect(await page.evaluate(() => document.body.dataset.dropped)).toBe(
      "outside",
    );
  } finally {
    await runner.dispose();
    await context.close();
  }
}, 30_000);
