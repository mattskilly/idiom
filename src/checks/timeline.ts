import type { ActionTimeline } from "./types.js";

export type ElementMovement = {
  selector: string;
  dx: number;
  dy: number;
  distance: number;
  /** Milliseconds since the action started. */
  firstMovedAt: number;
  lastMovedAt: number;
};

const tolerance = 0.5;

/**
 * How far each element moved during an action, and when. Positions are
 * scroll-compensated (rect + offset), so scrolling — Playwright's scroll into
 * view, the app's, or a nested scroller's — contributes nothing. A descendant
 * that moved rigidly with its tracked ancestor is represented by the
 * ancestor. Elements without frame samples fall back to layout-shift source
 * rects, which the browser already reports free of scroll.
 */
export function elementMovements(action: ActionTimeline): ElementMovement[] {
  type Point = { x: number; y: number; time: number };
  const samples = new Map<string, Point[]>();
  for (const frame of action.frames)
    for (const element of frame.elements) {
      const list = samples.get(element.selector) ?? [];
      list.push({
        x: element.rect.x + element.offset.x,
        y: element.rect.y + element.offset.y,
        time: frame.time,
      });
      samples.set(element.selector, list);
    }
  const movements: ElementMovement[] = [];
  for (const [selector, points] of samples) {
    const first = points[0];
    const last = points.at(-1);
    if (!first || !last) continue;
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    if (Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance) continue;
    const moved = points.filter(
      (point, index) =>
        index > 0 &&
        (Math.abs(point.x - (points[index - 1]?.x ?? point.x)) > tolerance ||
          Math.abs(point.y - (points[index - 1]?.y ?? point.y)) > tolerance),
    );
    movements.push({
      selector,
      dx,
      dy,
      distance: Math.hypot(dx, dy),
      firstMovedAt: moved[0]?.time ?? last.time,
      lastMovedAt: moved.at(-1)?.time ?? last.time,
    });
  }
  const shifted = new Map<
    string,
    {
      from: { x: number; y: number };
      to: { x: number; y: number };
      times: number[];
    }
  >();
  for (const shift of action.shifts)
    for (const source of shift.sources) {
      if (samples.has(source.selector)) continue;
      const known = shifted.get(source.selector);
      if (known) {
        known.to = source.currentRect;
        known.times.push(shift.time);
      } else
        shifted.set(source.selector, {
          from: source.previousRect,
          to: source.currentRect,
          times: [shift.time],
        });
    }
  for (const [selector, { from, to, times }] of shifted) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance) continue;
    movements.push({
      selector,
      dx,
      dy,
      distance: Math.hypot(dx, dy),
      firstMovedAt: times[0] ?? 0,
      lastMovedAt: times.at(-1) ?? 0,
    });
  }
  return movements;
}

/** The window scroll during an action, so "the page scrolled" is not "content moved". */
export function scrollDuring(action: ActionTimeline): {
  dx: number;
  dy: number;
} {
  const first = action.frames[0]?.scroll;
  const last = action.frames.at(-1)?.scroll;
  if (!first || !last) return { dx: 0, dy: 0 };
  return { dx: last.x - first.x, dy: last.y - first.y };
}

type Rect = { x: number; y: number; width: number; height: number };

type DisplacementStep = {
  since: number;
  time: number;
  from: Rect;
  to: Rect;
  start: Rect;
  end: Rect;
};

export type Displacement = {
  selector: string;
  /** Present in frames[0]; elements that joined later are new content. */
  baseline: boolean;
  /** First and last viewport-relative rects. */
  from: Rect;
  to: Rect;
  /** First and last rects in scroll-compensated (document) coordinates. */
  start: Rect;
  end: Rect;
  /** Largest scroll-compensated distance of any sample from the first. */
  peak: number;
  /**
   * Largest viewport-relative distance of any sample from the first: what
   * the user saw. A pinned (sticky or fixed) element, or content the browser
   * kept in place with scroll anchoring, has a document peak but no view peak.
   */
  viewPeak: number;
  /** The displacement at the peak sample. */
  peakDx: number;
  peakDy: number;
  /** Time of the first sample at or beyond `threshold`, else of the peak. */
  peakAt: number;
  firstMovedAt: number;
  lastMovedAt: number;
  /**
   * Time of the last sample. An element that moved rigidly with a tracked
   * ancestor is not sampled again, so `end` is only current as of `endAt`.
   */
  endAt: number;
  /** Distinct positions strictly between the first and the last sample. */
  positions: number;
  /** Consecutive position changes, retaining the geometry at each change. */
  steps: DisplacementStep[];
  /**
   * Size change, first sampled at `at`; `since` is the sample before it,
   * the earliest the change can have happened.
   */
  resized?: { dw: number; dh: number; at: number; since: number } | undefined;
};

const documentRect = (rect: Rect, offset: { x: number; y: number }): Rect => ({
  x: rect.x + offset.x,
  y: rect.y + offset.y,
  width: rect.width,
  height: rect.height,
});

/**
 * Every tracked element's journey during an action: where it started and
 * ended, how far it strayed (a banner that appears and leaves still moved
 * the content), when, whether it moved gradually, and whether it resized.
 * Positions are scroll-compensated as in `elementMovements`.
 */
