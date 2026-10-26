import type { PNG } from "pngjs";
import type { ObservationArtifact, Rect } from "../checks/types.js";
import type { DesignRegion, DesignRegions } from "./types.js";

/** Offset search reach beyond the height difference, in CSS px. */
export const OFFSET_SEARCH = 240;
/** Minimum overlap, as a share of the shorter image, for an offset to count. */
export const MIN_OVERLAP = 0.5;
/** Difference-map cell edge, in CSS px. */
export const CELL = 4;
/** Normalised YIQ delta (0–1) above which a cell counts as changed. */
export const CELL_DELTA = 0.012;
/** Owned groups with fewer changed cells are treated as resampling noise. */
export const MIN_CELLS = 2;
/** A component must differ on average by this much to count at all. */
export const MIN_MEAN_DELTA = 2 * CELL_DELTA;
export const MAX_REGIONS = 20;
export const MAX_REGION_ELEMENTS = 8;
const SIGNATURE_BLOCKS = 16;
const MAX_YIQ_DELTA = 35215;

type Plane = { width: number; height: number; rgb: Float32Array };

/** Area-average a PNG to one pixel per CSS px, compositing alpha over white. */
function normalise(png: PNG, scale: number): Plane {
  const width = Math.max(1, Math.round(png.width / scale));
  const height = Math.max(1, Math.floor(png.height / scale + 1e-6));
  if (Number.isInteger(scale)) return normaliseWhole(png, scale, width, height);
  // Horizontal pass into a source-height intermediate, then vertical.
  const across = new Float32Array(width * png.height * 3);
  const spans = (target: number, limit: number) =>
    Array.from({ length: target }, (_, index) => {
      const start = index * scale,
        end = Math.min(limit, (index + 1) * scale);
      const parts: Array<[number, number]> = [];
      for (let source = Math.floor(start); source < end; source++) {
        const weight = Math.min(end, source + 1) - Math.max(start, source);
        if (weight > 0) parts.push([source, weight]);
      }
      return parts;
    });
  const columns = spans(width, png.width),
    rows = spans(height, png.height);
  const data = png.data;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0,
        total = 0;
      for (const [source, weight] of columns[x] ?? []) {
        const at = (y * png.width + source) * 4;
        const alpha = (data[at + 3] as number) / 255;
        r += ((data[at] as number) * alpha + 255 * (1 - alpha)) * weight;
        g += ((data[at + 1] as number) * alpha + 255 * (1 - alpha)) * weight;
        b += ((data[at + 2] as number) * alpha + 255 * (1 - alpha)) * weight;
        total += weight;
      }
      const at = (y * width + x) * 3;
      across[at] = r / total;
      across[at + 1] = g / total;
      across[at + 2] = b / total;
    }
  const rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const parts = rows[y] ?? [];
    let total = 0;
    for (const [, weight] of parts) total += weight;
    for (let x = 0; x < width; x++)
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (const [source, weight] of parts)
          sum +=
            (across[(source * width + x) * 3 + channel] as number) * weight;
        rgb[(y * width + x) * 3 + channel] = sum / total;
      }
  }
  return { width, height, rgb };
}

function normaliseWhole(
  png: PNG,
  scale: number,
  width: number,
  height: number,
): Plane {
  const rgb = new Float32Array(width * height * 3),
    data = png.data,
    area = scale * scale;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let sy = y * scale; sy < (y + 1) * scale; sy++) {
        let at = (sy * png.width + x * scale) * 4;
        for (let sx = 0; sx < scale; sx++, at += 4) {
          const alpha = (data[at + 3] as number) / 255,
            white = 255 * (1 - alpha);
          r += (data[at] as number) * alpha + white;
          g += (data[at + 1] as number) * alpha + white;
          b += (data[at + 2] as number) * alpha + white;
        }
      }
      const at = (y * width + x) * 3;
      rgb[at] = r / area;
      rgb[at + 1] = g / area;
      rgb[at + 2] = b / area;
    }
  return { width, height, rgb };
}

