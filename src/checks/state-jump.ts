import {
  isVisuallyHidden,
  ran,
  type SignalledElement,
  signalledElements,
  verify,
} from "./shared.js";
import type {
  CheckResult,
  CheckTuple,
  DeterministicCheck,
  FindingCandidate,
  Rect,
} from "./types.js";

/** Moves and size changes up to this many CSS px are rounding, not jumps. */
export const STATE_JUMP_TOLERANCE_PX = 1;

/** Roles kept besides interactive elements: things a person keeps an eye on. */
const LANDMARK_ROLES = new Set(["img", "heading"]);

export type StateJumpItem = {
  element: SignalledElement;
  role: string;
  name: string;
  /** `role \0 normalised name`; empty when the element has no name. */
  key: string;
};

type Inventory = {
  items: StateJumpItem[];
  /** Unique role+name keys only; ambiguous keys are left out. */
  byKey: Map<string, StateJumpItem>;
  bySelector: Map<string, StateJumpItem>;
  /** Selectors matched by this state's `intendedChanges` (jump-ok marks). */
  jumpOk: Set<string>;
};

const inventories = new WeakMap<CheckTuple, Inventory | { reason: string }>();

const normalise = (value: string) =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

function healthy(tuple: CheckTuple): boolean {
  return (
    tuple.failure === undefined &&
    tuple.mismatches.length === 0 &&
    tuple.observations !== undefined
  );
}

function inventory(tuple: CheckTuple): Inventory | { reason: string } {
  const cached = inventories.get(tuple);
  if (cached !== undefined) return cached;
  const result = ((): Inventory | { reason: string } => {
    const signalled = signalledElements(tuple);
    if ("reason" in signalled) return signalled;
    const items: StateJumpItem[] = [];
    const counts = new Map<string, number>();
    for (const element of signalled.elements) {
      if (isVisuallyHidden(element)) continue;
      if (element.rect.width <= 0 || element.rect.height <= 0) continue;
      const role = element.signals.role;
      if (!element.interactive && !LANDMARK_ROLES.has(role)) continue;
      const name = (
        element.signals.name ||
        element.signals.title ||
        element.attributes["aria-label"] ||
        ""
      ).trim();
      const key = name === "" ? "" : `${role}\u0000${normalise(name)}`;
      if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
      items.push({ element, role, name, key });
    }
    const byKey = new Map<string, StateJumpItem>();
    const bySelector = new Map<string, StateJumpItem>();
    for (const item of items) {
      if (item.key !== "" && counts.get(item.key) === 1)
        byKey.set(item.key, item);
      if (!bySelector.has(item.element.selector))
        bySelector.set(item.element.selector, item);
    }
    const observation = tuple.observations;
    const marks =
      observation?.version === 2 ? (observation.selectorMarks ?? []) : [];
    const jumpOk = new Set(
      marks
        .filter((mark) => mark.purpose === "jump-ok")
        .flatMap((mark) => mark.matches),
    );
    return { items, byKey, bySelector, jumpOk };
  })();
  inventories.set(tuple, result);
  return result;
}

/** Options that differ between two toggle combinations of one base. */
function toggleDifference(
  a: Record<string, string>,
  b: Record<string, string>,
): number {
  const toggles = new Set([...Object.keys(a), ...Object.keys(b)]);
  let differing = 0;
  for (const toggle of toggles) if (a[toggle] !== b[toggle]) differing += 1;
  return differing;
}

export type Counterparts =
  | { linked: false }
  | { linked: true; before: CheckTuple[]; missing: string[] };

/**
 * The "before" states this tuple is the "after" of: its `from` source, or,
 * for a toggle combination, its base and every combination of that base
 * that differs by one toggle and whose label sorts earlier. A combination
 * inherits its base's `from`, which is two hops away, so it is ignored.
 */
