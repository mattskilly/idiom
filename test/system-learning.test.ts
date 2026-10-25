import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { afterEach, expect, test } from "vitest";
import { runCapture } from "../src/capture/run.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import {
  loadTokenDeclarations,
  normalizeTokenDeclarations,
  observePage,
} from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { scaleConformanceCheck } from "../src/checks/scale-conformance.js";
import { tokenDriftCheck } from "../src/checks/token-drift.js";
import type { CheckTuple } from "../src/checks/types.js";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { constructSiteFlow } from "../src/flows/generate.js";
import { setJsonValue } from "../src/learn/json-edit.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { flowSchema } from "../src/schemas/flow.js";
import { checksConfigSchema, projectSchema } from "../src/schemas/project.js";
import {
  collectDrift,
  compareValueDrift,
  type DriftInput,
} from "../src/system/drift.js";
import { cssKind } from "../src/system/learn/css.js";
import { discoverSources } from "../src/system/learn/discover.js";
import {
  applySystemDraft,
  draftSystemLearning,
} from "../src/system/learn/draft.js";
import { extractSources } from "../src/system/learn/extract.js";
import {
  normalizeCssValues,
  normalizeInBrowser,
} from "../src/system/learn/normalize.js";
import { runSystemLearning } from "../src/system/learn/run.js";
import type { DesignToken } from "../src/system/learn/schema.js";
import { runSystem } from "../src/system/run.js";

const roots: string[] = [];
const fixtures = join(import.meta.dirname, "fixtures", "system-learning");
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "idiom-system-learning-"));
  roots.push(root);
  return root;
}
async function fixture(name?: string) {
  const root = await temporary();
  if (name) await cp(join(fixtures, name), root, { recursive: true });
  await initProject({ project: root, yes: true, write: () => {} });
  return root;
}
async function config(root: string) {
  return projectSchema.parse(
    JSON.parse(await readFile(join(root, ".idiom", "project.json"), "utf8")),
  );
}
const token = (
  name: string,
  value: string,
  kind: DesignToken["kind"] = "spacing",
): DesignToken => ({
  name,
  value,
  kind,
  source: { path: "tokens.css", key: name },
});

test("discovery is bounded, stable and never executes Tailwind configs", async () => {
  const root = await temporary();
  await writeFile(
    join(root, "tailwind.config.cjs"),
    'throw new Error("executed")',
  );
  await writeFile(join(root, "package.json"), "{ malformed unrelated");
  await writeFile(join(root, "style.css"), ":root { --space: 8px }");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "tokens.json"), "{}");
  const outside = await temporary();
  await writeFile(join(outside, "tokens.json"), '{"a":{"$value":1}}');
  await symlink(outside, join(root, "linked"), "dir");
  expect((await discoverSources(root)).map((s) => s.path)).toEqual([
    "style.css",
    "tailwind.config.cjs",
  ]);
  await expect(extractSources(root)).rejects.toThrow("tailwind.config.cjs");
});

test("public Tailwind loader resolves presets, extend, functions and TypeScript", async () => {
  const extracted = await extractSources(join(fixtures, "tailwind-v3"));
  expect(extracted.tokens).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "spacing.preset", value: "16px" }),
      expect.objectContaining({ name: "spacing.compact", value: "4px" }),
      expect.objectContaining({
        name: "height.button",
        kind: "control-height",
        value: "32px",
      }),
      expect.objectContaining({
        name: "height.layout",
        kind: "other",
        value: "24px",
      }),
      expect.objectContaining({
        name: "colors.brand",
        source: { path: "tailwind.config.ts", key: "theme.colors.brand" },
      }),
    ]),
  );
  const root = await temporary();
  await writeFile(
    join(root, "tailwind.config.mjs"),
    'export default {content:[],theme:{extend:{spacing:{custom:"13px"}}}}',
  );
  const defaults = await extractSources(root);
  expect(defaults.tokens).toContainEqual(
    expect.objectContaining({
      name: "spacing.custom",
      value: "13px",
      default: false,
    }),
  );
  expect(defaults.tokens.some((t) => t.default)).toBe(true);
});

test("CSS keeps theme and alias context, channel colours, resets and conditional diagnostics", async () => {
  const css = await extractSources(join(fixtures, "css-variables"));
  expect(
    css.tokens.filter((t) => t.name === "--color-brand").map((t) => t.theme),
  ).toEqual([undefined, "dark", "ocean"]);
  expect(
    css.tokens.find((t) => t.name === "--color-brand")?.environment?.[
      "--channels"
    ],
  ).toContain("210");
  expect(css.tokens.find((t) => t.name === "--channels")?.kind).toBe("other");
  const v4 = await extractSources(join(fixtures, "tailwind-v4"));
  expect(v4.tokens.some((t) => t.name === "--color-removed")).toBe(false);
  expect(v4.tokens).toContainEqual(
    expect.objectContaining({ name: "--spacing", base: true }),
  );
  const root = await temporary();
  await writeFile(
    join(root, "style.css"),
    "@media (min-width:800px) {:root {--space-card: 8px}} :root {--color-loop:var(--color-loop);--color-missing:var(--missing)}",
  );
  const result = await extractSources(root);
  expect(
    result.tokens.find((t) => t.name === "--space-card")?.reason,
  ).toContain("Conditional");
  const values = await normalizeInBrowser(
    result.tokens.map((t) => ({
      value: t.value,
      kind: t.kind,
      environment: t.environment,
    })),
  );
  expect(values.slice(1).every((v) => v.reason)).toBe(true);
  const outside = await temporary();
  await writeFile(join(outside, "escape.css"), ":root{--space:1px}");
  await symlink(join(outside, "escape.css"), join(root, "escape.css"));
  await writeFile(
    join(root, "style.css"),
    '@import "./escape.css";:root{--space:8px}',
  );
  await expect(extractSources(root)).rejects.toThrow("escapes the project");
});

