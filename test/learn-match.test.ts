import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, test } from "vitest";
import { IdiomError } from "../src/errors.js";
import {
  CONFIDENT_MARGIN,
  confidenceFor,
  decodePng,
  MATCH_THRESHOLD,
  matchScreenshot,
  similarity,
} from "../src/learn/match.js";

type Box = { x: number; y: number; w: number; h: number; rgb: number[] };

/** A white page of `width`×`height` with filled boxes, as PNG bytes. */
function page(width: number, height: number, boxes: Box[]): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (const box of boxes)
    for (let y = box.y; y < Math.min(height, box.y + box.h); y += 1)
      for (let x = box.x; x < Math.min(width, box.x + box.w); x += 1) {
        const offset = (y * width + x) * 4;
        png.data[offset] = box.rgb[0] ?? 0;
        png.data[offset + 1] = box.rgb[1] ?? 0;
        png.data[offset + 2] = box.rgb[2] ?? 0;
      }
  return PNG.sync.write(png);
}

const dark = [34, 34, 34];
const grey = [220, 220, 220];
const mid = [120, 120, 120];

/** An editor: top bar, left rail, a canvas with rows of controls. */
const editorBoxes: Box[] = [
  { x: 0, y: 0, w: 1440, h: 64, rgb: dark },
  { x: 0, y: 64, w: 240, h: 836, rgb: grey },
  ...Array.from({ length: 8 }, (_, row) => ({
    x: 300,
    y: 120 + row * 90,
    w: 700,
    h: 40,
    rgb: mid,
  })),
];
/** A settings page: a centred column of cards and no rail. */
const settingsBoxes: Box[] = [
  { x: 0, y: 840, w: 1440, h: 60, rgb: dark },
  ...Array.from({ length: 3 }, (_, row) => ({
    x: 420,
    y: 80 + row * 240,
    w: 600,
    h: 180,
    rgb: grey,
  })),
  { x: 1240, y: 40, w: 120, h: 40, rgb: mid },
];

function thumb(bytes: Buffer) {
  const decoded = decodePng(bytes);
  if (decoded === undefined) throw new Error("undecodable");
  return decoded;
}

/** A red annotation stroke (outline only) around about 5% of the image. */
function annotate(bytes: Buffer): Buffer {
  const png = PNG.sync.read(bytes);
  const [x0, x1] = [Math.floor(png.width * 0.3), Math.floor(png.width * 0.52)];
  const [y0, y1] = [
    Math.floor(png.height * 0.3),
    Math.floor(png.height * 0.52),
  ];
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      if (x - x0 >= 6 && x1 - x > 6 && y - y0 >= 6 && y1 - y > 6) continue;
      const offset = (y * png.width + x) * 4;
      png.data[offset] = 255;
      png.data[offset + 1] = 0;
      png.data[offset + 2] = 0;
      png.data[offset + 3] = 255;
    }
  return PNG.sync.write(png);
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

test("an identical image scores about 1, and an annotated copy stays at least 0.9", () => {
  const editor = page(1440, 900, editorBoxes);
  expect(similarity(thumb(editor), thumb(editor))).toBeCloseTo(1, 5);
  expect(similarity(thumb(annotate(editor)), thumb(editor))).toBeGreaterThan(
    0.9,
  );
  // The human's screenshot at another device scale lines up all the same.
  const retina = page(
    2880,
    1800,
    editorBoxes.map((box) => ({
      ...box,
      x: box.x * 2,
      y: box.y * 2,
      w: box.w * 2,
      h: box.h * 2,
    })),
  );
  expect(similarity(thumb(retina), thumb(editor))).toBeGreaterThan(0.95);
});

