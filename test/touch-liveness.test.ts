import { readFile } from "node:fs/promises";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { collectPageEvidence } from "../src/capture/page.js";
import type { FlowState } from "../src/capture/types.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import type { ObserveOptions } from "../src/checks/observe.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type { ChecksConfig, CheckTuple } from "../src/checks/types.js";
import { flowSchema } from "../src/schemas/flow.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});
const state = flowSchema.parse({
  id: "templates",
  title: "Templates",
  intent: [],
  setup: [],
  states: [
    {
      id: "default",
      description: "Default",
      url: "/",
      expect: {
        status: 200,
        textPresent: [],
        selectorPresent: [],
        selectorAbsent: [],
      },
    },
  ],
}).states[0] as FlowState;
const touch = { ignore: [] };
const live = { selectors: [], auto: true, ignore: [] };
const config = {
  ...checksConfigFrom(),
  touchReachability: touch,
  liveness: live,
} as ChecksConfig;
async function fixture(name: string) {
  return readFile(
    new URL(`./fixtures/touch-liveness/${name}.html`, import.meta.url),
    "utf8",
  );
}
async function capture(
  page: Page,
  html: string,
  observe: ObserveOptions = {
    touchReachability: touch,
    liveness: live,
  } as ObserveOptions,
  reuseScreenshot?: Buffer,
  extra: Partial<Parameters<typeof collectPageEvidence>[0]> = {},
) {
  const result = await collectPageEvidence({
    page,
    state,
    settleMs: 0,
    reachStage: "navigation",
    reach: async () => {
      await page.setContent(html);
      return 200;
    },
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    collectConsole: async () => [],
    tokens: { status: "not-configured" },
    screenshotOptions: { animations: "disabled" },
    now: () => new Date(),
    observe,
    reuseScreenshot,
    ...extra,
  });
  expect(result.ok).toBe(true);
  expect(observationArtifactSchema.safeParse(result.observations).success).toBe(
    true,
  );
  return {
    flow: "templates",
    state: "default",
    viewport: "phone",
    width: 390,
    height: 844,
    metadataPath: "metadata.json",
    artifactPaths: ["observations.json"],
    commit: "fixture",
    createdAt: new Date().toISOString(),
    observations: result.observations,
    axe: result.axe,
    console: result.console,
    mismatches: [],
  } satisfies CheckTuple;
}
function findings(tuple: CheckTuple, checks: ChecksConfig = config) {
  return runDeterministicChecks([tuple], undefined, checks)
    .candidates.filter((c) =>
      ["touch-reachability", "liveness"].includes(c.candidate.category),
    )
    .map((c) => c.candidate);
}

test("touch template actions reveal on keyboard focus but require hover at rest", async () => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    const html = await fixture("templates-before");
    const tuple = await capture(page, html, {
      touchReachability: touch,
    } as ObserveOptions);
    expect(
      findings(tuple).filter((c) => c.rule === "idiom:touch-hover-only"),
    ).toHaveLength(4);
    await page.locator("#fade-action").focus();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#fade-action") as Element)
          .opacity === "1",
    );
    const after = await capture(page, await fixture("templates-after"), {
      touchReachability: touch,
    } as ObserveOptions);
    expect(findings(after)).toEqual([]);
  } finally {
    await context.close();
  }
}, 20000);

test("published zero and nonzero stalled timers are reported beside a running thumbnail", async () => {
  let page = await browser.newPage();
  try {
    const before = await capture(page, await fixture("countdown-before"), {
      liveness: live,
    } as ObserveOptions);
    expect(
      findings(before)
        .map((c) => c.rule)
        .sort(),
    ).toEqual(["idiom:liveness-all-zero", "idiom:liveness-unchanged"]);
    await page.close();
    page = await browser.newPage();
    const after = await capture(page, await fixture("countdown-after"), {
      liveness: live,
    } as ObserveOptions);
    expect(findings(after)).toEqual([]);
  } finally {
    await page.close();
  }
}, 15000);

function coverage(tuple: CheckTuple, check: string, checks = config) {
  return runDeterministicChecks([tuple], undefined, checks).coverage.find(
    (c) => c.coverage.check === check,
  )?.coverage;
}
async function touchPage() {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  return { context, page: await context.newPage() };
}

test("painted focus alternatives, inactive trees and ignores produce no touch noise", async () => {
  const { context, page } = await touchPage();
  try {
    const html = await fixture("templates-edges");
    const tuple = await capture(page, html, {
      touchReachability: touch,
    } as ObserveOptions);
    expect(findings(tuple).map((c) => c.verification?.params?.control)).toEqual(
      [expect.stringContaining("article:nth-of-type(3)")],
    );
    const evidence =
      tuple.observations?.version === 2
        ? tuple.observations.touchReachability
        : undefined;
    expect(evidence?.status).toBe("ran");
    expect(evidence?.entries.map((e) => e.focus.status)).toEqual([
      "revealed",
      "revealed",
      "hidden",
    ]);
    const ignoring = { ignore: [".ignored"] };
    await page.close();
    const second = await context.newPage();
    const ignored = await capture(second, html, {
      touchReachability: ignoring,
    } as ObserveOptions);
    expect(
      findings(ignored, { ...config, touchReachability: ignoring }),
    ).toEqual([]);
  } finally {
    await context.close();
  }
}, 20000);

test("desktop captures skip touch reachability without diagnosing", async () => {
  const page = await browser.newPage();
  try {
    const tuple = await capture(page, await fixture("templates-before"), {
      touchReachability: touch,
    } as ObserveOptions);
    expect(findings(tuple)).toEqual([]);
    expect(coverage(tuple, "touch-reachability")?.status).toBe("skipped");
    const evidence =
      tuple.observations?.version === 2
        ? tuple.observations.touchReachability
        : undefined;
    expect(evidence?.entries).toEqual([]);
  } finally {
    await page.close();
  }
});

