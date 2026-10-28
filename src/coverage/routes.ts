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
  privateDirectories = false,
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
      if (
        ignoredDirectories.has(entry.name) ||
        (!privateDirectories && entry.name.startsWith("_"))
      )
        continue;
      await walk(path, visit, depth + 1, privateDirectories);
    } else visit(path, entry);
  }
}

export type RouteRoot = {
  kind: "app" | "pages" | "svelte" | "remix";
  path: string;
  astro?: boolean;
};
export type RouteEntry = DiscoveredRoute & {
  root: RouteRoot;
  directory: string;
};

async function framework(
  directory: string,
  boundary: string,
): Promise<string[]> {
  try {
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    return Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
  } catch {
    const parent = dirname(directory);
    return directory === boundary || relative(boundary, parent).startsWith("..")
      ? []
      : framework(parent, boundary);
  }
}

async function routeRoots(projectDirectory: string): Promise<RouteRoot[]> {
  const roots: RouteRoot[] = [];
  const boundary = resolve(projectDirectory);
  const visit = async (directory: string, depth: number): Promise<void> => {
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
        const packages = await framework(directory, boundary);
        if (
          entry.name === "app" &&
          packages.some((p) => p.startsWith("@remix-run/"))
        )
          roots.push({ kind: "remix", path: join(path, "routes") });
        else
          roots.push({
            kind: entry.name,
            path,
            astro: packages.includes("astro"),
          });
        continue;
      }
      if (entry.name === "routes" && dirname(path).endsWith(`${sep}src`)) {
        roots.push({ kind: "svelte", path });
        continue;
      }
      if (
        ["apps", "packages", "src", "web", "frontend", "site"].includes(
          entry.name,
        ) ||
        depth > 0
      )
        await visit(path, depth + 1);
    }
  };
  await visit(boundary, 0);
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

/** Path-derived ownership also works for a route module removed by the diff. */
export function routeForFile(
  root: RouteRoot,
  path: string,
): string | undefined {
  const local = relative(root.path, path);
  if (local.startsWith("..") || local === "") return undefined;
  const segments = local.split(sep);
  const file = segments.at(-1) ?? "";
  if (root.kind === "app")
    return pageFile.test(file)
      ? appRouteFromSegments(segments.slice(0, -1))
      : undefined;
  if (root.kind === "svelte") {
    if (!/^\+page(?:\.server)?\.(?:svelte|ts|js)$/.test(file)) return undefined;
    return appRouteFromSegments(segments.slice(0, -1))?.replace(
      /=\w+(?=\])/g,
      "",
    );
  }
  if (root.kind === "remix") {
    if (!/\.(?:tsx|ts|jsx|js)$/.test(file) || /\.d\.ts$/.test(file))
      return undefined;
    if (
      segments.length > 2 ||
      (segments.length === 2 && !/^route\./.test(file))
    )
      return undefined;
    const name =
      segments.length === 2 ? segments[0] : file.replace(/\.[^.]+$/, "");
    if (!name || /[()[\]]/.test(name)) return undefined;
    const parts = name.split(".").flatMap((part) => {
      if (part === "_index" || part.startsWith("_")) return [];
      if (part === "$") return ["[...rest]"];
      if (part.startsWith("$")) return [`[${part.slice(1)}]`];
      return [part.replace(/_$/, "")];
    });
    return `/${parts.join("/")}`;
  }
  const extension = root.astro ? astroPageFile : pagesRouterFile;
  if (
    !extension.test(file) ||
    segments[0] === "api" ||
    segments.some((part) => part.startsWith("_")) ||
    /\.d\.[cm]?ts$/.test(file)
  )
    return undefined;
  const name = file.replace(extension, "");
  return `/${[...segments.slice(0, -1), ...(name === "index" ? [] : [name])].join("/")}`;
}

export async function discoverRouteTopology(projectDirectory: string) {
  const roots = await routeRoots(projectDirectory);
  const entries: RouteEntry[] = [];
  const uncertainties: string[] = [];
  const globals: string[] = [];
  for (const root of roots) {
    if (root.kind === "remix") {
      for (const file of await readdir(dirname(root.path)).catch(
        () => [] as string[],
      ))
        if (/^root\.[jt]sx?$/.test(file))
          globals.push(join(dirname(root.path), file));
    }
    await walk(
      root.path,
      (path, entry) => {
        if (
          /^(?:layout|template|_app|_document|\+layout(?:\.server)?)\.[^.]+$/.test(
            entry.name,
          )
        )
          globals.push(path);
        const route = routeForFile(root, path);
        if (route !== undefined)
          entries.push({
            route,
            source: relative(projectDirectory, path),
            root,
            directory: dirname(path),
          });
        else if (root.kind === "remix" && /\.[jt]sx?$/.test(entry.name))
          uncertainties.push(path);
      },
      0,
      root.kind === "remix",
    );
  }
  // Remix parent modules render an Outlet for descendants; pathless layouts
  // can own unrelated URL prefixes. Filename nesting, unlike URL prefixes,
  // also respects trailing-underscore layout escapes.
  const remixName = (entry: RouteEntry) =>
    relative(entry.root.path, resolve(projectDirectory, entry.source))
      .replace(/[/\\]route\.[jt]sx?$/, "")
      .replace(/\.[jt]sx?$/, "");
  for (const entry of entries) {
    if (
      entry.root.kind !== "remix" ||
      /(?:^|[./])_index(?:\.|$)/.test(entry.source)
    )
      continue;
    if (
      entries.some(
        (child) =>
          child !== entry &&
          child.root.path === entry.root.path &&
          remixName(child).startsWith(`${remixName(entry)}.`),
      )
    )
      globals.push(resolve(projectDirectory, entry.source));
  }
  return { roots, entries, uncertainties, globals };
}

/** Every (route, source) pair, before URL deduplication. */
export async function discoverRouteEntries(
  projectDirectory: string,
): Promise<DiscoveredRoute[]> {
  return (await discoverRouteTopology(projectDirectory)).entries.map(
    ({ route, source }) => ({ route, source }),
  );
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
  let body = "";
  for (const segment of route.split("/").slice(1)) {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) body += "(?:/.*)?";
    else if (/^\[\[[^\]]+\]\]$/.test(segment)) body += "(?:/[^/]+)?";
    else if (/^\[\.\.\.[^\]]+\]$/.test(segment)) body += "/.+";
    else if (/^\[[^\]]+\]$/.test(segment)) body += "/[^/]+";
    else body += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
  }
  return new RegExp(`^${body || "/"}/?$`);
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
