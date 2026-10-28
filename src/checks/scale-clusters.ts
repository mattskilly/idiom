import { rulingFingerprint } from "../rulings/fingerprint.js";
import type {
  CheckTuple,
  ObservedElementV2,
  ScaleClusterContext,
  ScaleClusterProperty,
  ScaleRole,
  ScaleRulingRecord,
  ScalesConfig,
} from "./types.js";

/** A px length, or a canonical colour. */
export type ClusterValue =
  | { kind: "px"; px: number }
  | { kind: "color"; canonical: string };

/** One off-scale value that would otherwise be reported as drift. */
export type ClusterOccurrence<Source = unknown> = {
  tuple: CheckTuple;
  element: ObservedElementV2;
  property: ScaleClusterProperty;
  value: ClusterValue;
  /** The scale role the value was judged under (absent for spacing). */
  role?: ScaleRole | undefined;
  longhand: string;
  /** The finding-side record this occurrence came from. */
  source: Source;
};

export type ScaleCluster<Source = unknown> = {
  fingerprint: string;
  choiceKey: string;
  property: ScaleClusterProperty;
  role?: ScaleRole | undefined;
  /** Bucket centre: `17px`, or a canonical colour. */
  value: string;
  context: ScaleClusterContext;
  componentLabel: string;
  count: number;
  distinctStates: number;
  distinctElements: number;
  qualifies: boolean;
  nearestSteps: { below?: string; above?: string; steps: string[] };
  /** Where the declared scale lives, for example `checks.scales.spacing`. */
  scaleSource: string;
  suggestedToken: string;
  question: string;
  occurrences: Array<ClusterOccurrence<Source>>;
  /** Up to three representative occurrences on distinct elements. */
  examples: Array<ClusterOccurrence<Source>>;
};

export const DEFAULT_SUGGEST_AFTER = 5;
export const SCALE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const landmarkTags: Record<string, string> = {
  header: "banner",
  nav: "navigation",
  main: "main",
  aside: "complementary",
  footer: "contentinfo",
  form: "form",
  dialog: "dialog",
};
const landmarkRoles = new Set([
  "banner",
  "navigation",
  "main",
  "complementary",
  "contentinfo",
  "form",
  "region",
  "search",
  "dialog",
  "alertdialog",
]);
const roleOrder: ScaleRole[] = ["chip", "control", "card", "panel", "divider"];

const nouns: Record<ScaleClusterProperty, string> = {
  "spacing:padding": "padding",
  "spacing:margin": "margin",
  "spacing:gap": "gap",
  height: "height",
  radius: "radius",
  border: "border colour",
};
const tokenPrefixes: Record<ScaleClusterProperty, string> = {
  "spacing:padding": "space",
  "spacing:margin": "space",
  "spacing:gap": "space",
  height: "height",
  radius: "radius",
  border: "border",
};

/** `paddingTop` → `spacing:padding`, `rowGap` → `spacing:gap`. */
export function spacingFamily(longhand: string): ScaleClusterProperty {
  if (longhand.startsWith("padding")) return "spacing:padding";
  if (longhand.startsWith("margin")) return "spacing:margin";
  return "spacing:gap";
}

function landmarkOf(element: ObservedElementV2): string | undefined {
  const role =
    element.attributes.role?.trim().toLowerCase() || landmarkTags[element.tag];
  if (role === undefined || !landmarkRoles.has(role)) return undefined;
  const name = element.attributes["aria-label"]?.trim();
  return name ? `${role} "${name}"` : role;
}

/** Nearest landmark, component and viewport of an occurrence. */
export function clusterContext(
  occurrence: Pick<ClusterOccurrence, "tuple" | "element" | "role">,
  bySelector: ReadonlyMap<string, ObservedElementV2>,
  scales: ScalesConfig,
): ScaleClusterContext {
  const { element, tuple } = occurrence;
  const lineage = [
    element,
    ...element.ancestorSelectors.flatMap((selector) => {
      const ancestor = bySelector.get(selector);
      return ancestor === undefined ? [] : [ancestor];
    }),
  ];
  let landmark = "document";
  for (const candidate of lineage) {
    const found = landmarkOf(candidate);
    if (found !== undefined) {
      landmark = found;
      break;
    }
  }
  const node = lineage.find((candidate) => candidate.signals?.nodeId)?.signals
    ?.nodeId;
  let component: string | undefined =
    node === undefined ? undefined : `node:${node}`;
  if (component === undefined) {
    const marks =
      tuple.observations?.version === 2
        ? (tuple.observations.selectorMarks ?? [])
        : [];
    for (const role of roleOrder) {
      const selector = scales.roles[role].find((configured) =>
        marks.some(
          (mark) =>
            mark.purpose === `scale-${role}` &&
            mark.selector === configured &&
            mark.matches.includes(element.selector),
        ),
      );
      if (selector !== undefined) {
        component = `role:${selector}`;
        break;
      }
    }
  }
  if (component === undefined) {
    // A bare tag names no component; its first authored class does.
    const className = element.attributes.class?.trim().split(/\s+/)[0];
    component =
      occurrence.role ??
      `tag:${element.tag}${className ? `.${className}` : ""}${element.attributes.role ? `[role=${element.attributes.role}]` : ""}`;
  }
  return { landmark, component, viewport: tuple.viewport };
}