test("a viewport screenshot is found inside a full-page capture, and the other way round", () => {
  const tallBoxes: Box[] = [
    ...editorBoxes,
    ...Array.from({ length: 12 }, (_, row) => ({
      x: 300,
      y: 900 + row * 150,
      w: 900,
      h: 80,
      rgb: row % 2 === 0 ? grey : mid,
    })),
  ];
  const full = page(1440, 2700, tallBoxes);
  const viewport = page(1440, 900, editorBoxes);
  expect(similarity(thumb(viewport), thumb(full))).toBeGreaterThanOrEqual(0.99);
  expect(similarity(thumb(full), thumb(viewport))).toBeGreaterThanOrEqual(
    MATCH_THRESHOLD,
  );
});

test("clearly different layouts score below the threshold, mostly white or not", () => {
  const editor = page(1440, 900, editorBoxes);
  const settings = page(1440, 900, settingsBoxes);
  expect(similarity(thumb(settings), thumb(editor))).toBeLessThan(
    MATCH_THRESHOLD,
  );
  // Two sparse white pages are not alike just for being white.
  const sparseA = page(1440, 900, [{ x: 40, y: 40, w: 200, h: 30, rgb: dark }]);
  const sparseB = page(1440, 900, [
    { x: 1100, y: 700, w: 200, h: 30, rgb: dark },
  ]);
  expect(similarity(thumb(sparseA), thumb(sparseB))).toBeLessThan(
    MATCH_THRESHOLD,
  );
  // Blank pages of the same tone match; blank against content does not.
  const blank = page(1440, 900, []);
  expect(similarity(thumb(blank), thumb(blank))).toBe(1);
  expect(similarity(thumb(blank), thumb(editor))).toBe(0);
});

test("confidence: high when clear and close, medium when clear, low in a near tie", () => {
  expect(confidenceFor(0.97, 0.7)).toBe("high");
  expect(confidenceFor(0.75, 0.5)).toBe("medium");
  expect(confidenceFor(0.97, 0.97 - CONFIDENT_MARGIN / 2)).toBe("low");
  expect(confidenceFor(0.97, undefined)).toBe("high");
});

test("matchScreenshot ranks candidates, names a runner-up of another state, and skips undecodable ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-match-"));
  directories.push(directory);
  const write = async (name: string, bytes: Buffer) => {
    const path = join(directory, name);
    await writeFile(path, bytes);
    return path;
  };
  const editor = page(1440, 900, editorBoxes);
  const candidates = [
    { key: "studio/editor", screenshotPath: await write("e.png", editor) },
    {
      key: "studio/settings",
      screenshotPath: await write("s.png", page(1440, 900, settingsBoxes)),
    },
    {
      key: "studio/broken",
      screenshotPath: await write("b.png", Buffer.from("not a png")),
    },
    { key: "studio/gone", screenshotPath: join(directory, "missing.png") },
  ];
  const match = await matchScreenshot({
    screenshot: annotate(editor),
    candidates,
  });
  expect(match.ranked.map((scored) => scored.candidate.key)).toEqual([
    "studio/editor",
    "studio/settings",
  ]);
  expect(match.best).toMatchObject({
    candidate: { key: "studio/editor" },
    confidence: "high",
  });
  expect(match.runnerUp?.candidate.key).toBe("studio/settings");

  // The same capture under two states is a near tie: low confidence.
  const tie = await matchScreenshot({
    screenshot: editor,
    candidates: [
      candidates[0] as (typeof candidates)[number],
      {
        key: "studio/editor-copy",
        screenshotPath: await write("c.png", editor),
      },
    ],
  });
  expect(tie.best?.confidence).toBe("low");

  // Nothing above the threshold: no best, but the nearest is still ranked.
  const none = await matchScreenshot({
    screenshot: page(1440, 900, settingsBoxes),
    candidates: [candidates[0] as (typeof candidates)[number]],
  });
  expect(none.best).toBeUndefined();
  expect(none.ranked).toHaveLength(1);

  await expect(
    matchScreenshot({
      screenshot: Buffer.from("nope"),
      label: "shot.png",
      candidates,
    }),
  ).rejects.toThrow(
    new IdiomError("--screenshot shot.png is not a readable PNG"),
  );
});
