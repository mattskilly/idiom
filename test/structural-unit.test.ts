import { expect, test } from "vitest";
import { alarmAtRestCheck, alarmHue } from "../src/checks/alarm-at-rest.js";
import {
  crossSurfaceNamingCheck,
  normalizeLabel,
  ownLabel,
} from "../src/checks/cross-surface-naming.js";
import { primaryRegionCheck } from "../src/checks/primary-region.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { parseCssColor } from "../src/checks/shared.js";
import type {
  CheckTuple,
  DeterministicCheck,
  ElementSignals,
  ExpandedObservedStyles,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const styles: ExpandedObservedStyles = {
  color: "rgb(17, 24, 39)",
  backgroundColor: "rgb(255, 255, 255)",
  borderTopColor: "rgb(209, 213, 219)",
  borderRightColor: "rgb(209, 213, 219)",
  borderBottomColor: "rgb(209, 213, 219)",
  borderLeftColor: "rgb(209, 213, 219)",
  borderTopWidth: "1px",
  borderRightWidth: "1px",
  borderBottomWidth: "1px",
  borderLeftWidth: "1px",
  outlineColor: "rgb(0, 0, 0)",
  outlineWidth: "0px",
  fill: "none",
  stroke: "none",
  borderTopLeftRadius: "6px",
  borderTopRightRadius: "6px",
  borderBottomRightRadius: "6px",
  borderBottomLeftRadius: "6px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
  display: "inline-flex",
  visibility: "visible",
  opacity: "1",
  fontFamily: "sans-serif",
  fontSize: "14px",
  fontWeight: "400",
  lineHeight: "normal",
  letterSpacing: "normal",
  textAlign: "center",
  textDecorationLine: "none",
  textTransform: "none",
  whiteSpace: "normal",
  wordBreak: "normal",
  paddingTop: "0px",
  paddingRight: "10px",
  paddingBottom: "0px",
  paddingLeft: "10px",
  marginTop: "0px",
  marginRight: "0px",
  marginBottom: "0px",
  marginLeft: "0px",
  gap: "normal",
  flexDirection: "row",
  justifyContent: "center",
  alignItems: "center",
  gridTemplateColumns: "none",
  boxShadow: "none",
  transform: "none",
  zIndex: "auto",
};

let counter = 0;
function element(
  overrides: Partial<Omit<ObservedElementV2, "signals" | "styles">> & {
    signals?: Partial<ElementSignals>;
    styles?: Partial<ExpandedObservedStyles>;
  } = {},
): ObservedElementV2 {
  counter += 1;
  const rect = overrides.rect ?? { x: 0, y: 0, width: 96, height: 32 };
  const {
    signals: signalOverrides,
    styles: styleOverrides,
    ...rest
  } = overrides;
  return {
    selector: `#e${counter}`,
    tag: "button",
    text: "Label",
    visible: true,
    interactive: true,
    enabled: true,
    scrollWidth: rect.width,
    scrollHeight: rect.height,
    clientWidth: rect.width,
    clientHeight: rect.height,
    outOfFlow: false,
    ancestorSelectors: ["#root"],
    hitTestWith: [],
    structuralPath: `html[0]/body[0]/x[${String(counter).padStart(4, "0")}]`,
    directText: "",
    attributes: {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]",
    relativeRect: rect,
    ...rest,
    styles: { ...styles, ...styleOverrides },
    rect,
    signals: {
      role: "button",
      name: "",
      described: false,
      appearance: "auto",
      cursor: "pointer",
      hasGraphic: false,
      lineCount: 1,
      contentBox: rect,
      transition: "all 0s",
      animation: "none 0s",
      focused: false,
      repeatedItem: false,
      ...signalOverrides,
    },
  };
}

function tupleOf(
  elements: ObservedElementV2[],
  options: {
    state?: string;
    viewport?: { name: string; width: number; height: number };
    extra?: Partial<ObservationArtifactV2>;
  } = {},
): CheckTuple {
  const viewport = options.viewport ?? {
    name: "desktop",
    width: 1440,
    height: 900,
  };
  const state = options.state ?? "editor";
  return {
    flow: "studio",
    state,
    viewport: viewport.name,
    width: viewport.width,
    height: viewport.height,
    metadataPath: `${state}/${viewport.name}/metadata.json`,
    artifactPaths: [],
    commit: "abc123",
    createdAt: "2026-10-23T00:00:00.000Z",
    observations: {
      version: 2,
      viewport: { width: viewport.width, height: viewport.height },
      document: {
        scrollWidth: viewport.width,
        scrollHeight: viewport.height,
        clientWidth: viewport.width,
        clientHeight: viewport.height,
      },
      elements,
      headings: [],
      tokens: { status: "not-configured" },
      maskMembership: [],
      ...options.extra,
    },
    console: [],
    mismatches: [],
  };
}

const config = (checks: unknown) =>
  checksConfigFrom(checksConfigSchema.parse(checks));

const run = (
  check: DeterministicCheck,
  tuple: CheckTuple,
  checks: unknown = {},
) => check.run({ tuple, narrowViewport: false, config: config(checks) });

const marks = (
  purpose: NonNullable<
    ObservationArtifactV2["selectorMarks"]
  >[number]["purpose"],
  entries: Record<string, string[]>,
) => ({
  selectorMarks: Object.entries(entries).map(([selector, matches]) => ({
    purpose,
    selector,
    matches,
  })),
});

// primary-region

const region = { primaryRegion: { selector: "main", minShare: 0.65 } };

test("primary-region is skipped unconfigured and unavailable without observations or marks", () => {
  const frame = element({ selector: "#frame", tag: "main" });
  expect(run(primaryRegionCheck, tupleOf([frame])).coverage.status).toBe(
    "skipped",
  );
  const v1: CheckTuple = {
    ...tupleOf([]),
    observations: {
      version: 1,
      viewport: { width: 1440, height: 900 },
      document: {
        scrollWidth: 1440,
        scrollHeight: 900,
        clientWidth: 1440,
        clientHeight: 900,
      },
      elements: [],
      headings: [],
      tokens: { status: "not-configured" },
    },
  };
  expect(run(primaryRegionCheck, v1, region).coverage.status).toBe(
    "unavailable",
  );
  const unmarked = run(primaryRegionCheck, tupleOf([frame]), region);
  expect(unmarked.coverage).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining(
      "recapture after adding checks.primaryRegion",
    ),
  });
});

