import type { Page } from "playwright";
import { PNG } from "pngjs";
import type { Rect, ScreenshotGeometry } from "../checks/types.js";

/**
 * Chromium's maximum texture size, in physical px. A full-page shot taller
 * than this paints plain background below it whenever the page has a
 * render surface spanning its height (an isolated group with a composited
 * mix-blend-mode descendant is the measured case).
 */
export const MAX_SURFACE_PX = 16384;

/** Above this the stitched image is not built; the single shot is kept. */
export const MAX_STITCH_BYTES = 1024 ** 3;

type ScreenshotOptions = Parameters<Page["screenshot"]>[0];

export type CapturedScreenshot = {
  buffer: Buffer;
  geometry: Omit<ScreenshotGeometry, "drift" | "rects">;
};

/** CSS px per tile: half the texture limit in physical px. */
export function tileHeightCss(scale: number): number {
  return Math.max(1, Math.floor(8192 / scale));
}

/**
 * The page size a Playwright full-page screenshot captures, using the same
 * formula Playwright does: the largest of body and documentElement scroll,
 * offset and client sizes.
 */
export async function fullPageSize(
  page: Page,
): Promise<{ width: number; height: number }> {
  return page.evaluate(() => {
    const body = document.body;
    const root = document.documentElement;
    return {
      width: Math.max(
        body?.scrollWidth ?? 0,
        root.scrollWidth,
        body?.offsetWidth ?? 0,
        root.offsetWidth,
        body?.clientWidth ?? 0,
        root.clientWidth,
      ),
      height: Math.max(
        body?.scrollHeight ?? 0,
        root.scrollHeight,
        body?.offsetHeight ?? 0,
        root.offsetHeight,
        body?.clientHeight ?? 0,
        root.clientHeight,
      ),
    };
  });
}

/**
 * Take the tuple screenshot and record its geometry. A full-page shot whose
 * physical height exceeds the texture limit is taken as clip tiles and
 * stitched; every other capture is the plain `page.screenshot(options)`.
 */
export async function captureScreenshot(
  page: Page,
  options: ScreenshotOptions,
): Promise<CapturedScreenshot> {
  const [{ scale, innerWidth, innerHeight }, size] = await Promise.all([
    page.evaluate(() => ({
      scale: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    })),
    fullPageSize(page),
  ]);
  if (options?.fullPage !== true)
    return {
      buffer: await page.screenshot(options),
      geometry: {
        strategy: "viewport",
        scale,
        width: innerWidth,
        height: innerHeight,
      },
    };
  const { width, height } = size;
  // Pathologically large pages would need more memory to stitch than the
  // single shot is worth; they keep the single shot and its known
  // blank-below-the-limit trade-off.
  if (
    Math.ceil(height * scale) <= MAX_SURFACE_PX ||
    width * scale * height * scale * 4 > MAX_STITCH_BYTES
  )
    return {
      buffer: await page.screenshot(options),
      geometry: { strategy: "full-page", scale, width, height },
    };
  // Wider than the limit is not tiled horizontally; the spec covers height.
  const tile = tileHeightCss(scale);
  let output: PNG | undefined;
  let tiles = 0;
  for (let y = 0; y < height; y += tile) {
    const image = PNG.sync.read(
      await page.screenshot({
        ...options,
        clip: { x: 0, y, width, height: Math.min(tile, height - y) },
      }),
    );
    output ??= new PNG({
      width: image.width,
      height: Math.round(height * scale),
    });
    const top = Math.min(Math.round(y * scale), output.height);
    const rows = Math.min(image.height, output.height - top);
    const columns = Math.min(image.width, output.width);
    if (rows > 0 && columns > 0)
      PNG.bitblt(image, output, 0, 0, columns, rows, 0, top);
    tiles += 1;
  }
  if (output === undefined)
    return {
      buffer: await page.screenshot(options),
      geometry: { strategy: "full-page", scale, width, height },
    };
  return {
    buffer: PNG.sync.write(output),
    geometry: { strategy: "tiled", scale, width, height, tiles },
  };
}

/**
 * Re-measure each selector's rect the way observe measures element rects
 * (unrounded `getBoundingClientRect`), unioning every match. Invalid
 * selectors and zero-area results are left out.
 */
export async function screenshotRects(
  page: Page,
  selectors: string[],
): Promise<Record<string, Rect>> {
  return page.evaluate((selectors) => {
    const rects: Record<string, Rect> = {};
    for (const selector of selectors) {
      let matches: Element[];
      try {
        matches = [...document.querySelectorAll(selector)];
      } catch {
        continue;
      }
      const boxes = matches
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0);
      if (boxes.length === 0) continue;
      const left = Math.min(...boxes.map((box) => box.left));
      const top = Math.min(...boxes.map((box) => box.top));
      const right = Math.max(...boxes.map((box) => box.right));
      const bottom = Math.max(...boxes.map((box) => box.bottom));
      rects[selector] = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };
    }
    return rects;
  }, selectors);
}

/**
 * The drift record when the captured page size differs from the size at
 * observation time by more than a CSS px; undefined otherwise.
 */
export function screenshotDrift(
  observed: { width: number; height: number },
  captured: { width: number; height: number },
): NonNullable<ScreenshotGeometry["drift"]> | undefined {
  if (
    Math.abs(observed.width - captured.width) <= 1 &&
    Math.abs(observed.height - captured.height) <= 1
  )
    return undefined;
  return {
    observed: { width: observed.width, height: observed.height },
    captured: { width: captured.width, height: captured.height },
  };
}

/**
 * Attach screenshot geometry to the observations, re-measuring every
 * observed selector when layout drifted between observing and the shot.
 */
export async function withScreenshotGeometry(
  page: Page,
  geometry: Omit<ScreenshotGeometry, "drift" | "rects">,
  observed: { width: number; height: number } | undefined,
  selectors: string[],
): Promise<ScreenshotGeometry> {
  const drift =
    observed === undefined || geometry.strategy === "viewport"
      ? undefined
      : screenshotDrift(observed, geometry);
  if (drift === undefined) return geometry;
  return {
    ...geometry,
    drift,
    rects: await screenshotRects(page, [...new Set(selectors)]),
  };
}
