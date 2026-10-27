import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  timelineEvidence,
  unavailable,
  verify,
} from "./shared.js";
import {
  contains,
  type Displacement,
  displacements,
  regionRect,
  scrollAt,
} from "./timeline.js";
import type {
  ActionTimeline,
  DeterministicCheck,
  FindingCandidate,
} from "./types.js";

type Rect = { x: number; y: number; width: number; height: number };

/** Content that arrives later than this after input is a late shift. */
export const LATE_MS = 500;
/** One frame of slack between a mutation's time and the sample that shows it. */
const FRAME_SLACK_MS = 20;

export type ShiftCause = {
  selector: string;
  kind: "insert" | "remove" | "resize";
  /** Milliseconds after the action started. */
  time: number;
  /**
   * The slot the cause pushes from, in document coordinates: an insert's
   * first rect, a resize's baseline rect, a removal's last rect.
   */
  rect: Rect;
  /** The measured end state: an insert's last rect, a resize's final rect. */
  final: Rect;
  /**
   * A resize's earliest possible time: the last sample before it changed.
   * Between sparse samples a resize is only known to fall in that gap.
   */
  since?: number | undefined;
  /** A resize's size change. */
  delta?: { dw: number; dh: number } | undefined;
};

/** What attribution needs to know about one moved element. */
export type ShiftCandidate = {
  start: Rect;
  end: Rect;
  peakAt: number;
  peakDx: number;
  peakDy: number;
};

export type InteractionShift = {
  cause: ShiftCause;
  late: boolean;
  moved: Displacement[];
};

/** Late only when the content provably changed after the boundary. */
export const isLate = (cause: ShiftCause) =>
  (cause.since ?? cause.time) > LATE_MS;

const root = (selector: string) => selector === "html" || selector === "body";
const area = (rect: Rect) => rect.width * rect.height;

/**
 * The content inserted, removed or resized during an action, as candidate
 * causes of displacement. A container that only grew because content was
 * inserted into it is not a cause; the insert is.
 */
export function shiftCauses(
  action: ActionTimeline,
  moved: readonly Displacement[] = displacements(action),
): ShiftCause[] {
  const bySelector = new Map(moved.map((entry) => [entry.selector, entry]));
  const causes: ShiftCause[] = [];
  for (const mutation of action.mutations) {
    if (root(mutation.selector)) continue;
    const scroll = scrollAt(action, mutation.time);
    const recorded = mutation.rect
      ? {
          ...mutation.rect,
          x: mutation.rect.x + scroll.x,
          y: mutation.rect.y + scroll.y,
        }
      : undefined;
    if (mutation.type === "remove") {
      // Nothing without area (a script, an empty wrapper) pulls content.
      if (!recorded || area(recorded) === 0) continue;
      causes.push({
        selector: mutation.selector,
        kind: "remove",
        time: mutation.time,
        rect: recorded,
        final: recorded,
      });
      continue;
    }
    const sampled = bySelector.get(mutation.selector);
    const rect = sampled?.baseline === false ? sampled.start : recorded;
    const final = sampled?.baseline === false ? sampled.end : recorded;
    if (!rect || !final || Math.max(area(rect), area(final)) === 0) continue;
    causes.push({
      selector: mutation.selector,
      kind: "insert",
      time: mutation.time,
      rect,
      final,
    });
  }
  const contents = [...causes];
  for (const entry of moved) {
    if (!entry.baseline || !entry.resized || root(entry.selector)) continue;
    // A container that grew because content arrived inside it is not the cause.
    if (contents.some((cause) => contains(entry.end, cause.final))) continue;
    causes.push({
      selector: entry.selector,
      kind: "resize",
      time: entry.resized.at,
      since: entry.resized.since,
      rect: entry.start,
      final: entry.end,
      delta: { dw: entry.resized.dw, dh: entry.resized.dh },
    });
  }
  return causes;
}

/**
 * The inserted, removed or resized content that pushed `candidate`, judged
 * geometrically in the baseline layout: the cause sits above the candidate,
 * or to its left on the same row, before the push. Undefined when nothing
 * accounts for the movement.
 */
