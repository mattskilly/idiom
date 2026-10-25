import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import postcss, { type ChildNode } from "postcss";
import { excludedDirectories } from "./discover.js";
import { dimensionKind } from "./mapping.js";
import type { ExtractedToken, TokenKind } from "./types.js";

// CSS Color 4 named colours: https://www.w3.org/TR/css-color-4/#named-colors
const namedColors = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen`.split(
    " ",
  ),
);

export function cssKind(name: string, value: string): TokenKind {
  if (
    /^--color(?:-|$)/.test(name) ||
    /^(?:#|(?:rgb|hsl|oklch|oklab|lab|lch|color|light-dark|color-mix)\()/i.test(
      value,
    ) ||
    namedColors.has(value.toLowerCase())
  )
    return "color";
  return dimensionKind(name);
}

/** Parse declarations, never inject a source stylesheet into a browser. */
export async function extractCss(
  root: string,
  paths: string[],
  options: { ignoreOutsideImports?: boolean } = {},
): Promise<ExtractedToken[]> {
  const rootReal = await realpath(root);
  const visited = new Set<string>();
  const tokens: ExtractedToken[] = [];
  const visit = async (
    path: string,
    conditional = false,
    cascade = path,
  ): Promise<void> => {
    const lexical = relative(root, resolve(root, path));
    if (lexical.split(/[\\/]/).some((part) => excludedDirectories.has(part)))
      return;
    const actual = await realpath(resolve(root, path));
    const rel = relative(rootReal, actual);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error(`${path}: stylesheet import escapes the project`);
    let directory = root;
    for (const part of lexical.split(/[\\/]/).slice(0, -1)) {
      directory = resolve(directory, part);
      if ((await lstat(directory)).isSymbolicLink()) {
        if (options.ignoreOutsideImports) return;
        throw new Error(`${path}: directory symlinks are not followed`);
      }
    }
    if (visited.has(actual)) return;
    visited.add(actual);
    const parsed = postcss.parse(await readFile(actual, "utf8"), {
      from: path,
    });
    const walk = async (
      nodes: ChildNode[],
      theme?: string,
      eligible = false,
      uncertain = conditional,
    ) => {
      for (const node of nodes) {
        if (node.type === "atrule" && node.name === "import") {
          const match = /^(?:url\(\s*)?["']([^"']+)["']\s*\)?(.*)$/.exec(
            node.params,
          );
          if (
            match &&
            /\.css$/i.test(match[1] ?? "") &&
            !/^(?:[a-z]+:|\/\/)/i.test(match[1] ?? "")
          ) {
            const target = resolve(
              dirname(resolve(root, path)),
              match[1] as string,
            );
            try {
              await visit(
                relative(root, target),
                uncertain || (match[2] ?? "").trim() !== "",
                cascade,
              );
            } catch (error) {
              if (
                !(
                  options.ignoreOutsideImports &&
                  error instanceof Error &&
                  error.message.includes("escapes the project")
                )
              )
                throw error;
            }
          }
        } else if (node.type === "atrule" && node.nodes) {
          const isTheme = node.name === "theme" && node.parent?.type === "root";
          await walk(
            node.nodes,
            theme,
            isTheme || eligible,
            uncertain || !isTheme,
          );
        } else if (node.type === "rule") {
          for (const selector of node.selector
            .split(",")
            .map((s) => s.trim())) {
            const match =
              /^(?::root)?\[data-theme\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\]$/.exec(
                selector,
              );
            if (selector === ":root")
              await walk(node.nodes, undefined, true, uncertain);
            else if (match)
              await walk(
                node.nodes,
                match[1] ?? match[2] ?? match[3],
                true,
                uncertain,
              );
            else if (selector.includes("[data-theme"))
              await walk(node.nodes, undefined, true, true);
          }
        } else if (
          node.type === "decl" &&
          eligible &&
          node.prop.startsWith("--")
        ) {
          const value = node.value.trim();
          const themeDeclaration =
            node.parent?.type === "atrule" && node.parent.name === "theme";
          if (value === "initial" && !uncertain) {
            const prefix = node.prop.endsWith("*")
              ? node.prop.slice(0, -1)
              : node.prop;
            for (let i = tokens.length - 1; i >= 0; i--)
              if (
                tokens[i]?.theme === theme &&
                (themeDeclaration
                  ? tokens[i]?.context === "@theme"
                  : tokens[i]?.cascade === cascade) &&
                (node.prop.endsWith("*")
                  ? tokens[i]?.name.startsWith(prefix)
                  : tokens[i]?.name === prefix)
              )
                tokens.splice(i, 1);
            continue;
          }
          if (node.prop.includes("*")) continue;
          const existing = tokens.findIndex(
            (t) =>
              t.source.path === path &&
              t.name === node.prop &&
              t.theme === theme &&
              !t.reason &&
              !uncertain,
          );
          if (existing >= 0) tokens.splice(existing, 1);
          if (!uncertain)
            for (const earlier of tokens)
              if (
                !earlier.reason &&
                earlier.cascade === cascade &&
                earlier.name === node.prop &&
                earlier.theme === theme &&
                earlier.source.path !== path
              )
                earlier.reason = `Overridden by ${path} in the local import cascade`;
          tokens.push({
            cascade,
            context: themeDeclaration
              ? "@theme"
              : node.parent?.type === "rule"
                ? node.parent.selector
                : "conditional",
            name: node.prop,
            value,
            resolved: value,
            kind: cssKind(node.prop, value),
            source: { path, key: node.prop },
            ...(theme === undefined ? {} : { theme }),
            ...(node.prop === "--spacing" ? { base: true } : {}),
            ...(uncertain
              ? { reason: "Conditional or ambiguous CSS environment" }
              : {}),
            notes: ["CSS purpose inferred from namespace/name"],
          });
        }
      }
    };
    await walk(parsed.nodes);
  };
  // Visit importers first, preserving their local import/cascade order.
  const imported = new Set<string>();
  for (const path of paths) {
    const text = await readFile(resolve(root, path), "utf8");
    for (const match of text.matchAll(/@import\s+["']([^"']+)["']/g))
      imported.add(
        relative(root, resolve(root, dirname(path), match[1] as string)),
      );
  }
  for (const path of [
    ...paths.filter((p) => !imported.has(p)),
    ...paths.filter((p) => imported.has(p)),
  ])
    await visit(path);
  for (const token of tokens) {
    const applicable = tokens.filter(
      (t) => !t.reason && (t.theme === undefined || t.theme === token.theme),
    );
    const environment: Record<string, string> = {};
    for (const candidate of applicable.filter((t) => t.theme === undefined))
      environment[candidate.name] = candidate.value;
    for (const candidate of applicable.filter((t) => t.theme !== undefined))
      environment[candidate.name] = candidate.value;
    token.environment = environment;
    const isColorAlias = (
      value: string,
      trail = new Set<string>(),
    ): boolean => {
      if (cssKind("", value) === "color") return true;
      return [...value.matchAll(/var\(\s*(--[-\w]+)/g)].some((match) => {
        const name = match[1] as string;
        if (trail.has(name)) return false;
        trail.add(name);
        return isColorAlias(environment[name] ?? "", trail);
      });
    };
    if (
      token.kind === "other" &&
      token.value.includes("var(") &&
      isColorAlias(token.value)
    )
      token.kind = "color";
  }
  return tokens;
}
