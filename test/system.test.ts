import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { chromium } from "playwright";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { collectSystemPage } from "../src/system/collect.js";
import { renderSystemPage } from "../src/system/html.js";
import { runSystem } from "../src/system/run.js";
import { collectSystemTokens } from "../src/system/tokens.js";
import type { SystemPageModel } from "../src/system/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function projectFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-system-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  return directory;
}

test("fresh projects publish one stable page and launch the exact printed path", async () => {
  const project = await projectFixture();
  const launches: Array<{ command: string; args: string[] }> = [];
  const output: string[] = [];
  const code = await run(["node", "idiom", "--project", project, "system"], {
    stdout: (message) => output.push(message),
    system: {
      platform: "darwin",
      launch: async (command, args) => {
        launches.push({ command, args });
      },
    },
  });
  const reportPath = join(project, ".idiom", "reports", "system.html");
  expect(code).toBe(0);
  expect(output).toEqual([`${reportPath}\n`]);
  expect(launches).toEqual([{ command: "open", args: [reportPath] }]);
  const source = await readFile(reportPath, "utf8");
  for (const title of [
    "Design tokens",
    "Observed palette and typography",
    "Design law",
    "Recorded rulings",
    "Standing prohibitions",
    "Coverage",
  ])
    expect(source).toContain(title);
  expect(source).toContain("No complete stored capture is available");
  expect(source).toContain("No qualifying stored review is available");
  expect(source).toContain("The decision log is empty");
  expect(source).toContain("connect-src &#39;none&#39;");
  expect(source).toContain("Print or save as PDF");
  expect(source).not.toMatch(/https?:\/\//);
});

test("configured rows use a bounded sibling alias environment for light and dark swatches", async () => {
  const project = await projectFixture();
  await writeFile(
    join(project, "theme.css"),
    `@theme inline {
  --color-bg: var(--bg);
  --space-card: 1rem;
  --overlay-none: transparent;
  --scrim: rgba(0, 0, 0, 0);
  --ink: currentColor;
}`,
  );
  await writeFile(
    join(project, "tokens.css"),
    `:root { color-scheme: light dark; --bg: light-dark(#fbfbf9, #0b0c0b); }`,
  );
  const tokens = await collectSystemTokens(project, "theme.css");
  const model: SystemPageModel = {
    projectName: "Alias fixture",
    generatedAt: "2026-08-21T12:00:00.000Z",
    tokens,
    observed: {
      status: "available",
      runId: "captured-colours",
      capturedAt: "2026-08-21T11:00:00.000Z",
      colors: [
        {
          value: "rgb(10, 120, 80)",
          coordinates: [
            {
              flow: "home",
              state: "ready",
              viewport: "desktop",
              colorScheme: "light",
            },
          ],
        },
      ],
      fontFamilies: [],
      fontSizes: [],
      fontWeights: [],
      typographyAvailable: true,
    },
    designLaw: "Use quiet surfaces.",
    rulings: [],
    decisionsAvailable: false,
    prohibitions: [],
    coverage: { status: "unavailable", reason: "No review." },
  };
  const source = renderSystemPage(model);
  expect(source).toContain("--color-bg");
  expect(source).not.toContain('data-token-name="--bg"');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(source, { waitUntil: "load" });
    const row = page.locator('[data-token-name="--color-bg"]');
    await expect(row.getAttribute("data-has-swatch")).resolves.toBe("true");
    const colors = await row
      .locator(".token-swatch span")
      .evaluateAll((items) =>
        items.map((item) => getComputedStyle(item).backgroundColor),
      );
    expect(colors).toEqual(["rgb(251, 251, 249)", "rgb(11, 12, 11)"]);
    expect(
      await page
        .locator('[data-token-name="--space-card"] [data-token-swatch]')
        .isHidden(),
    ).toBe(true);
    for (const name of ["--overlay-none", "--scrim"]) {
      const transparent = page.locator(`[data-token-name="${name}"]`);
      expect(
        await transparent.locator("[data-token-state]").textContent(),
      ).toBe("Colour token · fully transparent");
      expect(await transparent.locator("[data-token-swatch]").isHidden()).toBe(
        true,
      );
    }
    const inherited = page.locator('[data-token-name="--ink"]');
    expect(await inherited.locator("[data-token-state]").textContent()).toBe(
      "Colour token · context-dependent",
    );
    expect(await inherited.locator("[data-token-swatch]").isHidden()).toBe(
      true,
    );
    await page.emulateMedia({ media: "print" });
    const printAdjustments = await page
      .locator(
        '[data-has-swatch="true"] .token-swatch, [data-has-swatch="true"] .token-swatch span, .observed-swatch',
      )
      .evaluateAll((items) =>
        items.map((item) => ({
          standard:
            getComputedStyle(item).getPropertyValue("print-color-adjust"),
          webkit: getComputedStyle(item).getPropertyValue(
            "-webkit-print-color-adjust",
          ),
        })),
      );
    expect(printAdjustments).toHaveLength(4);
    expect(printAdjustments).toEqual(
      printAdjustments.map(() => ({ standard: "exact", webkit: "exact" })),
    );
  } finally {
    await browser.close();
  }
});

