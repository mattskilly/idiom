import {
  canonicalColor,
  colorDelta,
  effectiveBackground,
  isBounded,
  isPainted,
  isVisuallyHidden,
  parseColor,
  parseCssColor,
  px,
  relativeLuminance,
  round,
  type SignalledElement,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import { spacingFindings } from "./spacing-scale.js";
import type {
  CheckResult,
  ChecksConfig,
  CheckTuple,
  DeterministicCheck,
  FindingCandidate,
  RadiusRole,
  ScaleRole,
} from "./types.js";

type Property = "height" | "radius" | "border";

/** A measured value: a px number, a full (pill/circle) radius, a percentage ellipse, or a colour. */
type Value =
  | { kind: "px"; px: number }
  | { kind: "full"; px?: number }
  | { kind: "ellipse"; percent: number }
  | {
      kind: "color";
      color: string;
      /** The colour as painted over its backdrop (alpha resolved). */
      composite: string;
      backdrop: Rgb;
      surface: "light" | "dark";
      /** A hued accent rule rather than a neutral line. */
      chromatic: boolean;
    };

type Rgb = { r: number; g: number; b: number };

function composite(color: string, backdrop: Rgb): string | undefined {
  const parsed = parseCssColor(color);
  if (parsed === undefined) return undefined;
  const mix = (channel: number, behind: number) =>
    Math.round(channel * parsed.a + behind * (1 - parsed.a));
  return `rgb(${mix(parsed.r, backdrop.r)}, ${mix(parsed.g, backdrop.g)}, ${mix(parsed.b, backdrop.b)})`;
}

type Observation = {
  tuple: CheckTuple;
  element: SignalledElement;
  property: Property;
  role: ScaleRole;
  value: Value;
  label: string;
  /** A full radius on a square box: a circle, a shape of its own. */
  circle: boolean;
};

type Group = {
  property: Property;
  role: ScaleRole;
  label: string;
  observations: Observation[];
  mode: "declared" | "undeclared";
  /** Declared scale, or the prevailing value and its support. */
  scale?: string[] | undefined;
  prevailing?: { label: string; support: number } | undefined;
  owner: CheckTuple;
};

type Analysis = {
  groups: Group[];
  notes: Map<CheckTuple, string[]>;
};

const configuredOrder: ScaleRole[] = [
  "chip",
  "control",
  "card",
  "panel",
  "divider",
];

const excludedInputTypes = new Set([
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "hidden",
]);

function tupleSortKey(tuple: CheckTuple): string {
  return `${tuple.flow}\0${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? ""}\0${tuple.metadataPath}`;
}

function identity(observation: Observation): string {
  return `${observation.tuple.flow}\0${observation.element.structuralPath}\0${observation.element.selector}`;
}

type Side = {
  side: "top" | "right" | "bottom" | "left";
  width: number;
  color: string;
};

/** Painted border sides. */
function paintedSides(element: SignalledElement): Side[] {
  const styles = element.styles;
  return (
    [
      ["top", styles.borderTopWidth, styles.borderTopColor],
      ["right", styles.borderRightWidth, styles.borderRightColor],
      ["bottom", styles.borderBottomWidth, styles.borderBottomColor],
      ["left", styles.borderLeftWidth, styles.borderLeftColor],
    ] as const
  ).flatMap(([side, width, color]) =>
    px(width) > 0 && isPainted(color)
      ? [{ side, width: px(width), color }]
      : [],
  );
}

/**
 * The one thin painted side that makes an element a divider. A side rule on
 * a text block (a blockquote or callout's accent bar) is decoration, not a
 * divider.
 */
function dividerSide(element: SignalledElement): Side | undefined {
  const sides = paintedSides(element);
  const [only] = sides;
  if (sides.length !== 1 || only === undefined || only.width > 2)
    return undefined;
  if (
    (only.side === "left" || only.side === "right") &&
    (element.directText !== "" ||
      ["blockquote", "p", "li"].includes(element.tag))
  )
    return undefined;
  return only;
}

const controlRoles = new Set([
  "button",
  "combobox",
  "tab",
  "menuitem",
  "option",
]);
// Composite focus containers own controls; focusing them does not make
// their managed tabs, options or menu items nested control decorations.
const compositeRoles = new Set(["tablist", "listbox", "menu"]);

function defaultRole(
  element: SignalledElement,
  insideControl: boolean,
  skip: ReadonlySet<ScaleRole>,
): ScaleRole | undefined {
  const role = element.signals.role;
  if (
    !skip.has("control") &&
    (element.interactive || controlRoles.has(role)) &&
    !insideControl
  ) {
    const inputType = (element.attributes.type ?? "text").toLowerCase();
    const control =
      element.tag === "button" ||
      element.tag === "select" ||
      (element.tag === "input" &&
        !excludedInputTypes.has(inputType) &&
        !["checkbox", "radio", "slider"].includes(role)) ||
      controlRoles.has(role);
    if (control && element.inlineTextTarget !== true) return "control";
  }
  if (!skip.has("card") && (element.tag === "article" || role === "article"))
    return "card";
  if (
    !skip.has("panel") &&
    (element.tag === "dialog" ||
      element.tag === "aside" ||
      ["dialog", "alertdialog", "complementary", "menu", "listbox"].includes(
        role,
      ))
  )
    return "panel";
  if (!skip.has("divider") && !element.interactive && !insideControl) {
    if (element.tag === "hr" || role === "separator") return "divider";
    if (dividerSide(element) !== undefined) return "divider";
  }
  return undefined;
}

/** The largest corner, classified as px, full or a percentage ellipse. */
function radiusOf(element: SignalledElement): Value | undefined {
  const { width, height } = element.rect;
  const short = Math.min(width, height);
  if (short < 1) return undefined;
  const square = Math.abs(width - height) <= 1;
  const styles = element.styles;
  let largest: { value: Value; effective: number } | undefined;
  for (const corner of [
    styles.borderTopLeftRadius,
    styles.borderTopRightRadius,
    styles.borderBottomRightRadius,
    styles.borderBottomLeftRadius,
  ]) {
    const first = (corner ?? "").trim().split(/\s+/)[0] ?? "";
    const amount = Number.parseFloat(first);
    if (!Number.isFinite(amount)) continue;
    let value: Value;
    let effective: number;
    if (first.endsWith("%")) {
      effective = (amount / 100) * short;
      value =
        square && amount >= 50
          ? { kind: "full" }
          : amount === 0
            ? { kind: "px", px: 0 }
            : { kind: "ellipse", percent: round(amount) };
    } else {
      effective = amount;
      value =
        amount > 0 && amount >= short / 2 - 0.5
          ? { kind: "full", px: amount }
          : { kind: "px", px: Math.round(amount * 2) / 2 };
    }
    if (largest === undefined || effective > largest.effective)
      largest = { value, effective };
  }
  return largest?.value;
}

function stateful(element: SignalledElement): boolean {
  const attributes = element.attributes;
  return (
    ["aria-pressed", "aria-selected", "aria-checked", "aria-expanded"].some(
      (name) => attributes[name] === "true",
    ) ||
    (attributes["aria-current"] !== undefined &&
      attributes["aria-current"] !== "false")
  );
}

function borderOf(
  element: SignalledElement,
  role: ScaleRole,
): string | undefined {
  const sides = paintedSides(element);
  if (role === "divider") {
    const side = dividerSide(element);
    if (side !== undefined) return side.color;
    if (element.tag === "hr" || element.signals.role === "separator") {
      if (sides.length > 0) return sides[0]?.color;
      if (
        Math.min(element.rect.height, element.rect.width) <= 2 &&
        isPainted(element.styles.backgroundColor)
      )
        return element.styles.backgroundColor;
    }
    return undefined;
  }
  if (role !== "control" || sides.length !== 4) return undefined;
  const colors = new Set(sides.map(({ color }) => canonicalColor(color)));
  const color = sides[0]?.color;
  if (colors.size !== 1 || color === undefined) return undefined;
  // A border drawn in the control's own fill is part of the fill, and a
  // focused or selected control's border is a state, not the system's line.
  if (
    isPainted(element.styles.backgroundColor) &&
    colorDelta(color, element.styles.backgroundColor) <= 4
  )
    return undefined;
  if (element.signals.focused || stateful(element)) return undefined;
  return color;
}

function label(property: Property, value: Value): string {
  switch (value.kind) {
    case "px":
      return `${value.px}px`;
    case "full":
      return "full";
    case "ellipse":
      return `${value.percent}% (ellipse)`;
    case "color":
      return value.color;
  }
  return property;
}

function onScale(value: Value, scale: ReadonlyArray<number | string>): boolean {
  return scale.some((declared) => {
    if (value.kind === "color") {
      if (typeof declared !== "string") return false;
      const painted = composite(declared, value.backdrop);
      return (
        colorDelta(value.color, canonicalColor(declared) ?? declared) <= 4 ||
        (painted !== undefined && colorDelta(value.composite, painted) <= 4)
      );
    }
    if (declared === "full") return value.kind === "full";
    if (typeof declared !== "number") return false;
    return (
      (value.kind === "px" || value.kind === "full") &&
      value.px !== undefined &&
      Math.abs(value.px - declared) <= 0.5
    );
  });
}

function sharp(value: Value, prevailing: Value): boolean {
  if (value.kind === "color" && prevailing.kind === "color")
    return colorDelta(value.composite, prevailing.composite) >= 64;
  if (value.kind === "px" && prevailing.kind === "px") {
    if (value.px === prevailing.px) return false;
    if (value.px === 0 || prevailing.px === 0) return true;
    return value.px <= prevailing.px / 2 || value.px >= prevailing.px * 2;
  }
  if (value.kind === "full" && prevailing.kind === "full") return false;
  if (value.kind === "ellipse" && prevailing.kind === "ellipse")
    return value.percent !== prevailing.percent;
  return true;
}

function declaredScale(
  config: ChecksConfig,
  property: Property,
  role: ScaleRole,
): Array<number | string> {
  const scales = config.scales;
  if (property === "height")
    return role === "control" ? scales.controlHeights : [];
  if (property === "radius")
    return role === "divider" ? [] : scales.radius[role as RadiusRole];
  return role === "divider" || role === "control" ? scales.border[role] : [];
}

function scaleSource(property: Property, role: ScaleRole): string {
  if (property === "height") return "checks.scales.controlHeights";
  return `checks.scales.${property}.${role}`;
}

function formatScale(
  property: Property,
  scale: Array<number | string>,
): string {
  if (property === "height") return scale.join("/");
  if (property === "radius")
    return scale
      .map((value) => (typeof value === "number" ? `${value}px` : value))
      .join("/");
  return scale.join("/");
}

export function scaleMeasurements(
  tuple: CheckTuple,
  elements: SignalledElement[],
  config: ChecksConfig,
  notes: string[],
): Observation[] {
  const observation = tuple.observations;
  const marks =
    observation?.version === 2 ? (observation.selectorMarks ?? []) : [];
  const configured = new Map<ScaleRole, Set<string>>();
  const skipDefaults = new Set<ScaleRole>();
  for (const role of configuredOrder) {
    if (config.scales.roles[role].length === 0) continue;
    skipDefaults.add(role);
    const selectors = config.scales.roles[role];
    const matching = marks.filter(
      (mark) =>
        mark.purpose === `scale-${role}` && selectors.includes(mark.selector),
    );
    if (
      selectors.some(
        (selector) => !matching.some((mark) => mark.selector === selector),
      )
    ) {
      notes.push(
        `checks.scales.roles.${role} was not resolved at capture; recapture`,
      );
    }
    configured.set(role, new Set(matching.flatMap((mark) => mark.matches)));
  }
  const bySelector = new Map(
    (observation?.version === 2 ? observation.elements : elements).map(
      (element) => [element.selector, element],
    ),
  );
  const interactive = new Set(
    elements
      .filter(
        (element) =>
          controlRoles.has(element.signals.role) ||
          (element.interactive && !compositeRoles.has(element.signals.role)),
      )
      .map((element) => element.selector),
  );
  const results: Observation[] = [];
  for (const element of [...elements].sort((left, right) =>
    left.structuralPath.localeCompare(right.structuralPath),
  )) {
    if (isVisuallyHidden(element)) continue;
    if (element.rect.width <= 0 || element.rect.height <= 0) continue;
    if (["html", "body"].includes(element.tag)) continue;
    const insideControl = element.ancestorSelectors.some((selector) =>
      interactive.has(selector),
    );
    const role =
      configuredOrder.find((candidate) =>
        configured.get(candidate)?.has(element.selector),
      ) ?? defaultRole(element, insideControl, skipDefaults);
    if (role === undefined) continue;
    const push = (property: Property, value: Value) =>
      results.push({
        tuple,
        element,
        property,
        role,
        value,
        label: label(property, value),
        circle:
          value.kind === "full" &&
          Math.abs(element.rect.width - element.rect.height) <= 1,
      });
    if (role === "control" && element.signals.lineCount <= 1)
      push("height", {
        kind: "px",
        px: Math.round(element.rect.height * 2) / 2,
      });
    if (
      role !== "divider" &&
      (isBounded(element) || element.styles.boxShadow !== "none")
    ) {
      const radius = radiusOf(element);
      if (radius !== undefined) push("radius", radius);
    }
    if (role === "divider" || role === "control") {
      const color = borderOf(element, role);
      const canonical = color === undefined ? undefined : canonicalColor(color);
      const backdrop = effectiveBackground(element, bySelector);
      const painted =
        canonical === undefined ? undefined : composite(canonical, backdrop);
      const channels = painted === undefined ? undefined : parseColor(painted);
      if (canonical !== undefined && painted !== undefined && channels)
        push("border", {
          kind: "color",
          color: canonical,
          composite: painted,
          backdrop,
          surface: relativeLuminance(backdrop) > 0.4 ? "light" : "dark",
          chromatic:
            Math.max(channels.r, channels.g, channels.b) -
              Math.min(channels.r, channels.g, channels.b) >
            48,
        });
    }
  }
  return results;
}

function owner(observations: Observation[]): CheckTuple {
  return [...observations].sort((left, right) =>
    tupleSortKey(left.tuple).localeCompare(tupleSortKey(right.tuple)),
  )[0]?.tuple as CheckTuple;
}

/**
 * The prevailing value of a cohort under spacing-rhythm's support rules:
 * at least three distinct elements, at least twice everything else
 * combined, and no tie for first. Elements whose value differs between
 * states count against the prevailing value without supporting any.
 */
function prevailingOf(
  observations: Observation[],
): { value: Value; label: string; support: number } | undefined {
  const byIdentity = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = identity(observation);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), observation]);
  }
  const counts = new Map<string, { value: Value; support: number }>();
  for (const group of byIdentity.values()) {
    const labels = new Set(group.map((observation) => observation.label));
    const first = group[0];
    if (labels.size !== 1 || first === undefined) continue;
    const entry = counts.get(first.label) ?? { value: first.value, support: 0 };
    entry.support += 1;
    counts.set(first.label, entry);
  }
  const ranked = [...counts].sort(
    ([leftLabel, left], [rightLabel, right]) =>
      right.support - left.support || leftLabel.localeCompare(rightLabel),
  );
  const top = ranked[0];
  if (top === undefined) return undefined;
  const [prevailingLabel, { value, support }] = top;
  const others = byIdentity.size - support;
  if (support < 3 || support < others * 2 || ranked[1]?.[1].support === support)
    return undefined;
  return { value, label: prevailingLabel, support };
}

