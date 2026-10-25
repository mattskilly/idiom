import { checksConfigFrom } from "../checks/registry.js";
import { scaleMeasurements } from "../checks/scale-conformance.js";
import { signalledElements } from "../checks/shared.js";
import { authoredSpacing } from "../checks/spacing-scale.js";
import { contributingStyles } from "../checks/token-drift.js";
import type { CheckTuple } from "../checks/types.js";
import type { Project } from "../schemas/project.js";
import type {
  ExtractedToken,
  NormalizationInput,
  NormalizedValue,
  TokenKind,
} from "./learn/types.js";

export type DriftFact = {
  kind: TokenKind;
  value: string;
  count: number;
  selectors: string[];
  coordinate: string;
  theme?: string | undefined;
  scheme: "light" | "dark";
  rootFontSize?: number | undefined;
};
export type DriftInput = {
  status: "available" | "unavailable";
  reason?: string | undefined;
  runId?: string | undefined;
  capturedAt?: string | undefined;
  declarations: ExtractedToken[];
  facts: DriftFact[];
  limitations: string[];
  contexts: Array<{
    coordinate: string;
    theme?: string | undefined;
    scheme: "light" | "dark";
    rootFontSize?: number | undefined;
    unavailableKinds?: TokenKind[] | undefined;
  }>;
  proposed?: boolean | undefined;
};
export type DriftResult = {
  uncovered: string[];
  notObserved: string[];
  unresolved: string[];
  unconfigured: string[];
};
export function collectDrift(options: {
  tuples: CheckTuple[];
  project: Project;
  declarations: ExtractedToken[];
  runId: string;
  capturedAt: string;
}): DriftInput {
  const facts: DriftFact[] = [];
  const limitations = new Set<string>();
  const contexts: DriftInput["contexts"] = [];
  const config = checksConfigFrom(options.project.checks);
  for (const tuple of options.tuples) {
    const obs = tuple.observations;
    const unavailableKinds: TokenKind[] =
      obs?.version === 2 ? [] : ["spacing", "radius", "control-height"];
    if (
      obs?.version === 2 &&
      obs.elements.some((e) => e.visible && e.authoredProperties === undefined)
    )
      unavailableKinds.push("spacing");
    const context = {
      unavailableKinds,
      coordinate: `${tuple.flow} / ${tuple.state} / ${tuple.viewport} / ${tuple.colorScheme ?? options.project.capture.colorScheme}`,
      scheme: tuple.colorScheme ?? options.project.capture.colorScheme,
      ...(obs?.version === 2 && obs.theme !== undefined
        ? { theme: obs.theme }
        : {}),
      ...(obs?.version === 2 && obs.rootFontSize !== undefined
        ? { rootFontSize: obs.rootFontSize }
        : {}),
    };
    contexts.push(context);
    if (context.rootFontSize === undefined)
      limitations.add(
        "Legacy capture lacks root font size: rem drift coverage unavailable; recapture.",
      );
    if (obs?.version !== 2)
      limitations.add(
        "Legacy capture lacks role/style facts: spacing, control-height and radius coverage unavailable; recapture.",
      );
    const add = (kind: TokenKind, value: string, selector: string) => {
      const prior = facts.find(
        (f) =>
          f.kind === kind &&
          f.value === value &&
          f.coordinate === context.coordinate,
      );
      if (prior) {
        prior.count++;
        if (prior.selectors.length < 3 && !prior.selectors.includes(selector))
          prior.selectors.push(selector);
      } else
        facts.push({
          kind,
          value,
          count: 1,
          selectors: [selector],
          ...context,
        });
    };
    for (const element of obs?.elements ?? []) {
      if (!element.visible) continue;
      for (const [property, value] of contributingStyles(element))
        if (!property.toLowerCase().includes("radius"))
          add("color", value, element.selector);
      if (obs?.version === 2) {
        if (element.authoredProperties === undefined)
          limitations.add(
            "Legacy elements lack authored spacing facts; spacing coverage unavailable for those elements.",
          );
        for (const { px } of authoredSpacing(element))
          add("spacing", `${px}px`, element.selector);
      }
    }
    const signalled = signalledElements(tuple);
    if ("reason" in signalled && obs?.version === 2) {
      unavailableKinds.push("radius", "control-height");
      limitations.add(
        "Legacy capture lacks role signals: radius and control-height coverage unavailable; recapture.",
      );
    }
    if (!("reason" in signalled))
      for (const measurement of scaleMeasurements(
        tuple,
        signalled.elements,
        config,
        [],
      )) {
        if (measurement.property === "height")
          add(
            "control-height",
            measurement.label,
            measurement.element.selector,
          );
        if (measurement.property === "radius")
          add("radius", measurement.label, measurement.element.selector);
      }
  }
  return {
    status: "available",
    runId: options.runId,
    capturedAt: options.capturedAt,
    declarations: options.declarations,
    facts,
    contexts,
    limitations: [...limitations],
  };
}