test("launch failures retain the generated system page and use report diagnostics", async () => {
  const project = await projectFixture();
  const reportPath = join(project, ".idiom", "reports", "system.html");
  await expect(
    runSystem({
      project,
      dependencies: {
        platform: "linux",
        launch: async () => {
          throw new Error("no desktop");
        },
      },
    }),
  ).rejects.toThrow(`could not open HTML report ${reportPath}: no desktop`);
  expect(await readFile(reportPath, "utf8")).toContain("Idiom system");
});

test("token dependency failures stay local and deterministic", async () => {
  const project = await projectFixture();
  await mkdir(join(project, "styles"));
  await writeFile(
    join(project, "styles", "theme.css"),
    `@import "./support.css";
:root {
  --literal: oklch(60% .2 20);
  --fallback: var(--not-here, #abc);
  --missing-token: var(--missing);
  --cyclic-token: var(--loop-a);
  --conflicting-token: var(--shared);
}`,
  );
  await writeFile(
    join(project, "styles", "support.css"),
    `:root { --loop-a: var(--loop-b); --loop-b: var(--loop-a); --shared: red; }`,
  );
  await writeFile(
    join(project, "styles", "other.css"),
    `:root { --shared: blue; }`,
  );
  const result = await collectSystemTokens(project, "styles/theme.css");
  expect(result.status).toBe("configured");
  if (result.status !== "configured") return;
  const resolutions = new Map(
    result.tokens.map((token) => [token.name, token.resolution]),
  );
  expect(resolutions.get("--literal")).toEqual({ status: "available" });
  expect(resolutions.get("--fallback")).toEqual({ status: "available" });
  expect(resolutions.get("--missing-token")).toEqual({
    status: "unavailable",
    reason: "--missing resolves outside the available token sources",
  });
  expect(resolutions.get("--cyclic-token")).toMatchObject({
    status: "unavailable",
  });
  expect(
    (resolutions.get("--cyclic-token") as { reason: string }).reason,
  ).toContain("cyclic custom-property dependency");
  expect(resolutions.get("--conflicting-token")).toEqual({
    status: "unavailable",
    reason:
      "--shared has conflicting declarations in the available token sources",
  });
  expect(result.tokens.map((token) => token.name)).not.toContain("--shared");
});

