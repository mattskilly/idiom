import { expect, test } from "vitest";
import { checksConfigFrom } from "../src/checks/registry.js";
import {
  applyScaleRulings,
  type ClusterOccurrence,
  nearestSteps,
  SCALE_TOKEN_PATTERN,
  scaleClusters,
  scaleQuestionText,
  suggestedToken,
} from "../src/checks/scale-clusters.js";
import {
  scaleConformanceCheck,
  scaleQuestions,
} from "../src/checks/scale-conformance.js";
import type {
  ChecksConfig,
  CheckTuple,
  ElementSignals,
  ExpandedObservedStyles,
  ObservationArtifactV2,
  ObservedElementV2,
  ScaleRulingRecord,
  ScalesConfig,
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
    colorScheme?: "light" | "dark";
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
    metadataPath: `${state}/${viewport.name}${options.colorScheme === undefined ? "" : `-${options.colorScheme}`}/metadata.json`,
    ...(options.colorScheme === undefined
      ? {}
      : { colorScheme: options.colorScheme }),
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

const scalesOf = (checks: unknown = {}): ScalesConfig =>
  checksConfigFrom(checksConfigSchema.parse({ scales: checks })).scales;

const main = element({
  selector: "main",
  tag: "main",
  interactive: false,
  ancestorSelectors: [],
  signals: { role: "main" },
});
const nav = element({
  selector: "nav",
  tag: "nav",
  interactive: false,
  ancestorSelectors: [],
  attributes: { "aria-label": "Primary" },
  signals: { role: "navigation" },
});

/** One padding occurrence on each of `count` buttons inside `parent`. */
function padded(
  count: number,
  px: number | ((index: number) => number),
  options: {
    parent?: ObservedElementV2;
    state?: string;
    viewport?: { name: string; width: number; height: number };
    attributes?: Record<string, string>;
    signals?: Partial<ElementSignals>;
    longhands?: string[];
    extra?: Partial<ObservationArtifactV2>;
  } = {},
): ClusterOccurrence<string>[] {
  const parent = options.parent ?? main;
  const buttons = Array.from({ length: count }, (_, index) =>
    element({
      selector: `${parent.selector} > button:nth-of-type(${index + 1})`,
      structuralPath: `html[0]/body[0]/${parent.tag}[0]/button[${index}]`,
      ancestorSelectors: [parent.selector],
      attributes: options.attributes ?? {},
      ...(options.signals === undefined ? {} : { signals: options.signals }),
    }),
  );
  const tuple = tupleOf([parent, ...buttons], {
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
    ...(options.extra === undefined ? {} : { extra: options.extra }),
  });
  return buttons.flatMap((button, index) =>
    (options.longhands ?? ["paddingTop"]).map((longhand) => ({
      tuple,
      element: button,
      property: "spacing:padding" as const,
      value: {
        kind: "px" as const,
        px: typeof px === "number" ? px : px(index),
      },
      longhand,
      source: `${button.selector} ${longhand}`,
    })),
  );
}

const spacing = scalesOf({ spacing: [4, 8, 16, 24] });

test("values within ±1px of the most frequent one bucket together; 19px stands apart", () => {
  const values = [17, 17, 17, 17.5, 16.5, 19];
  const clusters = scaleClusters(
    padded(values.length, (index) => values[index] as number),
    spacing,
  );
  expect(clusters.map(({ value, count }) => ({ value, count }))).toEqual([
    { value: "17px", count: 5 },
    { value: "19px", count: 1 },
  ]);
  expect(clusters[0]?.qualifies).toBe(true);
});

test("border colours bucket by canonical colour", () => {
  const occurrences = padded(4, 0).map((occurrence, index) => ({
    ...occurrence,
    property: "border" as const,
    role: "control" as const,
    value: {
      kind: "color" as const,
      canonical: index < 3 ? "rgb(1, 2, 3)" : "rgb(9, 9, 9)",
    },
    longhand: "borderTopColor",
  }));
  const clusters = scaleClusters(
    occurrences,
    scalesOf({ border: { control: ["#D1D5DB"] } }),
  );
  expect(clusters.map(({ value, count }) => [value, count])).toEqual([
    ["rgb(1, 2, 3)", 3],
    ["rgb(9, 9, 9)", 1],
  ]);
  expect(clusters[0]?.question).toContain(
    "outside your declared colours (#D1D5DB)",
  );
});

test("context splits by landmark, data-node-id, configured role selector and viewport", () => {
  const phone = { name: "phone", width: 390, height: 844 };
  const contexts = [
    ...padded(3, 17),
    ...padded(3, 17, { parent: nav }),
    ...padded(3, 17, { state: "node", signals: { nodeId: "row" } }),
    ...padded(3, 17, { viewport: phone }),
    ...padded(3, 17, {
      parent: element({
        selector: "aside",
        tag: "aside",
        interactive: false,
        ancestorSelectors: [],
        signals: { role: "complementary" },
      }),
      extra: {
        selectorMarks: [
          {
            purpose: "scale-control",
            selector: ".row-control",
            matches: [1, 2, 3].map(
              (index) => `aside > button:nth-of-type(${index})`,
            ),
          },
        ],
      },
    }),
  ];
  const clusters = scaleClusters(
    contexts,
    scalesOf({ spacing: [16], roles: { control: [".row-control"] } }),
  );
  expect(clusters.map(({ context }) => context)).toEqual(
    expect.arrayContaining([
      { landmark: "main", component: "tag:button", viewport: "desktop" },
      {
        landmark: 'navigation "Primary"',
        component: "tag:button",
        viewport: "desktop",
      },
      { landmark: "main", component: "node:row", viewport: "desktop" },
      { landmark: "main", component: "tag:button", viewport: "phone" },
      {
        landmark: "complementary",
        component: "role:.row-control",
        viewport: "desktop",
      },
    ]),
  );
  expect(clusters).toHaveLength(5);
});

test("qualifying needs suggestAfter occurrences across two states or three elements", () => {
  const qualifies = (occurrences: ClusterOccurrence[], scales = spacing) =>
    scaleClusters(occurrences, scales).map((cluster) => cluster.qualifies);
  // 5 occurrences in 2 states (2 + 3 elements).
  expect(
    qualifies([
      ...padded(2, 17, { state: "a", longhands: ["paddingTop"] }),
      ...padded(3, 17, { state: "b", longhands: ["paddingTop"] }),
    ]),
  ).toEqual([true]);
  // 5 occurrences on 3 elements in one state.
  expect(
    qualifies([
      ...padded(3, 17, { longhands: ["paddingTop"] }),
      ...padded(2, 17, { longhands: ["paddingBottom"] }),
    ]),
  ).toEqual([true]);
  // 5 occurrences on 2 elements in one state.
  expect(
    qualifies(
      padded(2, 17, {
        longhands: ["paddingTop", "paddingBottom", "paddingLeft"],
      }).slice(0, 5),
    ),
  ).toEqual([false]);
  // 4 occurrences.
  expect(qualifies(padded(4, 17))).toEqual([false]);
  // suggestAfter is respected both ways.
  expect(qualifies(padded(4, 17), { ...spacing, suggestAfter: 4 })).toEqual([
    true,
  ]);
  expect(qualifies(padded(5, 17), { ...spacing, suggestAfter: 6 })).toEqual([
    false,
  ]);
});

test("nearest steps handle multiples and both edges of the scale", () => {
  expect(nearestSteps({ kind: "px", px: 17 }, [4, 8, 16, 24])).toEqual({
    below: "16px",
    above: "24px",
    steps: ["4px", "8px", "16px", "24px"],
  });
  expect(nearestSteps({ kind: "px", px: 18 }, [{ multipleOf: 8 }])).toEqual({
    below: "16px",
    above: "24px",
    steps: ["multiples of 8px"],
  });
  const context = {
    landmark: "document",
    component: "control",
    viewport: "desktop",
  };
  expect(
    scaleQuestionText({
      value: "2px",
      property: "spacing:gap",
      count: 6,
      context,
      nearestSteps: nearestSteps({ kind: "px", px: 2 }, [4, 8]),
    }),
  ).toBe(
    "2px gap appears 6 times on controls at desktop, below your smallest 4px step. Add a step for this context, or keep reporting it as drift?",
  );
  expect(
    scaleQuestionText({
      value: "30px",
      property: "height",
      count: 5,
      context,
      nearestSteps: nearestSteps({ kind: "px", px: 30 }, [24, 28]),
    }),
  ).toContain("above your largest 28px step");
});

test("the question reads as the spec's sentence", () => {
  expect(
    scaleQuestionText({
      value: "17px",
      property: "spacing:padding",
      count: 34,
      context: {
        landmark: "main",
        component: "role:table row controls",
        viewport: "desktop",
      },
      nearestSteps: nearestSteps({ kind: "px", px: 17 }, [16, 24]),
    }),
  ).toBe(
    "17px padding appears 34 times on table row controls in main at desktop, between your 16px and 24px steps. Add a step for this context, or keep reporting it as drift?",
  );
});

test("suggested tokens are valid, editable slugs", () => {
  for (const [property, context, expected] of [
    [
      "spacing:padding",
      { landmark: "main", component: "role:.row-control", viewport: "desktop" },
      "space-row-control-main",
    ],
    [
      "radius",
      { landmark: "document", component: "card", viewport: "desktop" },
      "radius-card",
    ],
    [
      "height",
      {
        landmark: 'navigation "Primary site navigation with a long name"',
        component: "node:Toolbar/Primary Button",
        viewport: "desktop",
      },
      "height-toolbar-primary-button-navigation-primary",
    ],
    [
      "border",
      { landmark: "document", component: "role:[data-x]", viewport: "phone" },
      "border-data-x",
    ],
  ] as const) {
    const token = suggestedToken(property, context);
    expect(token).toBe(expected);
    expect(token).toMatch(SCALE_TOKEN_PATTERN);
    expect(token.length).toBeLessThanOrEqual(48);
  }
});

test("an add-step resolves within ±1px in its own context only; a drift answer marks the cluster", () => {
  const inMain = padded(6, (index) => (index === 0 ? 17.5 : 17));
  const inNav = padded(6, 17, { parent: nav });
  const clusters = scaleClusters([...inMain, ...inNav], spacing);
  const navCluster = clusters.find(
    (cluster) => cluster.context.landmark !== "main",
  );
  const step: ScaleRulingRecord = {
    id: "ruling-1",
    fingerprint: "unrelated",
    answer: "add-step",
    property: "spacing:padding",
    value: "17px",
    context: { landmark: "main", component: "tag:button", viewport: "desktop" },
    token: "space-button-main",
  };
  const drift: ScaleRulingRecord = {
    id: "ruling-2",
    fingerprint: navCluster?.fingerprint as string,
    answer: "drift",
    property: "spacing:padding",
    value: "17px",
    context: navCluster?.context as ScaleRulingRecord["context"],
  };
  const applied = applyScaleRulings([...inMain, ...inNav], spacing, [
    step,
    drift,
  ]);
  expect(applied.resolved).toHaveLength(6);
  expect(
    applied.clusters.map(({ status, ruling }) => [status, ruling?.id]),
  ).toEqual([["drift", "ruling-2"]]);
  expect(applied.residual).toEqual([]);
  // Without answers both clusters are open questions.
  expect(
    applyScaleRulings([...inMain, ...inNav], spacing, []).clusters.map(
      ({ status }) => status,
    ),
  ).toEqual(["unanswered", "unanswered"]);
});

// The check itself, with control heights judged against [32, 40].
const heights = (count: number, height: number, state = "editor") =>
  tupleOf(
    [
      main,
      ...Array.from({ length: count }, (_, index) =>
        element({
          selector: `#h${height}-${state}-${index}`,
          ancestorSelectors: ["main"],
          rect: { x: 0, y: index * 40, width: 96, height },
        }),
      ),
    ],
    { state },
  );

function run(tuples: CheckTuple[], config: ChecksConfig) {
  return tuples.map((tuple) =>
    scaleConformanceCheck.run({
      tuple,
      tuples,
      narrowViewport: false,
      config,
    }),
  );
}

const heightConfig = (extra: Partial<ChecksConfig> = {}): ChecksConfig => ({
  ...checksConfigFrom(
    checksConfigSchema.parse({ scales: { controlHeights: [32, 40] } }),
  ),
  ...extra,
});

test("without scaleQuestions the check's output is unchanged; a run below the threshold is too", () => {
  const tuples = [heights(6, 36), heights(2, 44, "review")];
  const today = run(tuples, heightConfig());
  expect(
    today.flatMap(({ candidates }) =>
      candidates.map((candidate) => candidate.fingerprintHint),
    ),
  ).toEqual(["scale:height:control:36px", "scale:height:control:44px"]);
  // Same output when questions can be asked but nothing qualifies.
  const fresh = [heights(6, 36), heights(2, 44, "review")];
  const asked = run(
    fresh,
    heightConfig({
      scales: { ...heightConfig().scales, suggestAfter: 100 },
      scaleQuestions: { rulings: [] },
    }),
  );
  expect(asked.map(({ candidates }) => candidates)).toEqual(
    run(fresh, {
      ...heightConfig(),
      scales: { ...heightConfig().scales, suggestAfter: 100 },
    }).map(({ candidates }) => candidates),
  );
});

test("an unanswered cluster leaves the findings and is returned as a question; residual groups keep their fingerprints", () => {
  const tuples = [heights(6, 36), heights(2, 44, "review")];
  const config = heightConfig({ scaleQuestions: { rulings: [] } });
  const results = run(tuples, config);
  expect(
    results.flatMap(({ candidates }) =>
      candidates.map((candidate) => candidate.fingerprintHint),
    ),
  ).toEqual(["scale:height:control:44px"]);
  expect(results[0]?.coverage.reason).toContain(
    "6 occurrences held as 1 design-system question",
  );
  const questions = scaleQuestions(tuples, config);
  expect(questions).toHaveLength(1);
  expect(questions[0]).toMatchObject({
    property: "height",
    value: "36px",
    count: 6,
    context: { landmark: "main", component: "control" },
    nearestSteps: { below: "32px", above: "40px" },
    suggestedToken: "height-control-main",
  });
  expect(questions[0]?.examples).toHaveLength(3);
});

test("a drift answer is one finding listing every occurrence; an add-step resolves them", () => {
  const tuples = [heights(6, 36)];
  const [question] = scaleQuestions(
    tuples,
    heightConfig({ scaleQuestions: { rulings: [] } }),
  );
  const record = {
    id: "ruling-4",
    fingerprint: question?.fingerprint as string,
    property: "height" as const,
    value: "36px",
    context: question?.context as ScaleRulingRecord["context"],
  };
  const drift = run(
    [heights(6, 36)],
    heightConfig({
      scaleQuestions: { rulings: [{ ...record, answer: "drift" }] },
    }),
  ).flatMap(({ candidates }) => candidates);
  expect(drift).toHaveLength(1);
  expect(drift[0]?.rule).toBe("idiom:off-scale-height");
  expect(drift[0]?.explanation).toContain("kept as drift by ruling-4");
  expect(
    (drift[0]?.verification.params as { targets?: unknown[] } | undefined)
      ?.targets,
  ).toHaveLength(6);

  const stepped = [heights(6, 36.5)];
  const config = heightConfig({
    scaleQuestions: {
      rulings: [{ ...record, answer: "add-step", token: "height-row" }],
    },
  });
  const results = run(stepped, config);
  expect(results.flatMap(({ candidates }) => candidates)).toEqual([]);
  expect(results[0]?.coverage.reason).toContain(
    "6 occurrences resolved by recorded ruling",
  );
  expect(scaleQuestions(stepped, config)).toEqual([]);
});

test("values the engine cannot cluster (a full radius) are still reported when questions are on", () => {
  const pills = () => [
    tupleOf([
      main,
      ...Array.from({ length: 6 }, (_, index) =>
        element({
          selector: `#pill-${index}`,
          ancestorSelectors: ["main"],
          styles: {
            borderTopLeftRadius: "9999px",
            borderTopRightRadius: "9999px",
            borderBottomRightRadius: "9999px",
            borderBottomLeftRadius: "9999px",
          },
        }),
      ),
    ]),
  ];
  const settings = checksConfigFrom(
    checksConfigSchema.parse({ scales: { radius: { control: [8] } } }),
  );
  const today = run(pills(), settings).flatMap(({ candidates }) => candidates);
  expect(today.map((candidate) => candidate.fingerprintHint)).toEqual([
    "scale:radius:control:full",
  ]);
  const tuples = pills();
  const asked = { ...settings, scaleQuestions: { rulings: [] } };
  expect(run(tuples, asked).flatMap(({ candidates }) => candidates)).toEqual(
    today.map((candidate) => ({
      ...candidate,
      evidenceTuples: tuples,
    })),
  );
  expect(scaleQuestions(tuples, asked)).toEqual([]);
});

test("a bare tag splits by its first class, and off-canvas occurrences never support a question", () => {
  const classed = (name: string) =>
    padded(3, 17, { state: name, attributes: { class: `${name} extra` } });
  const split = scaleClusters(
    [...classed("tooltip"), ...classed("badge")],
    spacing,
  );
  expect(
    split.map(({ context, qualifies }) => [context.component, qualifies]),
  ).toEqual([
    ["tag:button.badge", false],
    ["tag:button.tooltip", false],
  ]);
  expect(split[0]?.componentLabel).toBe("button.badge elements");

  const parked = padded(6, 17).map((occurrence) => ({
    ...occurrence,
    element: {
      ...occurrence.element,
      rect: { ...occurrence.element.rect, x: 5000 },
    },
  }));
  expect(scaleClusters(parked, spacing)).toEqual([]);
  const applied = applyScaleRulings(parked, spacing, []);
  expect(applied.clusters).toEqual([]);
  expect(applied.residual).toHaveLength(6);
});

test("values falling back from an unresolved token stay findings, not questions", () => {
  const broken = padded(6, 17).map((occurrence) => ({
    ...occurrence,
    element: {
      ...occurrence.element,
      styleSources: {
        padding: {
          sheet: "<style>[0]",
          selector: ".field",
          tokens: ["--control-scale"],
          unresolved: ["--control-scale"],
        },
      },
    },
  }));
  expect(scaleClusters(broken, spacing)).toEqual([]);
  expect(applyScaleRulings(broken, spacing, []).residual).toHaveLength(6);
});
