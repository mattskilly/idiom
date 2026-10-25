import { readFile, writeFile } from "node:fs/promises";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { IdiomError } from "../errors.js";

const BACKGROUND = 245;
const HEADER = 24;
const GAP = 8;
const GLYPHS: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "/": ["00000", "00001", "00010", "00100", "01000", "10000", "00000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
};

function decode(source: Buffer, label: string): PNG {
  try {
    return PNG.sync.read(source);
  } catch (error) {
    throw new IdiomError(
      `cannot decode ${label} PNG: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function neutral(width: number, height: number): PNG {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = BACKGROUND;
    image.data[offset + 1] = BACKGROUND;
    image.data[offset + 2] = BACKGROUND;
    image.data[offset + 3] = 255;
  }
  return image;
}

function copy(source: PNG, target: PNG, x: number, y: number): void {
  PNG.bitblt(source, target, 0, 0, source.width, source.height, x, y);
}

function drawLabel(
  image: PNG,
  label: string,
  startX: number,
  panelWidth: number,
  top = 0,
): void {
  let x = startX + 8;
  // Unknown characters (and spaces) advance without drawing.
  for (const character of label.toUpperCase()) {
    const glyph = GLYPHS[character];
    if (glyph === undefined) {
      x += 12;
      continue;
    }
    for (const [row, values] of glyph.entries()) {
      for (const [column, value] of [...values].entries()) {
        if (value !== "1") continue;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const pixelX = x + column * 2 + dx;
            if (pixelX >= startX + panelWidth) continue;
            const offset =
              ((top + 6 + row * 2 + dy) * image.width + pixelX) * 4;
            image.data[offset] = 36;
            image.data[offset + 1] = 36;
            image.data[offset + 2] = 36;
            image.data[offset + 3] = 255;
          }
        }
      }
    }
    x += 12;
  }
}

export type ImageComparison = {
  before: { width: number; height: number };
  after: { width: number; height: number };
  padded: { width: number; height: number };
  differentPixels: number;
};

export type ImageDiff = ImageComparison & {
  beforeCanvas: PNG;
  afterCanvas: PNG;
};

/** Pads both images to a shared neutral canvas and counts differing pixels. */
export function diffImages(
  beforeSource: Buffer,
  afterSource: Buffer,
): ImageDiff {
  const before = decode(beforeSource, "before");
  const after = decode(afterSource, "after");
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const beforeCanvas = neutral(width, height);
  const afterCanvas = neutral(width, height);
  copy(before, beforeCanvas, 0, 0);
  copy(after, afterCanvas, 0, 0);
  const diff = neutral(width, height);
  const differentPixels = pixelmatch(
    beforeCanvas.data,
    afterCanvas.data,
    diff.data,
    width,
    height,
    { threshold: 0.1 },
  );
  return {
    before: { width: before.width, height: before.height },
    after: { width: after.width, height: after.height },
    padded: { width, height },
    differentPixels,
    beforeCanvas,
    afterCanvas,
  };
}

export type CompositeLabels = {
  /** Drawn in an extra header band above the panel labels. */
  title?: string | undefined;
  before?: string | undefined;
  after?: string | undefined;
};

export async function writeBeforeAfterComposite(options: {
  beforePath: string;
  afterPath: string;
  outputPath: string;
  beforeSource?: Buffer | undefined;
  afterSource?: Buffer | undefined;
  labels?: CompositeLabels | undefined;
}): Promise<ImageComparison> {
  const { beforeCanvas, afterCanvas, ...comparison } = diffImages(
    options.beforeSource ?? (await readFile(options.beforePath)),
    options.afterSource ?? (await readFile(options.afterPath)),
  );
  const { width, height } = comparison.padded;
  const title = options.labels?.title;
  const top = title === undefined ? 0 : HEADER;
  const composite = neutral(width * 2 + GAP, height + HEADER + top);
  if (title !== undefined) drawLabel(composite, title, 0, width * 2 + GAP);
  drawLabel(composite, options.labels?.before ?? "BEFORE", 0, width, top);
  drawLabel(
    composite,
    options.labels?.after ?? "AFTER",
    width + GAP,
    width,
    top,
  );
  copy(beforeCanvas, composite, 0, HEADER + top);
  copy(afterCanvas, composite, width + GAP, HEADER + top);
  await writeFile(options.outputPath, PNG.sync.write(composite));
  return comparison;
}
