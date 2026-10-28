import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DEFAULT_FAILURE } from "../src/capture/failure.js";
import { probeControls } from "../src/capture/probe.js";
import { judgeFailure } from "../src/checks/failure-state.js";
import {
  judgeDoubleSubmit,
  judgeLoading,
} from "../src/checks/loading-state.js";
import type {
  ActionTimeline,
  ActionTimelineArtifact,
  FailureReplay,
  HeldReplay,
} from "../src/checks/types.js";
// @ts-expect-error The field app server is plain Node ESM without declarations.
import { fieldAppServer } from "./fixtures/field-app/server.mjs";

type Case = {
  route: string;
  trigger: string;
  intended: string[];
  twinOf: string[];
};
let browser: Browser;
let app: {
  url: string;
  requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
};
let cases: Case[];
beforeAll(async () => {
  browser = await chromium.launch();
  app = await fieldAppServer();
  cases = JSON.parse(
    await readFile(
      join(import.meta.dirname, "fixtures", "field-app", "cases.json"),
      "utf8",
    ),
  ).cases;
});
afterAll(async () => {
  await app.close();
  await browser.close();
});

const WITHIN_MS = 1000;
/** The route's probe replays, through the real probe, with both replays on. */
async function probeRoute(route: string) {
  const page = await browser.newPage();
  const url = `${app.url}${route}`;
  let timelines: ActionTimelineArtifact | undefined;
  try {
    await page.goto(url);
    await probeControls({
      page,
      skip: [],
      maxControls: 20,
      waitMs: 150,
      stateTimeoutMs: 120_000,
      restore: async (active) => {
        await active.goto(url);
      },
      heldReplay: { delayMs: 1500, withinMs: WITHIN_MS, steps: [] },
      failureReplay: { ...DEFAULT_FAILURE },
      onTimelines: (recorded) => {
        timelines = recorded;
      },
    });
  } finally {
    await page.close();
  }
  return timelines?.actions ?? [];
}

const of = (route: string, rule: string, side: "intended" | "twinOf") =>
  cases
    .filter((item) => item.route === route && item[side].includes(rule))
    .map((item) => item.trigger)
    .sort();

test("/settings: loading and double-submit fire on the bad forms only, and no POST reaches the server", async () => {
  const before = app.requests.length;
  const actions = await probeRoute("/settings");
  const slow = actions.filter(
    (action): action is ActionTimeline & { held: HeldReplay } =>
      action.source === "slow-replay" && action.held !== undefined,
  );
  expect(slow.map((action) => action.name).sort()).toEqual(
    cases
      .filter((item) => item.route === "/settings")
      .map((item) => item.trigger)
      .sort(),
  );
  const loading = slow.filter(
    (action) => judgeLoading(action, WITHIN_MS, () => false).fires,
  );
  const double = slow.filter(
    (action) => judgeDoubleSubmit(action, WITHIN_MS).fires,
  );
  const names = (list: typeof slow) => list.map((action) => action.name).sort();
  expect(names(loading)).toEqual(
    of("/settings", "idiom:loading-state-missing", "intended"),
  );
  expect(names(double)).toEqual(
    of("/settings", "idiom:double-submit", "intended"),
  );
  // The held POSTs and the duplicate second activations are aborted at the
  // route layer: the server never sees a non-safe request.
  expect(
    app.requests.slice(before).filter((request) => request.method !== "GET"),
  ).toEqual([]);
}, 180_000);

test("/reports: failure rules fire on the bad report cards only", async () => {
  const before = app.requests.length;
  const actions = await probeRoute("/reports");
  const failed = actions.filter(
    (action): action is ActionTimeline & { failure: FailureReplay } =>
      action.source === "failure-replay" && action.failure !== undefined,
  );
  const verdicts = failed.map((action) => ({
    name: action.name,
    verdict: judgeFailure(action),
  }));
  const firing = (key: "missing" | "blocked") =>
    verdicts
      .filter((item) => item.verdict[key])
      .map((item) => item.name)
      .sort();
  // A spinner can fill the held replay's frame cap, which leaves the action
  // without a failure replay; every replay that is judged must agree with
  // the ground truth, and the silent failures (no spinner) always are.
  const missing = of("/reports", "idiom:error-state-missing", "intended");
  const stuck = of("/reports", "idiom:retry-blocked", "intended");
  expect(firing("missing")).toEqual(
    expect.arrayContaining(missing.filter((name) => !stuck.includes(name))),
  );
  for (const name of firing("missing")) expect(missing).toContain(name);
  for (const name of firing("blocked")) expect(stuck).toContain(name);
  for (const { name, verdict } of verdicts)
    if (verdict.judged && !stuck.includes(name))
      expect(verdict.blocked, name).toBe(false);
  expect(
    app.requests.slice(before).filter((request) => request.method !== "GET"),
  ).toEqual([]);
}, 180_000);
