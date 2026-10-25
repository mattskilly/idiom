import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import {
  discoverFlowRoutes,
  type Inspection,
  type LiveInspector,
  normalizePage,
} from "../src/flows/discover.js";
import { constructSiteFlow } from "../src/flows/generate.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const directories: string[] = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-flows-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const origin = "http://127.0.0.1:3000";
const project = projectSchema.parse({
  version: 1,
  app: { name: "fixture", framework: "other" },
  server: {
    build: "node -e 0",
    start: "node server.mjs",
    readyUrl: origin,
    port: 3000,
    env: {},
  },
  viewports: [
    { name: "wide", width: 900, height: 700 },
    { name: "small", width: 400, height: 600 },
  ],
  capture: { colorScheme: "dark" },
  design: {},
  model: { provider: "anthropic", model: "unused" },
});
function result(path: string, changes: Partial<Inspection> = {}): Inspection {
  return {
    finalUrl: origin + path,
    status: 200,
    html: true,
    password: false,
    links: [],
    base: origin + path,
    ...changes,
  };
}
function inspector(
  pages: Record<string, Inspection>,
  sitemap: string[] = [],
): LiveInspector {
  return {
    inspect: vi.fn(
      async (url) =>
        pages[new URL(url).pathname] ?? result(new URL(url).pathname),
    ),
    sitemap: vi.fn(async () => ({ kind: "urlset" as const, urls: sitemap })),
    close: vi.fn(async () => {}),
  };
}
async function discover(
  live: LiveInspector,
  entries: Array<{ route: string; source: string }> = [],
  exclude: string[] = [],
) {
  return discoverFlowRoutes({
    directory: ".",
    entries,
    readyUrl: origin,
    exclude,
    open: async () => live,
  });
}

test("live route identity rejects assets, fragments, credentials, external URLs and preserves encoded slashes", () => {
  for (const href of [
    "#hash",
    "mailto:a@b.test",
    "javascript:void(0)",
    "https://example.com/a",
    "http://user@127.0.0.1:3000/a",
    "/a.png",
    "/p/[id]",
  ])
    expect(normalizePage(href, origin, origin)).toBeUndefined();
  expect(
    normalizePage("../p/a%2Fb/?q=1#x", `${origin}/section/sub/`, origin),
  ).toBe("/section/p/a%2Fb");
});

test("merges filesystem sources after exclusions and resolves observed dynamic examples deterministically", async () => {
  const live = inspector({
    "/": result("/", {
      links: [
        "/p/z",
        "/p/new",
        "/p/a",
        "/docs/x/y",
        "/optional",
        "/a/b",
        "/a-b",
      ],
    }),
  });
  const entries = [
    { route: "/p/[id]", source: "app/p/[id]/page.tsx" },
    { route: "/p/new", source: "pages/p/new.tsx" },
    { route: "/docs/[...parts]", source: "app/docs/[...parts]/page.tsx" },
    {
      route: "/optional/[[...parts]]",
      source: "app/optional/[[...parts]]/page.tsx",
    },
    { route: "/unknown/[id]", source: "app/unknown/[id]/page.tsx" },
    { route: "/", source: "apps/a/app/page.tsx" },
    { route: "/", source: "apps/b/pages/index.tsx" },
    { route: "/", source: "src/app/page.tsx" },
  ];
  const found = await discover(live, entries, ["apps/a/**"]);
  expect(found.routes.find((r) => r.route === "/")?.sources).toContain(
    "apps/b/pages/index.tsx",
  );
  expect(found.routes.find((r) => r.route === "/")?.sources).not.toContain(
    "apps/a/app/page.tsx",
  );
  expect(found.routes.find((r) => r.route === "/p/[id]")?.path).toBe("/p/a");
  expect(found.routes.find((r) => r.route === "/docs/[...parts]")?.path).toBe(
    "/docs/x/y",
  );
  expect(
    found.routes.find((r) => r.route === "/optional/[[...parts]]")?.path,
  ).toBe("/optional");
  expect(
    found.routes.find((r) => r.route === "/unknown/[id]")?.path,
  ).toBeUndefined();
  expect(found.routes.some((r) => r.route === "/p/z")).toBe(false);
  const generated = constructSiteFlow(project, found);
  const raw = JSON.parse(generated.content ?? "");
  expect(raw.viewports).toEqual(["wide", "small"]);
  expect(raw.colorSchemes).toEqual(["dark"]);
  expect(raw.kind).toBeUndefined();
  expect(raw.states.find((r: { url: string }) => r.url === "/p/a").id).toBe(
    "route-p-id",
  );
  const ids = raw.states.map((r: { id: string }) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.filter((id: string) => id.startsWith("route-a-b-"))).toHaveLength(
    2,
  );
  expect(generated.todos.join(" ")).toContain("/unknown/[id]");
  expect(flowSchema.parse(raw).states).toHaveLength(raw.states.length);
});

