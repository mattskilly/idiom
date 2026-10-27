import { type Browser, chromium, type Response } from "playwright";
import { deterministicContextOptions } from "../capture/browser.js";
import { classifyDocument } from "../document.js";
import type { Project } from "../schemas/project.js";
import type { Inspection, LiveInspector } from "./discover.js";

export async function openFlowBrowser(
  project: Project,
  options: { launch?: () => Promise<Browser>; timeoutMs?: number } = {},
): Promise<LiveInspector> {
  const viewport = project.viewports[0];
  if (viewport === undefined)
    throw new Error("Flow discovery requires at least one project viewport");
  const browser = await (
    options.launch ?? (() => chromium.launch({ headless: true }))
  )();
  const timeout = options.timeoutMs ?? 5_000;
  const origin = new URL(project.server.readyUrl).origin;
  const controllers = new Set<AbortController>();
  let closed = false;
  return {
    async inspect(url): Promise<Inspection> {
      const context = await browser.newContext(
        deterministicContextOptions(project, viewport),
      );
      let response: Response | undefined;
      try {
        const page = await context.newPage();
        page.on("response", (candidate) => {
          try {
            const request = candidate.request();
            if (
              request.isNavigationRequest() &&
              request.frame() === page.mainFrame() &&
              !(candidate.status() >= 300 && candidate.status() < 400)
            )
              response = candidate;
          } catch {
            // Some navigation requests have no accessible frame.
          }
        });
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout,
        });
        await page.waitForTimeout(project.capture.settleMs);
        const finalUrl = page.url();
        const content = await page.evaluate(() => ({
          contentType: document.contentType,
          base: document.baseURI,
          links: Array.from(
            document.querySelectorAll("a[href]:not([download])"),
            (a) => a.getAttribute("href") ?? "",
          ),
          password: document.querySelector('input[type="password"]') !== null,
        }));
        const html =
          classifyDocument(response?.headers()["content-type"]) === "html" &&
          classifyDocument(content.contentType) === "html";
        return { finalUrl, status: response?.status(), html, ...content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          finalUrl: response?.url() ?? url,
          status: response?.status(),
          html: false,
          password: false,
          links: [],
          base: url,
          error: message.split("\n")[0],
          unavailable:
            /ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ECONNREFUSED/.test(
              message,
            ),
        };
      } finally {
        await context.close().catch(() => undefined);
      }
    },
    async sitemap(url) {
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeout);
      let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
      try {
        let target = new URL(url);
        let xml: string | undefined;
        for (let redirects = 0; redirects <= 5; redirects++) {
          if (closed) throw new Error("discovery closed");
          if (target.origin !== origin || target.username || target.password)
            throw new Error("off-origin sitemap redirect rejected");
          const response = await fetch(target, {
            redirect: "manual",
            signal: controller.signal,
          });
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            const location = response.headers.get("location");
            if (!location) throw new Error("sitemap redirect has no location");
            target = new URL(location, target);
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`HTTP ${response.status}`);
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Error("empty sitemap");
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 1024 * 1024)
                throw new Error("sitemap exceeds 1 MiB limit");
              chunks.push(part.value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          xml = Buffer.concat(chunks).toString("utf8");
          break;
        }
        if (xml === undefined) throw new Error("too many sitemap redirects");
        context = await browser.newContext();
        const page = await context.newPage();
        return await page.evaluate((text) => {
          const document = new DOMParser().parseFromString(
            text,
            "application/xml",
          );
          if (document.querySelector("parsererror"))
            throw new Error("malformed sitemap XML");
          const root = document.documentElement;
          const namespace = root.namespaceURI;
          if (
            namespace !== null &&
            namespace !== "http://www.sitemaps.org/schemas/sitemap/0.9"
          )
            throw new Error("unsupported sitemap namespace");
          const kind = root.localName;
          if (kind !== "urlset" && kind !== "sitemapindex")
            throw new Error("expected urlset or sitemapindex");
          const urls = Array.from(root.children)
            .filter(
              (child) =>
                child.namespaceURI === namespace &&
                child.localName === (kind === "urlset" ? "url" : "sitemap"),
            )
            .flatMap((child) =>
              Array.from(child.children)
                .filter(
                  (loc) =>
                    loc.localName === "loc" && loc.namespaceURI === namespace,
                )
                .map((loc) => loc.textContent?.trim() ?? "")
                .filter(Boolean),
            );
          return { kind, urls };
        }, xml);
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
        controller.abort();
        await context?.close().catch(() => undefined);
      }
    },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await browser.close();
    },
  };
}