test("DTCG inherits format types and resolves aliases without guessing scalar types", async () => {
  const extracted = await extractSources(join(fixtures, "dtcg"));
  expect(extracted.tokens).toContainEqual(
    expect.objectContaining({
      name: "spacing.alias",
      value: "{spacing.card}",
      resolved: "8px",
      kind: "spacing",
    }),
  );
  expect(extracted.tokens).toContainEqual(
    expect.objectContaining({
      name: "layout",
      kind: "other",
      notes: ["Ambiguous dimension purpose: display only"],
    }),
  );
  expect(extracted.tokens.find((t) => t.name === "unknown")?.reason).toContain(
    "no declared",
  );
  const root = await temporary();
  await writeFile(
    join(root, "tokens.json"),
    JSON.stringify({
      a: { $value: "{b}" },
      b: { $value: "{a}" },
      missing: { $value: "{absent}" },
      composite: { $type: "shadow", $value: [] },
    }),
  );
  expect((await extractSources(root)).tokens.every((t) => t.reason)).toBe(true);
  await writeFile(join(root, "tokens.json"), '{"bad.name":{"$value":4}}');
  await expect(extractSources(root)).rejects.toThrow(
    "invalid token/group name",
  );
});

test("browser normalization covers modern colour, alpha, aliases, fallbacks, calc and context", async () => {
  const values = await normalizeInBrowser([
    ...[
      "#123456",
      "rgb(18, 52, 86)",
      "hsl(210 65.384615% 20.392157%)",
      "color(srgb .0705882353 .2039215686 .337254902)",
      "oklch(0.319168 0.072455 251.168)",
    ].map((value) => ({ value, kind: "color" as const })),
    { value: "rgba(18,52,86,.5)", kind: "color" },
    {
      value: "var(--missing, calc(1rem + 2px))",
      kind: "spacing",
      rootFontSize: 20,
    },
    { value: "1rem", kind: "spacing", rootFontSize: 16 },
    {
      value: "var(--space)",
      kind: "spacing",
      rootFontSize: 20,
      environment: { "--space": "1rem", "--color": "hsl(20 50% 50%)" },
    },
    { value: "50% 30%", kind: "radius" },
    { value: "9999px", kind: "radius" },
    { value: "currentColor", kind: "color" },
    { value: "25%", kind: "spacing" },
    {
      value: "var(--cycle)",
      kind: "spacing",
      environment: { "--cycle": "var(--cycle)" },
    },
  ]);
  for (const value of values.slice(0, 5))
    expect(value.value).toBe("rgb(18, 52, 86)");
  expect(values[5]?.value).toMatch(/^rgba\(18, 52, 86, 0.50/);
  expect(values[6]?.px).toBe(22);
  expect(values[7]?.px).toBe(16);
  expect(values[8]?.px).toBe(20);
  expect(values[9]?.reason).toBeDefined();
  expect(values[10]?.value).toBe("full");
  expect(values.slice(11).every((v) => v.reason)).toBe(true);
});

test("drafts preserve user values, role selectors and unrelated bytes; conflicts and root assumptions are explicit", async () => {
  const root = await fixture();
  const before = (
    await readFile(join(root, ".idiom", "project.json"), "utf8")
  ).replace('"framework": "other"', '"framework"  :  "other"');
  const raw = JSON.parse(before);
  raw.checks = {
    scales: {
      spacing: [3],
      radius: { card: [5] },
      roles: { control: [".custom"] },
    },
  };
  const input = JSON.stringify(raw, null, 2).replace(
    '"framework": "other"',
    '"framework"  :  "other"',
  );
  const extracted = {
    sources: [{ path: "tokens.css", kind: "css" as const }],
    tokens: [
      token("--space-card", "1rem"),
      token("--radius-button", "6px", "radius"),
      token("--color-brand", "#123456", "color"),
    ],
    diagnostics: [],
  };
  const draft = await draftSystemLearning(input, extracted, {
    rootFontSizes: [16, 20],
  });
  expect(draft.after).toContain('"framework"  :  "other"');
  expect(JSON.parse(draft.after).checks.scales).toMatchObject({
    spacing: [3],
    radius: { card: [5], control: [6] },
    roles: { control: [".custom"] },
  });
  expect(draft.summary.join("\n")).toContain("Captured root sizes differ");
  expect(
    (
      await draftSystemLearning(draft.after, extracted, {
        rootFontSizes: [16, 20],
      })
    ).diff,
  ).toBe("");
  const existing = JSON.parse(draft.after);
  existing.design.tokens[0].value = "2rem";
  const conflict = await draftSystemLearning(
    JSON.stringify(existing),
    extracted,
  );
  expect(conflict.summary.join("\n")).toContain("Preserved existing token");
});

test("same names across sources retain identity, but conflicting context is excluded from scales", async () => {
  const root = await fixture();
  await writeFile(join(root, "a.css"), ":root{--space-card:8px}");
  await writeFile(join(root, "b.css"), ":root{--space-card:11px}");
  const extraction = await extractSources(root);
  expect(extraction.tokens).toHaveLength(2);
  expect(
    extraction.tokens.every((t) => t.reason?.includes("Conflicting")),
  ).toBe(true);
  const draft = await draftSystemLearning(
    await readFile(join(root, ".idiom", "project.json"), "utf8"),
    extraction,
  );
  expect(JSON.parse(draft.after).design.tokens).toHaveLength(2);
  expect(JSON.parse(draft.after).checks).toBeUndefined();
});

test("atomic application rejects stale confirmation and cleans up failed publication", async () => {
  const root = await fixture("dtcg");
  const path = join(root, ".idiom", "project.json");
  const before = await readFile(path, "utf8");
  const draft = await draftSystemLearning(before, await extractSources(root));
  await writeFile(path, `${before}\n`);
  await expect(applySystemDraft(path, draft)).rejects.toThrow(
    "changed after preview",
  );
  await writeFile(path, before);
  await expect(
    applySystemDraft(path, draft, async () => {
      throw new Error("rename failed");
    }),
  ).rejects.toThrow("rename failed");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(
    (await readdir(join(root, ".idiom"))).some((p) => p.endsWith(".tmp")),
  ).toBe(false);
});

test("CLI previews exact diff before confirmation, leaves declined bytes intact and supports non-TTY/yes/no-op", async () => {
  const root = await fixture("css-variables");
  const path = join(root, ".idiom", "project.json");
  const before = await readFile(path, "utf8");
  const source = await readFile(join(root, "tokens.css"), "utf8");
  const output: string[] = [];
  const launches: string[][] = [];
  const dependencies = {
    write: (s: string) => output.push(s),
    launch: async (_command: string, args: string[]) => {
      launches.push(args);
    },
    platform: "darwin" as const,
    confirm: async (diff: string) => {
      expect(output.join("")).toContain(diff);
      expect(diff).toContain("design");
      return false;
    },
  };
  const result = await runSystem({ project: root, learn: true, dependencies });
  expect(result.learning?.outcome).toBe("declined");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(await readFile(join(root, "tokens.css"), "utf8")).toBe(source);
  expect(launches[0]).toEqual([result.reportPath]);
  expect(await readFile(result.reportPath, "utf8")).toContain(
    "Transient proposed declarations",
  );
  const preview = await runSystemLearning(root, {
    dependencies: { isTTY: false, write: () => {} },
  });
  expect(preview.outcome).toBe("preview");
  const applied = await runSystemLearning(root, {
    yes: true,
    dependencies: { write: () => {} },
  });
  expect(applied.outcome).toBe("applied");
  expect((await config(root)).design.tokens?.length).toBeGreaterThan(0);
  expect(
    (
      await runSystemLearning(root, {
        yes: true,
        dependencies: { write: () => {} },
      })
    ).outcome,
  ).toBe("no-changes");
  await expect(runSystem({ project: root, yes: true })).rejects.toThrow(
    "--yes requires --learn",
  );
  const blank = await fixture();
  expect(
    (
      await runSystemLearning(blank, {
        yes: true,
        dependencies: { write: () => {} },
      })
    ).outcome,
  ).toBe("no-sources");
}, 30000);

test("recognized source failure aborts without partial writes", async () => {
  const root = await fixture("css-variables");
  const path = join(root, ".idiom", "project.json");
  const before = await readFile(path, "utf8");
  await writeFile(join(root, "tokens.json"), "{broken");
  let confirmed = false;
  await expect(
    runSystemLearning(root, {
      dependencies: {
        write: () => {},
        confirm: async () => {
          confirmed = true;
          return true;
        },
      },
    }),
  ).rejects.toThrow("tokens.json");
  expect(confirmed).toBe(false);
  expect(await readFile(path, "utf8")).toBe(before);
});

test("init detection needs separate offer/apply confirmations and --yes only advises", async () => {
  const root = await temporary();
  await cp(join(fixtures, "dtcg"), root, { recursive: true });
  const output: string[] = [];
  const requests: string[] = [];
  const result = await initProject({
    project: root,
    write: (s) => output.push(s),
    confirm: async (request) => {
      requests.push(request.kind);
      if (request.kind === "apply-system-learning") {
        expect(output.join("")).toContain(request.diff);
        expect(request.path).toBe(".idiom/project.json");
      }
      return request.kind !== "offer-flow-generation";
    },
  });
  expect(requests).toEqual([
    "offer-system-learning",
    "apply-system-learning",
    "offer-flow-generation",
  ]);
  expect(result.systemLearning.kind).toBe("applied");
  expect(result.flows.kind).toBe("declined");
  const other = await temporary();
  await cp(join(fixtures, "dtcg"), other, { recursive: true });
  const advisory = await initProject({
    project: other,
    yes: true,
    write: (s) => output.push(s),
  });
  expect(advisory.systemLearning.kind).toBe("available-noninteractive");
  expect((await config(other)).design.tokens).toBeUndefined();
  const declined = await initProject({
    project: other,
    write: () => {},
    confirm: async () => false,
  });
  expect(declined.systemLearning.kind).toBe("declined");
});

for (const applyLearning of [false, true])
  for (const generateFlows of [false, true])
    test(`init keeps token application (${applyLearning}) and flow generation (${generateFlows}) consent independent`, async () => {
      const root = await fixture("dtcg");
      const configPath = join(root, ".idiom", "project.json");
      const before = await readFile(configPath, "utf8");
      const requests: string[] = [];
      let generated = false;
      const result = await initProject({
        project: root,
        write: () => {},
        confirm: async (request) => {
          requests.push(request.kind);
          if (request.kind === "offer-system-learning") return true;
          if (request.kind === "apply-system-learning") return applyLearning;
          return request.kind === "offer-flow-generation" && generateFlows;
        },
        generateFlows: async ({ project }) => {
          generated = true;
          expect(Boolean(project.design.tokens?.length)).toBe(applyLearning);
          return constructSiteFlow(project, {
            routes: [{ route: "/", path: "/", sources: ["app/page.tsx"] }],
            warnings: [],
          });
        },
      });
      expect(requests).toEqual([
        "offer-system-learning",
        "apply-system-learning",
        "offer-flow-generation",
      ]);
      expect(result.systemLearning.kind).toBe(
        applyLearning ? "applied" : "declined",
      );
      expect(result.flows.kind).toBe(generateFlows ? "generated" : "declined");
      expect(generated).toBe(generateFlows);
      if (!applyLearning)
        expect(await readFile(configPath, "utf8")).toBe(before);
      const sitePath = join(root, ".idiom", "flows", "site.json");
      if (generateFlows)
        expect(
          flowSchema.parse(JSON.parse(await readFile(sitePath, "utf8"))),
        ).toMatchObject({
          id: "site",
          states: [{ url: "/", expect: { path: "/" } }],
        });
      else
        await expect(readFile(sitePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
    });

for (const family of ["tailwind-v3", "tailwind-v4", "css-variables", "dtcg"])
  test(`${family}: real capture, confirmed learning, offline HTML drift and fresh checks`, async () => {
    const root = await fixture(family);
    const path = join(root, ".idiom", "project.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.server = {
      build: "true",
      start: "node server.cjs",
      readyUrl: "http://127.0.0.1:3000/",
      port: 3000,
      env: {},
    };
    raw.viewports = [{ name: "desktop", width: 640, height: 480 }];
    raw.capture.settleMs = 0;
    await writeFile(path, JSON.stringify(raw, null, 2));
    const flow = flowSchema.parse({
      id: "sample",
      title: "Sample",
      target: { kind: "web" },
      setup: [],
      intent: ["Exercise declared tokens"],
      states: [
        { id: "ready", description: "Token examples", url: "/", expect: {} },
      ],
    });
    await writeFile(
      join(root, ".idiom", "flows", "sample.json"),
      JSON.stringify(flow),
    );
    const capture = async () =>
      runCapture({
        projectDirectory: root,
        project: await config(root),
        flow,
        dependencies: {
          snapshotSource: async () => ({
            commit: "a".repeat(40),
            dirty: false,
          }),
        },
      });
    const original = await capture();
    const result = await runSystem({
      project: root,
      learn: true,
      yes: true,
      dependencies: {
        platform: "darwin",
        launch: async () => {},
        write: () => {},
      },
    });
    expect(result.learning?.outcome).toBe("applied");
    expect(result.learning?.drift.uncovered.join("\n")).toContain("37px");
    expect(result.learning?.drift.uncovered.join("\n")).toContain("11px");
    expect(result.learning?.drift.notObserved.join("\n")).toContain("unused");
    const project = await config(root);
    expect(project.checks.scales.controlHeights).toContain(32);
    expect(project.checks.scales.controlHeights).not.toContain(24);
    expect(project.checks.scales.radius.control).toContain(6);
    expect(project.checks.scales.spacing).toContainEqual(
      family === "tailwind-v4" ? { multipleOf: 4 } : 8,
    );
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`file://${result.reportPath}`);
      await page.waitForSelector('[data-drift-ready="true"]');
      expect(errors).toEqual([]);
      expect(
        await page.locator("[data-drift-results]").textContent(),
      ).toContain("37px");
      expect(
        await page.locator("[data-drift-results]").textContent(),
      ).toContain("not observed in this capture");
    } finally {
      await browser.close();
    }
    const fresh = await capture();
    expect(fresh.runDirectory).not.toBe(original.runDirectory);
    const loaded = await loadCaptureRun({
      runDirectory: fresh.runDirectory,
      expectedFlow: "sample",
      legacyColorScheme: "light",
    });
    const tuple = loaded.tuples[0] as CheckTuple;
    expect(tuple.observations?.version).toBe(2);
    if (tuple.observations?.version === 2)
      expect(tuple.observations.rootFontSize).toBe(20);
    expect(observationArtifactSchema.parse(tuple.observations)).toEqual(
      tuple.observations,
    );
    const scales = scaleConformanceCheck.run({
      tuple,
      config: checksConfigFrom(project.checks),
      narrowViewport: false,
      tuples: loaded.tuples,
    });
    for (const property of ["height", "radius", "spacing"])
      expect(
        scales.candidates.some((c) => c.rule === `idiom:off-scale-${property}`),
      ).toBe(true);
    expect(scales.candidates.every((c) => c.selectorHint !== "#good")).toBe(
      true,
    );
    const colors = tokenDriftCheck.run({
      tuple,
      config: checksConfigFrom(project.checks),
      narrowViewport: false,
    });
    expect(
      colors.candidates.some((c) => c.selectorHint?.startsWith("#off")),
    ).toBe(true);
    expect(
      colors.candidates.some((c) => c.selectorHint?.startsWith("#good")),
    ).toBe(false);
  }, 60000);

test("typed captures preserve theme scope and never authorize radius from spacing", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<html data-theme="ocean" style="font-size:20px"><body><button style="height:32px;padding:8px;border-radius:8px;color:#124455">Example</button></body></html>',
    );
    const tokens = [
      token("--space-card", "8px"),
      { ...token("--color-brand", "#124455", "color"), theme: "ocean" },
      token("--radius", "6px", "radius"),
    ];
    const declarations = await loadTokenDeclarations(
      await temporary(),
      undefined,
      tokens,
    );
    const observed = await observePage(page, declarations);
    expect(observationArtifactSchema.parse(observed)).toEqual(observed);
    expect(observed.version === 2 && observed.theme).toBe("ocean");
    expect(
      observed.tokens.status === "configured" && observed.tokens.typedValues,
    ).toContainEqual(
      expect.objectContaining({ kind: "spacing", value: "8px" }),
    );
    const tuple = { observations: observed } as CheckTuple;
    const checked = tokenDriftCheck.run({
      tuple,
      config: checksConfigFrom(),
      narrowViewport: false,
    });
    expect(checked.candidates.some((c) => c.explanation.includes("8px"))).toBe(
      true,
    );
    expect(
      checked.candidates.some((c) => c.explanation.includes("rgb(18, 68, 85)")),
    ).toBe(false);
    const spacingOnly = await normalizeTokenDeclarations(
      page,
      await loadTokenDeclarations(await temporary(), undefined, [
        token("--space-card", "8px"),
      ]),
    );
    expect(spacingOnly.status).toBe("configured");
  } finally {
    await browser.close();
  }
});

