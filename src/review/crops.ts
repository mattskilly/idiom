import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import type { CheckTuple, Rect } from "../checks/types.js";
import type { Finding } from "../schemas/finding.js";

const padding = 24;

export function selectorsFor(finding: Finding): string[] {
  const params = finding.verification.params ?? {};
  return [params.selector, params.neighbour].filter(
    (value): value is string =>
      typeof value === "string" && value !== "document",
  );
}

export function union(rects: Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Cut a CSS-px rect (plus padding) out of a stored screenshot and write it to
 * `relativePath` under the run directory. Decoded screenshots are cached in
 * `images`. Returns false when the screenshot cannot be read or the rect
 * falls outside it.
 */
export async function cropToFile(options: {
  runDirectory: string;
  screenshotPath: string;
  images: Map<string, PNG | undefined>;
  viewportWidth: number;
  rect: Rect;
  padding: number;
  relativePath: string;
}): Promise<boolean> {
  const screenshotPath = join(options.runDirectory, options.screenshotPath);
  if (!options.images.has(screenshotPath)) {
    try {
      options.images.set(
        screenshotPath,
        PNG.sync.read(await readFile(screenshotPath)),
      );
    } catch {
      options.images.set(screenshotPath, undefined);
    }
  }
  const image = options.images.get(screenshotPath);
  if (image === undefined) return false;
  const { rect, padding } = options;
  const scale = image.width / options.viewportWidth;
  const x = Math.max(0, Math.floor((rect.x - padding) * scale));
  const y = Math.max(0, Math.floor((rect.y - padding) * scale));
  const width = Math.min(
    image.width - x,
    Math.ceil((rect.width + padding * 2) * scale),
  );
  const height = Math.min(
    image.height - y,
    Math.ceil((rect.height + padding * 2) * scale),
  );
  if (width <= 0 || height <= 0) return false;
  const crop = new PNG({ width, height });
  PNG.bitblt(image, crop, x, y, width, height, 0, 0);
  const target = join(options.runDirectory, options.relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, PNG.sync.write(crop));
  return true;
}

/**
 * Cut the finding's element (and its neighbour, for gap findings) out of the
 * tuple screenshot with a little context, so a person or an agent can see the
 * defect without hunting through a full-page capture. Crops are derived
 * deterministically from stored artifacts and are written beside them.
 */
export async function attachCrops(
  runDirectory: string,
  findings: Finding[],
  tuples: CheckTuple[],
): Promise<Finding[]> {
  const decoded = new Map<string, PNG | undefined>();
  const result: Finding[] = [];
  for (const finding of findings) {
    const tuple = tuples.find(
      (candidate) =>
        candidate.state === finding.state &&
        candidate.viewport === finding.viewport &&
        (finding.colorScheme === undefined ||
          candidate.colorScheme === finding.colorScheme),
    );
    const selectors = selectorsFor(finding);
    const observations = tuple?.observations;
    if (
      tuple?.screenshotPath === undefined ||
      observations === undefined ||
      selectors.length === 0
    ) {
      result.push(finding);
      continue;
    }
    const rect = union(
      observations.elements
        .filter(
          (element) => element.visible && selectors.includes(element.selector),
        )
        .map((element) => element.rect),
    );
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) {
      result.push(finding);
      continue;
    }
    const relativePath = join(
      dirname(tuple.screenshotPath),
      "crops",
      `${finding.fingerprint.slice(0, 16)}.png`,
    );
    const written = await cropToFile({
      runDirectory,
      screenshotPath: tuple.screenshotPath,
      images: decoded,
      viewportWidth: observations.viewport.width,
      rect,
      padding,
      relativePath,
    });
    if (!written) {
      result.push(finding);
      continue;
    }
    result.push({
      ...finding,
      evidence: {
        ...finding.evidence,
        screenshots: [
          ...finding.evidence.screenshots.filter(
            (path) => path !== relativePath,
          ),
          relativePath,
        ],
      },
    });
  }
  return result;
}