export function attributeShift(
  candidate: ShiftCandidate,
  causes: readonly ShiftCause[],
): ShiftCause | undefined {
  const from = candidate.start;
  const vertical = Math.abs(candidate.peakDy) >= Math.abs(candidate.peakDx);
  const sameRow = (slot: Rect) =>
    slot.y < from.y + from.height && slot.y + slot.height > from.y;
  const eligible = causes.filter((cause) => {
    if (cause.time > candidate.peakAt + FRAME_SLACK_MS) return false;
    const slot = cause.rect;
    if (cause.kind === "insert") {
      // The candidate ended up inside the new content: it is that content.
      if (contains(cause.final, candidate.end)) return false;
      const left = sameRow(slot) && slot.x <= from.x + 1;
      return vertical ? slot.y <= from.y + 1 || left : left;
    }
    if (cause.kind === "resize") {
      // A child of the element that grew moved with it.
      if (contains(slot, from) && contains(cause.final, candidate.end))
        return false;
      const delta = cause.delta ?? { dw: 0, dh: 0 };
      if (Math.abs(vertical ? delta.dh : delta.dw) < 1) return false;
      // Growing taller pushes what is below; growing wider, what is to the
      // right. A column beside the content that grew with the page pushes
      // nothing down.
      return vertical
        ? slot.y + slot.height <= from.y + 1
        : sameRow(slot) && slot.x + slot.width <= from.x + 1;
    }
    const left = sameRow(slot) && slot.x + slot.width <= from.x + 1;
    return vertical ? slot.y + slot.height <= from.y + 1 || left : left;
  });
  // Together the causes must be able to move it this far: a link that
  // grew a few pixels does not move a column by a page.
  const extent = (cause: ShiftCause) => {
    if (cause.kind === "resize")
      return Math.abs(
        vertical ? (cause.delta?.dh ?? 0) : (cause.delta?.dw ?? 0),
      );
    const size = (rect: Rect) => (vertical ? rect.height : rect.width);
    return Math.max(size(cause.rect), size(cause.final));
  };
  const distance = Math.abs(vertical ? candidate.peakDy : candidate.peakDx);
  const reach = eligible.reduce((sum, cause) => sum + extent(cause), 0);
  if (distance > reach * 1.25 + 32) return undefined;
  const rank = (cause: ShiftCause) => (cause.kind === "resize" ? 1 : 0);
  return eligible.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.time - a.time ||
      (a.kind === "resize" ? area(a.rect) - area(b.rect) : 0),
  )[0];
}

const geometryProperty =
  /^(?:transform|translate|scale|top|left|right|bottom|inset.*|margin.*|padding.*|width|height|max-height|max-width|min-height|grid-template-.*|flex.*|all)$/;

const intersectsViewport = (rect: Rect, width: number, height: number) =>
  rect.x < width &&
  rect.x + rect.width > 0 &&
  rect.y < height &&
  rect.y + rect.height > 0;

/**
 * Independent content arrivals are separate jumps, not intermediate animation
 * positions. Split only when every jump has a distinct cause in that sample
 * interval; a single insert followed by gradual movement keeps its exclusion.
 * Each attribution then compares a distance and cause from the same interval.
 */
function discreteJumps(
  entry: Displacement,
  causes: readonly ShiftCause[],
  minDistance: number,
): Array<{ candidate: Displacement; cause: ShiftCause | undefined }> {
  const whole = () => [
    { candidate: entry, cause: attributeShift(entry, causes) },
  ];
  if (entry.steps.length < 2 || entry.positions === 0) return whole();
  const seen = new Set<string>();
  const jumps: Array<{ candidate: Displacement; cause: ShiftCause }> = [];
  for (const step of entry.steps) {
    const dx = step.end.x - step.start.x;
    const dy = step.end.y - step.start.y;
    const jump: Displacement = {
      ...entry,
      from: step.from,
      to: step.to,
      start: step.start,
      end: step.end,
      peak: Math.hypot(dx, dy),
      peakDx: dx,
      peakDy: dy,
      viewPeak: Math.hypot(step.to.x - step.from.x, step.to.y - step.from.y),
      peakAt: step.time,
      firstMovedAt: step.time,
      lastMovedAt: step.time,
      endAt: step.time,
      positions: 0,
      steps: [step],
    };
    // Preserve the whole-journey threshold for accumulated small movements.
    if (jump.peak < minDistance) return whole();
    const cause = attributeShift(
      jump,
      causes.filter((cause) => cause.time >= step.since - FRAME_SLACK_MS),
    );
    if (!cause || seen.has(cause.selector)) return whole();
    seen.add(cause.selector);
    jumps.push({ candidate: jump, cause });
  }
  return jumps;
}

