import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, request as playwrightRequest } from "playwright";
import { expect, test, vi } from "vitest";
import type { BrowserTuple } from "../src/capture/types.js";
import { resolveDesignSource } from "../src/design/source.js";
import {
  guardContext,
  guardedLinkRequester,
  NetworkBudget,
} from "../src/hosted/network.js";
import { startProxy } from "../src/hosted/proxy.js";
import { createQuickConfiguration } from "../src/quick/config.js";
import { png } from "./hosted-helpers.js";

const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];
async function fixture() {
  const hits: Array<{ path: string; method: string; host: string }> = [];
  const server = createServer((req, res) => {
    hits.push({
      path: req.url ?? "",
      method: req.method ?? "",
      host: req.headers.host ?? "",
    });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1/private" });
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html");
    if (req.url === "/worker.js") {
      res.setHeader("content-type", "text/javascript");
      res.end('fetch("http://10.0.0.1/private").catch(()=>{});');
      return;
    }
    res.end(`<!doctype html><html><body><h1>Fixture</h1><button id="open">Open</button><script>
      fetch('/unsafe',{method:'POST'}).catch(()=>{}); navigator.sendBeacon('/beacon','no');
      fetch('http://127.0.0.1/private').catch(()=>{});
      new Worker('/worker.js'); new WebSocket('ws://fixture.example.com/socket');
      navigator.serviceWorker?.register('/sw.js').catch(()=>{});
      document.querySelector('#open').onclick=()=>window.open('/popup');
    </script><iframe src="http://10.0.0.1/private"></iframe></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture failed");
  return {
    port: address.port,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function proxyGet(proxyUrl: string, target: string) {
  const proxy = new URL(proxyUrl);
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: proxy.hostname,
        port: proxy.port,
        path: target,
        method: "GET",
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test("proxy pins the checked numeric address; a rebound/private target never opens a socket", async () => {
  const local = await fixture();
  const budget = new NetworkBudget(new AbortController().signal);
  const resolver = vi
    .fn()
    .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
    .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
  const dial = vi.fn((_address: string, _port: number, _family: number) =>
    connect({ host: "127.0.0.1", port: local.port }),
  );
  const proxy = await startProxy(budget, { resolver, dial });
  try {
    expect(
      (await proxyGet(proxy.url, "http://fixture.example.com:8080/")).status,
    ).toBe(200);
    expect(dial).toHaveBeenCalledWith("8.8.8.8", 8080, 4);
    expect(local.hits[0]?.host).toBe("fixture.example.com:8080");
    expect(
      (await proxyGet(proxy.url, "http://fixture.example.com/private")).status,
    ).toBe(403);
    expect(dial).toHaveBeenCalledTimes(1);
    for (const url of ["http://169.254.169.254/", "http://[::1]/"])
      expect((await proxyGet(proxy.url, url)).status).toBe(403);
  } finally {
    await proxy.close();
    await local.close();
  }
});
test("initial scripts, workers, iframe, POST/beacon, service workers and WebSockets are guarded", async () => {
  const local = await fixture();
  const budget = new NetworkBudget(new AbortController().signal);
  const proxy = await startProxy(budget, {
    resolver: publicDns,
    dial: () => connect({ host: "127.0.0.1", port: local.port }),
  });
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: proxy.url, bypass: "<-loopback>" },
    args: ["--proxy-bypass-list=<-loopback>"],
  });
  try {
    const config = createQuickConfiguration(["http://fixture.example.com/"]);
    const tuple = {
      project: config.project,
      state: config.flow.states[0],
      viewport: config.project.viewports[0],
      navigationUrl: "http://fixture.example.com/",
    } as BrowserTuple;
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await guardContext(context, tuple, budget, publicDns);
    const page = await context.newPage();
    await page.goto(tuple.navigationUrl);
    await page.waitForTimeout(500);
    expect(await page.locator("h1").textContent()).toBe("Fixture");
    await page.locator("#open").click();
    await page.waitForTimeout(200);
    expect(
      local.hits.every((hit) =>
        ["GET", "HEAD", "OPTIONS"].includes(hit.method),
      ),
    ).toBe(true);
    expect(
      local.hits.some((hit) =>
        /private|unsafe|beacon|socket|sw\.js/.test(hit.path),
      ),
    ).toBe(false);
    expect(budget.blocked.size).toBeGreaterThan(0);
    const client = guardedLinkRequester(
      await playwrightRequest.newContext({ proxy: { server: proxy.url } }),
      budget,
      publicDns,
    );
    await expect(
      client.head("http://fixture.example.com/redirect"),
    ).rejects.toMatchObject({ code: "blocked-url" });
    expect(local.hits.some((hit) => hit.path === "/private")).toBe(false);
    await client.dispose?.();
    // Repeated captures share one three-document allowance.
    await page.goto("http://fixture.example.com/second");
    await page.goto("http://fixture.example.com/third").catch(() => undefined);
    await expect(
      page.goto("http://fixture.example.com/fourth"),
    ).rejects.toThrow();
    expect(budget.pages.size).toBe(3);
  } finally {
    await browser.close();
    await proxy.close();
    await local.close();
  }
});
test("uploaded design wrapper and image are fulfilled offline only in their trusted context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosted-image-test-"));
  const path = join(directory, "upload.png");
  await writeFile(path, png);
  const source = await resolveDesignSource(path, directory);
  const browser = await chromium.launch({ headless: true });
  const budget = new NetworkBudget(new AbortController().signal);
  try {
    const config = createQuickConfiguration(["https://example.com/"]);
    const tuple = {
      project: config.project,
      state: config.flow.states[0],
      viewport: config.project.viewports[0],
      navigationUrl: source.url,
      designReference: source,
    } as BrowserTuple;
    const context = await browser.newContext();
    await guardContext(context, tuple, budget, publicDns);
    const page = await context.newPage();
    await page.goto(source.url);
    expect(
      await page
        .locator("img")
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    ).toBe(8);
    await expect(
      page.goto(new URL("/other", source.url).href),
    ).rejects.toThrow();
    expect(budget.pages.size).toBe(0);
  } finally {
    await browser.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
