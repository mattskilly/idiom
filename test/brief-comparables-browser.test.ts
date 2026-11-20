import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { runComparableResearch } from "../src/brief/comparable-research.js";
import { captureReferenceUrl } from "../src/capture/browser.js";
import { loadReferenceContext } from "../src/critique/context.js";
import { projectSchema } from "../src/schemas/project.js";

const fixtures = new URL("./fixtures/brief-comparables/", import.meta.url);
const requests: { method: string; url: string }[] = [];
let server: Server;
let origin: string;
const directories: string[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "" });
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (path === "/private") {
      response.statusCode = 401;
      response.end("sign in first");
      return;
    }
    const name = path.slice(1);
    if (!/^[a-z]+\.html$/.test(name)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    try {
      const html = await readFile(new URL(name, fixtures), "utf8");
      response.setHeader("Content-Type", "text/html");
      response.end(html);
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

function project(references: unknown[]) {
  return projectSchema.parse({
    version: 1,
    app: { name: "comparables", framework: "other" },
    server: {
      build: "true",
      start: "true",
      readyUrl: "http://127.0.0.1:3000/",
      port: 3000,
      env: {},
    },
    viewports: [{ name: "desktop", width: 1280, height: 800 }],
    capture: { settleMs: 0 },
    design: {},
    brief: { references },
    model: { provider: "anthropic", model: "unused" },
  });
}

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-comparables-browser-"));
  directories.push(directory);
  return directory;
}

test("fixture request: captures two comparables, measures chip and toolbar, proposes a minimum gap and a maximum width", {
  timeout: 60_000,
}, async () => {
  const directory = await temporary();
  requests.length = 0;
  const result = await runComparableResearch({
    projectDirectory: directory,
    project: project([
      {
        name: "Alpha",
        tier: "bar",
        note: "a calm document editor",
        pages: [{ surface: "selection toolbar", url: `${origin}/alpha.html` }],
      },
      {
        name: "Beta",
        tier: "bar",
        note: "a whiteboard",
        pages: [{ surface: "selection toolbar", url: `${origin}/beta.html` }],
      },
      {
        name: "Gamma",
        tier: "bar",
        note: "an editor behind a sign-in",
        pages: [{ surface: "selection toolbar", url: `${origin}/signin.html` }],
      },
    ]),
    cwd: directory,
    request: "selection toolbar offset chip",
  });

  expect(result.comparables.map((c) => [c.name, c.status])).toEqual([
    ["Alpha", "captured"],
    ["Beta", "captured"],
    ["Gamma", "not-reachable"],
  ]);
  expect(result.comparables[2]?.notReachable).toBe(
    "sign-in required; not logged into",
  );
  const value = (name: string, subject: string, property: string) =>
    result.comparables
      .find((c) => c.name === name)
      ?.measurements.find(
        (m) => m.subject === subject && m.property === property,
      );
  expect(
    value("Alpha", "offset chip to selection toolbar", "gap"),
  ).toMatchObject({
    value: 8,
    selector: "span.offset-chip → div.selection-toolbar",
    url: `${origin}/alpha.html`,
    viewport: "desktop",
  });
  expect(value("Beta", "offset chip to selection toolbar", "gap")?.value).toBe(
    12,
  );
  expect(value("Alpha", "selection toolbar", "width")?.value).toBe(320);
  expect(value("Beta", "selection toolbar", "width")?.value).toBe(360);
  expect(value("Alpha", "selection toolbar", "duration")?.value).toBe(150);

  const texts = result.criteria.map((criterion) => criterion.text);
  expect(texts[0]).toBe(
    "Offset chip to selection toolbar gap is at least 8px and at most 12px (Alpha 8px, reference:alpha-selection-toolbar; Beta 12px, reference:beta-selection-toolbar).",
  );
  expect(texts).toContain(
    "Selection toolbar width is at least 320px and at most 360px (Alpha 320px, reference:alpha-selection-toolbar; Beta 360px, reference:beta-selection-toolbar).",
  );

  // Stored as ordinary managed references the reviewer reads; Gamma is not.
  expect(
    (await readdir(join(directory, ".idiom", "references"))).sort(),
  ).toEqual(["alpha-selection-toolbar", "beta-selection-toolbar"]);
  const context = await loadReferenceContext(directory);
  expect(context.map((entry) => entry.label)).toEqual([
    "reference:alpha-selection-toolbar",
    "reference:beta-selection-toolbar",
  ]);
  expect(context[0]).toMatchObject({ kind: "image" });
  expect(JSON.stringify(context[0])).toContain(
    "offset chip to selection toolbar gap 8px",
  );

  // Only the listed pages were fetched, and nothing was submitted.
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(
    new Set(
      requests
        .map((request) => request.url)
        .filter((url) => url !== "/favicon.ico"),
    ),
  ).toEqual(new Set(["/alpha.html", "/beta.html", "/signin.html"]));
});

test("an HTTP 401 page is reported as needing sign-in and is not stored", {
  timeout: 60_000,
}, async () => {
  const directory = await temporary();
  const result = await runComparableResearch({
    projectDirectory: directory,
    project: project([
      {
        name: "Delta",
        tier: "bar",
        note: "a private toolbar",
        url: `${origin}/private`,
      },
    ]),
    cwd: directory,
    request: "toolbar",
  });
  expect(result.comparables).toMatchObject([
    {
      name: "Delta",
      status: "not-reachable",
      notReachable: "sign-in required; not logged into",
    },
  ]);
  expect(result.warnings[0]).toContain("list at least 2");
  expect(await loadReferenceContext(directory)).toEqual([]);
});

test("the capture's inspect hook runs before the screenshot, and its error skips it", async () => {
  const viewport = { name: "desktop", width: 1280, height: 800 };
  const order: string[] = [];
  const screenshot = vi.fn(async () => {
    order.push("screenshot");
    return Buffer.from("png");
  });
  const send = vi.fn(async () => ({}));
  const page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    waitForTimeout: vi.fn(async () => undefined),
    screenshot,
    close: vi.fn(async () => undefined),
    once: vi.fn(),
    isClosed: () => false,
    context: () => ({
      newCDPSession: async () => ({
        send,
        detach: vi.fn(async () => undefined),
      }),
    }),
  };
  const browser = {
    newContext: vi.fn(async () => ({
      newPage: async () => page as unknown as Page,
      close: vi.fn(async () => undefined),
    })),
    close: vi.fn(async () => undefined),
  };
  const options = {
    url: "https://example.test/reference",
    project: project([]),
    viewport,
    launch: async () => browser as unknown as Browser,
  };
  await expect(
    captureReferenceUrl({
      ...options,
      inspect: async () => {
        order.push("inspect");
      },
    }),
  ).resolves.toEqual(Buffer.from("png"));
  expect(order).toEqual(["inspect", "screenshot"]);

  screenshot.mockClear();
  await expect(
    captureReferenceUrl({
      ...options,
      inspect: async () => {
        throw new Error("sign-in wall");
      },
    }),
  ).rejects.toThrow("sign-in wall");
  expect(screenshot).not.toHaveBeenCalled();
  expect(page.close).toHaveBeenCalled();
});