function analyse(
  tuples: readonly CheckTuple[],
  config: ChecksConfig,
): Analysis {
  const notes = new Map<CheckTuple, string[]>();
  const observations: Observation[] = [];
  for (const tuple of [...tuples].sort((left, right) =>
    tupleSortKey(left).localeCompare(tupleSortKey(right)),
  )) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) continue;
    const tupleNotes: string[] = [];
    observations.push(
      ...scaleMeasurements(tuple, observed.elements, config, tupleNotes),
    );
    notes.set(tuple, tupleNotes);
  }
  const groups = new Map<string, Group>();
  const add = (
    observation: Observation,
    mode: Group["mode"],
    extra: Pick<Group, "scale" | "prevailing">,
  ) => {
    const key = `${observation.property}\0${observation.role}\0${observation.label}`;
    const group = groups.get(key);
    if (group === undefined)
      groups.set(key, {
        property: observation.property,
        role: observation.role,
        label: observation.label,
        observations: [observation],
        mode,
        ...extra,
        owner: observation.tuple,
      });
    else group.observations.push(observation);
  };
  const cohorts = new Map<string, Observation[]>();
  for (const observation of observations) {
    const scale = declaredScale(config, observation.property, observation.role);
    if (scale.length > 0) {
      if (!onScale(observation.value, scale))
        add(observation, "declared", {
          scale: scale.map(String),
        });
      continue;
    }
    const surface =
      observation.value.kind === "color" ? observation.value.surface : "";
    const cohort = `${observation.property}\0${observation.role}\0${observation.tuple.width}x${observation.tuple.height}\0${surface}`;
    cohorts.set(cohort, [...(cohorts.get(cohort) ?? []), observation]);
  }
  for (const [, cohort] of [...cohorts].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const prevailing = prevailingOf(cohort);
    if (prevailing === undefined) continue;
    for (const observation of cohort)
      if (
        !observation.circle &&
        !(observation.value.kind === "color" && observation.value.chromatic) &&
        sharp(observation.value, prevailing.value)
      )
        add(observation, "undeclared", {
          prevailing: { label: prevailing.label, support: prevailing.support },
        });
  }
  for (const group of groups.values()) group.owner = owner(group.observations);
  return { groups: [...groups.values()], notes };
}

