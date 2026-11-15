import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { expect, test } from "vitest";
import { measureNativeScrollbars } from "../src/capture/native-scrollbars.js";
import {
  ScrollbarController,
  scrollbarLaunchOptions,
} from "../src/capture/scrollbars.js";
import { browserDefaultStyleCheck } from "../src/checks/browser-default-style.js";
import { nativeScrollbarCheck } from "../src/checks/native-scrollbar.js";
import {
  loadTokenDeclarations,
  observePage,
  type TokenDeclarations,
} from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { CheckTuple } from "../src/checks/types.js";
import { unusedTokenCheck } from "../src/checks/unused-token.js";
import { evidenceTuple } from "./blank-media-support.js";
// @ts-expect-error Fixture server is authored Node ESM.
import { fieldAppServer, ROUTES } from "./fixtures/field-app/server.mjs";
import {
  type FixtureServer,
  spawnFixtureServer,
} from "./support/fixture-server.js";

const root = join(import.meta.dirname, "fixtures");
const record = join(
  import.meta.dirname,
  "../docs/field-test/chrome-defaults.json",
);
const config = checksConfigFrom();
const checks = [
  nativeScrollbarCheck,
  browserDefaultStyleCheck,
  unusedTokenCheck,
];
type Entry = {
  source: string;
  route: string;
  width: number;
  height: number;
  scheme: "light" | "dark";
  capture: string;
  /** Scrollers measured with a classic gutter (before the styled-box filter applies, none are recorded). */
  scrollbarScan: string;
  /** Links in the browser default colour, whether or not the check could judge them. */
  defaultLinks: number;
  /** Fieldset legends notched into their border (judged without tokens). */
  defaultLegends: number;
  candidates: Array<{ rule: string; selector: string; explanation: string }>;
  reviewed: string;
};
/**
 * Reviewed candidates the sweep is allowed to produce, by
 * `source route width scheme: explanation`. Each is a true positive whose
 * reason is recorded in the committed sweep record.
 */
const productsTrack =
  "#products-body shows the browser's own 15px scrollbar track inside a rounded box (section.card.card--products, 8px radius); no scrollbar-color, scrollbar-width or ::-webkit-scrollbar styling applies to it.";
const productsReason =
  "at 390px the products table overflows sideways inside the 8px-radius card and its unstyled overflow: auto body shows the browser's classic track: the spec's bug";
const reviewedTruePositives: Record<string, string> = {
  [`field-app /catalog 390 light: ${productsTrack}`]: productsReason,
  [`field-app /catalog 390 dark: ${productsTrack}`]: productsReason,
};

async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("port");
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}
const key = (entry: Entry, explanation: string) =>
  `${entry.source} ${entry.route} ${entry.width} ${entry.scheme}: ${explanation}`;

