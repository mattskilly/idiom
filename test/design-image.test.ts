import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { resolveDesignSource } from "../src/design/source.js";
import { createQuickConfiguration } from "../src/quick/config.js";
import { captureLiteralPages, runQuick } from "../src/quick/run.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { attachCrops } from "../src/review/crops.js";
import {
  buildDeterministicDrafts,
  finalizeFindings,
} from "../src/review/findings.js";
import type { DesignLocation } from "../src/schemas/design.js";

const fixtures = join(import.meta.dirname, "fixtures/design-image");
const htmlFixtures = join(import.meta.dirname, "fixtures/design-drift");
let browser: Browser;
let directory: string;
const exports: Record<"png" | "jpg" | "webp", string> = {
  png: "",
  jpg: "",
  webp: "",
};

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  directory = await mkdtemp(join(tmpdir(), "idiom-design-image-"));
  // The "exported design": the design page at 2× device scale, full page.
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await page.setContent(await readFile(join(fixtures, "design.html"), "utf8"));
  exports.png = join(directory, "design.png");
  await page.screenshot({ path: exports.png, fullPage: true });
  exports.jpg = join(directory, "design.jpg");
  await page.screenshot({
    path: exports.jpg,
    fullPage: true,
    type: "jpeg",
    quality: 90,
  });
  const png = await readFile(exports.png);
  await page.setContent("<canvas></canvas>");
  const webp = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    return canvas.toDataURL("image/webp", 0.95).split(",")[1] as string;
  }, png.toString("base64"));
  exports.webp = join(directory, "design.webp");
  await writeFile(exports.webp, Buffer.from(webp, "base64"));
  await page.close();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
});

async function compare(appFile: string, design: DesignLocation, out: string) {
  const served = await resolveDesignSource(appFile, directory);
  try {
    const configuration = createQuickConfiguration([served.url], {
      design,
      colorSchemes: ["light"],
      viewports: ["desktop"],
    });
    const capture = await captureLiteralPages({
      directory,
      finalDirectory: join(directory, out),
      configuration,
      checks: checksConfigFrom(),
      startedAt: new Date(),
      label: "test",
      dependencies: { browserLauncher: createBrowserLauncher() },
    });
    const drift = capture.reviewed.candidates.filter(
      (entry) => entry.candidate.category === "design-drift",
    );
    return { capture, drift, configuration };
  } finally {
    await served.close();
  }
}

const intersects = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

async function loaded(run: Awaited<ReturnType<typeof compare>>) {
  return await loadCaptureRun({
    runDirectory: run.capture.runDirectory,
    expectedFlow: run.configuration.flow.id,
  });
}

let planted: Awaited<ReturnType<typeof compare>>;
let identical: Awaited<ReturnType<typeof compare>>;

test("an exported design PNG finds the planted departures without a model", async () => {
  planted = await compare(join(fixtures, "app.html"), exports.png, "png-run");
  expect(planted.capture.counts.failed).toBe(0);
  const { tuples } = await loaded(planted);
  const tuple = tuples[0];
  expect(tuple?.design?.unavailable).toBeUndefined();
  expect(tuple?.design?.descriptor.resolved).toMatchObject({
    kind: "image",
    mediaType: "image/png",
  });
  const regions = planted.drift.map(
    (entry) => entry.candidate.designDrift?.region,
  );
  expect(
    planted.drift.every((entry) => entry.candidate.severity === "minor"),
  ).toBe(true);
  // Card corner radius, tile spacing, button colour, missing badge.
  for (const rect of [
    { x: 40, y: 160, width: 8, height: 8 },
    { x: 176, y: 360, width: 120, height: 80 },
    { x: 40, y: 500, width: 180, height: 48 },
    { x: 440, y: 180, width: 48, height: 48 },
  ])
    expect(
      regions.some((region) => region && intersects(region.rect, rect)),
    ).toBe(true);
  expect(regions.map((region) => region?.owner)).toContain("div.card");
  expect(
    regions.some((region) =>
      region?.elements.some((e) => e.endsWith("button")),
    ),
  ).toBe(true);
  const findings = await attachCrops(
    planted.capture.runDirectory,
    finalizeFindings({
      runId: "test",
      drafts: buildDeterministicDrafts({
        runId: "test",
        entries: planted.drift,
      }),
    }),
    tuples,
  );
  expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(
    findings.length,
  );
  for (const finding of findings) {
    expect(finding.layer).toBe("deterministic");
    const crops = finding.evidence.designDrift?.crops ?? [];
    expect(crops.map((crop) => crop.label)).toEqual(["Design", "App capture"]);
    for (const crop of crops)
      expect(
        PNG.sync.read(
          await readFile(join(planted.capture.runDirectory, crop.path)),
        ).width,
      ).toBeGreaterThan(0);
  }
}, 60_000);

test.each(["png", "jpg", "webp"] as const)(
  "the identical render against the %s export has no design drift",
  async (format) => {
    const run = await compare(
      join(fixtures, "design.html"),
      exports[format],
      `identical-${format}`,
    );
    if (format === "png") identical = run;
    expect(run.capture.counts.failed).toBe(0);
    expect(
      run.capture.reviewed.coverage
        .filter((entry) => entry.coverage.check === "design-drift")
        .map((entry) => entry.coverage.status),
    ).toEqual(["ran"]);
    expect(run.drift.map((entry) => entry.candidate.explanation)).toEqual([]);
  },
  60_000,
);