const analyses = new WeakMap<
  readonly CheckTuple[],
  { config: ChecksConfig; analysis: Analysis }
>();

function analysisFor(
  tuples: readonly CheckTuple[],
  config: ChecksConfig,
): Analysis {
  const cached = analyses.get(tuples);
  if (cached !== undefined && cached.config === config) return cached.analysis;
  const analysis = analyse(tuples, config);
  analyses.set(tuples, { config, analysis });
  return analysis;
}

const plural = (count: number, singular: string, many = `${singular}s`) =>
  count === 1 ? singular : many;

function noun(group: Group, count: number): string {
  if (group.property === "border")
    return group.role === "divider"
      ? plural(count, "divider")
      : plural(count, "control border");
  if (group.role !== "control") return plural(count, group.role);
  const tags = new Set(group.observations.map(({ element }) => element.tag));
  const [tag] = tags;
  if (
    tags.size === 1 &&
    tag !== undefined &&
    ["button", "select", "input"].includes(tag)
  )
    return plural(count, tag);
  return plural(count, "control");
}

function roleNoun(group: Group): string {
  if (group.property === "border")
    return group.role === "divider" ? "dividers" : "control borders";
  return `${group.role}s`;
}

function measured(group: Group, value: string): string {
  if (group.property === "radius") return `radius ${value}`;
  return value;
}

