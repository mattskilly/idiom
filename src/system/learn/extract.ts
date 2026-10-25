import { extractCss } from "./css.js";
import { discoverSources } from "./discover.js";
import { extractDtcg } from "./dtcg.js";
import { tokenIdentity } from "./schema.js";
import { extractTailwind } from "./tailwind.js";
import type { Extraction } from "./types.js";
export async function extractSources(root: string): Promise<Extraction> {
  const sources = await discoverSources(root);
  const result: Extraction = { sources, tokens: [], diagnostics: [] };
  try {
    result.tokens.push(
      ...(await extractCss(
        root,
        sources.filter((s) => s.kind === "css").map((s) => s.path),
      )),
    );
  } catch (error) {
    throw new Error(
      `Cannot extract CSS sources: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const source of sources) {
    try {
      if (source.kind === "tailwind")
        result.tokens.push(...extractTailwind(root, source.path));
      if (source.kind === "dtcg")
        result.tokens.push(...(await extractDtcg(root, source.path)));
    } catch (error) {
      throw new Error(
        `${source.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const unique = new Map<string, (typeof result.tokens)[number]>();
  for (const token of result.tokens) {
    const id = tokenIdentity(token);
    const prior = unique.get(id);
    if (prior && prior.value !== token.value)
      token.reason = "Conflicting declarations for this source/key/theme";
    unique.set(id, token);
  }
  result.tokens = [...unique.values()];
  const conflictsByToken = new Map(
    result.tokens.map((token) => [
      token,
      result.tokens.filter(
        (t) =>
          t.name === token.name &&
          t.theme === token.theme &&
          t.value !== token.value &&
          !t.default &&
          !token.default &&
          !t.reason &&
          !token.reason,
      ),
    ]),
  );
  for (const token of result.tokens) {
    const conflicts = conflictsByToken.get(token) ?? [];
    if (conflicts.length)
      token.reason = `Conflicting same-context values: ${[token.source.path, ...conflicts.map((t) => t.source.path)].join(", ")}`;
  }
  // Aliases must not smuggle a conflicting/conditional declaration into a scale.
  for (let round = 0; round < result.tokens.length; round++) {
    let changed = false;
    for (const token of result.tokens) {
      if (token.reason) continue;
      const names = [...token.value.matchAll(/var\(\s*(--[-\w]+)/g)].map(
        (m) => m[1],
      );
      const problem = result.tokens.find(
        (t) =>
          names.includes(t.name) &&
          t.reason &&
          !t.reason.startsWith("Overridden") &&
          (t.theme === undefined || t.theme === token.theme),
      );
      if (problem) {
        token.reason = `Unresolved alias dependency ${problem.name}: ${problem.reason}`;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const themes = [
    ...new Set(
      result.tokens.flatMap((t) => (t.theme === undefined ? [] : [t.theme])),
    ),
  ];
  const originalTokens = [...result.tokens];
  for (const theme of [undefined, ...themes]) {
    const environment: Record<string, string> = {};
    for (const scope of [undefined, ...(theme === undefined ? [] : [theme])])
      for (const t of originalTokens)
        if (t.theme === scope && t.name.startsWith("--") && !t.reason)
          environment[t.name] = t.resolved ?? t.value;
    for (const t of originalTokens) {
      if (t.theme === theme)
        t.environment = { ...t.environment, ...environment };
      if (
        theme === undefined ||
        t.theme !== undefined ||
        t.reason ||
        !t.value.includes("var(")
      )
        continue;
      const dependsOnTheme = (
        value: string,
        trail = new Set<string>(),
      ): boolean =>
        [...value.matchAll(/var\(\s*(--[-\w]+)/g)].some((match) => {
          const name = match[1] as string;
          if (trail.has(name)) return false;
          trail.add(name);
          return (
            originalTokens.some(
              (candidate) =>
                candidate.name === name && candidate.theme === theme,
            ) || dependsOnTheme(environment[name] ?? "", trail)
          );
        });
      if (
        !dependsOnTheme(t.value) ||
        originalTokens.some(
          (other) =>
            other.source.path === t.source.path &&
            other.source.key === t.source.key &&
            other.theme === theme,
        )
      )
        continue;
      result.tokens.push({
        ...t,
        theme,
        environment: { ...t.environment, ...environment },
        notes: [
          ...(t.notes ?? []),
          "Inherited alias resolved in this theme context",
        ],
      });
    }
  }
  for (const token of result.tokens)
    if (token.reason)
      result.diagnostics.push(
        `${token.source.path}:${token.name}: ${token.reason}`,
      );
  return result;
}
