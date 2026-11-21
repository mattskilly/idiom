import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  projectPrefix,
  designContextPaths as sharedDesignContextPaths,
} from "../src/changed/design-context.js";
import { collectChanges } from "../src/changed/git.js";
import { classifyByPath as sharedClassifyByPath } from "../src/changed/non-ui.js";
import { selectChangedStates } from "../src/changed/select.js";
import {
  classifyByPath,
  classifySelection,
  designContextPaths,
  detectStyleScope,
} from "../src/gate/classify.js";
import { planGate } from "../src/gate/plan.js";
import { renderGatePlan } from "../src/gate/render.js";
import { validateProject } from "../src/validation.js";
import { changedFixture } from "./changed-support.js";

test("pattern pass: docs, tests and lockfiles are non-UI; design context and flows are UI", () => {
  const classes = classifyByPath(
    [
      { path: "README.md" },
      { path: "docs/guide.md" },
      { path: "test/x.test.ts" },
      { path: "src/thing.spec.tsx" },
      { path: "bun.lock" },
      { path: ".github/workflows/ci.yml" },
      { path: "DESIGN.md" },
      { path: "PRODUCT.md" },
      { path: ".idiom/flows/site.json" },
      { path: "server/jobs.ts" },
      { path: "scripts/seed.ts" },
    ],
    ["scripts/**"],
  );
  expect(
    Object.fromEntries(classes.map((file) => [file.path, file.ui])),
  ).toEqual({
    "README.md": false,
    "docs/guide.md": false,
    "test/x.test.ts": false,
    "src/thing.spec.tsx": false,
    "bun.lock": false,
    ".github/workflows/ci.yml": false,
    "DESIGN.md": true,
    "PRODUCT.md": true,
    ".idiom/flows/site.json": true,
    "server/jobs.ts": true,
    "scripts/seed.ts": false,
  });
  expect(classes.find((file) => file.path === "scripts/seed.ts")?.reason).toBe(
    "checks.gate.nonUi scripts/**",
  );
});

test("import pass: unreached .ts is non-UI only on a complete graph; styles and assets stay UI", () => {
  const mapping = (path: string, extra = {}) => ({
    path,
    kind: "unresolved" as const,
    reason: "no reliable route ownership or static import association",
    routes: [],
    states: [],
    ...extra,
  });
  const files = [
    mapping("server/db.ts"),
    mapping("server/chained.ts", { importChains: [["app/r0/page.tsx"]] }),
    mapping("server/uncertain.ts", { uncertainties: ["something"] }),
    mapping("styles/card.css"),
    mapping("styles/theme.css.ts"),
    mapping("public/x.js"),
    mapping("site/widget.js"),
    mapping("next.config.mjs"),
    mapping("apps/web/vite.config.ts"),
    mapping("package.json"),
    mapping("middleware.ts"),
    mapping("src/proxy.ts"),
    mapping(".env.production"),
    mapping("tsconfig.json"),
    mapping("server/app.config.json"),
  ];
  const complete = classifySelection(
    { files, graph: { complete: true, reasons: [] } },
    ["site"],
  );
  expect(
    Object.fromEntries(complete.map((file) => [file.path, file.ui])),
  ).toEqual({
    "server/db.ts": false,
    "server/chained.ts": true,
    "server/uncertain.ts": true,
    "styles/card.css": true,
    "styles/theme.css.ts": true,
    "public/x.js": true,
    "site/widget.js": true,
    "next.config.mjs": true,
    "apps/web/vite.config.ts": true,
    "package.json": true,
    "middleware.ts": true,
    "src/proxy.ts": true,
    ".env.production": true,
    "tsconfig.json": true,
    "server/app.config.json": false,
  });
  const incomplete = classifySelection({
    files,
    graph: { complete: false, reasons: ["no route entries"] },
  });
  expect(incomplete.every((file) => file.ui)).toBe(true);
});

