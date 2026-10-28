import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import pixelmatch from "pixelmatch";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createProgram } from "../src/cli.js";

const root = join(import.meta.dirname, "..");
const sitePath = join(root, "site", "index.html");
const siteBuildPath = join(root, "scripts", "build-site.mjs");
const siteOutputPath = join(root, "site", "dist", "index.html");
const socialImagePath = join(root, "site", "social-preview.png");
const socialImageOutputPath = join(root, "site", "dist", "social-preview.png");
const packagePath = join(root, "package.json");
const execFileAsync = promisify(execFile);

let source = "";
let standalone = "";
let socialImage = Buffer.alloc(0);
let outputSocialImage = Buffer.alloc(0);
let packageJson: {
  version: string;
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
};
let browser: Browser;

beforeAll(async () => {
  [source, packageJson] = await Promise.all([
    readFile(sitePath, "utf8"),
    readFile(packagePath, "utf8").then((value) => JSON.parse(value)),
  ]);
  await execFileAsync(process.execPath, [siteBuildPath], { cwd: root });
  [standalone, socialImage, outputSocialImage] = await Promise.all([
    readFile(siteOutputPath, "utf8"),
    readFile(socialImagePath),
    readFile(socialImageOutputPath),
  ]);
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

function command(name: string) {
  const found = createProgram().commands.find(
    (candidate) => candidate.name() === name,
  );
  expect(found, `missing CLI command ${name}`).toBeDefined();
  if (found === undefined) throw new Error(`missing CLI command ${name}`);
  return found;
}

function option(commandName: string, flag: string) {
  const found = command(commandName).options.find(
    (candidate) => candidate.long === flag,
  );
  expect(found, `missing ${commandName} option ${flag}`).toBeDefined();
  if (found === undefined)
    throw new Error(`missing ${commandName} option ${flag}`);
  return found;
}

async function loadPage(options: {
  width: number;
  colorScheme: "light" | "dark";
  html?: string;
}): Promise<{
  context: BrowserContext;
  page: Page;
  networkRequests: string[];
}> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: 900 },
    colorScheme: options.colorScheme,
  });
  const page = await context.newPage();
  const networkRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("data:") && !url.startsWith("about:"))
      networkRequests.push(url);
  });
  await page.setContent(options.html ?? source, { waitUntil: "load" });
  await page.locator("img").evaluateAll(async (images) => {
    await Promise.all(
      images.map(
        (image) =>
          new Promise<void>((resolve, reject) => {
            if (
              image instanceof HTMLImageElement &&
              image.complete &&
              image.naturalWidth > 0
            ) {
              resolve();
              return;
            }
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener(
              "error",
              () => reject(new Error("embedded image did not load")),
              { once: true },
            );
          }),
      ),
    );
  });
  return { context, page, networkRequests };
}

const artifactDocument = () =>
  `<!doctype html><html><head></head><body>${source}</body></html>`;

function sourceParts() {
  const match = source.match(
    /^(<title\b[^>]*>[\s\S]*?<\/title>\s*<style\b[^>]*>[\s\S]*?<\/style>)/i,
  );
  const head = match?.[1];
  if (head === undefined) throw new Error("source head payload is missing");
  return { head, body: source.slice(head.length) };
}

async function metadataCopy() {
  const { context, page } = await loadPage({
    width: 1440,
    colorScheme: "light",
    html: artifactDocument(),
  });
  try {
    const [wordmark, mastheadMeta, description, documentTitle] =
      await Promise.all([
        page.locator(".wordmark").innerText(),
        page.locator(".masthead .meta").innerText(),
        page.locator(".standfirst").innerText(),
        page.title(),
      ]);
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    return {
      title: `${normalize(wordmark)} · ${normalize(mastheadMeta)}`,
      description: normalize(description),
      documentTitle,
    };
  } finally {
    await context.close();
  }
}

