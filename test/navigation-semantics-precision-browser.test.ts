import { createServer } from "node:net";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { reviewFixture } from "./benchmark-support.js";
// @ts-expect-error The field app server is plain Node ESM without declarations.
import { fieldAppServer, ROUTES } from "./fixtures/field-app/server.mjs";
import { spawnFixtureServer } from "./support/fixture-server.js";

/**
 * Precision run for the three navigation checks: every field-app route and
 * every gate-app route, probed, draws none of their findings.
 */
const categories = new Set([
  "disclosure-affordance",
  "opener-cannot-close",
  "icon-meaning",
]);
// Every gate-app route renders one template; /orders adds its card.
const GATE_ROUTES = ["/catalog", "/orders"];

let browser: Browser;
let field: { url: string; close(): Promise<void> };
let gate: { url: string; close(): Promise<void> };

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

async function startGate() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = await spawnFixtureServer(
    join(import.meta.dirname, "fixtures", "gate-app", "server.mjs"),
    { env: { PORT: String(port) }, readyUrl: `${url}/ready` },
  );
  return { url, close: () => server.stop() };
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  field = await fieldAppServer();
  gate = await startGate();
});
afterAll(async () => {
  await gate?.close();
  await field?.close();
  await browser?.close();
});

async function fired(url: string) {
  let recorded = false;
  const findings = await reviewFixture(browser, "", {
    url,
    probe: true,
    onObservations: (observations) => {
      recorded =
        observations.version === 2 &&
        observations.iconControls !== undefined &&
        observations.probe?.indicators !== undefined &&
        observations.probe.reclick !== undefined;
    },
  });
  expect(recorded, url).toBe(true);
  return findings
    .map(({ candidate }) => candidate)
    .filter((candidate) => categories.has(candidate.category))
    .map(
      (candidate) => `${url} ${candidate.category}: ${candidate.explanation}`,
    );
}

test.each(ROUTES as string[])(
  "field-app %s draws no navigation findings",
  async (route) => {
    expect(await fired(`${field.url}${route}`)).toEqual([]);
  },
  90_000,
);

test.each(GATE_ROUTES)(
  "gate-app %s draws no navigation findings",
  async (route) => {
    expect(await fired(`${gate.url}${route}`)).toEqual([]);
  },
  90_000,
);
