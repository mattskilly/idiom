import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { coverageCommand, renderCoverage } from "../src/commands/coverage.js";
import { initProject } from "../src/commands/init.js";
import {
  appRouteFromSegments,
  coverageGlob,
  crawlRoutes,
  discoverRoutes,
  routeCoverage,
} from "../src/coverage/routes.js";
import {
  buildReviewCoverage,
  buildVerificationCoverage,
  renderCoverageHtml,
  renderCoverageMarkdown,
} from "../src/report/coverage.js";
import { flowSchema, routeStateId } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function touch(root: string, path: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(
    join(root, path),
    "export default function Page() { return null; }\n",
  );
}

test("app router segments drop groups and skip slots, intercepts and private folders", () => {
  expect(appRouteFromSegments([])).toBe("/");
  expect(appRouteFromSegments(["(marketing)", "pricing"])).toBe("/pricing");
  expect(appRouteFromSegments(["p", "[id]"])).toBe("/p/[id]");
  expect(appRouteFromSegments(["@modal", "login"])).toBeUndefined();
  expect(appRouteFromSegments(["(.)photo"])).toBeUndefined();
  expect(appRouteFromSegments(["_components"])).toBeUndefined();
});

test("coverage lists the app-builder dashboard routes no flow captures (#42)", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-coverage-"));
  directories.push(project);
  await initProject({ project, yes: true });
  for (const path of [
    "apps/web/app/(dashboard)/page.tsx",
    "apps/web/app/create/page.tsx",
    "apps/web/app/leads/page.tsx",
    "apps/web/app/lab/editor/page.tsx",
    "apps/web/app/p/[id]/page.tsx",
    "apps/web/app/api/health/route.ts",
    "apps/web/node_modules/pkg/app/page.tsx",
  ])
    await touch(project, path);
  expect((await discoverRoutes(project)).map(({ route }) => route)).toEqual([
    "/",
    "/create",
    "/lab/editor",
    "/leads",
    "/p/[id]",
  ]);
  await writeFile(
    join(project, ".idiom", "flows", "studio-lab.json"),
    JSON.stringify({
      id: "studio-lab",
      title: "Studio",
      intent: ["Editor chrome"],
      setup: [],
      states: [
        {
          id: "editor",
          description: "Editor",
          url: "/lab/editor?idiomState=editor",
          expect: { status: 200 },
        },
        {
          id: "published",
          description: "Published",
          url: "/p/abc123",
          expect: { status: 200 },
        },
      ],
    }),
  );
  const summary = await coverageCommand({ project });
  const uncaptured = summary.routes
    .filter((route) => route.capturedBy.length === 0)
    .map(({ route }) => route);
  expect(uncaptured).toEqual(["/", "/create", "/leads"]);
  expect(
    summary.routes.find(({ route }) => route === "/p/[id]")?.capturedBy,
  ).toEqual([{ flow: "studio-lab", state: "published" }]);
  const text = renderCoverage(summary);
  expect(text).toContain("5 found, 2 captured, 3 uncaptured");
  expect(text).toContain('"routes": ["/", "/create", "/leads"]');
});

test("a flow's routes become capturable states", () => {
  const flow = flowSchema.parse({
    id: "dashboard",
    title: "Dashboard",
    intent: [],
    setup: [],
    routes: ["/", "/leads", "/create/new"],
  });
  expect(
    flow.states.map((state) => [
      state.id,
      "url" in state ? state.url : undefined,
    ]),
  ).toEqual([
    ["route-root", "/"],
    ["route-leads", "/leads"],
    ["route-create-new", "/create/new"],
  ]);
  expect(routeStateId("/p/abc/")).toBe("route-p-abc");
  expect(() =>
    flowSchema.parse({
      id: "x",
      title: "x",
      intent: [],
      setup: [],
      routes: ["leads"],
    }),
  ).toThrow();
});

