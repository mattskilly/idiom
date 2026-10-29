import type { APIRequestContext, BrowserContext } from "playwright";
import type { LinkRequester } from "../capture/links.js";
import { safeRequestMethod } from "../capture/request-policy.js";
import type { BrowserTuple } from "../capture/types.js";
import { designImageWrapper } from "../design/source.js";
import { LIMITS } from "./config.js";
import { HostedError } from "./errors.js";
import { type Resolver, resolvePublic } from "./ssrf.js";

export class NetworkBudget {
  bytes = 0;
  requests = 0;
  active = 0;
  readonly pages = new Set<string>();
  readonly blocked = new Map<string, number>();
  constructor(readonly signal: AbortSignal) {}
  check() {
    if (this.signal.aborted) throw new HostedError("timeout");
  }
  note(reason: string) {
    this.blocked.set(reason, (this.blocked.get(reason) ?? 0) + 1);
  }
  transfer(bytes: number) {
    this.check();
    this.bytes += bytes;
    if (this.bytes > LIMITS.networkBytes) {
      this.note("network byte budget exhausted");
      throw new HostedError("failed");
    }
  }
  request() {
    this.check();
    if (++this.requests > LIMITS.requests) {
      this.note("request budget exhausted");
      throw new HostedError("failed");
    }
  }
  page(url: URL) {
    const key = `${url.origin}${url.pathname}${url.search}`;
    if (!this.pages.has(key) && this.pages.size >= LIMITS.pages) {
      this.note("three-page budget exhausted");
      throw new HostedError("blocked-url");
    }
    this.pages.add(key);
  }
  coverage(): string[] {
    return [...this.blocked].map(
      ([reason, count]) =>
        `Not checked: ${reason} (${count} blocked requests).`,
    );
  }
}

export async function guardContext(
  context: BrowserContext,
  tuple: BrowserTuple,
  budget: NetworkBudget,
  resolver?: Resolver,
) {
  context.setDefaultNavigationTimeout(10_000);
  context.setDefaultTimeout(5000);
  context.on("page", (page) => {
    page.on("download", (download) => {
      budget.note("downloads disabled");
      void download.cancel();
    });
    page.on("popup", (popup) => {
      budget.note("popups disabled");
      void popup.close().catch(() => undefined);
    });
  });
  await context.routeWebSocket("**/*", (socket) => {
    budget.note("WebSockets disabled");
    socket.close();
  });
  // Registered first; later probe/replay routes must fallback to this guard.
  await context.route("**/*", async (route) => {
    const request = route.request();
    try {
      budget.request();
      if (!safeRequestMethod(request.method()))
        throw new HostedError("blocked-url");
      const image = tuple.designReference?.image;
      if (image && request.method() === "GET") {
        if (request.url() === tuple.navigationUrl)
          return await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: designImageWrapper,
          });
        if (request.url() === new URL("/image", tuple.navigationUrl).href)
          return await route.fulfill({
            status: 200,
            contentType: image.mediaType,
            body: image.bytes,
          });
      }
      const checked = await resolvePublic(
        request.url(),
        resolver,
        budget.signal,
      );
      if (request.isNavigationRequest()) budget.page(checked.url);
      await route.fallback();
    } catch {
      budget.note("unsafe method, non-public destination, or hosted budget");
      await route.abort("blockedbyclient").catch(() => undefined);
    }
  });
}

export function guardedLinkRequester(
  client: APIRequestContext,
  budget: NetworkBudget,
  resolver?: Resolver,
): LinkRequester {
  const run = async (
    method: "head" | "get",
    input: string,
    settings: Parameters<APIRequestContext["get"]>[1],
  ) => {
    let url = input;
    for (let hop = 0; hop <= 5; hop++) {
      budget.request();
      await resolvePublic(url, resolver, budget.signal).catch(() => {
        budget.note("link destination blocked");
        throw new HostedError("blocked-url");
      });
      const response = await client[method](url, {
        ...settings,
        maxRedirects: 0,
        timeout: Math.min(settings?.timeout ?? 5000, 5000),
      });
      const location = response.headers().location;
      if (response.status() < 300 || response.status() >= 400 || !location)
        return response;
      url = new URL(location, url).href;
      await response.dispose();
    }
    budget.note("link redirect limit");
    throw new HostedError("blocked-url");
  };
  return {
    head: (url, settings) => run("head", url, settings),
    get: (url, settings) => run("get", url, settings),
    dispose: () => client.dispose(),
  };
}
