import { dirname, join, resolve } from "node:path";
import type { PNG } from "pngjs";
import type { CheckTuple, Rect } from "../checks/types.js";
import { tupleLabel } from "../critique/context.js";
import type { CropRef } from "../critique/types.js";
import { cropToFile, selectorsFor, union } from "../review/crops.js";
import type { Finding } from "../schemas/finding.js";

/** Crops per surface (one flow state, every viewport and scheme). */
export const MAX_CROPS_PER_SURFACE = 8;
const REGION = { width: 480, height: 320 };
const PADDING = 16;

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** Greedy boxes over interactive elements in reading order. */
function controlRegions(tuple: CheckTuple): Rect[] {
  const elements = (tuple.observations?.elements ?? [])
    .filter(
      (element) =>
        element.visible &&
        element.interactive &&
        element.rect.width > 0 &&
        element.rect.height > 0,
    )
    .sort(
      (left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x,
    );
  const regions: Rect[] = [];
  let current: Rect | undefined;
  for (const element of elements) {
    const grown =
      current === undefined ? element.rect : union([current, element.rect]);
    if (
      grown !== undefined &&
      grown.width <= REGION.width &&
      grown.height <= REGION.height
    ) {
      current = grown;
      continue;
    }
    if (current !== undefined) regions.push(current);
    current = element.rect;
  }
  if (current !== undefined) regions.push(current);
  return regions;
}

function findingRegions(tuple: CheckTuple, findings: Finding[]): Rect[] {
  const elements = tuple.observations?.elements ?? [];
  return findings
    .filter(
      (finding) =>
        finding.state === tuple.state &&
        finding.viewport === tuple.viewport &&
        (finding.colorScheme === undefined ||
          finding.colorScheme === tuple.colorScheme),
    )
    .flatMap((finding) => {
      const selectors = selectorsFor(finding);
      const rect = union(
        elements
          .filter(
            (element) =>
              element.visible && selectors.includes(element.selector),
          )
          .map((element) => element.rect),
      );
      return rect === undefined || rect.width <= 0 || rect.height <= 0
        ? []
        : [rect];
    });
}

/**
 * Zoomed crops for one surface: first the regions deterministic findings
 * already point at, then the surface's controls in reading order, so the
 * model sees small details (dots, radii, gaps) a full-page screenshot blurs.
 * Crops are viewing aids, not evidence; an unreadable screenshot yields none.
 */
export async function sweepCrops(options: {
  runDirectory: string;
  tuples: CheckTuple[];
  findings: Finding[];
}): Promise<CropRef[]> {
  const images = new Map<string, PNG | undefined>();
  const crops: CropRef[] = [];
  // Share the allowance so one viewport cannot starve the others.
  const perTuple = Math.max(
    1,
    Math.floor(MAX_CROPS_PER_SURFACE / Math.max(1, options.tuples.length)),
  );
  for (const tuple of options.tuples) {
    const observations = tuple.observations;
    if (tuple.screenshotPath === undefined || observations === undefined)
      continue;
    const seen: Rect[] = [];
    for (const rect of [
      ...findingRegions(tuple, options.findings),
      ...controlRegions(tuple),
    ]) {
      if (crops.length >= MAX_CROPS_PER_SURFACE) return crops;
      if (seen.length >= perTuple) break;
      if (seen.some((earlier) => contains(earlier, rect))) continue;
      const index = crops.length + 1;
      const relativePath = join(
        dirname(tuple.screenshotPath),
        "sweep-crops",
        `${String(index).padStart(2, "0")}.png`,
      );
      const written = await cropToFile({
        runDirectory: options.runDirectory,
        screenshotPath: tuple.screenshotPath,
        images,
        viewportWidth: observations.viewport.width,
        rect,
        padding: PADDING,
        relativePath,
      });
      if (!written) continue;
      seen.push(rect);
      const screenshot = tupleLabel(tuple);
      crops.push({
        label: `${screenshot} zoom ${index}`,
        screenshot,
        path: relativePath,
        readPath: resolve(options.runDirectory, relativePath),
        state: tuple.state,
        viewport: tuple.viewport,
        ...(tuple.colorSchemeAxis ? { colorScheme: tuple.colorScheme } : {}),
        rect,
      });
    }
  }
  return crops;
}