describe("standalone site build", () => {
  test("is an explicit package target and leaves the Artifact source untouched", async () => {
    expect(packageJson.scripts["build:site"]).toBe(
      "node scripts/build-site.mjs",
    );
    await expect(readFile(sitePath, "utf8")).resolves.toBe(source);
    expect(source).not.toMatch(/<(?:!doctype|html|head|body)\b/i);

    const { stdout } = await execFileAsync(
      "git",
      ["check-ignore", "site/dist/index.html", "site/dist/social-preview.png"],
      { cwd: root },
    );
    expect(stdout.trim().split("\n").sort()).toEqual([
      "site/dist/index.html",
      "site/dist/social-preview.png",
    ]);
  });

  test("emits one complete HTML5 document without changing source payloads", async () => {
    const parts = sourceParts();
    expect(standalone.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(standalone).toContain(`${parts.head}\n</head>`);
    expect(standalone).toContain(`<body>${parts.body}</body>`);
    expect(standalone.match(/<title\b/gi)).toHaveLength(1);
    expect(standalone.match(/<style\b/gi)).toHaveLength(1);

    const { context, page, networkRequests } = await loadPage({
      width: 1440,
      colorScheme: "light",
      html: standalone,
    });
    try {
      expect(networkRequests).toEqual([]);
      await expect(page.locator("html").count()).resolves.toBe(1);
      await expect(page.locator("html").getAttribute("lang")).resolves.toBe(
        "en",
      );
      await expect(page.locator("head").count()).resolves.toBe(1);
      await expect(page.locator("body").count()).resolves.toBe(1);
      await expect(page.locator("meta[charset]").count()).resolves.toBe(1);
      await expect(
        page.locator("meta[charset]").getAttribute("charset"),
      ).resolves.toBe("utf-8");
      await expect(
        page.locator('meta[name="viewport"]').getAttribute("content"),
      ).resolves.toBe("width=device-width, initial-scale=1");
    } finally {
      await context.close();
    }
  });

  test("derives complete share metadata from the current page copy", async () => {
    const expected = await metadataCopy();
    const { context, page } = await loadPage({
      width: 1440,
      colorScheme: "light",
      html: standalone,
    });
    try {
      await expect(page.title()).resolves.toBe(expected.documentTitle);

      const expectedMetadata = new Map([
        ['meta[name="description"]', expected.description],
        ['meta[property="og:title"]', expected.title],
        ['meta[property="og:description"]', expected.description],
        ['meta[property="og:url"]', "https://idiom.build/"],
        ['meta[property="og:image"]', "https://idiom.build/social-preview.png"],
        ['meta[property="og:image:type"]', "image/png"],
        ['meta[property="og:image:width"]', "1200"],
        ['meta[property="og:image:height"]', "630"],
        ['meta[property="og:image:alt"]', expected.title],
        ['meta[property="og:type"]', "website"],
        ['meta[name="twitter:card"]', "summary_large_image"],
        ['meta[name="twitter:title"]', expected.title],
        ['meta[name="twitter:description"]', expected.description],
        [
          'meta[name="twitter:image"]',
          "https://idiom.build/social-preview.png",
        ],
        ['meta[name="twitter:image:alt"]', expected.title],
      ]);
      for (const [selector, value] of expectedMetadata) {
        const element = page.locator(selector);
        await expect(element.count(), selector).resolves.toBe(1);
        await expect(element.getAttribute("content"), selector).resolves.toBe(
          value,
        );
      }

      const canonical = page.locator('link[rel="canonical"]');
      await expect(canonical.count()).resolves.toBe(1);
      await expect(canonical.getAttribute("href")).resolves.toBe(
        "https://idiom.build/",
      );

      const absoluteUrls = await page
        .locator("[src], [srcset], [href], [action], [poster], meta[content]")
        .evaluateAll((elements) =>
          elements.flatMap((element) =>
            ["src", "srcset", "href", "action", "poster", "content"]
              .map((attribute) => element.getAttribute(attribute)?.trim())
              .filter(
                (value): value is string =>
                  value !== undefined && /^(?:https?:)?\/\//i.test(value),
              ),
          ),
        );
      expect(absoluteUrls.length).toBeGreaterThan(0);
      for (const value of absoluteUrls) {
        const url = new URL(value, "https://idiom.build/");
        if (
          url.href === "https://github.com/mattskilly/idiom" ||
          url.href === "https://www.npmjs.com/package/@mattskilly/idiom"
        )
          continue;
        expect(url.origin).toBe("https://idiom.build");
      }
    } finally {
      await context.close();
    }
  });

  test("ships and copies the declared opaque social card", () => {
    expect(outputSocialImage.equals(socialImage)).toBe(true);
    const png = PNG.sync.read(socialImage);
    expect({ width: png.width, height: png.height }).toEqual({
      width: 1200,
      height: 630,
    });

    // Redline brand: sheet --bg, ink --fg and --redline (the wordmark dot, tag and frame).
    const requiredColors = new Set(["250,250,248", "17,17,19", "224,53,43"]);
    const seenColors = new Set<string>();
    let opaque = true;
    for (let offset = 0; offset < png.data.length; offset += 4) {
      if (png.data[offset + 3] !== 255) opaque = false;
      seenColors.add(
        `${png.data[offset]},${png.data[offset + 1]},${png.data[offset + 2]}`,
      );
    }
    expect(opaque).toBe(true);
    for (const color of requiredColors)
      expect(seenColors.has(color)).toBe(true);
    expect(seenColors.size).toBeGreaterThan(3);
  });

  test("makes the raw and deployable document-mode boundary explicit", async () => {
    const documents = [source, artifactDocument(), standalone];
    const modes: string[] = [];
    for (const html of documents) {
      const { context, page } = await loadPage({
        width: 1440,
        colorScheme: "light",
        html,
      });
      try {
        modes.push(await page.evaluate(() => document.compatMode));
      } finally {
        await context.close();
      }
    }
    expect(modes).toEqual(["BackCompat", "CSS1Compat", "CSS1Compat"]);
  });

  test.each([
    { width: 1440, colorScheme: "light" as const },
    { width: 1440, colorScheme: "dark" as const },
    { width: 390, colorScheme: "light" as const },
    { width: 390, colorScheme: "dark" as const },
  ])(
    "matches the Artifact render at $width px in $colorScheme",
    async ({ width, colorScheme }) => {
      const artifact = await loadPage({
        width,
        colorScheme,
        html: artifactDocument(),
      });
      const emitted = await loadPage({ width, colorScheme, html: standalone });
      try {
        const [artifactBuffer, emittedBuffer] = await Promise.all([
          artifact.page.screenshot({ fullPage: true }),
          emitted.page.screenshot({ fullPage: true }),
        ]);
        const artifactPng = PNG.sync.read(artifactBuffer);
        const emittedPng = PNG.sync.read(emittedBuffer);
        expect({ width: emittedPng.width, height: emittedPng.height }).toEqual({
          width: artifactPng.width,
          height: artifactPng.height,
        });
        expect(
          pixelmatch(
            artifactPng.data,
            emittedPng.data,
            undefined,
            artifactPng.width,
            artifactPng.height,
            { includeAA: true, threshold: 0 },
          ),
        ).toBe(0);
      } finally {
        await Promise.all([artifact.context.close(), emitted.context.close()]);
      }
    },
    30_000,
  );
});

describe("landing-page copy follows the shipped command surface", () => {
  test("the version pin forces a re-audit, and the only install is the published package", () => {
    // Bump this literal deliberately at every release; the page must be
    // re-read against the shipped CLI each time.
    expect(packageJson.version).toBe("0.14.0");
    expect(source).toContain("npm install -g @mattskilly/idiom");
    expect(source).not.toMatch(/git\+ssh|\bbun add\b/);
    expect([...source.matchAll(/\bv\d+\.\d+\.\d+\b/g)]).toEqual([]);
  });

  test("every showcased command and option exists", () => {
    for (const name of ["check", "quick"]) command(name);
    expect(source).toContain("idiom check");
    expect(option("check", "--baseline")).toBeDefined();
    expect(option("check", "--fail-on")).toBeDefined();
  });

  test("the page stays product-neutral and makes no score claims", () => {
    expect(source).not.toMatch(/say ?when/i);
    expect(source).not.toMatch(/\b(?:score|grade|rating)s?\b/i);
    expect(source).not.toMatch(
      /\b(?:invitation|invited|private repository|authorized GitHub access)\b/i,
    );
  });
});

describe("theme toggle", () => {
  test.each(["light", "dark"] as const)(
    "starts from the %s system scheme and switches to the other",
    async (colorScheme) => {
      const { context, page } = await loadPage({
        width: 390,
        colorScheme,
        html: standalone,
      });
      try {
        const background = () =>
          page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const toggle = page.locator(".theme-toggle");
        const other = colorScheme === "light" ? "dark" : "light";
        const before = await background();
        await expect
          .poll(() => toggle.getAttribute("aria-label"))
          .toBe(`Switch to ${other} theme`);
        await toggle.click();
        expect(
          await page.evaluate(() => document.documentElement.dataset.theme),
        ).toBe(other);
        expect(await background()).not.toBe(before);
        expect(await toggle.getAttribute("aria-label")).toBe(
          `Switch to ${colorScheme} theme`,
        );
      } finally {
        await context.close();
      }
    },
  );
});

describe("landing-page presentation contract", () => {
  test("the source stays wrapper-free and renders offline", async () => {
    expect(source).not.toMatch(/<(?:!doctype|html|head|body)\b/i);
    expect(source).toMatch(/:focus-visible\s*\{[^}]*outline:/s);

    const { context, page, networkRequests } = await loadPage({
      width: 1440,
      colorScheme: "light",
    });
    try {
      expect(networkRequests).toEqual([]);
      // Navigation anchors to the site's own canonical domain are permitted;
      // they load no resource, and networkRequests above proves offline render.
      const externalAttributes = await page
        .locator("[src], [srcset], [href], [action], [poster]")
        .evaluateAll((elements) =>
          elements.flatMap((element) =>
            ["src", "srcset", "href", "action", "poster"]
              .map((name) => ({
                name,
                value: element.getAttribute(name),
              }))
              .filter(
                (attribute): attribute is { name: string; value: string } =>
                  attribute.value !== null &&
                  /^(?:https?:)?\/\//i.test(attribute.value.trim()) &&
                  !(
                    attribute.name === "href" &&
                    /^https:\/\/(?:idiom\.build(?:\/|$)|github\.com\/mattskilly\/idiom$|www\.npmjs\.com\/package\/@mattskilly\/idiom$)/i.test(
                      attribute.value.trim(),
                    )
                  ),
              )
              .map((attribute) => attribute.value),
          ),
        );
      expect(externalAttributes).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("every example crop decodes as a real image", async () => {
    const { context, page } = await loadPage({
      width: 1440,
      colorScheme: "light",
    });
    try {
      const sizes = await page.locator(".case img").evaluateAll((images) =>
        images.map((image) => ({
          src: (image as HTMLImageElement).src.slice(0, 22),
          width: (image as HTMLImageElement).naturalWidth,
        })),
      );
      expect(sizes).toHaveLength(6);
      for (const size of sizes) {
        expect(size.src).toBe("data:image/png;base64,");
        expect(size.width).toBeGreaterThan(0);
      }
    } finally {
      await context.close();
    }
  });

  test.each([
    { width: 1440, colorScheme: "light" as const },
    { width: 1440, colorScheme: "dark" as const },
    { width: 390, colorScheme: "light" as const },
    { width: 390, colorScheme: "dark" as const },
  ])(
    "renders at $width px in $colorScheme without page overflow",
    async ({ width, colorScheme }) => {
      const { context, page, networkRequests } = await loadPage({
        width,
        colorScheme,
      });
      try {
        expect(networkRequests).toEqual([]);
        const layout = await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);

        for (const name of ["What it catches", "With your agent", "Install"])
          await expect(
            page.getByText(name, { exact: true }).first().isVisible(),
          ).resolves.toBe(true);

        const typography = await page.evaluate(() => ({
          machine: getComputedStyle(
            document.querySelector(".wordmark") as Element,
          ).fontFamily,
          human: getComputedStyle(
            document.querySelector(".standfirst") as Element,
          ).fontFamily,
        }));
        expect(typography.machine).toMatch(/Archivo/);
        expect(typography.human).toMatch(/Instrument Sans/);
      } finally {
        await context.close();
      }
    },
    30_000,
  );
});
