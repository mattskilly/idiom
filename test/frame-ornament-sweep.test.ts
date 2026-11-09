import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { expect, test } from "vitest";
import { emptyFrameCheck } from "../src/checks/empty-frame.js";
import { glyphOverIconCheck } from "../src/checks/glyph-over-icon.js";
import { observePage } from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { repeatedRowOrnamentCheck } from "../src/checks/repeated-row-ornament.js";
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
  "../docs/field-test/frame-ornament.json",
);
const config = checksConfigFrom();
const checks = [emptyFrameCheck, repeatedRowOrnamentCheck, glyphOverIconCheck];
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
 * Reviewed candidates the sweep is allowed to produce, by
 * `source route width scheme: explanation`. Each is a true positive whose
 * reason is recorded in the committed sweep record.
 */
const reviewedTruePositives: Record<string, string> = {};

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

// Opt-in record update (IDIOM_UPDATE_FRAME_ORNAMENT_SWEEP=1) keeps ordinary
// runs read-only. Every coordinate runs the real in-page scan and the checks.
test("empty-frame, repeated-row-ornament and glyph-over-icon precision sweep over the gate and field apps", {
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
          frameOrnaments: {
            emptyFrame: true,
            rowOrnament: true,
            glyphOverIcon: true,
          },
        },
      );
      if (observations.version !== 2) throw Error("missing V2");
      if (
        observations.emptyFrames === undefined ||
        observations.rowOrnaments === undefined ||
        observations.glyphOverlaps === undefined
      )
        throw Error("missing frame-ornament scans");
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
    if (process.env.IDIOM_UPDATE_FRAME_ORNAMENT_SWEEP === "1")
      await writeFile(
        record,
        `${JSON.stringify(
          {
            description:
              "Fresh loads of every gate-app state and field-app route at desktop and mobile, light and dark, through the real in-page scan and the three checks. Severities stay minor (empty-frame, glyph-over-icon) and info (repeated-row-ornament) regardless of the result.",
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
