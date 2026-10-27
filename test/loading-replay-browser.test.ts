import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createProbeSafetyLedger,
  type ProbeOptions,
  probeControls,
} from "../src/capture/probe.js";
import { actionTimelineArtifactSchema } from "../src/checks/artifact-schema.js";
import type {
  ActionTimelineArtifact,
  HeldReplay,
} from "../src/checks/types.js";
import { type LoadingServer, startLoadingServer } from "./loading-support.js";

let browser: Browser;
let server: LoadingServer;
beforeAll(async () => {
  browser = await chromium.launch();
  server = await startLoadingServer();
});
afterAll(async () => {
  await server.close();
  await browser.close();
});

/** Probe one fixture with the held replay on; returns the artifact and timelines. */
async function probe(path: string, options: Partial<ProbeOptions> = {}) {
  const page = await browser.newPage();
  const url = `${server.origin}/${path}`;
  let timelines: ActionTimelineArtifact | undefined;
  try {
    await page.goto(url);
    const artifact = await probeControls({
      page,
      skip: [],
      maxControls: 10,
      waitMs: 150,
      restore: async (active: Page) => {
        await active.goto(url);
      },
      heldReplay: { delayMs: 1500, withinMs: 1000, steps: [] },
      onTimelines: (recorded) => {
        timelines = recorded;
      },
      ...options,
    });
    if (timelines)
      actionTimelineArtifactSchema.parse(JSON.parse(JSON.stringify(timelines)));
    const slow = (timelines?.actions ?? []).filter(
      (action) => action.source === "slow-replay",
    );
    return { artifact, timelines, slow };
  } finally {
    await page.close();
  }
}
const heldOf = (actions: Array<{ held?: HeldReplay | undefined }>) => {
  const held = actions[0]?.held;
  if (!held) throw new Error("no held replay");
  return held;
};

test("a held GET is released after delayMs and its result follows the release", async () => {
  const { artifact, slow } = await probe("loading-state/before.html");
  expect(artifact.heldReplay).toMatchObject({ queued: 1, ran: 1, notes: [] });
  expect(slow).toHaveLength(1);
  const held = heldOf(slow);
  expect(held.requests).toEqual([
    expect.objectContaining({
      method: "GET",
      path: "/api/items",
      forwarded: true,
    }),
  ]);
  expect(held.releasedAt).toBeGreaterThan(1400);
  expect(held.releasedAt).toBeLessThan(2200);
  expect(held.dispatched).toBe(true);
  expect(held.indicators).toEqual([]);
  expect(held.changedAfterRelease).toBe(true);
  expect(held.firstChange?.time).toBeGreaterThanOrEqual(held.releasedAt ?? 0);
  // The replay never publishes probe results of its own.
  expect(artifact.results).toHaveLength(1);
});

test("feedback within the window is recorded as indicators", async () => {
  const held = heldOf((await probe("loading-state/after.html")).slow);
  expect(held.indicators.map((indicator) => indicator.kind)).toEqual(
    expect.arrayContaining([
      "trigger-disabled",
      "trigger-busy",
      "control-text",
    ]),
  );
  expect(held.indicator?.time).toBeLessThan(200);
});

test("a route change: nav highlight is outside main, main changes only after release", async () => {
  const { slow } = await probe("route-change/before.html");
  const orders = slow.find((action) => action.held?.routeChange !== null);
  const held = heldOf(orders ? [orders] : []);
  expect(held.routeChange).toMatchObject({ to: "/orders" });
  expect(held.mainSelector).toBe("main");
  expect(held.indicators.filter((indicator) => indicator.inMain)).toEqual([]);
  expect(held.firstMainChange?.time).toBeGreaterThanOrEqual(
    held.releasedAt ?? 0,
  );
  expect(held.mainEmpty?.from).toBeLessThan(100);
});

