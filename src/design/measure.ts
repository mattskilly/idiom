import { isVisuallyHidden, parseCssColor } from "../checks/shared.js";
import type {
  ChecksConfig,
  FindingCandidate,
  ObservationArtifactV2,
  ObservedElementV2,
  RadiusRole,
} from "../checks/types.js";
import {
  componentToleranceDefault,
  type DesignDriftConfig,
  designDriftConfigSchema,
} from "../schemas/design.js";
import type { DesignDriftEvidence } from "../schemas/finding.js";
import {
  contentElements,
  isFigma,
  matchElements,
  nodeKey,
  normalizeText,
} from "./match.js";
import type { DesignMatches, DesignPair } from "./types.js";

export function numericAllowance(
  value: number,
  tolerance: {
    ratio: number;
    px: number;
    mode?: "tighter" | "looser" | undefined;
  },
): number {
  return (tolerance.mode === "tighter" ? Math.min : Math.max)(
    Math.abs(value) * tolerance.ratio,
    tolerance.px,
  );
}
export type Policy =
  | "size"
  | "position"
  | "gap"
  | "radius"
  | "borderWidth"
  | "fontSize"
  | "lineHeight";
const numberValue = (value: string | number): number | undefined =>
  typeof value === "number"
    ? value
    : /^[-+]?(?:\d*\.)?\d+(?:px)?$/i.test(value.trim())
      ? Number.parseFloat(value)
      : undefined;
export function normalizeFamily(value: string): string {
  return value
    .split(",")
    .map((name) =>
      name
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase(),
    )
    .join(",");
}
export function designColor(value: string) {
  const hex = /^#([a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(value.trim());
  if (!hex?.[1]) return parseCssColor(value);
  const expanded =
    hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
    a:
      expanded.length === 8
        ? Number.parseInt(expanded.slice(6, 8), 16) / 255
        : 1,
  };
}
export function normalizeColor(value: string): string {
  const color = designColor(value);
  return color
    ? JSON.stringify(
        [color.r, color.g, color.b, color.a * 255].map(
          (n) => Math.round(n * 10000) / 10000,
        ),
      )
    : value.trim().toLowerCase();
}
export function crossesStep(
  design: number,
  app: number,
  scale: number[],
): boolean {
  const ordered = [...new Set(scale)].sort((a, b) => a - b);
  const next =
    app > design
      ? ordered.find((v) => v > design)
      : ordered.filter((v) => v < design).at(-1);
  return (
    next !== undefined && Math.abs(app - design) >= Math.abs(next - design)
  );
}
function scaleFor(
  property: string,
  d: ObservedElementV2,
  a: ObservedElementV2,
  design: ObservationArtifactV2,
  app: ObservationArtifactV2,
  config: ChecksConfig,
  dv: number,
  av: number,
): number[] {
  if (/^(gap|position)/.test(property)) {
    const values: number[] = [];
    for (const entry of config.scales.spacing) {
      if (typeof entry === "number") values.push(entry);
      else {
        // Only the adjacent steps near the measured range are needed.
        const lo = Math.floor(Math.min(dv, av) / entry.multipleOf),
          hi = Math.ceil(Math.max(dv, av) / entry.multipleOf);
        values.push(
          Math.max(0, lo - 1) * entry.multipleOf,
          lo * entry.multipleOf,
          (lo + 1) * entry.multipleOf,
          hi * entry.multipleOf,
          (hi + 1) * entry.multipleOf,
        );
      }
    }
    return values;
  }
  if (property === "height" && d.interactive)
    return config.scales.controlHeights;
  if (/Radius$/.test(property)) {
    const roles: RadiusRole[] = ["chip", "control", "card", "panel"];
    const role =
      roles.find((role) =>
        [design, app].some((obs) =>
          obs.selectorMarks?.some(
            (mark) =>
              mark.purpose === `scale-${role}` &&
              mark.matches.includes(obs === design ? d.selector : a.selector),
          ),
        ),
      ) ?? (d.interactive ? "control" : undefined);
    return role
      ? config.scales.radius[role].map((v) =>
          v === "full" ? Math.min(d.rect.width, d.rect.height) / 2 : v,
        )
      : [];
  }
  return [];
}

