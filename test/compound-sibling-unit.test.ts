import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { compoundControlCheck } from "../src/checks/compound-control.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { siblingChromeCheck } from "../src/checks/sibling-chrome.js";
import type {
  CheckTuple,
  ElementSignals,
  ExpandedObservedStyles,
  ObservedElementV2,
  Rect,
  SelectorMark,
} from "../src/checks/types.js";
import { deterministicCheckIds } from "../src/checks/types.js";
import { findingCategories } from "../src/schemas/finding.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

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
  paddingRight: "8px",
  paddingBottom: "0px",
  paddingLeft: "8px",
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

function element(
  selector: string,
  overrides: Partial<Omit<ObservedElementV2, "signals" | "styles">> & {
    signals?: Partial<ElementSignals>;
    styles?: Partial<ExpandedObservedStyles>;
  } = {},
): ObservedElementV2 {
  const rect = overrides.rect ?? { x: 0, y: 0, width: 100, height: 32 };
  const { signals, styles: styleOverrides, ...rest } = overrides;
  return {
    selector,
    tag: "div",
    text: "",
    visible: true,
    interactive: false,
    enabled: true,
    scrollWidth: rect.width,
    scrollHeight: rect.height,
    clientWidth: rect.width,
    clientHeight: rect.height,
    outOfFlow: false,
    ancestorSelectors: ["#row", "#root"],
    hitTestWith: [],
    structuralPath: selector,
    directText: "",
    attributes: {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]",
    relativeRect: rect,
    ...rest,
    rect,
    styles: { ...styles, ...styleOverrides },
    signals: {
      role: "",
      name: "",
      described: false,
      appearance: "auto",
      cursor: "auto",
      hasGraphic: false,
      lineCount: 1,
      contentBox: rect,
      transition: "all 0s",
      animation: "none 0s",
      focused: false,
      repeatedItem: false,
      ...signals,
    },
  };
}

function tuple(
  elements: ObservedElementV2[],
  extra: Partial<CheckTuple> = {},
  marks?: SelectorMark[],
): CheckTuple {
  return {
    ...invariantTuple({
      ...invariantObservations(),
      elements,
      ...(marks === undefined ? {} : { selectorMarks: marks }),
    }),
    ...extra,
  };
}

const input = (contentBox: Rect = { x: 9, y: 1, width: 82, height: 30 }) =>
  element("#width", {
    tag: "input",
    interactive: true,
    attributes: { type: "number" },
    ancestorSelectors: ["#field", "#row", "#root"],
    signals: { role: "spinbutton", name: "Width", contentBox },
  });
const suffix = (x: number, text = "px", width = 14) =>
  element("#suffix", {
    text,
    directText: text,
    ancestorSelectors: ["#field", "#row", "#root"],
    rect: { x, y: 8, width, height: 16 },
    signals: { textRect: { x, y: 8, width, height: 16 } },
  });
const select = (value: string | undefined, text = "px%auto") =>
  element("#unit", {
    tag: "select",
    interactive: true,
    text,
    rect: { x: 108, y: 0, width: 64, height: 32 },
    signals: {
      role: "combobox",
      name: "Width unit",
      ...(value === undefined ? {} : { value }),
    },
  });

const compound = (elements: ObservedElementV2[], tokenMax = 4) =>
  compoundControlCheck.run({
    tuple: tuple(elements),
    narrowViewport: false,
    config: {
      ...checksConfigFrom(),
      compoundControls: { tokenMax, minInset: 2 },
    },
  });

test("inset rules report crossing, crowding and covering in priority order", () => {
  const crossing = compound([input(), suffix(86)]).candidates;
  expect(crossing).toHaveLength(1);
  expect(crossing[0]).toMatchObject({
    rule: "idiom:compound-control-adornment-inset",
    severity: "major",
    fingerprintHint: "#width | #suffix",
  });
  expect(crossing[0]?.explanation).toContain("crosses the input's border");
  const crowding = compound([input(), suffix(80)]).candidates;
  expect(crowding[0]?.severity).toBe("minor");
  expect(crowding[0]?.explanation).toContain("closer than the 8px");
  const covering = compound([input(), suffix(70)]).candidates;
  expect(covering[0]?.explanation).toContain("content box");
  // Inset by the padding and clear of the content box: not reported.
  expect(
    compound([input({ x: 9, y: 1, width: 62, height: 30 }), suffix(76)])
      .candidates,
  ).toEqual([]);
});

test("duplicate token needs a short select value matching an adjacent adornment", () => {
  const ok = { x: 9, y: 1, width: 62, height: 30 };
  const found = compound([input(ok), suffix(76), select("px")]).candidates;
  expect(found.map((c) => c.rule)).toEqual([
    "idiom:compound-control-duplicate-token",
  ]);
  expect(found[0]?.explanation).toBe(
    'The "Width" field shows "px" twice: in the unit select #unit and as a suffix inside #width; keep one.',
  );
  // A five-character token is past tokenMax.
  expect(
    compound([input(ok), suffix(70, "units", 20), select("units")]).candidates,
  ).toEqual([]);
  expect(
    compound(
      [input(ok), suffix(70, "units", 20), select("units")],
      5,
    ).candidates.map((c) => c.rule),
  ).toContain("idiom:compound-control-duplicate-token");
});

