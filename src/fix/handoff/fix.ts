import type { BasisDetails } from "../../schemas/acceptance.js";

type Measurement = Record<string, unknown>;

/** The CSS property a spacing check measures, by check id. */
const measuredProperty: Record<string, string> = {
  "adjacent-gap": "gap",
  "control-gap": "gap",
  "spacing-rhythm": "spacing",
  "negative-spacing": "margin",
  "cramped-padding": "padding",
};

const valueKeys = ["gap", "value", "measured", "actual"] as const;
const targetKeys = [
  "min",
  "minimum",
  "expected",
  "prevailing",
  "nearest",
] as const;

const px = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value}px`
    : typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : undefined;

function measurementOf(
  basisDetails: BasisDetails | undefined,
): Measurement | undefined {
  return basisDetails?.kind === "measured"
    ? (basisDetails.measurement as Measurement | undefined)
    : undefined;
}

/**
 * The measured value of a finding: a numeric measurement the check recorded,
 * else the first "<n>px apart" the check stated in its own summary.
 */
export function measuredValue(
  basisDetails: BasisDetails | undefined,
  summary: string,
): string | undefined {
  const measurement = measurementOf(basisDetails);
  for (const key of valueKeys) {
    const value = px(measurement?.[key]);
    if (value !== undefined) return value;
  }
  const stated = /(-?\d+(?:\.\d+)?)px apart/.exec(summary);
  return stated ? `${stated[1]}px` : undefined;
}

/** The value a check wants instead, when it recorded one. */
export function measuredTarget(
  basisDetails: BasisDetails | undefined,
): string | undefined {
  const measurement = measurementOf(basisDetails);
  for (const key of targetKeys) {
    const value = px(measurement?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * One concrete edit for a finding: its root cause's fix when it belongs to
 * one; else the measured property moved from its value to the check's target;
 * else the first acceptance criterion as the thing to make true.
 */
export function suggestedFix(options: {
  category: string;
  selector: string;
  basisDetails?: BasisDetails | undefined;
  summary: string;
  doneWhen: string[];
  rootCauseFix?: string | undefined;
  suggestedArea?: string | undefined;
}): string {
  const area =
    options.suggestedArea === undefined
      ? ""
      : ` Likely in ${options.suggestedArea}.`;
  if (options.rootCauseFix !== undefined)
    return `${options.rootCauseFix.replace(/\.$/, "")}.${area}`;
  const value = measuredValue(options.basisDetails, options.summary);
  const target = measuredTarget(options.basisDetails);
  const property = measuredProperty[options.category];
  if (value !== undefined && target !== undefined && property !== undefined) {
    const measurement = measurementOf(options.basisDetails);
    const owner =
      property === "gap" && typeof measurement?.parent === "string"
        ? measurement.parent
        : options.selector;
    const floor = targetKeys
      .slice(0, 2)
      .some((key) => measurement?.[key] !== undefined)
      ? "at least "
      : "";
    return `Change ${property} on \`${owner}\` from ${value} to ${floor}${target}.${area}`;
  }
  const done = options.doneWhen[0];
  return done === undefined
    ? `Repair ${options.category} on \`${options.selector}\`.${area}`
    : `Make this true: ${done}${area}`;
}