test.each([
  { route: "/editor", url: "/editor", examples: [] },
  {
    route: "/editor/[id]",
    url: "/editor/draft-123",
    examples: ["/editor/draft-123"],
  },
])(
  "route coverage names state chains for $route (#57)",
  ({ route, url, examples }) => {
    const flow = flowSchema.parse({
      id: "editor",
      title: "Editor",
      intent: [],
      setup: [],
      states: [
        { id: "empty", description: "Empty", url, expect: {} },
        {
          id: "versions",
          description: "Versions",
          from: "empty",
          steps: [{ action: "click", selector: "#history" }],
          expect: {},
        },
      ],
      toggles: { search: { focused: [{ action: "focus", selector: "#q" }] } },
      toggleStates: ["versions"],
    });
    const summary = {
      ...routeCoverage([{ route, source: "app/editor/page.tsx" }], [flow]),
      discoveredFrom: "test",
      excluded: [],
    };
    expect(summary.routes[0]?.capturedBy).toEqual([
      { flow: "editor", state: "empty" },
      { flow: "editor", state: "versions", label: "versions from empty" },
      {
        flow: "editor",
        state: "versions.search-focused",
        label: "versions.search-focused from empty",
      },
    ]);
    expect(summary.routes[0]?.examples).toEqual(examples);
    expect(renderCoverage(summary)).toContain(
      `| ${route}${examples.length === 0 ? "" : ` (e.g. ${url})`} | editor/empty, editor/versions from empty, editor/versions.search-focused from empty |`,
    );
    const project = projectSchema.parse({
      version: 1,
      app: { name: "Editor", framework: "other" },
      server: {
        build: "true",
        start: "true",
        port: 3000,
        readyUrl: "http://localhost:3000/",
        env: {},
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: {},
      design: {},
      model: { provider: "anthropic", model: "unused" },
    });
    const review = buildReviewCoverage({
      flow,
      project,
      tuples: [],
      commit: "abc",
    });
    expect(review.states).toEqual([
      "empty",
      "versions",
      "versions.search-focused",
    ]);
    expect(review.stateLabels).toEqual({
      versions: "versions from empty",
      "versions.search-focused": "versions.search-focused from empty",
    });
    const verification = buildVerificationCoverage({
      flow,
      project,
      tuples: [{ state: "versions.search-focused", viewport: "desktop" }],
      successfulTuples: 1,
    });
    expect(verification.states).toEqual(["versions.search-focused"]);
    expect(verification.stateLabels).toEqual({
      "versions.search-focused": "versions.search-focused from empty",
    });
    for (const coverage of [review, verification]) {
      expect(renderCoverageMarkdown(coverage)).toContain(
        "versions.search-focused from empty",
      );
      expect(renderCoverageHtml(coverage)).toContain(
        "versions.search-focused from empty",
      );
    }
  },
);

test("crawl discovers same-origin links from a page", async () => {
  const routes = await crawlRoutes(
    "http://app.test/",
    async () =>
      '<a href="/leads">Leads</a><a href="https://elsewhere.test/x">x</a><a href="create/">New</a><a href="#top">Top</a>',
  );
  expect(routes.map(({ route }) => route)).toEqual(["/", "/create", "/leads"]);
});

test("coverage.exclude globs match routes or source paths", () => {
  expect(coverageGlob("/lab/**").test("/lab")).toBe(true);
  expect(coverageGlob("/lab/**").test("/lab/editor")).toBe(true);
  expect(coverageGlob("/lab/**").test("/labs")).toBe(false);
  expect(coverageGlob("apps/web/**").test("apps/web/app/page.tsx")).toBe(true);
  expect(
    coverageGlob("apps/*/app/page.tsx").test("apps/web/app/page.tsx"),
  ).toBe(true);
  expect(coverageGlob("/lab/*").test("/lab/editor/deep")).toBe(false);
  expect(coverageGlob("/p/[id]").test("/p/[id]")).toBe(true);
  expect(coverageGlob("/p/[id]").test("/p/i")).toBe(false);
  expect(coverageGlob("/p?").test("/pa")).toBe(true);
});

test("coverage.exclude removes internal fixtures and a frozen prototype, before routes are de-duplicated (#61)", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-coverage-"));
  directories.push(project);
  await initProject({ project, yes: true });
  for (const path of [
    "apps/web/app/page.tsx",
    "apps/web/app/lab/editor/page.tsx",
    "apps/web/app/legacy/page.tsx",
    "apps/www/app/page.tsx",
    "apps/www/app/lab/grid/page.tsx",
    "apps/www/app/leads/page.tsx",
    "apps/www/app/p/[id]/page.tsx",
  ])
    await touch(project, path);
  const projectPath = join(project, ".idiom", "project.json");
  const config = JSON.parse(await readFile(projectPath, "utf8"));
  await writeFile(
    projectPath,
    JSON.stringify({
      ...config,
      coverage: { exclude: ["/lab/**", "apps/web/**"] },
    }),
  );
  await writeFile(
    join(project, ".idiom", "flows", "published.json"),
    JSON.stringify({
      id: "published",
      title: "Published",
      intent: ["Published page"],
      setup: [],
      states: [
        {
          id: "page",
          description: "Page",
          url: "/p/abc123",
          expect: { status: 200 },
        },
      ],
    }),
  );
  const summary = await coverageCommand({ project });
  expect(summary.routes.map(({ route, source }) => [route, source])).toEqual([
    ["/", join("apps", "www", "app", "page.tsx")],
    ["/leads", join("apps", "www", "app", "leads", "page.tsx")],
    ["/p/[id]", join("apps", "www", "app", "p", "[id]", "page.tsx")],
  ]);
  expect(
    summary.excluded.map(({ route, pattern }) => [route, pattern]),
  ).toEqual([
    ["/lab/editor", "/lab/**"],
    ["/lab/grid", "/lab/**"],
    ["/legacy", "apps/web/**"],
  ]);
  expect(
    summary.routes.find(({ route }) => route === "/p/[id]")?.examples,
  ).toEqual(["/p/abc123"]);
  const text = renderCoverage(summary);
  expect(text).toContain(
    "6 found, 3 excluded (coverage.exclude), 1 captured, 2 uncaptured.",
  );
  expect(text).toContain("| /p/[id] (e.g. /p/abc123) | published/page |");
  expect(text).not.toContain("/lab/");
  expect(text).not.toContain("/legacy");
});

