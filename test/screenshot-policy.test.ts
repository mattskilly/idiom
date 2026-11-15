import { errors, type Page } from "playwright";
import { PNG } from "pngjs";
import { afterEach, expect, test, vi } from "vitest";
import {
  captureScreenshot,
  SCREENSHOT_MIN_SHOT_MS,
  SCREENSHOT_MIN_TILE_MS,
  ScreenshotOutOfTime,
} from "../src/capture/screenshot.js";

afterEach(() => vi.restoreAllMocks());
function page(width: number, height: number, scale = 1) {
  let reads = 0;
  const screenshots: Array<NonNullable<Parameters<Page["screenshot"]>[0]>> = [];
  return {
    screenshots,
    page: {
      evaluate: async () =>
        ++reads % 2
          ? { scale, innerWidth: width, innerHeight: 600 }
          : { width, height },
      screenshot: async (
        options: NonNullable<Parameters<Page["screenshot"]>[0]>,
      ) => {
        screenshots.push(options);
        return PNG.sync.write(
          new PNG({ width: 1, height: Math.round(options.clip?.height ?? 1) }),
        );
      },
    } as unknown as Page,
  };
}

test("even the large-memory fallback clips before capture and keeps policy out of Playwright options", async () => {
  const f = page(100000, 40000, 2);
  const shot = await captureScreenshot(f.page, {
    fullPage: true,
    timeout: 30000,
  });
  expect(shot.geometry).toMatchObject({
    strategy: "full-page",
    height: 16000,
    croppedFromHeight: 40000,
  });
  expect(f.screenshots).toHaveLength(1);
  expect(f.screenshots[0]).toMatchObject({
    fullPage: true,
    clip: { x: 0, y: 0, width: 100000, height: 16000 },
  });
  expect(f.screenshots[0]).not.toHaveProperty("maxFullPageHeight");
});

function timedPage(
  height: number,
  advance: (call: number) => number,
  clock: { now: number },
  { scale = 1, enforceTimeout = false } = {},
) {
  const f = page(1, height, scale);
  const screenshot = f.page.screenshot.bind(f.page);
  let call = 0;
  vi.spyOn(f.page, "screenshot").mockImplementation(async (options) => {
    const took = advance(call++);
    // Like Playwright: a shot that would take longer than its timeout stops
    // at the timeout and throws.
    if (
      enforceTimeout &&
      options?.timeout !== undefined &&
      took > options.timeout
    ) {
      clock.now += options.timeout;
      throw new errors.TimeoutError(
        `page.screenshot: Timeout ${options.timeout}ms exceeded.`,
      );
    }
    clock.now += took;
    return screenshot(options);
  });
  return f;
}

test("tiles share one allowance and never send an expired remainder as timeout zero", async () => {
  const clock = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  // An allowance below the minimum clamps the minimum to the allowance: the
  // first tile starts with all of it, and a later tile with less is refused.
  const f = timedPage(20000, () => 10, clock);
  const refused = await captureScreenshot(
    f.page,
    { fullPage: true, timeout: 100 },
    { maxFullPageHeight: 20000 },
  ).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ScreenshotOutOfTime);
  expect(refused).toBeInstanceOf(errors.TimeoutError);
  expect(f.screenshots.map((options) => options.timeout)).toEqual([100]);
  expect(f.screenshots.every((options) => options.timeout !== 0)).toBe(true);
  expect((refused as Error).message).toBe(
    "screenshot out of time: 90 ms of the 100 ms screenshot allowance left after 1 of 3 tiles; each tile needs at least 100 ms",
  );
  // Tiles that finish quickly all fit one allowance.
  const quick = timedPage(20000, () => 10, clock);
  const shot = await captureScreenshot(
    quick.page,
    { fullPage: true, timeout: 30000 },
    { maxFullPageHeight: 20000 },
  );
  expect(quick.screenshots.map((options) => options.timeout)).toEqual([
    30000, 29990, 29980,
  ]);
  expect(quick.screenshots.every((options) => options.fullPage === true)).toBe(
    true,
  );
  expect(shot.geometry).toMatchObject({ strategy: "tiled", tiles: 3 });
  expect(shot.geometry.croppedFromHeight).toBeUndefined();
});

test("a later tile starts below the minimum share while real time is left", async () => {
  expect(SCREENSHOT_MIN_SHOT_MS).toBe(10000);
  const clock = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  // 10000 ms left: the third tile starts with it.
  const fits = timedPage(20000, () => 10000, clock);
  await captureScreenshot(
    fits.page,
    { fullPage: true, timeout: 30000 },
    { maxFullPageHeight: 20000 },
  );
  expect(fits.screenshots.map((options) => options.timeout)).toEqual([
    30000, 20000, 10000,
  ]);
  // 8000 ms left is below the minimum share, but the screenshot has already
  // started: the third tile is tried with all of it, and finishes.
  const slow = timedPage(20000, (call) => (call < 2 ? 11000 : 7000), clock, {
    enforceTimeout: true,
  });
  const shot = await captureScreenshot(
    slow.page,
    { fullPage: true, timeout: 30000 },
    { maxFullPageHeight: 20000 },
  );
  expect(slow.screenshots.map((options) => options.timeout)).toEqual([
    30000, 19000, 8000,
  ]);
  expect(shot.geometry).toMatchObject({ strategy: "tiled", tiles: 3 });
});

