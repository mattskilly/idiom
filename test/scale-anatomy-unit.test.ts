import { expect, test } from "vitest";
import { controlAnatomyCheck } from "../src/checks/control-anatomy.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { scaleConformanceCheck } from "../src/checks/scale-conformance.js";
import { canonicalColor, parseCssColor } from "../src/checks/shared.js";
import type {
  CheckTuple,
  ElementSignals,
  ExpandedObservedStyles,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import {
  buildDeterministicDrafts,
  dedupeFindingDrafts,
} from "../src/review/findings.js";
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

function radius(value: string) {
  return {
    borderTopLeftRadius: value,
    borderTopRightRadius: value,
    borderBottomRightRadius: value,
    borderBottomLeftRadius: value,
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

const config = (checks: unknown = {}) =>
  checksConfigFrom(checksConfigSchema.parse(checks));

function scale(tuples: CheckTuple[], checks: unknown = {}) {
  const settings = config(checks);
  return tuples.map((tuple) =>
    scaleConformanceCheck.run({
      tuple,
      tuples,
      narrowViewport: false,
      config: settings,
    }),
  );
}

const values = (tuples: CheckTuple[], checks: unknown = {}) =>
  scale(tuples, checks)
    .flatMap(({ candidates }) => candidates)
    .map((candidate) => ({
      rule: candidate.rule,
      ...(candidate.verification.params as { property: string; value: string }),
    }));

test("radius classification: 9999px and a square 50% are full, a rectangle's 50% is an ellipse, mixed corners take the largest", () => {
  const tuple = tupleOf([
    element({ selector: "#pill", styles: radius("9999px") }),
    element({
      selector: "#circle",
      rect: { x: 0, y: 0, width: 32, height: 32 },
      styles: radius("50%"),
    }),
    element({ selector: "#ellipse", styles: radius("50%") }),
    element({
      selector: "#mixed",
      styles: { ...radius("2px"), borderTopRightRadius: "10px" },
    }),
    element({ selector: "#square", styles: radius("0px") }),
  ]);
  const found = values([tuple], {
    scales: { radius: { control: [6] } },
  }).filter(({ property }) => property === "radius");
  expect(found.map(({ value }) => value).sort()).toEqual([
    "0px",
    "10px",
    "50% (ellipse)",
    "full",
  ]);
  const full = scale([tuple], { scales: { radius: { control: [6] } } })
    .flatMap(({ candidates }) => candidates)
    .find(
      (candidate) => candidate.fingerprintHint === "scale:radius:control:full",
    );
  expect(full?.explanation).toContain("2 buttons at radius full");
  // A declared "full" accepts both the pill and the circle.
  expect(
    values([tuple], { scales: { radius: { control: [6, "full"] } } })
      .filter(({ property }) => property === "radius")
      .map(({ value }) => value),
  ).not.toContain("full");
});

test.each([
  { declared: 20, rejected: ["#large", "#other", "#percent"] },
  { declared: 9999, rejected: ["#pill", "#near", "#other", "#percent"] },
  { declared: "full", rejected: [] },
])(
  "numeric pill tokens and full remain distinct alternatives ($declared)",
  ({ declared, rejected }) => {
    const pill = (selector: string, corner: string, width = 120) =>
      element({
        selector,
        rect: { x: 0, y: 0, width, height: 40 },
        styles: radius(corner),
      });
    const [result] = scale(
      [
        tupleOf([
          pill("#pill", "20px"),
          pill("#near", "20.4px"),
          pill("#large", "9999px"),
          pill("#other", "21px"),
          pill("#percent", "50%", 40),
        ]),
      ],
      { scales: { radius: { control: [declared] } } },
    );
    if (rejected.length === 0) expect(result?.candidates).toEqual([]);
    else {
      expect(result?.candidates).toHaveLength(1);
      expect(result?.candidates[0]?.explanation).toContain(
        `${rejected.length} buttons at radius full`,
      );
      for (const selector of rejected.slice(0, 3))
        expect(result?.candidates[0]?.explanation).toContain(selector);
    }
  },
);

test("a non-focusable ARIA control still excludes its nested controls", () => {
  const outer = element({
    selector: "#outer",
    tag: "div",
    interactive: false,
    signals: { role: "option" },
  });
  const nested = element({
    selector: "#nested",
    tag: "div",
    interactive: false,
    ancestorSelectors: ["#outer", "#root"],
    rect: { x: 0, y: 0, width: 60, height: 50 },
    signals: { role: "button" },
  });
  expect(
    values([tupleOf([outer, nested])], { scales: { controlHeights: [32] } }),
  ).toEqual([]);
});

test("colours parse from hex and rgb() and match declared values within tolerance", () => {
  expect(parseCssColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
  expect(parseCssColor("#E5E7EB")).toEqual({ r: 229, g: 231, b: 235, a: 1 });
  expect(parseCssColor("#00000080")?.a).toBeCloseTo(0.502, 2);
  expect(parseCssColor("rgba(1, 2, 3, 0.5)")).toEqual({
    r: 1,
    g: 2,
    b: 3,
    a: 0.5,
  });
  expect(parseCssColor("tomato")).toBeUndefined();
  expect(canonicalColor("#8A919F")).toBe("rgb(138, 145, 159)");

  const divider = (selector: string, color: string) =>
    element({
      selector,
      tag: "div",
      text: "",
      interactive: false,
      signals: { role: "", lineCount: 0 },
      styles: {
        borderTopWidth: "0px",
        borderRightWidth: "0px",
        borderLeftWidth: "0px",
        borderBottomColor: color,
      },
    });
  const found = values(
    [
      tupleOf([
        divider("#near", "rgb(231, 232, 236)"),
        divider("#exact", "rgb(229, 231, 235)"),
        divider("#dark", "rgb(138, 145, 159)"),
      ]),
    ],
    { scales: { border: { divider: ["#E5E7EB"] } } },
  );
  expect(found).toEqual([
    expect.objectContaining({
      rule: "idiom:off-scale-border",
      value: "rgb(138, 145, 159)",
    }),
  ]);
});

test("configured role selectors replace the defaults; an unresolved role is disclosed", () => {
  const tag = element({
    selector: "#tag",
    tag: "span",
    interactive: false,
    signals: { role: "" },
    styles: radius("4px"),
  });
  const marked = tupleOf([tag], {
    extra: {
      selectorMarks: [
        { purpose: "scale-chip", selector: ".tag", matches: ["#tag"] },
      ],
    },
  });
  const checks = {
    scales: { radius: { chip: ["full"] }, roles: { chip: [".tag"] } },
  };
  const [result] = scale([marked], checks);
  expect(result?.coverage).toEqual({
    check: "scale-conformance",
    status: "ran",
  });
  expect(result?.candidates[0]?.explanation).toContain(
    "1 chip at radius 4px; scale is full (checks.scales.radius.chip)",
  );

  const [old] = scale([tupleOf([tag])], checks);
  expect(old?.coverage).toEqual({
    check: "scale-conformance",
    status: "ran",
    reason: "checks.scales.roles.chip was not resolved at capture; recapture",
  });
  expect(old?.candidates).toEqual([]);
});

test("replayed role selectors ignore removed marks and disclose missing additions", () => {
  const tuple = tupleOf(
    [
      element({ selector: "#old", styles: radius("4px") }),
      element({ selector: "#new", styles: radius("6px") }),
    ],
    {
      extra: {
        selectorMarks: [
          { purpose: "scale-chip", selector: "#old", matches: ["#old"] },
          { purpose: "scale-card", selector: "#new", matches: ["#new"] },
          { purpose: "scale-chip", selector: ".empty", matches: [] },
        ],
      },
    },
  );
  const review = (selectors: string[]) =>
    scale([tuple], {
      scales: { radius: { chip: [6] }, roles: { chip: selectors } },
    })[0];
  const replacement = review(["#new"]);
  expect(replacement?.candidates).toEqual([]);
  expect(replacement?.coverage.reason).toContain("recapture");

  const addition = review(["#old", "#new"]);
  expect(addition?.candidates).toHaveLength(1);
  expect(addition?.candidates[0]?.selectorHint).toBe("#old");
  expect(addition?.coverage.reason).toContain("recapture");

  const resolvedEmpty = review([".empty"]);
  expect(resolvedEmpty?.candidates).toEqual([]);
  expect(resolvedEmpty?.coverage.reason).toBeUndefined();

  const unchanged = review(["#old"]);
  expect(unchanged?.candidates).toHaveLength(1);
  expect(unchanged?.coverage.reason).toBeUndefined();
});

test("one finding per off-scale value across viewports and states, with every tuple as evidence", () => {
  const scene = () => [
    element({
      selector: "#ok",
      structuralPath: "html[0]/body[0]/button[0]",
      rect: { x: 0, y: 0, width: 80, height: 32 },
    }),
    element({
      selector: "#tall",
      structuralPath: "html[0]/body[0]/button[1]",
      rect: { x: 0, y: 40, width: 80, height: 50 },
    }),
  ];
  const desktop = tupleOf(scene());
  const mobile = tupleOf(scene(), {
    viewport: { name: "mobile", width: 390, height: 844 },
  });
  const open = tupleOf(scene(), { state: "menu-open" });
  const tuples = [mobile, open, desktop];
  const results = scale(tuples, { scales: { controlHeights: [32] } });
  const candidates = results.flatMap(({ candidates }) => candidates);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.explanation).toContain(
    "1 button at 50px; scale is 32 (checks.scales.controlHeights)",
  );
  expect(candidates[0]?.evidenceTuples).toHaveLength(3);
  // The owning tuple is the first in stable order, not the first passed.
  expect(results[2]?.candidates).toHaveLength(1);

  const run = runDeterministicChecks(
    tuples,
    undefined,
    config({ scales: { controlHeights: [32] } }),
  );
  const drafts = dedupeFindingDrafts(
    buildDeterministicDrafts({
      runId: "scale",
      entries: run.candidates.filter(
        ({ candidate }) => candidate.category === "scale-conformance",
      ),
    }),
  );
  expect(drafts).toHaveLength(1);
});

test("undeclared scales report only sharp outliers against a supported prevailing value", () => {
  const buttons = (heights: number[]) =>
    heights.map((height, index) =>
      element({ rect: { x: index * 100, y: 0, width: 80, height } }),
    );
  const heights = (list: number[]) =>
    values([tupleOf(buttons(list))]).filter(
      ({ property }) => property === "height",
    );
  expect(heights([32, 32, 32, 32, 32, 32, 72])).toEqual([
    expect.objectContaining({ rule: "idiom:scale-outlier", value: "72px" }),
  ]);
  expect(heights([24, 24, 24, 24])).toEqual([]);
  expect(heights([32, 32, 40, 40])).toEqual([]);
  // 36 is off the prevailing 32 but not sharply.
  expect(heights([32, 32, 32, 32, 36])).toEqual([]);
});

test("control shadows: a sharp minority is an outlier; unauthored and focused shadows stay quiet", () => {
  const raised = "rgba(0, 0, 0, 0.2) 0px 1px 2px 0px";
  const flat = "rgba(0, 0, 0, 0.6) 0px 0px 0px 3px";
  const button = (
    shadow: string,
    options: { authored?: boolean; focused?: boolean } = {},
  ) =>
    element({
      styles: { boxShadow: shadow },
      ...(options.authored === false
        ? {}
        : { authoredProperties: ["boxShadow"] }),
      signals: { focused: options.focused === true },
    });
  const shadows = (elements: ObservedElementV2[]) =>
    scale([tupleOf(elements)])
      .flatMap(({ candidates }) => candidates)
      .filter(
        (candidate) =>
          (candidate.verification.params as { property: string }).property ===
          "shadow",
      );
  const prevailing = [raised, raised, raised, raised].map((shadow) =>
    button(shadow),
  );
  const outlier = button(flat);
  const [finding, ...rest] = shadows([...prevailing, outlier]);
  expect(rest).toEqual([]);
  expect(finding).toMatchObject({
    rule: "idiom:scale-outlier",
    verification: {
      params: {
        property: "shadow",
        role: "control",
        value: flat,
        prevailing: raised,
        targets: [{ selector: outlier.selector, property: "boxShadow" }],
      },
    },
  });
  expect(finding?.explanation).toContain(`1 control shadow at shadow ${flat}`);
  expect(shadows([...prevailing, button(flat, { authored: false })])).toEqual(
    [],
  );
  expect(shadows([...prevailing, button(flat, { focused: true })])).toEqual([]);
});

test("v1 and signal-less artifacts leave both checks unavailable", () => {
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
  const { signals: _, ...bare } = element();
  const signalless = tupleOf([bare as ObservedElementV2]);
  for (const tuple of [v1, signalless]) {
    for (const check of [scaleConformanceCheck, controlAnatomyCheck])
      expect(
        check.run({
          tuple,
          tuples: [tuple],
          narrowViewport: false,
          config: config(),
        }).coverage.status,
      ).toBe("unavailable");
  }
});

const anatomy = (elements: ObservedElementV2[], extra = {}) =>
  controlAnatomyCheck.run({
    tuple: tupleOf(elements, { extra }),
    narrowViewport: false,
    config: config(),
  });

test("a select-like without the adornment signal or a child chevron is unavailable (pre-signal capture)", () => {
  const select = element({
    selector: "#font",
    tag: "select",
    signals: { role: "combobox", appearance: "none" },
  });
  expect(anatomy([select]).coverage).toEqual({
    check: "control-anatomy",
    status: "unavailable",
    reason: "observations predate the select chevron signal (recapture)",
  });
  const measured = element({
    selector: "#font",
    tag: "select",
    rect: { x: 0, y: 0, width: 120, height: 28 },
    signals: {
      role: "combobox",
      appearance: "none",
      lineCount: 0,
      adornment: {
        status: "measured",
        source: "background",
        rect: { x: 102, y: 13, width: 10, height: 10 },
      },
    },
  });
  const result = anatomy([measured]);
  expect(result.coverage.status).toBe("ran");
  expect(result.candidates[0]?.explanation).toBe(
    "The chevron in #font sits 4px below the vertical centre of its 28px box (tolerance 1px).",
  );
  const unmeasured = anatomy([
    element({
      tag: "select",
      signals: {
        role: "combobox",
        appearance: "none",
        adornment: { status: "unmeasured", reason: "pseudo-element chevron" },
      },
    }),
  ]);
  expect(unmeasured.coverage).toEqual({
    check: "control-anatomy",
    status: "ran",
    reason:
      "1 select chevron could not be measured (pseudo-element or unparsed background)",
  });
});

test("an icon button's icon is compared with the box centre; a centred one is quiet", () => {
  const scene = (iconY: number) => {
    const button = element({
      selector: "#close",
      text: "",
      rect: { x: 0, y: 0, width: 28, height: 28 },
      signals: {
        lineCount: 0,
        renderedContent: { text: false, directText: false, graphic: true },
      },
    });
    const icon = element({
      selector: "#close > svg",
      tag: "svg",
      text: "",
      interactive: false,
      ancestorSelectors: ["#close", "#root"],
      rect: { x: 7, y: iconY, width: 14, height: 14 },
      signals: { role: "", lineCount: 0 },
    });
    return [button, icon];
  };
  expect(anatomy(scene(7)).candidates).toEqual([]);
  expect(anatomy(scene(9)).candidates).toEqual([
    expect.objectContaining({
      rule: "idiom:icon-off-centre",
      selectorHint: "#close",
      explanation:
        "The icon in #close sits 2px below the vertical centre of its 28px box (tolerance 1px).",
    }),
  ]);
});

test("a trailing glyph chevron wins over a leading graphic", () => {
  const control = element({
    selector: "#fit",
    text: "Fit ▾",
    signals: {
      haspopup: "listbox",
      inkCenterY: 16,
      adornment: { status: "none" },
      renderedContent: { text: true, directText: true, graphic: true },
    },
  });
  const leading = element({
    selector: "#leading",
    tag: "svg",
    text: "",
    interactive: false,
    ancestorSelectors: ["#fit", "#root"],
    rect: { x: 8, y: 9, width: 14, height: 14 },
    signals: { role: "", lineCount: 0 },
  });
  const glyph = element({
    selector: "#chevron",
    tag: "span",
    text: "▾",
    directText: "▾",
    interactive: false,
    ancestorSelectors: ["#fit", "#root"],
    rect: { x: 72, y: 12, width: 10, height: 14 },
    signals: { role: "", inkCenterY: 19 },
  });
  const result = anatomy([control, leading, glyph]);
  expect(result.candidates).toEqual([
    expect.objectContaining({
      selectorHint: "#fit",
      rule: "idiom:icon-off-centre",
      explanation: expect.stringContaining("3px below"),
    }),
  ]);
});

test("artifacts load with and without the adornment signal; an unknown status is rejected", async () => {
  const { observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  const plain = tupleOf([element({ tag: "select" })]).observations;
  expect(observationArtifactSchema.parse(plain)).toEqual(plain);
  for (const adornment of [
    { status: "none" },
    { status: "unmeasured", reason: "pseudo-element chevron" },
    {
      status: "measured",
      source: "background",
      rect: { x: 1, y: 2, width: 10, height: 10 },
    },
  ] as const) {
    const artifact = tupleOf([
      element({ tag: "select", signals: { adornment } }),
    ]).observations;
    expect(observationArtifactSchema.parse(artifact)).toEqual(artifact);
  }
  const unknown = tupleOf([element({ tag: "select" })]).observations;
  if (unknown?.version !== 2) throw new Error("expected v2");
  const signals = unknown.elements[0]?.signals as unknown as Record<
    string,
    unknown
  >;
  signals.adornment = { status: "guessed" };
  expect(observationArtifactSchema.safeParse(unknown).success).toBe(false);
  signals.adornment = { status: "measured", source: "pseudo", rect: {} };
  expect(observationArtifactSchema.safeParse(unknown).success).toBe(false);
});