test("drift reports legacy/rem and absent theme coverage rather than unused unresolved tokens", async () => {
  const input: DriftInput = {
    status: "available",
    runId: "legacy",
    capturedAt: "2026-01-01",
    declarations: [
      token("--space-card", "1rem"),
      { ...token("--color-brand", "#fff", "color"), theme: "ocean" },
    ],
    facts: [],
    contexts: [{ coordinate: "flow/state/desktop/light", scheme: "light" }],
    limitations: ["Legacy root font size unavailable"],
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<body></body>");
    const result = await page.evaluate<ReturnType<typeof compareValueDrift>>(
      `(${compareValueDrift.toString()})(${JSON.stringify(input)},${normalizeCssValues.toString()})`,
    );
    expect(result.notObserved).toEqual([]);
    expect(result.unresolved.join("\n")).toContain("ocean");
    expect(result.unresolved.join("\n")).toContain("Legacy");
  } finally {
    await browser.close();
  }
  expect(
    checksConfigSchema.safeParse({ scales: { spacing: [{ multipleOf: 0 }] } })
      .success,
  ).toBe(false);
  expect(
    projectSchema.safeParse({
      ...(await config(await fixture())),
      design: { tokens: [token("a", "8px"), token("a", "8px")] },
    }).success,
  ).toBe(false);
});

