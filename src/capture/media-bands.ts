import type { PNG } from "pngjs";
import type {
  MediaBand,
  MediaBands,
  MediaFrameObservation,
  Rect,
  RGB,
} from "../checks/types.js";

/** Samples per row (or column); enough to see content, cheap per frame. */
const maxSamples = 64;
/** A row is solid when this share of its samples matches its modal colour. */
const solidShare = 0.98;

type Unavailable = { status: "unavailable"; reason: string };

function channelDistance(a: RGB, b: RGB): number {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
  );
}

/** Evenly spaced positions in [start, end), inset so rounded corners and borders do not count. */
function positions(start: number, end: number): number[] {
  const length = end - start;
  const inset = Math.min(
    Math.floor(length / 4),
    Math.max(1, Math.round(length * 0.03)),
  );
  const from = start + inset;
  const span = end - inset - from;
  if (span <= 0) return [start];
  const count = Math.min(maxSamples, span);
  return Array.from({ length: count }, (_, index) =>
    Math.min(end - 1, from + Math.floor(((index + 0.5) * span) / count)),
  );
}

/**
 * Measure solid bands at each edge of a CSS-px frame in a decoded screenshot.
 * `scale` maps CSS px to image px (image width / viewport width). Raw depths
 * are returned; the check applies the threshold so stored evidence re-judges
 * offline.
 */
export function measureBands(
  image: PNG,
  frame: Rect,
  scale: number,
  tolerance: number,
): MediaBands | Unavailable {
  // Round inward: a fractional edge pixel blends in the neighbouring border.
  const x0 = Math.max(0, Math.ceil(frame.x * scale));
  const y0 = Math.max(0, Math.ceil(frame.y * scale));
  const x1 = Math.min(image.width, Math.floor((frame.x + frame.width) * scale));
  const y1 = Math.min(
    image.height,
    Math.floor((frame.y + frame.height) * scale),
  );
  if (x1 - x0 < 2 || y1 - y0 < 2)
    return { status: "unavailable", reason: "frame outside screenshot" };
  const pixel = (x: number, y: number): RGB => {
    const offset = (y * image.width + x) * 4;
    return {
      r: image.data[offset] ?? 0,
      g: image.data[offset + 1] ?? 0,
      b: image.data[offset + 2] ?? 0,
    };
  };
  /** The modal colour of a line, or undefined when the line is not solid. */
  const solid = (samples: RGB[]): RGB | undefined => {
    const counts = new Map<number, { color: RGB; count: number }>();
    for (const color of samples) {
      const key = (color.r << 16) | (color.g << 8) | color.b;
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { color, count: 1 });
    }
    let modal: RGB | undefined;
    let best = 0;
    for (const { color, count } of counts.values())
      if (count > best) {
        best = count;
        modal = color;
      }
    if (modal === undefined) return undefined;
    const near = samples.filter(
      (color) => channelDistance(color, modal as RGB) <= tolerance,
    ).length;
    return near / samples.length >= solidShare ? modal : undefined;
  };
  const columns = positions(x0, x1);
  const rows = positions(y0, y1);
  const row = (y: number) => solid(columns.map((x) => pixel(x, y)));
  const column = (x: number) => solid(rows.map((y) => pixel(x, y)));
  const run = (
    line: (index: number) => RGB | undefined,
    from: number,
    to: number,
  ): MediaBand | null => {
    const step = from < to ? 1 : -1;
    const length = Math.abs(to - from);
    // One hairline or antialiased edge line does not interrupt a band.
    const second = from + step;
    let start = from;
    let edge = line(from);
    if (length > 2) {
      const next = line(second);
      if (
        next !== undefined &&
        (edge === undefined || channelDistance(edge, next) > tolerance)
      ) {
        start = second;
        edge = next;
      }
    }
    if (edge === undefined) return null;
    let count = Math.abs(start - from);
    for (let index = start; index !== to; index += step) {
      const color = line(index);
      if (color === undefined || channelDistance(color, edge) > tolerance)
        break;
      count += 1;
    }
    if (count <= Math.abs(start - from)) return null;
    return { depth: Math.round((count / length) * 10000) / 10000, color: edge };
  };
  const top = run(row, y0, y1);
  const bottom = run(row, y1 - 1, y0 - 1);
  const left = run(column, x0, x1);
  const right = run(column, x1 - 1, x0 - 1);
  return {
    status: "measured",
    top,
    bottom,
    left,
    right,
    blank: (top?.depth ?? 0) >= 0.98,
  };
}

/** Attach band measurements to every frame, from one decode of the screenshot. */
export function sampleMediaFrames(
  frames: MediaFrameObservation[],
  decode: () => PNG,
  viewportWidth: number,
  tolerance: number,
): MediaFrameObservation[] {
  let image: PNG;
  try {
    image = decode();
  } catch {
    return frames.map((frame) => ({
      ...frame,
      bands: {
        status: "unavailable",
        reason: "screenshot could not be decoded",
      },
    }));
  }
  const scale = image.width / viewportWidth;
  return frames.map((frame) => ({
    ...frame,
    bands: measureBands(image, frame.frame, scale, tolerance),
  }));
}
