import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
// @ts-expect-error The site build script runs directly in Node.
import { docsGroups as groups } from "../scripts/site-docs.mjs";

type DocsGroup = {
  label: string;
  pages: Array<{ slug?: string; source?: string; href?: string }>;
};
const docsGroups = groups as DocsGroup[];

const root = join(import.meta.dirname, "..");
const dist = join(root, "site/dist");
const docPages = docsGroups.flatMap((group) =>
  group.pages
    .filter((page) => page.source !== undefined)
    .map((page) => ({ slug: page.slug ?? "" })),
);
const htmlFile = (slug: string) =>
  join(dist, slug === "" ? "docs.html" : `docs/${slug}.html`);
const markdownFile = (slug: string) =>
  join(dist, slug === "" ? "docs.md" : `docs/${slug}.md`);

let browser: Browser;
let siteCss = "";

beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["scripts/build-site.mjs"], {
    cwd: root,
    env: { ...process.env, IDIOM_HOSTED_REVIEW: "off" },
  });
  siteCss = await readFile(join(dist, "docs/site.css"), "utf8");
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe("docs", () => {
  test.each(docPages)(
    "/docs/$slug is a complete page with a Markdown twin",
    async ({ slug }) => {
      const html = await readFile(htmlFile(slug), "utf8");
      const canonical = `https://idiom.build/docs${slug === "" ? "" : `/${slug}`}`;
      expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
      expect(html.match(/<h1>/g)).toHaveLength(1);
      expect(html).toContain(`<link rel="canonical" href="${canonical}">`);
      expect(html).toMatch(/<meta name="description" content="[^"]{40,}">/);
      expect(html).toContain('aria-current="page"');
      await expect(readFile(markdownFile(slug), "utf8")).resolves.toMatch(
        /^# /m,
      );
      expect(html).not.toMatch(
        new RegExp(
          ["say ?when", "builder[\\s_-]?core", "un" + "bounce"].join("|"),
          "i",
        ),
      );
    },
  );

  test("every site link in the docs lands on a page and anchor that exist", async () => {
    for (const { slug } of docPages) {
      const html = await readFile(htmlFile(slug), "utf8");
      for (const [, href] of html.matchAll(/href="(\/[^"]*)"/g)) {
        const [path, hash] = (href ?? "").split("#");
        const target = path === "/" ? "/index" : (path ?? "");
        const file = /\.\w+$/.test(target) ? target : `${target}.html`;
        await expect(
          access(join(dist, file)),
          `${slug}: ${href}`,
        ).resolves.toBeUndefined();
        if (hash && file.endsWith(".html"))
          expect(
            await readFile(join(dist, file), "utf8"),
            `${slug}: ${href}`,
          ).toContain(`id="${hash}"`);
      }
    }
  });

  test("llms.txt lists every page and installs the current release", async () => {
    const llms = await readFile(join(dist, "llms.txt"), "utf8");
    const full = await readFile(join(dist, "llms-full.txt"), "utf8");
    const { version } = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    expect(llms).toMatch(/^# Idiom\n\n> /);
    expect(llms).toContain(
      `https://github.com/mattskilly/idiom/releases/download/v${version}/mattskilly-idiom-${version}.tgz`,
    );
    for (const command of [
      "/plugin marketplace add mattskilly/idiom",
      "/plugin install idiom@idiom",
      "codex plugin marketplace add mattskilly/idiom",
      "codex plugin add idiom@idiom",
      "/plugin update idiom@idiom",
      "codex plugin marketplace upgrade idiom",
    ])
      expect(llms).toContain(command);
    for (const slug of ["getting-started", "mcp"]) {
      for (const content of [
        await readFile(markdownFile(slug), "utf8"),
        await readFile(join(dist, "docs", `${slug}.html`), "utf8"),
      ]) {
        for (const command of [
          "/plugin marketplace add mattskilly/idiom",
          "/plugin install idiom@idiom",
          "codex plugin marketplace add mattskilly/idiom",
          "codex plugin add idiom@idiom",
          "/plugin update idiom@idiom",
          "codex plugin marketplace upgrade idiom",
        ])
          expect(content).toContain(command);
      }
    }
    const mcp = await readFile(markdownFile("mcp"), "utf8");
    expect(mcp).toContain("claude --plugin-dir /path/to/checkout");
    expect(mcp).toContain("node /path/to/checkout/dist/cli.js mcp");
    for (const { slug } of docPages) {
      const twin = `https://idiom.build/docs${slug === "" ? "" : `/${slug}`}.md`;
      expect(llms).toContain(`](${twin})`);
      const markdown = await readFile(markdownFile(slug), "utf8");
      expect(full).toContain(markdown.split("\n")[0]);
    }
    for (const page of docsGroups.flatMap((group) => group.pages))
      if (page.href !== undefined)
        expect(llms).toContain(`](https://idiom.build${page.href})`);
  });

  test.each([
    { width: 390, colorScheme: "light" as const },
    { width: 1440, colorScheme: "dark" as const },
  ])(
    "docs pages fit $width px in $colorScheme",
    async ({ width, colorScheme }) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme,
      });
      try {
        const page = await context.newPage();
        for (const { slug } of docPages) {
          const html = (await readFile(htmlFile(slug), "utf8")).replace(
            '<link rel="stylesheet" href="/docs/site.css">',
            `<style>${siteCss}</style>`,
          );
          await page.setContent(html, { waitUntil: "load" });
          const layout = await page.evaluate(() => ({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
          }));
          expect(layout.scrollWidth, slug).toBeLessThanOrEqual(
            layout.clientWidth + 1,
          );
          expect(await page.locator("main h1").isVisible(), slug).toBe(true);
        }
      } finally {
        await context.close();
      }
    },
    60_000,
  );
});

describe("landing structured data", () => {
  test("restates the visible FAQ word for word", async () => {
    const html = await readFile(join(dist, "index.html"), "utf8");
    const json = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(
      html,
    )?.[1];
    expect(json).toBeDefined();
    const graph = JSON.parse(json ?? "{}")["@graph"] as Array<{
      "@type": string;
      mainEntity?: Array<{ name: string }>;
    }>;
    const faq = graph.find((node) => node["@type"] === "FAQPage");
    const questions = [
      ...html.matchAll(/<div class="qa"><h3>([\s\S]*?)<\/h3>/g),
    ].map(([, question]) => question);
    expect(questions.length).toBeGreaterThanOrEqual(4);
    expect(faq?.mainEntity?.map((entry) => entry.name)).toEqual(questions);
    expect(graph.some((node) => node["@type"] === "SoftwareApplication")).toBe(
      true,
    );
  });
});

test("update and rollback workflow is under Start and describes upgrade safety and legacy binaries", async () => {
  expect(
    docsGroups.find((group) => group.label === "Start")?.pages,
  ).toContainEqual({
    slug: "update-and-roll-back",
    source: "site/docs/update-and-roll-back.md",
  });
  const markdown = await readFile(markdownFile("update-and-roll-back"), "utf8");
  for (const text of [
    "idiom upgrade",
    "--no-agent",
    "--dry-run",
    "--json",
    ".idiom-pristine/manifest.json",
    "exit status 1",
    "predate",
    "outside the managed trees",
    "same three-way merge rules",
    "never put",
  ]) {
    expect(markdown.toLowerCase()).toContain(text.toLowerCase());
  }
  for (const outcome of [
    "current",
    "adopted",
    "merged",
    "resolved",
    "conflicted",
    "installed",
    "removed",
    "kept",
  ])
    expect(markdown).toContain(`\`${outcome}\``);
});
