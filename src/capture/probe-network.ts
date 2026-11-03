import {
  analyticsRequest,
  ignoredRequest,
  safeRequestMethod,
} from "./request-policy.js";

/** A request the page started inside the click's task, as seen in-page. */
export type InitiatedRequest = {
  method: string;
  url: string;
  via: "fetch" | "xhr" | "beacon";
};

/** A request as `METHOD` + absolute URL, independent of Playwright. */
export type RequestRecord = { method: string; url: string };

const MAX_BACKGROUND_LABELS = 5;

const withoutFragment = (url: string): string => {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
};

const key = (request: RequestRecord): string =>
  `${request.method.toUpperCase()} ${withoutFragment(request.url)}`;

/**
 * Whether the click's own requests are an effect of the click. A request
 * counts only when the click started it, and either something visible
 * follows or it would change data. Beacons and analytics never count: a
 * dead button that only tracks its click is still dead.
 */
export function clickNetworkEffect({
  initiated,
  navigations,
  visible,
}: {
  initiated: readonly InitiatedRequest[];
  /** Non-safe navigation requests (a POST form submission). */
  navigations: readonly RequestRecord[];
  /** Some effect other than network was observed. */
  visible: boolean;
}): boolean {
  const own: RequestRecord[] = [
    ...initiated.filter(
      (request) =>
        request.via !== "beacon" &&
        !ignoredRequest({ url: () => request.url }) &&
        !analyticsRequest({
          url: () => request.url,
          resourceType: () => "fetch",
        }),
    ),
    ...navigations,
  ];
  if (own.length === 0) return false;
  return (
    visible ||
    own.some((request) => !safeRequestMethod(request.method.toUpperCase()))
  );
}

/**
 * Requests seen during the click that the click did not start, as unique
 * redacted labels: `METHOD /path` on the page's origin, `METHOD host/path`
 * elsewhere. Query strings and fragments are dropped.
 */
export function backgroundRequestLabels(
  requests: readonly RequestRecord[],
  started: readonly RequestRecord[],
  pageUrl: string,
): string[] {
  const unmatched = new Map<string, number>();
  for (const request of started) {
    const id = key(request);
    unmatched.set(id, (unmatched.get(id) ?? 0) + 1);
  }
  let origin: string | undefined;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    origin = undefined;
  }
  const labels: string[] = [];
  for (const request of requests) {
    const id = key(request);
    const remaining = unmatched.get(id) ?? 0;
    if (remaining > 0) {
      unmatched.set(id, remaining - 1);
      continue;
    }
    let label: string;
    try {
      const url = new URL(request.url);
      label = `${request.method.toUpperCase()} ${
        url.origin === origin ? "" : url.host
      }${url.pathname}`;
    } catch {
      continue;
    }
    if (!labels.includes(label)) labels.push(label);
    if (labels.length >= MAX_BACKGROUND_LABELS) break;
  }
  return labels;
}