function signature(plane: Plane): Float32Array {
  const out = new Float32Array(plane.height * SIGNATURE_BLOCKS);
  for (let y = 0; y < plane.height; y++)
    for (let block = 0; block < SIGNATURE_BLOCKS; block++) {
      const from = Math.floor((block * plane.width) / SIGNATURE_BLOCKS),
        to = Math.max(
          from + 1,
          Math.floor(((block + 1) * plane.width) / SIGNATURE_BLOCKS),
        );
      let sum = 0;
      for (let x = from; x < to; x++) {
        const at = (y * plane.width + x) * 3;
        sum +=
          (plane.rgb[at] as number) * 0.29889531 +
          (plane.rgb[at + 1] as number) * 0.58662247 +
          (plane.rgb[at + 2] as number) * 0.11448223;
      }
      out[y * SIGNATURE_BLOCKS + block] = sum / (to - from);
    }
  return out;
}

const overlapOf = (offset: number, appHeight: number, designHeight: number) => {
  const top = Math.max(0, -offset);
  return { top, height: Math.min(appHeight, designHeight - offset) - top };
};

/** design y = app y + offset; ties prefer the smallest |offset|, then positive. */
export function bestVerticalOffset(app: Plane, design: Plane): number {
  const a = signature(app),
    d = signature(design);
  const minimum = Math.ceil(MIN_OVERLAP * Math.min(app.height, design.height));
  const low = -OFFSET_SEARCH,
    high = Math.max(0, design.height - app.height) + OFFSET_SEARCH;
  // Every app row is compared; rows past the design's edge meet its nearest
  // edge row, so shifting content out of the overlap cannot hide it.
  const cost = (offset: number) => {
    const { height } = overlapOf(offset, app.height, design.height);
    if (height < Math.max(1, minimum)) return Number.POSITIVE_INFINITY;
    let sum = 0;
    for (let y = 0; y < app.height; y++) {
      const row = Math.min(design.height - 1, Math.max(0, y + offset));
      for (let block = 0; block < SIGNATURE_BLOCKS; block++)
        sum += Math.abs(
          (a[y * SIGNATURE_BLOCKS + block] as number) -
            (d[row * SIGNATURE_BLOCKS + block] as number),
        );
    }
    return sum / (app.height * SIGNATURE_BLOCKS);
  };
  let best = 0,
    bestCost = cost(0);
  const consider = (offset: number) => {
    if (offset < low || offset > high) return;
    const value = cost(offset);
    if (
      value < bestCost - 1e-9 ||
      (Math.abs(value - bestCost) <= 1e-9 &&
        (Math.abs(offset) < Math.abs(best) ||
          (Math.abs(offset) === Math.abs(best) && offset > best)))
    ) {
      best = offset;
      bestCost = value;
    }
  };
  for (let offset = low; offset <= high; offset += 4) consider(offset);
  const coarse = best;
  for (let offset = coarse - 4; offset <= coarse + 4; offset++)
    consider(offset);
  return Number.isFinite(bestCost) ? best : 0;
}

/** pixelmatch's YIQ colour delta, normalised to 0–1. */
function colorDelta(dr: number, dg: number, db: number): number {
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const i = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return (0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q) / MAX_YIQ_DELTA;
}

const round = (value: number) => Math.round(value * 10000) / 10000;
const contains = (outer: Rect, inner: Rect) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width &&
  outer.y + outer.height >= inner.y + inner.height;
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;
const intersection = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const unite = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};

/** A device scale factor Chromium can produce (whole or half steps). */
function scaleFor(png: PNG, width: number, side: string): number {
  const scale = png.width / width;
  if (scale < 0.999 || Math.abs(scale * 2 - Math.round(scale * 2)) > 0.01)
    throw new Error(
      `${side} screenshot is ${png.width}px wide, which is not ${width} CSS px at a device scale factor; recapture`,
    );
  return scale;
}

/**
 * Compare an intended design image with the app screenshot. Both images are
 * brought to CSS px, vertically aligned, compared on a cell grid with a
 * perceptual (YIQ) delta, and changed cells are grouped into regions that name
 * the app elements they cover. Pure and deterministic.
 */