async function gatePlan(directory: string) {
  const plan = await planGate({
    project: directory,
    dependencies: {
      readHost: () => ({
        load: [0, 0, 0] as [number, number, number],
        coreCount: 11,
      }),
    },
  });
  if (plan.skipped) throw new Error(`unexpected skip: ${plan.line}`);
  return plan;
}

test("a module behind a dynamic import keeps the graph incomplete: no skip, every state", async () => {
  const f = await changedFixture({
    "app/r0/page.tsx":
      "const name = 'chart';\nexport default async function Page() { await import(`../../lib/widgets/$" +
      "{name}`); return <main />; }\n",
    "lib/widgets/chart.ts": "export const chart = 1;\n",
  });
  try {
    await f.write("lib/widgets/chart.ts", "export const chart = 2;\n");
    const validated = await validateProject({ project: f.directory });
    const selection = await selectChangedStates(
      validated.projectDirectory,
      validated.flows.map((record) => record.flow),
      await collectChanges(f.directory),
    );
    expect(selection.graph?.complete).toBe(false);
    expect(classifySelection(selection)[0]?.ui).toBe(true);
    const plan = await gatePlan(f.directory);
    expect(plan.states.map((state) => state.state)).toEqual(["s0", "s1"]);
    expect(renderGatePlan(plan)[0]).toContain(
      "non-UI detection off: app/r0/page.tsx: nonliteral module loading",
    );
  } finally {
    await f.cleanup();
  }
});

test("an unresolvable alias keeps the graph incomplete", async () => {
  const f = await changedFixture({
    "app/r0/page.tsx":
      "import thing from '@/missing/thing';\nexport default function Page() { return <main>{thing}</main>; }\n",
    "server/db.ts": "export const db = 1;\n",
  });
  try {
    await f.write("server/db.ts", "export const db = 2;\n");
    const plan = await gatePlan(f.directory);
    expect(plan.graph.complete).toBe(false);
    expect(plan.states).toHaveLength(2);
    expect(renderGatePlan(plan)[0]).toMatch(
      /non-UI detection off: .*unresolved import "@\/missing\/thing"/,
    );
  } finally {
    await f.cleanup();
  }
});

test("a plain-script app has no route entries: its app.js stays UI", async () => {
  const f = await changedFixture({});
  try {
    await rm(join(f.directory, "app"), { recursive: true, force: true });
    await cp(
      join(import.meta.dirname, "fixtures/field-app"),
      join(f.directory, "site"),
      { recursive: true },
    );
    await f.commit("plain script app");
    const script = join(f.directory, "site/app.js");
    await writeFile(script, `${await readFile(script, "utf8")}\n// edit\n`);
    const plan = await gatePlan(f.directory);
    expect(plan.graph.complete).toBe(false);
    expect(plan.states).toHaveLength(2);
    expect(renderGatePlan(plan)[0]).toContain(
      "non-UI detection off: no route entries",
    );
  } finally {
    await f.cleanup();
  }
});

test("control: on a complete graph a server-only module skips the gate with one line", async () => {
  const f = await changedFixture({ "server/db.ts": "export const db = 1;\n" });
  try {
    await f.write("server/db.ts", "export const db = 2;\n");
    const plan = await planGate({
      project: f.directory,
      dependencies: {
        readHost: () => ({
          load: [0, 0, 0] as [number, number, number],
          coreCount: 11,
        }),
      },
    });
    expect(plan.skipped).toBe(true);
    if (plan.skipped)
      expect(plan.line).toMatch(/^no UI changes since [0-9a-f]{12}; skipped$/);
  } finally {
    await f.cleanup();
  }
});

