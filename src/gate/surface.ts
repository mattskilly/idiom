import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type ts from "typescript";
import { type GitRead, readGit } from "../changed/git.js";

/**
 * What a change touches on screen, read from the changed lines alone: the
 * classes, CSS-module keys, ids, test ids and component names of the rules
 * and declarations that overlap them. The gate matches these against what
 * each state's latest capture rendered.
 */
export type SurfaceTokenKind =
  | "class"
  | "module"
  | "id"
  | "testId"
  | "component"
  | "sheet";

export type SurfaceToken = {
  kind: SurfaceTokenKind;
  value: string;
  /** CSS-module tokens: the stylesheet's base name before `.module`. */
  stem?: string | undefined;
  /** Repository-relative path of the changed file the token came from. */
  file: string;
};

export type SurfaceFile = {
  path: string;
  tokens: SurfaceToken[];
  /** False when the change could not be pinned to anything a page renders. */
  identified: boolean;
  reason?: string | undefined;
};

export type ChangedSurface = { files: SurfaceFile[] };

/** Inclusive new-side line ranges, 1-based. */
export type LineRange = { start: number; end: number };

/**
 * Generic utility class names that most pages render; matching on them says
 * nothing about where a change shows. Kept short on purpose: a component's
 * own class names are what rank states.
 */
const GENERIC_CLASSES = new Set([
  "flex",
  "grid",
  "hidden",
  "block",
  "inline",
  "relative",
  "absolute",
  "container",
  "row",
  "col",
  "active",
  "disabled",
  "open",
  "sr-only",
]);

/** A token worth matching on: specific to a component, not a utility. */
export function distinctive(token: SurfaceToken): boolean {
  if (token.kind !== "class") return true;
  const value = token.value;
  if (value.length < 3) return false;
  if (/[:[/]/.test(value)) return false;
  return !GENERIC_CLASSES.has(value);
}

/** Display form used in plan lines and matched-token lists. */
export function formatToken(
  token: Pick<SurfaceToken, "kind" | "value" | "stem">,
): string {
  switch (token.kind) {
    case "class":
      return `.${token.value}`;
    case "module":
      return `.${token.stem ? `${token.stem}.` : ""}${token.value}`;
    case "id":
      return `#${token.value}`;
    case "testId":
      return `[data-testid=${token.value}]`;
    case "component":
      return `<${token.value}>`;
    case "sheet":
      return `sheet:${token.value}`;
  }
}

/**
 * New-side changed line ranges per tracked path from one `git diff -U0`. A
 * pure deletion marks the line it sat after (and the next), so a removed
 * declaration still maps to its rule. Deleted files are listed separately.
 */
export async function changedLineRanges(options: {
  repository: string;
  base: string;
  paths: string[];
  untracked?: string[] | undefined;
  git?: GitRead | undefined;
  /** An already-run `git diff -U0` of the same paths (shared with the style scope). */
  diff?: string | undefined;
}): Promise<{
  ranges: Map<string, LineRange[] | "whole">;
  deleted: Set<string>;
}> {
  const git = options.git ?? readGit;
  const untracked = new Set(options.untracked ?? []);
  const ranges = new Map<string, LineRange[] | "whole">();
  const deleted = new Set<string>();
  for (const path of options.paths)
    if (untracked.has(path)) ranges.set(path, "whole");
  const tracked = options.paths.filter((path) => !untracked.has(path));
  if (!tracked.length) return { ranges, deleted };
  let diff = options.diff;
  if (diff === undefined)
    try {
      diff = await git(options.repository, [
        "diff",
        "-U0",
        "--no-color",
        "--no-renames",
        options.base,
        "--",
        ...tracked,
      ]);
    } catch {
      diff = "";
    }
  let current: string | undefined;
  let removed: string | undefined;
  for (const line of diff.split("\n")) {
    const from = /^--- a\/(.*)$/.exec(line);
    if (from) {
      removed = from[1];
      current = undefined;
      continue;
    }
    if (line === "+++ /dev/null") {
      if (removed !== undefined) deleted.add(removed);
      current = undefined;
      continue;
    }
    const to = /^\+\+\+ b\/(.*)$/.exec(line);
    if (to) {
      current = to[1];
      continue;
    }
    if (current === undefined) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const list = ranges.get(current);
    const entries = Array.isArray(list) ? list : [];
    entries.push(
      count === 0
        ? { start: Math.max(1, start), end: start + 1 }
        : { start, end: start + count - 1 },
    );
    ranges.set(current, entries);
  }
  return { ranges, deleted };
}

const overlaps = (range: LineRange, start: number, end: number) =>
  range.start <= end && range.end >= start;

const STYLE_FILE = /\.(?:css|scss|sass|less)$/i;
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const MARKUP_FILE = /\.(?:vue|svelte|astro|html?)$/i;
const MODULE_STYLE = /^(.+?)\.module\.(?:css|scss|sass|less)$/i;
const PASCAL = /^[A-Z][A-Za-z0-9]+$/;

/** `Toolbar.module.css` → `Toolbar`; undefined for global stylesheets. */
export function moduleStem(path: string): string | undefined {
  return MODULE_STYLE.exec(basename(path))?.[1];
}

type CssRule = {
  selector: string;
  start: number;
  end: number;
  at: boolean;
};

/** Rules with their selector and line span, comments blanked out. */
export function cssRules(source: string): CssRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const rules: CssRule[] = [];
  const stack: Array<{ selector: string; start: number; at: boolean }> = [];
  let line = 1;
  let boundary = 0;
  let boundaryLine = 1;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (char === "\n") line++;
    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") {
      const raw = text.slice(boundary, index);
      const leading = raw.length - raw.trimStart().length;
      const startLine =
        boundaryLine + (raw.slice(0, leading).match(/\n/g)?.length ?? 0);
      const selector = raw.trim();
      stack.push({ selector, start: startLine, at: selector.startsWith("@") });
      boundary = index + 1;
      boundaryLine = line;
    } else if (char === "}") {
      const open = stack.pop();
      if (open) rules.push({ ...open, end: line });
      boundary = index + 1;
      boundaryLine = line;
    } else if (char === ";") {
      boundary = index + 1;
      boundaryLine = line;
    }
  }
  return rules;
}