export function compareDesignImage(options: {
  design: PNG;
  app: PNG;
  /** App viewport width in CSS px. */
  width: number;
  observations?: ObservationArtifact | undefined;
}): DesignRegions {
  const app = normalise(
    options.app,
    scaleFor(options.app, options.width, "app"),
  );
  const design = normalise(
    options.design,
    scaleFor(options.design, options.width, "design"),
  );
  if (Math.abs(app.width - design.width) > 1)
    throw new Error("design and app widths disagree; recapture");
  const width = Math.min(app.width, design.width);
  const offset = bestVerticalOffset(app, design);
  const compared = overlapOf(offset, app.height, design.height);
  compared.height = Math.max(0, compared.height);
  const uncompared: DesignRegions["uncompared"] = [];
  if (compared.top > 0)
    uncompared.push({ top: 0, height: compared.top, side: "app" });
  if (compared.top + compared.height < app.height)
    uncompared.push({
      top: compared.top + compared.height,
      height: app.height - compared.top - compared.height,
      side: "app",
    });
  if (offset > 0) uncompared.push({ top: 0, height: offset, side: "design" });
  const designEnd = compared.top + compared.height + offset;
  if (designEnd < design.height)
    uncompared.push({
      top: designEnd,
      height: design.height - designEnd,
      side: "design",
    });

  const columns = Math.ceil(width / CELL),
    rows = Math.ceil(compared.height / CELL);
  const delta = new Float32Array(columns * rows);
  const end = compared.top + compared.height;
  for (let row = 0; row < rows; row++) {
    const top = compared.top + row * CELL,
      bottom = Math.min(end, top + CELL);
    for (let column = 0; column < columns; column++) {
      const left = column * CELL,
        right = Math.min(width, left + CELL);
      let dr = 0,
        dg = 0,
        db = 0;
      for (let y = top; y < bottom; y++) {
        let at = (y * app.width + left) * 3,
          dt = ((y + offset) * design.width + left) * 3;
        for (let x = left; x < right; x++, at += 3, dt += 3) {
          dr += (app.rgb[at] as number) - (design.rgb[dt] as number);
          dg += (app.rgb[at + 1] as number) - (design.rgb[dt + 1] as number);
          db += (app.rgb[at + 2] as number) - (design.rgb[dt + 2] as number);
        }
      }
      const count = (bottom - top) * (right - left);
      delta[row * columns + column] = colorDelta(
        dr / count,
        dg / count,
        db / count,
      );
    }
  }
  const changed = (column: number, row: number) =>
    column >= 0 &&
    row >= 0 &&
    column < columns &&
    row < rows &&
    (delta[row * columns + column] as number) > CELL_DELTA;

  // Dilate by one cell, then 8-connected components over the dilated mask.
  const dilated = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++)
      if (changed(column, row))
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const c = column + dx,
              r = row + dy;
            if (c >= 0 && r >= 0 && c < columns && r < rows)
              dilated[r * columns + c] = 1;
          }
  const label = new Int32Array(columns * rows).fill(-1);
  type Component = { rect: Rect; changedCells: number; deltaSum: number };
  const components: Component[] = [];
  for (let start = 0; start < dilated.length; start++) {
    if (!dilated[start] || (label[start] as number) >= 0) continue;
    const id = components.length;
    const stack = [start];
    label[start] = id;
    let left = Number.POSITIVE_INFINITY,
      top = Number.POSITIVE_INFINITY,
      right = -1,
      bottom = -1,
      changedCells = 0,
      deltaSum = 0;
    while (stack.length) {
      const cell = stack.pop() as number;
      const column = cell % columns,
        row = Math.floor(cell / columns);
      if (changed(column, row)) {
        changedCells++;
        deltaSum += delta[cell] as number;
        left = Math.min(left, column);
        top = Math.min(top, row);
        right = Math.max(right, column);
        bottom = Math.max(bottom, row);
      }
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const c = column + dx,
            r = row + dy;
          if (c < 0 || r < 0 || c >= columns || r >= rows) continue;
          const next = r * columns + c;
          if (dilated[next] && (label[next] as number) < 0) {
            label[next] = id;
            stack.push(next);
          }
        }
    }
    const x = left * CELL,
      y = compared.top + top * CELL;
    components.push({
      rect: {
        x,
        y,
        width: Math.min(width, (right + 1) * CELL) - x,
        height:
          Math.min(
            compared.top + compared.height,
            compared.top + (bottom + 1) * CELL,
          ) - y,
      },
      changedCells,
      deltaSum,
    });
  }
  // Faint components are resampling noise. Tiny strong ones (a corner-radius
  // cell) survive until their owner's components are pooled below.
  const kept = components.filter(
    (component) =>
      component.deltaSum / component.changedCells >= MIN_MEAN_DELTA,
  );

  const page = width * app.height;
  const candidates =
    options.observations?.elements.filter(
      (element) =>
        element.visible &&
        element.rect.width > 0 &&
        element.rect.height > 0 &&
        element.tag !== "html" &&
        element.tag !== "body" &&
        element.rect.width * element.rect.height < 0.9 * page,
    ) ?? [];
  const area = (rect: Rect) => rect.width * rect.height;
  const ownerOf = (rect: Rect): string | null => {
    let best: (typeof candidates)[number] | undefined;
    for (const element of candidates)
      if (
        contains(element.rect, rect) &&
        (best === undefined || area(element.rect) < area(best.rect))
      )
        best = element;
    return best?.selector ?? null;
  };
  type Group = Component & { owner: string | null };
  let groups: Group[] = [];
  for (const component of kept) {
    const owner = ownerOf(component.rect);
    const same =
      owner === null ? undefined : groups.find((g) => g.owner === owner);
    if (same) {
      same.rect = unite(same.rect, component.rect);
      same.changedCells += component.changedCells;
      same.deltaSum += component.deltaSum;
    } else groups.push({ ...component, owner });
  }
  groups = groups.filter((group) => group.changedCells >= MIN_CELLS);
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i] as Group,
          b = groups[j] as Group;
        if (
          !overlaps(a.rect, b.rect) &&
          (a.owner === null || a.owner !== b.owner)
        )
          continue;
        const rect = unite(a.rect, b.rect);
        groups = [
          ...groups.filter((_, index) => index !== i && index !== j),
          {
            rect,
            changedCells: a.changedCells + b.changedCells,
            deltaSum: a.deltaSum + b.deltaSum,
            owner: ownerOf(rect),
          },
        ];
        merged = true;
        break outer;
      }
  }
  const byPosition = (a: Group, b: Group) =>
    a.rect.y - b.rect.y || a.rect.x - b.rect.x;
  groups.sort((a, b) => b.changedCells - a.changedCells || byPosition(a, b));
  const omitted = Math.max(0, groups.length - MAX_REGIONS);
  const regions: DesignRegion[] = groups
    .slice(0, MAX_REGIONS)
    .sort(byPosition)
    .map((group, index) => {
      const covered = candidates
        .filter(
          (element) =>
            element.selector === group.owner ||
            intersection(element.rect, group.rect) >= 0.5 * area(element.rect),
        )
        .sort(
          (a, b) =>
            area(a.rect) - area(b.rect) ||
            (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0),
        );
      const elements = [
        ...new Set(covered.map((element) => element.selector)),
      ].slice(0, MAX_REGION_ELEMENTS);
      if (group.owner !== null && !elements.includes(group.owner))
        elements[Math.min(elements.length, MAX_REGION_ELEMENTS - 1)] =
          group.owner;
      return {
        id: `region-${index + 1}`,
        rect: group.rect,
        designRect: { ...group.rect, y: group.rect.y + offset },
        owner: group.owner,
        elements,
        changedCells: group.changedCells,
        cells:
          Math.ceil(group.rect.width / CELL) *
          Math.ceil(group.rect.height / CELL),
        meanDelta: round(group.deltaSum / group.changedCells),
      };
    });
  return {
    version: 1,
    offset,
    compared,
    uncompared,
    regions,
    omitted,
  };
}
