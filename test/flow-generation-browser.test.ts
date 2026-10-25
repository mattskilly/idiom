import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { captureCommand } from "../src/commands/capture.js";
import { initProject } from "../src/commands/init.js";
import { validateCommand } from "../src/commands/validate.js";
import { openFlowBrowser } from "../src/flows/browser.js";
import { discoverFlowRoutes } from "../src/flows/discover.js";
import { flowSchema } from "../src/schemas/flow.js";
import { validateProjectConfiguration } from "../src/validation.js";

const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-route-browser-"));
  await cp(
    join(import.meta.dirname, "fixtures/route-flow-generation"),
    directory,
    { recursive: true },
  );
  await initProject({ project: directory, yes: true });
  const port = await freePort();
  const file = join(directory, ".idiom/project.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  raw.server = {
    build: "node -e 0",
    start: "node server.mjs",
    readyUrl: `http://127.0.0.1:${port}/`,
    port,
    env: {},
    startupTimeoutMs: 5000,
  };
  raw.viewports = [
    { name: "wide", width: 800, height: 600 },
    { name: "small", width: 390, height: 600 },
  ];
  raw.colorSchemes = ["light", "dark"];
  raw.capture.settleMs = 80;
  await writeFile(file, JSON.stringify(raw));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: directory,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  });
  return {
    directory,
    port,
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("real XML parsing, recursive rendered links, redirects and bounded traversal", async () => {
  const f = await fixture();
  try {
    const { project } = await validateProjectConfiguration({
      project: f.directory,
    });
    const live = await openFlowBrowser(project);
    try {
      expect((await live.sitemap(`${f.origin}/child.xml`)).urls).toEqual([
        `${f.origin}/sitemap-only?a=1&b=2`,
        "https://example.com/external",
      ]);
      await expect(live.sitemap(`${f.origin}/bad.xml`)).rejects.toThrow(
        "malformed",
      );
      await expect(live.sitemap(`${f.origin}/large.xml`)).rejects.toThrow(
        "1 MiB",
      );
      await expect(live.sitemap(`${f.origin}/foreign.xml`)).rejects.toThrow(
        "off-origin",
      );
      expect(await live.inspect(`${f.origin}/http-private`)).toMatchObject({
        finalUrl: `${f.origin}/login`,
        password: true,
      });
      expect(await live.inspect(`${f.origin}/client-private`)).toMatchObject({
        finalUrl: `${f.origin}/sign-in`,
        password: true,
      });
      await live.inspect(`${f.origin}/set-cookie`);
      expect((await live.inspect(`${f.origin}/cookie-check`)).password).toBe(
        false,
      );
      expect(await live.inspect(`${f.origin}/error`)).toMatchObject({
        status: 500,
      });
      expect(await live.inspect(`${f.origin}/text.txt`)).toMatchObject({
        html: false,
      });
    } finally {
      await live.close();
    }
    const discovered = await discoverFlowRoutes({
      directory: f.directory,
      readyUrl: `${f.origin}/many`,
      exclude: [],
      open: () => openFlowBrowser(project),
    });
    expect(discovered.routes).toHaveLength(31); // 30 crawl paths plus independent sitemap page.
    expect(discovered.warnings.join(" ")).toContain("30 admitted");
  } finally {
    await f.close();
  }
}, 30_000);

test("generated flows validate and capture the viewport/scheme grid; setup restores protected content on a fresh port", async () => {
  const f = await fixture();
  try {
    for (const file of [
      "app/page.tsx",
      "src/app/section/item/[id]/page.tsx",
      "pages/unlinked.tsx",
      "src/pages/missing/[id].tsx",
    ]) {
      await mkdir(join(f.directory, file, ".."), { recursive: true });
      await writeFile(join(f.directory, file), "");
    }
    const result = await initProject({
      project: f.directory,
      yes: true,
      flows: true,
    });
    expect(result.flows.kind).toBe("generated");
    const file = join(f.directory, ".idiom/flows/site.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.states.map((s: { url: string }) => s.url)).toEqual(
      expect.arrayContaining([
        "/section/item/observed",
        "/sitemap-only",
        "/unlinked",
      ]),
    );
    expect(raw.states.map((s: { url: string }) => s.url)).not.toContain(
      "/extension-only",
    );
    expect(raw.intent.join(" ")).toContain("/missing/[id]");
    expect(raw.intent.join(" ")).toContain("requires setup");
    expect(
      raw.states.find((s: { url: string }) => s.url === "/http-private"),
    ).toMatchObject({ expect: { path: "/http-private" } });
    expect(
      await validateCommand({ project: f.directory, flow: "site" }),
    ).toContain("site");
    await exec("git", ["init", "-q"], { cwd: f.directory });
    await exec("git", ["add", "."], { cwd: f.directory });
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "Fixture",
      ],
      { cwd: f.directory },
    );
    const capture = await captureCommand({
      project: f.directory,
      flow: "site",
    });
    expect(capture.counts.total).toBe(raw.states.length * 4);
    expect(capture.counts.failed).toBe(8);
    for (const state of raw.states)
      for (const viewport of ["wide", "small"])
        for (const scheme of ["light", "dark"]) {
          const directory = join(
            capture.runDirectory,
            state.id,
            viewport,
            scheme,
          );
          const metadata = JSON.parse(
            await readFile(join(directory, "metadata.json"), "utf8"),
          );
          expect(metadata.url.origin).not.toBe(f.origin);
          if (state.url.includes("private")) {
            expect(metadata.failure.stage).toBe("expectation");
            await expect(
              readFile(join(directory, "dom.html")),
            ).rejects.toMatchObject({ code: "ENOENT" });
            await expect(
              readFile(join(directory, "screenshot.png")),
            ).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            const expected =
              state.url === "/canonical" ? "/canonical/" : state.url;
            expect(
              await readFile(join(directory, "dom.html"), "utf8"),
            ).toContain(`Page ${expected}`);
          }
        }
    raw.setup = [{ run: "node setup.mjs" }];
    await writeFile(file, JSON.stringify(raw));
    const authenticated = await captureCommand({
      project: f.directory,
      flow: "site",
    });
    expect(authenticated.counts).toEqual({
      total: raw.states.length * 4,
      passed: raw.states.length * 4,
      failed: 0,
    });
    for (const state of raw.states.filter((s: { url: string }) =>
      s.url.includes("private"),
    )) {
      const dom = await readFile(
        join(authenticated.runDirectory, state.id, "wide/light/dom.html"),
        "utf8",
      );
      const expectedPath =
        state.url === "/http-private" ? "/http-private/" : state.url;
      expect(dom).toContain(`<h1>Page ${expectedPath}</h1>`);
      expect(dom).not.toContain("Page /login");
      expect(dom).not.toContain("Page /sign-in");
    }
  } finally {
    await f.close();
  }
}, 120_000);

