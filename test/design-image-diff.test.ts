import { PNG } from "pngjs";
import { expect, test } from "vitest";
import type {
  ObservationArtifactV2,
  ObservedElementV2,
  Rect,
} from "../src/checks/types.js";
import { compareDesignImage, MAX_REGIONS } from "../src/design/image-diff.js";

type Fill = { rect: Rect; color: [number, number, number]; radius?: number };
/** A white page of CSS size width×height at `scale`, with filled boxes. */
function paint(width: number, height: number, fills: Fill[], scale = 1): PNG {
  const png = new PNG({ width: width * scale, height: height * scale });
  png.data.fill(255);
  for (const { rect, color, radius = 0 } of fills)
    for (let y = rect.y * scale; y < (rect.y + rect.height) * scale; y++)
      for (let x = rect.x * scale; x < (rect.x + rect.width) * scale; x++) {
        const cx = x / scale + 0.5 / scale,
          cy = y / scale + 0.5 / scale;
        const dx = Math.max(
            rect.x + radius - cx,
            cx - (rect.x + rect.width - radius),
            0,
          ),
          dy = Math.max(
            rect.y + radius - cy,
            cy - (rect.y + rect.height - radius),
            0,
          );
        if (radius && dx > 0 && dy > 0 && dx * dx + dy * dy > radius * radius)
          continue;
        const at = (y * png.width + x) * 4;
        png.data[at] = color[0];
        png.data[at + 1] = color[1];
        png.data[at + 2] = color[2];
        png.data[at + 3] = 255;
      }
  return png;
}
const card: Fill = {
  rect: { x: 40, y: 40, width: 200, height: 120 },
  color: [30, 60, 160],
};
const block: Fill = {
  rect: { x: 40, y: 200, width: 300, height: 60 },
  color: [200, 40, 40],
};
const button: Fill = {
  rect: { x: 40, y: 300, width: 120, height: 40 },
  color: [20, 140, 60],
};
const badge: Fill = {
  rect: { x: 300, y: 60, width: 40, height: 40 },
  color: [240, 180, 0],
};
const base = [card, block, button, badge];
const W = 400,
  H = 400;

function observations(rects: Array<[string, Rect]>): ObservationArtifactV2 {
  return {
    version: 2,
    viewport: { width: W, height: H },
    elements: rects.map(([selector, rect]) => ({
      selector,
      tag: "div",
      rect,
      visible: true,
    })) as unknown as ObservedElementV2[],
  } as unknown as ObservationArtifactV2;
}
const inside = (outer: Rect, inner: Rect) =>
  inner.x < outer.x + outer.width &&
  outer.x < inner.x + inner.width &&
  inner.y < outer.y + outer.height &&
  outer.y < inner.y + inner.height;

test("identical images have no regions and zero offset", () => {
  const image = paint(W, H, base);
  const result = compareDesignImage({
    design: image,
    app: paint(W, H, base),
    width: W,
  });
  expect(result.regions).toEqual([]);
  expect(result.offset).toBe(0);
  expect(result.uncompared).toEqual([]);
});

test("a 2× design export compares equal to a 1× app capture", () => {
  const result = compareDesignImage({
    design: paint(W, H, base, 2),
    app: paint(W, H, base),
    width: W,
  });
  expect(result.regions).toEqual([]);
});

test("vertical alignment finds a uniform downward shift", () => {
  const shifted = base.map((fill) => ({
    ...fill,
    rect: { ...fill.rect, y: fill.rect.y + 37 },
  }));
  const result = compareDesignImage({
    design: paint(W, H, base),
    app: paint(W, H + 37, shifted),
    width: W,
  });
  // design y = app y + offset
  expect(result.offset).toBe(-37);
  expect(result.regions).toEqual([]);
  expect(result.uncompared).toContainEqual({ top: 0, height: 37, side: "app" });
});

test.each([
  [
    "colour patch",
    [
      card,
      block,
      button,
      badge,
      {
        rect: { x: 360, y: 340, width: 8, height: 8 },
        color: [0, 0, 0] as [number, number, number],
      },
    ],
    { x: 360, y: 340, width: 8, height: 8 },
  ],
  [
    "corner radius",
    [{ ...card, radius: 16 }, block, button, badge],
    { x: 40, y: 40, width: 8, height: 8 },
  ],
  [
    "spacing shift",
    [card, { ...block, rect: { ...block.rect, y: 212 } }, button, badge],
    block.rect,
  ],
  [
    "button colour",
    [
      card,
      block,
      { ...button, color: [20, 60, 140] as [number, number, number] },
      badge,
    ],
    button.rect,
  ],
  ["missing block", [card, block, button], badge.rect],
] as const)(
  "a planted %s yields a region covering it",
  (_, fills, expected) => {
    const result = compareDesignImage({
      design: paint(W, H, base),
      app: paint(W, H, [...fills]),
      width: W,
    });
    expect(result.regions.some((region) => inside(region.rect, expected))).toBe(
      true,
    );
  },
);

test("corner components of one card merge under their owner", () => {
  const result = compareDesignImage({
    design: paint(W, H, base),
    app: paint(W, H, [{ ...card, radius: 16 }, block, button, badge]),
    width: W,
    observations: observations([
      ["#card", card.rect],
      ["#block", block.rect],
      ["#button", button.rect],
      ["#badge", badge.rect],
    ]),
  });
  expect(result.regions).toHaveLength(1);
  expect(result.regions[0]?.owner).toBe("#card");
  expect(result.regions[0]?.elements).toContain("#card");
  expect(result.regions[0]?.id).toBe("region-1");
});

test("region count is capped and the rest counted as omitted", () => {
  const dots: Fill[] = Array.from({ length: 30 }, (_, index) => ({
    rect: {
      x: 8 + (index % 10) * 36,
      y: 8 + Math.floor(index / 10) * 36,
      width: 8,
      height: 8,
    },
    color: [0, 0, 0],
  }));
  const result = compareDesignImage({
    design: paint(W, H, []),
    app: paint(W, H, dots),
    width: W,
  });
  expect(result.regions).toHaveLength(MAX_REGIONS);
  expect(result.omitted).toBe(10);
  expect(result.regions.map((r) => r.id)).toEqual(
    Array.from({ length: MAX_REGIONS }, (_, i) => `region-${i + 1}`),
  );
});

test("comparison is deterministic", () => {
  const options = () => ({
    design: paint(W, H, base),
    app: paint(W, H, [{ ...card, radius: 16 }, block, button]),
    width: W,
  });
  expect(compareDesignImage(options())).toEqual(compareDesignImage(options()));
});

test("a stale design at another width throws", () => {
  expect(() =>
    compareDesignImage({
      design: paint(390, H, []),
      app: paint(W, H, []),
      width: W,
    }),
  ).toThrow(/recapture/);
});

test("tall pages compare quickly", () => {
  const design = paint(1440, 6000, []),
    app = paint(1440, 6000, []);
  const started = performance.now();
  compareDesignImage({ design, app, width: 1440 });
  expect(performance.now() - started).toBeLessThan(2000);
});
