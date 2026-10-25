import { resolve } from "node:path";
import loadConfig from "tailwindcss-v3/loadConfig.js";
import resolveConfig from "tailwindcss-v3/resolveConfig.js";
import { dimensionKind } from "./mapping.js";
import type { ExtractedToken } from "./types.js";

type ThemeFunction = (...args: unknown[]) => unknown;

/** Record the keys a project function actually returns while the public resolver
 * evaluates it. A function in extend must not mark its inherited siblings authored. */
function trackThemeFunctions(
  config: unknown,
  results: Map<ThemeFunction, unknown>,
  seen = new Map<object, unknown>(),
): unknown {
  if (!config || typeof config !== "object") return config;
  if (seen.has(config)) return seen.get(config);
  const input = config as Record<string, unknown>;
  const copy = { ...input };
  seen.set(config, copy);
  const track = (section: unknown): unknown => {
    if (!section || typeof section !== "object") return section;
    return Object.fromEntries(
      Object.entries(section).map(([key, value]) => {
        if (typeof value !== "function") return [key, value];
        const wrapped: ThemeFunction = (...args) => {
          const result = value(...args);
          results.set(wrapped, result);
          return result;
        };
        return [key, wrapped];
      }),
    );
  };
  if (input.theme && typeof input.theme === "object") {
    const theme = track(input.theme) as Record<string, unknown>;
    if ("extend" in theme) theme.extend = track(theme.extend);
    copy.theme = theme;
  }
  if (Array.isArray(input.presets))
    copy.presets = input.presets.map((preset) =>
      trackThemeFunctions(preset, results, seen),
    );
  return copy;
}

function explicitlyDeclared(
  config: unknown,
  section: string,
  keys: string[],
  results: Map<ThemeFunction, unknown>,
  seen = new Set<unknown>(),
): boolean {
  if (!config || typeof config !== "object" || seen.has(config)) return false;
  seen.add(config);
  const input = config as {
    theme?: Record<string, unknown>;
    presets?: unknown[];
  };
  const has = (value: unknown): boolean => {
    if (typeof value === "function")
      value = results.get(value as ThemeFunction);
    for (const key of keys) {
      if (!value || typeof value !== "object") return false;
      value = (value as Record<string, unknown>)[key];
      if (typeof value === "function") return true;
    }
    return value !== undefined;
  };
  return (
    has(input.theme?.[section]) ||
    has(
      (input.theme?.extend as Record<string, unknown> | undefined)?.[section],
    ) ||
    (input.presets ?? []).some((preset) =>
      explicitlyDeclared(preset, section, keys, results, seen),
    )
  );
}

export function extractTailwind(root: string, path: string): ExtractedToken[] {
  try {
    const loaded = loadConfig(resolve(root, path));
    const results = new Map<ThemeFunction, unknown>();
    const config = trackThemeFunctions(loaded, results) as typeof loaded;
    const effective = resolveConfig(config);
    const tokens: ExtractedToken[] = [];
    for (const [section, kind] of [
      ["spacing", "spacing"],
      ["borderRadius", "radius"],
      ["colors", "color"],
      ["height", "other"],
    ] as const) {
      const walk = (value: unknown, keys: string[]) => {
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value)
        ) {
          for (const [key, child] of Object.entries(value))
            walk(child, [...keys, key]);
        } else if (typeof value === "string" || typeof value === "number") {
          const name = `${section}.${keys.join(".")}`;
          const mapped =
            section === "height"
              ? dimensionKind(`height.${keys.join(".")}`)
              : kind;
          const isDefault = !explicitlyDeclared(config, section, keys, results);
          tokens.push({
            name,
            value: String(value),
            resolved: String(value).replaceAll("<alpha-value>", "1"),
            kind: mapped,
            source: { path, key: `theme.${name}` },
            default: isDefault,
            notes: [
              isDefault
                ? "Tailwind resolver default"
                : "Tailwind effective theme",
              ...(section === "height"
                ? [
                    mapped === "control-height"
                      ? "Control purpose inferred from name"
                      : "Layout height: display only",
                  ]
                : []),
            ],
          });
        } else
          tokens.push({
            name: `${section}.${keys.join(".")}`,
            value: String(value),
            kind: "other",
            source: { path, key: `theme.${section}.${keys.join(".")}` },
            default: !explicitlyDeclared(config, section, keys, results),
            reason: "Unsupported non-scalar Tailwind value",
          });
      };
      walk(effective.theme?.[section], []);
    }
    return tokens;
  } catch (error) {
    throw new Error(
      `${path}: cannot load/resolve Tailwind configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
