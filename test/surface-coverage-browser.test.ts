import { createServer } from "node:net";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import type { BrowserSession } from "../src/capture/types.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import type { ObservationArtifactV2 } from "../src/checks/types.js";
import {
  computeSurfaceCoverage,
  type SurfaceCoverage,
} from "../src/coverage/surfaces.js";
import { flowSchema, isWebFlow } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { tupleOf } from "./revealed-support.js";
import {
  type FixtureServer,
  fixtureCommand,
  spawnFixtureServer,
} from "./support/fixture-server.js";

const fixture = join(import.meta.dirname, "fixtures/surface-coverage");
let fixtureServer: FixtureServer | undefined;
let baseUrl: string;
let browser: Browser;
let session: BrowserSession;

async function freePort() {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("no port");
  await new Promise<void>((accept) => server.close(() => accept()));
  return address.port;
}

const rawFlow = {
  id: "canvas",
  title: "Canvas",
  intent: [],
  setup: [],
  states: [
    {
      id: "canvas",
      description: "The canvas at rest",
      url: "/canvas",
      expect: {},
    } as Record<string, unknown>,
  ],
};

function project() {
  const port = Number(new URL(baseUrl).port);
  return projectSchema.parse({
    version: 1,
    app: { name: "surfaces", framework: "other" },
    server: {
      build: "node -e 0",
      start: fixtureCommand(join(fixture, "server.mjs")),
      port,
      readyUrl: `${baseUrl}/`,
      env: { PORT: String(port) },
    },
    viewports: [{ name: "desktop", width: 900, height: 700 }],
    capture: { settleMs: 0 },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
}

/** Captures one state of the raw flow and returns its check tuple. */
async function captureState(raw: typeof rawFlow, id: string) {
  const flow = flowSchema.parse(raw);
  if (!isWebFlow(flow)) throw Error("expected a web flow");
  const state = flow.states.find((entry) => entry.id === id);
  const current = project();
  const viewport = current.viewports[0];
  if (state === undefined || viewport === undefined) throw Error("no tuple");
  const result = await session.capture({
    project: current,
    state,
    viewport,
    navigationUrl: new URL(state.url ?? "/", baseUrl).href,
  });
  expect(result.ok).toBe(true);
  // The inventory survives the stored artifact schema.
  const observations = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(result.observations)),
  ) as ObservationArtifactV2;
  return { flow, tuple: tupleOf(observations, id) };
}

function ran(coverage: SurfaceCoverage) {
  if (coverage.status !== "ran") throw Error(coverage.reason);
  return coverage;
}

beforeAll(async () => {
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
}, 30_000);
afterAll(async () => {
  await session?.close();
  await browser?.close();
  await fixtureServer?.stop();
});

test("an unopened menu, unselected options and a closed popover are listed, and each pasted draft captures its surface", async () => {
  const { flow, tuple: base } = await captureState(rawFlow, "canvas");
  const coverage = ran(computeSurfaceCoverage([base], flow));
  const listed = coverage.unrevealed.map((entry) => [
    entry.kind,
    entry.selector,
  ]);
  expect(listed).toEqual(
    expect.arrayContaining([
      ["menu", "#more"],
      ["popover", "#share"],
      ["selectable", "#size-s"],
    ]),
  );
  expect(coverage.covered).toBe(0);
  const more = coverage.unrevealed.find((entry) => entry.selector === "#more");
  expect(more).toMatchObject({ name: "More", reveals: 3 });
  expect(more?.suggestion.steps).toEqual([
    { action: "click", selector: "#more" },
    { action: "waitFor", selector: "#more-menu", state: "visible" },
  ]);
  // The menu reveals more than an option, so it ranks above it.
  const rank = (selector: string) =>
    coverage.unrevealed.findIndex((entry) => entry.selector === selector);
  expect(rank("#more")).toBeLessThan(rank("#size-s"));

  for (const selector of ["#more", "#share", "#size-s"]) {
    const entry = coverage.unrevealed.find(
      (candidate) => candidate.selector === selector,
    );
    if (entry === undefined) throw Error(`missing ${selector}`);
    const pasted = {
      ...rawFlow,
      states: [...rawFlow.states, entry.suggestion],
    };
    const { flow: next, tuple } = await captureState(
      pasted,
      entry.suggestion.id,
    );
    const after = ran(computeSurfaceCoverage([base, tuple], next));
    expect(
      after.unrevealed.map((candidate) => candidate.selector),
      selector,
    ).not.toContain(selector);
    expect(after.covered, selector).toBe(1);
  }
}, 90_000);
