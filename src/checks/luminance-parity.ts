import {
  contrastRatio,
  relativeLuminance,
  round,
  type SignalledElement,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type {
  CheckResult,
  CheckTuple,
  DeterministicCheck,
  FindingCandidate,
  Rect,
  RGB,
} from "./types.js";

/** A scheme flip crosses this relative luminance… */
export const FLIP_CROSSING = 0.5;
/** …and moves at least this far. */
export const FLIP_MOVEMENT = 0.25;
/** Neighbours are comparable when their light-scheme luminance is this close. */
export const PEER_LUMINANCE_WINDOW = 0.1;
/** The nearest neighbours that vote on the local scheme change. */
export const MAX_PEERS = 4;
/** Primary-action labels need this contrast in every scheme, at any size. */
export const PRIMARY_CONTRAST = 4.5;

const MAX_NOTES = 6;

type Painted = SignalledElement & {
  signals: SignalledElement["signals"] & {
    paint: NonNullable<SignalledElement["signals"]["paint"]>;
  };
};

/** -1 darker, 1 lighter, 0 no flip, from the light value to the dark one. */
export function flipDirection(light: number, dark: number): -1 | 0 | 1 {
  if (Math.abs(dark - light) < FLIP_MOVEMENT) return 0;
  if (light >= FLIP_CROSSING && dark < FLIP_CROSSING) return -1;
  if (light < FLIP_CROSSING && dark >= FLIP_CROSSING) return 1;
  return 0;
}

function sameAxis(left: CheckTuple, right: CheckTuple): boolean {
  return (
    left.flow === right.flow &&
    left.state === right.state &&
    left.viewport === right.viewport &&
    left.width === right.width &&
    left.height === right.height
  );
}

function healthy(tuple: CheckTuple): boolean {
  return tuple.failure === undefined && tuple.mismatches.length === 0;
}

/** The opposite-scheme tuple for this one, or why there is none. */
export function counterpartOf(
  tuple: CheckTuple,
  tuples: readonly CheckTuple[],
): { light: CheckTuple; dark: CheckTuple } | { reason: string } {
  if (tuple.colorScheme === undefined)
    return {
      reason:
        "parity needs light and dark captures (add colorSchemes to the project)",
    };
  if (!healthy(tuple))
    return { reason: "the capture failed or missed its expectations" };
  const opposite = tuple.colorScheme === "light" ? "dark" : "light";
  const matches = tuples.filter(
    (other) =>
      other !== tuple &&
      other.colorScheme === opposite &&
      sameAxis(tuple, other),
  );
  if (matches.length === 0)
    return { reason: `no ${opposite} capture of this state and viewport` };
  if (matches.length > 1)
    return {
      reason: `${matches.length} ${opposite} captures of this state and viewport`,
    };
  const other = matches[0] as CheckTuple;
  if (!healthy(other))
    return {
      reason: `the ${opposite} capture failed or missed its expectations`,
    };
  return tuple.colorScheme === "light"
    ? { light: tuple, dark: other }
    : { light: other, dark: tuple };
}

function painted(elements: SignalledElement[]): Painted[] {
  return elements.filter(
    (element): element is Painted => element.signals.paint !== undefined,
  );
}

function luminanceOf(element: Painted): number | undefined {
  const background = element.signals.paint.background;
  return background.status === "measured"
    ? relativeLuminance(background.color)
    : undefined;
}

function ancestorPaths(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(1).map((_, index) => parts.slice(0, -1 - index).join("/"));
}

function related(left: string, right: string): boolean {
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function edgeDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.hypot(dx, dy);
}

type Side = { element: Painted; luminance: number | undefined };
type Matched = { path: string; light: Side; dark: Side };

export type ParityOutlier = {
  path: string;
  owner: "light" | "dark";
  target: Matched;
  container: Matched;
  peers: Array<Matched & { flipped: boolean }>;
  direction: -1 | 1;
};

/**
 * Pair a light and dark capture by structural path and find painted surfaces
 * that stay on one side of the luminance scale while their painted container
 * and most comparable neighbours flip.
 */
export function parityOutliers(
  light: Painted[],
  dark: Painted[],
  ignored: { light: ReadonlySet<string>; dark: ReadonlySet<string> },
): { outliers: ParityOutlier[]; notes: string[]; compared: number } {
  const index = (elements: Painted[]) => {
    const byPath = new Map<string, Painted | null>();
    for (const element of elements)
      byPath.set(
        element.structuralPath,
        byPath.has(element.structuralPath) ? null : element,
      );
    return byPath;
  };
  const lightPaths = index(light);
  const darkPaths = index(dark);
  const matched = new Map<string, Matched>();
  let unmeasured = 0;
  for (const [path, left] of lightPaths) {
    const right = darkPaths.get(path);
    if (left === null || right === null || right === undefined) continue;
    if (left.tag !== right.tag || left.signals.role !== right.signals.role)
      continue;
    const entry = {
      path,
      light: { element: left, luminance: luminanceOf(left) },
      dark: { element: right, luminance: luminanceOf(right) },
    };
    if (
      entry.light.luminance === undefined ||
      entry.dark.luminance === undefined
    )
      unmeasured += 1;
    matched.set(path, entry);
  }
  const surface = (entry: Matched) =>
    entry.light.element.signals.paint.surface ||
    entry.dark.element.signals.paint.surface;
  const direction = (entry: Matched) =>
    entry.light.luminance === undefined || entry.dark.luminance === undefined
      ? undefined
      : flipDirection(entry.light.luminance, entry.dark.luminance);
  const containerOf = (path: string): Matched | undefined => {
    for (const ancestor of ancestorPaths(path)) {
      const entry = matched.get(ancestor);
      if (entry !== undefined && surface(entry)) return entry;
    }
    return undefined;
  };
  const isIgnored = (entry: Matched) =>
    [entry.light, entry.dark].some(({ element }, scheme) => {
      const set = scheme === 0 ? ignored.light : ignored.dark;
      return (
        set.has(element.selector) ||
        element.ancestorSelectors.some((selector) => set.has(selector))
      );
    });
  const containers = new Map<string, Matched | undefined>();
  for (const path of matched.keys()) containers.set(path, containerOf(path));
  const surfaces = [...matched.values()].filter(surface);
  const outliers: ParityOutlier[] = [];
  let compared = 0;
  for (const target of surfaces) {
    const container = containers.get(target.path);
    if (container === undefined || isIgnored(target)) continue;
    const contextDirection = direction(container);
    if (contextDirection === undefined || contextDirection === 0) continue;
    const own = direction(target);
    if (own === undefined) continue;
    const interactive = target.light.element.interactive;
    const reference = target.light.luminance as number;
    const peers = surfaces
      .filter(
        (peer) =>
          peer !== target &&
          containers.get(peer.path) === container &&
          !related(peer.path, target.path) &&
          peer.light.element.interactive === interactive &&
          direction(peer) !== undefined &&
          Math.abs((peer.light.luminance as number) - reference) <=
            PEER_LUMINANCE_WINDOW,
      )
      .sort(
        (left, right) =>
          edgeDistance(target.light.element.rect, left.light.element.rect) -
            edgeDistance(target.light.element.rect, right.light.element.rect) ||
          left.path.localeCompare(right.path),
      )
      .slice(0, MAX_PEERS)
      .map((peer) => ({
        ...peer,
        flipped: direction(peer) === contextDirection,
      }));
    if (peers.length === 0) continue;
    compared += 1;
    if (own === contextDirection) continue;
    const flipped = peers.filter((peer) => peer.flipped).length;
    if (flipped * 2 <= peers.length) continue;
    // The scheme where the stuck surface sits on the far side of the scale
    // from its container is where a reader sees it disagree.
    const disagrees = (scheme: "light" | "dark") =>
      (target[scheme].luminance as number) >= FLIP_CROSSING !==
      (container[scheme].luminance as number) >= FLIP_CROSSING;
    outliers.push({
      path: target.path,
      owner: disagrees("light") && !disagrees("dark") ? "light" : "dark",
      target,
      container,
      peers,
      direction: contextDirection,
    });
  }
  const notes =
    unmeasured === 0
      ? []
      : [`${unmeasured} matched elements have unmeasured background paint`];
  return {
    outliers: outliers.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    notes,
    compared,
  };
}

const hex = ({ r, g, b }: RGB) =>
  `#${[r, g, b]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;

function parityCandidate(
  outlier: ParityOutlier,
  light: CheckTuple,
  dark: CheckTuple,
): FindingCandidate {
  const { target, container, peers } = outlier;
  const owner = target[outlier.owner].element;
  const lum = (side: Side) => round(side.luminance as number, 3);
  const flipped = peers.filter((peer) => peer.flipped);
  const way = outlier.direction < 0 ? "darkens" : "lightens";
  return {
    category: "luminance-parity",
    severity: "major",
    rule: "idiom:background-scheme-parity",
    selectorHint: owner.selector,
    fingerprintHint: `scheme-parity:${target.path}`,
    explanation: `${owner.selector} keeps a ${lum(target.light) >= FLIP_CROSSING ? "light" : "dark"} background in both schemes (luminance ${lum(target.light)} light, ${lum(target.dark)} dark) while its container ${container.light.element.selector} ${way} (${lum(container.light)} → ${lum(container.dark)}) and ${flipped.length} of ${peers.length} comparable neighbours follow it (${flipped
      .slice(0, 3)
      .map((peer) => peer.light.element.selector)
      .join(", ")}).`,
    acceptance: [
      `${owner.selector} changes scheme with its surroundings: in ${outlier.owner} mode its background sits on the same side of luminance ${FLIP_CROSSING} as ${container.light.element.selector}.`,
    ],
    verification: verify("luminance-parity", {
      rule: "background-scheme-parity",
      path: target.path,
      schemes: ["light", "dark"],
      target: { light: lum(target.light), dark: lum(target.dark) },
      container: {
        path: container.path,
        light: lum(container.light),
        dark: lum(container.dark),
      },
      peers: peers.map((peer) => ({
        path: peer.path,
        light: lum(peer.light),
        dark: lum(peer.dark),
        flipped: peer.flipped,
      })),
      thresholds: {
        crossing: FLIP_CROSSING,
        movement: FLIP_MOVEMENT,
        peerWindow: PEER_LUMINANCE_WINDOW,
      },
    }),
    evidenceTuples: [light, dark],
  };
}

function primaryCandidates(
  elements: Painted[],
  tuple: CheckTuple,
  notes: string[],
): { candidates: FindingCandidate[]; measured: number } {
  const candidates: FindingCandidate[] = [];
  let measured = 0;
  const unmeasured: string[] = [];
  for (const element of elements) {
    const { paint } = element.signals;
    if (!paint.primaryAction) continue;
    const text = paint.text;
    if (text === undefined || text.status === "none") continue;
    if (text.status === "unavailable") {
      unmeasured.push(`${element.selector} (${text.reason})`);
      continue;
    }
    measured += 1;
    const worst = text.samples
      .map((sample) => ({
        sample,
        ratio: contrastRatio(sample.foreground, sample.background),
      }))
      .sort((left, right) => left.ratio - right.ratio)[0];
    if (worst === undefined || worst.ratio >= PRIMARY_CONTRAST) continue;
    const scheme = tuple.colorScheme ?? "default";
    const shown = Math.floor(worst.ratio * 100) / 100;
    candidates.push({
      category: "luminance-parity",
      severity: "major",
      rule: "idiom:primary-action-contrast",
      selectorHint: element.selector,
      explanation: `primary action ${element.selector}${element.signals.name ? ` (${JSON.stringify(element.signals.name.slice(0, 40))})` : ""} has label contrast ${shown}:1 in the ${scheme} scheme (${hex(worst.sample.foreground)} on ${hex(worst.sample.background)}); primary actions need ${PRIMARY_CONTRAST}:1 at any size.`,
      acceptance: [
        `Every label colour on ${element.selector} reaches ${PRIMARY_CONTRAST}:1 against its background in the ${scheme} scheme.`,
      ],
      verification: verify("luminance-parity", {
        rule: "primary-action-contrast",
        scheme,
        ratio: round(worst.ratio, 3),
        required: PRIMARY_CONTRAST,
        foreground: worst.sample.foreground,
        background: worst.sample.background,
        sources: worst.sample.sources,
      }),
    });
  }
  if (unmeasured.length > 0)
    notes.push(
      `primary-action label paint unmeasured: ${unmeasured.slice(0, 3).join(", ")}${unmeasured.length > 3 ? ", …" : ""}`,
    );
  return { candidates, measured };
}

function ignoredSelectors(
  tuple: CheckTuple,
  selectors: readonly string[],
  notes: string[],
): Set<string> {
  const marks =
    tuple.observations?.version === 2
      ? (tuple.observations.selectorMarks ?? [])
      : [];
  const ignored = new Set<string>();
  for (const selector of selectors) {
    const mark = marks.find(
      (candidate) =>
        candidate.purpose === "luminance-ignore" &&
        candidate.selector === selector,
    );
    if (mark === undefined)
      notes.push(
        `ignore selector ${selector} was not resolved at capture (recapture)`,
      );
    else for (const match of mark.matches) ignored.add(match);
  }
  return ignored;
}

/**
 * Light/dark parity of painted surfaces and the contrast of primary-action
 * labels, both from paint evidence persisted at capture.
 */
export const luminanceParityCheck: DeterministicCheck = {
  id: "luminance-parity",
  run({ tuple, tuples, config }): CheckResult {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const elements = painted(observed.elements);
    if (elements.length === 0 && observed.elements.length > 0)
      return unavailable(
        this.id,
        "observations predate paint signals (recapture)",
      );
    const notes: string[] = [];
    const marks =
      tuple.observations?.version === 2
        ? (tuple.observations.selectorMarks ?? [])
        : [];
    for (const selector of config.luminanceParity.primarySelectors)
      if (
        !marks.some(
          (mark) =>
            mark.purpose === "primary-action" && mark.selector === selector,
        )
      )
        notes.push(
          `primary selector ${selector} was not resolved at capture (recapture)`,
        );
    const primary = primaryCandidates(elements, tuple, notes);
    const candidates = [...primary.candidates];
    let parityUnavailable: string | undefined;
    const pair = counterpartOf(tuple, tuples ?? [tuple]);
    if ("reason" in pair) parityUnavailable = pair.reason;
    else {
      const other = pair.light === tuple ? pair.dark : pair.light;
      const otherObserved = signalledElements(other);
      const otherElements =
        "reason" in otherObserved ? [] : painted(otherObserved.elements);
      if ("reason" in otherObserved)
        parityUnavailable = `${other.colorScheme} capture: ${otherObserved.reason}`;
      else if (otherElements.length === 0)
        parityUnavailable = `${other.colorScheme} capture predates paint signals (recapture)`;
      else {
        const ownNotes: string[] = [];
        const ignore = config.luminanceParity.ignore;
        const ignored = {
          light: ignoredSelectors(pair.light, ignore, ownNotes),
          dark: ignoredSelectors(pair.dark, ignore, []),
        };
        const analysis = parityOutliers(
          pair.light === tuple ? elements : otherElements,
          pair.dark === tuple ? elements : otherElements,
          ignored,
        );
        notes.push(...ownNotes, ...analysis.notes);
        if (analysis.compared === 0)
          notes.push(
            "no painted surface has a changing container and comparable neighbours to compare against",
          );
        for (const outlier of analysis.outliers)
          if (pair[outlier.owner] === tuple)
            candidates.push(parityCandidate(outlier, pair.light, pair.dark));
      }
    }
    if (parityUnavailable !== undefined)
      notes.unshift(`scheme parity unavailable: ${parityUnavailable}`);
    const reason =
      notes.length === 0
        ? undefined
        : `${notes.slice(0, MAX_NOTES).join("; ")}${notes.length > MAX_NOTES ? `; +${notes.length - MAX_NOTES} more` : ""}`;
    return {
      coverage: {
        check: this.id,
        status:
          parityUnavailable !== undefined && primary.measured === 0
            ? "unavailable"
            : "ran",
        ...(reason === undefined ? {} : { reason }),
      },
      candidates,
    };
  },
};