test("destination guard checks HTTP, client, off-origin and evidence-time navigation and leaves legacy captures compatible", async () => {
  const f = await fixture();
  const external = createHttpServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<html><body>Foreign</body></html>");
  });
  await new Promise<void>((resolve) =>
    external.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = external.address();
    if (!address || typeof address === "string") throw new Error("address");
    const { project } = await validateProjectConfiguration({
      project: f.directory,
    });
    const viewport = project.viewports[0];
    if (viewport === undefined) throw new Error("missing viewport");
    const browser = await chromium.launch({ headless: true });
    const session = await createBrowserLauncher({
      launch: async () => browser,
      createAxe: (page) => ({
        analyze: async () => {
          if (page.url().endsWith("/during"))
            await page.goto(`${f.origin}/login`);
          return {};
        },
      }),
    })();
    try {
      const stateFor = (path: string, expected?: string) => {
        const parsed = flowSchema.parse({
          id: "guard",
          title: "Guard",
          intent: [],
          setup: [],
          states: [
            {
              id: "guard",
              description: "",
              url: path,
              expect: { ...(expected ? { path: expected } : {}) },
            },
          ],
        }).states[0];
        if (parsed === undefined) throw new Error("missing state");
        return parsed;
      };
      for (const path of ["/http-private", "/client-private", "/during"]) {
        const captured = await session.capture({
          project,
          viewport,
          state: stateFor(path, path),
          navigationUrl: f.origin + path,
        });
        expect(captured).toMatchObject({
          ok: false,
          stage: "expectation",
          dom: undefined,
          screenshot: undefined,
          axe: undefined,
          observations: undefined,
        });
      }
      for (const [path, expected] of [
        ["/canonical", "/canonical"],
        ["/unlinked", "/unlinked/"],
      ] as const) {
        const captured = await session.capture({
          project,
          viewport,
          state: stateFor(path, expected),
          navigationUrl: f.origin + path,
        });
        expect(captured.ok).toBe(true);
      }
      expect(
        await session.capture({
          project,
          viewport,
          state: stateFor("/unlinked/child", "/unlinked"),
          navigationUrl: `${f.origin}/unlinked/child`,
        }),
      ).toMatchObject({ ok: false, stage: "expectation" });
      // Inject a real server redirect to another origin with an identical pathname.
      const redirect = createHttpServer((_req, res) => {
        res.writeHead(302, {
          location: `http://127.0.0.1:${address.port}/same`,
        });
        res.end();
      });
      await new Promise<void>((resolve) =>
        redirect.listen(0, "127.0.0.1", resolve),
      );
      try {
        const local = redirect.address();
        if (!local || typeof local === "string") throw new Error("address");
        const captured = await session.capture({
          project,
          viewport,
          state: stateFor("/same", "/same/"),
          navigationUrl: `http://127.0.0.1:${local.port}/same`,
        });
        expect(captured).toMatchObject({ ok: false, stage: "expectation" });
      } finally {
        await new Promise<void>((resolve) => redirect.close(() => resolve()));
      }
      expect(
        (
          await session.capture({
            project,
            viewport,
            state: stateFor("/http-private"),
            navigationUrl: `${f.origin}/http-private`,
          })
        ).ok,
      ).toBe(true);
    } finally {
      await session.close();
    }
  } finally {
    await new Promise<void>((resolve) => external.close(() => resolve()));
    await f.close();
  }
}, 30_000);

test("short navigation timeout is specific and an overall deadline closes the real browser", async () => {
  const f = await fixture();
  try {
    const { project } = await validateProjectConfiguration({
      project: f.directory,
    });
    const live = await openFlowBrowser(project, { timeoutMs: 30 });
    try {
      expect((await live.inspect(`${f.origin}/slow`)).error).toContain(
        "Timeout",
      );
    } finally {
      await live.close();
    }
    const browser = await chromium.launch({ headless: true });
    const discovery = await discoverFlowRoutes({
      directory: f.directory,
      readyUrl: `${f.origin}/slow`,
      exclude: [],
      limits: { totalMs: 80 },
      open: () => openFlowBrowser(project, { launch: async () => browser }),
    });
    expect(discovery.warnings.join(" ")).toContain("overall time limit");
    expect(browser.isConnected()).toBe(false);
  } finally {
    await f.close();
  }
}, 15_000);