test("a tall page's last tile starts with 9384 ms left and succeeds (the field-test shape)", async () => {
  const clock = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  // Scale 2 at the 16000 px cap: 4 tiles of 4096 CSS px.
  const f = timedPage(16000, (call) => (call < 3 ? 6872 : 7000), clock, {
    scale: 2,
    enforceTimeout: true,
  });
  const shot = await captureScreenshot(
    f.page,
    { fullPage: true, timeout: 30000 },
    { maxFullPageHeight: 16000 },
  );
  expect(f.screenshots.map((options) => options.timeout)).toEqual([
    30000, 23128, 16256, 9384,
  ]);
  expect(shot.geometry).toMatchObject({ strategy: "tiled", tiles: 4 });
});

test("a later tile that starts but does not finish is screenshot out of time", async () => {
  const clock = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  const f = timedPage(20000, (call) => (call < 2 ? 11000 : 9000), clock, {
    enforceTimeout: true,
  });
  const error = await captureScreenshot(
    f.page,
    { fullPage: true, timeout: 30000 },
    { maxFullPageHeight: 20000 },
  ).catch((caught: unknown) => caught);
  expect(f.screenshots.map((options) => options.timeout)).toEqual([
    30000, 19000,
  ]);
  expect(error).toBeInstanceOf(ScreenshotOutOfTime);
  expect(error).toBeInstanceOf(errors.TimeoutError);
  expect((error as Error).message).toContain(
    "screenshot out of time: a shot did not finish in 8000 ms of the 30000 ms",
  );
  expect((error as Error).cause).toBeInstanceOf(errors.TimeoutError);
  expect(error).toMatchObject({ tilesDone: 2, tilesTotal: 3 });
});

test("a later tile with less than the tile floor left is refused", async () => {
  expect(SCREENSHOT_MIN_TILE_MS).toBe(1000);
  const clock = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  const f = timedPage(20000, () => 14600, clock);
  const error = await captureScreenshot(
    f.page,
    { fullPage: true, timeout: 30000 },
    { maxFullPageHeight: 20000 },
  ).catch((caught: unknown) => caught);
  expect(f.screenshots).toHaveLength(2);
  expect(error).toBeInstanceOf(ScreenshotOutOfTime);
  expect(error).toMatchObject({
    allowanceMs: 30000,
    remainingMs: 800,
    minShotMs: 1000,
    tilesDone: 2,
    tilesTotal: 3,
  });
  expect((error as Error).message).toBe(
    "screenshot out of time: 800 ms of the 30000 ms screenshot allowance left after 2 of 3 tiles; each tile needs at least 1000 ms",
  );
});

test("a Playwright timeout during a shot is reported as screenshot out of time", async () => {
  const f = page(1, 600);
  const original = new errors.TimeoutError(
    "page.screenshot: Timeout 6270ms exceeded.\nCall log:\n  - waiting for fonts to load...",
  );
  vi.spyOn(f.page, "screenshot").mockRejectedValue(original);
  const error = await captureScreenshot(f.page, {
    fullPage: false,
    timeout: 30000,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ScreenshotOutOfTime);
  expect((error as Error).cause).toBe(original);
  expect((error as Error).message).toMatch(
    /^screenshot out of time: a shot did not finish in \d+ ms of the 30000 ms screenshot allowance \(page\.screenshot: Timeout 6270ms exceeded\.\)$/,
  );
  const other = new Error("Target closed");
  vi.spyOn(f.page, "screenshot").mockRejectedValue(other);
  await expect(
    captureScreenshot(f.page, { fullPage: false, timeout: 30000 }),
  ).rejects.toBe(other);
});

test("an allowance below the minimum still takes its first shot with all of it", async () => {
  const f = page(1, 600);
  await captureScreenshot(f.page, { fullPage: true, timeout: 5000 });
  expect(f.screenshots.map((options) => options.timeout)).toEqual([5000]);
});

test("exact cap and viewport-only captures retain their original bounds", async () => {
  const exact = page(1, 16000);
  const full = await captureScreenshot(exact.page, { fullPage: true });
  expect(full.geometry.croppedFromHeight).toBeUndefined();
  expect(exact.screenshots[0]?.clip).toBeUndefined();
  const viewport = page(1, 40000);
  const shot = await captureScreenshot(
    viewport.page,
    { fullPage: false },
    { maxFullPageHeight: 100 },
  );
  expect(shot.geometry).toMatchObject({ strategy: "viewport", height: 600 });
  expect(shot.geometry.croppedFromHeight).toBeUndefined();
  expect(viewport.screenshots[0]?.clip).toBeUndefined();
});