test("primary-region measures the widest match, clipped to the viewport", () => {
  const narrow = element({
    selector: "#narrow",
    rect: { x: 0, y: 0, width: 400, height: 100 },
  });
  const wide = element({
    selector: "#wide",
    rect: { x: 400, y: 0, width: 600, height: 100 },
  });
  const result = run(
    primaryRegionCheck,
    tupleOf([narrow, wide], {
      extra: marks("primary-region", { main: ["#narrow", "#wide"] }),
    }),
    region,
  );
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.selectorHint).toBe("#wide");
  expect(result.coverage.reason).toBe(
    "#wide is 42% of 1440px (widest of 2 matches for main) (minimum 65%)",
  );

  const bleed = element({
    selector: "#bleed",
    rect: { x: -100, y: 0, width: 1700, height: 100 },
  });
  const clipped = run(
    primaryRegionCheck,
    tupleOf([bleed], { extra: marks("primary-region", { main: ["#bleed"] }) }),
    region,
  );
  expect(clipped.candidates).toEqual([]);
  expect(clipped.coverage.reason).toBe(
    "#bleed is 100% of 1440px (minimum 65%)",
  );

  const none = run(
    primaryRegionCheck,
    tupleOf([], { extra: marks("primary-region", { main: [] }) }),
    region,
  );
  expect(none.coverage).toEqual({
    check: "primary-region",
    status: "ran",
    reason: "main matches nothing",
  });
});

test("primary-region does not flap at the boundary", () => {
  const exact = element({
    selector: "#exact",
    rect: { x: 0, y: 0, width: 1440 * 0.6499, height: 100 },
  });
  expect(
    run(
      primaryRegionCheck,
      tupleOf([exact], {
        extra: marks("primary-region", { main: ["#exact"] }),
      }),
      region,
    ).candidates,
  ).toEqual([]);
});

