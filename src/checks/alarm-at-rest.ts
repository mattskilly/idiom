import {
  canonicalColor,
  colorDelta,
  hsl,
  isVisuallyHidden,
  parseColor,
  parseCssColor,
  ran,
  type SignalledElement,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  ObservedElementV2,
} from "./types.js";

/** Warning/error symbols. ⓧ and ✖ are left out: they mean close/remove. */
const alarmGlyph = /⚠|❗|❕|‼|⛔|\u{1F6D1}/u;
const alarmHint = /\b(warn(ing)?|alert|error|danger|exclamation|caution)\b/;
const errorStateId =
  /error|invalid|fail|warn|conflict|expired|denied|offline|overdue|alert/i;
const statusText =
  /\b(error|failed|invalid|required|warning|expired|overdue|conflict|unable|can(?:'|’)t|couldn(?:'|’)t|missing|denied|not saved)\b/i;
const destructive = /\b(delete|remove|discard|destroy|revoke|disconnect)\b/i;
const alarmTokenName =
  /warn|error|danger|alert|destruct|critical|negative|caution/i;

/** Within this of a configured alarm colour counts as that colour. */
const configuredDelta = 24;
/** Within this of a brand colour is a brand choice, not an alarm. */
const brandDelta = 48;

export function isIconLike(
  element: ObservedElementV2,
  bySelector: ReadonlyMap<string, ObservedElementV2>,
): boolean {
  const ancestors = element.ancestorSelectors.map((selector) =>
    bySelector.get(selector),
  );
  if (element.tag === "svg")
    return !ancestors.some((ancestor) => ancestor?.tag === "svg");
  if (ancestors.some((ancestor) => ancestor?.tag === "svg")) return false;
  if (element.signals?.alarm !== undefined) return true;
  if (element.tag === "i") return true;
  if (/icon/i.test(element.attributes.class ?? "")) return true;
  const direct = element.directText.replace(/\s|\uFE0E|\uFE0F/g, "");
  return (
    direct !== "" && [...direct].length <= 3 && !/[\p{L}\p{N}]/u.test(direct)
  );
}

/**
 * Saturated red or amber, the hues readers take as error/warning. Amber is
 * also a common brand, rating and "in progress" colour, so only red is
 * judged without configuration; amber needs checks.alarm.colors.
 */
export function alarmHue(color: {
  r: number;
  g: number;
  b: number;
}): "red" | "amber" | undefined {
  const { h, s, l } = hsl(color);
  if (s < 0.5 || l < 0.25 || l > 0.7) return undefined;
  if (h >= 345 || h < 20) return "red";
  return h <= 50 ? "amber" : undefined;
}

/** Roughly square and no larger than 32px: an icon, not a logo or artwork. */
function iconSized(element: ObservedElementV2): boolean {
  const { width, height } = element.rect;
  return (
    width > 0 &&
    height > 0 &&
    width <= 32 &&
    height <= 32 &&
    Math.max(width, height) / Math.min(width, height) <= 2
  );
}

type Group = {
  rule: string;
  label: string;
  params: Record<string, unknown>;
  selectors: string[];
};

type Ink = { color: string; rgb: { r: number; g: number; b: number } };

/** The colours an icon paints: text colour, or an svg's fills and strokes. */
function inkOf(
  element: SignalledElement,
  descendants: readonly ObservedElementV2[],
): Ink[] {
  const values =
    element.tag === "svg"
      ? [element, ...descendants].flatMap((node) => [
          node.styles.fill,
          node.styles.stroke,
        ])
      : [element.styles.color];
  const inks: Ink[] = [];
  for (const value of new Set(values)) {
    const parsed = parseColor(value);
    if (parsed === undefined || parsed.a < 0.3) continue;
    inks.push({ color: value, rgb: parsed });
  }
  return inks;
}

/**
 * Warning/error styling on an icon with nothing wrong around it: a ⚠ or an
 * alert-named icon, or red/amber ink far from the brand palette, on a
 * resting element with no aria-invalid, role=alert, status text or error
 * state. Resting and unset states should look neutral.
 */