export function componentLabel(component: string): string {
  if (component.startsWith("node:"))
    return `node ${component.slice("node:".length)}`;
  if (component.startsWith("role:")) return component.slice("role:".length);
  if (component.startsWith("tag:")) {
    const [tag, ...rest] = component.slice("tag:".length).split(".");
    return rest.length
      ? `${tag}.${rest.join(".")} elements`
      : `<${tag}> elements`;
  }
  return `${component}s`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function suggestedToken(
  property: ScaleClusterProperty,
  context: ScaleClusterContext,
): string {
  const component = slug(context.component.replace(/^(?:node|role|tag):/, ""));
  const landmark =
    context.landmark === "document" ? "" : slug(context.landmark);
  const token = [tokenPrefixes[property], component || "custom", landmark]
    .filter((part) => part !== "")
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return SCALE_TOKEN_PATTERN.test(token) ? token : tokenPrefixes[property];
}

function declared(
  property: ScaleClusterProperty,
  role: ScaleRole | undefined,
  scales: ScalesConfig,
): {
  entries: Array<number | string | { multipleOf: number }>;
  source: string;
} {
  if (property.startsWith("spacing:"))
    return { entries: scales.spacing, source: "checks.scales.spacing" };
  if (property === "height")
    return {
      entries: scales.controlHeights,
      source: "checks.scales.controlHeights",
    };
  if (property === "radius")
    return role === undefined || role === "divider"
      ? { entries: [], source: "checks.scales.radius" }
      : {
          entries: scales.radius[role],
          source: `checks.scales.radius.${role}`,
        };
  return role === "divider" || role === "control"
    ? { entries: scales.border[role], source: `checks.scales.border.${role}` }
    : { entries: [], source: "checks.scales.border" };
}

const pxLabel = (value: number) => `${Math.round(value * 1000) / 1000}px`;

export function nearestSteps(
  value: ClusterValue,
  entries: ReadonlyArray<number | string | { multipleOf: number }>,
): ScaleCluster["nearestSteps"] {
  const steps = entries.map((entry) =>
    typeof entry === "number"
      ? pxLabel(entry)
      : typeof entry === "string"
        ? entry
        : `multiples of ${pxLabel(entry.multipleOf)}`,
  );
  if (value.kind === "color") return { steps };
  const numbers: number[] = [];
  for (const entry of entries) {
    if (typeof entry === "number") numbers.push(entry);
    else if (typeof entry === "object") {
      const step = entry.multipleOf;
      numbers.push(
        Math.floor(value.px / step) * step,
        Math.ceil(value.px / step) * step,
      );
    }
  }
  const below = numbers.filter((step) => step < value.px);
  const above = numbers.filter((step) => step > value.px);
  return {
    ...(below.length ? { below: pxLabel(Math.max(...below)) } : {}),
    ...(above.length ? { above: pxLabel(Math.min(...above)) } : {}),
    steps,
  };
}

export function scaleQuestionText(options: {
  value: string;
  property: ScaleClusterProperty;
  count: number;
  context: ScaleClusterContext;
  nearestSteps: ScaleCluster["nearestSteps"];
}): string {
  const { below, above, steps } = options.nearestSteps;
  const noun = nouns[options.property];
  const where = `${componentLabel(options.context.component)}${options.context.landmark === "document" ? "" : ` in ${options.context.landmark}`} at ${options.context.viewport}`;
  const relation =
    options.property === "border"
      ? `outside your declared colours (${steps.join(", ")})`
      : below !== undefined && above !== undefined
        ? `between your ${below} and ${above} steps`
        : below !== undefined
          ? `above your largest ${below} step`
          : above !== undefined
            ? `below your smallest ${above} step`
            : `outside your declared steps (${steps.join(", ")})`;
  return `${options.value} ${noun} appears ${options.count} ${options.count === 1 ? "time" : "times"} on ${where}, ${relation}. Add a step for this context, or keep reporting it as drift?`;
}

export function scaleNoun(property: ScaleClusterProperty): string {
  return nouns[property];
}

export function scaleChoiceKey(options: {
  property: ScaleClusterProperty;
  role?: ScaleRole | undefined;
  value: ClusterValue;
  context: ScaleClusterContext;
}): string {
  const value =
    options.value.kind === "px"
      ? `${Math.round(options.value.px)}px`
      : options.value.canonical;
  const role =
    options.property.startsWith("spacing:") || options.role === undefined
      ? ""
      : ` role=${options.role}`;
  return `scale-cluster:v1 ${options.property} ${value}${role} component=${options.context.component} landmark=${options.context.landmark} viewport=${options.context.viewport}`;
}

const occurrenceKey = (occurrence: ClusterOccurrence) =>
  `${occurrence.tuple.flow}\0${occurrence.tuple.state}\0${occurrence.tuple.viewport}\0${occurrence.tuple.colorScheme ?? ""}\0${occurrence.tuple.metadataPath}\0${occurrence.element.structuralPath}\0${occurrence.longhand}`;
const elementKey = (occurrence: ClusterOccurrence) =>
  `${occurrence.tuple.flow}\0${occurrence.element.structuralPath}\0${occurrence.element.selector}`;
const sortKey = (occurrence: ClusterOccurrence) =>
  `${occurrence.tuple.state}\0${occurrence.tuple.viewport}\0${occurrence.tuple.colorScheme ?? ""}\0${occurrence.element.structuralPath}\0${occurrence.longhand}`;

function representatives<Source>(
  occurrences: Array<ClusterOccurrence<Source>>,
): Array<ClusterOccurrence<Source>> {
  const byState = new Map<string, Array<ClusterOccurrence<Source>>>();
  for (const occurrence of [...occurrences].sort((left, right) =>
    sortKey(left).localeCompare(sortKey(right)),
  ))
    byState.set(occurrence.tuple.state, [
      ...(byState.get(occurrence.tuple.state) ?? []),
      occurrence,
    ]);
  const queues = [...byState.values()];
  const picked: Array<ClusterOccurrence<Source>> = [];
  const elements = new Set<string>();
  while (picked.length < 3 && queues.some((queue) => queue.length > 0))
    for (const queue of queues) {
      if (picked.length >= 3) break;
      while (queue.length > 0) {
        const next = queue.shift() as ClusterOccurrence<Source>;
        if (elements.has(elementKey(next))) continue;
        elements.add(elementKey(next));
        picked.push(next);
        break;
      }
    }
  return picked;
}

/**
 * Whether a person can see the occurrence in the capture: off-canvas
 * content (a carousel's parked slides) never supports a question; it is
 * still reported as an ordinary finding.
 */
function onCanvas(occurrence: ClusterOccurrence): boolean {
  const observations = occurrence.tuple.observations;
  const width =
    observations?.version === 2
      ? Math.max(observations.document.scrollWidth, observations.viewport.width)
      : occurrence.tuple.width;
  const { x, width: extent } = occurrence.element.rect;
  return x < width && x + extent > 0;
}

const shorthands: Record<string, string[]> = {
  rowGap: ["gap"],
  columnGap: ["gap"],
  borderTopLeftRadius: ["borderRadius"],
  borderTopColor: ["borderColor", "border", "borderTop"],
};

/**
 * Whether the value falls back from a custom property that never resolved:
 * a broken token is a defect, not a missing step, so it stays a finding
 * (and root-cause grouping still sees it) instead of becoming a question.
 */
function fromBrokenToken(occurrence: ClusterOccurrence): boolean {
  const sources = occurrence.element.styleSources;
  if (sources === undefined) return false;
  const family = /^(padding|margin)/.exec(occurrence.longhand)?.[1];
  return [
    occurrence.longhand,
    ...(family === undefined ? [] : [family]),
    ...(shorthands[occurrence.longhand] ?? []),
  ].some((property) => (sources[property]?.unresolved?.length ?? 0) > 0);
}

/** Bucket values within ±1px around the most frequent value (ties → smaller). */
function bucket<Source>(
  occurrences: Array<ClusterOccurrence<Source>>,
): Array<{ value: ClusterValue; members: Array<ClusterOccurrence<Source>> }> {
  const buckets: Array<{
    value: ClusterValue;
    members: Array<ClusterOccurrence<Source>>;
  }> = [];
  const colors = new Map<string, Array<ClusterOccurrence<Source>>>();
  let lengths: Array<ClusterOccurrence<Source> & { value: { kind: "px" } }> =
    [];
  for (const occurrence of occurrences)
    if (occurrence.value.kind === "color")
      colors.set(occurrence.value.canonical, [
        ...(colors.get(occurrence.value.canonical) ?? []),
        occurrence,
      ]);
    else
      lengths.push(
        occurrence as ClusterOccurrence<Source> & { value: { kind: "px" } },
      );
  for (const [canonical, members] of [...colors].sort(([left], [right]) =>
    left.localeCompare(right),
  ))
    buckets.push({ value: { kind: "color", canonical }, members });
  while (lengths.length > 0) {
    const frequency = new Map<number, number>();
    for (const { value } of lengths)
      frequency.set(value.px, (frequency.get(value.px) ?? 0) + 1);
    const [centre] = [...frequency].sort(
      ([leftValue, left], [rightValue, right]) =>
        right - left || leftValue - rightValue,
    )[0] as [number, number];
    const members = lengths.filter(
      ({ value }) => Math.abs(value.px - centre) <= 1,
    );
    lengths = lengths.filter(({ value }) => Math.abs(value.px - centre) > 1);
    buckets.push({ value: { kind: "px", px: centre }, members });
  }
  return buckets;
}

/**
 * Group off-scale occurrences by property, value (±1px or the same colour)
 * and context (nearest landmark, component, viewport). A cluster qualifies
 * as a design-system question when it repeats at least `suggestAfter` times
 * across at least two states or three distinct elements.
 */
export function scaleClusters<Source>(
  occurrences: Array<ClusterOccurrence<Source>>,
  scales: ScalesConfig,
): Array<ScaleCluster<Source>> {
  const suggestAfter = scales.suggestAfter ?? DEFAULT_SUGGEST_AFTER;
  const lookups = new Map<CheckTuple, Map<string, ObservedElementV2>>();
  const lookup = (tuple: CheckTuple) => {
    let found = lookups.get(tuple);
    if (found === undefined) {
      found = new Map(
        tuple.observations?.version === 2
          ? tuple.observations.elements.map((element) => [
              element.selector,
              element,
            ])
          : [],
      );
      lookups.set(tuple, found);
    }
    return found;
  };
  const unique = new Map<string, ClusterOccurrence<Source>>();
  for (const occurrence of occurrences)
    if (
      onCanvas(occurrence) &&
      !fromBrokenToken(occurrence) &&
      !unique.has(occurrenceKey(occurrence))
    )
      unique.set(occurrenceKey(occurrence), occurrence);
  const byContext = new Map<
    string,
    {
      context: ScaleClusterContext;
      property: ScaleClusterProperty;
      role?: ScaleRole | undefined;
      members: Array<ClusterOccurrence<Source>>;
    }
  >();
  for (const occurrence of unique.values()) {
    const context = clusterContext(
      occurrence,
      lookup(occurrence.tuple),
      scales,
    );
    const role = occurrence.property.startsWith("spacing:")
      ? undefined
      : occurrence.role;
    const key = `${occurrence.property}\0${role ?? ""}\0${context.landmark}\0${context.component}\0${context.viewport}`;
    const entry = byContext.get(key) ?? {
      context,
      property: occurrence.property,
      ...(role === undefined ? {} : { role }),
      members: [],
    };
    entry.members.push(occurrence);
    byContext.set(key, entry);
  }
  const clusters: Array<ScaleCluster<Source>> = [];
  for (const [, entry] of [...byContext].sort(([left], [right]) =>
    left.localeCompare(right),
  ))
    for (const { value, members } of bucket(entry.members)) {
      // Light and dark captures of one element are one occurrence.
      const count = new Set(
        members.map(
          (occurrence) =>
            `${occurrence.tuple.flow}\0${occurrence.tuple.state}\0${occurrence.tuple.viewport}\0${occurrence.element.structuralPath}\0${occurrence.longhand}`,
        ),
      ).size;
      const distinctStates = new Set(members.map(({ tuple }) => tuple.state))
        .size;
      const distinctElements = new Set(members.map(elementKey)).size;
      const label = value.kind === "px" ? pxLabel(value.px) : value.canonical;
      const scale = declared(entry.property, entry.role, scales);
      const steps = nearestSteps(value, scale.entries);
      const choiceKey = scaleChoiceKey({
        property: entry.property,
        role: entry.role,
        value,
        context: entry.context,
      });
      clusters.push({
        fingerprint: rulingFingerprint(choiceKey),
        choiceKey,
        property: entry.property,
        ...(entry.role === undefined ? {} : { role: entry.role }),
        value: label,
        context: entry.context,
        componentLabel: componentLabel(entry.context.component),
        count,
        distinctStates,
        distinctElements,
        qualifies:
          count >= suggestAfter &&
          (distinctStates >= 2 || distinctElements >= 3),
        nearestSteps: steps,
        scaleSource: scale.source,
        suggestedToken: suggestedToken(entry.property, entry.context),
        question: scaleQuestionText({
          value: label,
          property: entry.property,
          count,
          context: entry.context,
          nearestSteps: steps,
        }),
        occurrences: [...members].sort((left, right) =>
          sortKey(left).localeCompare(sortKey(right)),
        ),
        examples: representatives(members),
      });
    }
  return clusters;
}

const contextEqual = (left: ScaleClusterContext, right: ScaleClusterContext) =>
  left.landmark === right.landmark &&
  left.component === right.component &&
  left.viewport === right.viewport;

/** Whether a recorded add-step covers this occurrence's value in its context. */
function covered(value: ClusterValue, record: ScaleRulingRecord): boolean {
  if (value.kind === "color") return value.canonical === record.value;
  const step = Number.parseFloat(record.value);
  return Number.isFinite(step) && Math.abs(value.px - step) <= 1;
}

export type AppliedScaleRulings<Source> = {
  /** Occurrences on a recorded add-step: resolved by ruling, never reported. */
  resolved: Array<ClusterOccurrence<Source>>;
  clusters: Array<
    ScaleCluster<Source> & {
      status: "unanswered" | "drift";
      ruling?: ScaleRulingRecord | undefined;
    }
  >;
  /** Every input occurrence a qualifying cluster holds. */
  held: Array<ClusterOccurrence<Source>>;
  /** Occurrences outside every qualifying cluster: reported as today. */
  residual: Array<ClusterOccurrence<Source>>;
};

/**
 * Apply recorded answers: add-steps resolve matching occurrences in their
 * context, a drift answer keeps its cluster as one grouped finding, and every
 * other qualifying cluster is an unanswered question.
 */
export function applyScaleRulings<Source>(
  occurrences: Array<ClusterOccurrence<Source>>,
  scales: ScalesConfig,
  rulings: readonly ScaleRulingRecord[],
): AppliedScaleRulings<Source> {
  const steps = rulings.filter((record) => record.answer === "add-step");
  const lookups = new Map<CheckTuple, Map<string, ObservedElementV2>>();
  const resolved: Array<ClusterOccurrence<Source>> = [];
  const open: Array<ClusterOccurrence<Source>> = [];
  for (const occurrence of occurrences) {
    if (steps.length === 0) {
      open.push(occurrence);
      continue;
    }
    let map = lookups.get(occurrence.tuple);
    if (map === undefined) {
      map = new Map(
        occurrence.tuple.observations?.version === 2
          ? occurrence.tuple.observations.elements.map((element) => [
              element.selector,
              element,
            ])
          : [],
      );
      lookups.set(occurrence.tuple, map);
    }
    const context = clusterContext(occurrence, map, scales);
    if (
      steps.some(
        (record) =>
          record.property === occurrence.property &&
          contextEqual(record.context, context) &&
          covered(occurrence.value, record),
      )
    )
      resolved.push(occurrence);
    else open.push(occurrence);
  }
  const drift = new Map(
    rulings
      .filter((record) => record.answer === "drift")
      .map((record) => [record.fingerprint, record]),
  );
  const clusters: AppliedScaleRulings<Source>["clusters"] = [];
  const held = new Set<ClusterOccurrence<Source>>();
  for (const cluster of scaleClusters(open, scales)) {
    if (!cluster.qualifies) continue;
    const ruling = drift.get(cluster.fingerprint);
    clusters.push({
      ...cluster,
      status: ruling === undefined ? "unanswered" : "drift",
      ...(ruling === undefined ? {} : { ruling }),
    });
    for (const occurrence of cluster.occurrences) held.add(occurrence);
  }
  // Duplicates of a held occurrence (the same element/longhand) are held too.
  const heldKeys = new Set([...held].map(occurrenceKey));
  return {
    resolved,
    clusters,
    held: open.filter((occurrence) => heldKeys.has(occurrenceKey(occurrence))),
    residual: open.filter(
      (occurrence) => !heldKeys.has(occurrenceKey(occurrence)),
    ),
  };
}