test("filesystem route roots include groups, src routers and pages index while skipping private/API/slots", async () => {
  const directory = await temporary();
  const files = [
    "app/(group)/page.tsx",
    "app/_private/page.tsx",
    "app/@slot/page.tsx",
    "app/(.)photo/page.tsx",
    "src/app/blog/[id]/page.tsx",
    "pages/info/index.tsx",
    "src/pages/contact.tsx",
    "src/pages/api/no.ts",
    "pages/_app.tsx",
  ];
  for (const file of files) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(join(directory, file), "");
  }
  const found = await discoverFlowRoutes({
    directory,
    readyUrl: origin,
    exclude: [],
    open: async () => {
      throw new Error("offline");
    },
  });
  expect(found.routes.map((r) => r.route)).toEqual([
    "/",
    "/blog/[id]",
    "/contact",
    "/info",
  ]);
  expect(found.warnings.join(" ")).toContain("offline");
  expect(found.routes.find((r) => r.route === "/blog/[id]")?.reason).toContain(
    "no successfully inspected",
  );
});

test("crawl admits and attempts at most 30 paths while sitemap and static routes remain independent", async () => {
  const live = inspector(
    {
      "/": result("/", {
        links: Array.from(
          { length: 100 },
          (_, i) => `/p${String(i).padStart(3, "0")}`,
        ),
      }),
    },
    [`${origin}/sitemap-only`],
  );
  const found = await discover(live, [
    { route: "/unlinked", source: "app/unlinked/page.tsx" },
  ]);
  expect(live.inspect).toHaveBeenCalledTimes(32);
  expect(found.routes).toHaveLength(32);
  expect(found.routes.some((r) => r.route === "/p029")).toBe(false);
  expect(found.warnings.join(" ")).toContain("30 admitted");
  expect(live.close).toHaveBeenCalledOnce();
});

test("auth redirects preserve requested paths, public redirects retain actual pathname, failed dynamic examples remain TODO", async () => {
  const live = inspector({
    "/": result("/", {
      links: [
        "/private",
        "/client",
        "/external",
        "/login",
        "/canonical",
        "/p/bad",
        "/other",
      ],
    }),
    "/private": result("/login", { password: true }),
    "/client": result("/sign-in"),
    "/external": result("/", { finalUrl: "https://auth.example/signin" }),
    "/canonical": result("/canonical/"),
    "/p/bad": result("/p/bad", { status: 404 }),
    "/other": result("/", { finalUrl: "https://example.com/other" }),
  });
  const found = await discover(live, [
    { route: "/p/[id]", source: "app/p/[id]/page.tsx" },
  ]);
  const generated = constructSiteFlow(project, found);
  const raw = JSON.parse(generated.content ?? "");
  expect(generated.setup).toHaveLength(3);
  expect(raw.setup).toEqual([]);
  expect(
    raw.states.find((s: { url: string }) => s.url === "/private"),
  ).toMatchObject({
    expect: { path: "/private" },
    description: expect.stringContaining("requires setup"),
  });
  expect(
    raw.states.find((s: { url: string }) => s.url === "/login").description,
  ).not.toContain("requires setup");
  expect(
    raw.states.find((s: { url: string }) => s.url === "/canonical").expect.path,
  ).toBe("/canonical/");
  expect(raw.states.some((s: { url: string }) => s.url.includes("[id]"))).toBe(
    false,
  );
  expect(generated.todos.join(" ")).toContain("off-origin");
});

