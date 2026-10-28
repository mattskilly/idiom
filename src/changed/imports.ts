import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type ts from "typescript";

export type ImportGraph = {
  consumers: Map<string, Map<string, string[]>>;
  globalDependencies: Set<string>;
  /** Every uncertainty, for disclosure. */
  uncertainties: string[];
  /** Uncertainties not tied to one module (configuration), which make every edge suspect. */
  globalUncertainties: string[];
  /** Module → uncertainties about its own outgoing edges; only its consumers are suspect. */
  uncertainModules: Map<string, string[]>;
};
const sourceExtension = /\.(?:[cm]?[jt]sx?|svelte|astro|mdx)$/;
const leafExtension =
  /\.(?:css|scss|sass|less|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4)$/;

/** One invocation's graph. Parse syntax rather than matching import statements. */
export async function buildImportGraph(
  routes: string[],
  globals: string[],
): Promise<ImportGraph> {
  // Keep the external package import dynamic even in the single-file bundle.
  const ts = (await import("typescript")).default;
  const consumers: ImportGraph["consumers"] = new Map();
  const globalDependencies = new Set<string>();
  const uncertainties = new Set<string>();
  const globalUncertainties = new Set<string>();
  const uncertainModules: ImportGraph["uncertainModules"] = new Map();
  const uncertain = (file: string, message: string) => {
    const text = `${file}: ${message}`;
    uncertainties.add(text);
    const list = uncertainModules.get(file) ?? [];
    if (!list.includes(text)) list.push(text);
    uncertainModules.set(file, list);
  };
  const edges = new Map<string, string[]>();
  const configs = new Map<string, ts.CompilerOptions>();
  const resolutionCache = ts.createModuleResolutionCache(
    process.cwd(),
    (path) => path,
  );
  const optionsFor = (file: string): ts.CompilerOptions => {
    const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
    const key = config ?? "";
    const cached = configs.get(key);
    if (cached) return cached;
    let options: ts.CompilerOptions = {
      allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
    };
    if (config) {
      const loaded = ts.readConfigFile(config, ts.sys.readFile);
      if (loaded.error) {
        uncertainties.add(`cannot parse ${config}`);
        globalUncertainties.add(`cannot parse ${config}`);
      } else {
        const parsed = ts.parseJsonConfigFileContent(
          loaded.config,
          ts.sys,
          dirname(config),
        );
        // Empty fixture projects need not include compiler input files.
        if (
          parsed.errors.some(
            (error) => error.code !== 18003 && error.code !== 18002,
          )
        ) {
          uncertainties.add(`invalid configuration ${config}`);
          globalUncertainties.add(`invalid configuration ${config}`);
        }
        options = { ...options, ...parsed.options };
      }
    }
    configs.set(key, options);
    return options;
  };
  const resolveModule = (
    specifier: string,
    file: string,
  ): string | undefined => {
    // Runtime builtins (node:fs, path) never resolve to project source.
    if (isBuiltin(specifier)) return "external";
    const options = optionsFor(file);
    const resolved = ts.resolveModuleName(
      specifier,
      file,
      options,
      ts.sys,
      resolutionCache,
    ).resolvedModule;
    if (resolved)
      return resolved.isExternalLibraryImport ||
        resolved.resolvedFileName.includes("/node_modules/")
        ? "external"
        : resolve(resolved.resolvedFileName);
    const candidates: string[] = [];
    let matchedAlias = false;
    if (specifier.startsWith(".") || isAbsolute(specifier))
      candidates.push(resolve(dirname(file), specifier));
    for (const [pattern, replacements] of Object.entries(options.paths ?? {})) {
      const star = pattern.indexOf("*");
      const matched =
        star < 0
          ? specifier === pattern
          : specifier.startsWith(pattern.slice(0, star)) &&
            specifier.endsWith(pattern.slice(star + 1));
      if (matched) matchedAlias = true;
      if (matched)
        for (const replacement of replacements)
          candidates.push(
            resolve(
              options.baseUrl ??
                (typeof options.pathsBasePath === "string"
                  ? options.pathsBasePath
                  : undefined) ??
                dirname(
                  ts.findConfigFile(dirname(file), ts.sys.fileExists) ?? file,
                ),
              replacement.replace(
                "*",
                star < 0
                  ? ""
                  : specifier.slice(
                      star,
                      specifier.length - (pattern.length - star - 1),
                    ),
              ),
            ),
          );
    }
    if (options.baseUrl) candidates.push(resolve(options.baseUrl, specifier));
    for (const candidate of candidates)
      for (const suffix of [
        "",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".svelte",
        ".astro",
        "/index.ts",
        "/index.tsx",
        "/index.js",
        "/index.jsx",
        "/index.svelte",
        "/index.astro",
      ]) {
        const path = candidate + suffix;
        if (
          existsSync(path) &&
          (sourceExtension.test(path) || leafExtension.test(path))
        )
          return path;
      }
    // CSS and other package assets may not have a TS declaration.
    if (!specifier.startsWith(".") && !isAbsolute(specifier) && !matchedAlias) {
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      let directory = dirname(file);
      while (true) {
        if (
          existsSync(
            join(directory, "node_modules", name ?? "", "package.json"),
          )
        )
          return "external";
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    uncertain(file, `unresolved import ${JSON.stringify(specifier)}`);
    return undefined;
  };
  const dependencies = (file: string): string[] => {
    const cached = edges.get(file);
    if (cached) return cached;
    const result: string[] = [];
    edges.set(file, result);
    if (leafExtension.test(file)) return result;
    if (!sourceExtension.test(file) || file.endsWith(".mdx")) {
      uncertain(file, `unsupported source format`);
      return result;
    }
    optionsFor(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      uncertain(file, `cannot read source`);
      return result;
    }
    if (file.endsWith(".svelte") || file.endsWith(".astro")) {
      if (
        /<script\b[^>]*\blang\s*=\s*["'](?!ts["']|js["']|typescript["']|javascript["'])/.test(
          source,
        )
      )
        uncertain(file, `unsupported script language`);
    }
    if (file.endsWith(".svelte")) {
      if (/<script\b[^>]*\bsrc\s*=/.test(source))
        uncertain(file, `external Svelte script`);
      source = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .join("\n");
    } else if (file.endsWith(".astro")) {
      const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
      if (source.trimStart().startsWith("---") && !frontmatter)
        uncertain(file, `invalid Astro frontmatter`);
      source = [
        frontmatter?.[1] ?? "",
        ...[...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
          (match) => match[1],
        ),
      ].join("\n");
    }
    const syntax = ts.createSourceFile(
      file.replace(/\.(svelte|astro)$/, ".tsx"),
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const diagnostics = (
      syntax as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
    if (diagnostics?.length) uncertain(file, `malformed source`);
    const add = (node: ts.Expression) => {
      if (ts.isStringLiteralLike(node)) {
        const target = resolveModule(node.text, file);
        if (target && target !== "external") result.push(target);
      } else uncertain(file, `nonliteral module loading`);
    };
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      )
        add(node.moduleSpecifier);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression
      )
        add(node.moduleReference.expression);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        if (node.arguments[0]) add(node.arguments[0]);
        else uncertain(file, `missing module argument`);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ((ts.isMetaProperty(node.expression.expression) &&
          ["glob", "globEager"].includes(node.expression.name.text)) ||
          (ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "require" &&
            node.expression.name.text === "context"))
      )
        uncertain(
          file,
          `nonliteral module loading through ${node.expression.getText(syntax)}`,
        );
      ts.forEachChild(node, visit);
    };
    visit(syntax);
    return result;
  };
  for (const entry of [...routes, ...globals]) {
    const global = globals.includes(entry);
    const visited = new Set<string>();
    const walk = (file: string, chain: string[]) => {
      if (visited.has(file)) return;
      visited.add(file);
      if (global) globalDependencies.add(file);
      else {
        const associations = consumers.get(file) ?? new Map();
        associations.set(entry, chain);
        consumers.set(file, associations);
      }
      for (const dependency of dependencies(file))
        walk(dependency, [...chain, dependency]);
    };
    walk(entry, [entry]);
  }
  return {
    consumers,
    globalDependencies,
    uncertainties: [...uncertainties],
    globalUncertainties: [...globalUncertainties],
    uncertainModules,
  };
}
