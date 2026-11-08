import { errors, type Page } from "playwright";
import { PNG } from "pngjs";
import { afterEach, expect, test, vi } from "vitest";
import { captureScreenshot } from "../src/capture/screenshot.js";

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

test("tiles share one allowance and never send an expired remainder as timeout zero", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const f = page(1, 20000);
  const screenshot = f.page.screenshot.bind(f.page);
  vi.spyOn(f.page, "screenshot").mockImplementation(async (options) => {
    now += 10;
    return screenshot(options);
  });
  const shot = await captureScreenshot(
    f.page,
    { fullPage: true, timeout: 100 },
    { maxFullPageHeight: 20000 },
  );
  expect(f.screenshots.map((options) => options.timeout)).toEqual([
    100, 90, 80,
  ]);
  expect(f.screenshots.every((options) => options.fullPage === true)).toBe(
    true,
  );
  expect(shot.geometry.croppedFromHeight).toBeUndefined();
  const expired = page(1, 20000);
  const first = expired.page.screenshot.bind(expired.page);
  vi.spyOn(expired.page, "screenshot").mockImplementation(async (options) => {
    now += 101;
    return first(options);
  });
  await expect(
    captureScreenshot(
      expired.page,
      { fullPage: true, timeout: 100 },
      { maxFullPageHeight: 20000 },
    ),
  ).rejects.toBeInstanceOf(errors.TimeoutError);
  expect(expired.screenshots).toHaveLength(1);
  expect(expired.screenshots[0]?.timeout).toBe(100);
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
