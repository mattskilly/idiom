import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createFailureRoute, DEFAULT_FAILURE } from "../src/capture/failure.js";
import {
  createProbeSafetyLedger,
  type ProbeOptions,
  probeControls,
} from "../src/capture/probe.js";
import { actionTimelineArtifactSchema } from "../src/checks/artifact-schema.js";
import { judgeFailure } from "../src/checks/failure-state.js";
import type { ActionTimelineArtifact } from "../src/checks/types.js";
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
async function probe(path: string, overrides: Partial<ProbeOptions> = {}) {
  const page = await browser.newPage();
  let timelines: ActionTimelineArtifact | undefined;
  try {
    const url = `${server.origin}/${path}`;
    await page.goto(url);
    const artifact = await probeControls({
      page,
      skip: [],
      maxControls: 1,
      waitMs: 150,
      stateTimeoutMs: 20000,
      restore: async (p) => {
        await p.goto(url);
      },
      heldReplay: { delayMs: 450, withinMs: 300, steps: [] },
      failureReplay: { ...DEFAULT_FAILURE, feedbackWithinMs: 400 },
      onTimelines(t) {
        timelines = t;
      },
      ...overrides,
    });
    if (timelines)
      actionTimelineArtifactSchema.parse(JSON.parse(JSON.stringify(timelines)));
    const failure = timelines?.actions.find((a) => a.failure)?.failure;
    const action = timelines?.actions.find((a) => a.failure);
    return {
      artifact,
      timelines,
      failure,
      verdict: action?.failure
        ? judgeFailure({ ...action, failure: action.failure })
        : undefined,
    };
  } finally {
    await page.close();
  }
}
for (const mode of ["status", "network"] as const) {
  for (const name of [
    "silent",
    "disabled",
    "busy",
    "hidden",
    "spinner",
    "empty",
    "xhr",
  ]) {
    test(`${mode}: ${name} recovery pair records complete local failure evidence`, async () => {
      const before = await probe(`failure-${name}/before.html`, {
        failureReplay: { ...DEFAULT_FAILURE, mode, feedbackWithinMs: 400 },
      });
      expect(before.failure, JSON.stringify(before.artifact)).toBeDefined();
      expect(before.failure?.requests).toEqual([
        expect.objectContaining({ path: "/api/items", delivered: true }),
      ]);
      expect(before.failure?.complete).toBe(true);
      expect(before.verdict?.missing).toBe(true);
      expect(before.verdict?.blocked).toBe(name !== "silent");
      const after = await probe(`failure-${name}/after.html`, {
        failureReplay: { ...DEFAULT_FAILURE, mode, feedbackWithinMs: 400 },
      });
      expect(after.failure?.complete, JSON.stringify(after.artifact)).toBe(
        true,
      );
      expect(
        after.failure?.feedback.some((f) =>
          f.text.includes("Something went wrong"),
        ),
      ).toBe(true);
      expect(after.verdict).toMatchObject({
        judged: true,
        missing: false,
        blocked: false,
      });
    });
  }
}
test("injection prevents all matching sends through overflow and repeated POST/XHR attempts", async () => {
  const page = await browser.newPage();
  await page.goto(`${server.origin}/failure-silent/before.html`);
  const count = server.requests.length;
  const ledger = createProbeSafetyLedger([server.origin]);
  await page.route("**/*", async (route) => {
    if (["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
      ledger.requests.sent.GET = (ledger.requests.sent.GET ?? 0) + 1;
      await route.fallback();
    } else {
      ledger.requests.blocked.POST = (ledger.requests.blocked.POST ?? 0) + 1;
      await route.abort();
    }
  });
  for (const mode of ["status", "network"] as const) {
    const route = await createFailureRoute(page, {
      requests: [
        {
          method: "POST",
          url: `${server.origin}/api/save`,
          resourceType: "fetch",
        },
        {
          method: "GET",
          url: `${server.origin}/api/items`,
          resourceType: "xhr",
        },
      ],
      settings: { ...DEFAULT_FAILURE, mode },
      clock: () => performance.now(),
      boundary: async () => 1,
    });
    try {
      await page.evaluate(async () => {
        await Promise.all(
          Array.from({ length: 70 }, () =>
            fetch("/api/save", { method: "POST" }).catch(() => undefined),
          ),
        );
        await new Promise<void>((resolve) => {
          const x = new XMLHttpRequest();
          x.open("GET", "/api/items");
          x.onload = x.onerror = () => resolve();
          x.send();
        });
        await fetch("/api/track", { method: "POST" }).catch(() => undefined);
      });
      expect(route.requests).toHaveLength(60);
      expect(route.truncated).toBe(true);
      expect(route.requests.every((r) => r.delivered)).toBe(true);
    } finally {
      await route.dispose();
    }
  }
  expect(server.requests.slice(count)).toEqual([]);
  expect(ledger.requests.sent.POST).toBeUndefined();
  expect(ledger.requests.blocked.POST).toBe(2);
  await page.close();
});
test("small budgets retain an explicit failure marker without absence findings", async () => {
  const result = await probe("failure-silent/before.html", {
    stateTimeoutMs: 250,
  });
  expect(result.artifact.failureReplay).toBeDefined();
  expect(result.verdict?.missing).not.toBe(true);
});
test("a fire-and-forget action is not failure eligible", async () => {
  const result = await probe("loading-exclusions/fire-and-forget.html");
  expect(result.failure).toBeUndefined();
});

// Exercise watcher attribution directly, independently of replay selection.
for (const [name, handled] of [
  ["alert", true],
  ["status", true],
  ["live", true],
  ["invalid", true],
  ["generic", true],
  ["linked-error", true],
  ["loading-error", true],
  ["toast", true],
  ["banner", true],
  ["retry", true],
  ["hidden-retry", false],
  ["disabled-retry", false],
  ["hidden-error", false],
  ["old-error", false],
  ["unrelated-live", false],
  ["transient", false],
  ["replacement", false],
  ["trigger-spinner", false],
] as const)
  test(`recovery attribution: ${name}`, async () => {
    const { replayFailure } = await import("../src/capture/failure.js");
    const { TimelineCollector } = await import("../src/capture/timeline.js");
    const page = await browser.newPage();
    try {
      await page.goto(`${server.origin}/failure-exclusions/${name}.html`);
      const timeline = new TimelineCollector(page);
      await replayFailure({
        page,
        routePage: page,
        item: {
          of: "probe-click",
          kind: "click",
          selector: "#load",
          name: "Load",
          perform: async (p) => {
            await p.locator("#load").click();
          },
        },
        requests: [
          {
            method: "GET",
            url: `${server.origin}/api/items`,
            resourceType: "fetch",
          },
        ],
        eligibility: {
          basis: "release",
          responseAt: 100,
          changeAt: 110,
          selector: "#result",
        },
        settings: { ...DEFAULT_FAILURE, feedbackWithinMs: 200 },
        timeline,
        clock: () => performance.now(),
      });
      const a = timeline.lastAction();
      expect(a?.failure?.complete).toBe(true);
      if (!a?.failure) throw new Error("missing replay");
      const verdict = judgeFailure({ ...a, failure: a.failure });
      expect(verdict.missing).toBe(!handled);
      expect(verdict.blocked).toBe(
        name === "hidden-retry" ||
          name === "hidden-error" ||
          name === "trigger-spinner",
      );
    } finally {
      await page.close();
    }
  });

test("a different origin with the same pathname retains the ordinary guard", async () => {
  const other = await startLoadingServer();
  const page = await browser.newPage();
  try {
    await page.goto(`${server.origin}/failure-silent/before.html`);
    const route = await createFailureRoute(page, {
      requests: [
        {
          method: "GET",
          url: `${server.origin}/api/items`,
          resourceType: "fetch",
        },
      ],
      settings: DEFAULT_FAILURE,
      clock: () => performance.now(),
      boundary: async () => 1,
    });
    try {
      const count = other.requests.length;
      await page.evaluate(async (origin) => {
        await fetch(`${origin}/api/items`).catch(() => undefined);
      }, other.origin);
      expect(other.requests.slice(count)).toContain("GET /api/items");
      expect(route.requests).toEqual([]);
    } finally {
      await route.dispose();
    }
  } finally {
    await page.close();
    await other.close();
  }
});

for (const name of ["navigation", "navigation-fetch", "optimistic", "beacon"])
  test(`scheduler exclusion: ${name}`, async () => {
    const r = await probe(`failure-exclusions/${name}.html`);
    expect(r.verdict?.missing).not.toBe(true);
    expect(r.verdict?.blocked).not.toBe(true);
  });

test.each([
  { fixture: "post", reaches: 1 },
  { fixture: "silent", reaches: 2 },
])(
  "short hold replays declared $fixture with $reaches shared reaches",
  async ({ fixture, reaches }) => {
    const { TimelineCollector } = await import("../src/capture/timeline.js");
    const { replayRequests } = await import(
      "../src/capture/failure-identity.js"
    );
    const page = await browser.newPage();
    const url = `${server.origin}/failure-${fixture}/before.html`;
    try {
      await page.goto(url);
      const normal = new TimelineCollector(page);
      const handle = await normal.start({
        source: "web-step",
        kind: "click",
        selector: "#load",
        name: "click",
        stepIndex: 1,
      });
      await page.locator("#load").click();
      await page.waitForTimeout(150);
      await handle.finish();
      const original = normal.lastAction();
      if (!original) throw new Error("missing original");
      const { failureEligibility } = await import("../src/capture/failure.js");
      expect(
        failureEligibility(original),
        JSON.stringify(original),
      ).toBeDefined();
      const before = server.nonGet.length;
      let reachCount = 0;
      const result = await probe(`failure-${fixture}/before.html`, {
        maxControls: 0,
        heldReplay: {
          delayMs: 200,
          withinMs: 1000,
          steps: [
            {
              stepIndex: 1,
              action: "click",
              selector: "#load",
              sourceAction: original,
              requests: replayRequests(original),
              reach: async (p) => {
                reachCount++;
                await p.goto(url);
              },
              perform: async (p) => {
                await p.locator("#load").click();
              },
            },
          ],
        },
      });
      expect(
        result.failure,
        JSON.stringify({
          artifact: result.artifact,
          original,
          timelines: result.timelines,
        }),
      ).toMatchObject({
        of: "web-step",
        complete: true,
      });
      expect(result.verdict?.missing).toBe(true);
      expect(server.nonGet.length).toBe(before);
      expect(reachCount).toBe(reaches);
    } finally {
      await page.close();
    }
  },
);

test("failure filmstrip owns the recovery frame beyond 800ms", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FilmstripCapture } = await import("../src/capture/filmstrips.js");
  const { filmstripConfigSchema } = await import(
    "../src/checks/filmstrip-schema.js"
  );
  const { checksConfigFrom } = await import("../src/checks/registry.js");
  const { tupleFor, emptyObservation } = await import("./motion-support.js");
  const { withTimelineIds } = await import("../src/capture/timeline.js");
  const directory = await mkdtemp(join(tmpdir(), "idiom-failure-filmstrip-"));
  const films = new FilmstripCapture(
    filmstripConfigSchema.parse({}),
    checksConfigFrom(),
  );
  try {
    const result = await probe("failure-late/before.html", {
      filmstrips: films,
      failureReplay: { ...DEFAULT_FAILURE, feedbackWithinMs: 2000 },
    });
    const tuple = {
      ...tupleFor(emptyObservation),
      timelines: withTimelineIds(result.timelines),
      observations: { ...emptyObservation, probe: result.artifact },
    };
    const manifest = await films.publish(directory, tuple);
    const entry = manifest.actions.find(
      (a) => a.identity.source === "failure-replay",
    );
    expect(entry?.identity).toMatchObject({ failureOf: "probe-click" });
    expect(entry?.settleMs).toBeGreaterThan(1900);
    expect(
      entry?.frames.find((f) => f.slot === "settle")?.actualMs,
    ).toBeGreaterThan(1400);
    expect(
      entry?.frames.some((f) => f.slot === "settle" && f.path !== undefined),
    ).toBe(true);
  } finally {
    await films.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("six failure replays per state, with completed identities carried into later rounds", async () => {
  const { TimelineCollector, withTimelineIds } = await import(
    "../src/capture/timeline.js"
  );
  const { replayRequests } = await import("../src/capture/failure-identity.js");
  const page = await browser.newPage();
  const url = `${server.origin}/failure-cap/before.html`;
  try {
    await page.goto(url);
    const normal = new TimelineCollector(page);
    const steps = [];
    for (let i = 0; i < 7; i++) {
      const selector = `#load-${i}`;
      const h = await normal.start({
        source: "web-step",
        kind: "click",
        selector,
        name: "click",
        stepIndex: i + 1,
      });
      await page.locator(selector).click();
      await page.waitForTimeout(70);
      await h.finish();
      const original = normal.lastAction();
      if (!original) throw new Error("missing original");
      steps.push({
        stepIndex: i + 1,
        action: "click" as const,
        selector,
        sourceAction: original,
        requests: replayRequests(original),
        reach: async (p: import("playwright").Page) => {
          await p.goto(url);
        },
        perform: async (p: import("playwright").Page) => {
          await p.locator(selector).click();
        },
      });
    }
    const settings = {
      maxControls: 0,
      stateTimeoutMs: 60000,
      heldReplay: { delayMs: 100, withinMs: 300, steps },
      failureReplay: { ...DEFAULT_FAILURE, feedbackWithinMs: 200 },
    };
    const first = await probe("failure-cap/before.html", settings);
    expect(first.artifact.failureReplay?.ran).toBe(6);
    expect(first.artifact.failureReplay?.completed).toHaveLength(6);
    expect(
      first.artifact.failureReplay?.notes.some((n) => n.includes("cap of 6")),
    ).toBe(true);
    const actions = withTimelineIds(first.timelines)?.actions.filter(
      (a) => a.failure,
    );
    expect(actions?.map((a) => a.id)).toEqual(
      Array.from({ length: 6 }, (_, i) => `failure-step-${i + 1}`),
    );
    const second = await probe("failure-cap/before.html", {
      ...settings,
      failureReplay: {
        ...settings.failureReplay,
        completed: first.artifact.failureReplay?.completed ?? [],
      },
    });
    expect(second.artifact.failureReplay?.ran).toBe(0);
    expect(second.artifact.failureReplay?.completed).toHaveLength(6);
  } finally {
    await page.close();
  }
}, 90000);
