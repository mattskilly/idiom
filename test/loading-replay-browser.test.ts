import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createProbeSafetyLedger,
  type ProbeOptions,
  probeControls,
} from "../src/capture/probe.js";
import { actionTimelineArtifactSchema } from "../src/checks/artifact-schema.js";
import { loadingStateMissingCheck } from "../src/checks/loading-state.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ActionTimelineArtifact,
  HeldReplay,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { type LoadingServer, startLoadingServer } from "./loading-support.js";
import { emptyObservation, tupleFor } from "./motion-support.js";

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

test.each([
  ["display:none", "class", false],
  ["visibility:hidden", "data", false],
  ["opacity:0", "style", false],
  ["ancestor", "class", false],
  ["display:none", "remove", false],
  ["visible", "remove", true],
  ["visible", "hide", true],
  ["display:none", "reveal", true],
] as const)(
  "pending feedback: %s with %s",
  async (hidden, mutation, visibleChange) => {
    const page = await browser.newPage();
    let timelines: ActionTimelineArtifact | undefined;
    const setup = async (active: Page) => {
      await active.goto(`${server.origin}/loading-state/before.html`);
      await active.evaluate(
        ({ hidden, mutation }) => {
          document.body.innerHTML = `<main><h1>Items</h1><button id="load">Load items</button>
        <div id="wrapper"><p id="pending">Pending</p></div><ul id="list"><li>Existing item</li></ul></main>`;
          const pending = document.querySelector("#pending") as HTMLElement;
          const wrapper = document.querySelector("#wrapper") as HTMLElement;
          const load = document.querySelector("#load");
          const list = document.querySelector("#list");
          if (!load || !list) throw new Error("missing fixture controls");
          if (hidden === "ancestor") wrapper.style.display = "none";
          else if (hidden !== "visible") pending.style.cssText = hidden;
          load.addEventListener("click", async () => {
            if (mutation === "class") pending.classList.add("active");
            if (mutation === "data") pending.dataset.pending = "true";
            if (mutation === "style") pending.style.color = "red";
            if (mutation === "remove") pending.remove();
            if (mutation === "hide") pending.style.display = "none";
            if (mutation === "reveal") pending.style.display = "block";
            const response = await fetch("/api/items");
            const items = (await response.json()) as string[];
            list.replaceChildren(
              ...items.map((text) => {
                const li = document.createElement("li");
                li.textContent = text;
                return li;
              }),
            );
          });
        },
        { hidden, mutation },
      );
    };
    try {
      await setup(page);
      await probeControls({
        page,
        skip: [],
        maxControls: 1,
        waitMs: 150,
        restore: setup,
        heldReplay: { delayMs: 1500, withinMs: 1000, steps: [] },
        onTimelines: (recorded) => {
          timelines = recorded;
        },
      });
      if (!timelines) throw new Error("missing timelines");
      const slow = timelines.actions.filter((a) => a.source === "slow-replay");
      const held = heldOf(slow);
      if (!held.firstChange || held.releasedAt === null)
        throw new Error("missing release/change evidence");
      expect(held.indicators).toEqual([]);
      expect(held.changedAfterRelease).toBe(true);
      if (visibleChange)
        expect(held.firstChange.time).toBeLessThan(held.releasedAt);
      else
        expect(held.firstChange.time).toBeGreaterThanOrEqual(held.releasedAt);
      const tuple = {
        ...tupleFor(emptyObservation),
        timelines,
        observations: {
          ...emptyObservation,
          probe: {
            status: "ran" as const,
            results: [],
            heldReplay: { delayMs: 1500, queued: 1, ran: 1, notes: [] },
          },
        },
      };
      const result = loadingStateMissingCheck.run({
        tuple,
        tuples: [tuple],
        narrowViewport: false,
        config: checksConfigFrom(checksConfigSchema.parse({})),
      });
      if (visibleChange) expect(result.candidates).toEqual([]);
      else
        expect(result.candidates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              rule: "idiom:loading-state-missing",
              selectorHint: "#load",
              verification: expect.objectContaining({
                params: expect.objectContaining({
                  selector: "#load",
                  requests: ["GET /api/items"],
                }),
              }),
            }),
          ]),
        );
    } finally {
      await page.close();
    }
  },
);

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

test("a held web step that submits by document navigation notes it once, briefly", async () => {
  const url = `${server.origin}/loading-exclusions/form-nav.html`;
  const { artifact, slow } = await probe("loading-exclusions/form-nav.html", {
    maxControls: 0,
    heldReplay: {
      delayMs: 1500,
      withinMs: 1000,
      steps: [
        {
          stepIndex: 1,
          action: "click",
          selector: "#submit",
          requests: [],
          reach: async (active: Page) => {
            await active.goto(url);
          },
          perform: async (active: Page) => {
            await active.locator("#submit").click();
          },
        },
      ],
    },
  });
  expect(artifact.heldReplay?.notes.join("; ") ?? "").not.toMatch(
    /held replay failed/,
  );
  const step = slow.find((action) => action.stepIndex === 1);
  expect(step?.held?.notes).toEqual(["main-frame document navigation"]);
}, 60_000);
