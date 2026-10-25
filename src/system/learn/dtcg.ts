import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dimensionKind } from "./mapping.js";
import type { ExtractedToken } from "./types.js";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export async function extractDtcg(
  root: string,
  path: string,
): Promise<ExtractedToken[]> {
  const data: unknown = JSON.parse(await readFile(resolve(root, path), "utf8"));
  const entries = new Map<
    string,
    { value: unknown; type?: string | undefined }
  >();
  const walk = (value: unknown, keys: string[], inherited?: string) => {
    if (!object(value)) return;
    if (value.$type !== undefined && typeof value.$type !== "string")
      throw new Error(`${path}:${keys.join(".")}: $type must be a string`);
    const type = typeof value.$type === "string" ? value.$type : inherited;
    if ("$value" in value) {
      if (Object.keys(value).some((k) => !k.startsWith("$")))
        throw new Error(
          `${path}: token ${keys.join(".")} also contains a group`,
        );
      if (keys.length === 0) throw new Error(`${path}: root cannot be a token`);
      entries.set(keys.join("."), { value: value.$value, type });
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("$") && key !== "$root") {
        if (object(child) && "$value" in child)
          throw new Error(`${path}: invalid reserved token name ${key}`);
        continue;
      }
      if (/[.{}]/.test(key) || key === "")
        throw new Error(
          `${path}: invalid token/group name ${JSON.stringify(key)}`,
        );
      walk(child, [...keys, key], type);
    }
  };
  walk(data, []);
  const resolveValue = (
    name: string,
    trail: string[],
  ): { value: unknown; type?: string | undefined } => {
    if (trail.includes(name))
      throw new Error(`Cyclic token alias: ${[...trail, name].join(" → ")}`);
    const entry = entries.get(name);
    if (!entry) throw new Error(`Missing token alias target: ${name}`);
    if (typeof entry.value === "string" && /^\{[^{}]+\}$/.test(entry.value)) {
      const target = resolveValue(entry.value.slice(1, -1), [...trail, name]);
      if (entry.type && entry.type !== target.type)
        throw new Error(`Alias type mismatch: ${name}`);
      return { ...target, type: entry.type ?? target.type };
    }
    return entry;
  };
  return [...entries].map(([name, authored]) => {
    const token: ExtractedToken = {
      name,
      value:
        typeof authored.value === "string"
          ? authored.value
          : JSON.stringify(authored.value),
      kind: "other",
      source: { path, key: name },
    };
    try {
      const { value, type } = resolveValue(name, []);
      token.formatType = type;
      if (
        type === "dimension" &&
        object(value) &&
        typeof value.value === "number" &&
        Number.isFinite(value.value) &&
        ["px", "rem"].includes(String(value.unit))
      ) {
        token.kind = dimensionKind(name);
        token.resolved = `${value.value}${value.unit}`;
        if (
          !(
            typeof authored.value === "string" && authored.value.startsWith("{")
          )
        )
          token.value = token.resolved;
        token.notes = [
          token.kind === "other"
            ? "Ambiguous dimension purpose: display only"
            : `Dimension purpose inferred from name (${token.kind})`,
        ];
      } else if (
        type === "color" &&
        object(value) &&
        typeof value.colorSpace === "string" &&
        Array.isArray(value.components) &&
        value.components.length === 3 &&
        value.components.every(
          (c) => c === "none" || (typeof c === "number" && Number.isFinite(c)),
        )
      ) {
        const alpha = value.alpha ?? 1;
        if (typeof alpha !== "number" || alpha < 0 || alpha > 1)
          throw new Error("Invalid colour alpha");
        const parts = value.components.join(" ");
        const space = value.colorSpace;
        if (
          [
            "srgb",
            "srgb-linear",
            "display-p3",
            "a98-rgb",
            "prophoto-rgb",
            "rec2020",
            "xyz-d50",
            "xyz-d65",
          ].includes(space)
        )
          token.resolved = `color(${space} ${parts} / ${alpha})`;
        else if (
          ["hsl", "hwb", "lab", "lch", "oklab", "oklch"].includes(space)
        ) {
          const components = [...value.components];
          if (space === "hsl" || space === "hwb") {
            components[1] = `${components[1]}%`;
            components[2] = `${components[2]}%`;
          }
          token.resolved = `${space}(${components.join(" ")} / ${alpha})`;
        } else throw new Error(`Unsupported colour space ${space}`);
        token.kind = "color";
        if (
          !(
            typeof authored.value === "string" && authored.value.startsWith("{")
          )
        )
          token.value = token.resolved;
      } else
        token.reason = `Unsupported or invalid DTCG type/value: ${type ?? "no declared or inherited type"} (display only)`;
    } catch (error) {
      token.reason = error instanceof Error ? error.message : String(error);
    }
    return token;
  });
}
