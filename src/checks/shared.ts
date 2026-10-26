import type {
  CheckResult,
  CheckTuple,
  DeterministicCheckId,
  FindingCandidate,
  ObservedElement,
  ObservedElementV2,
  Rect,
} from "./types.js";

export type AxeNode = {
  target?: unknown;
  html?: unknown;
  failureSummary?: unknown;
  any?: unknown;
  all?: unknown;
  none?: unknown;
};

export type AxeViolation = {
  id: string;
  impact?: string | null | undefined;
  nodes: AxeNode[];
};

/** Tags whose text is code or user input, not authored copy. */
export const codeTags: ReadonlySet<string> = new Set([
  "code",
  "pre",
  "kbd",
  "samp",
  "var",
  "script",
  "style",
  "textarea",
  "input",
]);

export function axeViolations(value: unknown): AxeViolation[] {
  if (value === null || typeof value !== "object") return [];
  const raw = (value as { violations?: unknown }).violations;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as { id?: unknown; impact?: unknown; nodes?: unknown };
    if (typeof record.id !== "string" || !Array.isArray(record.nodes))
      return [];
    return [
      {
        id: record.id,
        ...(typeof record.impact === "string" || record.impact === null
          ? { impact: record.impact }
          : {}),
        nodes: record.nodes.filter(
          (node): node is AxeNode => node !== null && typeof node === "object",
        ),
      },
    ];
  });
}

export function axeSelector(node: AxeNode): string {
  if (Array.isArray(node.target)) {
    return node.target.map(String).join(" > ");
  }
  return typeof node.target === "string" ? node.target : "document";
}

export function axeSeverity(
  impact: string | null | undefined,
): "major" | "minor" {
  return impact === "critical" || impact === "serious" ? "major" : "minor";
}

export function unavailable(
  check: DeterministicCheckId,
  reason: string,
): CheckResult {
  return { coverage: { check, status: "unavailable", reason }, candidates: [] };
}

export function ran(
  check: DeterministicCheckId,
  candidates: FindingCandidate[],
): CheckResult {
  return { coverage: { check, status: "ran" }, candidates };
}

export function verify(
  check: DeterministicCheckId,
  params?: Record<string, unknown>,
) {
  return { check, ...(params === undefined ? {} : { params }) };
}

export function isVisuallyHidden(element: ObservedElement): boolean {
  return (
    element.outOfFlow &&
    element.rect.width <= 1 &&
    element.rect.height <= 1 &&
    ["hidden", "clip"].includes(element.styles.overflowX) &&
    ["hidden", "clip"].includes(element.styles.overflowY)
  );
}

export type SignalledElement = ObservedElementV2 & {
  signals: NonNullable<ObservedElementV2["signals"]>;
};

/**
 * Elements carrying the 0.3 signals, or a reason the check cannot run. Runs
 * captured before 0.3 lack signals; the check then says so in coverage
 * instead of passing silently.
 */
export function signalledElements(
  tuple: CheckTuple,
): { elements: SignalledElement[] } | { reason: string } {
  const observation = tuple.observations;
  if (observation === undefined)
    return { reason: "observations.json is unavailable" };
  if (observation.version !== 2)
    return { reason: "observations predate element signals (recapture)" };
  const elements = observation.elements.filter(
    (element): element is SignalledElement =>
      element.signals !== undefined && element.visible,
  );
  if (
    elements.length === 0 &&
    observation.elements.some((element) => element.visible)
  )
    return { reason: "observations predate element signals (recapture)" };
  return { elements };
}

export function px(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseColor(
  value: string,
): { r: number; g: number; b: number; a: number } | undefined {
  const match = value
    .trim()
    .match(
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i,
    );
  if (match === null) return undefined;
  const alpha = match[4];
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a:
      alpha === undefined
        ? 1
        : alpha.endsWith("%")
          ? Number(alpha.slice(0, -1)) / 100
          : Number(alpha),
  };
}

/**
 * A configured colour: #rgb, #rgba, #rrggbb, #rrggbbaa, or the rgb()/rgba()
 * forms {@link parseColor} reads from computed styles.
 */
export function parseCssColor(
  value: string,
): { r: number; g: number; b: number; a: number } | undefined {
  const hex = value.trim().match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex === null) return parseColor(value);
  const digits = hex[1] ?? "";
  const pairs =
    digits.length <= 4
      ? [...digits].map((digit) => digit + digit)
      : (digits.match(/../g) ?? []);
  const [r, g, b, a] = pairs.map((pair) => Number.parseInt(pair, 16));
  if (r === undefined || g === undefined || b === undefined) return undefined;
  return { r, g, b, a: a === undefined ? 1 : round(a / 255, 3) };
}

