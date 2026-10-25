// Renders the benchmark fixture's before/after pages for the README.
// Usage: node scripts/render-readme-screenshots.mjs
// Viewport 1280x800 keeps the whole editor chrome, including the bare "?"
// beside Layers and the override dots, above the fold.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(repositoryRoot, "test", "fixtures", "benchmark");
const outputDirectory = join(repositoryRoot, "docs", "images");

async function fixture(name) {
  const css = await readFile(join(fixtureDirectory, "chrome.css"), "utf8");
  return (await readFile(join(fixtureDirectory, name), "utf8")).replace(
    "/*CSS*/",
    css,
  );
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  for (const variant of ["before", "after"]) {
    await page.setContent(await fixture(`${variant}.html`));
    await page.waitForLoadState("load");
    await page.screenshot({
      path: join(outputDirectory, `benchmark-${variant}.png`),
    });
  }
} finally {
  await browser.close();
}