test.each(["tailwind-v3", "tailwind-v3-extend"])(
  "built CLI loads %s through its pinned Tailwind alias outside the target application",
  async (family) => {
    const root = await fixture(family);
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const name of ["open", "xdg-open"])
      await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        join(import.meta.dirname, "..", "dist", "cli.js"),
        "--project",
        root,
        "system",
        "--learn",
        "--yes",
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    expect(stdout).toContain("tailwind.config.cjs");
    const learned = await config(root);
    if (family === "tailwind-v3")
      expect(
        learned.design.tokens?.some((t) => t.name === "spacing.preset"),
      ).toBe(true);
    else {
      expect(learned.design.tokens?.map((t) => t.name)).toEqual([
        "colors.brand",
      ]);
      expect(learned.checks.scales.border.control).toEqual(["rgb(18, 52, 86)"]);
      expect(learned.checks.scales.spacing).toEqual([]);
      expect(stdout).toContain("inherited Tailwind defaults");
    }
  },
  30000,
);

test("CLI rejects --yes alone and non-TTY learning prints a proposal before its exact report path", async () => {
  const root = await fixture("dtcg");
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await run(["node", "idiom", "--project", root, "system", "--yes"], {
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    }),
  ).toBe(1);
  expect(stderr.join("")).toContain("--yes requires --learn");
  const before = await readFile(join(root, ".idiom", "project.json"), "utf8");
  expect(
    await run(["node", "idiom", "--project", root, "system", "--learn"], {
      stdout: (s) => stdout.push(s),
      system: { isTTY: false, platform: "darwin", launch: async () => {} },
    }),
  ).toBe(0);
  expect(stdout.join("")).toContain("Preview only");
  expect(stdout.at(-1)).toBe(
    `${join(root, ".idiom", "reports", "system.html")}\n`,
  );
  expect(await readFile(join(root, ".idiom", "project.json"), "utf8")).toBe(
    before,
  );
});