test("touch diagnosis restores the resting state before the probe and after the screenshot", async () => {
  const { context, page } = await touchPage();
  try {
    const order: string[] = [];
    const screenshot = page.screenshot.bind(page);
    page.screenshot = (async (options) => {
      order.push(
        `screenshot:${await page.evaluate(() => getComputedStyle(document.querySelector("#fade .actions") as Element).opacity)}`,
      );
      return screenshot(options);
    }) as Page["screenshot"];
    const tuple = await capture(
      page,
      await fixture("templates-before"),
      { touchReachability: touch } as ObserveOptions,
      undefined,
      {
        probe: async () => {
          order.push(
            `probe:${await page.evaluate(() => getComputedStyle(document.querySelector("#fade .actions") as Element).opacity)}`,
          );
          return { status: "ran", results: [] };
        },
      },
    );
    expect(order).toEqual(["screenshot:0", "probe:0"]);
    const observations =
      tuple.observations?.version === 2 ? tuple.observations : undefined;
    expect(observations?.touchReachability?.restored).toBe(true);
    expect(observations?.probe?.status).toBe("ran");
    expect(observations?.input).toMatchObject({
      pointer: "coarse",
      hover: "none",
    });
  } finally {
    await context.close();
  }
}, 20000);

test("protocol failure yields unavailable touch evidence, never findings", async () => {
  const { context, page } = await touchPage();
  try {
    const original = context.newCDPSession.bind(context);
    context.newCDPSession = (async () => {
      throw new Error("CDP unavailable");
    }) as typeof context.newCDPSession;
    const tuple = await capture(page, await fixture("templates-before"), {
      touchReachability: touch,
    } as ObserveOptions);
    context.newCDPSession = original;
    expect(findings(tuple)).toEqual([]);
    expect(coverage(tuple, "touch-reachability")).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("CDP unavailable"),
    });
  } finally {
    await context.close();
  }
}, 20000);

test("declared, automatic, missing and detached liveness targets", async () => {
  const page = await browser.newPage();
  const declared = {
    selectors: ["#split", "#labelled", "#missing"],
    auto: true,
    ignore: [],
  };
  try {
    const started = performance.now();
    const order: number[] = [];
    const screenshot = page.screenshot.bind(page);
    page.screenshot = (async (options) => {
      order.push(performance.now() - started);
      return screenshot(options);
    }) as Page["screenshot"];
    const tuple = await capture(page, await fixture("countdown-edges"), {
      liveness: declared,
    } as ObserveOptions);
    expect(order[0]).toBeGreaterThanOrEqual(1400);
    const checks = { ...config, liveness: declared };
    expect(
      findings(tuple, checks)
        .map((c) => `${c.selectorHint} ${c.rule}`)
        .sort(),
    ).toEqual([
      "#inner idiom:liveness-unchanged",
      "#labelled idiom:liveness-all-zero",
      "#split idiom:liveness-all-zero",
    ]);
    const evidence =
      tuple.observations?.version === 2
        ? tuple.observations.liveness
        : undefined;
    const measured = evidence?.entries.filter((e) => e.status === "measured");
    const elapsed = new Set(
      measured?.map((e) => (e.status === "measured" ? e.elapsedMs : 0)),
    );
    expect(elapsed.size).toBe(1);
    expect([...elapsed][0]).toBeGreaterThanOrEqual(1450);
    expect([...elapsed][0]).toBeLessThan(2500);
    expect(evidence?.entries.map((e) => e.selector)).not.toContain("#clock");
    expect(evidence?.entries.map((e) => e.selector)).not.toContain("#prose");
    expect(evidence?.entries.map((e) => e.selector)).not.toContain(
      "#hidden-timer",
    );
    expect(coverage(tuple, "liveness", checks)).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/#missing: no matches.*#detaching/),
    });
  } finally {
    await page.close();
  }
}, 15000);

test("invalid selectors are diagnostics and default captures do not wait", async () => {
  const page = await browser.newPage();
  try {
    const invalid = { selectors: ["[["], auto: false, ignore: [] };
    const tuple = await capture(page, await fixture("countdown-before"), {
      liveness: invalid,
    } as ObserveOptions);
    expect(
      coverage(tuple, "liveness", { ...config, liveness: invalid }),
    ).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("invalid CSS selector"),
    });
    const started = performance.now();
    const plain = await capture(page, "<main><p>1:00:00:00</p></main>", {});
    expect(performance.now() - started).toBeLessThan(1400);
    const observations =
      plain.observations?.version === 2 ? plain.observations : undefined;
    expect(observations?.liveness).toBeUndefined();
    expect(observations?.touchReachability).toBeUndefined();
  } finally {
    await page.close();
  }
}, 15000);

test("captured evidence replays offline with identical findings, per tuple", async () => {
  const { context, page } = await touchPage();
  try {
    const first = await capture(page, await fixture("countdown-before"));
    const shared = Buffer.from("reused");
    await page.close();
    const other = await context.newPage();
    const second = await capture(
      other,
      await fixture("countdown-before"),
      undefined,
      shared,
    );
    for (const tuple of [first, second]) {
      const replayed = {
        ...tuple,
        observations: observationArtifactSchema.parse(
          JSON.parse(JSON.stringify(tuple.observations)),
        ),
      } as CheckTuple;
      const live = findings(tuple).map((c) => [
        c.fingerprintHint,
        c.explanation,
      ]);
      expect(live.length).toBe(2);
      expect(
        findings(replayed).map((c) => [c.fingerprintHint, c.explanation]),
      ).toEqual(live);
    }
  } finally {
    await context.close();
  }
}, 20000);