test("overall deadline closes the inspector and preserves static routes", async () => {
  const live = inspector({});
  live.sitemap = async () => new Promise(() => {});
  const found = await discoverFlowRoutes({
    directory: ".",
    entries: [{ route: "/known", source: "pages/known.tsx" }],
    readyUrl: origin,
    exclude: [],
    open: async () => live,
    limits: { totalMs: 15 },
  });
  expect(found.routes[0]?.path).toBe("/known");
  expect(found.routes[0]?.reason).toContain("unavailable");
  expect(found.warnings.join(" ")).toContain("overall time limit");
  expect(live.close).toHaveBeenCalledOnce();
});

test("unavailable origin stops repeated probes and does not invent a root route", async () => {
  const live = inspector({
    "/": result("/", { unavailable: true, error: "connection refused" }),
  });
  const found = await discover(live, [
    { route: "/offline", source: "pages/offline.tsx" },
  ]);
  expect(live.inspect).toHaveBeenCalledOnce();
  expect(found.routes.map((r) => r.route)).toEqual(["/offline"]);
  expect(found.warnings.join(" ")).toContain("unavailable");
});

test("surface selection validates legacy, single and multi-surface projects", () => {
  const discovery = {
    routes: [{ route: "/", path: "/", sources: ["app/page.tsx"] }],
    warnings: [],
  };
  expect(
    JSON.parse(constructSiteFlow(project, discovery).content ?? "").surface,
  ).toBeUndefined();
  const one = { ...project, surfaces: [{ id: "web", name: "Website" }] };
  expect(
    JSON.parse(constructSiteFlow(one, discovery).content ?? "").surface,
  ).toBe("web");
  const multiple = {
    ...one,
    surfaces: [...one.surfaces, { id: "admin", name: "Admin" }],
  };
  expect(() => constructSiteFlow(multiple, discovery)).toThrow("--surface");
  expect(() => constructSiteFlow(multiple, discovery, "nope")).toThrow(
    "web, admin",
  );
  expect(
    JSON.parse(constructSiteFlow(multiple, discovery, "admin").content ?? "")
      .surface,
  ).toBe("admin");
});

test("init offers flow generation, uses on-disk config and preserves authored flows on reruns", async () => {
  const directory = await temporary();
  const generate = vi.fn(
    async ({ project: configured }: { project: typeof project }) =>
      constructSiteFlow(configured, {
        routes: [{ route: "/", path: "/", sources: ["app/page.tsx"] }],
        warnings: [],
      }),
  );
  await initProject({ project: directory, yes: true, generateFlows: generate });
  expect(generate).not.toHaveBeenCalled();
  const configPath = join(directory, ".idiom/project.json");
  await writeFile(configPath, JSON.stringify(project));
  await initProject({
    project: directory,
    confirm: async (r) => r.kind === "offer-flow-generation",
    generateFlows: generate,
  });
  expect(generate).toHaveBeenCalledWith(
    expect.objectContaining({
      project: expect.objectContaining({ viewports: project.viewports }),
    }),
  );
  const file = join(directory, ".idiom/flows/site.json");
  const initial = await readFile(file, "utf8");
  const repeat = await initProject({
    project: directory,
    yes: true,
    flows: true,
    generateFlows: generate,
  });
  expect(repeat.unchanged).toContain(".idiom/flows/site.json");
  await writeFile(file, "authored");
  await writeFile(join(directory, ".idiom/flows/other.json"), "other authored");
  expect(
    (
      await initProject({
        project: directory,
        yes: true,
        flows: true,
        generateFlows: generate,
      })
    ).skipped,
  ).toContain(".idiom/flows/site.json");
  expect(await readFile(file, "utf8")).toBe("authored");
  await initProject({
    project: directory,
    flows: true,
    confirm: async (r) => r.path === ".idiom/flows/site.json",
    generateFlows: generate,
  });
  expect(await readFile(file, "utf8")).toBe(initial);
  expect(
    await readFile(join(directory, ".idiom/flows/other.json"), "utf8"),
  ).toBe("other authored");
});

