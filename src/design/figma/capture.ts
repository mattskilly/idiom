import { relative, sep } from "node:path";
import { PNG } from "pngjs";
import type { SelectedViewport, TupleCapture } from "../../capture/types.js";
import type { CapturedDesign } from "../types.js";
import {
  FIGMA_RENDER_SCALE,
  type FigmaFrame,
  fetchFigmaFrame,
} from "./cache.js";
import type { FigmaDependencies } from "./client.js";
import { figmaObservation } from "./normalize.js";
import { parseFigmaUrl } from "./url.js";

export type FigmaCaptureOptions = {
  projectDirectory: string;
  refresh?: boolean | undefined;
  deps?: FigmaDependencies | undefined;
};

/** One fetch (or cache read) per frame per run, shared by viewport selection and capture. */
export function figmaFrameLoader(options: FigmaCaptureOptions) {
  const frames = new Map<string, Promise<FigmaFrame>>();
  return (source: string): Promise<FigmaFrame> => {
    let frame = frames.get(source);
    if (!frame) {
      const ref = parseFigmaUrl(source);
      frame = ref
        ? fetchFigmaFrame(ref, {
            projectDirectory: options.projectDirectory,
            refresh: options.refresh,
            deps: options.deps,
          })
        : Promise.reject(new Error(`${source} is not a Figma frame URL`));
      // Settle once so a rejection is observed by every awaiting tuple.
      frame.catch(() => undefined);
      frames.set(source, frame);
    }
    return frame;
  };
}

export function frameWidth(frame: FigmaFrame): number {
  return frame.document.absoluteBoundingBox?.width ?? 0;
}

/**
 * Lay the 2x render top-left on a viewport-wide canvas so crop rectangles in
 * CSS pixels land where they do on the app screenshot.
 */
function composite(
  png: Buffer,
  viewport: SelectedViewport,
  frameHeight: number,
): Buffer {
  const source = PNG.sync.read(png);
  const width = Math.round(viewport.width * FIGMA_RENDER_SCALE),
    height = Math.round(
      Math.max(frameHeight, viewport.height) * FIGMA_RENDER_SCALE,
    );
  const canvas = new PNG({ width, height });
  canvas.data.fill(255);
  PNG.bitblt(
    source,
    canvas,
    0,
    0,
    Math.min(source.width, width),
    Math.min(source.height, height),
    0,
    0,
  );
  return PNG.sync.write(canvas);
}

export async function captureFigmaDesign(options: {
  source: string;
  name?: string | undefined;
  frame: Promise<FigmaFrame>;
  projectDirectory: string;
  viewport: SelectedViewport;
}): Promise<CapturedDesign> {
  const base = {
    source: options.source,
    ...(options.name === undefined ? {} : { name: options.name }),
    runtimeVersion: "figma-rest-v1",
  };
  try {
    const frame = await options.frame;
    const box = frame.document.absoluteBoundingBox;
    const observations = figmaObservation(frame.document, {
      viewport: {
        width: options.viewport.width,
        height: options.viewport.height,
      },
      fileKey: frame.meta.fileKey,
      variables: frame.variables,
    });
    const now = new Date().toISOString();
    const result: TupleCapture = {
      ok: true,
      status: null,
      dom: "",
      screenshot: composite(frame.png, options.viewport, box?.height ?? 0),
      console: [],
      axe: undefined,
      observations,
      mismatches: [],
      startedAt: now,
      endedAt: now,
    };
    return {
      ...base,
      resolved: {
        kind: "figma",
        requested: options.source,
        final: frame.meta.link,
      },
      figma: {
        fileKey: frame.meta.fileKey,
        nodeId: frame.meta.nodeId,
        version: frame.meta.version,
        ...(frame.meta.lastModified === undefined
          ? {}
          : { lastModified: frame.meta.lastModified }),
        frame: { width: box?.width ?? 1, height: box?.height ?? 1 },
        variables: frame.meta.variables,
        link: frame.meta.link,
        cache:
          relative(options.projectDirectory, frame.cacheDirectory)
            .split(sep)
            .join("/") || ".",
      },
      figmaDocument: frame.document,
      result,
    };
  } catch (error) {
    return {
      ...base,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}
