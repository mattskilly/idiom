import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { IdiomError } from "../errors.js";

/** Below this similarity a screenshot matches no stored capture. */
export const MATCH_THRESHOLD = 0.6;
/** How far the best match must beat a different state to be trusted. */
export const CONFIDENT_MARGIN = 0.05;
/** At or above this similarity (and clear of the runner-up) is high confidence. */
export const HIGH_CONFIDENCE = 0.9;

const THUMBNAIL_WIDTH = 64;
/**
 * How much more saturated a cell of the human's screenshot may be than the
 * capture's before it reads as an annotation stroke and is left out.
 */
const ANNOTATION_CHROMA = 0.08;

export type Thumbnail = {
  width: number;
  height: number;
  luma: Float64Array;
  /** Mean saturation per cell, 0–1: where an annotation's coloured strokes are. */
  chroma: Float64Array;
};
export type Confidence = "high" | "medium" | "low";

/**
 * A fixed-width greyscale thumbnail of a decoded PNG: composited over white,
 * converted to luma, and area-averaged so the height stays in proportion. A
 * viewport screenshot and a full-page capture of the same page share a width
 * and line up row for row.
 */
export function thumbnail(png: {
  width: number;
  height: number;
  data: Uint8Array;
}): Thumbnail {
  const width = THUMBNAIL_WIDTH;
  const height = Math.max(
    1,
    Math.round((png.height * width) / Math.max(1, png.width)),
  );
  const lumaSums = new Float64Array(width * height);
  const chromaSums = new Float64Array(width * height);
  const counts = new Float64Array(width * height);
  const columns = new Int32Array(png.width);
  for (let x = 0; x < png.width; x += 1)
    columns[x] = Math.min(width - 1, Math.floor((x * width) / png.width));
  for (let y = 0; y < png.height; y += 1) {
    const base =
      Math.min(height - 1, Math.floor((y * height) / png.height)) * width;
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const alpha = (png.data[offset + 3] ?? 255) / 255;
      const over = (channel: number) =>
        (png.data[offset + channel] ?? 0) * alpha + 255 * (1 - alpha);
      const red = over(0);
      const green = over(1);
      const blue = over(2);
      const cell = base + (columns[x] ?? 0);
      lumaSums[cell] =
        (lumaSums[cell] ?? 0) + 0.299 * red + 0.587 * green + 0.114 * blue;
      chromaSums[cell] =
        (chromaSums[cell] ?? 0) +
        (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }
  const luma = new Float64Array(width * height);
  const chroma = new Float64Array(width * height);
  for (let cell = 0; cell < luma.length; cell += 1) {
    const count = counts[cell] ?? 0;
    luma[cell] = count === 0 ? 255 : (lumaSums[cell] ?? 0) / count;
    chroma[cell] = count === 0 ? 0 : (chromaSums[cell] ?? 0) / count;
  }
  return { width, height, luma, chroma };
}

/** Decode PNG bytes; `undefined` when they are not a readable PNG. */
export function decodePng(bytes: Buffer): Thumbnail | undefined {
  try {
    return thumbnail(PNG.sync.read(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Pearson correlation of the luma of `rows` rows of `a` from `aRow` and of
 * `b` from `bRow`, leaving out cells where `a` is markedly more saturated than
 * `b`: an annotation drawn on the human's screenshot. Flat regions carry no
 * layout, so they match only when both whole images are flat and the same
 * tone; a blank band of two pages that differ elsewhere is no match.
 */
function correlation(
  a: Thumbnail,
  aRow: number,
  b: Thumbnail,
  bRow: number,
  rows: number,
): number {
  const length = rows * a.width;
  const aStart = aRow * a.width;
  const bStart = bRow * b.width;
  const keep = new Uint8Array(length);
  let count = 0;
  let sumA = 0;
  let sumB = 0;
  for (let index = 0; index < length; index += 1) {
    const annotated =
      (a.chroma[aStart + index] ?? 0) - (b.chroma[bStart + index] ?? 0) >
      ANNOTATION_CHROMA;
    if (annotated) continue;
    keep[index] = 1;
    sumA += a.luma[aStart + index] ?? 0;
    sumB += b.luma[bStart + index] ?? 0;
    count += 1;
  }
  // Mostly annotation: nothing left to compare.
  if (count < length / 2) return 0;
  const meanA = sumA / count;
  const meanB = sumB / count;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  let difference = 0;
  for (let index = 0; index < length; index += 1) {
    if (keep[index] === 0) continue;
    const valueA = a.luma[aStart + index] ?? 0;
    const valueB = b.luma[bStart + index] ?? 0;
    covariance += (valueA - meanA) * (valueB - meanB);
    varianceA += (valueA - meanA) ** 2;
    varianceB += (valueB - meanB) ** 2;
    difference += Math.abs(valueA - valueB);
  }
  const flatA = varianceA / count < 1e-6;
  const flatB = varianceB / count < 1e-6;
  if (flatA || flatB) {
    const whole = rows === a.height && rows === b.height;
    return whole && flatA && flatB && difference / count < 8 ? 1 : 0;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}

/**
 * How alike the human's screenshot `a` and a stored capture `b` are, 0–1: the
 * Pearson correlation of their luma over the best vertical overlap. The
 * shorter slides down the taller one row by row, so a viewport screenshot is
 * found inside a full-page capture and the other way round; the overlap is at
 * least half the shorter image. Correlation follows layout, so two unrelated
 * mostly-white pages do not score alike; cells `a` has coloured in that `b`
 * has not (annotation strokes) are left out.
 */
export function similarity(a: Thumbnail, b: Thumbnail): number {
  if (a.width !== b.width) return 0;
  const shorter = Math.min(a.height, b.height);
  const minimum = Math.max(1, Math.ceil(shorter / 2));
  let best = 0;
  // offset = the row of `b` that `a`'s first row lines up with.
  for (
    let offset = minimum - a.height;
    offset <= b.height - minimum;
    offset += 1
  ) {
    const aRow = Math.max(0, -offset);
    const bRow = Math.max(0, offset);
    const rows = Math.min(a.height - aRow, b.height - bRow);
    if (rows < minimum) continue;
    best = Math.max(best, correlation(a, aRow, b, bRow, rows));
  }
  return Math.min(1, Math.max(0, best));
}

export type MatchCandidate = {
  /** Candidates of one flow state share a key; the runner-up is another key. */
  key: string;
  screenshotPath: string;
};

export type ScoredCandidate<C extends MatchCandidate> = {
  candidate: C;
  similarity: number;
};

export type ScreenshotMatch<C extends MatchCandidate> = {
  /** Every decodable candidate, most similar first. */
  ranked: ScoredCandidate<C>[];
  /** The most similar candidate, when it clears `MATCH_THRESHOLD`. */
  best?: (ScoredCandidate<C> & { confidence: Confidence }) | undefined;
  /** The most similar candidate of a different flow state than the top one. */
  runnerUp?: ScoredCandidate<C> | undefined;
};

export function confidenceFor(
  score: number,
  runnerUp: number | undefined,
): Confidence {
  const clear = runnerUp === undefined || score - runnerUp >= CONFIDENT_MARGIN;
  if (!clear) return "low";
  return score >= HIGH_CONFIDENCE ? "high" : "medium";
}

/**
 * Rank stored captures by how alike they are to the human's screenshot.
 * Candidates whose PNG cannot be decoded are skipped.
 */
export async function matchScreenshot<C extends MatchCandidate>(options: {
  screenshot: Buffer;
  /** For error messages: where the screenshot came from. */
  label?: string | undefined;
  candidates: readonly C[];
}): Promise<ScreenshotMatch<C>> {
  const target = decodePng(options.screenshot);
  if (target === undefined)
    throw new IdiomError(
      `--screenshot ${options.label ?? "image"} is not a readable PNG`,
    );
  const ranked: ScoredCandidate<C>[] = [];
  for (const candidate of options.candidates) {
    let bytes: Buffer;
    try {
      bytes = await readFile(candidate.screenshotPath);
    } catch {
      continue;
    }
    const decoded = decodePng(bytes);
    if (decoded === undefined) continue;
    ranked.push({ candidate, similarity: similarity(target, decoded) });
  }
  ranked.sort((a, b) => b.similarity - a.similarity);
  const top = ranked[0];
  const runnerUp =
    top === undefined
      ? undefined
      : ranked.find((scored) => scored.candidate.key !== top.candidate.key);
  return {
    ranked,
    ...(runnerUp === undefined ? {} : { runnerUp }),
    ...(top !== undefined && top.similarity >= MATCH_THRESHOLD
      ? {
          best: {
            ...top,
            confidence: confidenceFor(top.similarity, runnerUp?.similarity),
          },
        }
      : {}),
  };
}
