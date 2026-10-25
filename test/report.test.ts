import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import {
  comparison,
  escapeHtml,
  escapeHtmlAttribute,
  evidenceLink,
  pngDataUri,
  renderHtmlDocument,
  reportRelativeHref,
  writeHtmlReport,
} from "../src/report/html.js";
import {
  openHtmlReport,
  reportLaunchCommand,
  resolveHtmlReport,
} from "../src/report/open.js";
import { renderVerificationHtmlReport } from "../src/verify/html-report.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function projectFixture(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "idiom-html-report-"));
  directories.push(project);
  await initProject({ project, yes: true });
  return project;
}

function png(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return PNG.sync.write(image);
}

test("shared HTML helpers escape hostile content and couple data images to CSP", async () => {
  expect(escapeHtml(`<script>&"`)).toBe('&lt;script&gt;&amp;"');
  expect(escapeHtmlAttribute(`'"<&`)).toBe("&#39;&quot;&lt;&amp;");
  expect(reportRelativeHref("https://host/a b#c")).toBe(
    "https%3A//host/a%20b%23c",
  );
  expect(evidenceLink("data:text/html,x")).toContain(
    'href="data%3Atext/html%2Cx"',
  );
  expect(() => reportRelativeHref("../outside.png")).toThrow("unsafe");

  const before = pngDataUri(Buffer.from("before"));
  const after = pngDataUri(Buffer.from("after"));
  const source = renderHtmlDocument({
    title: `Hostile </title><img src="https://example.test/x">`,
    body: comparison(
      { state: `ready"<`, viewport: "mobile", before, after },
      0,
    ),
    interactive: true,
  });
  expect(source).toContain("prefers-color-scheme: dark");
  expect(source).toContain("color-scheme: light dark");
  const cspAttribute = source.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
  )?.[1];
  expect(cspAttribute).toBeDefined();
  const emittedCsp = cspAttribute
    ?.replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
  expect(emittedCsp).toContain("default-src 'none'");
  expect(emittedCsp).toContain("img-src data:");
  expect(emittedCsp).not.toMatch(/'self'|file:|https?:|\/\//);
  expect(emittedCsp).toContain("connect-src 'none'");
  expect(emittedCsp).toContain("font-src 'none'");
  expect(emittedCsp).toContain("media-src 'none'");
  expect(emittedCsp).toContain("frame-src 'none'");
  const imageSources = [...source.matchAll(/<img[^>]+src="([^"]+)"/g)].map(
    (match) => match[1],
  );
  expect(imageSources).toHaveLength(2);
  expect(new Set(imageSources)).toEqual(new Set([before, after]));
  expect(
    imageSources.every((value) => value?.startsWith("data:image/png;base64,")),
  ).toBe(true);
  for (const imageSource of imageSources)
    expect(source.split(imageSource ?? "")).toHaveLength(2);
  expect(source).not.toContain("<form");
  const staticSource = renderHtmlDocument({ title: "Static", body: "ok" });
  expect(staticSource).toContain("script-src &#39;none&#39;");
  expect(staticSource).not.toContain("<script>");
  expect(staticSource).not.toContain("Print or save as PDF");

  const printableSource = renderHtmlDocument({
    title: "Printable",
    body: "ok",
    printable: true,
  });
  expect(printableSource).toContain("Print or save as PDF");
  expect(printableSource).toContain("window.print()");
  expect(printableSource).toContain("script-src &#39;unsafe-inline&#39;");

  const directory = await mkdtemp(join(tmpdir(), "idiom-html-write-"));
  directories.push(directory);
  const path = await writeHtmlReport(directory, source);
  expect(path).toBe(join(directory, "report.html"));
  expect(await readFile(path, "utf8")).toBe(source);
});

