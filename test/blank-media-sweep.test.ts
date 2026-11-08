import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { expect, test } from "vitest";
import { collectPageEvidence } from "../src/capture/page.js";
import { loadingStuckCheck } from "../src/checks/loading-stuck.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { visualBlankCheck } from "../src/checks/visual-blank.js";
import { flowSchema, isWebFlow } from "../src/schemas/flow.js";
import { fixture } from "./benchmark-support.js";
import { evidenceTuple } from "./blank-media-support.js";
// @ts-expect-error Fixture server is authored Node ESM.
import { fieldAppServer, ROUTES } from "./fixtures/field-app/server.mjs";
import {
  type FixtureServer,
  spawnFixtureServer,
} from "./support/fixture-server.js";

const root = join(import.meta.dirname, "fixtures");
const config = checksConfigFrom();
type Coordinate = {
  source: string;
  route: string;
  width: number;
  height: number;
  scheme: "light" | "dark";
  case?: string;
};
type Entry = Coordinate & {
  capture: string;
  media: number;
  intervals: number;
  observedMs: number;
  candidates: Array<{ rule: string; selector: string; explanation: string }>;
  reviewed: string;
  partial?: string | undefined;
};
async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("port");
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}

// Opt-in record update keeps ordinary tests read-only. Every row runs the actual
// state collector, screenshot sampler and rules, before any synthetic replay.
test("new rules precision sweep: gate matrix, field routes/cases and benchmark near misses", {
  timeout: 600000,
}, async () => {
  let browser: Browser | undefined, gate: FixtureServer | undefined;
  let field: { url: string; close(): Promise<void> } | undefined;
  const entries: Entry[] = [];
  const inspect = async (
    coordinate: Coordinate,
    reach: (page: import("playwright").Page) => Promise<void>,
  ) => {
    if (!browser) throw Error("browser");
    const page = await browser.newPage({
      viewport: { width: coordinate.width, height: coordinate.height },
      colorScheme: coordinate.scheme,
      reducedMotion: "reduce",
    });
    try {
      const flow = flowSchema.parse({
        id: "precision",
        title: "Precision",
        setup: [],
        intent: [],
        states: [
          {
            id: "normal",
            description: "Normal",
            url: "/",
            expect: {},
            loadingSettleMs: 100,
          },
        ],
      });
      if (!isWebFlow(flow) || !flow.states[0]) throw Error("state");
      const result = await collectPageEvidence({
        page,
        state: flow.states[0],
        settleMs: 50,
        animationSettleMs: 1500,
        reachStage: "navigation",
        reach: async () => {
          await reach(page);
          return 200;
        },
        createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
        collectConsole: async () => [],
        tokens: { status: "not-configured" },
        screenshotOptions: { fullPage: true },
        now: () => new Date(),
        observe: { visualBlank: config.visualBlank, loadingStuck: true },
      });
      if (!result.ok || result.observations?.version !== 2)
        throw Error(result.ok ? "missing V2" : result.message);
      const obs = result.observations;
      if (!obs.visualBlank || !obs.loadingStuck)
        throw Error("missing new scans");
      const tuple = { ...evidenceTuple(), observations: obs };
      const candidates = [visualBlankCheck, loadingStuckCheck]
        .flatMap(
          (check) =>
            check.run({ tuple, config, tuples: [tuple], narrowViewport: false })
              .candidates,
        )
        .map((c) => ({
          rule: c.rule,
          selector: c.selectorHint,
          explanation: c.explanation,
        }));
      entries.push({
        ...coordinate,
        capture: "ok",
        media: obs.visualBlank.records.length,
        intervals: obs.loadingStuck.records.length,
        observedMs: Math.floor(obs.loadingStuck.observedMs),
        candidates,
        reviewed: candidates.length ? "review required" : "no false positives",
        ...(obs.visualBlank.status === "partial"
          ? { partial: obs.visualBlank.reason }
          : {}),
      });
    } catch (error) {
      entries.push({
        ...coordinate,
        capture: error instanceof Error ? error.message : String(error),
        media: 0,
        intervals: 0,
        observedMs: 0,
        candidates: [],
        reviewed: "capture failure is not a precision pass",
      });
    } finally {
      const entry = entries.at(-1);
      if (
        entry?.source === "gallery-crud" &&
        entry.candidates.length === 1 &&
        ["gallery-before.html", "gallery-after.html"].includes(entry.route) &&
        entry.candidates[0]?.rule === "idiom:visual-blank" &&
        entry.candidates[0]?.selector ===
          "html > body > div:nth-of-type(3) > img"
      )
        entry.reviewed =
          "false positive: intentional single-colour Brand artwork; no swatch semantics, so no exemption was added";
      await page.close();
      if (process.env.IDIOM_UPDATE_BLANK_MEDIA_SWEEP === "1")
        await writeFile(
          join(import.meta.dirname, "../docs/field-test/blank-media.json"),
          `${JSON.stringify({ loadingWindowMs: 100, incomplete: true, entries }, null, 2)}\n`,
        );
    }
  };
  try {
    browser = await chromium.launch();
    const port = await freePort(),
      gateUrl = `http://127.0.0.1:${port}`;
    gate = await spawnFixtureServer(join(root, "gate-app/server.mjs"), {
      env: { PORT: String(port) },
      readyUrl: `${gateUrl}/ready`,
    });
    const gateFlow = JSON.parse(
      await readFile(join(root, "gate-app/.idiom/flows/app.json"), "utf8"),
    );
    const gateProject = JSON.parse(
      await readFile(join(root, "gate-app/.idiom/project.json"), "utf8"),
    );
    for (const state of gateFlow.states)
      for (const viewport of gateProject.viewports)
        for (const scheme of gateProject.colorSchemes)
          await inspect(
            { source: "gate-app", route: state.url, ...viewport, scheme },
            async (page) => {
              await page.goto(`${gateUrl}${state.url}`, {
                waitUntil: "domcontentloaded",
              });
            },
          );
    field = await fieldAppServer();
    const fieldUrl = field?.url;
    if (!fieldUrl) throw Error("field server");
    for (const route of [
      ...ROUTES,
      "/team/invitations",
      "/team/audit",
      "/reports/quarterly",
    ])
      for (const viewport of gateProject.viewports)
        for (const scheme of gateProject.colorSchemes)
          await inspect(
            { source: "field-app", route, ...viewport, scheme },
            async (page) => {
              await page.goto(`${fieldUrl}${route}`, { waitUntil: "load" });
              await page.waitForTimeout(200);
            },
          );
    const cases = JSON.parse(
      await readFile(join(root, "field-app/cases.json"), "utf8"),
    ).cases;
    for (const item of cases)
      await inspect(
        {
          source: "field-app",
          route: item.route,
          case: item.id,
          width: 1280,
          height: 800,
          scheme: "light",
        },
        async (page) => {
          await page.goto(`${fieldUrl}${item.route}`);
          await page
            .getByRole("button", { name: item.trigger, exact: true })
            .or(page.getByRole("tab", { name: item.trigger, exact: true }))
            .click({ timeout: 5000 });
          await page.waitForTimeout(1200); // longest normal API delay is 800ms; allow the fade to finish
        },
      );
    const benchmarkRoot = join(root, "benchmark");
    const folders = (
      await readdir(benchmarkRoot, { withFileTypes: true })
    ).filter(
      (d) => d.isDirectory() && /^(loading|failure-spinner)/.test(d.name),
    );
    const benchmarkFiles = [
      "progress-before.html",
      "progress-after.html",
      ...(
        await Promise.all(
          folders.map(async (folder) =>
            (
              await readdir(join(benchmarkRoot, folder.name))
            )
              .filter((f) => f.endsWith(".html"))
              .map((f) => `${folder.name}/${f}`),
          ),
        )
      ).flat(),
    ];
    for (const route of benchmarkFiles)
      await inspect(
        {
          source: "benchmark",
          route,
          width: 1280,
          height: 800,
          scheme: "light",
        },
        async (page) => {
          await page.setContent(await fixture(route));
        },
      );
    const galleryRoot = join(root, "gallery-crud");
    for (const route of (await readdir(galleryRoot)).filter((f) =>
      f.endsWith(".html"),
    ))
      await inspect(
        {
          source: "gallery-crud",
          route,
          width: 1280,
          height: 800,
          scheme: "light",
        },
        async (page) => {
          await page.setContent(
            await readFile(join(galleryRoot, route), "utf8"),
          );
        },
      );
  } finally {
    await field?.close();
    await gate?.stop();
    await browser?.close();
    if (process.env.IDIOM_UPDATE_BLANK_MEDIA_SWEEP === "1")
      await writeFile(
        join(import.meta.dirname, "../docs/field-test/blank-media.json"),
        `${JSON.stringify({ description: "Fresh ordinary states before replay; original authored rules stay minor regardless of sweep results.", loadingWindowMs: 100, fieldActionSettleMs: 1200, review: { captures: entries.length, captureFailures: entries.filter((e) => e.capture !== "ok").length, truePositives: 0, falsePositives: entries.filter((e) => e.reviewed.startsWith("false positive:")).length, promotion: "Both rules remain minor. Intentional solid artwork without colour-swatch semantics remains a known limitation." }, entries }, null, 2)}\n`,
      );
  }
  expect(entries.filter((e) => e.capture !== "ok")).toEqual([]);
  // The gallery pages share an intentionally solid brand SVG. Preserve and
  // disclose those findings; every other unexpected finding fails.
  expect(
    entries
      .filter((e) => !e.reviewed.startsWith("false positive:"))
      .flatMap((e) =>
        e.candidates.map(
          (c) => `${e.source} ${e.route} ${e.case ?? ""}: ${c.explanation}`,
        ),
      ),
  ).toEqual([]);
});