function selectorTokens(selector: string): {
  classes: string[];
  ids: string[];
} {
  // Drop attribute selectors and strings: `[href="#x"]` is not an id.
  const plain = selector
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/(["']).*?\1/g, " ");
  return {
    classes: [...plain.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(
      (match) => match[1] as string,
    ),
    ids: [...plain.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)].map(
      (match) => match[1] as string,
    ),
  };
}

function styleSurface(
  path: string,
  source: string,
  ranges: LineRange[] | "whole",
): SurfaceFile {
  const lines = source.split("\n");
  const rules = cssRules(source).filter((rule) => !rule.at);
  const stem = moduleStem(path);
  const tokens: SurfaceToken[] = [];
  const changed: number[] = [];
  if (ranges === "whole") {
    lines.forEach((_, index) => {
      changed.push(index + 1);
    });
  } else
    for (const range of ranges)
      for (let line = range.start; line <= range.end; line++)
        changed.push(line);
  let unscoped = false;
  const picked = new Set<CssRule>();
  for (const line of changed) {
    const text = lines[line - 1];
    if (
      text === undefined ||
      text.trim() === "" ||
      /^\s*(?:\/\*.*\*\/|\/\/.*)\s*$/.test(text)
    )
      continue;
    // A line may sit inside several nested rules: the innermost decides.
    const containing = rules
      .filter((rule) => rule.start <= line && rule.end >= line)
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    const innermost = containing[0];
    if (!innermost) {
      if (ranges !== "whole") unscoped = true;
      continue;
    }
    picked.add(innermost);
  }
  for (const rule of picked) {
    const { classes, ids } = selectorTokens(rule.selector);
    if (!classes.length && !ids.length) unscoped = true;
    for (const value of classes)
      tokens.push(
        stem === undefined
          ? { kind: "class", value, file: path }
          : { kind: "module", value, stem, file: path },
      );
    for (const value of ids) tokens.push({ kind: "id", value, file: path });
  }
  const sheet: SurfaceToken = { kind: "sheet", value: path, file: path };
  return finish(
    path,
    tokens,
    sheet,
    unscoped ? "change is not scoped to a class or id" : undefined,
  );
}

function finish(
  path: string,
  raw: SurfaceToken[],
  sheet: SurfaceToken | undefined,
  unscopedReason: string | undefined,
  emptyReason = "no class, id, test id or component in the changed code",
): SurfaceFile {
  const seen = new Set<string>();
  const unique = raw.filter((token) => {
    const key = `${token.kind}\0${token.stem ?? ""}\0${token.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const kept = unique.filter(distinctive);
  const tokens = [...kept, ...(sheet ? [sheet] : [])];
  if (unscopedReason !== undefined)
    return { path, tokens, identified: false, reason: unscopedReason };
  if (!kept.length)
    return {
      path,
      tokens,
      identified: false,
      reason: unique.length
        ? "only generic utility classes changed"
        : emptyReason,
    };
  return { path, tokens, identified: true };
}

const splitClasses = (value: string) =>
  value
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

async function scriptSurface(
  path: string,
  source: string,
  ranges: LineRange[] | "whole",
): Promise<SurfaceFile> {
  const typescript = (await import("typescript")).default;
  const kind = /\.tsx$/i.test(path)
    ? typescript.ScriptKind.TSX
    : /\.jsx$/i.test(path)
      ? typescript.ScriptKind.JSX
      : /\.[cm]?ts$/i.test(path)
        ? typescript.ScriptKind.TS
        : typescript.ScriptKind.JSX;
  const file = typescript.createSourceFile(
    path,
    source,
    typescript.ScriptTarget.Latest,
    true,
    kind,
  );
  const lineOf = (position: number) =>
    file.getLineAndCharacterOfPosition(position).line + 1;
  const modules = new Map<string, string>();
  for (const statement of file.statements)
    if (
      typescript.isImportDeclaration(statement) &&
      typescript.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause?.name
    ) {
      const stem = moduleStem(statement.moduleSpecifier.text);
      if (stem) modules.set(statement.importClause.name.text, stem);
    }
  const spans = file.statements.map((statement) => ({
    statement,
    start: lineOf(statement.getStart(file)),
    end: lineOf(statement.getEnd()),
  }));
  let chosen: ts.Statement[];
  if (ranges === "whole") chosen = [...file.statements];
  else {
    const lines = source.split("\n");
    const outside = ranges.some((range) => {
      for (let line = range.start; line <= range.end; line++) {
        if (!(lines[line - 1] ?? "").trim()) continue;
        if (!spans.some((span) => span.start <= line && span.end >= line))
          return true;
      }
      return false;
    });
    chosen = outside
      ? [...file.statements]
      : spans
          .filter((span) =>
            ranges.some((range) => overlaps(range, span.start, span.end)),
          )
          .map((span) => span.statement);
  }
  const tokens: SurfaceToken[] = [];
  const add = (token: Omit<SurfaceToken, "file">) =>
    tokens.push({ ...token, file: path });
  const component = (name: string | undefined) => {
    if (name && PASCAL.test(name)) add({ kind: "component", value: name });
  };
  const literal = (node: ts.Node | undefined): string | undefined => {
    if (!node) return undefined;
    if (
      typescript.isStringLiteral(node) ||
      typescript.isNoSubstitutionTemplateLiteral(node)
    )
      return node.text;
    if (typescript.isTemplateExpression(node)) return node.head.text;
    if (typescript.isJsxExpression(node)) return literal(node.expression);
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (
      (typescript.isFunctionDeclaration(node) ||
        typescript.isClassDeclaration(node)) &&
      node.name
    )
      component(node.name.text);
    else if (
      typescript.isVariableDeclaration(node) &&
      typescript.isIdentifier(node.name) &&
      node.initializer &&
      (typescript.isArrowFunction(node.initializer) ||
        typescript.isFunctionExpression(node.initializer) ||
        typescript.isCallExpression(node.initializer))
    )
      component(node.name.text);
    else if (
      typescript.isExportAssignment(node) &&
      typescript.isIdentifier(node.expression)
    )
      component(node.expression.text);
    else if (typescript.isJsxAttribute(node)) {
      const name = node.name.getText(file);
      const value = literal(node.initializer);
      if (value !== undefined) {
        if (name === "className" || name === "class")
          for (const entry of splitClasses(value))
            add({ kind: "class", value: entry });
        else if (name === "id" && value.trim())
          add({ kind: "id", value: value.trim() });
        else if (
          (name === "data-testid" || name === "data-test-id") &&
          value.trim()
        )
          add({ kind: "testId", value: value.trim() });
      }
    } else if (
      typescript.isPropertyAccessExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      modules.has(node.expression.text)
    )
      add({
        kind: "module",
        value: node.name.text,
        stem: modules.get(node.expression.text),
      });
    else if (
      typescript.isElementAccessExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      modules.has(node.expression.text)
    ) {
      const key = literal(node.argumentExpression);
      if (key)
        add({
          kind: "module",
          value: key,
          stem: modules.get(node.expression.text),
        });
    }
    typescript.forEachChild(node, visit);
  };
  for (const statement of chosen) visit(statement);
  const stem = basename(path).replace(/\.[^.]+$/, "");
  component(stem);
  return finish(path, tokens, undefined, undefined);
}

function markupSurface(
  path: string,
  source: string,
  ranges: LineRange[] | "whole",
): SurfaceFile {
  const lines = source.split("\n");
  const text =
    ranges === "whole"
      ? source
      : ranges
          .flatMap((range) => lines.slice(range.start - 1, range.end))
          .join("\n");
  const tokens: SurfaceToken[] = [];
  for (const match of text.matchAll(/\bclass(?:Name)?\s*=\s*["']([^"']*)["']/g))
    for (const value of splitClasses(match[1] as string))
      tokens.push({ kind: "class", value, file: path });
  for (const match of text.matchAll(/\bid\s*=\s*["']([^"']+)["']/g))
    tokens.push({ kind: "id", value: (match[1] as string).trim(), file: path });
  for (const match of text.matchAll(/\bdata-test-?id\s*=\s*["']([^"']+)["']/g))
    tokens.push({
      kind: "testId",
      value: (match[1] as string).trim(),
      file: path,
    });
  const stem = basename(path).replace(/\.[^.]+$/, "");
  if (PASCAL.test(stem) && !/\.html?$/i.test(path))
    tokens.push({ kind: "component", value: stem, file: path });
  return finish(path, tokens, undefined, undefined);
}

/** The surface of one file's changed lines; `source` is its new content. */
export async function fileSurface(
  path: string,
  source: string,
  ranges: LineRange[] | "whole",
): Promise<SurfaceFile> {
  if (STYLE_FILE.test(path)) return styleSurface(path, source, ranges);
  if (SCRIPT_FILE.test(path)) {
    try {
      return await scriptSurface(path, source, ranges);
    } catch {
      return {
        path,
        tokens: [],
        identified: false,
        reason: "could not parse the changed file",
      };
    }
  }
  if (MARKUP_FILE.test(path)) return markupSurface(path, source, ranges);
  return {
    path,
    tokens: [],
    identified: false,
    reason: "not a stylesheet, script or markup file",
  };
}

/**
 * The changed surface of every UI file (repository-relative paths). Never
 * throws: a file it cannot read or diff is unidentified with a reason.
 */
export async function extractChangedSurface(options: {
  repository: string;
  base: string;
  files: Array<{ path: string; ui: boolean }>;
  untracked?: string[] | undefined;
  git?: GitRead | undefined;
}): Promise<ChangedSurface> {
  const paths = options.files
    .filter((file) => file.ui)
    .map((file) => file.path);
  if (!paths.length) return { files: [] };
  const { ranges, deleted } = await changedLineRanges({
    repository: options.repository,
    base: options.base,
    paths,
    untracked: options.untracked,
    git: options.git,
  });
  const files: SurfaceFile[] = [];
  for (const path of paths) {
    if (deleted.has(path)) {
      files.push({ path, tokens: [], identified: false, reason: "deleted" });
      continue;
    }
    const absolute = join(options.repository, path);
    if (!existsSync(absolute)) {
      files.push({ path, tokens: [], identified: false, reason: "deleted" });
      continue;
    }
    let source: string;
    try {
      source = await readFile(absolute, "utf8");
    } catch {
      files.push({
        path,
        tokens: [],
        identified: false,
        reason: "could not read the changed file",
      });
      continue;
    }
    const fileRanges = ranges.get(path);
    if (fileRanges === undefined) {
      // Changed only in mode or whitespace git ignores: nothing renders new.
      files.push({
        path,
        tokens: [],
        identified: false,
        reason: "no changed lines",
      });
      continue;
    }
    files.push(await fileSurface(path, source, fileRanges));
  }
  return { files };
}
