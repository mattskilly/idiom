import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { measureBands, sampleMediaFrames } from "../src/capture/media-bands.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { classifyFrame, mediaFillCheck } from "../src/checks/media-fill.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ChecksConfig,
  CheckTuple,
  MediaBands,
  MediaFrameObservation,
  RGB,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

type Paint = (x: number, y: number) => RGB;

// Deterministic pseudo-random noise, so "photographs" never form solid rows.
function noise(x: number, y: number): RGB {
  const seed = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  const value = seed - Math.floor(seed);
  return {
    r: Math.floor(value * 255),
    g: Math.floor(((value * 7) % 1) * 255),
    b: Math.floor(((value * 13) % 1) * 255),
  };
}

function image(width: number, height: number, paint: Paint): PNG {
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
const black = { r: 0, g: 0, b: 0 };
const frame = { x: 0, y: 0, width: 200, height: 100 };

function measured(value: ReturnType<typeof measureBands>): MediaBands {
  if (value.status !== "measured") throw new Error(value.reason);
  return value;
}

describe("measureBands", () => {
  test("a white top band over a noisy hero", () => {
    const bands = measured(
      measureBands(
        image(200, 100, (x, y) => (y < 40 ? white : noise(x, y))),
        frame,
        1,
        8,
      ),
    );
    expect(bands.top?.depth).toBeCloseTo(0.4, 2);
    expect(bands.top?.color).toEqual(white);
    expect(bands).toMatchObject({
      bottom: null,
      left: null,
      right: null,
      blank: false,
    });
  });

  test("letterboxing produces both bands", () => {
    const bands = measured(
      measureBands(
        image(200, 100, (x, y) => (y < 15 || y >= 85 ? black : noise(x, y))),
        frame,
        1,
        8,
      ),
    );
    expect(bands.top?.depth).toBeCloseTo(0.15, 2);
    expect(bands.bottom?.depth).toBeCloseTo(0.15, 2);
  });

  test("noise has no bands and a flat colour is blank", () => {
    expect(measured(measureBands(image(200, 100, noise), frame, 1, 8))).toEqual(
      {
        status: "measured",
        top: null,
        bottom: null,
        left: null,
        right: null,
        blank: false,
      },
    );
    const flat = measured(
      measureBands(
        image(200, 100, () => white),
        frame,
        1,
        8,
      ),
    );
    expect(flat.blank).toBe(true);
    expect(flat.top?.depth).toBe(1);
  });

  test("a near-white gradient is solid only within tolerance", () => {
    // Rows step by 1 per 10 rows: a 40-row band spans 4 channel levels.
    const paint: Paint = (x, y) =>
      y < 40 ? { r: 255 - Math.floor(y / 10), g: 255, b: 255 } : noise(x, y);
    expect(
      measured(measureBands(image(200, 100, paint), frame, 1, 8)).top?.depth,
    ).toBeCloseTo(0.4, 2);
    expect(
      measured(measureBands(image(200, 100, paint), frame, 1, 0)).top?.depth,
    ).toBeLessThan(0.15);
    // Across a row: 98% must match the modal colour.
    const striped: Paint = (x, y) =>
      y < 40 ? (x % 10 === 0 ? black : white) : noise(x, y);
    expect(
      measured(measureBands(image(200, 100, striped), frame, 1, 8)).top,
    ).toBeNull();
  });

  test("frames are clamped to the screenshot, and outside it unavailable", () => {
    const png = image(200, 100, (x, y) => (y < 40 ? white : noise(x, y)));
    const clamped = measured(
      measureBands(png, { x: 100, y: 0, width: 200, height: 100 }, 1, 8),
    );
    expect(clamped.top?.depth).toBeCloseTo(0.4, 2);
    expect(
      measureBands(png, { x: 0, y: 300, width: 200, height: 100 }, 1, 8),
    ).toEqual({ status: "unavailable", reason: "frame outside screenshot" });
  });

  test("scale maps CSS px to image px (DPR 2)", () => {
    const png = image(400, 400, (x, y) =>
      y >= 200 && y < 240 ? white : noise(x, y),
    );
    // CSS frame 100..200 → image rows 200..400; the top 20% is white.
    const bands = measured(
      measureBands(png, { x: 0, y: 100, width: 200, height: 100 }, 2, 8),
    );
    expect(bands.top?.depth).toBeCloseTo(0.2, 2);
  });

  test("one hairline edge row does not interrupt a band", () => {
    const bands = measured(
      measureBands(
        image(200, 100, (x, y) =>
          y === 0 ? { r: 200, g: 200, b: 200 } : y < 40 ? white : noise(x, y),
        ),
        frame,
        1,
        8,
      ),
    );
    expect(bands.top?.depth).toBeCloseTo(0.4, 2);
  });

  test("a screenshot that cannot be decoded marks every frame unavailable", () => {
    const frames = sampleMediaFrames(
      [
        {
          selector: "#a",
          kind: "img",
          frame,
          group: "#g",
          backdrop: [white],
          loaded: true,
        },
      ],
      () => {
        throw new Error("bad png");
      },
      200,
      8,
    );
    expect(frames[0]?.bands).toEqual({
      status: "unavailable",
      reason: "screenshot could not be decoded",
    });
  });
});

function band(depth: number, color: RGB = white) {
  return { depth, color };
}
function bands(extra: Partial<MediaBands> = {}): MediaBands {
  return {
    status: "measured",
    top: null,
    bottom: null,
    left: null,
    right: null,
    blank: false,
    ...extra,
  };
}

describe("classifyFrame", () => {
  test("the threshold boundary is inclusive", () => {
    expect(classifyFrame(bands({ top: band(0.2) }), 0.2, 8)?.kind).toBe(
      "band:top",
    );
    expect(classifyFrame(bands({ top: band(0.19) }), 0.2, 8)).toBeUndefined();
  });

  test("letterboxing needs matching colours on opposite edges", () => {
    expect(
      classifyFrame(bands({ top: band(0.12), bottom: band(0.12) }), 0.2, 8)
        ?.kind,
    ).toBe("letterbox");
    expect(
      classifyFrame(
        bands({ top: band(0.12), bottom: band(0.12, black) }),
        0.2,
        8,
      ),
    ).toBeUndefined();
    expect(
      classifyFrame(bands({ left: band(0.1), right: band(0.1) }), 0.2, 8),
    ).toMatchObject({ kind: "letterbox", edges: ["left", "right"] });
  });

  test("only bands of the backdrop colour are gaps", () => {
    const grey = { r: 229, g: 231, b: 235 };
    // A screenshot with white margins on a grey card is the content, not a gap.
    expect(
      classifyFrame(bands({ top: band(0.15), bottom: band(0.15) }), 0.2, 8, [
        grey,
      ]),
    ).toBeUndefined();
    expect(
      classifyFrame(
        bands({ top: band(0.15, grey), bottom: band(0.15, grey) }),
        0.2,
        8,
        [white, grey],
      )?.kind,
    ).toBe("letterbox");
    // A solid brand-colour tile is not an empty frame.
    expect(
      classifyFrame(bands({ blank: true, top: band(1, black) }), 0.2, 8, [
        white,
      ]),
    ).toBeUndefined();
  });

  test("blank wins, and the deepest edge band is named", () => {
    expect(
      classifyFrame(bands({ blank: true, top: band(1) }), 0.2, 8)?.kind,
    ).toBe("blank");
    expect(
      classifyFrame(bands({ top: band(0.25), left: band(0.5) }), 0.2, 8)?.kind,
    ).toBe("band:left");
  });
});

function frameAt(
  index: number,
  value: Partial<MediaFrameObservation> = {},
): MediaFrameObservation {
  return {
    selector: `#t${index}`,
    kind: "iframe",
    frame: { x: index * 250, y: 0, width: 240, height: 150 },
    group: "#templates",
    backdrop: [white],
    loaded: true,
    bands: bands(),
    ...value,
  };
}
function tuple(extra: Record<string, unknown> | undefined): CheckTuple {
  return {
    flow: "f",
    state: "s",
    viewport: "desktop",
    width: 1280,
    height: 720,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "c",
    createdAt: "2026-10-24T00:00:00.000Z",
    observations: {
      version: 2,
      viewport: { width: 1280, height: 720 },
      document: {
        scrollWidth: 1280,
        scrollHeight: 720,
        clientWidth: 1280,
        clientHeight: 720,
      },
      elements: [],
      maskMembership: [],
      headings: [],
      tokens: { status: "not-configured" },
      ...extra,
    } as CheckTuple["observations"],
    axe: { violations: [] },
    console: [],
    mismatches: [],
  };
}
const config: ChecksConfig = checksConfigFrom();
function run(frames: MediaFrameObservation[], checks = config) {
  return mediaFillCheck.run({
    tuple: tuple({ mediaFrames: frames, mediaFill: { tolerance: 8 } }),
    narrowViewport: false,
    config: checks,
  });
}
const topBand = bands({ top: band(0.4) });

describe("mediaFillCheck", () => {
  test("a systematic defect is major; an isolated one is minor", () => {
    const all = run([0, 1, 2, 3].map((i) => frameAt(i, { bands: topBand })));
    expect(all.candidates).toHaveLength(1);
    expect(all.candidates[0]).toMatchObject({
      severity: "major",
      fingerprintHint: "media-fill:#templates:band:top",
      selectorHint: "#t0",
    });
    expect(all.candidates[0]?.explanation).toBe(
      "4 of 4 thumbnails in #templates show a solid #ffffff band 40% deep at the top: the image does not fill its frame.",
    );
    const one = run([
      frameAt(0, { bands: topBand }),
      frameAt(1),
      frameAt(2),
      frameAt(3),
    ]);
    expect(one.candidates[0]?.severity).toBe("minor");
    const two = run([
      frameAt(0, { bands: topBand }),
      frameAt(1, { bands: topBand }),
      frameAt(2),
      frameAt(3),
    ]);
    expect(two.candidates[0]?.severity).toBe("minor");
  });

  test("bandThreshold re-judges stored evidence without recapture", () => {
    const frames = [0, 1, 2].map((i) => frameAt(i, { bands: topBand }));
    expect(run(frames).candidates).toHaveLength(1);
    expect(
      run(frames, {
        ...config,
        mediaFill: { ...config.mediaFill, bandThreshold: 0.5 },
      }).candidates,
    ).toEqual([]);
  });

  test("unloaded and unmeasured frames become notes", () => {
    const result = run([
      frameAt(0, { loaded: false }),
      frameAt(1, { bands: { status: "unavailable", reason: "x" } }),
      frameAt(2, { bands: undefined }),
      frameAt(3),
      frameAt(4),
      frameAt(5),
    ]);
    expect(result.coverage).toEqual({
      check: "media-fill",
      status: "ran",
      reason:
        "3 frames in 1 galleries examined; 1 images not loaded at capture; 2 frames not measured in the screenshot",
    });
  });

  test("a gallery with fewer than three judged frames is not reported", () => {
    const result = run([
      frameAt(0, { bands: topBand }),
      frameAt(1, { bands: topBand }),
      frameAt(2, { loaded: false }),
    ]);
    expect(result.candidates).toEqual([]);
  });

  test("auto: false is skipped and an old capture is unavailable", () => {
    expect(
      run([], {
        ...config,
        mediaFill: { ...config.mediaFill, auto: false },
      }).coverage.status,
    ).toBe("skipped");
    expect(
      mediaFillCheck.run({
        tuple: tuple(undefined),
        narrowViewport: false,
        config,
      }).coverage,
    ).toEqual({
      check: "media-fill",
      status: "unavailable",
      reason: "observations predate media frame sampling (recapture)",
    });
  });

  test("evidence round-trips through the strict artifact schema", () => {
    const observations = tuple({
      mediaFrames: [frameAt(0, { bands: topBand }), frameAt(1)],
      mediaFill: { tolerance: 8 },
    }).observations;
    expect(observationArtifactSchema.safeParse(observations).success).toBe(
      true,
    );
    expect(
      observationArtifactSchema.safeParse(tuple({}).observations).success,
    ).toBe(true);
    expect(
      observationArtifactSchema.safeParse(
        tuple({ mediaFrames: [{ ...frameAt(0), extra: true }] }).observations,
      ).success,
    ).toBe(false);
  });
});

describe("checks.mediaFill config", () => {
  test("defaults, bounds and threading", () => {
    expect(checksConfigSchema.parse({}).mediaFill).toEqual({
      auto: true,
      bandThreshold: 0.2,
      tolerance: 8,
      ignore: [],
    });
    expect(
      checksConfigFrom(
        checksConfigSchema.parse({
          mediaFill: { bandThreshold: 0.3, ignore: [".hero"] },
        }),
      ).mediaFill,
    ).toEqual({
      auto: true,
      bandThreshold: 0.3,
      tolerance: 8,
      ignore: [".hero"],
    });
    for (const mediaFill of [
      { bandThreshold: 0 },
      { bandThreshold: 1 },
      { tolerance: 65 },
      { tolerance: 1.5 },
      { ignore: [""] },
      { unknown: true },
    ])
      expect(checksConfigSchema.safeParse({ mediaFill }).success).toBe(false);
  });
});
