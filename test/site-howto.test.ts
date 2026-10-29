import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createProgram } from "../src/cli.js";
import { flowSchema, webStepSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const root = join(import.meta.dirname, "..");
const articles = [
  { slug: "design-qa-for-claude-code", title: "Design QA for Claude Code" },
  {
    slug: "testing-loading-empty-error-states",
    title: "Testing loading, empty and error states",
  },
];
const outputs = new Map<string, string>();
let browser: Browser;
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["scripts/build-site.mjs"], {
    cwd: root,
  });
  for (const { slug } of articles)
    outputs.set(
      slug,
      await readFile(join(root, "site/dist", `${slug}.html`), "utf8"),
    );
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

test("how-to copy remains pinned to the dated release and public command surface", async () => {
  const metadata = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  expect(metadata.version).toBe("0.15.0");
  expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toContain(
    "## [v0.15.0] - 2026-10-28",
  );
  for (const { slug } of articles) {
    const source = await readFile(join(root, "site", `${slug}.html`), "utf8");
    expect(source).not.toMatch(/<(?:!doctype|html|head|body)\b/i);
    for (const html of [source, outputs.get(slug) ?? ""]) {
      // Ignore font bytes and CSS; these are reader-facing copy rules.
      const copy = html.replace(/<style>[\s\S]*?<\/style>/g, "");
      expect(copy).not.toMatch(/\b(?:score|grade|rating)s?\b/i);
      expect(copy).not.toMatch(
        new RegExp(
          [
            "say ?when",
            "builder[\\s_-]?core",
            "un" + "bounce",
            "ub-" + "builder",
          ].join("|"),
          "i",
        ),
      );
      expect(copy).not.toMatch(
        /--states|--fail-on-judged|basisDetails|regressionFree|acceptance\s*[:.]|&quot;data&quot;\s*:/,
      );
      expect(copy).toContain(
        `playwright@${metadata.dependencies.playwright} install chromium`,
      );
      expect(copy).toContain("v0.15.0");
    }
  }
  const qa = outputs.get(articles[0]?.slug ?? "") ?? "";
  for (const topic of [
    "idiom_context",
    "idiom_flows",
    "idiom_check",
    "idiom_issue",
    "idiom_fix_plan",
    "idiom_verify",
    "next.arguments",
    "PostToolUse",
    "Stop hook",
    "reminder epoch",
    "does not inspect",
    "/idiom:idiom",
    "uiGlobs",
    "scoped",
    "waived",
  ])
    expect(qa.toLowerCase(), topic).toContain(topic.toLowerCase());
  const states = outputs.get(articles[1]?.slug ?? "") ?? "";
  for (const topic of [
    "loading-state-missing",
    "double-submit",
    "empty-state",
    "error-state-missing",
    "retry-blocked",
    "progress-affordance",
    "longRunning",
    "failure",
    "network",
    "400–599",
    "fixture",
    "Expectation failures",
    "Full-page navigations",
    "budgets",
    "authentication",
  ])
    expect(states.toLowerCase(), topic).toContain(topic.toLowerCase());
});

