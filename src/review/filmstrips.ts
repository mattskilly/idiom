import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { evidencePath } from "../artifact-path.js";
import { decodeFrame } from "../capture/filmstrips.js";
import {
  FILMSTRIP_LIMITS,
  type FilmstripAction,
} from "../checks/filmstrip-schema.js";
import type { ActionTimeline, CheckTuple, Rect } from "../checks/types.js";
import type { Finding } from "../schemas/finding.js";

// Five-pixel glyphs, deterministic across hosts and installed fonts.
const font: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  m: ["00000", "00000", "11010", "10101", "10101", "10101", "10101"],
  s: ["00000", "00000", "01111", "10000", "01110", "00001", "11110"],
  e: ["00000", "00000", "01110", "10001", "11111", "10000", "01111"],
  t: ["00100", "00100", "11111", "00100", "00100", "00101", "00010"],
  l: ["01100", "00100", "00100", "00100", "00100", "00100", "01110"],
  a: ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
  u: ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
  n: ["00000", "00000", "11110", "10001", "10001", "10001", "10001"],
  v: ["00000", "00000", "10001", "10001", "10001", "01010", "00100"],
  i: ["00100", "00000", "01100", "00100", "00100", "00100", "01110"],
  b: ["10000", "10000", "11110", "10001", "10001", "10001", "11110"],
  r: ["00000", "00000", "10110", "11001", "10000", "10000", "10000"],
  o: ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
  d: ["00001", "00001", "01111", "10001", "10001", "10001", "01111"],
  f: ["00110", "01001", "01000", "11100", "01000", "01000", "01000"],
  c: ["00000", "00000", "01111", "10000", "10000", "10000", "01111"],
  p: ["00000", "00000", "11110", "10001", "11110", "10000", "10000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
};
function pixel(png: PNG, x: number, y: number, color: number[]) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const p = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  png.data[p] = color[0] ?? 0;
  png.data[p + 1] = color[1] ?? 0;
  png.data[p + 2] = color[2] ?? 0;
  png.data[p + 3] = 255;
}
export function bitmapLabel(png: PNG, value: string, x: number, y: number) {
  for (const [index, letter] of [...value].entries())
    for (const [row, bits] of (font[letter] ?? []).entries())
      for (const [col, bit] of [...bits].entries())
        if (bit === "1") pixel(png, x + index * 6 + col, y + row, [35, 35, 35]);
}
/** Reconstruct the subject at this paint, never stamp its final box on history. */
export function subjectRects(
  action: ActionTimeline,
  visual: FilmstripAction,
  time: number,
  selector: string,
): Rect[] {
  const origin =
    (visual.anchor ?? visual.timelineOrigin) - visual.timelineOrigin;
  const map = new Map<string, Rect>();
  const changed = new Set(
    action.frames.slice(1).flatMap((f) => f.elements.map((e) => e.selector)),
  );
  for (const frame of action.frames) {
    if (frame.time > time + origin) break;
    for (const e of frame.elements)
      if (e.selector === selector || changed.has(e.selector))
        map.set(e.selector, e.rect);
  }
  for (const shift of action.shifts)
    for (const source of shift.sources) {
      if (source.selector !== selector && !changed.has(source.selector))
        continue;
      if (shift.time <= time + origin)
        map.set(source.selector, source.currentRect);
      else if (!map.has(source.selector))
        map.set(source.selector, source.previousRect);
    }
  for (const m of action.mutations)
    if (m.time <= time + origin && m.rect) map.set(m.selector, m.rect);
  for (const frame of visual.visualFrames ?? []) {
    if (frame.time > time) break;
    for (const e of frame.elements)
      if (e.selector === selector || changed.has(e.selector))
        map.set(e.selector, e.rect);
  }
  return [...map.values()];
}