test("a native select without a recorded value asks for a recapture", () => {
  const result = compound([input(), select(undefined)]);
  expect(result.coverage.status).toBe("unavailable");
  expect(result.coverage.reason).toContain("recapture");
});

test("compound-control is skipped by default", () => {
  expect(
    compoundControlCheck.run({
      tuple: tuple([]),
      narrowViewport: false,
      config: checksConfigFrom(),
    }).coverage.status,
  ).toBe("skipped");
});

const region: SelectorMark = {
  purpose: "sibling-region",
  selector: ".left-panel",
  matches: ["#panel"],
};
const toggle = element("#toggle", {
  tag: "button",
  interactive: true,
  ancestorSelectors: ["#panel", "#root"],
  signals: { role: "button", name: "Collapse panel" },
});
const panel = element("#panel");
const state = (
  name: string,
  withToggle: boolean,
  extra: Partial<CheckTuple> = {},
  marks: SelectorMark[] | null = [region],
) =>
  tuple(
    withToggle ? [panel, toggle] : [panel],
    { state: name, siblings: "sibling:left", ...extra },
    marks ?? undefined,
  );
const sibling = (target: CheckTuple, tuples: CheckTuple[]) =>
  siblingChromeCheck.run({
    tuple: target,
    tuples,
    narrowViewport: false,
    config: {
      ...checksConfigFrom(),
      siblingChrome: { regions: [".left-panel"] },
    },
  });

test("a control every sibling shows is missing from one state", () => {
  const ai = state("ai", false);
  const tuples = [state("layers", true), state("add", true), ai];
  const result = sibling(ai, tuples);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    rule: "idiom:sibling-chrome-missing",
    severity: "major",
    selectorHint: "#panel",
    fingerprintHint: "sibling:sibling:left|.left-panel|button|collapse panel",
  });
  for (const other of tuples.slice(0, 2))
    expect(sibling(other, tuples).candidates).toEqual([]);
});

test("sibling-chrome needs two peers at the same viewport and colour scheme", () => {
  const ai = state("ai", false);
  expect(sibling(ai, [state("layers", true), ai]).coverage.status).toBe(
    "skipped",
  );
  expect(
    sibling(ai, [
      state("layers", true),
      state("add", true, { viewport: "mobile" }),
      ai,
    ]).candidates,
  ).toEqual([]);
  expect(
    sibling(ai, [
      state("layers", true),
      state("add", true, { colorScheme: "light" }),
      ai,
    ]).candidates,
  ).toEqual([]);
});

test("sibling-chrome is unavailable without resolved region marks", () => {
  const ai = state("ai", false, {}, null);
  const result = sibling(ai, [state("layers", true), state("add", true), ai]);
  expect(result.coverage.status).toBe("unavailable");
  expect(result.coverage.reason).toContain("recapture");
});

test("checksConfigFrom threads both settings; compoundControls stays off by default", () => {
  expect(checksConfigFrom().compoundControls).toBeUndefined();
  expect(checksConfigFrom().siblingChrome).toEqual({ regions: [] });
  const config = checksConfigFrom(
    checksConfigSchema.parse({
      compoundControls: {},
      siblingChrome: { regions: [".left-panel"] },
    }),
  );
  expect(config.compoundControls).toEqual({ tokenMax: 4, minInset: 2 });
  expect(config.siblingChrome).toEqual({ regions: [".left-panel"] });
  expect(
    checksConfigSchema.safeParse({ compoundControls: { tokenMax: 9 } }).success,
  ).toBe(false);
  for (const id of ["compound-control", "sibling-chrome"] as const) {
    expect(deterministicCheckIds).toContain(id);
    expect(findingCategories).toContain(id);
  }
});

test("artifacts load with and without a select value", () => {
  for (const value of [undefined, "px"]) {
    const artifact = tuple([select(value)], {}, [region]).observations;
    expect(observationArtifactSchema.parse(artifact)).toEqual(artifact);
  }
});

test("metadata sibling declarations load onto tuples; older metadata still loads", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { storedRun } = await import("./stored-run-support.js");
  const { loadCaptureRun } = await import("../src/review/artifacts.js");
  const project = await mkdtemp(join(tmpdir(), "idiom-siblings-"));
  await storedRun(project, "run", "abc123", [
    {
      state: "layers",
      html: "before.html",
      declares: { siblingGroup: "left" },
    },
    { state: "ai", html: "before.html", declares: { group: "panels" } },
    { state: "editor", html: "before.html" },
  ]);
  const { tuples } = await loadCaptureRun({
    runDirectory: join(project, ".idiom", "reports", "run"),
    expectedFlow: "studio-lab",
  });
  expect(
    Object.fromEntries(tuples.map((entry) => [entry.state, entry.siblings])),
  ).toEqual({
    layers: "sibling:left",
    ai: "group:studio-lab:panels",
    editor: undefined,
  });
}, 30_000);