function candidateFor(group: Group): FindingCandidate {
  const members = new Map<string, Observation>();
  for (const observation of [...group.observations].sort((left, right) =>
    left.element.structuralPath.localeCompare(right.element.structuralPath),
  ))
    if (!members.has(identity(observation)))
      members.set(identity(observation), observation);
  const ordered = [...members.values()];
  const count = ordered.length;
  const selectors = [
    ...new Set(ordered.map(({ element }) => element.selector)),
  ];
  const examples = `${selectors.slice(0, 3).join(", ")}${selectors.length > 3 ? ", …" : ""}`;
  const first = selectors[0] ?? "document";
  const what = `${count} ${noun(group, count)} at ${measured(group, group.label)}`;
  const rule =
    group.mode === "undeclared"
      ? "idiom:scale-outlier"
      : `idiom:off-scale-${group.property}`;
  let explanation: string;
  let acceptance: string;
  let reference: Record<string, unknown>;
  if (group.mode === "declared") {
    const scale = formatScale(
      group.property,
      (group.scale ?? []).map((value) =>
        Number.isFinite(Number(value)) ? Number(value) : value,
      ),
    );
    explanation = `${what}; scale is ${scale} (${scaleSource(group.property, group.role)}). For example ${examples}.`;
    acceptance = `No ${group.role} renders at ${measured(group, group.label)}; use a declared value (${scale}).`;
    reference = { scale: group.scale };
  } else {
    const prevailing = group.prevailing as NonNullable<Group["prevailing"]>;
    explanation = `${what}; the run's ${roleNoun(group)} are ${measured(group, prevailing.label)} (${prevailing.support} ${roleNoun(group)}). For example ${examples}.`;
    acceptance = `No ${group.role} renders at ${measured(group, group.label)}; it matches the run's prevailing ${measured(group, prevailing.label)}.`;
    reference = { prevailing: prevailing.label };
  }
  return {
    category: "scale-conformance",
    severity: "minor",
    rule,
    selectorHint: first,
    fingerprintHint: `scale:${group.property}:${group.role}:${group.label}`,
    explanation,
    acceptance: [acceptance],
    verification: verify("scale-conformance", {
      property: group.property,
      role: group.role,
      value: group.label,
      ...reference,
    }),
    evidenceTuples: [
      ...new Set(
        [...group.observations]
          .sort((left, right) =>
            tupleSortKey(left.tuple).localeCompare(tupleSortKey(right.tuple)),
          )
          .map(({ tuple }) => tuple),
      ),
    ],
  };
}