test("on a complete graph, framework config, the package manifest and middleware still gate every state", async () => {
  const f = await changedFixture({
    "server/db.ts": "export const db = 1;\n",
    "next.config.mjs": "export default {};\n",
    "package.json": JSON.stringify({ dependencies: { "ui-kit": "1.0.0" } }),
    "middleware.ts": "export function middleware() {}\n",
  });
  try {
    const changes: Array<[string, string]> = [
      ["next.config.mjs", "export default { basePath: '/app' };\n"],
      ["package.json", JSON.stringify({ dependencies: { "ui-kit": "2.0.0" } })],
      [
        "middleware.ts",
        "export function middleware() { return Response.redirect('/r1'); }\n",
      ],
    ];
    for (const [path, content] of changes) {
      await f.write(path, content);
      const plan = await gatePlan(f.directory);
      expect(plan.graph.complete, path).toBe(true);
      expect(
        plan.files.find((file) => file.path === path),
        path,
      ).toMatchObject({ ui: true });
      expect(plan.states, path).toHaveLength(2);
      await f.commit(`change ${path}`);
    }
  } finally {
    await f.cleanup();
  }
});

test("style scope: @media, md:, dark:, prefers-color-scheme, removed lines and untracked files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-scope-"));
  try {
    const diff = [
      "diff --git a/a.css b/a.css",
      "--- a/a.css",
      "+++ b/a.css",
      "@@ -1 +1 @@",
      "-@media (min-width: 600px) { .a { color: red } }",
      "+.a { color: blue }",
      "diff --git a/b.tsx b/b.tsx",
      "--- a/b.tsx",
      "+++ b/b.tsx",
      "@@ -1 +1 @@",
      '+<div className="md:flex dark:bg-black" />',
      "diff --git a/c.css b/c.css",
      "--- a/c.css",
      "+++ b/c.css",
      "@@ -1 +1 @@",
      "+.c { padding: 2px }",
    ].join("\n");
    await writeFile(
      join(directory, "d.css"),
      "@media (prefers-color-scheme: dark) { .d { color: white } }\n",
    );
    const scope = await detectStyleScope({
      repository: directory,
      base: "HEAD",
      files: ["a.css", "b.tsx", "c.css", "d.css"].map((path) => ({
        path,
        ui: true,
        reason: "",
      })),
      untracked: ["d.css"],
      git: async () => diff,
    });
    expect(scope.responsive.sort()).toEqual(["a.css", "b.tsx"]);
    expect(scope.theme.sort()).toEqual(["b.tsx", "d.css"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("design context: only the project's own DESIGN.md and PRODUCT.md are UI", () => {
  const byDefault = classifyByPath([
    { path: "DESIGN.md" },
    { path: "PRODUCT.md" },
    { path: "test/fixtures/x/DESIGN.md" },
    { path: "templates/foo/PRODUCT.md" },
    { path: "packages/other/DESIGN.md" },
  ]);
  expect(byDefault.map((file) => [file.path, file.ui, file.reason])).toEqual([
    ["DESIGN.md", true, "design context"],
    ["PRODUCT.md", true, "design context"],
    ["test/fixtures/x/DESIGN.md", false, "documentation"],
    ["templates/foo/PRODUCT.md", false, "documentation"],
    ["packages/other/DESIGN.md", false, "documentation"],
  ]);
  const configured = classifyByPath(
    [{ path: "design/brand.md" }, { path: "DESIGN.md" }],
    [],
    ["design/brand.md", "PRODUCT.md"],
  );
  expect(configured.map((file) => [file.path, file.ui])).toEqual([
    ["design/brand.md", true],
    ["DESIGN.md", false],
  ]);
});

test("design context paths are repo-relative and never localized", () => {
  const defaults = { designFile: "DESIGN.md", productFile: "PRODUCT.md" };
  expect(designContextPaths(defaults, "")).toEqual({
    design: "DESIGN.md",
    product: "PRODUCT.md",
  });
  expect(designContextPaths(defaults, "packages/web")).toEqual({
    design: "packages/web/DESIGN.md",
    product: "packages/web/PRODUCT.md",
  });
  expect(
    designContextPaths(
      { ...defaults, designFile: "../../DESIGN.md" },
      "packages/web",
    ).design,
  ).toBe("DESIGN.md");
  expect(
    designContextPaths({ ...defaults, designFile: "./design/brand.md" }, "")
      .design,
  ).toBe("design/brand.md");
});

test("--changed and --gate share one design-context definition", async () => {
  expect(designContextPaths).toBe(sharedDesignContextPaths);
  const root = await mkdtemp(join(tmpdir(), "idiom-prefix-"));
  try {
    await mkdir(join(root, "packages/web"), { recursive: true });
    expect(await projectPrefix(root, root)).toBe("");
    expect(await projectPrefix(root, join(root, "packages/web"))).toBe(
      "packages/web",
    );
    await symlink(join(root, "packages/web"), join(root, "web-link"));
    expect(await projectPrefix(root, join(root, "web-link"))).toBe(
      "packages/web",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("under --project a repo-root DESIGN.md is not the project's own", () => {
  const classes = classifyByPath(
    [
      { path: "DESIGN.md", repoPath: "DESIGN.md" },
      { path: "DESIGN.md", repoPath: "packages/web/DESIGN.md" },
    ],
    [],
    ["packages/web/DESIGN.md", "packages/web/PRODUCT.md"],
  );
  expect(classes.map((file) => [file.ui, file.reason])).toEqual([
    [false, "documentation"],
    [true, "design context"],
  ]);
});

const themeLines = (n: number) =>
  `# Design\n\ndark: surfaces use color-scheme dark (${n})\n`;

async function twoSchemes(f: Awaited<ReturnType<typeof changedFixture>>) {
  const path = join(f.directory, ".idiom/project.json");
  const project = JSON.parse(await readFile(path, "utf8"));
  project.colorSchemes = ["light", "dark"];
  await writeFile(path, JSON.stringify(project));
}

const host = {
  readHost: () => ({
    load: [0, 0, 0] as [number, number, number],
    coreCount: 11,
  }),
};

test("--changed and --gate share one non-UI classifier and agree on a docs-only diff", async () => {
  expect(classifyByPath).toBe(sharedClassifyByPath);
  const f = await changedFixture();
  try {
    await f.write("README.md", "# Readme\n");
    await f.write("bun.lock", "lock\n");
    const gate = await planGate({ project: f.directory, dependencies: host });
    expect(gate.skipped).toBe(true);
    const validated = await validateProject({ project: f.directory });
    const selection = await selectChangedStates(
      f.directory,
      validated.flows.map((record) => record.flow),
      await collectChanges(f.directory),
      { design: validated.project.design },
    );
    expect(selection.selected).toEqual([]);
    const reasons = (files: Array<{ path: string; reason: string }>) =>
      Object.fromEntries(files.map((file) => [file.path, file.reason]));
    expect(reasons(selection.files)).toEqual({
      "README.md": "documentation",
      "bun.lock": "lockfile",
    });
    if (gate.skipped)
      expect(reasons(gate.files)).toEqual(reasons(selection.files));
  } finally {
    await f.cleanup();
  }
});

test("a fixture DESIGN.md never widens the gate; the project's own does", async () => {
  const f = await changedFixture({
    "test/fixtures/x/DESIGN.md": themeLines(0),
    "DESIGN.md": themeLines(0),
  });
  try {
    await twoSchemes(f);
    await f.commit("two schemes");
    // AC1: the fixture alone skips.
    await f.write("test/fixtures/x/DESIGN.md", themeLines(1));
    const skipped = await planGate({
      project: f.directory,
      dependencies: host,
    });
    expect(skipped.skipped).toBe(true);
    if (skipped.skipped) {
      expect(skipped.line).toMatch(
        /^no UI changes since [0-9a-f]{12}; skipped$/,
      );
      expect(
        skipped.files.find((file) => file.path === "test/fixtures/x/DESIGN.md")
          ?.reason,
      ).toBe("documentation");
    }
    // AC1: with a page change, still one scheme and no widened line.
    await f.write(
      "app/r0/page.tsx",
      "export default function Page() { return <main>changed</main>; }\n",
    );
    const plan = await gatePlan(f.directory);
    expect(plan.styleScope.theme).toEqual([]);
    expect(plan.states.every((state) => state.schemes.length === 1)).toBe(true);
    expect(
      renderGatePlan(plan).some((line) => line.startsWith("widened schemes")),
    ).toBe(false);
    await f.commit("fixture and page");
    // AC2: the project's own DESIGN.md widens as before.
    await f.write("DESIGN.md", themeLines(2));
    const own = await gatePlan(f.directory);
    expect(own.styleScope.theme).toContain("DESIGN.md");
    expect(own.states.length).toBeGreaterThan(0);
    expect(own.states.every((state) => state.schemes.length === 2)).toBe(true);
    expect(renderGatePlan(own)).toContain(
      "widened schemes: theme styles in DESIGN.md",
    );
  } finally {
    await f.cleanup();
  }
});

test("a configured design file widens; the default-named one then does not", async () => {
  const f = await changedFixture({
    "design/brand.md": themeLines(0),
    "DESIGN.md": themeLines(0),
  });
  try {
    await twoSchemes(f);
    const path = join(f.directory, ".idiom/project.json");
    const project = JSON.parse(await readFile(path, "utf8"));
    project.design = { designFile: "design/brand.md" };
    await writeFile(path, JSON.stringify(project));
    await f.commit("configured design file");
    await f.write("DESIGN.md", themeLines(1));
    const skipped = await planGate({
      project: f.directory,
      dependencies: host,
    });
    expect(skipped.skipped).toBe(true);
    await f.commit("root DESIGN.md");
    await f.write("design/brand.md", themeLines(1));
    const plan = await gatePlan(f.directory);
    expect(plan.graph.complete).toBe(true);
    expect(plan.styleScope.theme).toContain("design/brand.md");
    expect(
      plan.files.find((file) => file.path === "design/brand.md"),
    ).toMatchObject({ ui: true, reason: "design context", kind: "global" });
    expect(renderGatePlan(plan)).toContain(
      "widened schemes: theme styles in design/brand.md",
    );
  } finally {
    await f.cleanup();
  }
});

test("under --project only the project's own DESIGN.md widens, not a sibling's or the repo root's", async () => {
  const f = await changedFixture({});
  const outer = await mkdtemp(join(tmpdir(), "idiom-outer-"));
  const git = async (...args: string[]) =>
    (await promisify(execFile)("git", args, { cwd: outer })).stdout;
  const commit = async (message: string) => {
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      message,
    );
  };
  try {
    await twoSchemes(f);
    const web = join(outer, "packages/web");
    await cp(f.directory, web, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes(".git"),
    });
    await writeFile(join(web, "DESIGN.md"), themeLines(0));
    await cp(join(web, "DESIGN.md"), join(outer, "packages/other/DESIGN.md"));
    await writeFile(join(outer, "DESIGN.md"), themeLines(0));
    await git("init", "--quiet", "--initial-branch=main");
    await commit("outer");
    const plan = () => planGate({ project: web, dependencies: host });

    await writeFile(join(outer, "packages/other/DESIGN.md"), themeLines(1));
    expect((await plan()).skipped).toBe(true);
    await commit("sibling");

    await writeFile(join(outer, "DESIGN.md"), themeLines(1));
    const root = await plan();
    expect(root.skipped).toBe(true);
    if (root.skipped)
      expect(root.files.find((file) => file.path === "DESIGN.md")?.reason).toBe(
        "documentation",
      );
    await commit("root");

    await writeFile(join(web, "DESIGN.md"), themeLines(1));
    const own = await plan();
    if (own.skipped) throw new Error(`unexpected skip: ${own.line}`);
    expect(own.styleScope.theme).toContain("packages/web/DESIGN.md");
    expect(own.states.every((state) => state.schemes.length === 2)).toBe(true);
    expect(renderGatePlan(own)).toContain(
      "widened schemes: theme styles in packages/web/DESIGN.md",
    );
  } finally {
    await f.cleanup();
    await rm(outer, { recursive: true, force: true });
  }
});