test("replay recomputes identical regions and tampering fails closed", async () => {
  const { designDriftCheck } = await import("../src/checks/design-drift.js");
  const config = checksConfigFrom();
  const replay = (await loaded(planted)).tuples[0];
  if (!replay) throw new Error("no tuple");
  expect(
    designDriftCheck.run({ tuple: replay, config, narrowViewport: false })
      .candidates,
  ).toEqual(planted.drift.map((entry) => entry.candidate));
  const base = join(planted.capture.runDirectory, "page-1/desktop/design");
  for (const [file, change] of [
    [
      "regions.json",
      (text: string) => text.replace('"offset": 0', '"offset": 1'),
    ],
    ["reference.png", (text: string) => `${text}x`],
  ] as const) {
    const path = join(base, file);
    const original = await readFile(path);
    await writeFile(path, change(original.toString("latin1")), "latin1");
    try {
      const tuple = (await loaded(planted)).tuples[0];
      if (!tuple) throw new Error("no tuple");
      expect(tuple.design?.unavailable).toMatch(/Design evidence unavailable/);
      expect(
        designDriftCheck.run({ tuple, config, narrowViewport: false }).coverage
          .status,
      ).toBe("unavailable");
    } finally {
      await writeFile(path, original);
    }
  }
}, 60_000);

test("verification is fixed when the app is corrected and unverifiable when the design image changes", async () => {
  const { evaluateVerification } = await import("../src/verify/evaluate.js");
  const findings = finalizeFindings({
    runId: "test",
    drafts: buildDeterministicDrafts({ runId: "test", entries: planted.drift }),
  });
  const baseline = (await loaded(planted)).tuples;
  const fixed = (await loaded(identical)).tuples;
  const evaluate = (current: typeof baseline) =>
    evaluateVerification({
      findings,
      baseline,
      currentA: current,
      currentB: current,
      checksConfig: checksConfigFrom(),
    }).findings.map((verdict) => verdict.status);
  expect(new Set(evaluate(fixed))).toEqual(new Set(["fixed"]));
  expect(new Set(evaluate(baseline))).toEqual(new Set(["reproduced"]));
  const changed = await compare(
    join(fixtures, "design.html"),
    exports.jpg,
    "changed-design",
  );
  expect(new Set(evaluate((await loaded(changed)).tuples))).toEqual(
    new Set(["unverifiable"]),
  );
}, 60_000);

test("a live site reference runs the full element comparison", async () => {
  const site = await resolveDesignSource(
    join(htmlFixtures, "design.html"),
    directory,
  );
  try {
    const run = await compare(
      join(htmlFixtures, "app.html"),
      { site: site.url },
      "site-run",
    );
    expect(run.capture.counts.failed).toBe(0);
    const tuple = (await loaded(run)).tuples[0];
    expect(tuple?.design?.descriptor.resolved?.kind).toBe("site");
    expect(tuple?.design?.matches).toBeDefined();
    for (const property of [
      "borderTopLeftRadius",
      "gap.x",
      "fontWeight",
      "color",
      "missing",
      "extra",
      "text",
    ])
      expect(
        run.drift.some(
          (entry) => entry.candidate.designDrift?.property === property,
        ),
      ).toBe(true);
  } finally {
    await site.close();
  }
}, 60_000);

test.each([
  [403, "text/html", "<p>Forbidden</p>"],
  [200, "text/html", "<title>Sign in</title><p>Sign in to continue</p>"],
] as const)(
  "a site answering %i with a wall fails with the remedy",
  async (status, type, body) => {
    const server = createServer((_, response) => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    });
    await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
    const { port } = server.address() as { port: number };
    try {
      const run = await compare(
        join(fixtures, "design.html"),
        { site: `http://127.0.0.1:${port}/` },
        `site-wall-${status}`,
      );
      expect(run.capture.counts.failed).toBe(1);
      const tuple = (await loaded(run)).tuples[0];
      expect(tuple?.design?.unavailable).toMatch(/without signing in/);
    } finally {
      server.closeAllConnections();
      await new Promise((yes) => server.close(yes));
    }
  },
  60_000,
);

test("quick --design compares one page and rejects several before launching a browser", async () => {
  const served = await resolveDesignSource(
    join(fixtures, "app.html"),
    directory,
  );
  try {
    const result = await runQuick({
      urls: [served.url],
      design: exports.png,
      viewports: ["desktop"],
      literal: true,
      materializeAllDeterministic: true,
      cwd: directory,
      out: "quick-run",
    });
    expect(
      result.findings?.filter((finding) => finding.category === "design-drift")
        .length,
    ).toBeGreaterThanOrEqual(4);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Design image:");
    expect(report).toContain("Region region-1");
  } finally {
    await served.close();
  }
  await expect(
    runQuick({
      urls: ["http://127.0.0.1:9/a", "http://127.0.0.1:9/b"],
      design: exports.png,
      literal: true,
      cwd: directory,
      dependencies: {
        browserLauncher: () => {
          throw new Error("browser launched");
        },
      },
    }),
  ).rejects.toThrow(/single URL/);
}, 120_000);
