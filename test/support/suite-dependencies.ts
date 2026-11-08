import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

type Reference = { module: string; name: string };
type Export = Reference | { local: string };
type Module = {
  source: ts.SourceFile;
  imports: Map<string, Reference>;
  declarations: Map<string, ts.Node>;
  exports: Map<string, Export>;
  sideEffects: Reference[];
  stars: string[];
};
export type ResourceUse = { file: string; resource: string };

/**
 * Trace all runtime dependencies in test/fixture/script helpers. For production
 * modules, trace the imported value's declarations instead of unrelated exports:
 * projectSchema must not inherit an unused browser launcher's resource needs.
 * This is conservative static admission, not a substitute for reviewing a file.
 */
export function resourceScanner(
  root: string,
  read: (file: string) => string | undefined = (file) =>
    existsSync(file) && statSync(file).isFile()
      ? readFileSync(file, "utf8")
      : undefined,
) {
  const modules = new Map<string, Module>();
  const texts = new Map<string, string | undefined>();
  const readText = (file: string) => {
    if (!texts.has(file)) {
      try {
        texts.set(file, read(file));
      } catch {
        texts.set(file, undefined);
      }
    }
    return texts.get(file);
  };
  function resolveModule(file: string, name: string) {
    if (!name.startsWith(".")) return name;
    const base = resolve(dirname(file), name);
    const candidates = [
      base.replace(/\.js$/, ".ts"),
      base,
      `${base}.ts`,
      join(base, "index.ts"),
    ];
    return (
      candidates.find((candidate) => {
        return readText(candidate) !== undefined;
      }) ?? base
    );
  }
  function load(file: string): Module | undefined {
    const cached = modules.get(file);
    if (cached) return cached;
    const text = readText(file);
    if (text === undefined) return undefined;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const result: Module = {
      source,
      imports: new Map(),
      declarations: new Map(),
      exports: new Map(),
      sideEffects: [],
      stars: [],
    };
    const declare = (
      name: ts.BindingName,
      node: ts.Node | undefined,
      exported: boolean,
    ) => {
      if (ts.isIdentifier(name)) {
        if (node) result.declarations.set(name.text, node);
        if (exported) result.exports.set(name.text, { local: name.text });
      } else
        for (const element of name.elements)
          if (ts.isBindingElement(element))
            declare(element.name, node, exported);
    };
    for (const node of source.statements) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        const module = node.moduleSpecifier.text;
        const clause = node.importClause;
        if (!clause) {
          result.sideEffects.push({ module, name: "*" });
          continue;
        }
        if (clause.isTypeOnly) continue;
        if (clause.name)
          result.imports.set(clause.name.text, { module, name: "default" });
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings))
          result.imports.set(bindings.name.text, { module, name: "*" });
        else if (bindings)
          for (const element of bindings.elements)
            if (!element.isTypeOnly)
              result.imports.set(element.name.text, {
                module,
                name: element.propertyName?.text ?? element.name.text,
              });
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
        const module =
          node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : undefined;
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements)
            if (!element.isTypeOnly)
              result.exports.set(
                element.name.text,
                module
                  ? {
                      module,
                      name: element.propertyName?.text ?? element.name.text,
                    }
                  : { local: element.propertyName?.text ?? element.name.text },
              );
        } else if (module) result.stars.push(module);
      } else {
        if (ts.isExportAssignment(node)) {
          result.exports.set("default", { local: "__default" });
          result.declarations.set("__default", node.expression);
        }
        const exported =
          ts.canHaveModifiers(node) &&
          ts
            .getModifiers(node)
            ?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            ) === true;
        if (
          (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
          node.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
          )
        ) {
          result.exports.set("default", { local: "__default" });
          result.declarations.set("__default", node);
        }
        if (ts.isVariableStatement(node))
          for (const declaration of node.declarationList.declarations)
            declare(declaration.name, declaration.initializer, exported);
        else if (
          (ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isEnumDeclaration(node)) &&
          node.name
        )
          declare(node.name, node, exported);
      }
    }
    modules.set(file, result);
    return result;
  }
  return (entry: string): ResourceUse[] => {
    const seen = new Set<string>();
    const resources = new Map<string, ResourceUse>();
    const record = (file: string, resource: string) => {
      const use = { file: relative(root, file), resource };
      resources.set(`${use.file}:${resource}`, use);
    };
    function visit(file: string, names: string[]) {
      const key = `${file}:${names.join(",")}`;
      if (seen.has(key)) return;
      seen.add(key);
      const module = load(file);
      if (!module) return;
      const locals = new Set<string>();
      const follow = (reference: Reference) => {
        const target = resolveModule(file, reference.module);
        if (
          /^(?:node:)?child_process$|^(?:@axe-core\/)?playwright(?:-core)?(?:\/|$)|^electron(?:\/|$)/.test(
            target,
          )
        )
          record(file, reference.module);
        else if (
          /^(?:node:)?(?:http|https|http2|net|tls)$/.test(target) &&
          [
            "createServer",
            "createSecureServer",
            "Server",
            "*",
            "default",
          ].includes(reference.name)
        )
          record(file, `${reference.module}:${reference.name}`);
        else if (isAbsolute(target)) {
          if (/\/test\/support\/fixture-server\.[jt]s$/.test(target))
            record(file, "fixture-server");
          visit(target, [reference.name]);
        }
      };
      const local = (name: string) => {
        if (locals.has(name)) return;
        locals.add(name);
        const reference = module.imports.get(name);
        if (reference) follow(reference);
        const declaration = module.declarations.get(name);
        if (declaration) walk(declaration);
      };
      function walk(node: ts.Node) {
        if (
          ts.isTypeNode(node) ||
          ts.isImportDeclaration(node) ||
          ts.isExportDeclaration(node)
        )
          return;
        if (ts.isIdentifier(node)) {
          const parent = node.parent;
          if (
            !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
            !(ts.isPropertyAssignment(parent) && parent.name === node) &&
            !(ts.isMethodDeclaration(parent) && parent.name === node)
          )
            local(node.text);
        }
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (
            callee.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(callee) && callee.text === "require")
          ) {
            const argument = node.arguments[0];
            if (argument && ts.isStringLiteralLike(argument))
              follow({ module: argument.text, name: "*" });
            else
              record(
                file,
                "computed runtime import (review before unit admission)",
              );
          }
          if (
            (ts.isPropertyAccessExpression(callee) &&
              ["createServer", "listen"].includes(callee.name.text)) ||
            (ts.isIdentifier(callee) && callee.text === "createServer")
          )
            record(file, "server construction/listen");
        }
        ts.forEachChild(node, walk);
      }
      // Tests and local helpers are inspected in full, including literal dynamic
      // imports. Source exports are followed by value so type imports stay inert.
      if (file.startsWith(`${join(root, "test")}/`) || names.includes("*")) {
        for (const reference of module.imports.values()) follow(reference);
        for (const exported of module.exports.values())
          if ("module" in exported) follow(exported);
        for (const target of module.stars)
          follow({ module: target, name: "*" });
        walk(module.source);
      } else {
        for (const name of names) {
          const exported = module.exports.get(name);
          if (exported && "local" in exported) local(exported.local);
          else if (exported) follow(exported);
          else
            for (const target of module.stars) follow({ module: target, name });
        }
        // Top-level expressions execute even when only a pure export is used.
        for (const node of module.source.statements)
          if (ts.isExpressionStatement(node)) walk(node);
      }
      for (const reference of module.sideEffects) follow(reference);
    }
    visit(resolve(root, entry), ["*"]);
    return [...resources.values()].sort((a, b) =>
      `${a.file}:${a.resource}`.localeCompare(`${b.file}:${b.resource}`),
    );
  };
}
