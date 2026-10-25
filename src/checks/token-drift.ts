import { parseCssColor, ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, ObservedElement } from "./types.js";

const transparent = new Set([
  "transparent",
  "rgba(0, 0, 0, 0)",
  "rgba(0,0,0,0)",
  "none",
]);

export function contributingStyles(
  element: ObservedElement,
): Array<[string, string]> {
  const styles = element.styles;
  const authored = (property: string) =>
    element.authoredProperties === undefined ||
    element.authoredProperties.includes(property);
  const contributes = (property: string, value: string) =>
    authored(property) &&
    value !== "" &&
    !transparent.has(value) &&
    value !== "0px";
  const values = (
    [
      ["color", styles.color],
      ["backgroundColor", styles.backgroundColor],
      ["fill", styles.fill],
      ["stroke", styles.stroke],
    ] as Array<[string, string]>
  ).filter(([property, value]) => contributes(property, value));
  const borders: Array<[string, string]> = [];
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    const width = styles[`border${side}Width`];
    const property = `border${side}Color` as const;
    const value = styles[property];
    if (Number.parseFloat(width) > 0 && contributes(property, value))
      borders.push([property, value]);
  }
  if (
    borders.length === 4 &&
    new Set(borders.map(([, value]) => value)).size === 1
  )
    values.push(["borderColor", borders[0]?.[1] ?? ""]);
  else values.push(...borders);
  if (
    styles.outlineStyle !== undefined &&
    !["none", "hidden"].includes(styles.outlineStyle) &&
    Number.parseFloat(styles.outlineWidth) > 0 &&
    contributes("outlineColor", styles.outlineColor)
  )
    values.push(["outlineColor", styles.outlineColor]);
  const radii: Array<[string, string]> = [];
  for (const corner of [
    "TopLeft",
    "TopRight",
    "BottomRight",
    "BottomLeft",
  ] as const) {
    const property = `border${corner}Radius` as const;
    const value = styles[property];
    if (Number.parseFloat(value) > 0 && contributes(property, value))
      radii.push([property, value]);
  }
  if (radii.length === 4 && new Set(radii.map(([, value]) => value)).size === 1)
    values.push(["borderRadius", radii[0]?.[1] ?? ""]);
  else values.push(...radii);
  return values;
}

function coveredValue(
  kind: "radius" | "color",
  declared: string,
  value: string,
  element: ObservedElement,
): boolean {
  if (declared === value) return true;
  if (kind === "color") {
    const a = parseCssColor(declared),
      b = parseCssColor(value);
    return (
      a !== undefined &&
      b !== undefined &&
      Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) <=
        1 &&
      Math.abs(a.a - b.a) < 0.01
    );
  }
  if (declared === "full")
    return (
      (/^[\d.]+px$/.test(value) &&
        Number(value.slice(0, -2)) >=
          Math.min(element.rect.width, element.rect.height) / 2 - 0.5) ||
      (value === "50%" &&
        Math.abs(element.rect.width - element.rect.height) <= 1)
    );
  return (
    /^[\d.]+px$/.test(value) &&
    /^[\d.]+px$/.test(declared) &&
    Math.abs(Number(value.slice(0, -2)) - Number(declared.slice(0, -2))) <= 0.5
  );
}

export const tokenDriftCheck: DeterministicCheck = {
  id: "token-drift",
  run({ tuple }) {
    const observations = tuple.observations;
    if (observations === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observations.tokens.status === "not-configured") {
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "design.tokensFile is not configured",
        },
        candidates: [],
      };
    }
    const allowed = new Set(observations.tokens.normalizedValues);
    const candidates = [];
    for (const element of observations.elements) {
      if (!element.visible) continue;
      for (const [property, value] of contributingStyles(element)) {
        const kind = property.toLowerCase().includes("radius")
          ? "radius"
          : "color";
        const typed = observations.tokens.typedValues;
        if (typed !== undefined) {
          const applicable = typed.filter((t) => t.kind === kind);
          if (
            applicable.length === 0 ||
            applicable.some((t) => coveredValue(kind, t.value, value, element))
          )
            continue;
        } else if (allowed.has(value)) continue;
        candidates.push({
          category: this.id,
          severity: "minor" as const,
          rule: "idiom:token-drift",
          selectorHint: `${element.selector}::${property}`,
          explanation: `${element.selector} renders ${property} as ${value}, which does not resolve to a value declared in ${observations.tokens.source}.`,
          acceptance: [
            `${element.selector}'s ${property} resolves to a declared design-token value.`,
          ],
          verification: verify(this.id, {
            selector: element.selector,
            property,
          }),
        });
      }
    }
    const result = ran(this.id, candidates);
    if (observations.tokens.typedValues?.length === 0)
      result.coverage.reason =
        "No usable typed token values for this capture; recapture after learning.";
    return result;
  },
};
