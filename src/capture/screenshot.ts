import { errors, type Page } from "playwright";
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

/** The screenshot allowance per tuple when the state sets none. */
export const SCREENSHOT_ALLOWANCE_MS = 30000;

/**
 * The least time a screenshot is started with: a viewport shot, an untiled
 * full-page shot, or the first tile of a tiled one. Clamped to the tuple's
 * whole allowance when that is smaller. It decides whether a screenshot
 * starts, not whether a started tiled shot's later tiles do; those use
 * SCREENSHOT_MIN_TILE_MS.
 */
export const SCREENSHOT_MIN_SHOT_MS = 10_000;

/**
 * The least time a tile after the first is started with, clamped to the
 * minimum share when the allowance is smaller. A tiled shot that has started
 * shares one allowance across its tiles and keeps going while at least this
 * much is left; below it the tile is not started and the tuple is recorded as
 * screenshot out of time instead of being handed a sliver it cannot finish in.
 */
export const SCREENSHOT_MIN_TILE_MS = 1_000;

/**
 * A screenshot that ran out of its allowance: either too little was left to
 * start the next shot or tile, or a shot did not finish in what it was given.
 * Extends Playwright's TimeoutError so timeout handling treats it the same.
 * `minShotMs` is the floor that applied to the shot: the minimum share for a
 * screenshot's first shot, the tile floor for a later tile.
 */
export class ScreenshotOutOfTime extends errors.TimeoutError {
  constructor(
    message: string,
    readonly allowanceMs: number,
    readonly remainingMs: number,
    readonly minShotMs: number,
    readonly tilesDone?: number | undefined,
    readonly tilesTotal?: number | undefined,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ScreenshotOutOfTime";
    // Playwright's error classes drop constructor options, so set it here.
    if (cause !== undefined) this.cause = cause;
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(
    "\n",
  )[0] as string;
}

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
  policy: { maxFullPageHeight?: number | undefined } = {},
): Promise<CapturedScreenshot> {
  const allowance = options?.timeout ?? SCREENSHOT_ALLOWANCE_MS;
  const minShot = Math.min(SCREENSHOT_MIN_SHOT_MS, allowance);
  // Set once the page is measured: measuring is not screenshot time, and a
  // first shot must always start with the whole allowance.
  let deadline = Number.POSITIVE_INFINITY;
  const shot = async (
    extra: ScreenshotOptions = {},
    progress?: { done: number; total: number },
  ) => {
    const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
    // The minimum share decides whether a screenshot starts; once a tiled
    // shot has started, its later tiles are tried while real time is left.
    const later = progress !== undefined && progress.done > 0;
    const floor = later ? Math.min(SCREENSHOT_MIN_TILE_MS, minShot) : minShot;
    if (remaining < floor)
      throw new ScreenshotOutOfTime(
        `screenshot out of time: ${remaining} ms of the ${allowance} ms screenshot allowance left${progress === undefined ? "" : ` after ${progress.done} of ${progress.total} tiles`}; ${later ? "each tile" : "each shot"} needs at least ${floor} ms`,
        allowance,
        remaining,
        floor,
        progress?.done,
        progress?.total,
      );
    const timeout = Math.max(1, remaining);
    try {
      return await page.screenshot({ ...options, ...extra, timeout });
    } catch (error) {
      if (
        !(error instanceof errors.TimeoutError) ||
        error instanceof ScreenshotOutOfTime
      )
        throw error;
      throw new ScreenshotOutOfTime(
        `screenshot out of time: a shot did not finish in ${timeout} ms of the ${allowance} ms screenshot allowance (${firstLine(error)})`,
        allowance,
        Math.max(0, Math.ceil(deadline - performance.now())),
        floor,
        progress?.done,
        progress?.total,
        error,
      );
    }
  };
  const [{ scale, innerWidth, innerHeight }, size] = await Promise.all([
    page.evaluate(() => ({
      scale: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    })),
    fullPageSize(page),
  ]);
  deadline = performance.now() + allowance;
  if (options?.fullPage !== true)
    return {
      buffer: await shot(),
      geometry: {
        strategy: "viewport",
        scale,
        width: innerWidth,
        height: innerHeight,
      },
    };
  const { width } = size;
  const height = Math.min(size.height, policy.maxFullPageHeight ?? 16000);
  const crop = height < size.height ? { croppedFromHeight: size.height } : {};
  const clip =
    height < size.height ? { clip: { x: 0, y: 0, width, height } } : {};
  const fullShot = () => shot(clip);
  // Pathologically large pages would need more memory to stitch than the
  // single shot is worth; they keep the single shot and its known
  // blank-below-the-limit trade-off.
  if (
    Math.ceil(height * scale) <= MAX_SURFACE_PX ||
    width * scale * height * scale * 4 > MAX_STITCH_BYTES
  )
    return {
      buffer: await fullShot(),
      geometry: { strategy: "full-page", scale, width, height, ...crop },
    };
  // Wider than the limit is not tiled horizontally; the spec covers height.
  const tile = tileHeightCss(scale);
  let output: PNG | undefined;
  let tiles = 0;
  const total = Math.ceil(height / tile);
  for (let y = 0; y < height; y += tile) {
    const image = PNG.sync.read(
      await shot(
        { clip: { x: 0, y, width, height: Math.min(tile, height - y) } },
        { done: tiles, total },
      ),
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
      buffer: await fullShot(),
      geometry: { strategy: "full-page", scale, width, height, ...crop },
    };
  return {
    buffer: PNG.sync.write(output),
    geometry: { strategy: "tiled", scale, width, height, tiles, ...crop },
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
      : screenshotDrift(observed, {
          width: geometry.width,
          height: geometry.croppedFromHeight ?? geometry.height,
        });
  if (drift === undefined) return geometry;
  return {
    ...geometry,
    drift,
    rects: await screenshotRects(page, [...new Set(selectors)]),
  };
}