test("print mode invokes the native dialog and preserves bounded static evidence", async () => {
  const tall = pngDataUri(png(390, 4000));
  const source = renderHtmlDocument({
    title: "Printable evidence",
    body: `<section><img class="screenshot" src="${tall}" alt="Review screenshot"><pre>${"evidence ".repeat(200)}</pre><table><tbody><tr><td>long evidence</td></tr></tbody></table></section>${comparison(
      {
        state: "confirmed",
        viewport: "mobile",
        before: tall,
        after: pngDataUri(png(390, 4000)),
      },
      0,
    )}`,
    interactive: true,
    printable: true,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.setContent(source, { waitUntil: "load" });
    await page.evaluate(() => {
      window.print = () => {
        document.body.dataset.printInvoked = "yes";
      };
    });
    await page.getByRole("button", { name: "Print or save as PDF" }).click();
    await expect(
      page.evaluate(() => document.body.dataset.printInvoked),
    ).resolves.toBe("yes");

    await page.emulateMedia({ media: "print" });
    const metrics = await page.evaluate(() => {
      const images = [
        ...document.querySelectorAll<HTMLImageElement>(
          ".screenshot, .comparison-pair img",
        ),
      ];
      const control = document.querySelector<HTMLElement>(".report-actions");
      const slider = document.querySelector<HTMLElement>(".comparison-slider");
      const pre = document.querySelector<HTMLElement>("pre");
      const table = document.querySelector<HTMLElement>("table");
      return {
        imageHeights: images.map(
          (image) => image.getBoundingClientRect().height,
        ),
        controlDisplay:
          control === null ? "missing" : getComputedStyle(control).display,
        sliderDisplay:
          slider === null ? "missing" : getComputedStyle(slider).display,
        preMaxHeight:
          pre === null ? "missing" : getComputedStyle(pre).maxHeight,
        preOverflow: pre === null ? "missing" : getComputedStyle(pre).overflow,
        tableDisplay:
          table === null ? "missing" : getComputedStyle(table).display,
        tableOverflow:
          table === null ? "missing" : getComputedStyle(table).overflow,
      };
    });
    expect(metrics.controlDisplay).toBe("none");
    expect(metrics.sliderDisplay).toBe("none");
    expect(metrics.preMaxHeight).toBe("none");
    expect(metrics.preOverflow).toBe("visible");
    expect(metrics.tableDisplay).toBe("table");
    expect(metrics.tableOverflow).toBe("visible");
    expect(metrics.imageHeights).toHaveLength(3);
    for (const height of metrics.imageHeights) {
      expect(height).toBeGreaterThan(0);
      expect(height).toBeLessThanOrEqual(8 * 96);
    }
  } finally {
    await browser.close();
  }
});

test("both verification HTML branches expose a working print action", async () => {
  const manifest = {
    version: 1 as const,
    report: {
      kind: "idiom-verify-report" as const,
      path: "before-after.md" as const,
    },
    composites: [],
  };
  const sources = [
    renderVerificationHtmlReport({
      flow: "booking",
      baselineRunId: "baseline",
      currentRunA: "current-a",
      currentRunB: "current-b",
      diagnostic: "fixture",
      manifest,
    }),
    renderVerificationHtmlReport({
      flow: "booking",
      baselineRunId: "not applicable",
      currentRunA: "not run",
      currentRunB: "not run",
      noFindings: true,
      manifest,
    }),
  ];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const source of sources) {
      const page = await browser.newPage();
      expect(source).toContain("Print or save as PDF");
      await page.setContent(source, { waitUntil: "load" });
      await page.evaluate(() => {
        window.print = () => {
          document.body.dataset.printInvoked = "yes";
        };
      });
      await page.getByRole("button", { name: "Print or save as PDF" }).click();
      await expect(
        page.evaluate(() => document.body.dataset.printInvoked),
      ).resolves.toBe("yes");
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("multi-tuple reports embed each PNG payload exactly once", () => {
  const comparisons = Array.from({ length: 3 }, (_, index) => ({
    state: `state-${index}`,
    viewport: "mobile",
    before: pngDataUri(Buffer.alloc(4096, index + 1)),
    after: pngDataUri(Buffer.alloc(4096, index + 11)),
  }));
  const source = renderVerificationHtmlReport({
    flow: "booking",
    baselineRunId: "baseline",
    currentRunA: "current-a",
    currentRunB: "current-b",
    diagnostic: "fixture",
    manifest: {
      version: 1,
      report: { kind: "idiom-verify-report", path: "before-after.md" },
      composites: comparisons.map((item, index) => ({
        ordinal: index + 1,
        kind: `idiom-before-after-${String(index + 1).padStart(3, "0")}`,
        state: item.state,
        viewport: item.viewport,
        path: `before-after-${index}.png`,
      })),
    },
    comparisons,
  });
  const embedded = [...source.matchAll(/<img[^>]+src="([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
  expect(embedded).toHaveLength(6);
  expect(new Set(embedded).size).toBe(6);
  for (const imageSource of embedded)
    expect(source.split(imageSource)).toHaveLength(2);
});

test("comparison slider follows the intrinsic aspect of tall full-page captures", async () => {
  const source = renderHtmlDocument({
    title: "Tall comparison",
    body: comparison(
      {
        state: "confirmed",
        viewport: "mobile",
        before: pngDataUri(png(390, 4000)),
        after: pngDataUri(png(1440, 3200)),
      },
      0,
    ),
    interactive: true,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.setContent(source, { waitUntil: "load" });
    await page.waitForSelector("[data-before] img");
    const metrics = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>("[data-frame]");
      const slider = document.querySelector<HTMLInputElement>("[data-slider]");
      const after = document.querySelector<HTMLElement>("[data-after]");
      const afterImage = after?.querySelector("img");
      if (
        frame === null ||
        slider === null ||
        after === null ||
        afterImage === null ||
        afterImage === undefined
      )
        throw new Error("comparison did not initialize");
      const frameRect = frame.getBoundingClientRect();
      const widths = [0, 20, 50, 100].map((value) => {
        slider.value = String(value);
        slider.dispatchEvent(new Event("input"));
        return after.getBoundingClientRect().width;
      });
      slider.value = "50";
      slider.dispatchEvent(new Event("input"));
      return {
        frameWidth: frameRect.width,
        frameHeight: frameRect.height,
        afterImageWidth: afterImage.getBoundingClientRect().width,
        widths,
      };
    });
    expect(metrics.frameWidth).toBeGreaterThan(1000);
    expect(metrics.frameHeight / metrics.frameWidth).toBeCloseTo(4000 / 390, 1);
    expect(metrics.widths[0]).toBeCloseTo(0, 1);
    expect((metrics.widths[1] ?? 0) / metrics.frameWidth).toBeCloseTo(0.2, 2);
    expect((metrics.widths[2] ?? 0) / metrics.frameWidth).toBeCloseTo(0.5, 2);
    expect((metrics.widths[3] ?? 0) / metrics.frameWidth).toBeCloseTo(1, 2);
    expect(metrics.afterImageWidth / metrics.frameWidth).toBeGreaterThan(0.995);
  } finally {
    await browser.close();
  }
});

test("verify HTML includes labeled presentation-only comparisons in diagnostic reports", () => {
  const source = renderVerificationHtmlReport({
    flow: "booking",
    baselineRunId: "baseline",
    currentRunA: "current-a",
    currentRunB: "current-b",
    diagnostic: "current captures disagree",
    manifest: {
      version: 1,
      report: { kind: "idiom-verify-report", path: "before-after.md" },
      composites: [
        {
          ordinal: 1,
          kind: "idiom-before-after-001",
          state: "confirmed",
          viewport: "desktop",
          path: "before-after-confirmed-desktop.png",
        },
      ],
    },
    comparisons: [
      {
        state: "confirmed",
        viewport: "desktop",
        before: pngDataUri(Buffer.from("before")),
        after: pngDataUri(Buffer.from("after")),
      },
    ],
  });
  expect(source).toContain("failed — verification was not safely decidable");
  expect(source).toContain("current captures disagree");
  expect(source).toContain("Before: confirmed at desktop");
  expect(source).toContain("After: confirmed at desktop");
  expect(source).toContain('data-slider type="range"');
  expect(source).toContain("Open composite PNG");
  expect(source).not.toContain("decide --accept");
});

test("report resolution selects named or newest regular HTML report deterministically", async () => {
  const project = await projectFixture();
  const reports = join(project, ".idiom", "reports");
  const older = join(reports, "review-old");
  const tieA = join(reports, "verify-a");
  const tieB = join(reports, "verify-b");
  await Promise.all([
    mkdir(older, { recursive: true }),
    mkdir(tieA, { recursive: true }),
    mkdir(tieB, { recursive: true }),
    mkdir(join(reports, "capture-only"), { recursive: true }),
  ]);
  const olderReport = join(older, "report.html");
  const tieAReport = join(tieA, "report.html");
  const tieBReport = join(tieB, "report.html");
  await Promise.all([
    writeFile(olderReport, "old"),
    writeFile(tieAReport, "a"),
    writeFile(tieBReport, "b"),
  ]);
  await utimes(olderReport, new Date(1_000), new Date(1_000));
  await Promise.all([
    utimes(tieAReport, new Date(2_000), new Date(2_000)),
    utimes(tieBReport, new Date(2_000), new Date(2_000)),
  ]);

  await expect(resolveHtmlReport({ project })).resolves.toMatchObject({
    runId: "verify-b",
    reportPath: tieBReport,
  });
  await expect(
    resolveHtmlReport({ project, runId: "review-old" }),
  ).resolves.toMatchObject({ runId: "review-old", reportPath: olderReport });
  await expect(
    resolveHtmlReport({ project, runId: "../outside" }),
  ).rejects.toThrow("simple directory name");
  await expect(
    resolveHtmlReport({ project, runId: "capture-only" }),
  ).rejects.toThrow("does not exist");
});

test("platform launch shapes and the CLI use the injectable launcher", async () => {
  expect(reportLaunchCommand("darwin", "/tmp/report.html")).toEqual({
    command: "open",
    args: ["/tmp/report.html"],
  });
  expect(reportLaunchCommand("linux", "/tmp/report.html")).toEqual({
    command: "xdg-open",
    args: ["/tmp/report.html"],
  });
  expect(reportLaunchCommand("win32", "C:\\report.html")).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "start", "", "C:\\report.html"],
  });

  const project = await projectFixture();
  const runDirectory = join(project, ".idiom", "reports", "review-1");
  await mkdir(runDirectory, { recursive: true });
  const reportPath = join(runDirectory, "report.html");
  await writeFile(reportPath, "report");
  const launch = vi.fn(async () => undefined);
  await expect(
    openHtmlReport({
      project,
      runId: "review-1",
      dependencies: { platform: "darwin", launch },
    }),
  ).resolves.toMatchObject({ reportPath });
  expect(launch).toHaveBeenCalledWith("open", [reportPath]);

  const stdout: string[] = [];
  expect(
    await run(["node", "idiom", "report", "review-1", "--project", project], {
      stdout: (message) => stdout.push(message),
      stderr: () => undefined,
      report: { platform: "linux", launch },
    }),
  ).toBe(0);
  expect(stdout.join("")).toContain(`Opened report review-1 — ${reportPath}`);

  await expect(
    openHtmlReport({
      project,
      runId: "review-1",
      dependencies: {
        launch: async () => {
          throw new Error("launcher unavailable");
        },
      },
    }),
  ).rejects.toThrow("launcher unavailable");
});
