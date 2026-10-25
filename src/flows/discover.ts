import {
  type DiscoveredRoute,
  discoverRouteEntries,
  excludeRoutes,
  routePattern,
} from "../coverage/routes.js";

export type Inspection = {
  finalUrl: string;
  status?: number | undefined;
  html: boolean;
  password: boolean;
  links: string[];
  base: string;
  error?: string | undefined;
  unavailable?: boolean;
};
export type LiveInspector = {
  inspect(url: string): Promise<Inspection>;
  sitemap(
    url: string,
  ): Promise<{ kind: "urlset" | "sitemapindex"; urls: string[] }>;
  close(): Promise<void>;
};
export type RouteRecord = {
  route: string;
  sources: string[];
  path?: string;
  expectedPath?: string;
  setup?: string;
  reason?: string;
};
export type Discovery = { routes: RouteRecord[]; warnings: string[] };
export type DiscoveryLimits = {
  pages?: number;
  documents?: number;
  totalMs?: number;
};

export function normalizePage(
  href: string,
  base: string,
  origin: string,
): string | undefined {
  if (href.startsWith("#")) return undefined;
  try {
    const url = new URL(href, base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== origin ||
      url.username ||
      url.password
    )
      return undefined;
    if (
      /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|css|js|mjs|json|xml|pdf|csv|docx?|pptx?|xlsx?|zip|tar|gz|bz2|7z|mp[34]|wav|ogg|webm|woff2?|ttf|txt|map)$/i.test(
        url.pathname,
      )
    )
      return undefined;
    if (/[[\]\s]/.test(url.pathname) || /%5[bBdD]/i.test(url.pathname))
      return undefined;
    return url.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return undefined;
  }
}

function loginPath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => /^(?:login|log-in|signin|sign-in)$/i.test(segment));
}
function assessment(
  path: string,
  origin: string,
  result: Inspection,
): Pick<RouteRecord, "expectedPath" | "setup" | "reason"> {
  if (result.error) return { reason: result.error };
  const final = new URL(result.finalUrl);
  const changed =
    final.origin !== origin ||
    (final.pathname.replace(/\/+$/, "") || "/") !== path;
  if (changed && (loginPath(final.pathname) || result.password))
    return {
      expectedPath: path,
      setup: `${final.origin === origin ? "" : final.origin}${final.pathname}`,
    };
  if (final.origin !== origin)
    return { reason: `unexpected off-origin destination ${final.href}` };
  if (
    result.status === undefined ||
    result.status < 200 ||
    result.status >= 300 ||
    !result.html
  )
    return {
      reason: `not a successful HTML page (HTTP ${result.status ?? "unknown"})`,
    };
  return { expectedPath: final.pathname };
}