test("init refuses symlink and directory destinations and detects edits during replacement confirmation", async () => {
  const directory = await temporary();
  await initProject({ project: directory, yes: true });
  const generate = async () =>
    constructSiteFlow(project, {
      routes: [{ route: "/", path: "/", sources: [] }],
      warnings: [],
    });
  const file = join(directory, ".idiom/flows/site.json");
  const target = join(directory, "sentinel");
  await writeFile(target, "safe");
  await symlink(target, file);
  expect(
    (
      await initProject({
        project: directory,
        yes: true,
        flows: true,
        generateFlows: generate,
      })
    ).flows.kind,
  ).toBe("preserved");
  expect(await readFile(target, "utf8")).toBe("safe");
  await rm(file);
  await mkdir(file);
  expect(
    (
      await initProject({
        project: directory,
        yes: true,
        flows: true,
        generateFlows: generate,
      })
    ).flows.kind,
  ).toBe("preserved");
  await rm(file, { recursive: true });
  await writeFile(file, "old");
  await expect(
    initProject({
      project: directory,
      flows: true,
      generateFlows: generate,
      confirm: async (r) => {
        if (r.path !== ".idiom/flows/site.json") return false;
        await writeFile(file, "concurrent edit");
        return true;
      },
    }),
  ).rejects.toThrow("changed after confirmation");
  expect(await readFile(file, "utf8")).toBe("concurrent edit");
});

test("CLI threads --flows --yes --surface and reports partial routes and next commands", async () => {
  const directory = await temporary();
  const stdout: string[] = [];
  const generate = vi.fn(async () =>
    constructSiteFlow(project, {
      routes: [
        { route: "/", path: "/", sources: [], setup: "/login" },
        { route: "/p/[id]", sources: [], reason: "no example" },
      ],
      warnings: ["Partial discovery: offline"],
    }),
  );
  expect(
    await run(
      [
        "node",
        "idiom",
        "init",
        "--project",
        directory,
        "--flows",
        "--yes",
        "--surface",
        "web",
      ],
      { generateFlows: generate, stdout: (s) => stdout.push(s) },
    ),
  ).toBe(0);
  expect(generate).toHaveBeenCalledWith(
    expect.objectContaining({ surface: "web" }),
  );
  expect(stdout.join(" ")).toContain("1 setup-required");
  expect(stdout.join(" ")).toContain("/p/[id]");
  expect(stdout.join(" ")).toContain("idiom capture site");
  expect(stdout.join(" ")).toContain("offline");
});

test("distinct dynamic templates keep identities even when their observed example coincides", async () => {
  const found = await discover(
    inspector({ "/": result("/", { links: ["/p/new", "/p/a"] }) }),
    [
      { route: "/p/[id]", source: "app/p/[id]/page.tsx" },
      { route: "/p/[slug]", source: "pages/p/[slug].tsx" },
      { route: "/p/new", source: "pages/p/new.tsx" },
    ],
  );
  expect(
    found.routes.filter((r) => r.route.includes("[")).map((r) => r.path),
  ).toEqual(["/p/a", "/p/a"]);
  const raw = JSON.parse(constructSiteFlow(project, found).content ?? "{}");
  expect(
    raw.states
      .filter((s: { url: string }) => s.url === "/p/a")
      .map((s: { id: string }) => s.id),
  ).toEqual(["route-p-id", "route-p-slug"]);
});

test("route exclusions suppress matching live examples without losing independently sourced routes", async () => {
  const found = await discover(
    inspector({ "/": result("/", { links: ["/p/a", "/skip", "/kept"] }) }),
    [
      { route: "/p/[id]", source: "app/p/[id]/page.tsx" },
      { route: "/kept", source: "excluded/pages/kept.tsx" },
    ],
    ["/p/[id]", "/skip", "excluded/**"],
  );
  expect(found.routes.map((r) => r.route)).toEqual(["/", "/kept"]);
});

