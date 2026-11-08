import type { PNG } from "pngjs";
import type {
  VisualBlankEvidence,
  VisualBlankRecord,
} from "../checks/blank-schema.js";
import type { Rect, ScreenshotGeometry } from "../checks/types.js";
import { screenshotScale } from "./media-bands.js";

export function blankReason(record: VisualBlankRecord): string | undefined {
  if (record.masked || record.exempt || record.unavailable || !record.pixels)
    return;
  if (record.opacity <= 0.01) return "effective opacity is at or below 1%";
  if (record.overlay.alpha >= 0.98 && record.overlay.coverage >= 0.995)
    return "an opaque overlay covers at least 99.5% of the visible media";
  if (record.video && !record.video.poster && !record.video.frame)
    return "video has no poster or painted frame";
  if (record.pixels.dominantShare >= 0.995)
    return "one quantized colour covers at least 99.5% of the interior";
  return;
}

/** Exact RGB histogram: 16 levels per channel, every interior pixel, 2 CSS px edge inset. */
export function sampleBlankMedia(
  evidence: VisualBlankEvidence,
  decode: () => PNG,
  viewport: number | { width: number; height: number },
  geometry?: ScreenshotGeometry,
  documentWidth?: number,
): VisualBlankEvidence {
  if (evidence.status === "skipped" || evidence.status === "unavailable")
    return evidence;
  let image: PNG;
  try {
    image = decode();
  } catch {
    return {
      ...evidence,
      status: "unavailable",
      reason: "screenshot PNG could not be decoded",
      records: evidence.records.map((r) => ({
        ...r,
        pixels: undefined,
        unavailable: "screenshot PNG could not be decoded",
      })),
    };
  }
  const fallbackViewport =
    typeof viewport === "number"
      ? { width: viewport, height: image.height / (image.width / viewport) }
      : viewport;
  const scale =
    geometry?.scale ??
    screenshotScale(
      image,
      fallbackViewport,
      documentWidth ?? fallbackViewport.width,
    );
  const records = evidence.records.map((original): VisualBlankRecord => {
    const record = { ...original, pixels: undefined };
    if (record.exempt || record.masked || record.unavailable) return record;
    let { interior, visible } = record;
    const fresh = geometry?.rects?.[record.selector];
    if (geometry?.drift && !fresh)
      return {
        ...record,
        unavailable: "target has no refreshed screenshot rect",
      };
    if (fresh) {
      const dx = fresh.x - record.rect.x,
        dy = fresh.y - record.rect.y;
      // Insets are CSS box edges; reapply them to the refreshed dimensions.
      interior = {
        x: interior.x + dx,
        y: interior.y + dy,
        width: Math.max(0, interior.width + fresh.width - record.rect.width),
        height: Math.max(
          0,
          interior.height + fresh.height - record.rect.height,
        ),
      };
      visible = {
        x: visible.x + dx,
        y: visible.y + dy,
        width: Math.min(visible.width, fresh.width),
        height: Math.min(visible.height, fresh.height),
      };
    }
    const ox = geometry?.strategy === "viewport" ? 0 : record.scroll.x;
    const oy = geometry?.strategy === "viewport" ? 0 : record.scroll.y;
    const left = Math.max(interior.x + 2, visible.x) + ox;
    const top = Math.max(interior.y + 2, visible.y) + oy;
    const right =
      Math.min(interior.x + interior.width - 2, visible.x + visible.width) + ox;
    const bottom =
      Math.min(interior.y + interior.height - 2, visible.y + visible.height) +
      oy;
    const x0 = Math.max(0, Math.ceil(left * scale)),
      y0 = Math.max(0, Math.ceil(top * scale));
    const x1 = Math.min(image.width, Math.floor(right * scale)),
      y1 = Math.min(image.height, Math.floor(bottom * scale));
    if (!(scale > 0) || x1 - x0 < 4 * scale || y1 - y0 < 4 * scale)
      return {
        ...record,
        unavailable: "target outside screenshot or crop too small",
      };
    const histogram = new Uint32Array(4096);
    let dominant = 0,
      distinct = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * image.width + x) * 4;
        const key =
          ((image.data[i] ?? 0) >> 4) * 256 +
          ((image.data[i + 1] ?? 0) >> 4) * 16 +
          ((image.data[i + 2] ?? 0) >> 4);
        const value = (histogram[key] ?? 0) + 1;
        if (value === 1) distinct++;
        histogram[key] = value;
        dominant = Math.max(dominant, value);
      }
    const count = (x1 - x0) * (y1 - y0);
    const crop: Rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    return {
      ...record,
      interior,
      visible,
      pixels: { dominantShare: dominant / count, distinct, count, crop },
    };
  });
  const missing = records.filter(
    (r) => (r.unavailable || r.overlay.uncertainty) && !r.masked && !r.exempt,
  );
  return {
    ...evidence,
    status: missing.length ? "partial" : "ran",
    reason: missing.length
      ? [
          ...new Set(
            missing.map((r) => r.unavailable ?? r.overlay.uncertainty),
          ),
        ].join("; ")
      : undefined,
    records,
  };
}