test("project.json coverage is optional and strict", () => {
  const base = {
    version: 1,
    app: { name: "app", framework: "nextjs" },
    server: {
      build: "build",
      start: "start",
      readyUrl: "http://localhost:3000",
      port: 3000,
      env: {},
    },
    capture: {},
    design: {},
    model: { provider: "claude-code", model: "claude-opus-5-5" },
  };
  expect(projectSchema.safeParse(base).success).toBe(true);
  expect(
    projectSchema.safeParse({ ...base, coverage: { exclude: ["/lab/**"] } })
      .data?.coverage,
  ).toEqual({ exclude: ["/lab/**"] });
  expect(
    projectSchema.safeParse({ ...base, coverage: { ignore: ["/lab/**"] } })
      .success,
  ).toBe(false);
});

test("report coverage shows each DESIGN.md-inferred component's resolved selector, or that it was unresolved", async () => {
  const { emptyObservation } = await import("./motion-support.js");
  const project = projectSchema.parse({
    version: 1,
    app: { name: "Editor", framework: "other" },
    server: {
      build: "true",
      start: "true",
      port: 3000,
      readyUrl: "http://localhost:3000/",
      env: {},
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "editor",
    title: "Editor",
    setup: [],
    intent: [],
    states: [
      { id: "a", description: "A", expect: {}, url: "/a" },
      { id: "b", description: "B", expect: {}, url: "/b" },
    ],
  });
  const tolerance = { ratio: 0.15, px: 1, mode: "tighter" as const };
  const rect = { selector: ".x-dot", x: 0, y: 0, width: 12, height: 12 };
  const observations = (rects: number) => ({
    ...emptyObservation,
    components: [
      {
        name: "override dot",
        selector: ".x-dot",
        width: 8,
        height: 8,
        tolerance,
        rects: Array.from({ length: rects }, () => rect),
        inferred: { source: "DESIGN.md:12", words: ["override", "dot"] },
      },
      {
        name: "chip",
        selector: "",
        width: 24,
        height: 24,
        tolerance,
        rects: [],
        inferred: {
          source: "DESIGN.md:14",
          words: ["chip"],
          axis: "height" as const,
        },
        unresolved: true as const,
      },
    ],
  });
  const coverage = buildReviewCoverage({
    flow,
    project,
    tuples: [
      {
        state: "a",
        viewport: "desktop",
        mismatches: [],
        observations: observations(2),
      },
      {
        state: "b",
        viewport: "desktop",
        mismatches: [],
        observations: observations(1),
      },
    ],
    commit: "abc",
  });
  const lines = [
    'Component "override dot" inferred from DESIGN.md:12, matched .x-dot (3 elements across 2 captures); explicit checks.components overrides it.',
    'Component "chip" inferred from DESIGN.md:14 was not matched by any class or aria-label words in capture; it was not checked.',
  ];
  expect(coverage.limitations).toEqual(expect.arrayContaining(lines));
  expect(renderCoverageMarkdown(coverage)).toContain(
    "DESIGN.md:12, matched .x-dot",
  );
  expect(renderCoverageHtml(coverage)).toContain(
    '<li>Component "chip" inferred from DESIGN.md:14',
  );
});