/** One compared property of one matched pair, whether or not it drifted. */
export type Comparison = {
  /** App element, property and app neighbour: the same key across references. */
  key: string;
  pair: DesignPair;
  property: string;
  designValue: string | number;
  appValue: string | number;
  kind: "numeric" | "color" | "string";
  policy?: Policy | undefined;
  basis?: number | undefined;
  allowance?: number | undefined;
  within: boolean;
  /** The fingerprint hint a drift candidate for this comparison carries. */
  hint: string;
  neighbour?: DesignDriftEvidence["neighbour"] | undefined;
  layerPath?: string | undefined;
  link?: string | undefined;
  /** The drift candidate this comparison emitted; absent when within tolerance. */
  candidate?: FindingCandidate | undefined;
};

/** Tolerance allowance for a numeric design value under a property policy. */
export function policyAllowance(
  config: ChecksConfig,
  policy: Policy,
  basis: number,
): number {
  const settings: DesignDriftConfig =
    config.designDrift ?? designDriftConfigSchema.parse({});
  const tolerance = {
    ...componentToleranceDefault,
    ...settings.tolerance,
    ...settings[policy],
  };
  return numericAllowance(basis, {
    ratio: tolerance.ratio ?? componentToleranceDefault.ratio,
    px: tolerance.px ?? componentToleranceDefault.px,
    mode: tolerance.mode ?? componentToleranceDefault.mode,
  });
}

/** Whether two design values for the same comparison agree within its policy. */
export function designValuesAgree(
  first: Comparison,
  second: Comparison,
  config: ChecksConfig,
): boolean {
  const settings: DesignDriftConfig =
    config.designDrift ?? designDriftConfigSchema.parse({});
  if (first.kind === "color") {
    const a = designColor(String(first.designValue)),
      b = designColor(String(second.designValue));
    if (!a || !b)
      return (
        normalizeColor(String(first.designValue)) ===
        normalizeColor(String(second.designValue))
      );
    return (
      Math.max(
        Math.abs(a.r - b.r),
        Math.abs(a.g - b.g),
        Math.abs(a.b - b.b),
        Math.abs(a.a - b.a) * 255,
      ) <= settings.color
    );
  }
  if (first.kind === "numeric") {
    const a = numberValue(first.designValue),
      b = numberValue(second.designValue);
    if (a !== undefined && b !== undefined) {
      if (first.property === "fontWeight")
        return Math.abs(a - b) <= settings.fontWeight;
      if (first.policy)
        return (
          Math.abs(a - b) <=
          policyAllowance(config, first.policy, first.basis ?? a)
        );
    }
  }
  if (first.property === "fontFamily")
    return (
      normalizeFamily(String(first.designValue)).split(",")[0] ===
      normalizeFamily(String(second.designValue)).split(",")[0]
    );
  if (first.property === "text")
    return (
      normalizeText(String(first.designValue)) ===
      normalizeText(String(second.designValue))
    );
  return String(first.designValue) === String(second.designValue);
}

const variableKey = (property: string) =>
  property.startsWith("gap.")
    ? "gap"
    : /^border(?:Top|Right|Bottom|Left)Color$/.test(property)
      ? "borderColor"
      : /^border(?:Top|Right|Bottom|Left)Width$/.test(property)
        ? "borderWidth"
        : property;

export function measureDrift(
  design: ObservationArtifactV2,
  app: ObservationArtifactV2,
  config: ChecksConfig,
  /** Validated saved matches; recomputed only when absent. */
  saved?: DesignMatches,
): FindingCandidate[] {
  return measureComparisons(design, app, config, saved).candidates;
}

/** Every compared property per pair; reconciling several references needs agreements too. */
export function comparePairs(
  design: ObservationArtifactV2,
  app: ObservationArtifactV2,
  config: ChecksConfig,
  saved?: DesignMatches,
): Comparison[] {
  return measureComparisons(design, app, config, saved).comparisons;
}

