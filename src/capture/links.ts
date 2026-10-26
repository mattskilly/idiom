import type { APIRequestContext } from "playwright";
import type {
  GeometryScan,
  LinkCheckResult,
  LinkObservation,
  LinksConfig,
} from "../checks/types.js";

/** The slice of Playwright's APIRequestContext the checker uses. */
export type LinkRequester = Pick<APIRequestContext, "head" | "get"> & {
  dispose?: (() => Promise<void>) | undefined;
};

export type LinkChecker = {
  check(records: LinkObservation[]): Promise<GeometryScan<LinkObservation>>;
  dispose(): Promise<void>;
};

const dnsFailure = /ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|getaddrinfo/;
const unjudgeable = new Set([401, 403, 407, 429]);

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(
    "\n",
  )[0] as string;
}

/** A link is ignored when its absolute URL or its path starts with a prefix. */
export function linkIgnored(href: string, ignore: readonly string[]): boolean {
  let path = href;
  try {
    const url = new URL(href);
    path = `${url.pathname}${url.search}`;
  } catch {}
  return ignore.some(
    (prefix) => href.startsWith(prefix) || path.startsWith(prefix),
  );
}

/**
 * Checks visible links once per run. Every URL is requested at most once
 * (results are cached across tuples and viewports), with bounded concurrency
 * and a total time budget. The request context is cookie-less on purpose: a
 * GET of /logout must not end the capture session.
 */
export function createLinkChecker(
  options: Omit<LinksConfig, "enabled"> & {
    request: () => Promise<LinkRequester>;
    monotonicNow?: (() => number) | undefined;
  },
): LinkChecker {
  const now = options.monotonicNow ?? (() => performance.now());
  const cache = new Map<string, Promise<LinkCheckResult>>();
  let requester: Promise<LinkRequester> | undefined;
  let deadline: number | undefined;
  let active = 0;
  const waiting: Array<() => void> = [];
  const budgetReason = `link check time budget (${Math.round(options.budgetMs / 1000)}s) exhausted`;

  const acquire = async () => {
    if (active < options.concurrency) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  const request = async (url: string): Promise<LinkCheckResult> => {
    deadline ??= now() + options.budgetMs;
    await acquire();
    try {
      if (now() >= deadline)
        return { status: "unchecked", reason: budgetReason };
      requester ??= options.request();
      const client = await requester;
      const settings = {
        timeout: options.timeoutMs,
        maxRedirects: 5,
        failOnStatusCode: false,
      };
      let code: number | undefined;
      let failure: unknown;
      try {
        const response = await client.head(url, settings);
        code = response.status();
        await response.dispose();
      } catch (error) {
        failure = error;
      }
      // Some servers reject HEAD; only a GET answer is conclusive.
      if (
        (code !== undefined && code >= 400) ||
        (failure !== undefined && !dnsFailure.test(firstLine(failure)))
      ) {
        try {
          const response = await client.get(url, settings);
          code = response.status();
          failure = undefined;
          await response.dispose();
        } catch (error) {
          failure = error;
        }
      }
      if (failure !== undefined) {
        const message = firstLine(failure);
        return dnsFailure.test(message)
          ? { status: "broken", code: null, reason: "DNS lookup failed" }
          : { status: "unchecked", reason: message };
      }
      const status = code as number;
      if (status < 400) return { status: "ok", code: status };
      if (unjudgeable.has(status))
        return {
          status: "unchecked",
          reason: `HTTP ${status}: requires authentication or is rate limited`,
        };
      return { status: "broken", code: status, reason: `HTTP ${status}` };
    } finally {
      release();
    }
  };

  const resolve = (link: LinkObservation): Promise<LinkCheckResult> => {
    if (!link.sameOrigin && !options.external)
      return Promise.resolve({
        status: "unchecked",
        reason: "external links are not checked (checks.links.external)",
      });
    if (linkIgnored(link.href, options.ignore))
      return Promise.resolve({
        status: "unchecked",
        reason: "ignored by checks.links.ignore",
      });
    let pending = cache.get(link.href);
    if (pending === undefined) {
      pending = request(link.href);
      cache.set(link.href, pending);
    }
    return pending;
  };

  return {
    async check(records) {
      const checked = await Promise.all(
        records.map(async (link) => ({ ...link, result: await resolve(link) })),
      );
      return checked.some(
        (link) =>
          link.result.status === "unchecked" &&
          link.result.reason === budgetReason,
      )
        ? { status: "partial", reason: budgetReason, records: checked }
        : { status: "ran", records: checked };
    },
    async dispose() {
      const client = await requester?.catch(() => undefined);
      await client?.dispose?.().catch(() => undefined);
    },
  };
}
