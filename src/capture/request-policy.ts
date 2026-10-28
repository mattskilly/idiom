import type { Request } from "playwright";
import type { ProbeSafetyPolicy } from "../checks/types.js";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** Dev-server and asset chatter that is never an effect of an action. */
export const ignoredRequest = (request: Pick<Request, "url">) =>
  /(?:webpack-hmr|__nextjs|_next\/static|hot-update|favicon|\/__vite|sockjs)/.test(
    request.url(),
  );

/**
 * Well-known analytics and beacon endpoints: a request to one is never
 * content a user waits for. A well-known list, extended by evidence, never
 * per site.
 */
const ANALYTICS_HOSTS = [
  /(?:^|\.)google-analytics\.com$/,
  /(?:^|\.)analytics\.google\.com$/,
  /(?:^|\.)googletagmanager\.com$/,
  /(?:^|\.)doubleclick\.net$/,
  /^api\.segment\.io$/,
  /^cdn\.segment\.com$/,
  /^api[\w-]*\.mixpanel\.com$/,
  /^api[\w-]*\.amplitude\.com$/,
  /(?:^|\.)posthog\.com$/,
  /(?:^|\.)clarity\.ms$/,
  /^bat\.bing\.com$/,
  /\.ingest(?:\.[a-z]+)?\.sentry\.io$/,
  /^browser-intake-[\w.-]*datadoghq\.(?:com|eu)$/,
  /^rs\.fullstory\.com$/,
  /(?:^|\.)hotjar\.(?:com|io)$/,
  /(?:^|\.)heapanalytics\.com$/,
  /(?:^|\.)cloudflareinsights\.com$/,
];
const ANALYTICS_PATHS: Array<{ host?: RegExp; path: RegExp }> = [
  { host: /^plausible\.io$/, path: /^\/api\/event\b/ },
  { host: /(?:^|\.)facebook\.com$/, path: /^\/tr\/?$/ },
  { path: /^\/_vercel\/(?:speed-)?insights\// },
];

/** sendBeacon and `<a ping>` (resource type `ping`), or a known endpoint. */
export function analyticsRequest(
  request: Pick<Request, "url" | "resourceType">,
): boolean {
  if (request.resourceType() === "ping") return true;
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    ANALYTICS_HOSTS.some((pattern) => pattern.test(host)) ||
    ANALYTICS_PATHS.some(
      (entry) =>
        (entry.host === undefined || entry.host.test(host)) &&
        entry.path.test(url.pathname),
    )
  );
}

/**
 * The same request policy applies to focus sweeps and every probe context.
 * A third-party page gets no dev-server exemption.
 */
export function probeRequestAllowed(
  request: Pick<Request, "method" | "url">,
  policy: ProbeSafetyPolicy = "app",
): boolean {
  if (safeMethods.has(request.method())) return true;
  return policy === "app" && ignoredRequest(request);
}
