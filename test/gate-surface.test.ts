import { expect, test } from "vitest";
import {
  moduleClassMatches,
  surfaceMatches,
} from "../src/capture/rendered-surface.js";
import { renderGateTimingLine } from "../src/capture/timings.js";
import {
  lineBreakpoints,
  orderSchemes,
  orderViewports,
} from "../src/gate/classify.js";
import { hostFactor } from "../src/gate/estimate.js";
import {
  controlsNearSurface,
  deriveRenderedSurface,
} from "../src/gate/evidence.js";
import { classifyStateSurface } from "../src/gate/plan.js";
import { changedLineRanges, fileSurface } from "../src/gate/surface.js";

const css = `:root {
  --accent: #1f4fd1;
}

.toolbar {
  display: flex;
}

.button,
.button:hover {
  color: #1f2933;
}
`;

test("a changed declaration yields its rule's classes; a :root change is unidentified", async () => {
  const body = await fileSurface("components/Panel.css", css, [
    { start: 11, end: 11 },
  ]);
  expect(body.identified).toBe(true);
  expect(body.tokens).toEqual([
    { kind: "class", value: "button", file: "components/Panel.css" },
    {
      kind: "sheet",
      value: "components/Panel.css",
      file: "components/Panel.css",
    },
  ]);
  const root = await fileSurface("components/Panel.css", css, [
    { start: 2, end: 2 },
  ]);
  expect(root).toMatchObject({
    identified: false,
    reason: "change is not scoped to a class or id",
  });
});

test("a CSS module tags its classes with the module stem", async () => {
  const surface = await fileSurface("components/Toolbar.module.css", css, [
    { start: 6, end: 6 },
  ]);
  expect(surface.tokens[0]).toEqual({
    kind: "module",
    value: "toolbar",
    stem: "Toolbar",
    file: "components/Toolbar.module.css",
  });
});

const tsx = `import styles from "./Toolbar.module.css";

export function Helper() {
  return <span className="helper-text">help</span>;
}

export function Toolbar() {
  return (
    <div className={styles.toolbar} data-testid="text-toolbar" id="fmt">
      <button className={\`tool-button \${active}\`} />
      <i className={styles["icon"]} />
    </div>
  );
}
`;

test("TSX: only the changed statement's component, classes, ids, test ids and module keys", async () => {
  const surface = await fileSurface("components/Toolbar.tsx", tsx, [
    { start: 9, end: 10 },
  ]);
  const shown = surface.tokens.map((token) =>
    token.kind === "module"
      ? `${token.kind}:${token.stem}.${token.value}`
      : `${token.kind}:${token.value}`,
  );
  expect(shown).toEqual(
    expect.arrayContaining([
      "component:Toolbar",
      "module:Toolbar.toolbar",
      "module:Toolbar.icon",
      "testId:text-toolbar",
      "id:fmt",
      "class:tool-button",
    ]),
  );
  // Helper sits outside the changed range.
  expect(shown).not.toContain("component:Helper");
  expect(shown).not.toContain("class:helper-text");
});

test("generic utility classes are dropped; a utilities-only change is unidentified", async () => {
  const source = `export const x = <div className="flex grid md:hidden" />;\n`;
  const surface = await fileSurface("lib/x.tsx", source, "whole");
  expect(surface).toMatchObject({
    identified: false,
    reason: "only generic utility classes changed",
  });
});

test("diff hunks map to new-side ranges; a pure deletion marks its neighbours", async () => {
  const diff = [
    "diff --git a/a.css b/a.css",
    "--- a/a.css",
    "+++ b/a.css",
    "@@ -3,2 +3,3 @@",
    "@@ -10 +11,0 @@",
    "diff --git a/gone.css b/gone.css",
    "--- a/gone.css",
    "+++ /dev/null",
  ].join("\n");
  const { ranges, deleted } = await changedLineRanges({
    repository: ".",
    base: "HEAD",
    paths: ["a.css", "gone.css", "new.css"],
    untracked: ["new.css"],
    diff,
  });
  expect(ranges.get("a.css")).toEqual([
    { start: 3, end: 5 },
    { start: 11, end: 12 },
  ]);
  expect(ranges.get("new.css")).toBe("whole");
  expect([...deleted]).toEqual(["gone.css"]);
});

test("CSS-module class shapes match their key; look-alikes do not", () => {
  for (const name of [
    "toolbar",
    "Toolbar_toolbar__k3x9",
    "_toolbar_1x2y3_4",
    "Toolbar-module__toolbar___abc12",
  ])
    expect(moduleClassMatches(name, "toolbar"), name).toBe(true);
  // A different word, a single-dash compound and a hashless BEM name.
  for (const name of ["toolbarish", "my-toolbar-x", "page__toolbar"])
    expect(moduleClassMatches(name, "toolbar"), name).toBe(false);
});

