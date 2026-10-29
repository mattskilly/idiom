import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { renderHostedReport } from "../src/hosted/render.js";
import { HASH, ID, report } from "./hosted-helpers.js";

let browser: Browser;
let output: string;
let html: string;
let client: string;
let controls: string;
let css: string;
const root = join(import.meta.dirname, "..");
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "hosted-site-"));
  await promisify(execFile)(
    process.execPath,
    [join(root, "scripts/build-site.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        IDIOM_HOSTED_REVIEW: "on",
        IDIOM_SITE_OUTPUT: output,
      },
    },
  );
  [html, client, controls, css] = (await Promise.all(
    [
      "index.html",
      "hosted/client.js",
      "hosted/report.js",
      "hosted/form.css",
    ].map((path) => readFile(join(output, path), "utf8")),
  )) as [string, string, string, string];
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  if (output) await rm(output, { recursive: true, force: true });
});
async function routes(
  page: Page,
  options: {
    enabled?: boolean;
    config?: Record<string, unknown>;
    body?: string;
    status?: number;
  } = {},
) {
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: html });
    if (path === "/hosted/client.js")
      return route.fulfill({ contentType: "text/javascript", body: client });
    if (path === "/hosted/report.js")
      return route.fulfill({ contentType: "text/javascript", body: controls });
    if (path === "/hosted/form.css")
      return route.fulfill({ contentType: "text/css", body: css });
    if (path === "/api/hosted-config")
      return route.fulfill({
        json: options.config ?? {
          enabled: options.enabled ?? true,
          available: true,
        },
      });
    if (path === "/api/hosted-review")
      return route.fulfill({
        status: options.status ?? 200,
        contentType: "application/x-ndjson",
        body:
          options.body ??
          `${JSON.stringify({ type: "progress", stage: "reviewing", message: "Running measured checks." })}\n${JSON.stringify({ type: "result", id: ID, url: `/r/${ID}`, deleteToken: HASH })}\n`,
      });
    if (path.endsWith("/c.js"))
      return route.fulfill({
        contentType: "text/javascript",
        body: 'window.V_C.push({b:1,v:"offline-test",e:"",d:0});',
      });
    return route.fulfill({ contentType: "text/javascript", body: "" }); // BotID external bootstrap is offline here.
  });
}
test.each([
  { width: 1440, colorScheme: "light" as const },
  { width: 390, colorScheme: "dark" as const },
])(
  "enabled form inherits theme, wraps at $width and is accessible",
  async ({ width, colorScheme }) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme,
    });
    const page = await context.newPage();
    try {
      await routes(page);
      await page.goto("https://idiom.build/");
      await page.locator("#hosted-review").waitFor({ state: "visible" });
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      const findings = await new AxeBuilder({ page })
        .include("#hosted-review")
        .analyze();
      expect(findings.violations).toEqual([]);
      await page.locator("#hosted-design-kind").selectOption("reference");
      expect(await page.locator("#hosted-image").isDisabled()).toBe(true);
      expect(await page.locator("#hosted-reference").isEnabled()).toBe(true);
      await page.locator("#hosted-design-kind").selectOption("none");
      await page.getByLabel("Public page URL").fill("https://example.com/");
      await page.locator("#hosted-submit").focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.locator("#hosted-progress").textContent())
        .toContain("Report ready");
      expect(
        await page.locator("#hosted-report-link").getAttribute("href"),
      ).toBe(`/r/${ID}#delete=${HASH}`);
      expect(
        await page
          .locator("#hosted-report-link")
          .getAttribute("data-share-url"),
      ).toBe(`https://idiom.build/r/${ID}`);
      expect(
        await page.evaluate(
          (id) => localStorage.getItem(`idiom-delete:${id}`),
          ID,
        ),
      ).toBe(HASH);
      expect(await page.locator("#hosted-submit").isEnabled()).toBe(true);
    } finally {
      await context.close();
    }
  },
);
test("server-off config keeps stale enabled markup hidden", async () => {
  const page = await browser.newPage();
  try {
    await routes(page, { enabled: false });
    await page.goto("https://idiom.build/");
    await page.waitForTimeout(100);
    expect(await page.locator("#hosted-review").isVisible()).toBe(false);
  } finally {
    await page.close();
  }
});
test("an exhausted monthly cap says so before submission and points to the CLI", async () => {
  const page = await browser.newPage();
  try {
    await routes(page, {
      config: { enabled: true, available: false, reason: "cap-reached" },
    });
    await page.goto("https://idiom.build/");
    await expect
      .poll(() => page.locator("#hosted-progress").textContent())
      .toContain("budget has been reached");
    expect(await page.locator("#hosted-progress").textContent()).toContain(
      "npm install -g @mattskilly/idiom",
    );
    expect(await page.locator("#hosted-submit").isDisabled()).toBe(true);
  } finally {
    await page.close();
  }
});
test.each([
  {
    code: "blocked-url",
    message: "This URL is blocked.",
    field: "target",
    status: 400,
  },
  {
    code: "cap-reached",
    message: "The budget has been reached. npm install -g @mattskilly/idiom",
    status: 503,
  },
  {
    code: "timeout",
    message: "The review exceeded its 90-second limit.",
    status: 504,
  },
])(
  "shows honest $code failure and allows retry",
  async ({ message, field, status }) => {
    const page = await browser.newPage();
    try {
      await routes(page, {
        body: JSON.stringify({ type: "error", message, field }),
        status,
      });
      await page.goto("https://idiom.build/");
      await page.getByLabel("Public page URL").fill("https://example.com/");
      await page.locator("#hosted-submit").click();
      await expect
        .poll(() => page.locator("#hosted-progress").textContent())
        .toBe(message);
      expect(await page.locator("#hosted-result").isVisible()).toBe(false);
      expect(await page.locator("#hosted-submit").isEnabled()).toBe(true);
      if (field)
        expect(
          await page.locator("#hosted-target").getAttribute("aria-invalid"),
        ).toBe("true");
    } finally {
      await page.close();
    }
  },
);
test("report controls separate shared and creator views and delete with the capability", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let deletion = "";
  try {
    await page.route("**/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/r/${ID}`)
        return route.fulfill({
          contentType: "text/html",
          body: renderHostedReport(ID, report(), Date.now() + 1000),
        });
      if (path === "/hosted/report.js")
        return route.fulfill({
          contentType: "text/javascript",
          body: controls,
        });
      if (path === "/api/hosted-delete") {
        deletion = route.request().postData() ?? "";
        return route.fulfill({ json: { deleted: true } });
      }
      return route.fulfill({ status: 404 });
    });
    await page.goto(`https://idiom.build/r/${ID}`);
    expect(await page.locator("#delete-report").isVisible()).toBe(false);
    await page.goto(`https://idiom.build/r/${ID}#delete=${HASH}`);
    await page.reload();
    await page.locator("#delete-report").waitFor({ state: "visible" });
    expect(page.url()).not.toContain("#");
    await page.locator("#delete-report").click();
    await expect
      .poll(() => page.locator("main").textContent())
      .toContain("Report deleted");
    expect(JSON.parse(deletion)).toEqual({ token: HASH });
  } finally {
    await context.close();
  }
});
