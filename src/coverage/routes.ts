import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type Flow, stateChainLabel } from "../schemas/flow.js";

export type DiscoveredRoute = {
  route: string;
  source: string;
};

/** `label` names the chain for a state reached from another state. */
export type CoveredState = { flow: string; state: string; label?: string };

export type RouteCoverage = {
  route: string;
  source: string;
  capturedBy: CoveredState[];
  /** Concrete paths flows used for a dynamic route, in flow order. */
  examples: string[];
};

export type ExcludedRoute = DiscoveredRoute & { pattern: string };

const ignoredDirectories = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "out",
  ".turbo",
  ".vercel",
  ".idiom",
  ".autobuild",
  "coverage",
]);

const pageFile = /^page\.(?:tsx|ts|jsx|js|mdx)$/;
const pagesRouterFile = /\.(?:tsx|ts|jsx|js|mdx)$/;
const astroPageFile = /\.(?:astro|md|mdx|html)$/;

async function walk(
  directory: string,
  visit: (path: string, entry: Dirent) => void,
  depth = 0,
): Promise<void> {
  if (depth > 12) return;
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name) || entry.name.startsWith("_"))
        continue;
      await walk(path, visit, depth + 1);
    } else visit(path, entry);
  }
}

/** Route roots: `app/` and `pages/` directories, in a monorepo or not. */
async function routeRoots(
  projectDirectory: string,
): Promise<Array<{ kind: "app" | "pages"; path: string }>> {
  const roots: Array<{ kind: "app" | "pages"; path: string }> = [];
  const visitDirectories = async (directory: string, depth: number) => {
    if (depth > 4) return;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.name === "app" || entry.name === "pages") {
        roots.push({ kind: entry.name, path });
        continue;
      }
      if (
        ["apps", "packages", "src", "web", "frontend", "site"].includes(
          entry.name,
        ) ||
        depth > 0
      )
        await visitDirectories(path, depth + 1);
    }
  };
  await visitDirectories(projectDirectory, 0);
  return roots;
}

export function appRouteFromSegments(segments: string[]): string | undefined {
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith("@") || segment.startsWith("_")) return undefined;
    if (/^\(\.{1,3}\)/.test(segment)) return undefined;
    if (segment.startsWith("(") && segment.endsWith(")")) continue;
    kept.push(segment);
  }
  return `/${kept.join("/")}`;
}