test.each(articles)(
  "$title emits metadata, linked navigation and schema-valid copyable examples",
  async ({ slug, title }) => {
    const html = outputs.get(slug) ?? "";
    expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(html.match(/<html\b/gi)).toHaveLength(1);
    expect(html.match(/<head\b/gi)).toHaveLength(1);
    expect(html.match(/<body\b/gi)).toHaveLength(1);
    expect(html.match(/<title\b/gi)).toHaveLength(1);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent(html);
      expect(await page.title()).toBe(`${title} · Idiom`);
      expect(await page.locator("html").getAttribute("lang")).toBe("en");
      expect(await page.locator("meta[charset]").getAttribute("charset")).toBe(
        "utf-8",
      );
      expect(
        await page.locator('meta[name="viewport"]').getAttribute("content"),
      ).toBe("width=device-width, initial-scale=1");
      expect(
        await page.locator('link[rel="canonical"]').getAttribute("href"),
      ).toBe(`https://idiom.build/${slug}`);
      expect(
        await page.locator('meta[property="og:url"]').getAttribute("content"),
      ).toBe(`https://idiom.build/${slug}`);
      expect(
        await page.locator('meta[property="og:title"]').getAttribute("content"),
      ).toBe(`idiom · ${title}`);
      const lede = (await page.locator(".lede").innerText())
        .replace(/\s+/g, " ")
        .trim();
      for (const selector of [
        'meta[name="description"]',
        'meta[property="og:description"]',
      ])
        expect(await page.locator(selector).getAttribute("content")).toBe(lede);
      const links = await page
        .locator("a[href]")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("href") ?? ""),
        );
      expect(links).toContain("/guide");
      expect(links).toContain(
        `/${articles.find((article) => article.slug !== slug)?.slug}`,
      );
      for (const link of links) {
        const url = new URL(link, `https://idiom.build/${slug}`);
        if (url.origin !== "https://idiom.build") continue;
        const path = url.pathname === "/" ? "index" : url.pathname.slice(1);
        const target = await readFile(
          join(root, "site/dist", `${path}.html`),
          "utf8",
        );
        if (url.hash) expect(target).toContain(`id="${url.hash.slice(1)}"`);
      }
      const examples = await page
        .locator("code[data-example]")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            kind: node.getAttribute("data-example"),
            text: node.textContent ?? "",
          })),
        );
      expect(examples.filter(({ kind }) => kind === "project")).toHaveLength(1);
      expect(examples.filter(({ kind }) => kind === "flow")).toHaveLength(1);
      const fullProject = projectSchema.parse(
        JSON.parse(examples.find(({ kind }) => kind === "project")?.text ?? ""),
      );
      for (const { kind, text } of examples) {
        if (kind === "project") projectSchema.parse(JSON.parse(text));
        if (kind === "flow") {
          const flow = flowSchema.parse(JSON.parse(text));
          for (const state of flow.states)
            expect(state.expect.textPresent.length).toBeGreaterThan(0);
        }
        if (kind === "project-partial") {
          const partial = JSON.parse(text);
          projectSchema.parse({ ...fullProject, ...partial });
        }
        if (kind === "state-partial") {
          for (const step of JSON.parse(text).steps) webStepSchema.parse(step);
        }
        if (kind === "shell") {
          for (const line of text.split("\n")) {
            if (!line.startsWith("idiom ")) continue;
            const [, name, ...args] = line.split(/\s+/);
            const command = createProgram().commands.find(
              (candidate) => candidate.name() === name,
            );
            expect(command, line).toBeDefined();
            if (!command) throw new Error(`Unknown command: ${line}`);
            for (const arg of args.filter((arg) => arg.startsWith("--")))
              expect(
                command.options.some((option) => option.long === arg),
                line,
              ).toBe(true);
            for (const option of command.options.filter(
              (option) => option.mandatory,
            ))
              expect(args, line).toContain(option.long);
          }
        }
      }
    } finally {
      await context.close();
    }
  },
);

test("field guide links both deployable articles", async () => {
  const guide = await readFile(join(root, "site/dist/guide.html"), "utf8");
  for (const { slug, title } of articles)
    expect(guide).toContain(`<a href="/${slug}">${title}</a>`);
});

for (const article of articles) {
  test.each([
    { width: 390, colorScheme: "light" as const },
    { width: 390, colorScheme: "dark" as const },
    { width: 1440, colorScheme: "light" as const },
    { width: 1440, colorScheme: "dark" as const },
  ])(
    `${article.title} at $width px in $colorScheme works offline with accessible focus and theme`,
    async ({ width, colorScheme }) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme,
      });
      try {
        const page = await context.newPage();
        const remote: string[] = [];
        page.on("request", (request) => {
          if (/^https?:/.test(request.url())) remote.push(request.url());
        });
        await page.setContent(outputs.get(article.slug) ?? "", {
          waitUntil: "load",
        });
        expect(remote).toEqual([]);
        expect(await page.locator("h1").innerText()).toBe(article.title);
        expect(await page.locator("main").isVisible()).toBe(true);
        expect(await page.locator(".lede").isVisible()).toBe(true);
        expect(
          await page
            .locator(".lede")
            .evaluate((node) =>
              Number.parseFloat(getComputedStyle(node).fontSize),
            ),
        ).toBeGreaterThanOrEqual(16);
        const layout = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          width: document.documentElement.clientWidth,
        }));
        expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
        await page.keyboard.press("Tab");
        const focus = await page.locator(":focus").evaluate((node) => ({
          style: getComputedStyle(node).outlineStyle,
          width: getComputedStyle(node).outlineWidth,
        }));
        expect(focus.style).not.toBe("none");
        expect(Number.parseFloat(focus.width)).toBeGreaterThanOrEqual(2);
        const violations = (
          await new AxeBuilder({ page }).analyze()
        ).violations.filter((violation) =>
          ["serious", "critical"].includes(violation.impact ?? ""),
        );
        expect(
          violations.map(({ id, nodes }) => ({
            id,
            targets: nodes.map((node) => node.target),
          })),
        ).toEqual([]);
        const other = colorScheme === "light" ? "dark" : "light";
        const toggle = page.getByRole("button", {
          name: `Switch to ${other} theme`,
        });
        const before = await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        );
        await toggle.click();
        expect(await page.locator("html").getAttribute("data-theme")).toBe(
          other,
        );
        expect(
          await page.evaluate(
            () => getComputedStyle(document.body).backgroundColor,
          ),
        ).not.toBe(before);
        expect(
          await page
            .getByRole("button", { name: `Switch to ${colorScheme} theme` })
            .count(),
        ).toBe(1);
      } finally {
        await context.close();
      }
    },
  );
}