test("spacing groups authored gap axes and negative margins once per value across tuples", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<body><div style="display:flex;gap:11px 13px"><button id="a" style="padding:11px;margin-left:-11px">One</button><button id="b" style="padding:12.4px">Two</button></div></body>',
    );
    const observations = await observePage(page, { status: "not-configured" });
    const tuple: CheckTuple = {
      flow: "sample",
      state: "a",
      viewport: "desktop",
      colorScheme: "light",
      width: 640,
      height: 480,
      metadataPath: "a/metadata.json",
      artifactPaths: [],
      commit: "a",
      createdAt: "2026-10-25T00:00:00Z",
      observations,
      console: [],
      mismatches: [],
    };
    const second = { ...tuple, state: "b" };
    const tuples = [tuple, second];
    const config = checksConfigFrom(
      checksConfigSchema.parse({ scales: { spacing: [{ multipleOf: 4 }] } }),
    );
    const first = scaleConformanceCheck.run({
      tuple,
      tuples,
      config,
      narrowViewport: false,
    });
    const spacing = first.candidates.filter(
      (c) => c.rule === "idiom:off-scale-spacing",
    );
    expect(spacing).toHaveLength(2);
    expect(spacing.every((c) => c.evidenceTuples?.length === 2)).toBe(true);
    expect(spacing.map((c) => c.explanation).join("\n")).not.toContain(
      "12.4px",
    );
    expect(
      scaleConformanceCheck
        .run({ tuple: second, tuples, config, narrowViewport: false })
        .candidates.filter((c) => c.rule === "idiom:off-scale-spacing"),
    ).toEqual([]);
    for (const element of observations.elements)
      delete element.authoredProperties;
    const historical = { ...tuple, observations };
    const unavailable = scaleConformanceCheck.run({
      tuple: historical,
      config,
      narrowViewport: false,
    });
    expect(unavailable.coverage.reason).toContain(
      "spacing coverage unavailable",
    );
    expect(
      unavailable.candidates.filter(
        (c) => c.rule === "idiom:off-scale-spacing",
      ),
    ).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("drift respects root overrides, named themes and equal-valued aliases", async () => {
  const light = {
    coordinate: "sample/ready/desktop/light",
    scheme: "light" as const,
    rootFontSize: 20,
  };
  const dark = {
    coordinate: "sample/ready/desktop/dark",
    scheme: "dark" as const,
    rootFontSize: 20,
  };
  const ocean = {
    coordinate: "sample/ocean/desktop/light",
    scheme: "light" as const,
    theme: "ocean",
    rootFontSize: 20,
  };
  const declarations = [
    token("--color-brand", "#123456", "color"),
    token("--color-alias", "var(--color-brand)", "color"),
    { ...token("--color-brand", "#abcdef", "color"), theme: "dark" },
    { ...token("--color-brand", "#124455", "color"), theme: "ocean" },
    token("--color-unused", "#ff0000", "color"),
  ].map((t) => ({
    ...t,
    environment: {
      "--color-brand":
        t.theme === "dark"
          ? "#abcdef"
          : t.theme === "ocean"
            ? "#124455"
            : "#123456",
    },
  }));
  const input: DriftInput = {
    status: "available",
    declarations,
    contexts: [light, dark, ocean],
    limitations: [],
    facts: [
      {
        ...light,
        kind: "color",
        value: "#123456",
        count: 1,
        selectors: ["#light"],
      },
      {
        ...dark,
        kind: "color",
        value: "#abcdef",
        count: 1,
        selectors: ["#dark"],
      },
      {
        ...dark,
        kind: "color",
        value: "#123456",
        count: 1,
        selectors: ["#wrong-theme"],
      },
      {
        ...ocean,
        kind: "color",
        value: "#124455",
        count: 1,
        selectors: ["#ocean"],
      },
    ],
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<body></body>");
    const result = await page.evaluate<ReturnType<typeof compareValueDrift>>(
      `(${compareValueDrift.toString()})(${JSON.stringify(input)},${normalizeCssValues.toString()})`,
    );
    // The root alias still declares that literal colour in dark too, so isolate the override assertion.
    input.declarations = input.declarations.filter(
      (t) => t.name !== "--color-alias",
    );
    const scoped = await page.evaluate<ReturnType<typeof compareValueDrift>>(
      `(${compareValueDrift.toString()})(${JSON.stringify(input)},${normalizeCssValues.toString()})`,
    );
    expect(scoped.uncovered.join("\n")).toContain("#wrong-theme");
    expect(scoped.uncovered.join("\n")).not.toContain("#light");
    expect(scoped.uncovered.join("\n")).not.toContain("#ocean");
    expect(result.notObserved.some((s) => s.includes("--color-alias"))).toBe(
      false,
    );
    expect(result.notObserved.join("\n")).toContain("--color-unused");
  } finally {
    await browser.close();
  }
});