/** Self-contained comparison, shared by the disposable browser and offline report. */
export function compareValueDrift(
  input: DriftInput,
  normalize: (inputs: NormalizationInput[]) => NormalizedValue[],
): DriftResult {
  const result: DriftResult = {
    uncovered: [],
    notObserved: [],
    unresolved: [...input.limitations],
    unconfigured: [],
  };
  if (input.status === "unavailable") {
    result.unresolved.push(
      input.reason ?? "No complete capture: drift unavailable.",
    );
    return result;
  }
  const match = (a: string, b: string, base = false) => {
    if (a === b) return true;
    if (/^[\d.]+px$/.test(a) && /^[\d.]+px$/.test(b)) {
      const x = Number(a.slice(0, -2)),
        y = Number(b.slice(0, -2));
      return base && y > 0
        ? Math.abs(x - Math.round(x / y) * y) <= 0.5
        : Math.abs(x - y) <= 0.5;
    }
    // One raster channel of rounding is normal when converting modern colours.
    const channels = (value: string) =>
      /^rgba?\(/.test(value) ? value.match(/[\d.]+/g)?.map(Number) : undefined;
    const x = channels(a),
      y = channels(b);
    return (
      x !== undefined &&
      y !== undefined &&
      x.slice(0, 3).every((v, i) => Math.abs(v - (y[i] ?? -10)) <= 1) &&
      Math.abs((x[3] ?? 1) - (y[3] ?? 1)) < 0.01
    );
  };
  for (const kind of [
    "color",
    "spacing",
    "radius",
    "control-height",
  ] as const) {
    const tokens = input.declarations.filter((t) => t.kind === kind);
    if (!tokens.length) {
      result.unconfigured.push(`${kind}: no declared tokens`);
      continue;
    }
    const used = new Set<number>();
    const resolvable = new Set<number>();
    const unresolved = new Set<number>();
    for (const context of input.contexts) {
      const contextEnvironment: Record<string, string> = {};
      for (const theme of [undefined, context.theme ?? context.scheme])
        for (const t of input.declarations)
          if (t.theme === theme && !t.reason && t.name.startsWith("--"))
            contextEnvironment[t.name] = t.resolved ?? t.value;
      const applicable = tokens
        .map((t, i) => ({ t, i }))
        .filter(
          ({ t }) =>
            (t.theme === undefined ||
              t.theme === (context.theme ?? context.scheme)) &&
            !(
              t.theme === undefined &&
              tokens.some(
                (other) =>
                  other.name === t.name &&
                  other.source.path === t.source.path &&
                  other.theme === (context.theme ?? context.scheme),
              )
            ),
        );
      if (context.unavailableKinds?.includes(kind)) {
        for (const { i } of applicable) unresolved.add(i);
        result.unresolved.push(
          `${kind} coverage unavailable for ${context.coordinate}; recapture.`,
        );
        continue;
      }
      const values = applicable.map(({ t, i }) => {
        if (t.reason) {
          result.unresolved.push(`${t.name}: ${t.reason}`);
          unresolved.add(i);
          return undefined;
        }
        const usesRem = (
          value: string,
          visited = new Set<string>(),
        ): boolean => {
          if (/[\d.]rem\b/.test(value)) return true;
          return [...value.matchAll(/var\(\s*(--[-\w]+)/g)].some((match) => {
            const name = match[1] as string;
            if (visited.has(name)) return false;
            visited.add(name);
            return usesRem(
              contextEnvironment[name] ?? t.environment?.[name] ?? "",
              visited,
            );
          });
        };
        if (
          context.rootFontSize === undefined &&
          usesRem(t.resolved ?? t.value)
        ) {
          unresolved.add(i);
          result.unresolved.push(
            `${t.name}: capture lacks root font size for rem comparison; recapture.`,
          );
          return undefined;
        }
        const value = normalize([
          {
            value: t.resolved ?? t.value,
            kind: t.kind,
            environment: { ...t.environment, ...contextEnvironment },
            scheme: context.scheme,
            rootFontSize: context.rootFontSize,
          },
        ])[0];
        if (!value?.value) {
          result.unresolved.push(
            `${t.name} (${context.coordinate}): ${value?.reason ?? "unresolved"}`,
          );
          unresolved.add(i);
          return undefined;
        }
        resolvable.add(i);
        return value.value;
      });
      for (const fact of input.facts.filter(
        (f) => f.kind === kind && f.coordinate === context.coordinate,
      )) {
        const observed =
          fact.value === "full"
            ? "full"
            : normalize([
                {
                  value: fact.value,
                  kind,
                  scheme: context.scheme,
                  rootFontSize: context.rootFontSize,
                },
              ])[0]?.value;
        if (!observed) {
          result.unresolved.push(
            `${kind} ${fact.value}: unsupported observed value`,
          );
          continue;
        }
        let covered = false;
        applicable.forEach(({ t, i }, j) => {
          if (
            values[j] &&
            match(observed, values[j] as string, t.base ?? false)
          ) {
            used.add(i);
            covered = true;
          }
        });
        if (!covered && applicable.length && values.some(Boolean))
          result.uncovered.push(
            `${kind} ${fact.value} · ${fact.count} uses · ${fact.selectors.join(", ")} · ${fact.coordinate}`,
          );
        else if (!covered && !applicable.length)
          result.unresolved.push(
            `${kind}: no declarations applicable to ${context.coordinate}`,
          );
      }
    }
    tokens.forEach((token, i) => {
      if (!resolvable.has(i) && !unresolved.has(i))
        result.unresolved.push(
          `${token.name}: theme ${token.theme ?? "default"} not represented in this capture`,
        );
      if (resolvable.has(i) && !unresolved.has(i) && !used.has(i))
        result.notObserved.push(
          `${token.name} (${token.source.path}:${token.source.key}${token.theme === undefined ? "" : `, theme ${token.theme}`}) = ${token.value} — not observed in this capture`,
        );
    });
  }
  for (const token of input.declarations.filter((t) => t.kind === "other"))
    result.unresolved.push(
      `${token.name}: ${token.reason ?? "display-only/unsupported mapping"}`,
    );
  for (const key of [
    "uncovered",
    "notObserved",
    "unresolved",
    "unconfigured",
  ] as const)
    result[key] = [...new Set(result[key])];
  return result;
}
