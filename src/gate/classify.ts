import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { globRegex } from "../../plugins/claude/hooks/lib.mjs";
import { type GitRead, readGit } from "../changed/git.js";
import type { ChangedSelection, FileMapping } from "../changed/select.js";

export type FileClass = {
  path: string;
  ui: boolean;
  /** Why the gate called the file non-UI or UI. */
  reason: string;
};

/** Changed paths that never reach a rendered page. */
const nonUiPatterns: Array<[RegExp, string]> = [
  [/(?:^|\/)(?:DESIGN|PRODUCT)\.md$/i, ""],
  [/\.md$/i, "documentation"],
  [/^docs\//, "documentation"],
  [/(?:^|\/)(?:test|tests|__tests__)\//, "tests"],
  [/\.(?:test|spec)\.[^/]+$/, "tests"],
  [/^\.github\//, "CI configuration"],
  [/^\.ab\//, "build scratch"],
  [/^\.autobuild\//, "build scratch"],
  [
    /(?:^|\/)(?:[^/]+\.lock|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml)$/,
    "lockfile",
  ],
  [/(?:^|\/)\.idiom\/(?:reports|cache)\//, "Idiom run output"],
];

const uiExtension =
  /\.(?:css|scss|sass|less|tsx|jsx|vue|svelte|astro|html|mdx|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i;
const styleModule = /\.(?:css\.[jt]s|styles?\.[^/]+|styled\.[^/]+)$/i;
const assetDirectory = /(?:^|\/)(?:public|static|assets)\//;
/**
 * Build and runtime configuration: no route imports it, yet a basePath, a
 * dependency bump, a rewrite or a path alias can change every page.
 */
const buildConfig =
  /(?:^|\/)(?:package\.json|[^/]+\.config\.[cm]?[jt]s|(?:middleware|proxy)\.[cm]?[jt]s|\.env(?:\.[^/]*)?|[tj]sconfig(?:\.[^/]*)?\.json)$/i;

/** Pattern pass: no import graph, so a docs-only change exits in milliseconds. */
export function classifyByPath(
  files: Array<{ path: string }>,
  nonUi: string[] = [],
): FileClass[] {
  const globs = nonUi.map((glob) => [glob, globRegex(glob)] as const);
  return files.map(({ path }) => {
    const normalized = path.replaceAll("\\", "/");
    for (const [pattern, reason] of nonUiPatterns)
      if (pattern.test(normalized))
        return reason
          ? { path, ui: false, reason }
          : { path, ui: true, reason: "design context" };
    const glob = globs.find(([, regex]) => regex.test(normalized));
    if (glob)
      return { path, ui: false, reason: `checks.gate.nonUi ${glob[0]}` };
    return { path, ui: true, reason: "may affect the UI" };
  });
}

/**
 * Import pass over a changed selection: a module no route reaches is non-UI,
 * but only when the graph accounts for every edge. Otherwise every file stays
 * UI and falls back exactly as `--changed` does.
 */
export function classifySelection(
  selection: Pick<ChangedSelection, "files" | "graph">,
  htmlDirectories: string[] = [],
): FileClass[] {
  const complete = selection.graph?.complete === true;
  return selection.files.map((file) => {
    if (!complete)
      return {
        path: file.path,
        ui: true,
        reason: "import graph incomplete",
      };
    return serverOnly(file, htmlDirectories)
      ? {
          path: file.path,
          ui: false,
          reason: "no route module imports it",
        }
      : { path: file.path, ui: true, reason: file.reason };
  });
}

function serverOnly(file: FileMapping, htmlDirectories: string[]): boolean {
  const path = file.path.replaceAll("\\", "/");
  return (
    file.kind === "unresolved" &&
    !file.importChains?.length &&
    !file.uncertainties?.length &&
    !uiExtension.test(path) &&
    !styleModule.test(path) &&
    !assetDirectory.test(path) &&
    !buildConfig.test(path) &&
    !htmlDirectories.some(
      (directory) => directory === "" || path.startsWith(`${directory}/`),
    )
  );
}

export type StyleScope = {
  responsive: string[];
  theme: string[];
  /** Media-query and Tailwind breakpoints in the changed lines. */
  breakpoints?: Breakpoint[] | undefined;
  /** The change styles the dark (or light) scheme specifically. */
  prefersDark?: boolean | undefined;
  prefersLight?: boolean | undefined;
};

export type Breakpoint = { feature: "min-width" | "max-width"; px: number };

const tailwindBreakpoints: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
};

/** Width breakpoints a changed line names: `@media (max-width: 640px)`, `md:`. */
export function lineBreakpoints(line: string): Breakpoint[] {
  const found: Breakpoint[] = [];
  for (const match of line.matchAll(
    /\b(min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|em|rem)?/g,
  )) {
    const unit = match[3] ?? "px";
    const value = Number(match[2]) * (unit === "px" ? 1 : 16);
    found.push({
      feature: match[1] === "min" ? "min-width" : "max-width",
      px: Math.round(value),
    });
  }
  for (const match of line.matchAll(/(?:^|[\s"'`])(sm|md|lg|xl|2xl):/g))
    found.push({
      feature: "min-width",
      px: tailwindBreakpoints[match[1] as string] as number,
    });
  return found;
}

/** Whether a viewport width satisfies any of the breakpoints. */
export function satisfiesBreakpoint(
  width: number,
  breakpoints: Breakpoint[],
): boolean {
  return breakpoints.some((breakpoint) =>
    breakpoint.feature === "min-width"
      ? width >= breakpoint.px
      : width <= breakpoint.px,
  );
}

/**
 * Widened viewports ordered by how likely they are to show the change: the
 * first (default) stays first, then those a changed breakpoint selects in
 * project order, then the rest in reverse project order. The gate trims from
 * the end, so the least likely goes first.
 */
export function orderViewports(
  viewports: Array<{ name: string; width: number }>,
  breakpoints: Breakpoint[],
): string[] {
  const [first, ...rest] = viewports;
  if (!first) return [];
  const likely = rest.filter((viewport) =>
    satisfiesBreakpoint(viewport.width, breakpoints),
  );
  const others = rest
    .filter((viewport) => !likely.includes(viewport))
    .reverse();
  return [first, ...likely, ...others].map((viewport) => viewport.name);
}

/** Widened schemes: the default first, then the one the change styles. */
export function orderSchemes<T extends string>(
  schemes: T[],
  defaultScheme: T | undefined,
  scope: Pick<StyleScope, "prefersDark" | "prefersLight">,
): T[] {
  const ordered =
    defaultScheme === undefined
      ? [...schemes]
      : [
          defaultScheme,
          ...schemes.filter((scheme) => scheme !== defaultScheme),
        ];
  const [head, ...tail] = ordered;
  if (head === undefined) return [];
  const weight = (scheme: string) =>
    (scope.prefersDark && scheme === "dark") ||
    (scope.prefersLight && scheme === "light")
      ? 0
      : 1;
  return [head, ...tail.sort((a, b) => weight(a) - weight(b))];
}

const responsivePatterns = [
  /@media[^{]*\b(?:min-|max-)?(?:width|height|aspect-ratio|orientation)\b/,
  /@container\b/,
  /(?:^|[\s"'`])(?:sm|md|lg|xl|2xl|max-[a-z0-9]+|min-\[[^\]]*\]):/,
  /\buseMediaQuery\s*\(/,
  /\bmatchMedia\s*\([^)]*\b(?:width|height)\b/,
];
const themePatterns = [
  /prefers-color-scheme/,
  /(?:^|[\s"'`])dark:/,
  /\[data-theme/,
  /\.dark(?:\s|\{)/,
  /color-scheme/,
];

/**
 * Whether the change touches responsive or theme styling: added and removed
 * lines of tracked UI files, and the whole of untracked ones.
 */
export async function detectStyleScope(options: {
  repository: string;
  base: string;
  files: FileClass[];
  untracked?: string[] | undefined;
  globalFiles?: string[] | undefined;
  colorSchemeAttribute?: string | undefined;
  git?: GitRead | undefined;
}): Promise<StyleScope> {
  const git = options.git ?? readGit;
  const ui = options.files.filter((file) => file.ui).map((file) => file.path);
  const scope: StyleScope = {
    responsive: [],
    theme: [],
    breakpoints: [],
    prefersDark: false,
    prefersLight: false,
  };
  if (!ui.length) return scope;
  const theme = [
    ...themePatterns,
    ...(options.colorSchemeAttribute
      ? [
          new RegExp(
            options.colorSchemeAttribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          ),
        ]
      : []),
  ];
  const untracked = new Set(options.untracked ?? []);
  const changedLines = new Map<string, string[]>();
  const tracked = ui.filter((path) => !untracked.has(path));
  if (tracked.length) {
    let diff = "";
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
    for (const line of diff.split("\n")) {
      const header =
        /^\+\+\+ b\/(.*)$/.exec(line) ?? /^--- a\/(.*)$/.exec(line);
      if (header) {
        current = header[1];
        continue;
      }
      if (current === undefined) continue;
      if (/^[+-](?![+-]{2} )/.test(line)) {
        const lines = changedLines.get(current) ?? [];
        lines.push(line.slice(1));
        changedLines.set(current, lines);
      }
    }
  }
  for (const path of ui)
    if (untracked.has(path) || !tracked.includes(path)) {
      const absolute = join(options.repository, path);
      if (!existsSync(absolute)) continue;
      try {
        changedLines.set(path, (await readFile(absolute, "utf8")).split("\n"));
      } catch {
        // An unreadable file adds no scope.
      }
    }
  for (const path of ui) {
    const lines = changedLines.get(path) ?? [];
    if (lines.some((line) => responsivePatterns.some((re) => re.test(line))))
      scope.responsive.push(path);
    if (lines.some((line) => theme.some((re) => re.test(line))))
      scope.theme.push(path);
    for (const line of lines) {
      scope.breakpoints?.push(...lineBreakpoints(line));
      if (
        /prefers-color-scheme\s*:\s*dark/.test(line) ||
        /(?:^|[\s"'`])dark:/.test(line) ||
        /\.dark(?:\s|\{|,)/.test(line)
      )
        scope.prefersDark = true;
      if (/prefers-color-scheme\s*:\s*light/.test(line))
        scope.prefersLight = true;
    }
  }
  for (const path of options.globalFiles ?? [])
    if (!scope.theme.includes(path) && ui.includes(path))
      scope.theme.push(path);
  return scope;
}
