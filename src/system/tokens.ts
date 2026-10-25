import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import postcss from "postcss";
import { loadTokenDeclarations } from "../checks/observe.js";
import { IdiomError } from "../errors.js";
import { cssKind } from "./learn/css.js";
import { inlineDeclarations } from "./learn/inline.js";
import type { DesignToken } from "./learn/schema.js";
import { tokenIdentity } from "./learn/schema.js";
import type { SystemToken, SystemTokens } from "./types.js";

type DefinitionMap = Map<string, Set<string>>;
type VarUse = { name: string; fallback: string | undefined };

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function importTarget(params: string): string | undefined {
  const trimmed = params.trim();
  const quoted = /^(?:url\(\s*)?(["'])(.*?)\1\s*\)?/u.exec(trimmed);
  const target =
    quoted?.[2] ?? /^(?:url\(\s*)?([^\s)'";]+)/u.exec(trimmed)?.[1];
  if (
    target === undefined ||
    (!target.startsWith("./") && !target.startsWith("../")) ||
    !target.toLowerCase().endsWith(".css")
  )
    return undefined;
  return target;
}

function varUses(source: string): VarUse[] {
  const uses: VarUse[] = [];
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source.slice(cursor, cursor + 4).toLowerCase() !== "var(") continue;
    let depth = 1;
    let quote = "";
    let end = cursor + 4;
    for (; end < source.length && depth > 0; end += 1) {
      const character = source[end] ?? "";
      if (quote !== "") {
        if (character === quote && source[end - 1] !== "\\") quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    if (depth !== 0) continue;
    const body = source.slice(cursor + 4, end - 1);
    let split = -1;
    depth = 0;
    quote = "";
    for (let index = 0; index < body.length; index += 1) {
      const character = body[index] ?? "";
      if (quote !== "") {
        if (character === quote && body[index - 1] !== "\\") quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 0) {
        split = index;
        break;
      }
    }
    const name = body.slice(0, split < 0 ? undefined : split).trim();
    if (/^--[-_A-Za-z0-9]+$/u.test(name))
      uses.push({
        name,
        fallback: split < 0 ? undefined : body.slice(split + 1).trim(),
      });
    cursor = end - 1;
  }
  return uses;
}

async function cssFiles(
  projectDirectory: string,
  configuredPath: string,
): Promise<string[]> {
  let rootReal: string;
  let configuredReal: string;
  try {
    [rootReal, configuredReal] = await Promise.all([
      realpath(projectDirectory),
      realpath(configuredPath),
    ]);
  } catch (error) {
    throw new IdiomError(
      `cannot resolve design token sources: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!contained(rootReal, configuredReal))
    throw new IdiomError("design.tokensFile must remain inside the project");

  const siblingDirectory = dirname(configuredPath);
  let siblings: string[];
  try {
    siblings = (await readdir(siblingDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => join(siblingDirectory, entry.name))
      .sort();
  } catch (error) {
    throw new IdiomError(
      `cannot enumerate token support sources ${relative(projectDirectory, siblingDirectory)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const accepted: string[] = [];
  const visited = new Set<string>();
  const visit = async (lexicalPath: string): Promise<void> => {
    const path = resolve(lexicalPath);
    if (visited.has(path) || !contained(projectDirectory, path)) return;
    visited.add(path);
    let actual: string;
    try {
      actual = await realpath(path);
      const entry = await stat(path);
      if (!entry.isFile() || !contained(rootReal, actual)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    accepted.push(path);
    let parsed: postcss.Root;
    try {
      parsed = postcss.parse(await readFile(path, "utf8"), { from: path });
    } catch (error) {
      throw new IdiomError(
        `cannot parse token support stylesheet ${relative(projectDirectory, path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const imports = parsed.nodes.flatMap((node) => {
      if (node.type !== "atrule" || node.name.toLowerCase() !== "import")
        return [];
      const target = importTarget(node.params);
      return target === undefined ? [] : [resolve(dirname(path), target)];
    });
    for (const imported of imports.sort()) await visit(imported);
  };
  await visit(configuredPath);
  for (const sibling of siblings) await visit(sibling);
  return accepted;
}

async function definitionsFrom(
  files: readonly string[],
): Promise<DefinitionMap> {
  const definitions: DefinitionMap = new Map();
  for (const file of files) {
    const parsed = postcss.parse(await readFile(file, "utf8"), { from: file });
    parsed.walkDecls((declaration) => {
      if (!declaration.prop.startsWith("--") || declaration.value.trim() === "")
        return;
      const values = definitions.get(declaration.prop) ?? new Set<string>();
      values.add(declaration.value.trim());
      definitions.set(declaration.prop, values);
    });
  }
  return definitions;
}

function resolveToken(
  name: string,
  authoredValue: string,
  definitions: DefinitionMap,
  environment: Record<string, string>,
): SystemToken {
  const walk = (
    value: string,
    trail: string[],
  ): { ok: true } | { ok: false; reason: string } => {
    for (const use of varUses(value)) {
      if (trail.includes(use.name))
        return {
          ok: false,
          reason: `cyclic custom-property dependency: ${[...trail, use.name].join(" → ")}`,
        };
      const values = definitions.get(use.name);
      if (values === undefined || values.size === 0) {
        if (use.fallback !== undefined && use.fallback !== "") {
          const fallback = walk(use.fallback, trail);
          if (!fallback.ok) return fallback;
          continue;
        }
        return {
          ok: false,
          reason: `${use.name} resolves outside the available token sources`,
        };
      }
      if (values.size > 1)
        return {
          ok: false,
          reason: `${use.name} has conflicting declarations in the available token sources`,
        };
      const dependency = [...values][0] as string;
      environment[use.name] = dependency;
      const nested = walk(dependency, [...trail, use.name]);
      if (!nested.ok) return nested;
    }
    return { ok: true };
  };
  const result = walk(authoredValue, [name]);
  return {
    name,
    value: authoredValue,
    resolution: result.ok
      ? { status: "available" }
      : { status: "unavailable", reason: result.reason },
  };
}

export async function collectSystemTokens(
  projectDirectory: string,
  tokensFile: string | undefined,
  inline: DesignToken[] = [],
): Promise<SystemTokens> {
  const authored = await loadTokenDeclarations(projectDirectory, tokensFile);
  const inlineTokens: SystemToken[] = inlineDeclarations(inline).map((t) => ({
    ...t,
    resolution: t.reason
      ? { status: "unavailable", reason: t.reason }
      : { status: "available" },
  }));
  if (authored.status === "not-configured")
    return inlineTokens.length
      ? {
          status: "configured",
          source: "design.tokens",
          tokens: inlineTokens,
          declarations: inlineDeclarations(inline),
          environment: {},
        }
      : authored;
  const configuredPath = resolve(projectDirectory, authored.source);
  const definitions = await definitionsFrom(
    await cssFiles(projectDirectory, configuredPath),
  );
  for (const [name, value] of Object.entries(authored.declarations))
    definitions.set(name, new Set([value]));
  const environment: Record<string, string> = { ...authored.declarations };
  const tokens = Object.entries(authored.declarations)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({
      ...resolveToken(name, value, definitions, environment),
      kind: cssKind(name, value),
      source: { path: authored.source, key: name },
    }));
  const inlineIds = new Set(inline.map(tokenIdentity));
  const declarations = [
    ...(authored.fileTokens ?? []).filter(
      (t) => !inlineIds.has(tokenIdentity(t)),
    ),
    ...inlineDeclarations(inline),
  ];
  return {
    status: "configured",
    declarations,
    source: authored.source,
    tokens: [
      ...tokens.filter(
        (t) =>
          !inlineIds.has(
            tokenIdentity({ ...t, kind: t.kind ?? "other", source: t.source }),
          ),
      ),
      ...inlineTokens,
    ],
    environment,
  };
}