/**
 * Content displaced by one action, grouped by what pushed it. Pure: reads
 * only the timeline, so replay never needs the browser.
 */
export function interactionShifts(
  action: ActionTimeline,
  viewport: { width: number; height: number },
  settings: { minDistance: number },
): InteractionShift[] {
  const journeys = displacements(action, settings.minDistance);
  const causes = shiftCauses(action, journeys);
  const inserted = new Set(
    action.mutations
      .filter((mutation) => mutation.type === "insert")
      .map((mutation) => mutation.selector),
  );
  const baseline = journeys.filter((entry) => entry.baseline);
  const candidates = baseline.filter(
    (entry) =>
      entry.peak >= settings.minDistance &&
      entry.peak > 0.5 &&
      // Pinned or scroll-anchored content did not move where the user looks.
      entry.viewPeak >= Math.min(settings.minDistance, entry.peak) &&
      // A container that collapsed to nothing was emptied, not displaced.
      area(entry.end) > 0 &&
      !root(entry.selector) &&
      // A re-rendered element that reuses its selector is new content.
      !inserted.has(entry.selector),
  );

  // Sorting or filtering inside a list: every moved member of a column of
  // equal-width items lands exactly on a slot an item held before.
  const reordered = new Set<string>();
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  for (const entry of candidates) {
    if (reordered.has(entry.selector)) continue;
    const column = (other: Displacement) =>
      near(other.start.x, entry.start.x) &&
      near(other.start.width, entry.start.width);
    const group = candidates.filter(column);
    const members = baseline.filter(column);
    // A member lands in a slot another item held, never back in its own.
    const closed = group.every((member) =>
      members.some(
        ({ selector, start: slot }) =>
          selector !== member.selector &&
          near(slot.x, member.end.x) &&
          near(slot.y, member.end.y) &&
          near(slot.width, member.end.width) &&
          near(slot.height, member.end.height),
      ),
    );
    if (closed) for (const member of group) reordered.add(member.selector);
  }

  const regionSelectors = [
    ...(action.effectRegion.control ? [action.effectRegion.control] : []),
    ...action.effectRegion.controls,
  ];
  const regions = regionSelectors.flatMap(
    (selector) => regionRect(action, selector) ?? [],
  );
  const ancestor = action.effectRegion.commonAncestor;
  if (ancestor && !root(ancestor)) {
    const start = journeys.find((entry) => entry.selector === ancestor)?.start;
    const rect = regionRect(action, ancestor);
    if (start && rect && start.height <= viewport.height) regions.push(rect);
  }

  // What the user clicked in: the control and the panels it controls. A
  // cause that holds the control, or is or sits in a controlled panel, is
  // the action's own disclosure opening or closing (snapping belongs to the
  // motion rules); only content it brings later is a shift.
  const control = action.effectRegion.control;
  const clicked = control
    ? journeys.find((entry) => entry.selector === control)
    : undefined;
  const panels = action.effectRegion.controls.flatMap(
    (selector) => regionRect(action, selector) ?? [],
  );
  // Compared within one layout: a baseline slot with the control's first
  // rect; new content with a sample of the control taken after it arrived
  // (a control that moved with its container is not sampled again).
  const holdsControl = (cause: ShiftCause) => {
    if (!clicked) return false;
    if (cause.kind === "insert")
      return clicked.endAt >= cause.time && contains(cause.final, clicked.end);
    return contains(cause.rect, clicked.start);
  };
  const toggled = (cause: ShiftCause) =>
    action.effectRegion.controls.includes(cause.selector) ||
    holdsControl(cause) ||
    panels.some(
      (panel) => contains(panel, cause.rect) || contains(panel, cause.final),
    );

  // The action took away what the user clicked in (a dismissed banner, an
  // unpinned panel): the page closing up behind it is the action's effect.
  const dismissed = causes.some(
    (cause) =>
      cause.kind === "remove" && cause.time <= LATE_MS && holdsControl(cause),
  );

  const byCause = new Map<ShiftCause, Displacement[]>();
  for (const { candidate, cause } of candidates.flatMap((entry) =>
    discreteJumps(entry, causes, settings.minDistance),
  )) {
    if (candidate.viewPeak < Math.min(settings.minDistance, candidate.peak))
      continue;
    if (reordered.has(candidate.selector)) continue;
    if (
      !intersectsViewport(candidate.from, viewport.width, viewport.height) &&
      !intersectsViewport(candidate.to, viewport.width, viewport.height)
    )
      continue;
    if (!cause) continue;
    const late = isLate(cause);
    if (!late && (dismissed || toggled(cause))) continue;
    const inside = (rect: Rect) =>
      contains(rect, candidate.start) || contains(rect, candidate.end);
    if (!late && regions.some(inside)) continue;
    if (candidate.positions >= 2) continue;
    const covering = new Set(
      journeys
        .filter((entry) => contains(entry.start, candidate.start))
        .map((entry) => entry.selector),
    );
    const animated = action.animations.some(
      (animation) =>
        animation.startTime <= candidate.lastMovedAt + FRAME_SLACK_MS &&
        (animation.endTime ?? Number.POSITIVE_INFINITY) >=
          candidate.firstMovedAt - FRAME_SLACK_MS &&
        animation.properties.some((property) =>
          geometryProperty.test(property),
        ) &&
        (animation.target === candidate.selector ||
          animation.target === cause.selector ||
          covering.has(animation.target)),
    );
    if (animated) continue;
    const list = byCause.get(cause) ?? [];
    list.push(candidate);
    byCause.set(cause, list);
  }
  // A cause that was itself pushed belongs to the shift that pushed it: a
  // table column that widens moves the next, which moves the next.
  const pushedBy = new Map<string, ShiftCause>();
  for (const [cause, moved] of byCause)
    for (const entry of moved) pushedBy.set(entry.selector, cause);
  const origin = (cause: ShiftCause) => {
    const seen = new Set<ShiftCause>([cause]);
    let current = cause;
    for (;;) {
      const parent = pushedBy.get(current.selector);
      if (!parent || seen.has(parent)) return current;
      seen.add(parent);
      current = parent;
    }
  };
  const merged = new Map<ShiftCause, Map<string, Displacement>>();
  const bySelector = new Map(journeys.map((entry) => [entry.selector, entry]));
  for (const [cause, moved] of byCause) {
    const key = origin(cause);
    const members = merged.get(key) ?? new Map<string, Displacement>();
    for (const entry of moved)
      members.set(
        entry.selector,
        members.has(entry.selector)
          ? (bySelector.get(entry.selector) ?? entry)
          : entry,
      );
    merged.set(key, members);
  }
  return [...merged].map(([cause, moved]) => ({
    cause,
    late: isLate(cause),
    moved: [...moved.values()].sort(
      (a, b) =>
        b.start.width * b.start.height * b.peak -
        a.start.width * a.start.height * a.peak,
    ),
  }));
}

