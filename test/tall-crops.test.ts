import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  captureScreenshot,
  fullPageSize,
  screenshotDrift,
  tileHeightCss,
  withScreenshotGeometry,
} from "../src/capture/screenshot.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { observePage } from "../src/checks/observe.js";
import type {
  CheckTuple,
  ObservationArtifactV2,
  Rect,
} from "../src/checks/types.js";
import { attachCrops, screenshotPlacement } from "../src/review/crops.js";
import type { Finding } from "../src/schemas/finding.js";

const options = {
  fullPage: true,
  animations: "disabled",
  type: "png",
} as const;

// A full-height isolated group with a composited blend child renders as one
// surface capped at the texture limit; a seam band straddles the first tile
// boundary (4096 CSS px at DPR 2).
const tall = `<body style="margin:0;background:#fff">
  <div style="isolation:isolate">
    <div style="position:fixed;top:0;width:100px;height:100px;mix-blend-mode:difference;background:#0f0"></div>
    <div style="height:3900px"></div>
    <div id="band" style="height:400px;background:#00f"></div>
    <div style="height:7700px"></div>
    <div id="t" style="width:200px;height:200px;background:#e00">Target</div>
    <div style="height:500px"></div>
  </div>
</body>`;

let browser: Browser;
let directory: string;

beforeAll(async () => {
  browser = await chromium.launch();
  directory = await mkdtemp(join(tmpdir(), "idiom-tall-crops-"));
});
afterAll(async () => {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
});

async function open(
  html: string,
  viewport: { width: number; height: number },
): Promise<Page> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.setContent(html);
  return page;
}

async function observe(page: Page): Promise<ObservationArtifactV2> {
  const result = await observePage(
    page,
    { status: "not-configured" },
    undefined,
    [],
  );
  expect(result.version).toBe(2);
  return result as ObservationArtifactV2;
}