test("local imports retain cascade overrides and dependent conflicts stay unresolved", async () => {
  const root = await temporary();
  await writeFile(join(root, "base.css"), ":root{--space-card:4px}");
  await writeFile(
    join(root, "style.css"),
    '@import "./base.css";:root{--space-card:8px;--space-alias:var(--space-card)}',
  );
  let extracted = await extractSources(root);
  expect(
    extracted.tokens.find((t) => t.source.path === "base.css")?.reason,
  ).toContain("Overridden");
  expect(
    extracted.tokens.find(
      (t) => t.source.path === "style.css" && t.name === "--space-card",
    )?.reason,
  ).toBeUndefined();
  await writeFile(join(root, "other.css"), ":root{--space-card:11px}");
  extracted = await extractSources(root);
  expect(
    extracted.tokens.find((t) => t.name === "--space-alias")?.reason,
  ).toContain("dependency");
  await writeFile(
    join(root, "tokens.json"),
    JSON.stringify({
      spacing: {
        $type: "dimension",
        $root: { $value: { value: 8, unit: "px" } },
        alias: { $value: "{spacing.$root}" },
      },
    }),
  );
  expect((await extractSources(root)).tokens).toContainEqual(
    expect.objectContaining({ name: "spacing.alias", resolved: "8px" }),
  );
});