const px = (value: number) => `${Math.round(Math.abs(value))}px`;
const mediaTags = /^(?:img|video|iframe|canvas|picture|svg)$/;

/** A table cell, or the wrapper directly inside one. */
const tableCell = (selector: string) => {
  const tags = selector
    .trim()
    .split(/\s*>\s*|\s+/)
    .slice(-2)
    .map((segment) => /^[a-z][a-z0-9-]*/i.exec(segment)?.[0]?.toLowerCase());
  return tags.some((tag) => tag === "th" || tag === "td");
};

function tagOf(selector: string): string {
  const last =
    selector
      .trim()
      .split(/[\s>+~]+/)
      .at(-1) ?? "";
  return /^[a-z][a-z0-9-]*/i.exec(last)?.[0]?.toLowerCase() ?? "";
}

/** A concrete fix from the measured evidence. */
export function shiftFix(
  cause: ShiftCause,
  late: boolean,
  moved: readonly string[],
): string {
  const height =
    cause.kind === "resize"
      ? px(cause.delta?.dh || cause.final.height)
      : px(cause.final.height);
  const selector = cause.selector;
  if (mediaTags.test(tagOf(selector))) {
    const w = Math.round(cause.final.width);
    const h = Math.round(cause.final.height);
    return `Give ${selector} its intrinsic size (width and height attributes, or aspect-ratio: ${w} / ${h}) so it reserves ${w}×${h}px before it loads.`;
  }
  if (cause.kind === "remove")
    return `Keep ${selector}'s ${height} while it leaves (a placeholder or min-height), or overlay it so its departure does not pull content up.`;
  const delta = cause.delta ?? { dw: 0, dh: 0 };
  if (cause.kind === "resize" && Math.abs(delta.dw) > Math.abs(delta.dh))
    return `Give ${selector} a stable width (${tableCell(selector) ? `fixed column widths with table-layout: fixed, so it keeps its ${px(cause.rect.width)}` : `min-width: ${px(Math.max(cause.rect.width, cause.final.width))}`}) so new content does not resize it by ${px(delta.dw)} and push ${moved[0] ?? "its neighbours"} sideways.`;
  if (cause.kind === "resize" && delta.dh < 0)
    return `Keep ${selector}'s height when its content shrinks (min-height: ${px(cause.rect.height)}), so ${moved[0] ?? "the content below"} does not jump up by ${height}.`;
  if (late)
    return `Reserve the measured space: give ${selector}'s container min-height: ${height} before the data arrives, or render a skeleton at ${Math.round(cause.final.width)}×${px(cause.final.height)} in its place while it loads.`;
  if (cause.kind === "resize")
    return `Reserve ${selector}'s ${height} of growth (min-height) before it changes, or overlay the added content so it does not displace ${moved[0] ?? "the content below"}.`;
  return `Overlay instead of pushing: position ${selector} over the page (popover, toast or sheet) so it does not displace ${moved[0] ?? "the content below"}, or reserve ${height} (min-height) where it appears.`;
}