// alarm-at-rest

const red = "rgb(229, 72, 77)";
const amber = "rgb(245, 158, 11)";
const icon = (
  overrides: Parameters<typeof element>[0] = {},
  alarm: ElementSignals["alarm"] = { context: false },
) =>
  element({
    tag: "i",
    text: "",
    interactive: false,
    ancestorSelectors: ["#root"],
    rect: { x: 0, y: 0, width: 16, height: 16 },
    ...overrides,
    styles: { color: red, ...overrides.styles },
    signals: { alarm, ...overrides.signals },
  });

test("alarm-at-rest is unavailable when icons predate the alarm signal", () => {
  const old = element({ tag: "i", text: "", interactive: false });
  expect(run(alarmAtRestCheck, tupleOf([old])).coverage).toEqual({
    check: "alarm-at-rest",
    status: "unavailable",
    reason: "observations predate alarm signals (recapture)",
  });
});

test("alarm hues: saturated red and amber only", () => {
  const hue = (value: string) =>
    alarmHue(parseCssColor(value) ?? { r: 0, g: 0, b: 0 });
  expect(hue("#f59e0b")).toBe("amber");
  expect(hue("#dc2626")).toBe("red");
  expect(hue("#a11d2b")).toBe("red");
  expect(hue("#8b6b4a")).toBeUndefined(); // desaturated brown
  expect(hue("#2563eb")).toBeUndefined();
  expect(hue("#9aa5b1")).toBeUndefined();
  expect(hue("#fee2e2")).toBeUndefined(); // too light
});

test("alarm-at-rest judges amber only when configured, and only icon-sized monochrome ink", () => {
  const star = icon({ selector: "#star", styles: { color: amber } });
  expect(run(alarmAtRestCheck, tupleOf([star])).candidates).toEqual([]);
  expect(
    run(alarmAtRestCheck, tupleOf([star]), { alarm: { colors: ["#f59e0b"] } })
      .candidates,
  ).toHaveLength(1);
  const logo = icon({
    selector: "#logo",
    rect: { x: 0, y: 0, width: 96, height: 24 },
  });
  expect(run(alarmAtRestCheck, tupleOf([logo])).candidates).toEqual([]);
  const svg = icon({
    selector: "#g",
    tag: "svg",
    styles: { fill: red, stroke: "none" },
  });
  const blue = element({
    selector: "#g-blue",
    tag: "path",
    interactive: false,
    ancestorSelectors: ["#g", "#root"],
    styles: { fill: "rgb(66, 133, 244)", stroke: "none" },
  });
  expect(run(alarmAtRestCheck, tupleOf([svg])).candidates).toHaveLength(1);
  expect(run(alarmAtRestCheck, tupleOf([svg, blue])).candidates).toEqual([]);
});

test("alarm-at-rest: brand colours, context, status text and errorPatterns exempt", () => {
  const plain = icon({ selector: "#plain" });
  expect(run(alarmAtRestCheck, tupleOf([plain])).candidates).toHaveLength(1);
  expect(
    run(alarmAtRestCheck, tupleOf([plain]), { alarm: { brand: ["#e5484d"] } })
      .candidates,
  ).toEqual([]);
  const brown = icon({
    selector: "#brown",
    styles: { color: "rgb(139, 107, 74)" },
  });
  expect(run(alarmAtRestCheck, tupleOf([brown])).candidates).toEqual([]);

  const context = icon({ selector: "#ctx" }, { context: true });
  expect(run(alarmAtRestCheck, tupleOf([context])).candidates).toEqual([]);

  const row = element({
    selector: "#row",
    tag: "p",
    interactive: false,
    text: "Payment failed",
  });
  const inRow = icon({
    selector: "#in-row",
    ancestorSelectors: ["#row", "#root"],
  });
  expect(run(alarmAtRestCheck, tupleOf([row, inRow])).candidates).toEqual([]);

  const custom = element({
    selector: "#custom",
    tag: "p",
    interactive: false,
    text: "Sync paused",
  });
  const inCustom = icon({
    selector: "#in-custom",
    ancestorSelectors: ["#custom", "#root"],
  });
  expect(
    run(alarmAtRestCheck, tupleOf([custom, inCustom])).candidates,
  ).toHaveLength(1);
  expect(
    run(alarmAtRestCheck, tupleOf([custom, inCustom]), {
      errorPatterns: ["sync paused"],
    }).candidates,
  ).toEqual([]);
});