test("narrow JSON set/insert preserves unrelated bytes", () => {
  const input =
    '{ "kept"  : [1,  2], "checks": {"scales": {"spacing": [3]}} }\n';
  const edited = setJsonValue(input, ["checks", "scales", "spacing"], [3, 8]);
  expect(edited).toContain('"kept"  : [1,  2]');
  expect(JSON.parse(edited as string).checks.scales.spacing).toEqual([3, 8]);
  expect(
    JSON.parse(setJsonValue(input, ["design", "tokens"], []) as string).design
      .tokens,
  ).toEqual([]);
});

test("legacy style gaps cannot classify radius or height declarations as not observed", async () => {
  const project = await config(await fixture());
  const declarations = [
    token("--radius", "6px", "radius"),
    token("--control-height", "32px", "control-height"),
    token("--space-card", "8px"),
  ];
  const tuple = {
    flow: "sample",
    state: "ready",
    viewport: "desktop",
    colorScheme: "light",
    observations: { version: 1, elements: [] },
  } as unknown as CheckTuple;
  const input = collectDrift({
    tuples: [tuple],
    project,
    declarations,
    runId: "legacy",
    capturedAt: "2026-01-01",
  });
  expect(input.contexts[0]?.unavailableKinds).toEqual([
    "spacing",
    "radius",
    "control-height",
  ]);
  const result = compareValueDrift(input, () => {
    throw new Error("Unavailable categories must not normalize");
  });
  expect(result.notObserved).toEqual([]);
  expect(result.unresolved.join("\n")).toContain("coverage unavailable");
});

test("CSS colour keywords are typed without guessing bare numeric channels or font names", () => {
  for (const value of ["rebeccapurple", "LightSlateGrey", "tomato"])
    expect(cssKind("--brand", value)).toBe("color");
  expect(cssKind("--channels", "210 50% 20%")).toBe("other");
  expect(cssKind("--family", "Inter")).toBe("other");
});

test("file-only captures retain conditional and .dark token coverage until inline rules are configured", async () => {
  const root = await temporary();
  await writeFile(
    join(root, "tokens.css"),
    ":root{--bg:#fff;--radius:4px} @media (prefers-color-scheme: dark){:root{--bg:#000}} .dark{--fg:#111}",
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ colorScheme: "dark" });
    await page.setContent(
      '<body><p id="dark" style="color:#000">Dark</p><p id="class-dark" style="color:#111">Class dark</p><p id="off" style="color:#123456">Off token</p></body>',
    );
    for (const inline of [undefined, []]) {
      const observed = await observePage(
        page,
        await loadTokenDeclarations(root, "tokens.css", inline),
      );
      expect(observationArtifactSchema.parse(observed)).toEqual(observed);
      expect(observed.tokens).toMatchObject({
        status: "configured",
        normalizedValues: [
          "4px",
          "rgb(0, 0, 0)",
          "rgb(17, 17, 17)",
          "rgb(255, 255, 255)",
        ],
      });
      expect(
        observed.tokens.status === "configured" && observed.tokens.typedValues,
      ).toBeUndefined();
      const checked = tokenDriftCheck.run({
        tuple: { observations: observed } as CheckTuple,
        config: checksConfigFrom(),
        narrowViewport: false,
      });
      expect(checked.candidates.map((c) => c.selectorHint)).toEqual([
        "#off::color",
      ]);
    }
    const optedIn = await normalizeTokenDeclarations(
      page,
      await loadTokenDeclarations(root, "tokens.css", [
        token("--learned-color", "#123456", "color"),
      ]),
    );
    expect(
      optedIn.status === "configured" && optedIn.typedValues,
    ).toContainEqual(
      expect.objectContaining({
        kind: "color",
        name: "--learned-color",
        value: "rgb(18, 52, 86)",
      }),
    );
  } finally {
    await browser.close();
  }
});

