import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { captureDesign } from "../src/design/capture.js";
import { navigateDesign, resolveDesignSource } from "../src/design/source.js";
import { designDescriptorSchema } from "../src/design/types.js";
import { createQuickConfiguration } from "../src/quick/config.js";
import { captureLiteralPages, quickDesignReference } from "../src/quick/run.js";
import {
  designDeclarationSchema,
  designLocationSchema,
  designSourceLabel,
  imageDesignExtension,
} from "../src/schemas/design.js";

const fixture = join(import.meta.dirname, "fixtures/design-drift/design.html");
test("directory entry selection, Unicode resources, MIME types and root containment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-design-source-"));
  try {
    const root = join(directory, "export");
    await mkdir(root);
    await writeFile(join(directory, "secret.txt"), "outside");
    await writeFile(
      join(root, "screen ü.html"),
      '<!doctype html><link rel="stylesheet" href="a%20b.css"><script type="module" src="module.js"></script><main>Hello</main>',
    );
    await writeFile(join(root, "a b.css"), "main{width:123px}");
    await writeFile(
      join(root, "module.js"),
      "document.querySelector('main').dataset.loaded='yes'",
    );
    await symlink(join(directory, "secret.txt"), join(root, "escape.txt"));
    const source = await resolveDesignSource(root, directory);
    try {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await navigateDesign(page, source);
        expect(
          await page.locator("main").evaluate((e) => getComputedStyle(e).width),
        ).toBe("123px");
        expect(await page.locator("main").getAttribute("data-loaded")).toBe(
          "yes",
        );
        expect(
          (await fetch(new URL("a%20b.css", source.url))).headers.get(
            "content-type",
          ),
        ).toBe("text/css");
        expect((await fetch(new URL("escape.txt", source.url))).status).toBe(
          404,
        );
        expect(
          (await fetch(new URL("/%2e%2e%2fsecret.txt", source.url))).status,
        ).toBe(404);
      } finally {
        await browser.close();
      }
    } finally {
      await source.close();
    }
    await writeFile(join(root, "other.html"), "<p>Other</p>");
    await expect(resolveDesignSource(root, directory)).rejects.toThrow(
      "candidates: other.html, screen ü.html",
    );
    await writeFile(join(root, "index.html"), "<p>Index</p>");
    const index = await resolveDesignSource(root, directory);
    expect(index.provenance.entry).toBe(join(root, "index.html"));
    await index.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote redirects, HTML validation, inline preview bases and inaccessible shares", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/design" });
      response.end();
      return;
    }
    if (request.url === "/image") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end("png");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url === "/design")
      response.end(
        "<!doctype html><title>Design</title><p>Rendered preview</p>",
      );
    else if (request.url === "/component")
      response.end(
        '<style>.dot{width:20px;height:20px;background:red;border-radius:50%}</style><div class="dot"></div>',
      );
    else if (request.url === "/denied")
      response.end("<title>Access denied</title><p>Access denied</p>");
    else if (request.url === "/assets/preview.css") {
      response.end("p{font-size:23px}");
    } else response.end("<p>Unknown</p>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const origin = `http://127.0.0.1:${address.port}`,
    browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await expect(
      navigateDesign(
        page,
        await resolveDesignSource(`${origin}/component`, "."),
      ),
    ).resolves.toBe(200);
    const source = await resolveDesignSource(`${origin}/redirect`, ".");
    await navigateDesign(page, source);
    expect(source.provenance.final).toBe(`${origin}/design`);
    await expect(
      navigateDesign(page, await resolveDesignSource(`${origin}/image`, ".")),
    ).rejects.toThrow("not HTML");
    await expect(
      navigateDesign(page, await resolveDesignSource(`${origin}/denied`, ".")),
    ).rejects.toThrow("inaccessible");
    // A generic rendered iframe resolver regression, not a live provider DOM contract.
    // All HTML is intercepted locally; no provider endpoint or account is accessed.
    let html = `<title>Share shell</title><iframe src="${origin}/design"></iframe>`;
    await page.route("https://claude.ai/artifacts/test", (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
    const share = await resolveDesignSource(
      "https://claude.ai/artifacts/test",
      ".",
    );
    await navigateDesign(page, share);
    expect(await page.locator("body").innerText()).toBe("Rendered preview");
    expect(page.url()).toBe(`${origin}/design`);
    html =
      '<title>Share shell</title><iframe srcdoc="&lt;title&gt;Inline&lt;/title&gt;&lt;p&gt;Inline preview&lt;/p&gt;"></iframe>';
    await navigateDesign(page, share);
    expect(share.provenance.kind).toBe("inline");
    expect(await page.locator("base").getAttribute("href")).toBe(
      "https://claude.ai/artifacts/test",
    );
    expect(await page.locator("p").innerText()).toBe("Inline preview");
    html = '<iframe src="/one"></iframe><iframe src="/two"></iframe>';
    await expect(navigateDesign(page, share)).rejects.toThrow("ambiguous");
    html = "<h1>Sign in</h1>";
    await expect(navigateDesign(page, share)).rejects.toThrow(
      "export standalone HTML",
    );
  } finally {
    await browser.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 30000);

test("failed declared designs persist unavailable coverage and block passing capture counts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-design-failure-"));
  const source = await resolveDesignSource(fixture, directory);
  try {
    const configuration = createQuickConfiguration([source.url], {
      design: join(directory, "missing.html"),
      colorSchemes: ["light", "dark"],
    });
    const result = await captureLiteralPages({
      directory,
      finalDirectory: join(directory, "run"),
      configuration,
      checks: checksConfigFrom(),
      startedAt: new Date(),
      label: "test",
    });
    expect(result.counts).toEqual({ passed: 0, failed: 4, total: 4 });
    for (const tuple of result.loaded.tuples) {
      expect(tuple.design?.descriptor.status).toBe("failed");
      expect(tuple.failure).toBeUndefined();
      expect(
        tuple.artifactPaths.some((p) => p.endsWith("design/source.json")),
      ).toBe(true);
    }
    const coverage = result.reviewed.coverage.filter(
      (c) => c.coverage.check === "design-drift",
    );
    expect(coverage.map((c) => c.coverage.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(
      result.reviewed.candidates.filter(
        (c) => c.candidate.category === "design-drift",
      ),
    ).toEqual([]);
    expect(
      await readFile(join(result.runDirectory, "baseline.md"), "utf8"),
    ).toContain("missing.html");
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("reference capture ignores app steps, focus and probes, and aborts cleanly", async () => {
  const configuration = createQuickConfiguration(["http://localhost/"], {
    checks: undefined,
  });
  const browser = await createBrowserLauncher()();
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(
      captureDesign({
        source: fixture,
        directory: ".",
        project: configuration.project,
        viewport: configuration.project.viewports[0] as NonNullable<
          (typeof configuration.project.viewports)[0]
        >,
        colorScheme: "dark",
        browser,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    const captured = await captureDesign({
      source: fixture,
      directory: ".",
      project: configuration.project,
      viewport: configuration.project.viewports[0] as NonNullable<
        (typeof configuration.project.viewports)[0]
      >,
      colorScheme: "dark",
      browser,
    });
    expect(captured.failure).toBeUndefined();
    expect(captured.result?.observations?.version).toBe(2);
    if (captured.result?.observations?.version === 2) {
      expect(captured.result.observations.probe).toBeUndefined();
      expect(captured.result.observations.invariants).toEqual([]);
    }
  } finally {
    await browser.close();
  }
}, 30000);

test("Electron captures lazily acquire Chromium references and retain both runtime versions", async () => {
  const { runCapture } = await import("../src/capture/run.js");
  const { flowSchema } = await import("../src/schemas/flow.js");
  const { loadCaptureRun } = await import("../src/review/artifacts.js");
  const directory = await mkdtemp(join(tmpdir(), "idiom-design-electron-"));
  const source = await resolveDesignSource(fixture, directory);
  const configuration = createQuickConfiguration([source.url], {
    colorSchemes: ["light", "dark"],
  });
  const appBrowser = await createBrowserLauncher()();
  let referenceLaunches = 0;
  try {
    const flow = flowSchema.parse({
      id: "desktop",
      title: "Desktop",
      intent: [],
      setup: [],
      target: {
        kind: "electron",
        launch: { executablePath: "unused" },
        window: { title: "Test" },
      },
      states: [
        { id: "home", description: "Home", design: fixture, expect: {} },
      ],
    });
    const result = await runCapture({
      projectDirectory: directory,
      project: configuration.project,
      flow,
      out: join(directory, "run"),
      scope: { viewports: "mobile", schemes: "dark" },
      dependencies: {
        inheritedEnvironment: {},
        snapshotSource: async () => ({ commit: "test", dirty: false }),
        browserLauncher: async (options) => {
          referenceLaunches++;
          return createBrowserLauncher()(options);
        },
        electronLauncher: async () => ({
          effectiveEnvironment: {},
          close: async () => {},
          capture: async (tuple) => ({
            version: "Electron injected",
            result: await appBrowser.capture({
              ...tuple,
              state: {
                ...(configuration.flow.states[0] as NonNullable<
                  (typeof configuration.flow.states)[0]
                >),
                id: tuple.state.id,
                design: tuple.state.design,
              },
              navigationUrl: source.url,
            }),
          }),
        }),
      },
    });
    expect(referenceLaunches).toBe(1);
    expect(result.counts).toEqual({ passed: 1, failed: 0, total: 1 });
    const loaded = await loadCaptureRun({
      runDirectory: result.runDirectory,
      expectedFlow: flow.id,
    });
    expect(loaded.tuples).toHaveLength(1);
    const tuple = loaded.tuples[0];
    expect(tuple?.platform?.browserVersion).toBe("Electron injected");
    expect(tuple?.design?.unavailable).toBeUndefined();
    expect(tuple?.design?.descriptor.runtimeVersion).toMatch(/^\d/);
    expect(tuple?.design?.descriptor.coordinate).toMatchObject({
      state: "home",
      viewport: "mobile",
      width: 390,
      height: 844,
      colorScheme: "dark",
    });
    const noDesign = flowSchema.parse({
      ...flow,
      states: [{ id: "home", description: "Home", expect: {} }],
    });
    await runCapture({
      projectDirectory: directory,
      project: configuration.project,
      flow: noDesign,
      out: join(directory, "undeclared"),
      scope: { viewports: "mobile", schemes: "light" },
      dependencies: {
        inheritedEnvironment: {},
        snapshotSource: async () => ({ commit: "test", dirty: false }),
        browserLauncher: async () => {
          throw new Error("No reference runtime may launch");
        },
        electronLauncher: async () => ({
          effectiveEnvironment: {},
          close: async () => {},
          capture: async (tuple) => ({
            version: "Electron injected",
            result: await appBrowser.capture({
              ...tuple,
              state: configuration.flow.states[0] as NonNullable<
                (typeof configuration.flow.states)[0]
              >,
              navigationUrl: source.url,
            }),
          }),
        }),
      },
    });
  } finally {
    await appBrowser.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("page review propagates --design into paired full views even for an identical page", async () => {
  const { runPageReview } = await import("../src/review/page.js");
  const directory = await mkdtemp(join(tmpdir(), "idiom-page-design-"));
  const source = await resolveDesignSource(fixture, directory);
  try {
    const result = await runPageReview({
      url: source.url,
      design: fixture,
      cwd: directory,
      deterministicOnly: true,
    });
    expect(result.counts).toEqual({ passed: 2, failed: 0, total: 2 });
    const findings = JSON.parse(
      await readFile(result.findingsPath, "utf8"),
    ) as { category: string }[];
    expect(
      [...findings, ...result.deferredFindings].filter(
        (f) => f.category === "design-drift",
      ),
    ).toEqual([]);
    const html = await readFile(result.htmlReportPath, "utf8");
    expect(html.match(/<figcaption>Design<\/figcaption>/g)).toHaveLength(2);
    expect(html).toContain("data:image/png;base64,");
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("design references accept a site object and local images, never remote images", () => {
  expect(
    designLocationSchema.parse({ site: " https://example.test/pricing " }),
  ).toEqual({ site: "https://example.test/pricing" });
  for (const site of [
    "https://user:secret@example.test/",
    "ftp://example.test/",
    "example.test",
  ])
    expect(designLocationSchema.safeParse({ site }).success).toBe(false);
  expect(
    designLocationSchema.safeParse({ site: "https://example.test", x: 1 })
      .success,
  ).toBe(false);
  for (const path of ["design.png", "exports/Frame 1.JPG", "a.jpeg", "a.webp"])
    expect(designLocationSchema.safeParse(path).success).toBe(true);
  expect(imageDesignExtension("exports/Frame 1.JPG")).toBe("jpg");
  expect(imageDesignExtension("design.html")).toBeUndefined();
  expect(imageDesignExtension("https://example.test/a.png")).toBeUndefined();
  const remote = designLocationSchema.safeParse("https://example.test/a.png");
  expect(remote.success).toBe(false);
  expect(JSON.stringify(remote.error?.issues)).toContain(
    "download the image and reference the file",
  );
  expect(designSourceLabel({ site: "https://example.test/" })).toBe(
    "https://example.test/",
  );
  expect(
    designDeclarationSchema.safeParse([
      { site: "https://example.test/", name: "production", viewport: "mobile" },
      "design.png",
    ]).success,
  ).toBe(true);
  expect(
    designDeclarationSchema.safeParse({
      site: "https://example.test/",
      source: "design.png",
    }).success,
  ).toBe(false);
});

test("descriptors require the artifacts their reference kind produces", () => {
  const base = {
    version: 1,
    source: "design.html",
    coordinate: {
      state: "home",
      viewport: "desktop",
      width: 500,
      height: 700,
      colorScheme: "light",
    },
    runtimeVersion: "test",
    status: "captured",
  };
  const html = {
    observations: "d/observations.json",
    screenshot: "d/screenshot.png",
    dom: "d/dom.html",
    console: "d/console.jsonl",
    axe: "d/axe.json",
    source: "d/source.json",
    matches: "d/matches.json",
  };
  expect(
    designDescriptorSchema.safeParse({ ...base, artifacts: html }).success,
  ).toBe(true);
  const { matches: _, ...partial } = html;
  expect(
    designDescriptorSchema.safeParse({ ...base, artifacts: partial }).success,
  ).toBe(false);
  const resolved = {
    kind: "image",
    requested: "design.png",
    final: "/abs/design.png",
    mediaType: "image/png",
    sha256: "a".repeat(64),
  };
  const image = {
    screenshot: "d/screenshot.png",
    console: "d/console.jsonl",
    source: "d/source.json",
    image: "d/reference.png",
    regions: "d/regions.json",
  };
  expect(
    designDescriptorSchema.safeParse({ ...base, resolved, artifacts: image })
      .success,
  ).toBe(true);
  expect(
    designDescriptorSchema.safeParse({
      ...base,
      resolved,
      artifacts: { ...image, matches: "d/matches.json" },
    }).success,
  ).toBe(false);
  expect(
    designDescriptorSchema.safeParse({
      ...base,
      resolved: { ...resolved, sha256: undefined },
      artifacts: image,
    }).success,
  ).toBe(false);
});

test("image sources are sniffed by content and served through a two-path wrapper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-design-image-src-"));
  try {
    const png = new PNG({ width: 4, height: 4 });
    png.data.fill(255);
    const bytes = PNG.sync.write(png);
    await writeFile(join(directory, "design.png"), bytes);
    // JPEG bytes under a .png name, and a GIF.
    await writeFile(
      join(directory, "fake.png"),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
    );
    await writeFile(
      join(directory, "anim.webp"),
      Buffer.from("GIF89a\x01\x00\x01\x00"),
    );
    await expect(resolveDesignSource("fake.png", directory)).rejects.toThrow(
      /does not contain image\/png data \(it holds image\/jpeg\)/,
    );
    await expect(resolveDesignSource("anim.webp", directory)).rejects.toThrow(
      /is a GIF/,
    );
    await expect(
      resolveDesignSource(
        "https://www.figma.com/design/abc/Frame?node-id=1-2",
        directory,
      ),
    ).rejects.toThrow(/pinned frame cache/);
    const source = await resolveDesignSource("design.png", directory);
    try {
      expect(source.provenance).toMatchObject({
        kind: "image",
        requested: "design.png",
        final: join(directory, "design.png"),
        mediaType: "image/png",
      });
      expect(source.image?.bytes.equals(bytes)).toBe(true);
      const origin = new URL(source.url).origin;
      const wrapper = await fetch(`${origin}/`);
      expect(wrapper.headers.get("content-type")).toMatch(/text\/html/);
      expect(await wrapper.text()).toContain('src="/image"');
      const image = await fetch(`${origin}/image`);
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await image.arrayBuffer()).equals(bytes)).toBe(true);
      for (const path of ["/design.png", "/image/x", "/../design.png"])
        expect((await fetch(`${origin}${path}`)).status).toBe(404);
    } finally {
      await source.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("quick classifies --design values", () => {
  expect(quickDesignReference("exports/home.png", "/work")).toBe(
    "/work/exports/home.png",
  );
  expect(quickDesignReference("design/", "/work")).toBe("/work/design");
  expect(
    quickDesignReference("https://www.figma.com/design/abc/x?node-id=1", "/w"),
  ).toBe("https://www.figma.com/design/abc/x?node-id=1");
  expect(
    quickDesignReference("https://claude.ai/public/artifacts/abc", "/w"),
  ).toBe("https://claude.ai/public/artifacts/abc");
  expect(quickDesignReference("https://example.com/pricing", "/w")).toEqual({
    site: "https://example.com/pricing",
  });
});