/** Every (route, source) pair the filesystem routers declare, in walk order. */
export async function discoverRouteEntries(
  projectDirectory: string,
): Promise<DiscoveredRoute[]> {
  const found: DiscoveredRoute[] = [];
  const boundary = resolve(projectDirectory);
  const owners = new Map<string, Promise<boolean>>();
  const isAstro = (directory: string): Promise<boolean> => {
    const cached = owners.get(directory);
    if (cached) return cached;
    const lookup = (async () => {
      try {
        const manifest = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        return (
          Object.hasOwn(manifest?.dependencies ?? {}, "astro") ||
          Object.hasOwn(manifest?.devDependencies ?? {}, "astro")
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        const parent = dirname(directory);
        if (
          directory === boundary ||
          relative(boundary, parent).startsWith("..")
        )
          return false;
        return isAstro(parent);
      }
    })();
    owners.set(directory, lookup);
    return lookup;
  };
  for (const root of await routeRoots(projectDirectory)) {
    const extension =
      root.kind === "pages" && (await isAstro(resolve(root.path)))
        ? astroPageFile
        : pagesRouterFile;
    await walk(root.path, (path, entry) => {
      const relativePath = relative(root.path, path);
      const segments = relativePath.split(sep);
      const source = relative(projectDirectory, path);
      if (root.kind === "app") {
        if (!pageFile.test(entry.name)) return;
        const route = appRouteFromSegments(segments.slice(0, -1));
        if (route !== undefined) found.push({ route, source });
        return;
      }
      if (
        !extension.test(entry.name) ||
        segments[0] === "api" ||
        segments.some((segment) => segment.startsWith("_")) ||
        /\.d\.[cm]?ts$/.test(entry.name)
      )
        return;
      const name = entry.name.replace(extension, "");
      if (name.startsWith("_")) return;
      const parts = [
        ...segments.slice(0, -1),
        ...(name === "index" ? [] : [name]),
      ];
      found.push({ route: `/${parts.join("/")}`, source });
    });
  }
  return found;
}

/** One entry per route (the first source found wins), sorted by route. */
function uniqueRoutes(entries: DiscoveredRoute[]): DiscoveredRoute[] {
  const found = new Map<string, DiscoveredRoute>();
  for (const entry of entries)
    if (!found.has(entry.route)) found.set(entry.route, entry);
  return [...found.values()].sort((left, right) =>
    left.route.localeCompare(right.route),
  );
}

export async function discoverRoutes(
  projectDirectory: string,
): Promise<DiscoveredRoute[]> {
  return uniqueRoutes(await discoverRouteEntries(projectDirectory));
}

/**
 * A coverage.exclude glob: `**` crosses segments, `*` and `?` stay within
 * one, everything else (brackets included, so `/p/[id]` names that dynamic
 * route) is literal. A trailing `/**` also matches its base.
 */
export function coverageGlob(pattern: string): RegExp {
  let body = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (pattern.startsWith("/**", index) && index + 3 === pattern.length) {
      body += "(?:/.*)?";
      break;
    }
    if (pattern.startsWith("**", index)) {
      body += ".*";
      index += 1;
    } else if (char === "*") body += "[^/]*";
    else if (char === "?") body += "[^/]";
    else body += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${body}$`);
}

/**
 * Apply coverage.exclude before routes are de-duplicated, so excluding one
 * app's sources keeps a route another app also serves. Patterns starting
 * with `/` match the route; others match the project-relative source path
 * (crawled sources are URLs, so only route patterns apply to them).
 */
export function excludeRoutes(
  entries: DiscoveredRoute[],
  patterns: string[],
): { kept: DiscoveredRoute[]; excluded: ExcludedRoute[] } {
  const globs = patterns.map((pattern) => ({
    pattern,
    glob: coverageGlob(pattern),
  }));
  const matched = (entry: DiscoveredRoute) =>
    globs.find(({ pattern, glob }) =>
      glob.test(
        pattern.startsWith("/")
          ? entry.route
          : entry.source.replaceAll(sep, "/"),
      ),
    )?.pattern;
  const kept: DiscoveredRoute[] = [];
  const excluded = new Map<string, ExcludedRoute>();
  for (const entry of entries) {
    const pattern = matched(entry);
    if (pattern === undefined) kept.push(entry);
    else if (!excluded.has(entry.route))
      excluded.set(entry.route, { ...entry, pattern });
  }
  const unique = uniqueRoutes(kept);
  const served = new Set(unique.map(({ route }) => route));
  return {
    kept: unique,
    excluded: [...excluded.values()]
      .filter(({ route }) => !served.has(route))
      .sort((left, right) => left.route.localeCompare(right.route)),
  };
}

/** Same-origin links from one page, for apps without a filesystem router. */
export async function crawlRoutes(
  start: string,
  fetcher: (url: string) => Promise<string> = async (url) =>
    await (await fetch(url)).text(),
): Promise<DiscoveredRoute[]> {
  const origin = new URL(start).origin;
  const html = await fetcher(start);
  const routes = new Map<string, DiscoveredRoute>();
  routes.set(new URL(start).pathname, {
    route: new URL(start).pathname,
    source: start,
  });
  for (const match of html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi,
  )) {
    const href = match[1];
    if (href === undefined) continue;
    let url: URL;
    try {
      url = new URL(href, start);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const route = url.pathname.replace(/\/+$/, "") || "/";
    if (!routes.has(route)) routes.set(route, { route, source: start });
  }
  return [...routes.values()].sort((left, right) =>
    left.route.localeCompare(right.route),
  );
}

export function routePattern(route: string): RegExp {
  const body = route
    .split("/")
    .map((segment) => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return "(?:.*)";
      if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return ".+";
      if (/^\[[^\]]+\]$/.test(segment)) return "[^/]+";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/")
    .replace(/\/\(\?:\.\*\)$/, "(?:/.*)?");
  return new RegExp(`^${body === "" ? "/" : body}/?$`);
}

function statePath(url: string): string | undefined {
  try {
    const parsed = new URL(url, "http://idiom.invalid");
    return parsed.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return undefined;
  }
}

export function routeCoverage(
  routes: DiscoveredRoute[],
  flows: Flow[],
): {
  routes: RouteCoverage[];
  unresolvedStates: CoveredState[];
} {
  const unresolvedStates: CoveredState[] = [];
  const statePaths: Array<{ covered: CoveredState; path: string }> = [];
  for (const flow of flows) {
    if (flow.target.kind !== "web") continue;
    for (const state of flow.states) {
      const url = "url" in state ? state.url : undefined;
      const path = url === undefined ? undefined : statePath(url);
      const covered: CoveredState = {
        flow: flow.id,
        state: state.id,
        ...("reachedFrom" in state && state.reachedFrom !== undefined
          ? { label: stateChainLabel(state) }
          : {}),
      };
      if (path === undefined) unresolvedStates.push(covered);
      else statePaths.push({ covered, path });
    }
  }
  return {
    routes: routes.map((route) => {
      const pattern = routePattern(route.route);
      const matches = statePaths.filter(({ path }) => pattern.test(path));
      return {
        ...route,
        capturedBy: matches.map(({ covered }) => covered),
        examples: route.route.includes("[")
          ? [...new Set(matches.map(({ path }) => path))]
          : [],
      };
    }),
    unresolvedStates,
  };
}