export function linkedCounterparts(
  tuple: CheckTuple,
  tuples: readonly CheckTuple[],
): Counterparts {
  const comparable = (other: CheckTuple) =>
    other !== tuple &&
    other.flow === tuple.flow &&
    other.viewport === tuple.viewport &&
    (other.colorScheme ?? "light") === (tuple.colorScheme ?? "light");
  const before: CheckTuple[] = [];
  const missing: string[] = [];
  if (tuple.combinationBase !== undefined) {
    const base = tuples.find(
      (other) =>
        comparable(other) &&
        other.state === tuple.combinationBase &&
        other.combination === undefined,
    );
    if (base !== undefined && healthy(base)) before.push(base);
    else missing.push(tuple.combinationBase);
    const options = tuple.combinationOptions ?? {};
    for (const other of tuples)
      if (
        comparable(other) &&
        other.combinationBase === tuple.combinationBase &&
        other.combination !== undefined &&
        tuple.combination !== undefined &&
        other.combination < tuple.combination &&
        toggleDifference(options, other.combinationOptions ?? {}) === 1 &&
        healthy(other)
      )
        before.push(other);
    return { linked: true, before, missing };
  }
  if (tuple.from !== undefined) {
    const source = tuples.find(
      (other) =>
        comparable(other) &&
        other.state === tuple.from &&
        other.combination === undefined,
    );
    if (source !== undefined && healthy(source)) before.push(source);
    else missing.push(tuple.from);
    return { linked: true, before, missing };
  }
  return { linked: false };
}

export type StateJump = {
  before: StateJumpItem;
  after: StateJumpItem;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  resized: boolean;
};

function stable(selector: string): boolean {
  return !selector.includes(":nth-");
}

function intended(item: StateJumpItem, jumpOk: Set<string>): boolean {
  return (
    jumpOk.has(item.element.selector) ||
    item.element.ancestorSelectors.some((ancestor) => jumpOk.has(ancestor))
  );
}

/**
 * How far scrolled content shifts in viewport coordinates between the two
 * observations, from their recorded scroll offsets; undefined when either
 * predates the record.
 */
function scrollShift(
  before: CheckTuple,
  after: CheckTuple,
): { dx: number; dy: number } | undefined {
  const a = before.observations;
  const b = after.observations;
  if (a?.version !== 2 || b?.version !== 2) return undefined;
  const { scrollX: ax, scrollY: ay } = a.document;
  const { scrollX: bx, scrollY: by } = b.document;
  if (
    ax === undefined ||
    ay === undefined ||
    bx === undefined ||
    by === undefined
  )
    return undefined;
  // Recorded on both sides: a zero shift is known, not estimated.
  return { dx: ax - bx, dy: ay - by };
}

