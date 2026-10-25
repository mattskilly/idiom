import { expect, test } from "vitest";
import type {
  CheckTuple,
  ElementSignals,
  ExpandedObservedStyles,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import { MAX_GEOMETRY_ROWS, surfaceGeometry } from "../src/sweep/geometry.js";

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

test("rows carry size, radius, the nearest gap and contrast", () => {
  const dot = element({
    tag: "span",
    text: "",
    interactive: false,
    rect: { x: 100, y: 10, width: 16, height: 16 },
    attributes: { class: "bp-override-dot", title: "Mobile override" },
    styles: {
      backgroundColor: "rgb(245, 165, 36)",
      borderTopLeftRadius: "999px",
      borderTopRightRadius: "999px",
      borderBottomRightRadius: "999px",
      borderBottomLeftRadius: "999px",
    },
    signals: { role: "generic" },
  });
  const button = element({
    rect: { x: 0, y: 10, width: 90, height: 32 },
    directText: "Save",
    signals: { name: "Save" },
    styles: { color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)" },
  });
  const mixed = element({
    rect: { x: 0, y: 60, width: 90, height: 32 },
    styles: { borderTopLeftRadius: "0px" },
  });
  const geometry = surfaceGeometry(tupleOf([dot, button, mixed]));
  expect(geometry.label).toBe("editor/desktop");
  expect(geometry.unavailable).toBeUndefined();
  const rows = new Map(geometry.rows.map((row) => [row.selector, row]));
  expect(rows.get(dot.selector)).toMatchObject({
    class: "bp-override-dot",
    name: "Mobile override",
    size: "16×16",
    radius: "full",
    gapToNearest: { px: 10, neighbour: button.selector, axis: "horizontal" },
  });
  expect(rows.get(button.selector)).toMatchObject({
    name: "Save",
    size: "90×32",
    radius: "6px",
    contrast: 21,
  });
  expect(rows.get(mixed.selector)).toMatchObject({
    radius: "mixed",
    gapToNearest: { px: 18, neighbour: button.selector, axis: "vertical" },
  });
  // Reading order: y, then x.
  expect(geometry.rows.map((row) => row.selector)).toEqual([
    button.selector,
    dot.selector,
    mixed.selector,
  ]);
});

test("rows are capped and declared components are reported", () => {
  const many = Array.from({ length: MAX_GEOMETRY_ROWS + 5 }, (_, index) =>
    element({ rect: { x: 0, y: index * 40, width: 90, height: 32 } }),
  );
  const geometry = surfaceGeometry(
    tupleOf(many, {
      extra: {
        components: [
          {
            name: "override dot",
            selector: ".bp-override-dot",
            width: 8,
            height: 8,
            tolerance: { ratio: 0.25, px: 4 },
            rects: [{ x: 0, y: 0, width: 16, height: 16, selector: "#d" }],
          },
        ],
      },
    }),
  );
  expect(geometry.rows).toHaveLength(MAX_GEOMETRY_ROWS);
  expect(geometry.omittedRows).toBe(5);
  expect(geometry.components).toEqual([
    {
      name: "override dot",
      selector: ".bp-override-dot",
      expected: "8×8",
      rendered: ["16×16"],
    },
  ]);
});

test("hidden and invisible elements are skipped; old captures say why", () => {
  const hidden = element({ visible: false });
  const visuallyHidden = element({
    outOfFlow: true,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    styles: { overflowX: "hidden", overflowY: "hidden" },
  });
  expect(surfaceGeometry(tupleOf([hidden, visuallyHidden])).rows).toEqual([]);
  const tuple = tupleOf([]);
  const v1: CheckTuple = {
    ...tuple,
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
  expect(surfaceGeometry(v1).unavailable).toMatch(/predate/);
  expect(
    surfaceGeometry({ ...tuple, observations: undefined }).unavailable,
  ).toMatch(/unavailable/);
});
