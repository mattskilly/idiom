import { PNG } from "pngjs";
import { expect, test } from "vitest";
import {
  measureInk,
  sampleOrphanInk,
  screenshotScale,
} from "../src/capture/media-bands.js";
import type { OrphanWordObservation, RGB } from "../src/checks/types.js";

function image(
  width: number,
  height: number,
  paint: (x: number, y: number) => RGB,
): PNG {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const { r, g, b } = paint(x, y);
      const offset = (y * width + x) * 4;
      png.data[offset] = r;
      png.data[offset + 1] = g;
      png.data[offset + 2] = b;
      png.data[offset + 3] = 255;
    }
  return png;
}

const white = { r: 255, g: 255, b: 255 };
const ink = { r: 20, g: 20, b: 20 };
const solid = image(200, 100, () => white);
// Vertical 2px strokes every 8px inside x 40–120, y 20–60, like glyph stems.
const strokes = image(200, 100, (x, y) =>
  x >= 40 && x < 120 && y >= 20 && y < 60 && x % 8 < 2 ? ink : white,
);
const word = { x: 40, y: 20, width: 80, height: 40 };

test("a solid background has no ink", () => {
  expect(measureInk(solid, word, 1, 8)).toEqual({
    status: "measured",
    share: 0,
  });
});

test("glyph-like strokes leave ink above the threshold", () => {
  const result = measureInk(strokes, word, 1, 8);
  expect(result.status).toBe("measured");
  if (result.status === "measured") expect(result.share).toBeGreaterThan(0.02);
  // CSS px scale onto image px: a half-size rect at scale 2 is the same box.
  expect(
    measureInk(strokes, { x: 20, y: 10, width: 40, height: 20 }, 2, 8),
  ).toEqual(result);
});

test("a rect outside the screenshot is unavailable", () => {
  expect(
    measureInk(solid, { x: 0, y: 200, width: 50, height: 20 }, 1, 8),
  ).toEqual({ status: "unavailable", reason: "rect outside screenshot" });
});

const record = (lastLine?: OrphanWordObservation["lastLine"]) => ({
  selector: "h1",
  word: "now",
  lines: 2,
  text: "Plan a now",
  ...(lastLine === undefined ? {} : { lastLine }),
});

test("sampling leaves legacy records alone and marks undecodable screenshots unavailable", () => {
  const legacy = record();
  expect(
    sampleOrphanInk(
      [legacy],
      () => {
        throw new Error("never decoded");
      },
      { width: 200, height: 100 },
      200,
      8,
    ),
  ).toEqual([legacy]);
  expect(
    sampleOrphanInk(
      [record(word), legacy],
      () => {
        throw new Error("bad png");
      },
      { width: 200, height: 100 },
      200,
      8,
    ),
  ).toEqual([
    {
      ...record(word),
      ink: { status: "unavailable", reason: "screenshot could not be decoded" },
    },
    legacy,
  ]);
  expect(
    sampleOrphanInk(
      [record(word)],
      () => strokes,
      { width: 200, height: 100 },
      200,
      8,
    )[0]?.ink,
  ).toEqual(measureInk(strokes, word, 1, 8));
});

test("a full-page screenshot of a horizontally overflowing page scales by its document width", () => {
  const viewport = { width: 390, height: 844 };
  // 519 CSS px of document at 2x: not 1038 / 390.
  expect(screenshotScale({ width: 1038, height: 67050 }, viewport, 519)).toBe(
    2,
  );
  // A viewport-only screenshot of the same page is the viewport at 2.66x.
  expect(
    screenshotScale({ width: 1038, height: (844 * 1038) / 390 }, viewport, 519),
  ).toBeCloseTo(1038 / 390);
  expect(screenshotScale({ width: 780, height: 62672 }, viewport, 390)).toBe(2);
});