/**
 * Control heights, corner radius by role and border colour by role judged
 * against the scales the project declares, or, when it declares none,
 * against what the run itself does most of the time (sharp outliers only).
 * The analysis is run-wide; each finding is emitted once, from the first
 * tuple where its value occurs.
 */
export const scaleConformanceCheck: DeterministicCheck = {
  id: "scale-conformance",
  run({ tuple, config, tuples }): CheckResult {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const analysis = analysisFor(
      tuples?.includes(tuple) ? tuples : [tuple],
      config,
    );
    const notes = [...(analysis.notes.get(tuple) ?? [])];
    if (
      config.scales.spacing?.length &&
      (tuple.observations?.version !== 2 ||
        tuple.observations.elements.some(
          (e) => e.visible && e.authoredProperties === undefined,
        ))
    )
      notes.push(
        "Authored spacing coverage unavailable for legacy elements; recapture",
      );
    const candidates = analysis.groups
      .filter((group) => group.owner === tuple)
      .map(candidateFor);
    candidates.push(
      ...(spacingFindings(
        tuples?.includes(tuple) ? tuples : [tuple],
        config.scales.spacing,
      ).get(tuple) ?? []),
    );
    return {
      coverage: {
        check: this.id,
        status: "ran",
        ...(notes.length === 0 ? {} : { reason: notes.join("; ") }),
      },
      candidates,
    };
  },
};