// Opt-in record update (IDIOM_UPDATE_CHROME_DEFAULTS_SWEEP=1) keeps ordinary
// runs read-only. Every coordinate runs the real in-page scan and the checks.
test("native-scrollbar, browser-default-style and unused-token precision sweep over the gate and field apps", {
  timeout: 600000,
}, async () => {
  let browser: Browser | undefined;
  let gate: FixtureServer | undefined;
  let field: { url: string; close(): Promise<void> } | undefined;
  const entries: Entry[] = [];
  const tuples: CheckTuple[] = [];
  let tokens: TokenDeclarations = { status: "not-configured" };
  const inspect = async (
    coordinate: Omit<
      Entry,
      | "capture"
      | "scrollbarScan"
      | "defaultLinks"
      | "defaultLegends"
      | "candidates"
      | "reviewed"
    >,
    reach: (page: Page) => Promise<void>,
  ) => {
    if (!browser) throw Error("browser");
    const page = await browser.newPage({
      viewport: { width: coordinate.width, height: coordinate.height },
      colorScheme: coordinate.scheme,
      reducedMotion: "reduce",
    });
    try {
      const controller = await ScrollbarController.create(page);
      await reach(page);
      let observations = await observePage(page, tokens, undefined, [], {
        chromeDefaults: {
          nativeScrollbar: true,
          browserDefaultStyle: true,
          unusedToken: true,
        },
      });
      if (observations.version !== 2) throw Error("missing V2");
      const measured = await measureNativeScrollbars(page, controller);
      if (!measured.restored) throw Error("scrollbar measurement not restored");
      observations = { ...observations, nativeScrollbars: measured.scan };
      if (observations.browserDefaultLinks === undefined)
        throw Error("missing default-link scan");
      if (observations.browserDefaultLegends === undefined)
        throw Error("missing notched-legend scan");
      if (measured.scan.status !== "ran")
        throw Error(
          `scrollbar scan ${measured.scan.status}: ${measured.scan.reason}`,
        );
      const tuple: CheckTuple = {
        ...evidenceTuple(),
        width: coordinate.width,
        height: coordinate.height,
        observations,
      };
      tuples.push(tuple);
      const candidates = checks
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
      const entry: Entry = {
        ...coordinate,
        capture: "ok",
        scrollbarScan: measured.scan.status,
        defaultLinks: observations.browserDefaultLinks.count,
        defaultLegends: observations.browserDefaultLegends.count,
        candidates,
        reviewed: "no false positives",
      };
      const reasons = candidates.map(
        (c) => reviewedTruePositives[key(entry, c.explanation)],
      );
      if (candidates.length > 0)
        entry.reviewed = reasons.every((r) => r !== undefined)
          ? `true positive: ${[...new Set(reasons)].join("; ")}`
          : "review required";
      entries.push(entry);
    } catch (error) {
      entries.push({
        ...coordinate,
        capture: error instanceof Error ? error.message : String(error),
        scrollbarScan: "not run",
        defaultLinks: 0,
        defaultLegends: 0,
        candidates: [],
        reviewed: "capture failure is not a precision pass",
      });
    } finally {
      await page.close();
    }
  };
  try {
    // Classic scrollbars must be able to show for the gutter measurement.
    browser = await chromium.launch(scrollbarLaunchOptions);
    const port = await freePort();
    const gateUrl = `http://127.0.0.1:${port}`;
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
    // The gate app's configured tokens file, when it has one.
    if (typeof gateProject.design?.tokensFile === "string")
      tokens = await loadTokenDeclarations(
        join(root, "gate-app"),
        gateProject.design.tokensFile,
      );
    for (const state of gateFlow.states)
      for (const viewport of gateProject.viewports)
        for (const scheme of gateProject.colorSchemes)
          await inspect(
            {
              source: "gate-app",
              route: state.url,
              width: viewport.width,
              height: viewport.height,
              scheme,
            },
            async (page) => {
              await page.goto(`${gateUrl}${state.url}`, { waitUntil: "load" });
              await page.waitForTimeout(100);
            },
          );
    field = await fieldAppServer();
    const fieldUrl = field?.url;
    if (!fieldUrl) throw Error("field server");
    for (const route of ROUTES as string[])
      for (const viewport of gateProject.viewports)
        for (const scheme of gateProject.colorSchemes)
          await inspect(
            {
              source: "field-app",
              route,
              width: viewport.width,
              height: viewport.height,
              scheme,
            },
            async (page) => {
              await page.goto(`${fieldUrl}${route}`, { waitUntil: "load" });
              await page.waitForTimeout(200);
            },
          );
    // unused-token is run-level: judge it once over every coordinate.
    const runLevel = tuples.flatMap(
      (tuple) =>
        unusedTokenCheck.run({ tuple, tuples, config, narrowViewport: false })
          .candidates,
    );
    expect(runLevel).toEqual([]);
  } finally {
    await field?.close();
    await gate?.stop();
    await browser?.close();
    if (process.env.IDIOM_UPDATE_CHROME_DEFAULTS_SWEEP === "1")
      await writeFile(
        record,
        `${JSON.stringify(
          {
            description:
              "Fresh loads of every gate-app state and field-app route at desktop and mobile, light and dark, through the real in-page scan, the classic-scrollbar measurement and the three checks. Severities stay minor (native-scrollbar, browser-default-style) and info (unused-token) regardless of the result. The gate app configures no tokens file, so unused-token and browser-default-style's link half are skipped there (defaultLinks records what the scan saw anyway); browser-default-style's notched-legend half needs no tokens and is judged everywhere (defaultLegends).",
            review: {
              captures: entries.length,
              captureFailures: entries.filter((e) => e.capture !== "ok").length,
              candidates: entries.reduce(
                (sum, e) => sum + e.candidates.length,
                0,
              ),
              truePositives: entries.filter((e) =>
                e.reviewed.startsWith("true positive:"),
              ).length,
            },
            entries,
          },
          null,
          2,
        )}\n`,
      );
  }
  expect(entries.filter((e) => e.capture !== "ok")).toEqual([]);
  expect(
    entries.flatMap((e) =>
      e.candidates
        .map((c) => key(e, c.explanation))
        .filter((k) => reviewedTruePositives[k] === undefined),
    ),
  ).toEqual([]);
});