function direction(entry: Displacement): string {
  if (Math.abs(entry.peakDy) >= Math.abs(entry.peakDx))
    return entry.peakDy >= 0 ? "down" : "up";
  return entry.peakDx >= 0 ? "right" : "left";
}

function describeAction(action: ActionTimeline): string {
  if (action.source === "web-step")
    return `step ${action.stepIndex ?? "?"} (${action.kind}${action.selector ? ` ${action.selector}` : ""})`;
  return `clicking ${JSON.stringify(action.name)}${action.selector ? ` (${action.selector})` : ""}`;
}

const verb = {
  insert: "was inserted",
  remove: "was removed",
  resize: "resized",
} as const;

export const interactionShiftCheck: DeterministicCheck = {
  id: "interaction-shift",
  run({ tuple, config }) {
    const settings =
      config.interactionShift ?? defaultChecksSettings.interactionShift;
    if (!settings.enabled) return skipped(this.id, "interactionShift");
    const evidence = timelineEvidence(tuple);
    if (evidence.status === "unavailable")
      return unavailable(this.id, evidence.reason);
    const viewport = { width: tuple.width, height: tuple.height };
    const candidates: FindingCandidate[] = [];
    for (const action of evidence.timelines.actions) {
      if (
        (action.source !== "probe-click" && action.source !== "web-step") ||
        // Motion-only replays repeat an action already judged in its own window.
        action.confirmation === true ||
        action.status === "unavailable"
      )
        continue;
      for (const { cause, late, moved } of interactionShifts(
        action,
        viewport,
        settings,
      )) {
        const [lead] = moved;
        if (!lead) continue;
        const names = moved
          .slice(0, 5)
          .map((entry) => `${entry.selector} (${px(entry.peak)})`);
        const more = moved.length > 5 ? `, and ${moved.length - 5} more` : "";
        const subject = describeAction(action);
        candidates.push({
          category: this.id,
          severity: "major",
          rule: "idiom:interaction-shift",
          selectorHint: cause.selector,
          fingerprintHint: `interaction-shift:${cause.selector}`,
          ...(action.id === undefined ? {} : { timeline: action.id }),
          explanation: `After ${subject}, content moved ${px(lead.peak)} ${direction(lead)} ${Math.round(cause.time)}ms after input because ${cause.selector} ${verb[cause.kind]}${late ? " (late: async content arrived after the reader had started)" : ""}: ${names.join(", ")}${more}.`,
          acceptance: [
            late
              ? `After ${subject}, content that arrives later reserves its space before it arrives.`
              : `After ${subject}, content outside what it changes stays within ${settings.minDistance}px of where it was unless the movement is animated.`,
          ],
          fix: shiftFix(
            cause,
            late,
            moved.map((entry) => entry.selector),
          ),
          verification: verify(this.id, { minDistance: settings.minDistance }),
        });
      }
    }
    return scanResult(this.id, candidates, {
      status: evidence.reason ? "partial" : "ran",
      reason: evidence.reason,
    });
  },
};