test("surfaceMatches: exact classes, ids, test ids, components and sheet suffixes", () => {
  const rendered = {
    classes: ["card", "Toolbar_button__p7q2"],
    ids: ["fmt"],
    testIds: ["text-toolbar"],
    components: ["Toolbar"],
    sheets: ["/src/components/Panel.css"],
  };
  expect(
    surfaceMatches(rendered, [
      { kind: "class", value: "card" },
      { kind: "class", value: "car" },
      { kind: "module", value: "button", stem: "Toolbar" },
      { kind: "id", value: "fmt" },
      { kind: "testId", value: "text-toolbar" },
      { kind: "component", value: "Toolbar" },
      { kind: "component", value: "Canvas" },
      { kind: "sheet", value: "components/Panel.css" },
    ]),
  ).toEqual([
    ".card",
    ".Toolbar.button",
    "#fmt",
    "[data-testid=text-toolbar]",
    "<Toolbar>",
    "sheet:components/Panel.css",
  ]);
});

test("an older observation without an inventory still yields classes, ids and sheets", () => {
  const derived = deriveRenderedSurface({
    elements: [
      {
        selector: "#editor > div.Toolbar_toolbar__k3x9",
        attributes: { class: "Toolbar_toolbar__k3x9 shadow" },
        styleSources: {
          color: { sheet: "/assets/app.css" },
          margin: { sheet: "<style>[0]" },
        },
      },
    ],
  });
  expect(derived).toEqual({
    version: 1,
    classes: ["Toolbar_toolbar__k3x9", "shadow"],
    ids: ["editor"],
    testIds: [],
    components: [],
    sheets: ["/assets/app.css"],
  });
});

const evidence = (classes: string[], derived = false) => ({
  runId: "run-1",
  derived,
  elements: [],
  surface: {
    version: 1 as const,
    classes,
    ids: [],
    testIds: [],
    components: [],
    sheets: [],
  },
});
const toolbarFile = {
  path: "components/Toolbar.module.css",
  identified: true,
  tokens: [
    {
      kind: "module" as const,
      value: "button",
      stem: "Toolbar",
      file: "components/Toolbar.module.css",
    },
    {
      kind: "sheet" as const,
      value: "components/Toolbar.module.css",
      file: "components/Toolbar.module.css",
    },
  ],
};

test("a state shows, lacks or cannot tell the changed surface", () => {
  expect(
    classifyStateSurface({
      files: [toolbarFile],
      evidence: evidence(["Toolbar_button__p7q2"]),
    }),
  ).toMatchObject({ status: "shows", matched: [".Toolbar.button"] });
  expect(
    classifyStateSurface({ files: [toolbarFile], evidence: evidence(["x"]) }),
  ).toMatchObject({ status: "absent", runId: "run-1" });
  expect(
    classifyStateSurface({ files: [toolbarFile], evidence: undefined }),
  ).toMatchObject({ status: "unknown" });
  expect(
    classifyStateSurface({
      files: [
        toolbarFile,
        { path: "theme.css", identified: false, tokens: [], reason: "x" },
      ],
      evidence: evidence(["x"]),
    }),
  ).toMatchObject({ status: "unknown" });
  // Component tokens cannot be judged from an older, derived inventory.
  expect(
    classifyStateSurface({
      files: [
        {
          path: "components/Panel.tsx",
          identified: true,
          tokens: [
            { kind: "component", value: "Panel", file: "components/Panel.tsx" },
          ],
        },
      ],
      evidence: evidence(["x"], true),
    }),
  ).toMatchObject({ status: "unknown" });
  // Nor from a rendered inventory that read no component names (production
  // builds, Svelte/Astro, unnamed forwardRef): unknown, never absent.
  const toolbarComponent = {
    path: "components/Toolbar.tsx",
    identified: true,
    tokens: [
      {
        kind: "component" as const,
        value: "Toolbar",
        file: "components/Toolbar.tsx",
      },
    ],
  };
  expect(
    classifyStateSurface({
      files: [toolbarComponent],
      evidence: evidence(["toolbar-root"]),
    }),
  ).toMatchObject({ status: "unknown" });
  // A rendered inventory that sees component names still decides.
  const named = (components: string[]) => ({
    ...evidence(["x"]),
    surface: { ...evidence(["x"]).surface, components },
  });
  expect(
    classifyStateSurface({
      files: [toolbarComponent],
      evidence: named(["Other"]),
    }),
  ).toMatchObject({ status: "absent" });
  expect(
    classifyStateSurface({
      files: [toolbarComponent],
      evidence: named(["Toolbar"]),
    }),
  ).toMatchObject({ status: "shows", matched: ["<Toolbar>"] });
  expect(
    classifyStateSurface({
      files: [toolbarFile],
      evidence: undefined,
      asserted: true,
    }),
  ).toMatchObject({ status: "shows" });
});