test("a held POST never reaches the server; the second activation's duplicate is aborted too", async () => {
  const before = server.nonGet.length;
  const { slow } = await probe("double-submit/before.html");
  const held = heldOf(slow);
  expect(held.requests).toEqual([
    expect.objectContaining({
      method: "POST",
      path: "/api/save",
      forwarded: false,
    }),
  ]);
  expect(held.secondActivation.attempted).toBe(true);
  expect(held.secondActivation.duplicates).toEqual([
    expect.objectContaining({ method: "POST", path: "/api/save" }),
  ]);
  expect(
    slow[0]?.requests.find((request) => request.method === "POST")?.outcome,
  ).toBe("blocked");
  expect(server.nonGet.length).toBe(before);
});

test("a disabled trigger is not activated twice", async () => {
  const held = heldOf(
    (await probe("loading-exclusions/disabled-trigger.html")).slow,
  );
  expect(held.trigger.enabled).toBe(false);
  expect(held.secondActivation).toMatchObject({
    attempted: false,
    duplicates: [],
  });
});

test("third-party policy: the held POST is counted blocked and nothing non-safe is sent", async () => {
  const before = server.nonGet.length;
  const ledger = createProbeSafetyLedger([server.origin]);
  await probe("double-submit/before.html", {
    safety: { policy: "third-party", ledger },
  });
  expect(ledger.requests.sent.POST).toBeUndefined();
  expect(ledger.requests.blocked.POST).toBeGreaterThanOrEqual(2);
  expect(server.nonGet.length).toBe(before);
});

test("a small budget leaves a not-reached note and adds no timed-out results", async () => {
  const { artifact, slow } = await probe("loading-state/before.html", {
    stateTimeoutMs: 6000,
    controlTimeoutMs: 5000,
  });
  expect(slow).toEqual([]);
  expect(artifact.heldReplay?.notes).toEqual([
    "not reached: probe budget (1 held replays)",
  ]);
  expect(artifact.status).toBe("ran");
  expect(artifact.results).toHaveLength(1);
  expect(
    artifact.results.every((result) => result.status === "completed"),
  ).toBe(true);
});

test("images, scripts and cross-site requests are never held", async () => {
  const page = await browser.newPage();
  try {
    const url = `${server.origin}/loading-state/before.html`;
    const cross = server.origin.replace("127.0.0.1", "localhost");
    await page.goto(url);
    await page.evaluate((cross) => {
      const button = document.querySelector("#load") as HTMLButtonElement;
      button.addEventListener("click", () => {
        const image = new Image();
        image.src = "/pixel.png";
        document.body.append(image);
        const script = document.createElement("script");
        script.src = "/script.js";
        document.body.append(script);
        fetch(`${cross}/api/items`).catch(() => undefined);
      });
    }, cross);
    let timelines: ActionTimelineArtifact | undefined;
    await probeControls({
      page,
      skip: [],
      maxControls: 10,
      waitMs: 150,
      // Restoring keeps the extra listener so the replay sends the same mix.
      restore: async (active) => {
        await active.goto(url);
        await active.evaluate((cross) => {
          document.querySelector("#load")?.addEventListener("click", () => {
            const image = new Image();
            image.src = "/pixel.png";
            document.body.append(image);
            const script = document.createElement("script");
            script.src = "/script.js";
            document.body.append(script);
            fetch(`${cross}/api/items`).catch(() => undefined);
          });
        }, cross);
      },
      heldReplay: { delayMs: 1500, withinMs: 1000, steps: [] },
      onTimelines: (recorded) => {
        timelines = recorded;
      },
    });
    const held = heldOf(
      (timelines?.actions ?? []).filter((a) => a.source === "slow-replay"),
    );
    expect(held.requests.map((request) => request.path)).toEqual([
      "/api/items",
    ]);
    expect(held.requests[0]?.resourceType).toBe("fetch");
  } finally {
    await page.close();
  }
});

test("on a page with more controls than time, the clicks leave the held replay its reserve", async () => {
  const { artifact, slow } = await probe("loading-state/crowded.html", {
    stateTimeoutMs: 40_000,
    waitMs: 1500,
  });
  expect(artifact.status).not.toBe("timed-out");
  expect(artifact.heldReplay).toMatchObject({ queued: 1, ran: 1 });
  expect(slow).toHaveLength(1);
  expect(
    artifact.results.some(
      (result) => result.skipped === "not reached: held replay reserve",
    ),
  ).toBe(true);
}, 90_000);