test("alarm-at-rest groups by glyph and names the hint", () => {
  const glyphs = [1, 2].map((index) =>
    icon({
      selector: `#warn${index}`,
      tag: "span",
      directText: "⚠️",
      styles: { color: "rgb(100, 100, 100)" },
    }),
  );
  const hinted = icon(
    { selector: "#hinted", styles: { color: "rgb(100, 100, 100)" } },
    { context: false, iconHint: "lucide lucide-alert-circle" },
  );
  const result = run(alarmAtRestCheck, tupleOf([...glyphs, hinted]));
  expect(
    result.candidates.map((candidate) => candidate.verification.params),
  ).toEqual([{ glyph: "⚠" }, { iconHint: "alert" }]);
  expect(result.candidates[0]?.explanation).toContain("#warn1, #warn2");
});

// cross-surface-naming

test("labels drop separators, whitespace and nested node rows", () => {
  expect(normalizeLabel("  › Stack  › ")).toBe("Stack");
  expect(normalizeLabel("Page / ")).toBe("Page");
  expect(normalizeLabel(" · ")).toBe("");
  const row = element({
    selector: "#row",
    directText: "",
    signals: { nodeId: "stack" },
  });
  const label = element({
    selector: "#row-label",
    directText: "Stack",
    ancestorSelectors: ["#row", "#root"],
  });
  const hidden = element({
    selector: "#row-hidden",
    directText: "›",
    attributes: { "aria-hidden": "true" },
    ancestorSelectors: ["#row", "#root"],
  });
  const hiddenChild = element({
    selector: "#row-hidden-child",
    directText: "secret",
    ancestorSelectors: ["#row-hidden", "#row", "#root"],
  });
  const child = element({
    selector: "#child",
    directText: "",
    signals: { nodeId: "h1" },
    ancestorSelectors: ["#row", "#root"],
  });
  const childLabel = element({
    selector: "#child-label",
    directText: "Heading",
    ancestorSelectors: ["#child", "#row", "#root"],
  });
  const all = [row, label, hidden, hiddenChild, child, childLabel];
  const bySelector = new Map(all.map((entry) => [entry.selector, entry]));
  expect(ownLabel(row, all, bySelector)).toBe("Stack");
  const labelled = { ...row, attributes: { "aria-label": "Stack layer" } };
  expect(ownLabel(labelled, all, bySelector)).toBe("Stack layer");
});

test("cross-surface-naming compares case-insensitively and reports unresolved surfaces", () => {
  const surfaces = {
    naming: { surfaces: { chip: "#chip", toolbar: "#tool" } },
  };
  const chip = element({
    selector: "#chip",
    directText: "Heading",
    signals: { nodeId: "h1" },
  });
  const tool = element({
    selector: "#tool",
    directText: "HEADING",
    signals: { nodeId: "h1" },
  });
  expect(
    run(crossSurfaceNamingCheck, tupleOf([chip, tool])).coverage.status,
  ).toBe("skipped");
  expect(
    run(crossSurfaceNamingCheck, tupleOf([chip, tool]), surfaces).coverage
      .status,
  ).toBe("unavailable");
  const same = run(
    crossSurfaceNamingCheck,
    tupleOf([chip, tool], {
      extra: marks("naming", { "#chip": ["#chip"], "#tool": ["#tool"] }),
    }),
    surfaces,
  );
  expect(same).toEqual({
    coverage: { check: "cross-surface-naming", status: "ran" },
    candidates: [],
  });
  const partial = run(
    crossSurfaceNamingCheck,
    tupleOf([chip, tool], { extra: marks("naming", { "#chip": ["#chip"] }) }),
    surfaces,
  );
  expect(partial.coverage).toEqual({
    check: "cross-surface-naming",
    status: "ran",
    reason:
      "fewer than two naming surfaces resolved; toolbar (#tool) was not resolved at capture (recapture)",
  });
});