export async function composeFilmstrip(options: {
  runDirectory: string;
  tuple: CheckTuple;
  action: FilmstripAction;
  timeline: ActionTimeline;
  selector: string;
  path: string;
  region?: Rect | undefined;
}): Promise<NonNullable<Finding["evidence"]["filmstrip"]>> {
  const started = performance.now();
  const { action, timeline } = options;
  const region = options.region ?? action.region;
  const base = dirname(options.tuple.metadataPath);
  const limits = {
    width: FILMSTRIP_LIMITS.width,
    height: FILMSTRIP_LIMITS.height,
    bytes: FILMSTRIP_LIMITS.bytes,
  };
  const evidence: NonNullable<Finding["evidence"]["filmstrip"]> = {
    manifest: join(base, "filmstrips.json"),
    action: action.id,
    status: action.status,
    limits,
    ...(action.reason ? { reason: action.reason } : {}),
  };
  if (
    region.x < action.region.x ||
    region.y < action.region.y ||
    region.x + region.width > action.region.x + action.region.width ||
    region.y + region.height > action.region.y + action.region.height
  ) {
    evidence.status = "partial";
    evidence.reason =
      "common comparison region includes uncaptured pixels (shown grey)";
  }
  const images = await Promise.all(
    action.frames.map(async (frame) =>
      frame.path
        ? await readFile(
            await evidencePath(options.runDirectory, join(base, frame.path)),
          )
        : undefined,
    ),
  );
  if (!images.some(Boolean))
    return {
      ...evidence,
      status: "unavailable",
      reason: action.reason ?? "no observed compositor frames",
    };
  const columns = action.frames.length;
  const minCellWidth = 116;
  const header = 36;
  let scale = Math.min(
    1,
    (limits.width / columns - 4) / region.width,
    (limits.height - header) / region.height,
  );
  for (let attempt = 0; attempt < 10; attempt++, scale *= 0.75) {
    const w = Math.max(minCellWidth, Math.floor(region.width * scale));
    const h = Math.max(1, Math.floor(region.height * scale));
    const sheet = new PNG({ width: (w + 4) * columns, height: h + header });
    sheet.data.fill(245);
    for (let p = 3; p < sheet.data.length; p += 4) sheet.data[p] = 255;
    for (const [i, frame] of action.frames.entries()) {
      const left = i * (w + 4) + 2;
      const data = images[i];
      const image = data ? decodeFrame(data) : undefined;
      bitmapLabel(
        sheet,
        frame.slot === "settle"
          ? `settle ${Math.round(frame.requestedMs)}ms`
          : `${frame.slot}ms`,
        left,
        3,
      );
      if (
        frame.actualMs !== undefined &&
        Math.abs(frame.actualMs - frame.requestedMs) >
          FILMSTRIP_LIMITS.toleranceMs
      )
        bitmapLabel(sheet, `${Math.round(frame.actualMs)}ms sampled`, left, 14);
      if (options.region && evidence.status === "partial")
        bitmapLabel(sheet, "partial", left, 25);
      if (!image) {
        bitmapLabel(sheet, "unavailable", left, 25);
        continue;
      }
      if (frame.slot === "settle" && !action.settled)
        bitmapLabel(sheet, "unsettled", left, 25);
      const iw = Math.max(1, Math.floor(region.width * scale));
      for (let y = 0; y < h; y++)
        for (let x = 0; x < iw; x++) {
          const cssX = region.x + x / scale;
          const cssY = region.y + y / scale;
          if (
            cssX < action.region.x ||
            cssY < action.region.y ||
            cssX >= action.region.x + action.region.width ||
            cssY >= action.region.y + action.region.height
          )
            continue;
          const sx = Math.min(
            image.width - 1,
            Math.floor(
              ((cssX - action.region.x) * image.width) / action.region.width,
            ),
          );
          const sy = Math.min(
            image.height - 1,
            Math.floor(
              ((cssY - action.region.y) * image.height) / action.region.height,
            ),
          );
          const p = (sy * image.width + sx) * 4;
          pixel(sheet, left + x, header + y, [
            image.data[p] ?? 0,
            image.data[p + 1] ?? 0,
            image.data[p + 2] ?? 0,
          ]);
        }
      const rects = subjectRects(
        timeline,
        action,
        frame.actualMs ?? frame.requestedMs,
        options.selector,
      );
      if (!rects.length) bitmapLabel(sheet, "no outline", left, 25);
      if (
        timeline.mutations.some(
          (m) =>
            m.type === "remove" &&
            m.time <=
              (frame.actualMs ?? frame.requestedMs) +
                (action.anchor ?? action.timelineOrigin) -
                action.timelineOrigin,
        )
      )
        bitmapLabel(sheet, "removed", left, 25);
      for (const rect of rects) {
        const x = Math.round((rect.x - region.x) * scale) + left;
        const y = Math.round((rect.y - region.y) * scale) + header;
        const right =
          Math.round((rect.x + rect.width - region.x) * scale) + left;
        const bottom =
          Math.round((rect.y + rect.height - region.y) * scale) + header;
        for (let line = 0; line < 2; line++) {
          for (
            let px = Math.max(left, x);
            px <= Math.min(left + iw - 1, right);
            px++
          ) {
            if (y >= header) pixel(sheet, px, y + line, [235, 45, 55]);
            if (bottom < sheet.height)
              pixel(sheet, px, bottom - line, [235, 45, 55]);
          }
          for (
            let py = Math.max(header, y);
            py <= Math.min(sheet.height - 1, bottom);
            py++
          ) {
            if (x >= left) pixel(sheet, x + line, py, [235, 45, 55]);
            if (right < left + iw)
              pixel(sheet, right - line, py, [235, 45, 55]);
          }
        }
      }
    }
    if (sheet.width > limits.width || sheet.height > limits.height) continue;
    const bytes = PNG.sync.write(sheet);
    if (bytes.length > limits.bytes) continue;
    const path = join(options.runDirectory, options.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return {
      ...evidence,
      sheet: options.path,
      width: sheet.width,
      height: sheet.height,
      bytes: bytes.length,
      generationMs: performance.now() - started,
    };
  }
  return {
    ...evidence,
    status: "unavailable",
    reason: "contact sheet cannot fit within PNG size limits",
  };
}

export async function attachFilmstrips(
  runDirectory: string,
  findings: Finding[],
  tuples: CheckTuple[],
): Promise<Finding[]> {
  const cache = new Map<
    string,
    Promise<NonNullable<Finding["evidence"]["filmstrip"]>>
  >();
  const owners = new Map<string, string>();
  return Promise.all(
    findings.map(async (finding) => {
      const id = finding.evidence.timeline?.id;
      if (!id) return finding;
      const tuple = tuples.find(
        (t) =>
          t.state === finding.state &&
          t.viewport === finding.viewport &&
          (finding.colorScheme === undefined ||
            t.colorScheme === finding.colorScheme),
      );
      const action = tuple?.filmstrips?.actions.find((a) => a.id === id);
      const timeline = tuple?.timelines?.actions.find((a) => a.id === id);
      if (!tuple || !action || !timeline) return finding;
      let path = join(
        dirname(tuple.metadataPath),
        "crops",
        `${finding.fingerprint.slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, "_")}-filmstrip.png`,
      );
      if (owners.has(path) && owners.get(path) !== id)
        path = path.replace(/-filmstrip\.png$/, `-filmstrip-${id}.png`);
      owners.set(path, id);
      let pending = cache.get(path);
      if (!pending) {
        pending = composeFilmstrip({
          runDirectory,
          tuple,
          action,
          timeline,
          selector: String(
            finding.verification.params?.surface ??
              finding.verification.params?.selector ??
              "",
          ),
          path,
        });
        cache.set(path, pending);
      }
      const evidence = await pending;
      return {
        ...finding,
        evidence: { ...finding.evidence, filmstrip: evidence },
      };
    }),
  );
}