/** Filesystem sources survive unavailable live discovery and the independent link cap. */
export async function discoverFlowRoutes(options: {
  directory: string;
  readyUrl: string;
  exclude: string[];
  open: () => Promise<LiveInspector>;
  limits?: DiscoveryLimits;
  entries?: DiscoveredRoute[];
}): Promise<Discovery> {
  const origin = new URL(options.readyUrl).origin;
  const raw =
    options.entries ?? (await discoverRouteEntries(options.directory));
  // Exclude per source before merging, retaining all non-excluded references.
  const entries = raw.filter(
    (entry) => excludeRoutes([entry], options.exclude).kept.length > 0,
  );
  const records = new Map<string, RouteRecord>();
  for (const entry of entries) {
    const record = records.get(entry.route) ?? {
      route: entry.route,
      sources: [],
      ...(!entry.route.includes("[") ? { path: entry.route } : {}),
    };
    record.sources.push(entry.source);
    records.set(entry.route, record);
  }
  const warnings: string[] = [];
  const observed = new Map<string, Set<string>>();
  const inspected = new Map<string, Inspection>();
  const excludedTemplates = raw.filter(
    (entry) =>
      entry.route.includes("[") &&
      excludeRoutes(
        [entry],
        options.exclude.filter((pattern) => pattern.startsWith("/")),
      ).kept.length === 0,
  );
  const allowed = (path: string) =>
    (records.has(path) ||
      !excludedTemplates.some((entry) =>
        routePattern(entry.route).test(path),
      )) &&
    excludeRoutes([{ route: path, source: origin + path }], options.exclude)
      .kept.length > 0;
  let live: LiveInspector | undefined;
  let expired = false;
  let unavailable = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const inspector = await options.open();
    live = inspector;
    if (expired) {
      await live.close();
      return;
    }
    const inspect = async (path: string) => {
      if (expired || unavailable) return undefined;
      const cached = inspected.get(path);
      if (cached) return cached;
      const result = await inspector.inspect(origin + path);
      if (expired) return undefined;
      inspected.set(path, result);
      if (result.unavailable) {
        unavailable = true;
        warnings.push(
          `Local application unavailable: ${result.error}. Filesystem routes are unverified.`,
        );
      }
      return result;
    };
    const admit = (path: string, source: string) => {
      if (!allowed(path)) return;
      const sources = observed.get(path) ?? new Set<string>();
      sources.add(source);
      observed.set(path, sources);
    };
    const documents = [new URL("/sitemap.xml", origin).href];
    const seen = new Set<string>();
    const maxDocuments = options.limits?.documents ?? 10;
    while (documents.length && seen.size < maxDocuments && !expired) {
      const url = documents.shift();
      if (url === undefined) break;
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const sitemap = await live.sitemap(url);
        if (expired) break;
        for (const href of sitemap.urls.sort()) {
          let target: URL;
          try {
            target = new URL(href, url);
          } catch {
            warnings.push(`Sitemap ${url}: invalid location ${href}`);
            continue;
          }
          if (
            target.origin !== origin ||
            target.username ||
            target.password ||
            !["http:", "https:"].includes(target.protocol)
          )
            continue;
          if (sitemap.kind === "sitemapindex") {
            if (!seen.has(target.href) && !documents.includes(target.href))
              documents.push(target.href);
          } else {
            const path = normalizePage(target.href, url, origin);
            if (path) admit(path, url);
          }
        }
      } catch (error) {
        if (!expired) warnings.push(`Sitemap ${url}: ${String(error)}`);
      }
    }
    if (documents.length)
      warnings.push(`Sitemap discovery limited to ${maxDocuments} documents.`);
    const start = normalizePage(options.readyUrl, options.readyUrl, origin);
    const queue: string[] = start && allowed(start) ? [start] : [];
    const admitted = new Set(queue);
    const maxPages = options.limits?.pages ?? 30;
    let capped = false;
    for (
      let index = 0;
      index < queue.length && !expired && !unavailable;
      index++
    ) {
      const path = queue[index];
      if (path === undefined) break;
      const result = await inspect(path);
      if (!result) break;
      const assessed = assessment(path, origin, result);
      if (index === 0 && assessed.reason)
        warnings.push(
          `Ready page ${path} could not be verified: ${assessed.reason}`,
        );
      // The ready page is a route only when it really serves a page.
      if (assessed.expectedPath !== undefined)
        admit(path, index === 0 ? options.readyUrl : origin + path);
      if (assessed.reason || assessed.setup) continue;
      const paths = [
        ...new Set(
          result.links.flatMap((href) => {
            const found = normalizePage(href, result.base, origin);
            return found && allowed(found) ? [found] : [];
          }),
        ),
      ].sort();
      for (const next of paths) {
        if (admitted.has(next)) continue;
        if (admitted.size >= maxPages) {
          capped = true;
          continue;
        }
        admitted.add(next);
        queue.push(next);
        admit(next, result.finalUrl);
      }
    }
    if (capped)
      warnings.push(
        `Same-origin link crawl limited to ${maxPages} admitted page paths.`,
      );
    for (const path of [
      ...new Set([
        ...observed.keys(),
        ...[...records.values()].flatMap((r) => (r.path ? [r.path] : [])),
      ]),
    ].sort()) {
      if (expired || unavailable) break;
      await inspect(path);
    }
  };
  try {
    await Promise.race([
      work(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          warnings.push(
            "Live discovery reached its overall time limit; remaining routes are unverified.",
          );
          resolve();
        }, options.limits?.totalMs ?? 60_000);
      }),
    ]);
  } catch (error) {
    warnings.push(`Live discovery unavailable: ${String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
    expired = true;
    await live?.close().catch(() => undefined);
  }
  const templates = [...records.values()]
    .filter((r) => r.route.includes("["))
    .sort((a, b) => {
      const score = (route: string) =>
        route
          .split("/")
          .reduce(
            (n, segment) =>
              n +
              (segment.includes("[[")
                ? 0
                : segment.includes("[...")
                  ? 1
                  : segment.includes("[")
                    ? 2
                    : 10),
            0,
          );
      return score(b.route) - score(a.route) || a.route.localeCompare(b.route);
    });
  const fallbackExamples = new Map<RouteRecord, string[]>();
  for (const [path, sources] of [...observed].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const result = inspected.get(path);
    const assessed = result
      ? assessment(path, origin, result)
      : { reason: "live inspection unavailable or discovery limit reached" };
    const exact = records.get(path);
    const matching = exact
      ? []
      : templates.filter((r) => routePattern(r.route).test(path));
    const owners = exact ? [exact] : matching;
    if (owners.length > 0) {
      // A concrete path is not emitted again as a live-only state. Each distinct
      // template still keeps its own identity, including overlapping routers.
      for (const record of owners) {
        record.sources.push(...sources);
        if (assessed.expectedPath === undefined) continue;
        const candidates = fallbackExamples.get(record) ?? [];
        candidates.push(path);
        fallbackExamples.set(record, candidates);
        if (record === owners[0] && record.path === undefined)
          record.path = path;
      }
    } else records.set(path, { route: path, path, sources: [...sources] });
  }
  // Prefer examples owned by the most specific route. An overlapping template
  // without an exclusive example may still use a verified shared pathname.
  for (const template of templates) {
    const example = fallbackExamples.get(template)?.[0];
    if (template.path === undefined && example !== undefined)
      template.path = example;
  }
  for (const record of records.values()) {
    record.sources = [...new Set(record.sources)].sort();
    if (!record.path)
      record.reason =
        "no successfully inspected link or sitemap example matched this dynamic template; it may be unreachable or beyond a discovery limit";
    else {
      const result = inspected.get(record.path);
      Object.assign(
        record,
        result !== undefined
          ? assessment(record.path, origin, result)
          : {
              reason: "live inspection unavailable or discovery limit reached",
            },
      );
    }
  }
  return {
    routes: [...records.values()].sort((a, b) =>
      a.route.localeCompare(b.route),
    ),
    warnings,
  };
}