export function displacements(
  action: ActionTimeline,
  threshold = tolerance,
): Displacement[] {
  type Sample = { time: number; view: Rect; page: Rect };
  const samples = new Map<string, Sample[]>();
  const baseline = new Set(
    action.frames[0]?.elements.map((element) => element.selector) ?? [],
  );
  for (const frame of action.frames)
    for (const element of frame.elements) {
      const list = samples.get(element.selector) ?? [];
      list.push({
        time: frame.time,
        view: element.rect,
        page: documentRect(element.rect, element.offset),
      });
      samples.set(element.selector, list);
    }
  const result: Displacement[] = [];
  const journey = (
    selector: string,
    points: Sample[],
    inBaseline: boolean,
  ): Displacement | undefined => {
    const first = points[0];
    const last = points.at(-1);
    if (!first || !last) return undefined;
    let peak = 0;
    let viewPeak = 0;
    let peakDx = 0;
    let peakDy = 0;
    let peakAt: number | undefined;
    let maximumAt = first.time;
    let firstMovedAt: number | undefined;
    let lastMovedAt = last.time;
    let dw = 0;
    let dh = 0;
    let resizedAt: number | undefined;
    let resizedSince = first.time;
    const intermediate = new Set<string>();
    const steps: DisplacementStep[] = [];
    const key = (rect: Rect) => `${Math.round(rect.x)},${Math.round(rect.y)}`;
    for (const [index, point] of points.entries()) {
      const dx = point.page.x - first.page.x;
      const dy = point.page.y - first.page.y;
      const distance = Math.hypot(dx, dy);
      viewPeak = Math.max(
        viewPeak,
        Math.hypot(point.view.x - first.view.x, point.view.y - first.view.y),
      );
      if (distance > peak) {
        peak = distance;
        peakDx = dx;
        peakDy = dy;
        maximumAt = point.time;
      }
      if (peakAt === undefined && distance >= threshold && distance > tolerance)
        peakAt = point.time;
      const previous = points[index - 1];
      if (
        previous &&
        (Math.abs(point.page.x - previous.page.x) > tolerance ||
          Math.abs(point.page.y - previous.page.y) > tolerance)
      ) {
        firstMovedAt ??= point.time;
        lastMovedAt = point.time;
        steps.push({
          since: previous.time,
          time: point.time,
          from: previous.view,
          to: point.view,
          start: previous.page,
          end: point.page,
        });
      }
      const w = point.page.width - first.page.width;
      const h = point.page.height - first.page.height;
      if (Math.abs(w) >= 1 || Math.abs(h) >= 1) {
        if (resizedAt === undefined) {
          resizedAt = point.time;
          resizedSince = previous?.time ?? point.time;
        }
        if (Math.abs(w) > Math.abs(dw)) dw = w;
        if (Math.abs(h) > Math.abs(dh)) dh = h;
      }
      if (index > 0 && index < points.length - 1) {
        const position = key(point.page);
        if (position !== key(first.page) && position !== key(last.page))
          intermediate.add(position);
      }
    }
    return {
      selector,
      baseline: inBaseline,
      from: first.view,
      to: last.view,
      start: first.page,
      end: last.page,
      peak,
      viewPeak,
      peakDx,
      peakDy,
      peakAt: peakAt ?? maximumAt,
      firstMovedAt: firstMovedAt ?? last.time,
      lastMovedAt,
      endAt: last.time,
      positions: intermediate.size,
      steps,
      ...(resizedAt === undefined
        ? {}
        : { resized: { dw, dh, at: resizedAt, since: resizedSince } }),
    };
  };
  for (const [selector, points] of samples) {
    const entry = journey(selector, points, baseline.has(selector));
    if (entry) result.push(entry);
  }
  // Unsampled layout-shift sources are baseline content the browser saw move.
  const shifted = new Map<string, Sample[]>();
  for (const shift of action.shifts)
    for (const source of shift.sources) {
      if (samples.has(source.selector)) continue;
      const list = shifted.get(source.selector) ?? [
        {
          time: shift.time,
          view: source.previousRect,
          page: source.previousRect,
        },
      ];
      list.push({
        time: shift.time,
        view: source.currentRect,
        page: source.currentRect,
      });
      shifted.set(source.selector, list);
    }
  for (const [selector, points] of shifted) {
    const entry = journey(selector, points, true);
    if (entry) result.push(entry);
  }
  return result;
}

/** The union of a selector's first and last sampled document rect. */
export function regionRect(
  action: ActionTimeline,
  selector: string,
): Rect | undefined {
  let first: Rect | undefined;
  let last: Rect | undefined;
  for (const frame of action.frames)
    for (const element of frame.elements)
      if (element.selector === selector) {
        const rect = documentRect(element.rect, element.offset);
        first ??= rect;
        last = rect;
      }
  if (!first || !last) return undefined;
  const x = Math.min(first.x, last.x);
  const y = Math.min(first.y, last.y);
  return {
    x,
    y,
    width: Math.max(first.x + first.width, last.x + last.width) - x,
    height: Math.max(first.y + first.height, last.y + last.height) - y,
  };
}

/** Whether `inner` lies within `outer`, give or take `slack` px. */
export function contains(outer: Rect, inner: Rect, slack = 1): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

/** The window scroll in effect at `time`, for rects recorded without offsets. */
export function scrollAt(
  action: ActionTimeline,
  time: number,
): { x: number; y: number } {
  let scroll = action.frames[0]?.scroll ?? { x: 0, y: 0 };
  for (const frame of action.frames) {
    if (frame.time > time) break;
    scroll = frame.scroll;
  }
  return scroll;
}