/** A colour as computed styles print it: rgb(r, g, b) or rgba(r, g, b, a). */
export function canonicalColor(value: string): string | undefined {
  const color = parseCssColor(value);
  if (color === undefined) return undefined;
  const [r, g, b] = [color.r, color.g, color.b].map((channel) =>
    Math.round(channel),
  );
  return color.a >= 1
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${round(color.a, 3)})`;
}

/**
 * Largest channel difference between two computed colours (0–255). Two
 * effectively transparent colours are equal; an alpha shift of 0.15 or more
 * always counts as at least 255 × 0.15. Unparseable values compare by string.
 */
export function colorDelta(a: string, b: string): number {
  const left = parseColor(a);
  const right = parseColor(b);
  if (left === undefined || right === undefined)
    return a.trim() === b.trim() ? 0 : Number.POSITIVE_INFINITY;
  if (left.a <= 0.05 && right.a <= 0.05) return 0;
  const alpha = Math.abs(left.a - right.a) * 255;
  // Premultiply so a colour fading toward transparent reads as fading.
  const channel = Math.max(
    Math.abs(left.r * left.a - right.r * right.a),
    Math.abs(left.g * left.a - right.g * right.a),
    Math.abs(left.b * left.a - right.b * right.a),
  );
  return Math.max(alpha, channel);
}

export function isPainted(color: string): boolean {
  const parsed = parseColor(color);
  return parsed === undefined ? color !== "transparent" : parsed.a > 0.05;
}

/** A visible edge: a painted fill or a painted border on any side. */
export function isBounded(element: ObservedElementV2): boolean {
  const styles = element.styles;
  if (isPainted(styles.backgroundColor)) return true;
  return (
    [
      [styles.borderTopWidth, styles.borderTopColor],
      [styles.borderRightWidth, styles.borderRightColor],
      [styles.borderBottomWidth, styles.borderBottomColor],
      [styles.borderLeftWidth, styles.borderLeftColor],
    ] as const
  ).some(([width, color]) => px(width) > 0 && isPainted(color));
}

export function interactiveAncestry(
  elements: readonly ObservedElementV2[],
): (element: ObservedElementV2) => boolean {
  const interactive = new Set(
    elements
      .filter((element) => element.interactive)
      .map((element) => element.selector),
  );
  return (element) =>
    element.interactive ||
    element.ancestorSelectors.some((selector) => interactive.has(selector));
}

export function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

type Rgb = { r: number; g: number; b: number };

/** WCAG relative luminance of an sRGB colour. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (left, right) => right - left,
  ) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The first painted background behind an element: its own, then its
 * ancestors', then the page's. When everything up to the root is transparent
 * the canvas is assumed white, which is what browsers paint by default.
 */
export function effectiveBackground(
  element: ObservedElementV2,
  bySelector: ReadonlyMap<string, ObservedElementV2>,
  roots: readonly ObservedElementV2[] = [],
): Rgb {
  const chain = [
    element,
    ...element.ancestorSelectors.flatMap((selector) => {
      const ancestor = bySelector.get(selector);
      return ancestor === undefined ? [] : [ancestor];
    }),
    ...roots,
  ];
  for (const candidate of chain) {
    const color = parseColor(candidate.styles.backgroundColor);
    if (color !== undefined && color.a > 0.05)
      return { r: color.r, g: color.g, b: color.b };
  }
  return { r: 255, g: 255, b: 255 };
}

export type Facing = "horizontal" | "vertical";

/**
 * How two boxes face each other: side by side or stacked, with the gap
 * between their facing edges, or undefined when they do not face.
 */
export function relation(
  a: Rect,
  b: Rect,
): { axis: Facing; gap: number; overlap: number } | undefined {
  const overlapY =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const minHeight = Math.min(a.height, b.height);
  const minWidth = Math.min(a.width, b.width);
  if (overlapY >= minHeight * 0.5 && overlapX <= 1) {
    const gap = a.x < b.x ? b.x - (a.x + a.width) : a.x - (b.x + b.width);
    return { axis: "horizontal", gap, overlap: overlapY };
  }
  if (overlapX >= minWidth * 0.5 && overlapY <= 1) {
    const gap = a.y < b.y ? b.y - (a.y + a.height) : a.y - (b.y + b.height);
    return { axis: "vertical", gap, overlap: overlapX };
  }
  return undefined;
}

/** Hue in degrees [0, 360), saturation and lightness in [0, 1]. */
export function hsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === red
      ? ((green - blue) / d + 6) % 6
      : max === green
        ? (blue - red) / d + 2
        : (red - green) / d + 4;
  return { h: h * 60, s, l };
}

/** Coverage for a check whose `checks.<key>.enabled` is false. */
export function skipped(check: DeterministicCheckId, key: string): CheckResult {
  return {
    coverage: {
      check,
      status: "skipped",
      reason: `checks.${key} is not enabled`,
    },
    candidates: [],
  };
}

/**
 * A partial or unavailable scan still emits what it found, but coverage says
 * the scan was incomplete so a clean result is not read as a pass.
 */
export function scanResult(
  check: DeterministicCheckId,
  candidates: FindingCandidate[],
  scan: { status: string; reason?: string | undefined },
): CheckResult {
  const result = ran(check, candidates);
  if (scan.status !== "ran")
    result.coverage = {
      check,
      status: "unavailable",
      reason: scan.reason ?? "the scan was incomplete",
    };
  return result;
}

/** v2 observation evidence for a check, or undefined (older capture). */
export function v2Observations(tuple: CheckTuple) {
  const observation = tuple.observations;
  return observation?.version === 2 ? observation : undefined;
}