async function rectOf(page: Page, selector: string): Promise<Rect> {
  return page.$eval(selector, (element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
}

function pixel(image: PNG, x: number, y: number): [number, number, number] {
  const index = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return [
    image.data[index] ?? 0,
    image.data[index + 1] ?? 0,
    image.data[index + 2] ?? 0,
  ];
}

const red = ([r, g, b]: [number, number, number]) =>
  r > 200 && g < 60 && b < 60;

let sequence = 0;
/** Crop `selector` out of a stored screenshot through attachCrops. */
async function crop(
  screenshot: Buffer,
  observations: ObservationArtifactV2,
  selector: string,
): Promise<PNG | undefined> {
  sequence += 1;
  const base = `tuple-${sequence}`;
  await mkdir(join(directory, base), { recursive: true });
  await writeFile(join(directory, base, "screenshot.png"), screenshot);
  const tuple = {
    flow: "flow",
    state: "state",
    viewport: "viewport",
    width: observations.viewport.width,
    height: observations.viewport.height,
    metadataPath: `${base}/metadata.json`,
    screenshotPath: `${base}/screenshot.png`,
    artifactPaths: [],
    commit: "test",
    createdAt: "2026-10-26T00:00:00.000Z",
    observations,
    console: [],
  } as unknown as CheckTuple;
  const finding = {
    state: "state",
    viewport: "viewport",
    fingerprint: `${String(sequence).padStart(4, "0")}aaaaaaaaaaaaaaaaaaaa`,
    verification: { params: { selector } },
    evidence: { screenshots: [] },
  } as unknown as Finding;
  const [result] = await attachCrops(directory, [finding], [tuple]);
  const path = result?.evidence.screenshots.find((item) =>
    item.includes("/crops/"),
  );
  if (path === undefined) return undefined;
  return PNG.sync.read(await readFile(join(directory, path)));
}

/** Whether the crop's centre is red (the target sits in the middle). */
const centreRed = (image: PNG | undefined) =>
  image !== undefined && red(pixel(image, image.width / 2, image.height / 2));

describe("tall pages", () => {
  test("tiles past the texture limit so a bottom element is painted", async () => {
    const page = await open(tall, { width: 1440, height: 900 });
    const target = await rectOf(page, "#t");
    expect(target.y * 2).toBeGreaterThan(16384);

    const control = PNG.sync.read(await page.screenshot(options));
    // Proves the fixture reproduces the blank single shot. If a newer
    // Chromium paints it, relax this deliberately.
    expect(
      red(pixel(control, (target.x + 100) * 2, (target.y + 150) * 2)),
    ).toBe(false);

    const { buffer, geometry } = await captureScreenshot(page, options);
    const size = await fullPageSize(page);
    expect(geometry).toEqual({
      strategy: "tiled",
      scale: 2,
      width: 1440,
      height: size.height,
      tiles: Math.ceil(size.height / 4096),
    });
    const image = PNG.sync.read(buffer);
    expect([image.width, image.height]).toEqual([
      2880,
      Math.round(size.height * 2),
    ]);
    for (const [dx, dy] of [
      [30, 120],
      [100, 150],
      [190, 190],
    ] as const)
      expect(red(pixel(image, (target.x + dx) * 2, (target.y + dy) * 2))).toBe(
        true,
      );
    // No seam at the first tile boundary inside the solid blue band.
    for (const row of [8191, 8192, 8193])
      expect(pixel(image, 1440, row)).toEqual([0, 0, 255]);

    const observations = await observe(page);
    const placed = { ...observations, screenshot: geometry };
    expect(observationArtifactSchema.safeParse(placed).success).toBe(true);
    expect(centreRed(await crop(buffer, placed, "#t"))).toBe(true);
    await page.context().close();
  }, 120_000);

  test("short full pages keep the single shot byte for byte", async () => {
    const page = await open(
      '<body style="margin:0"><div style="height:3000px;background:linear-gradient(#fff,#08f)"></div></body>',
      { width: 1440, height: 900 },
    );
    const plain = await page.screenshot(options);
    const { buffer, geometry } = await captureScreenshot(page, options);
    expect(geometry.strategy).toBe("full-page");
    expect(geometry.tiles).toBeUndefined();
    expect(buffer.equals(plain)).toBe(true);
    const viewport = await captureScreenshot(page, {
      ...options,
      fullPage: false,
    });
    expect(viewport.geometry).toEqual({
      strategy: "viewport",
      scale: 2,
      width: 1440,
      height: 900,
    });
    await page.context().close();
  });
});

describe("crop placement", () => {
  test("horizontal overflow uses the recorded scale, not image width", async () => {
    const page = await open(
      `<body style="margin:0;background:#fff">
        <div style="width:694px;height:10px"></div>
        <div style="height:780px"></div>
        <button id="m" style="margin-left:40px;width:120px;height:40px;background:#e00;border:0">Collapse</button>
        <div style="height:400px"></div>
      </body>`,
      { width: 390, height: 844 },
    );
    const { buffer, geometry } = await captureScreenshot(page, options);
    expect(PNG.sync.read(buffer).width).toBe(1388);
    expect(geometry.scale).toBe(2);
    const observations = await observe(page);
    expect(
      centreRed(
        await crop(buffer, { ...observations, screenshot: geometry }, "#m"),
      ),
    ).toBe(true);
    // Without geometry the document-width fallback still finds it.
    expect(centreRed(await crop(buffer, observations, "#m"))).toBe(true);
    await page.context().close();
  });

  test("layout that moved after observing is re-measured for the crop", async () => {
    const page = await open(
      `<body style="margin:0;background:#fff">
        <div style="height:600px"></div>
        <button id="ticker" style="width:300px;height:40px;background:#e00;border:0">Ticker</button>
        <div style="height:1200px"></div>
      </body>`,
      { width: 1280, height: 800 },
    );
    const observations = await observe(page);
    const observed = await fullPageSize(page);
    const before = await rectOf(page, "#ticker");
    await page.evaluate(() => {
      const block = document.createElement("div");
      block.style.height = "300px";
      document.body.prepend(block);
    });
    const { buffer, geometry } = await captureScreenshot(page, options);
    const placed = await withScreenshotGeometry(
      page,
      geometry,
      observed,
      observations.elements.map((element) => element.selector),
    );
    expect(placed.drift).toEqual({
      observed,
      captured: { width: observed.width, height: observed.height + 300 },
    });
    expect(placed.rects?.["#ticker"]?.y).toBe(before.y + 300);
    const artifact = { ...observations, screenshot: placed };
    expect(observationArtifactSchema.safeParse(artifact).success).toBe(true);
    const { drift: _drift, ...undrifted } = placed;
    expect(
      observationArtifactSchema.safeParse({
        ...observations,
        screenshot: undrifted,
      }).success,
    ).toBe(false);
    expect(
      observationArtifactSchema.safeParse({
        ...observations,
        screenshot: { ...geometry, tiles: 2 },
      }).success,
    ).toBe(false);
    expect(centreRed(await crop(buffer, artifact, "#ticker"))).toBe(true);
    // The observed rect now points 300px above the ticker.
    expect(centreRed(await crop(buffer, observations, "#ticker"))).toBe(false);

    const steady = await withScreenshotGeometry(
      page,
      geometry,
      { width: geometry.width, height: geometry.height },
      ["#ticker"],
    );
    expect(steady).toEqual(geometry);
    await page.context().close();
  });
});

describe("geometry records", () => {
  test("tile height is half the texture limit in device px", () => {
    expect(tileHeightCss(2)).toBe(4096);
    expect(tileHeightCss(1)).toBe(8192);
    expect(tileHeightCss(3)).toBe(2730);
  });

  test("drift tolerates a CSS px", () => {
    expect(
      screenshotDrift({ width: 10, height: 10 }, { width: 11, height: 9 }),
    ).toBeUndefined();
    expect(
      screenshotDrift({ width: 10, height: 10 }, { width: 10, height: 12 }),
    ).toEqual({
      observed: { width: 10, height: 10 },
      captured: { width: 10, height: 12 },
    });
  });

  test("placement falls back without geometry", () => {
    const element = {
      selector: "#a",
      rect: { x: 1, y: 2, width: 3, height: 4 },
    };
    const v1 = screenshotPlacement({ version: 1 } as never);
    expect(v1.scale).toBeUndefined();
    expect(v1.rect(element)).toBe(element.rect);
    const moved = { x: 1, y: 302, width: 3, height: 4 };
    const v2 = screenshotPlacement({
      version: 2,
      screenshot: {
        strategy: "full-page",
        scale: 2,
        width: 10,
        height: 10,
        drift: {
          observed: { width: 10, height: 10 },
          captured: { width: 10, height: 310 },
        },
        rects: { "#a": moved },
      },
    } as never);
    expect(v2.scale).toBe(2);
    expect(v2.rect(element)).toEqual(moved);
    expect(v2.rect({ ...element, selector: "#b" })).toBe(element.rect);
  });
});