/** Rounded (dx, dy) shared by most unchanged-size pairs: a scrolled frame. */
function frameOffset(
  pairs: Array<{ dx: number; dy: number; resized: boolean }>,
): { dx: number; dy: number } | undefined {
  const steady = pairs.filter((pair) => !pair.resized);
  const counts = new Map<string, { dx: number; dy: number; count: number }>();
  for (const pair of steady) {
    const dx = Math.round(pair.dx);
    const dy = Math.round(pair.dy);
    if (dx === 0 && dy === 0) continue;
    const key = `${dx},${dy}`;
    const entry = counts.get(key) ?? { dx, dy, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  let best: { dx: number; dy: number; count: number } | undefined;
  for (const entry of counts.values())
    if (best === undefined || entry.count > best.count) best = entry;
  if (best === undefined || best.count < 3 || best.count * 2 < steady.length)
    return undefined;
  return { dx: best.dx, dy: best.dy };
}

/**
 * Elements present in both states that moved or changed size by more than
 * the tolerance, outermost only. Matching is by unique role and accessible
 * name, then by an identical stable selector on the same tag.
 */
export function stateJumps(
  before: CheckTuple,
  after: CheckTuple,
): StateJump[] | { reason: string } {
  const a = inventory(before);
  if ("reason" in a) return a;
  const b = inventory(after);
  if ("reason" in b) return b;
  const pairs: Array<[StateJumpItem, StateJumpItem]> = [];
  const usedBefore = new Set<StateJumpItem>();
  const usedAfter = new Set<StateJumpItem>();
  for (const item of b.items) {
    if (item.key === "") continue;
    const own = b.byKey.get(item.key);
    const other = a.byKey.get(item.key);
    if (own !== item || other === undefined) continue;
    pairs.push([other, item]);
    usedBefore.add(other);
    usedAfter.add(item);
  }
  for (const item of b.items) {
    if (usedAfter.has(item) || !stable(item.element.selector)) continue;
    const other = a.bySelector.get(item.element.selector);
    if (
      other === undefined ||
      usedBefore.has(other) ||
      other.element.tag !== item.element.tag
    )
      continue;
    pairs.push([other, item]);
    usedBefore.add(other);
    usedAfter.add(item);
  }
  const measured = pairs
    .filter(
      ([from, to]) => !intended(from, a.jumpOk) && !intended(to, b.jumpOk),
    )
    .map(([from, to]): StateJump => {
      const dw = to.element.rect.width - from.element.rect.width;
      const dh = to.element.rect.height - from.element.rect.height;
      return {
        before: from,
        after: to,
        dx: to.element.rect.x - from.element.rect.x,
        dy: to.element.rect.y - from.element.rect.y,
        dw,
        dh,
        resized:
          Math.abs(dw) > STATE_JUMP_TOLERANCE_PX ||
          Math.abs(dh) > STATE_JUMP_TOLERANCE_PX,
      };
    });
  // Rects are viewport coordinates. When the page scrolled between the
  // states, content shifts by the scroll and fixed chrome does not, so an
  // element counts as moved only relative to both frames. The recorded
  // scroll offset gives the second frame; older captures estimate it.
  const offset = scrollShift(before, after) ?? frameOffset(measured);
  const magnitude = (dx: number, dy: number) =>
    Math.max(Math.abs(dx), Math.abs(dy));
  const reported = measured
    .map((pair): StateJump => {
      if (offset === undefined) return pair;
      const dx = pair.dx - offset.dx;
      const dy = pair.dy - offset.dy;
      return magnitude(dx, dy) < magnitude(pair.dx, pair.dy)
        ? { ...pair, dx, dy }
        : pair;
    })
    .filter(
      (pair) =>
        pair.resized || magnitude(pair.dx, pair.dy) > STATE_JUMP_TOLERANCE_PX,
    );
  const selectors = new Set(
    reported.map((pair) => pair.after.element.selector),
  );
  return reported.filter(
    (pair) =>
      !pair.after.element.ancestorSelectors.some((ancestor) =>
        selectors.has(ancestor),
      ),
  );
}

const fmt = (value: number) => String(Number(value.toFixed(1)));

const box = (rect: Rect) =>
  `x ${fmt(rect.x)}, y ${fmt(rect.y)}, ${fmt(rect.width)}×${fmt(rect.height)}`;

function movement(dx: number, dy: number): string | undefined {
  const parts: string[] = [];
  if (Math.abs(dx) > STATE_JUMP_TOLERANCE_PX)
    parts.push(`${fmt(Math.abs(dx))}px ${dx > 0 ? "right" : "left"}`);
  if (Math.abs(dy) > STATE_JUMP_TOLERANCE_PX)
    parts.push(`${fmt(Math.abs(dy))}px ${dy > 0 ? "down" : "up"}`);
  return parts.length === 0 ? undefined : `moves ${parts.join(" and ")}`;
}

function sizing(jump: StateJump): string | undefined {
  if (!jump.resized) return undefined;
  const from = jump.before.element.rect;
  const to = jump.after.element.rect;
  const verb =
    jump.dw <= STATE_JUMP_TOLERANCE_PX && jump.dh <= STATE_JUMP_TOLERANCE_PX
      ? "shrinks"
      : jump.dw >= -STATE_JUMP_TOLERANCE_PX &&
          jump.dh >= -STATE_JUMP_TOLERANCE_PX
        ? "grows"
        : "changes size";
  return `${verb} from ${fmt(from.width)}×${fmt(from.height)} to ${fmt(to.width)}×${fmt(to.height)}`;
}

function label(item: StateJumpItem): string {
  return item.name === ""
    ? `The ${item.role || item.element.tag} at ${item.element.selector}`
    : `The ${item.role || item.element.tag} "${item.name}"`;
}

function identity(item: StateJumpItem): string {
  return item.name === "" ? item.element.selector : normalise(item.name);
}

function rectOf(rect: Rect) {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Findings for one linked pair, reported on the "after" tuple. */
export function stateJumpCandidates(
  before: CheckTuple,
  after: CheckTuple,
  jumps: StateJump[],
): FindingCandidate[] {
  const candidates: FindingCandidate[] = [];
  const pair = `between "${before.state}" and "${after.state}"`;
  const groups = new Map<string, StateJump[]>();
  for (const jump of jumps) {
    if (jump.resized) {
      const changes = [movement(jump.dx, jump.dy), sizing(jump)]
        .filter(Boolean)
        .join(" and ");
      const from = jump.before.element.rect;
      const to = jump.after.element.rect;
      candidates.push({
        category: "state-jump",
        severity: "minor",
        rule: "idiom:state-jump",
        selectorHint: jump.after.element.selector,
        fingerprintHint: `idiom:state-jump|${before.state}|${after.state}|${jump.after.role}|${identity(jump.after)}`,
        explanation: `${label(jump.after)} ${changes} ${pair} (before ${box(from)}; after ${box(to)}). An element present in both states should stay put unless the change is intended.`,
        acceptance: [
          `${label(jump.after)} keeps the same position and size (within ${STATE_JUMP_TOLERANCE_PX}px) in "${before.state}" and "${after.state}", or the flow declares it in intendedChanges for "${after.state}".`,
        ],
        verification: verify("state-jump", {
          before: { state: before.state, rect: rectOf(from) },
          after: { state: after.state, rect: rectOf(to) },
          delta: { dx: jump.dx, dy: jump.dy, dw: jump.dw, dh: jump.dh },
          toleranceCssPx: STATE_JUMP_TOLERANCE_PX,
        }),
        evidenceTuples: [before, after],
      });
      continue;
    }
    const key = `${Math.round(jump.dx)},${Math.round(jump.dy)}`;
    groups.set(key, [...(groups.get(key) ?? []), jump]);
  }
  for (const members of groups.values()) {
    const first = members[0];
    if (first === undefined) continue;
    const change = movement(first.dx, first.dy) ?? "moves";
    const from = first.before.element.rect;
    const to = first.after.element.rect;
    const boxes = `before ${box(from)}; after ${box(to)}`;
    const subject =
      members.length === 1
        ? label(first.after)
        : `${members.length} elements (${members
            .slice(0, 3)
            .map((member) =>
              member.after.name === ""
                ? member.after.element.selector
                : `"${member.after.name}"`,
            )
            .join(", ")}${members.length > 3 ? ", …" : ""})`;
    const verb =
      members.length === 1 ? change : change.replace(/^moves/, "move together");
    candidates.push({
      category: "state-jump",
      severity: "minor",
      rule: "idiom:state-jump",
      selectorHint: first.after.element.selector,
      fingerprintHint: `idiom:state-jump|${before.state}|${after.state}|${first.after.role}|${identity(first.after)}`,
      explanation: `${subject} ${verb} ${pair} (${members.length === 1 ? "" : "the first one: "}${boxes}). An element present in both states should stay put unless the change is intended.`,
      acceptance: [
        `${members.length === 1 ? label(first.after) : "Each of these elements"} keeps the same position (within ${STATE_JUMP_TOLERANCE_PX}px) in "${before.state}" and "${after.state}", or the flow declares ${members.length === 1 ? "it" : "them"} in intendedChanges for "${after.state}".`,
      ],
      verification: verify("state-jump", {
        before: { state: before.state, rect: rectOf(from) },
        after: { state: after.state, rect: rectOf(to) },
        delta: { dx: first.dx, dy: first.dy, dw: first.dw, dh: first.dh },
        members: members.map((member) => member.after.element.selector),
        toleranceCssPx: STATE_JUMP_TOLERANCE_PX,
      }),
      evidenceTuples: [before, after],
    });
  }
  return candidates;
}

/**
 * Persistent elements that jump between two states a flow links: a `from`
 * state and its source, or toggle combinations of one base. The trigger
 * is included; elements a state lists in `intendedChanges` are skipped.
 */
export const stateJumpCheck: DeterministicCheck = {
  id: "state-jump",
  run({ tuple, tuples }): CheckResult {
    const status = (
      kind: "skipped" | "not-applicable" | "unavailable",
      reason: string,
    ): CheckResult => ({
      coverage: { check: this.id, status: kind, reason },
      candidates: [],
    });
    const linked = linkedCounterparts(tuple, tuples ?? [tuple]);
    if (!linked.linked)
      return status(
        "not-applicable",
        "state is not linked to another captured state (from or toggles)",
      );
    if (!healthy(tuple))
      return status("skipped", "this state did not capture cleanly");
    const own = inventory(tuple);
    if ("reason" in own) return status("unavailable", own.reason);
    if (linked.before.length === 0)
      return status(
        "skipped",
        `linked state ${linked.missing.map((id) => `"${id}"`).join(", ")} was not captured cleanly at this viewport`,
      );
    const candidates: FindingCandidate[] = [];
    const notes: string[] = [];
    for (const before of linked.before) {
      const jumps = stateJumps(before, tuple);
      if ("reason" in jumps) {
        notes.push(`"${before.state}": ${jumps.reason}`);
        continue;
      }
      candidates.push(...stateJumpCandidates(before, tuple, jumps));
    }
    for (const id of linked.missing)
      notes.push(`"${id}" was not captured cleanly at this viewport`);
    return notes.length === 0
      ? ran(this.id, candidates)
      : {
          coverage: { check: this.id, status: "ran", reason: notes.join("; ") },
          candidates,
        };
  },
};