test("a v3 extend fixture learns its declared brand without importing inherited defaults into scales or drift", async () => {
  const root = await fixture("tailwind-v3-extend");
  const path = join(root, ".idiom", "project.json");
  const extraction = await extractSources(root);
  const defaults = extraction.tokens.filter((t) => t.default);
  expect(defaults.length).toBeGreaterThan(300);
  expect(
    extraction.tokens.filter((t) => !t.default).map((t) => t.name),
  ).toEqual(["colors.brand"]);
  const draft = await draftSystemLearning(
    await readFile(path, "utf8"),
    extraction,
  );
  const proposed = projectSchema.parse(JSON.parse(draft.after));
  expect(proposed.design.tokens?.map((t) => t.name)).toEqual(["colors.brand"]);
  expect(proposed.checks.scales).toMatchObject({
    spacing: [],
    controlHeights: [],
    radius: { control: [], card: [], panel: [], chip: [] },
    border: { control: ["rgb(18, 52, 86)"], divider: ["rgb(18, 52, 86)"] },
  });
  expect(draft.summary.join("\n")).toContain(
    `omitted ${defaults.length} inherited Tailwind defaults`,
  );
  expect(draft.diff.split("\n").length).toBeLessThan(100);
  const applied = await runSystemLearning(root, {
    yes: true,
    dependencies: { write: () => {} },
  });
  expect(applied.outcome).toBe("applied");
  expect(applied.model.drift?.declarations.map((t) => t.name)).toEqual([
    "colors.brand",
  ]);
  expect(applied.draft.diff).toBe(draft.diff);
  expect(
    (
      await runSystemLearning(root, {
        yes: true,
        dependencies: { write: () => {} },
      })
    ).outcome,
  ).toBe("no-changes");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(await readFile(join(root, "index.html"), "utf8"));
    const observations = await observePage(page, { status: "not-configured" });
    const tuple = {
      flow: "sample",
      state: "ready",
      viewport: "desktop",
      colorScheme: "light",
      observations,
    } as CheckTuple;
    const input = collectDrift({
      tuples: [tuple],
      project: proposed,
      declarations: proposed.design.tokens ?? [],
      runId: "extend-defaults",
      capturedAt: "2026-10-25",
    });
    const drift = await page.evaluate<ReturnType<typeof compareValueDrift>>(
      `(${compareValueDrift.toString()})(${JSON.stringify(input)},${normalizeCssValues.toString()})`,
    );
    expect(drift.uncovered.join("\n")).toContain("rgb(255, 0, 0)");
    expect(drift.notObserved).toEqual([]);
    expect(drift.unconfigured).toEqual([
      "spacing: no declared tokens",
      "radius: no declared tokens",
      "control-height: no declared tokens",
    ]);
  } finally {
    await browser.close();
  }
});

test("function-valued theme extensions retain only returned project keys and explicit references", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "tailwind.config.cjs"),
    `module.exports={content:[],presets:[{theme:{extend:{borderRadius:()=>({button:'6px'})}}}],theme:{extend:{colors:({colors})=>({brand:colors.blue[500]}),spacing:{4:'1rem'}}}}`,
  );
  const extraction = await extractSources(root);
  expect(
    extraction.tokens
      .filter((t) => !t.default)
      .map((t) => t.name)
      .sort(),
  ).toEqual(["borderRadius.button", "colors.brand", "spacing.4"]);
  expect(extraction.tokens).toContainEqual(
    expect.objectContaining({
      name: "colors.brand",
      value: "#3b82f6",
      default: false,
    }),
  );
  expect(extraction.tokens).toContainEqual(
    expect.objectContaining({ name: "colors.blue.500", default: true }),
  );
  const draft = await draftSystemLearning(
    await readFile(join(root, ".idiom", "project.json"), "utf8"),
    extraction,
  );
  const proposed = projectSchema.parse(JSON.parse(draft.after));
  expect(proposed.design.tokens).toHaveLength(3);
  expect(proposed.checks.scales.spacing).toEqual([16]);
  expect(proposed.checks.scales.radius.control).toEqual([6]);
  expect(proposed.checks.scales.border.control).toEqual(["rgb(59, 130, 246)"]);
});
