import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { collectChanges } from "../src/changed/git.js";
import { selectChangedStates } from "../src/changed/select.js";
import {
  classifyByPath,
  classifySelection,
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
  const plan = await planGate({ project: directory });
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
    const plan = await planGate({ project: f.directory });
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
