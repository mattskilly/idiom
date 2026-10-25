import type { DesignToken } from "./schema.js";
import type { ExtractedToken } from "./types.js";
/** Restore alias context without turning dotted DTCG paths into CSS names. */
export function inlineDeclarations(tokens: DesignToken[]): ExtractedToken[] {
  return tokens.map((token) => {
    const environment: Record<string, string> = {};
    const applicable = tokens.filter(
      (t) => t.theme === undefined || t.theme === token.theme,
    );
    for (const t of applicable.filter((t) => t.theme === undefined))
      if (t.name.startsWith("--")) environment[t.name] = t.value;
    for (const t of applicable.filter((t) => t.theme !== undefined))
      if (t.name.startsWith("--")) environment[t.name] = t.value;
    const walk = (value: string, trail: string[]): string => {
      if (!/^\{[^{}]+\}$/.test(value)) return value;
      const key = value.slice(1, -1);
      if (trail.includes(key)) throw new Error("Cyclic token alias");
      const target = applicable.find(
        (t) => t.source.path === token.source.path && t.source.key === key,
      );
      if (!target) throw new Error(`Missing token alias target: ${key}`);
      return walk(target.value, [...trail, key]);
    };
    try {
      return {
        ...token,
        ...(token.name === "--spacing" && token.kind === "spacing"
          ? { base: true }
          : {}),
        resolved: walk(token.value, [token.source.key]).replaceAll(
          "<alpha-value>",
          "1",
        ),
        environment,
      };
    } catch (error) {
      return { ...token, environment, reason: String(error) };
    }
  });
}