export const alarmAtRestCheck: DeterministicCheck = {
  id: "alarm-at-rest",
  run({ tuple, config }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const observation = tuple.observations;
    if (observation?.version !== 2)
      return unavailable(this.id, "observations.json is unavailable");
    const bySelector = new Map(
      observation.elements.map((element) => [element.selector, element]),
    );
    const icons = observed.elements.filter(
      (element) =>
        !isVisuallyHidden(element) && isIconLike(element, bySelector),
    );
    if (
      icons.length > 0 &&
      !icons.some((element) => element.signals.alarm !== undefined)
    )
      return unavailable(
        this.id,
        "observations predate alarm signals (recapture)",
      );
    if (errorStateId.test(tuple.state)) return ran(this.id, []);

    const configured = config.alarm.colors.flatMap((value) => {
      const color = canonicalColor(value);
      return color === undefined ? [] : [color];
    });
    const brand = [
      ...config.alarm.brand,
      ...(observation.tokens.status === "configured"
        ? Object.entries(observation.tokens.declarations)
            .filter(([name]) => !alarmTokenName.test(name))
            .map(([, value]) => value)
        : []),
    ].flatMap((value) => {
      const color =
        parseCssColor(value) === undefined ? undefined : canonicalColor(value);
      return color === undefined ? [] : [color];
    });
    const patterns = [
      statusText,
      ...config.errorPatterns.flatMap((pattern) => {
        try {
          return [new RegExp(pattern, "i")];
        } catch {
          return [];
        }
      }),
    ];
    const ignored = new Set(
      (observation.selectorMarks ?? [])
        .filter((mark) => mark.purpose === "alarm-ignore")
        .flatMap((mark) => mark.matches),
    );
    const descendantsOf = (selector: string) =>
      observation.elements.filter(
        (element) =>
          element.visible && element.ancestorSelectors.includes(selector),
      );

    const exempt = (element: SignalledElement): boolean => {
      if (element.signals.alarm?.context === true) return true;
      if (
        ignored.has(element.selector) ||
        element.ancestorSelectors.some((selector) => ignored.has(selector))
      )
        return true;
      const ancestors = element.ancestorSelectors.flatMap((selector) => {
        const ancestor = bySelector.get(selector);
        return ancestor === undefined ? [] : [ancestor];
      });
      const speaker = ancestors
        .slice(0, 3)
        .find((ancestor) => /\p{L}{2}/u.test(ancestor.text));
      if (
        speaker !== undefined &&
        patterns.some((pattern) => pattern.test(speaker.text))
      )
        return true;
      return [element, ...ancestors].some(
        (node) =>
          node.interactive &&
          destructive.test(
            `${node.signals?.name ?? ""} ${node.attributes["aria-label"] ?? ""}`,
          ),
      );
    };

    const groups = new Map<string, Group>();
    const add = (
      key: string,
      group: Omit<Group, "selectors">,
      selector: string,
    ) => {
      const existing = groups.get(key) ?? { ...group, selectors: [] };
      existing.selectors.push(selector);
      groups.set(key, existing);
    };

    for (const element of icons) {
      if (element.signals.alarm === undefined) continue;
      if (element.tag !== "svg" && /\p{L}{2}/u.test(element.text)) continue;
      const text = element.directText.replace(/\s|\uFE0E|\uFE0F/g, "");
      const glyph = [...text].find((symbol) => alarmGlyph.test(symbol));
      const hint = element.signals.alarm.iconHint?.match(alarmHint)?.[1];
      const painted =
        glyph === undefined && hint === undefined
          ? inkOf(element, descendantsOf(element.selector))
          : [];
      // Two or more hues in one graphic is a logo or illustration, not a
      // monochrome status icon.
      const hues = new Set(
        painted.flatMap(({ rgb }) => {
          const { h, s } = hsl(rgb);
          return s >= 0.25 ? [Math.round(h / 30) % 12] : [];
        }),
      );
      const inks =
        hues.size <= 1
          ? painted.filter(
              (ink) =>
                configured.some(
                  (color) => colorDelta(ink.color, color) <= configuredDelta,
                ) ||
                (alarmHue(ink.rgb) === "red" &&
                  iconSized(element) &&
                  !brand.some(
                    (color) => colorDelta(ink.color, color) <= brandDelta,
                  )),
            )
          : [];
      if (glyph === undefined && hint === undefined && inks.length === 0)
        continue;
      if (exempt(element)) continue;
      if (glyph !== undefined) {
        const code = `U+${(glyph.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
        add(
          `glyph:${glyph}`,
          {
            rule: "idiom:alarm-glyph-at-rest",
            label: `the warning glyph "${glyph}" (${code})`,
            params: { glyph },
          },
          element.selector,
        );
      } else if (hint !== undefined) {
        add(
          `hint:${hint}`,
          {
            rule: "idiom:alarm-glyph-at-rest",
            label: `a "${hint}" icon`,
            params: { iconHint: hint },
          },
          element.selector,
        );
      } else {
        const ink = inks[0] as Ink;
        const color = canonicalColor(ink.color) ?? ink.color;
        add(
          `color:${color}`,
          {
            rule: "idiom:alarm-color-at-rest",
            label: `warning/error colour ${color}`,
            params: { color },
          },
          element.selector,
        );
      }
    }

    const candidates: FindingCandidate[] = [];
    for (const { rule, label, params, selectors } of groups.values()) {
      const first = selectors[0];
      if (first === undefined) continue;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule,
        selectorHint: first,
        explanation: `${label[0]?.toUpperCase()}${label.slice(1)} marks ${selectors.length} icon${selectors.length === 1 ? "" : "s"} (${selectors.slice(0, 4).join(", ")}${selectors.length > 4 ? ", …" : ""}) with no error or warning around ${selectors.length === 1 ? "it" : "them"} — the alarm semantics read as a problem in a resting state.`,
        acceptance: [
          "Resting/unset states use a neutral icon and colour; warning/error styling appears only with an error or warning (aria-invalid, role=alert, status text, or an error state).",
        ],
        verification: verify(this.id, params),
      });
    }
    return ran(this.id, candidates);
  },
};
