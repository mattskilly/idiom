import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { expect, test } from "vitest";
import { controlGapCheck } from "../src/checks/control-gap.js";
import { crampedPaddingCheck } from "../src/checks/cramped-padding.js";
import { edgeTextCheck } from "../src/checks/edge-text.js";
import { headingRhythmCheck } from "../src/checks/heading-rhythm.js";
import { hiddenAtRestCheck } from "../src/checks/hidden-at-rest.js";
import { negativeSpacingCheck } from "../src/checks/negative-spacing.js";
import { numericAlignCheck } from "../src/checks/numeric-align.js";
import { observePage } from "../src/checks/observe.js";
import { raggedRowCheck } from "../src/checks/ragged-row.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { textOcclusionCheck } from "../src/checks/text-occlusion.js";
import { toolbarLayoutCheck } from "../src/checks/toolbar-layout.js";
import { typeLegibilityCheck } from "../src/checks/type-legibility.js";
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
  "../docs/field-test/legibility-layout.json",
);
const config = checksConfigFrom();
const checks = [
  hiddenAtRestCheck,
  edgeTextCheck,
  crampedPaddingCheck,
  headingRhythmCheck,
  typeLegibilityCheck,
  numericAlignCheck,
  raggedRowCheck,
  textOcclusionCheck,
  controlGapCheck,
  negativeSpacingCheck,
  toolbarLayoutCheck,
];
type Entry = {
  source: string;
  route: string;
  width: number;
  height: number;
  scheme: "light" | "dark";
  capture: string;
  candidates: Array<{ rule: string; selector: string; explanation: string }>;
  reviewed: string;
};
/**
 * Reviewed candidates the sweep is allowed to produce. Each is a true
 * positive whose reason is recorded in the committed sweep record.
 */
const reviewedTruePositives: Array<{
  source: string;
  routes: string[];
  rule: string;
  columns: string[];
  reason: string;
}> = [
  {
    source: "field-app",
    routes: ["/catalog", "/orders", "/customers"],
    rule: "idiom:numeric-align",
    columns: [
      '"Price" column',
      '"Stock" column',
      '"Total" column',
      '"Orders" column',
    ],
    reason:
      "the field app sets text-align: left on every table cell and no tabular figures, so price, stock, total and order-count columns of differing digit lengths do not line up",
  },
];
const reviewedReason = (
  entry: Pick<Entry, "source" | "route">,
  candidate: { rule: string; explanation: string },
) =>
  reviewedTruePositives.find(
    (reviewed) =>
      reviewed.source === entry.source &&
      reviewed.routes.includes(entry.route) &&
      reviewed.rule === candidate.rule &&
      reviewed.columns.some((column) => candidate.explanation.includes(column)),
  )?.reason;

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

// Opt-in record update (IDIOM_UPDATE_LEGIBILITY_SWEEP=1) keeps ordinary
// runs read-only. Every coordinate runs the real in-page scan and the checks.
test("legibility and layout precision sweep over the gate and field apps", {
  timeout: 600000,
}, async () => {
  let browser: Browser | undefined;
  let gate: FixtureServer | undefined;
  let field: { url: string; close(): Promise<void> } | undefined;
  const entries: Entry[] = [];
  const inspect = async (
    coordinate: Omit<Entry, "capture" | "candidates" | "reviewed">,
    reach: (page: Page) => Promise<void>,
  ) => {
    if (!browser) throw Error("browser");
    const page = await browser.newPage({
      viewport: { width: coordinate.width, height: coordinate.height },
      colorScheme: coordinate.scheme,
      reducedMotion: "reduce",
    });
    try {
      await reach(page);
      const observations = await observePage(
        page,
        { status: "not-configured" },
        undefined,
        [],
        {
          legibility: {
            hiddenAtRest: true,
            edgeText: true,
            crampedPadding: true,
            headingRhythm: true,
            typeLegibility: true,
            numericAlign: true,
            raggedRow: true,
            controlGap: true,
            negativeSpacing: true,
            toolbarLayout: true,
          },
          textOcclusion: true,
        },
      );
      if (observations.version !== 2) throw Error("missing V2");
      if (
        observations.hiddenAtRest === undefined ||
        observations.edgeTexts === undefined ||
        observations.crampedPaddings === undefined ||
        observations.headingRhythms === undefined ||
        observations.typeLegibility === undefined ||
        observations.numericColumns === undefined ||
        observations.raggedRows === undefined ||
        observations.controlGaps === undefined ||
        observations.negativeSpacings === undefined ||
        observations.toolbarLayouts === undefined ||
        observations.textOcclusions === undefined
      )
        throw Error("missing legibility scans");
      const tuple = {
        ...evidenceTuple(),
        width: coordinate.width,
        height: coordinate.height,
        observations,
      };
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
        candidates,
        reviewed: "no false positives",
      };
      const reasons = candidates.map((c) => reviewedReason(entry, c));
      if (candidates.length > 0)
        entry.reviewed = reasons.every((r) => r !== undefined)
          ? `true positive: ${[...new Set(reasons)].join("; ")}`
          : "review required";
      entries.push(entry);
    } catch (error) {
      entries.push({
        ...coordinate,
        capture: error instanceof Error ? error.message : String(error),
        candidates: [],
        reviewed: "capture failure is not a precision pass",
      });
    } finally {
      await page.close();
    }
  };
  try {
    browser = await chromium.launch();
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
  } finally {
    await field?.close();
    await gate?.stop();
    await browser?.close();
    if (process.env.IDIOM_UPDATE_LEGIBILITY_SWEEP === "1")
      await writeFile(
        record,
        `${JSON.stringify(
          {
            description:
              "Fresh loads of every gate-app state and field-app route at desktop and mobile, light and dark, with reduced motion, through the real in-page scans and the ten legibility and layout checks. Every rule stays minor regardless of the result.",
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
        .filter((c) => reviewedReason(e, c) === undefined)
        .map((c) => key(e, c.explanation)),
    ),
  ).toEqual([]);
});
