import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { screenshotScale } from "../capture/media-bands.js";
import type { CheckTuple, ObservationArtifact, Rect } from "../checks/types.js";
import { tupleDesigns } from "../design/evidence.js";
import type { LoadedDesign } from "../design/types.js";
import type { Finding } from "../schemas/finding.js";

const padding = 24;

export function selectorsFor(finding: Finding): string[] {
  const params = finding.verification.params ?? {};
  return [params.selector, params.neighbour].filter(
    (value): value is string =>
      typeof value === "string" && value !== "document",
  );
}

/** A finding's own measured rect (`params.rect`), when it is a usable CSS-px box. */
export function paramsRect(finding: Finding): Rect | undefined {
  const rect = finding.verification.params?.rect;
  if (typeof rect !== "object" || rect === null) return undefined;
  const { x, y, width, height } = rect as Record<string, unknown>;
  return typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number" &&
    [x, y, width, height].every(Number.isFinite) &&
    width > 0 &&
    height > 0
    ? { x, y, width, height }
    : undefined;
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
 * Where an observed element sits in the stored screenshot: the screenshot's
 * recorded device scale, and the element's rect re-measured at screenshot
 * time when layout drifted after observing. Observations without screenshot
 * geometry fall back to the observed rect and the width-derived scale.
 */
export function screenshotPlacement(observations: ObservationArtifact): {
  scale?: number | undefined;
  rect(element: { selector: string; rect: Rect }): Rect;
} {
  const geometry =
    observations.version === 2 ? observations.screenshot : undefined;
  return {
    scale: geometry?.scale,
    rect: (element) => geometry?.rects?.[element.selector] ?? element.rect,
  };
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
  /** Device px per CSS px; derived from the image width when absent. */
  scale?: number | undefined;
  /** Without `scale`, accounts for full-page screenshots wider than the viewport. */
  viewport?: { width: number; height: number; documentWidth: number };
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
  const scale =
    options.scale ??
    (options.viewport === undefined
      ? image.width / options.viewportWidth
      : screenshotScale(
          image,
          options.viewport,
          options.viewport.documentWidth,
        ));
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
    if (finding.evidence.designDrift && tuple) {
      const drift = finding.evidence.designDrift;
      const crops: NonNullable<typeof drift.crops> = [];
      const designs = tupleDesigns(tuple);
      const named = (name: string | undefined) =>
        designs.find((d) => (d.descriptor.name ?? "design") === name);
      // A decision shows every reference; other findings show the one they cite.
      const sides: Array<{
        label: string;
        design?: LoadedDesign | undefined;
        selector?: string | undefined;
      }> = [
        ...(drift.designDecision
          ? drift.designDecision.references.map((reference) => ({
              label: `Design: ${reference.name}`,
              design: named(reference.name),
              selector: reference.designSelector,
            }))
          : [
              {
                label:
                  designs.length > 1
                    ? `Design: ${drift.chosenReference ?? drift.reference ?? designs[0]?.descriptor.name ?? "design"}`
                    : "Design",
                design:
                  named(drift.chosenReference ?? drift.reference) ??
                  tuple.design,
              },
            ]),
        { label: "App capture" },
      ];
      for (const [index, entry] of sides.entries()) {
        const side = entry.label;
        const design = side !== "App capture";
        const screenshot = design
          ? entry.design?.screenshotPath
          : tuple.screenshotPath;
        const path = `${dirname(tuple.metadataPath)}/crops/${finding.fingerprint.slice(0, 16)}-${design ? (sides.length > 2 ? `design-${index + 1}` : "design") : "app"}.png`;
        if (drift.region) {
          // Image regions carry their own rects on each side.
          if (
            screenshot &&
            (await cropToFile({
              runDirectory,
              screenshotPath: screenshot,
              images: decoded,
              viewportWidth: tuple.width,
              scale: design
                ? undefined
                : tuple.observations &&
                  screenshotPlacement(tuple.observations).scale,
              rect: design ? drift.region.designRect : drift.region.rect,
              padding,
              relativePath: path,
            }))
          )
            crops.push({ label: side, path });
          continue;
        }
        const observation = design
          ? entry.design?.observations
          : tuple.observations;
        const selector = design
          ? (entry.selector ?? drift.designSelector ?? drift.designContext)
          : (drift.appSelector ?? drift.appContext);
        const neighbour = design
          ? drift.neighbour?.designSelector
          : drift.neighbour?.appSelector;
        if (!screenshot || !observation || !selector) continue;
        // Design sides keep the width-derived scale and observed rects.
        const placement = design ? undefined : screenshotPlacement(observation);
        const rect = union(
          observation.elements
            .filter((e) => e.selector === selector || e.selector === neighbour)
            .map((e) => placement?.rect(e) ?? e.rect),
        );
        if (!rect) continue;
        if (
          await cropToFile({
            runDirectory,
            screenshotPath: screenshot,
            images: decoded,
            viewportWidth: tuple.width,
            scale: placement?.scale,
            rect,
            padding,
            relativePath: path,
          })
        ) {
          const absent = design
            ? drift.designSelector === null
            : drift.appSelector === null;
          crops.push({ label: absent ? `${side} (absent)` : side, path });
        }
      }
      result.push({
        ...finding,
        evidence: {
          ...finding.evidence,
          screenshots: [
            ...new Set([
              ...finding.evidence.screenshots,
              ...crops.map((crop) => crop.path),
            ]),
          ],
          designDrift: { ...drift, crops },
        },
      });
      continue;
    }
    const selectors = selectorsFor(finding);
    const measured = paramsRect(finding);
    const observations = tuple?.observations;
    if (
      tuple?.screenshotPath === undefined ||
      observations === undefined ||
      (selectors.length === 0 && measured === undefined)
    ) {
      result.push(finding);
      continue;
    }
    const placement = screenshotPlacement(observations);
    // A rect the check measured is the exact subject; selectors can resolve elsewhere.
    const rect =
      measured ??
      union(
        observations.elements
          .filter(
            (element) =>
              element.visible && selectors.includes(element.selector),
          )
          .map((element) => placement.rect(element)),
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
      viewport: {
        ...observations.viewport,
        documentWidth: observations.document.scrollWidth,
      },
      scale: placement.scale,
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