test("sitemap document cap is independent and missing or malformed documents leave other sources available", async () => {
  const live = inspector({});
  live.sitemap = vi.fn(async (url) => {
    if (url.endsWith("/sitemap.xml"))
      return {
        kind: "sitemapindex" as const,
        urls: Array.from({ length: 20 }, (_, i) => `${origin}/${i}.xml`),
      };
    throw new Error("malformed document");
  });
  const found = await discover(live);
  expect(live.sitemap).toHaveBeenCalledTimes(10);
  expect(found.routes.map((r) => r.route)).toEqual(["/"]);
  expect(found.warnings.join(" ")).toContain("10 documents");
  expect(found.warnings.join(" ")).toContain("malformed document");
});

test("generated bytes do not depend on the live origin port", () => {
  const one = constructSiteFlow(project, {
    routes: [{ route: "/", path: "/", sources: [`${origin}/sitemap.xml`] }],
    warnings: [`Sitemap ${origin}/bad.xml: HTTP 404`],
  });
  const two = constructSiteFlow(
    {
      ...project,
      server: { ...project.server, readyUrl: "http://127.0.0.1:5555" },
    },
    {
      routes: [
        {
          route: "/",
          path: "/",
          sources: ["http://127.0.0.1:5555/sitemap.xml"],
        },
      ],
      warnings: ["Sitemap http://127.0.0.1:5555/bad.xml: HTTP 404"],
    },
  );
  expect(one.content).toBe(two.content);
});

test("init invalid configuration fails before generation; no-routes and TODO-only results are explicit", async () => {
  const directory = await temporary();
  await initProject({ project: directory, yes: true });
  const file = join(directory, ".idiom/project.json");
  const original = await readFile(file, "utf8");
  await writeFile(
    file,
    JSON.stringify({ ...JSON.parse(original), viewports: "invalid" }),
  );
  const generate = vi.fn(async () =>
    constructSiteFlow(project, { routes: [], warnings: ["offline"] }),
  );
  await expect(
    initProject({
      project: directory,
      yes: true,
      flows: true,
      generateFlows: generate,
    }),
  ).rejects.toThrow("viewports");
  expect(generate).not.toHaveBeenCalled();
  await writeFile(file, original);
  expect(
    (
      await initProject({
        project: directory,
        yes: true,
        flows: true,
        generateFlows: generate,
      })
    ).flows.kind,
  ).toBe("no-routes");
  await expect(
    readFile(join(directory, ".idiom/flows/site.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const onlyTodo = constructSiteFlow(project, {
    routes: [{ route: "/p/[id]", sources: [], reason: "no example" }],
    warnings: [],
  });
  expect(flowSchema.parse(JSON.parse(onlyTodo.content ?? "{}")).states).toEqual(
    [],
  );
  expect(onlyTodo.todos.join(" ")).toContain("no example");
});

test("web destination path validates concrete pathname syntax without extending Electron expectations", () => {
  const raw = {
    id: "path",
    title: "Path",
    intent: [],
    setup: [],
    states: [{ id: "path", description: "", url: "/", expect: { path: "/" } }],
  };
  expect(flowSchema.safeParse(raw).success).toBe(true);
  for (const path of ["relative", "/a?query", "/a#hash", "/a b"])
    expect(
      flowSchema.safeParse({
        ...raw,
        states: [{ ...raw.states[0], expect: { path } }],
      }).success,
    ).toBe(false);
  const electron = {
    ...raw,
    target: {
      kind: "electron",
      launch: { executablePath: "electron" },
      window: { title: "Fixture" },
    },
    states: [{ id: "path", description: "", expect: { path: "/" } }],
  };
  expect(flowSchema.safeParse(electron).success).toBe(false);
});

test("more specific dynamic patterns own examples before broader fallbacks", async () => {
  const found = await discover(
    inspector({ "/": result("/", { links: ["/p/a", "/z"] }) }),
    [
      { route: "/[...parts]", source: "app/[...parts]/page.tsx" },
      { route: "/p/[id]", source: "app/p/[id]/page.tsx" },
    ],
  );
  expect(found.routes.find((r) => r.route === "/p/[id]")?.path).toBe("/p/a");
  expect(found.routes.find((r) => r.route === "/[...parts]")?.path).toBe("/z");
});