test("token support rejects package, URL, lexical, and symlink escapes", async () => {
  const project = await projectFixture();
  const outside = await mkdtemp(join(tmpdir(), "idiom-system-outside-"));
  directories.push(outside);
  const styles = join(project, "styles");
  await mkdir(styles);
  const escapedSource = join(outside, "escaped.css");
  const importedLinkSource = join(outside, "imported-link.css");
  const siblingLinkSource = join(outside, "sibling-link.css");
  await Promise.all([
    writeFile(escapedSource, ":root { --outside-secret: #bad001; }"),
    writeFile(importedLinkSource, ":root { --linked-secret: #bad002; }"),
    writeFile(siblingLinkSource, ":root { --sibling-secret: #bad003; }"),
    symlink(importedLinkSource, join(styles, "linked-import.css")),
    symlink(siblingLinkSource, join(styles, "linked-sibling.css")),
  ]);
  const escapedImport = relative(styles, escapedSource).split(sep).join("/");
  await writeFile(
    join(styles, "theme.css"),
    `@import "tailwindcss";
@import url("https://example.test/remote.css");
@import "${escapedImport}";
@import "./linked-import.css";
:root {
  --from-package: var(--package-secret);
  --from-url: var(--url-secret);
  --from-escape: var(--outside-secret);
  --from-import-link: var(--linked-secret);
  --from-sibling-link: var(--sibling-secret);
}`,
  );

  const result = await collectSystemTokens(project, "styles/theme.css");
  expect(result.status).toBe("configured");
  if (result.status !== "configured") return;
  for (const [token, dependency] of [
    ["--from-package", "--package-secret"],
    ["--from-url", "--url-secret"],
    ["--from-escape", "--outside-secret"],
    ["--from-import-link", "--linked-secret"],
    ["--from-sibling-link", "--sibling-secret"],
  ])
    expect(
      result.tokens.find(({ name }) => name === token)?.resolution,
    ).toEqual({
      status: "unavailable",
      reason: `${dependency} resolves outside the available token sources`,
    });
  for (const name of [
    "--package-secret",
    "--url-secret",
    "--outside-secret",
    "--linked-secret",
    "--sibling-secret",
  ])
    expect(result.environment).not.toHaveProperty(name);

  const source = renderSystemPage({
    projectName: "Contained fixture",
    generatedAt: "2026-08-21T12:00:00.000Z",
    tokens: result,
    observed: { status: "unavailable", reason: "No capture." },
    designLaw: "Keep local evidence bounded.",
    rulings: [],
    decisionsAvailable: false,
    prohibitions: [],
    coverage: { status: "unavailable", reason: "No review." },
  });
  expect(source).not.toMatch(/#bad00[123]/);
  expect(source).not.toContain("https://example.test/remote.css");
});

const observedStyles = {
  color: "rgb(20, 30, 40)",
  backgroundColor: "rgb(10, 120, 80)",
  borderTopColor: "rgb(0, 0, 0)",
  borderRightColor: "rgb(0, 0, 0)",
  borderBottomColor: "rgb(0, 0, 0)",
  borderLeftColor: "rgb(0, 0, 0)",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  outlineColor: "rgb(0, 0, 0)",
  outlineWidth: "0px",
  outlineStyle: "none",
  textOverflow: "clip",
  fill: "rgb(9, 9, 9)",
  stroke: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
  display: "block",
  visibility: "visible",
  opacity: "1",
  fontFamily: "Inter, sans-serif",
  fontSize: "18px",
  fontWeight: "600",
  lineHeight: "24px",
  letterSpacing: "normal",
  textAlign: "start",
  textDecorationLine: "none",
  textTransform: "none",
  whiteSpace: "normal",
  wordBreak: "normal",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  marginTop: "0px",
  marginRight: "0px",
  marginBottom: "0px",
  marginLeft: "0px",
  gap: "normal",
  flexDirection: "row",
  justifyContent: "normal",
  alignItems: "normal",
  gridTemplateColumns: "none",
  boxShadow: "none",
  transform: "none",
  zIndex: "auto",
};

async function storedTuple(options: {
  project: string;
  runId: string;
  viewport: { name: string; width: number; height: number };
  startedAt: string;
  flow?: string | undefined;
}): Promise<void> {
  const directory = join(
    options.project,
    ".idiom",
    "reports",
    options.runId,
    "ready",
    options.viewport.name,
  );
  await mkdir(directory, { recursive: true });
  const metadata = {
    source: { commit: "abc123", dirty: false },
    flow: { id: options.flow ?? "home", title: "Home" },
    state: { id: "ready", description: "Ready" },
    viewport: options.viewport,
    timestamps: { startedAt: options.startedAt, endedAt: options.startedAt },
    status: 200,
    expectations: { passed: true, mismatches: [] },
    failure: null,
  };
  const observations = {
    version: 2,
    viewport: {
      width: options.viewport.width,
      height: options.viewport.height,
    },
    document: {
      scrollWidth: options.viewport.width,
      scrollHeight: options.viewport.height,
      clientWidth: options.viewport.width,
      clientHeight: options.viewport.height,
    },
    elements: [
      {
        selector: "p.copy",
        tag: "p",
        text: "Visible copy",
        visible: true,
        interactive: false,
        enabled: true,
        rect: { x: 0, y: 0, width: 100, height: 24 },
        scrollWidth: 100,
        scrollHeight: 24,
        clientWidth: 100,
        clientHeight: 24,
        outOfFlow: false,
        inlineTextTarget: true,
        ancestorSelectors: ["body"],
        authoredProperties: ["color", "background-color"],
        styles: observedStyles,
        hitTestWith: [],
        structuralPath: "body/p[1]",
        directText: "Visible copy",
        attributes: {},
        temporal: false,
        stableIslandPath: "body",
        relativeRect: { x: 0, y: 0, width: 100, height: 24 },
      },
    ],
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
  };
  await Promise.all([
    writeFile(join(directory, "metadata.json"), JSON.stringify(metadata)),
    writeFile(join(directory, "screenshot.png"), "png"),
    writeFile(join(directory, "dom.html"), "<p>Visible copy</p>"),
    writeFile(join(directory, "console.jsonl"), ""),
    writeFile(join(directory, "axe.json"), '{"violations":[]}'),
    writeFile(
      join(directory, "observations.json"),
      JSON.stringify(observations),
    ),
  ]);
}

test("observed evidence prefers the newest complete capture while coverage follows the newest review", async () => {
  const project = await projectFixture();
  await writeFile(
    join(project, ".idiom", "flows", "home.json"),
    JSON.stringify({
      id: "home",
      title: "Home",
      intent: [],
      setup: [],
      states: [{ id: "ready", description: "Ready", url: "/", expect: {} }],
    }),
  );
  const complete = "arbitrary-complete";
  const partial = "newer-partial";
  const stale = "newest-retired-flow";
  const empty = "newest-empty-review";
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ])
    await storedTuple({
      project,
      runId: complete,
      viewport,
      startedAt: "2026-08-20T12:00:00.000Z",
    });
  await storedTuple({
    project,
    runId: partial,
    viewport: { name: "desktop", width: 1440, height: 900 },
    startedAt: "2026-08-21T12:00:00.000Z",
  });
  await storedTuple({
    project,
    runId: stale,
    viewport: { name: "desktop", width: 1440, height: 900 },
    startedAt: "2026-08-22T12:00:00.000Z",
    flow: "retired",
  });
  await mkdir(join(project, ".idiom", "reports", empty), { recursive: true });
  const completeFindings = join(
    project,
    ".idiom",
    "reports",
    complete,
    "findings.json",
  );
  const partialFindings = join(
    project,
    ".idiom",
    "reports",
    partial,
    "findings.json",
  );
  const staleFindings = join(
    project,
    ".idiom",
    "reports",
    stale,
    "findings.json",
  );
  const emptyFindings = join(
    project,
    ".idiom",
    "reports",
    empty,
    "findings.json",
  );
  const rejectedFinding = {
    id: "finding-1",
    fingerprint: "standing-pattern",
    createdAt: "2026-08-20T12:00:00.000Z",
    commit: "abc123",
    flow: "home",
    state: "ready",
    viewport: "desktop",
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    rule: "Interactive targets remain comfortably sized.",
    evidence: {
      screenshots: [
        "ready/desktop/screenshot.png",
        "ready/mobile/screenshot.png",
        "ready/desktop/screenshot.png",
      ],
    },
    explanation: "Do not repeat the undersized primary action.",
    acceptance: ["The primary action has a comfortable target."],
    verification: { kind: "deterministic-check", check: "target-size" },
    status: "rejected",
  };
  await writeFile(completeFindings, `${JSON.stringify([rejectedFinding])}\n`);
  await writeFile(partialFindings, "[]\n");
  await writeFile(staleFindings, "[]\n");
  await writeFile(emptyFindings, "[]\n");
  await writeFile(
    join(project, ".idiom", "decisions.jsonl"),
    `${JSON.stringify({
      at: "2026-08-20T13:00:00.000Z",
      commit: "abc123",
      findingId: "finding-1",
      fingerprint: "standing-pattern",
      decision: "reject",
      scope: "rule",
      reason: "This pattern makes the main action too hard to use.",
      actor: "human",
    })}\n`,
  );
  await utimes(
    completeFindings,
    new Date("2026-08-20T13:00:00.000Z"),
    new Date("2026-08-20T13:00:00.000Z"),
  );
  await utimes(
    partialFindings,
    new Date("2026-08-21T13:00:00.000Z"),
    new Date("2026-08-21T13:00:00.000Z"),
  );
  await utimes(
    staleFindings,
    new Date("2026-08-22T13:00:00.000Z"),
    new Date("2026-08-22T13:00:00.000Z"),
  );
  await utimes(
    emptyFindings,
    new Date("2026-08-23T13:00:00.000Z"),
    new Date("2026-08-23T13:00:00.000Z"),
  );
  const model = await collectSystemPage({
    project,
    now: () => new Date("2026-08-21T14:00:00.000Z"),
  });
  expect(model.observed).toMatchObject({
    status: "available",
    runId: complete,
    typographyAvailable: true,
  });
  if (model.observed.status === "available") {
    expect(model.observed.colors.map((entry) => entry.value)).toContain(
      "rgb(10, 120, 80)",
    );
    expect(model.observed.colors.map((entry) => entry.value)).not.toContain(
      "rgb(9, 9, 9)",
    );
    expect(model.observed.fontSizes[0]).toMatchObject({ value: "18px" });
    expect(model.observed.fontSizes[0]?.coordinates[0]).toMatchObject({
      flow: "home",
      state: "ready",
      viewport: "desktop",
      colorScheme: "light",
    });
  }
  expect(model.coverage).toMatchObject({
    status: "available",
    runId: partial,
    value: { selectedTuples: 2, successfulTuples: 1 },
  });
  if (model.coverage.status === "available")
    expect(model.coverage.value.surfaceCoverage).toEqual({
      judged: [],
      governedNotJudged: [],
      ungoverned: [],
    });
  expect(model.prohibitions).toHaveLength(1);
  expect(model.prohibitions[0]).toMatchObject({
    kind: "described",
    behavior: "Do not repeat the undersized primary action.",
    reason: "This pattern makes the main action too hard to use.",
    images: [
      { path: "ready/desktop/screenshot.png" },
      { path: "ready/mobile/screenshot.png" },
    ],
  });
  const html = renderSystemPage(model);
  expect(html).toContain("Do not repeat the undersized primary action.");
  expect(html).toContain("This pattern makes the main action too hard to use.");
  expect(html.match(/data:image\/png;base64,cG5n/g)).toHaveLength(2);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const visibleText = await page.locator("body").innerText();
    expect(visibleText).not.toMatch(
      /\b(?:score|grade|rating)\b|\b\d+(?:\.\d+)?\s?%/iu,
    );
  } finally {
    await browser.close();
  }
});

test("coverage degrades when every completed review is stale or lacks tuple evidence", async () => {
  const project = await projectFixture();
  await storedTuple({
    project,
    runId: "retired-review",
    viewport: { name: "desktop", width: 1440, height: 900 },
    startedAt: "2026-08-21T12:00:00.000Z",
    flow: "retired",
  });
  await writeFile(
    join(project, ".idiom", "reports", "retired-review", "findings.json"),
    "[]\n",
  );
  const empty = join(project, ".idiom", "reports", "empty-review");
  await mkdir(empty, { recursive: true });
  await writeFile(join(empty, "findings.json"), "[]\n");

  await expect(collectSystemPage({ project })).resolves.toMatchObject({
    coverage: {
      status: "unavailable",
      reason: "No qualifying stored review is available.",
    },
  });
});