export function measureComparisons(
  design: ObservationArtifactV2,
  app: ObservationArtifactV2,
  config: ChecksConfig,
  saved?: DesignMatches,
): { candidates: FindingCandidate[]; comparisons: Comparison[] } {
  const comparisons: Comparison[] = [];
  const settings: DesignDriftConfig =
    config.designDrift ?? designDriftConfigSchema.parse({});
  const matches = saved ?? matchElements(design, app),
    candidates: FindingCandidate[] = [];
  const pairById = new Map(matches.pairs.map((p) => [p.id, p])),
    siblingsOf = new Map<string, DesignPair[]>();
  for (const p of matches.pairs)
    if (p.parent)
      siblingsOf.set(p.parent, [...(siblingsOf.get(p.parent) ?? []), p]);
  const ds = contentElements(design).filter((e) => !isVisuallyHidden(e)),
    as = contentElements(app).filter((e) => !isVisuallyHidden(e));
  const dmap = new Map(ds.map((e) => [e.selector, e])),
    amap = new Map(as.map((e) => [e.selector, e]));
  const emit = (
    pair: DesignPair,
    property: string,
    dv: string | number | null,
    av: string | number | null,
    allowance?: number,
    dn?: string | number,
    an?: string | number,
    neighbour?: DesignDriftEvidence["neighbour"],
    major = false,
  ) => {
    const missing = property === "missing",
      extra = property === "extra";
    const figma = extra ? undefined : dmap.get(pair.design);
    const layerPath = figma?.attributes["data-figma-path"],
      link = figma?.attributes["data-figma-link"];
    let variable: string | undefined;
    try {
      // Item spacing belongs to the auto-layout parent, not the child.
      const owner = property.startsWith("gap.")
        ? dmap.get((pair.parent && pairById.get(pair.parent)?.design) ?? "")
        : figma;
      const names = JSON.parse(
        owner?.attributes["data-figma-variables"] ?? "{}",
      ) as Record<string, string>;
      variable = names[variableKey(property)];
    } catch {}
    const fix = missing
      ? `Restore the design content/control at ${layerPath ? `Figma layer ${JSON.stringify(layerPath)}` : pair.design}.`
      : extra
        ? `Remove or reconsider the extra element ${pair.app}.`
        : property.startsWith("gap.")
          ? `Adjust the ${property.endsWith("x") ? "horizontal" : "vertical"} edge gap between ${pair.app} and ${neighbour?.appSelector ?? "its matched sibling"} to ${dv}px using parent spacing or child margins.`
          : property.startsWith("position.")
            ? `Adjust ${pair.app}'s ${property.endsWith("x") ? "horizontal" : "vertical"} offset from its matched parent to ${dv}px.`
            : property === "text"
              ? `Replace the owned text of ${pair.app} with ${JSON.stringify(dv)}.`
              : `Set ${property} on ${pair.app} to the design value ${JSON.stringify(dv)}.`;
    const evidence: DesignDriftEvidence = {
      version: 1,
      pairId: pair.id,
      method: missing || extra ? "unmatched" : pair.method,
      property,
      designValue: dv,
      appValue: av,
      designSelector: extra ? null : pair.design,
      appSelector: missing ? null : pair.app,
      ...(dn === undefined ? {} : { designNormalized: dn }),
      ...(an === undefined ? {} : { appNormalized: an }),
      ...(allowance === undefined ? {} : { allowance }),
      ...(neighbour ? { neighbour } : {}),
      ...(layerPath ? { designLayerPath: layerPath } : {}),
      ...(link ? { designLink: link } : {}),
      ...(variable ? { designVariable: variable } : {}),
    };
    const parent = pair.parent ? pairById.get(pair.parent) : undefined;
    if (parent) {
      evidence.designContext = parent.design;
      evidence.appContext = parent.app;
    }
    const designLabel = layerPath
      ? `Figma ${JSON.stringify(layerPath)}${variable ? ` (${variable})` : ""}`
      : "design";
    const candidate: FindingCandidate = {
      category: "design-drift",
      severity: major ? "major" : "minor",
      rule: "idiom:design-drift",
      selectorHint: missing ? (parent?.app ?? "body") : pair.app,
      fingerprintHint: `${pair.id}:${property}${neighbour ? `:${neighbour.pairId}` : ""}`,
      explanation: `${property}: ${designLabel} ${JSON.stringify(dv)}; app ${JSON.stringify(av)}${allowance === undefined ? "" : ` (allowance ${allowance})`}. Match: ${evidence.method}.${link ? ` Figma node: ${link}` : ""}`,
      fix: `${fix} Or accept this departure through a normal decision.`,
      designDrift: evidence,
      acceptance: [
        `${property} agrees with the intended design within tolerance, or the departure is accepted.`,
      ],
      verification: {
        check: "design-drift",
        params: {
          selector: missing ? (parent?.app ?? "body") : pair.app,
          pairId: pair.id,
          property,
        },
      },
    };
    candidates.push(candidate);
    return candidate;
  };
  for (const pair of matches.pairs) {
    const d = dmap.get(pair.design),
      a = amap.get(pair.app);
    if (!d || !a) continue;
    const comparison = (
      property: string,
      dv: string | number,
      av: string | number,
      kind: Comparison["kind"],
      neighbour: DesignDriftEvidence["neighbour"] | undefined,
      extra: {
        policy?: Policy;
        basis?: number;
        allowance?: number;
        within: boolean;
      },
    ): Comparison => {
      const layerPath = d.attributes["data-figma-path"],
        link = d.attributes["data-figma-link"];
      const record: Comparison = {
        key: `${pair.app}\0${property}\0${neighbour?.appSelector ?? ""}`,
        pair,
        property,
        designValue: dv,
        appValue: av,
        kind,
        ...extra,
        hint: `${pair.id}:${property}${neighbour ? `:${neighbour.pairId}` : ""}`,
        ...(neighbour ? { neighbour } : {}),
        ...(layerPath ? { layerPath } : {}),
        ...(link ? { link } : {}),
      };
      comparisons.push(record);
      return record;
    };
    const compare = (
      property: string,
      dv: string | number | undefined,
      av: string | number | undefined,
      policy?: Policy,
      basis?: number,
      neighbour?: DesignDriftEvidence["neighbour"],
    ) => {
      if (dv === undefined || av === undefined) return;
      const dn = numberValue(dv),
        an = numberValue(av);
      if (dn !== undefined && an !== undefined && policy) {
        const allowance = policyAllowance(config, policy, basis ?? dn);
        const record = comparison(property, dv, av, "numeric", neighbour, {
          policy,
          basis: basis ?? dn,
          allowance,
          within: Math.abs(dn - an) <= allowance,
        });
        if (!record.within)
          record.candidate = emit(
            pair,
            property,
            dv,
            av,
            allowance,
            dn,
            an,
            neighbour,
            crossesStep(
              dn,
              an,
              scaleFor(property, d, a, design, app, config, dn, an),
            ),
          );
      } else {
        const record = comparison(property, dv, av, "string", neighbour, {
          within: String(dv) === String(av),
        });
        if (!record.within)
          record.candidate = emit(
            pair,
            property,
            dv,
            av,
            undefined,
            undefined,
            undefined,
            neighbour,
          );
      }
    };
    // A Figma root spans the viewport and takes the artboard height, so root
    // geometry would only report the viewport snap; root styles still compare.
    if (!(pair.method === "root" && isFigma(d))) {
      compare("width", d.rect.width, a.rect.width, "size");
      compare("height", d.rect.height, a.rect.height, "size");
    }
    const parent = pair.parent ? pairById.get(pair.parent) : undefined,
      dp = parent && dmap.get(parent.design),
      ap = parent && amap.get(parent.app);
    if (dp && ap) {
      compare(
        "position.x",
        d.rect.x - dp.rect.x,
        a.rect.x - ap.rect.x,
        "position",
        d.rect.width,
      );
      compare(
        "position.y",
        d.rect.y - dp.rect.y,
        a.rect.y - ap.rect.y,
        "position",
        d.rect.height,
      );
    }
    for (const property of [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomRightRadius",
      "borderBottomLeftRadius",
    ] as const)
      compare(property, d.styles[property], a.styles[property], "radius");
    for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
      compare(
        `border${side}Width`,
        d.styles[`border${side}Width`],
        a.styles[`border${side}Width`],
        "borderWidth",
      );
      compare(
        `border${side}Style`,
        d.styles[`border${side}Style`],
        a.styles[`border${side}Style`],
      );
    }
    // Typography is meaningful only where the element owns rendered text.
    if (
      normalizeText(d.directText) ||
      normalizeText(a.directText) ||
      d.interactive
    ) {
      compare("fontSize", d.styles.fontSize, a.styles.fontSize, "fontSize");
      compare(
        "lineHeight",
        d.styles.lineHeight,
        a.styles.lineHeight,
        "lineHeight",
      );
      const dw = numberValue(d.styles.fontWeight),
        aw = numberValue(a.styles.fontWeight);
      if (dw !== undefined && aw !== undefined) {
        const record = comparison(
          "fontWeight",
          d.styles.fontWeight,
          a.styles.fontWeight,
          "numeric",
          undefined,
          {
            allowance: settings.fontWeight,
            within: Math.abs(dw - aw) <= settings.fontWeight,
          },
        );
        if (!record.within)
          record.candidate = emit(
            pair,
            "fontWeight",
            d.styles.fontWeight,
            a.styles.fontWeight,
            settings.fontWeight,
            dw,
            aw,
          );
      } else compare("fontWeight", d.styles.fontWeight, a.styles.fontWeight);
      // Figma names one family; the app's stack is compared by its first entry.
      const df = normalizeFamily(d.styles.fontFamily),
        af = isFigma(d)
          ? (normalizeFamily(a.styles.fontFamily).split(",")[0] ?? "")
          : normalizeFamily(a.styles.fontFamily);
      const family = comparison(
        "fontFamily",
        d.styles.fontFamily,
        a.styles.fontFamily,
        "string",
        undefined,
        { within: df === af },
      );
      if (!family.within)
        family.candidate = emit(
          pair,
          "fontFamily",
          d.styles.fontFamily,
          a.styles.fontFamily,
          undefined,
          df,
          af,
        );
    }
    const colors = [
      "backgroundColor",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
      ...(d.directText || a.directText ? ["color" as const] : []),
      ...(["svg", "path", "circle", "rect", "line", "polygon", "g"].includes(
        d.tag,
      )
        ? ["fill" as const, "stroke" as const]
        : []),
    ] as const;
    for (const property of colors) {
      const dv = d.styles[property],
        av = a.styles[property];
      if (
        property.startsWith("border") &&
        numberValue(
          d.styles[property.replace("Color", "Width") as "borderTopWidth"],
        ) === 0 &&
        numberValue(
          a.styles[property.replace("Color", "Width") as "borderTopWidth"],
        ) === 0
      )
        continue;
      const dn = normalizeColor(dv),
        an = normalizeColor(av);
      const dc = designColor(dv),
        ac = designColor(av);
      const delta =
        dc && ac
          ? Math.max(
              Math.abs(dc.r - ac.r),
              Math.abs(dc.g - ac.g),
              Math.abs(dc.b - ac.b),
              Math.abs(dc.a - ac.a) * 255,
            )
          : undefined;
      const record = comparison(property, dv, av, "color", undefined, {
        allowance: settings.color,
        within: delta !== undefined ? delta <= settings.color : dn === an,
      });
      if (!record.within)
        record.candidate = emit(pair, property, dv, av, settings.color, dn, an);
    }
    const text = comparison(
      "text",
      d.directText,
      a.directText,
      "string",
      undefined,
      {
        within: normalizeText(d.directText) === normalizeText(a.directText),
      },
    );
    if (!text.within)
      text.candidate = emit(
        pair,
        "text",
        d.directText,
        a.directText,
        undefined,
        normalizeText(d.directText),
        normalizeText(a.directText),
      );
    if (parent) {
      const siblings = siblingsOf.get(parent.id) ?? [];
      const index = siblings.indexOf(pair),
        next = siblings[index + 1];
      const nd = next && dmap.get(next.design),
        na = next && amap.get(next.app);
      if (next && nd && na) {
        for (const axis of ["x", "y"] as const) {
          const length = axis === "x" ? "width" : "height",
            cross = axis === "x" ? "y" : "x",
            crossLength = axis === "x" ? "height" : "width";
          const direction = (
            first: ObservedElementV2,
            second: ObservedElementV2,
          ) => {
            if (
              Math.min(
                first.rect[cross] + first.rect[crossLength],
                second.rect[cross] + second.rect[crossLength],
              ) <= Math.max(first.rect[cross], second.rect[cross])
            )
              return 0;
            return second.rect[axis] >= first.rect[axis] + first.rect[length]
              ? 1
              : first.rect[axis] >= second.rect[axis] + second.rect[length]
                ? -1
                : 0;
          };
          const dir = direction(d, nd);
          if (dir && dir === direction(a, na)) {
            const gap = (
              first: ObservedElementV2,
              second: ObservedElementV2,
            ) =>
              dir === 1
                ? second.rect[axis] - first.rect[axis] - first.rect[length]
                : first.rect[axis] - second.rect[axis] - second.rect[length];
            compare(`gap.${axis}`, gap(d, nd), gap(a, na), "gap", undefined, {
              pairId: next.id,
              designSelector: next.design,
              appSelector: next.app,
            });
          }
        }
      }
    }
  }
  const majorRoles = new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "slider",
    "tab",
    "switch",
    "spinbutton",
    "searchbox",
    "listbox",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "scrollbar",
    "treeitem",
    "main",
    "heading",
  ]);
  for (const side of ["Design", "App"] as const) {
    const unmatched = new Set(
        side === "Design" ? matches.unmatchedDesign : matches.unmatchedApp,
      ),
      map = side === "Design" ? dmap : amap,
      byPath = new Map([...map.values()].map((e) => [e.structuralPath, e])),
      paired = new Map(
        matches.pairs.map((p) => [side === "Design" ? p.design : p.app, p]),
      );
    const anchors = new Map<string, number>();
    for (const e of map.values()) {
      const key = nodeKey(e) ?? e.attributes["data-idiom-name"];
      if (key) anchors.set(key, (anchors.get(key) ?? 0) + 1);
    }
    const ancestorsOf = (element: ObservedElementV2) => {
      const found = new Set<ObservedElementV2>();
      for (const selector of element.ancestorSelectors) {
        const node = map.get(selector);
        if (node && node !== element) found.add(node);
      }
      const parts = element.structuralPath.split("/");
      for (let i = 1; i < parts.length; i++) {
        const node = byPath.get(parts.slice(0, i).join("/"));
        if (node && node !== element) found.add(node);
      }
      return [...found];
    };
    const descendants = new Map<string, ObservedElementV2[]>();
    for (const e of map.values())
      for (const ancestor of ancestorsOf(e))
        if (unmatched.has(ancestor.selector))
          descendants.set(ancestor.selector, [
            ...(descendants.get(ancestor.selector) ?? []),
            e,
          ]);
    for (const selector of unmatched) {
      const element = map.get(selector);
      if (
        !element ||
        ancestorsOf(element).some((parent) => unmatched.has(parent.selector))
      )
        continue;
      // Severity follows what is actually absent: content whose counterpart was
      // matched elsewhere (a wrapper difference) does not make the gap major.
      const absent = [element, ...(descendants.get(selector) ?? [])].filter(
        (e) => unmatched.has(e.selector),
      );
      const major =
        side === "Design" &&
        absent.some(
          (e) =>
            e.interactive ||
            e.headingLevel ||
            majorRoles.has(e.signals?.role ?? "") ||
            e.signals?.paint?.primaryAction ||
            e.tag === "main" ||
            ((normalizeText(e.directText) ||
              ["img", "svg", "canvas", "video", "picture"].includes(e.tag)) &&
              e.ancestorSelectors.some((ancestor) => {
                const node = dmap.get(ancestor);
                return node?.tag === "main" || node?.signals?.role === "main";
              })),
        );
      const parent = ancestorsOf(element)
        .filter((node) => paired.has(node.selector))
        .sort(
          (x, y) =>
            y.structuralPath.split("/").length -
            x.structuralPath.split("/").length,
        )
        .map((node) => paired.get(node.selector))[0];
      const anchor = nodeKey(element) ?? element.attributes["data-idiom-name"];
      const unique = anchor && anchors.get(anchor) === 1;
      const pair: DesignPair = {
        id: `unmatched:${side}:${unique ? anchor : `${anchor ?? "path"}:${element.structuralPath}`}`,
        design: selector,
        app: selector,
        method: "parent-position",
        parent: parent?.id ?? null,
      };
      emit(
        pair,
        side === "Design" ? "missing" : "extra",
        side === "Design"
          ? element.directText || element.signals?.name || element.tag
          : null,
        side === "App"
          ? element.directText || element.signals?.name || element.tag
          : null,
        undefined,
        undefined,
        undefined,
        undefined,
        major,
      );
    }
  }
  return { candidates, comparisons };
}
