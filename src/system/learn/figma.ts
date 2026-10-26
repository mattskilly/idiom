import { relative, sep } from "node:path";
import { fetchFigmaVariables } from "../../design/figma/cache.js";
import type { FigmaDependencies } from "../../design/figma/client.js";
import {
  type FigmaColor,
  type FigmaVariables,
  isVariableAlias,
} from "../../design/figma/types.js";
import type { FigmaRef } from "../../design/figma/url.js";
import type { ExtractedToken, Extraction, TokenKind } from "./types.js";

const hex = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n * 255)))
    .toString(16)
    .padStart(2, "0");
function hexColor(color: FigmaColor, opacity = 1): string {
  const alpha = (color.a ?? 1) * opacity;
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}${alpha < 1 ? hex(alpha) : ""}`;
}
const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const isColor = (value: unknown): value is FigmaColor =>
  typeof value === "object" &&
  value !== null &&
  ["r", "g", "b"].every(
    (key) => typeof (value as Record<string, unknown>)[key] === "number",
  );

type Variable = FigmaVariables["meta"]["variables"][string];

/** Follow aliases (with a cycle guard) to a concrete value for one mode. */
function resolveValue(
  variables: FigmaVariables,
  variable: Variable,
  modeId: string,
  seen = new Set<string>(),
): unknown {
  if (seen.has(variable.id)) return undefined;
  seen.add(variable.id);
  const collection =
    variables.meta.variableCollections[variable.variableCollectionId];
  const value =
    variable.valuesByMode[modeId] ??
    (collection ? variable.valuesByMode[collection.defaultModeId] : undefined);
  if (!isVariableAlias(value)) return value;
  const target = variables.meta.variables[value.id];
  return target ? resolveValue(variables, target, modeId, seen) : undefined;
}

/** Local Figma variables as design tokens: colours, radii, spacing and other numbers. */
export function figmaVariableTokens(
  variables: FigmaVariables,
  path: string,
): { tokens: ExtractedToken[]; diagnostics: string[] } {
  const tokens: ExtractedToken[] = [],
    diagnostics: string[] = [];
  for (const variable of Object.values(variables.meta.variables).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (variable.remote) continue;
    if (variable.resolvedType !== "COLOR" && variable.resolvedType !== "FLOAT")
      continue;
    const collection =
      variables.meta.variableCollections[variable.variableCollectionId];
    if (!collection) continue;
    const scopes = variable.scopes ?? [];
    const kind: TokenKind =
      variable.resolvedType === "COLOR"
        ? "color"
        : scopes.includes("CORNER_RADIUS")
          ? "radius"
          : scopes.includes("GAP")
            ? "spacing"
            : "other";
    for (const mode of collection.modes) {
      const raw = resolveValue(variables, variable, mode.modeId);
      let value: string | undefined;
      if (variable.resolvedType === "COLOR") {
        if (isColor(raw)) value = hexColor(raw);
        else if (
          typeof raw === "object" &&
          raw !== null &&
          isColor((raw as { color?: unknown }).color)
        ) {
          const composed = raw as { color: FigmaColor; opacity?: number };
          value = hexColor(composed.color, composed.opacity ?? 1);
        }
      } else if (typeof raw === "number" && Number.isFinite(raw))
        value = `${Math.round(raw * 100) / 100}px`;
      if (value === undefined) {
        diagnostics.push(
          `${collection.name}/${variable.name} (${mode.name}): unresolved value skipped`,
        );
        continue;
      }
      const theme =
        collection.modes.length > 1 && mode.modeId !== collection.defaultModeId
          ? slug(mode.name)
          : undefined;
      tokens.push({
        name: variable.name,
        value,
        kind,
        source: { path, key: `${collection.name}/${variable.name}` },
        ...(theme ? { theme } : {}),
      });
    }
  }
  return { tokens, diagnostics };
}

export async function extractFigmaVariables(
  projectDirectory: string,
  ref: FigmaRef,
  options: {
    refresh?: boolean | undefined;
    deps?: FigmaDependencies | undefined;
  } = {},
): Promise<Extraction & { summary: string }> {
  const fetched = await fetchFigmaVariables(ref, {
    projectDirectory,
    refresh: options.refresh,
    deps: options.deps,
  });
  const path = relative(projectDirectory, fetched.path).split(sep).join("/");
  const { tokens, diagnostics } = figmaVariableTokens(fetched.variables, path);
  return {
    sources: [{ path, kind: "figma" }],
    tokens,
    diagnostics,
    summary: `Figma variables from ${fetched.name ? `"${fetched.name}" ` : ""}(${ref.fileKey}) version ${fetched.version}`,
  };
}