test("controls near the surface: inside it, or within the distance", () => {
  const elements = [
    {
      classes: ["Toolbar_toolbar__k3x9"],
      interactive: false,
      selector: "div.t",
      ancestors: [],
      rect: { x: 100, y: 100, width: 200, height: 40 },
    },
    {
      classes: [],
      interactive: true,
      selector: "div.t > button",
      ancestors: ["div.t"],
      rect: { x: 104, y: 104, width: 40, height: 32 },
    },
    {
      classes: [],
      interactive: true,
      selector: "button.near",
      ancestors: [],
      rect: { x: 320, y: 100, width: 40, height: 32 },
    },
    {
      classes: [],
      interactive: true,
      selector: "button.far",
      ancestors: [],
      rect: { x: 900, y: 600, width: 40, height: 32 },
    },
  ];
  const tokens = [{ kind: "module" as const, value: "toolbar" }];
  expect(controlsNearSurface(elements, tokens, 48)).toBe(2);
  expect(
    controlsNearSurface(elements, [{ kind: "class", value: "none" }], 48),
  ).toBeUndefined();
});

test("breakpoints and axis order: likely values first, least likely trimmed first", () => {
  expect(lineBreakpoints("@media (max-width: 640px) {")).toEqual([
    { feature: "max-width", px: 640 },
  ]);
  expect(lineBreakpoints('<div className="p-2 md:flex">')).toEqual([
    { feature: "min-width", px: 768 },
  ]);
  const viewports = [
    { name: "desktop", width: 1280 },
    { name: "tablet", width: 820 },
    { name: "mobile", width: 390 },
    { name: "wide", width: 1600 },
  ];
  expect(
    orderViewports(viewports, [{ feature: "max-width", px: 640 }]),
  ).toEqual(["desktop", "mobile", "wide", "tablet"]);
  expect(
    orderSchemes(["light", "dark"], "light", { prefersDark: true }),
  ).toEqual(["light", "dark"]);
  expect(
    orderSchemes(["dark", "light"], "dark", { prefersLight: true }),
  ).toEqual(["dark", "light"]);
});

test("the gate Timing line breaks down server start, base, captures, probe and checks", () => {
  const base = {
    totalMs: 134_000,
    phases: {
      build: { status: "reused" as const, ms: 0 },
      serverStart: { status: "reused" as const, ms: 0 },
      capture: { status: "measured" as const, ms: 109_000 },
      probe: { status: "measured" as const, ms: 18_000 },
      checks: { status: "measured" as const, ms: 9_400 },
    },
    slowest: "capture" as const,
    probeIncludedInCapture: true as const,
  };
  expect(
    renderGateTimingLine({
      ...base,
      gate: {
        servers: 1,
        serversReused: 0,
        serverStartMs: 6_200,
        baseCaptureMs: 0,
        baseCapture: "baseline",
        captureMs: 91_000,
        probeMs: 18_000,
        checksMs: 9_400,
      },
    }),
  ).toBe(
    "Timing: 2m14s — server start 6.2s (1 server), base capture 0.0s (baseline), captures 1m31s, probe 18s, checks 9.4s; slowest: captures",
  );
  expect(
    renderGateTimingLine({
      ...base,
      gate: {
        servers: 0,
        serversReused: 1,
        serverStartMs: 0,
        baseCaptureMs: 41_000,
        baseCapture: "captured",
        captureMs: 20_000,
        probeMs: 0,
        checksMs: 1_000,
      },
    }),
  ).toBe(
    "Timing: 2m14s — server start reused (1 server), base capture 41s, captures 20s, probe 0.0s, checks 1.0s; slowest: base capture",
  );
});

test("a busy host scales the estimate by load per core over its history's", () => {
  const run = (load: number) =>
    ({
      record: {
        host: { loadStart: [load, 0, 0], loadEnd: [load, 0, 0], coreCount: 10 },
      },
    }) as never;
  expect(hostFactor([run(5)], { load: [30, 0, 0], coreCount: 10 })).toBe(3);
  expect(hostFactor([run(20)], { load: [30, 0, 0], coreCount: 10 })).toBe(1.5);
  expect(hostFactor([], { load: [80, 0, 0], coreCount: 10 })).toBe(4);
  expect(hostFactor([run(5)], { load: null, coreCount: 10 })).toBe(1);
});
