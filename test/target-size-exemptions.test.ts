import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type {
  CheckTuple,
  ExpandedObservedStyles,
  ObservationArtifact,
  ObservedElement,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const styles: ObservedElement["styles"] = {
  color: "rgb(0, 0, 0)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  borderTopColor: "rgb(0, 0, 0)",
  borderRightColor: "rgb(0, 0, 0)",
  borderBottomColor: "rgb(0, 0, 0)",
  borderLeftColor: "rgb(0, 0, 0)",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  outlineColor: "rgb(0, 0, 0)",
  outlineWidth: "0px",
  outlineStyle: "none",
  fill: "none",
  stroke: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
};

const expandedStyles: ExpandedObservedStyles = {
  ...styles,
  display: "block",
  visibility: "visible",
  opacity: "1",
  fontFamily: "sans-serif",
  fontSize: "16px",
  fontWeight: "400",
  lineHeight: "normal",
  letterSpacing: "normal",
  textAlign: "start",
  textDecorationLine: "none",
  textTransform: "none",
  whiteSpace: "normal",
  wordBreak: "normal",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  marginTop: "0px",
  marginRight: "0px",
  marginBottom: "0px",
  marginLeft: "0px",
  gap: "normal",
  flexDirection: "row",
  justifyContent: "normal",
  alignItems: "normal",
  gridTemplateColumns: "none",
  boxShadow: "none",
  transform: "none",
  zIndex: "auto",
};

function element(overrides: Partial<ObservedElement>): ObservedElement {
  return {
    selector: "button.action",
    tag: "button",
    text: "Action",
    visible: true,
    interactive: true,
    enabled: true,
    rect: { x: 0, y: 0, width: 44, height: 44 },
    scrollWidth: 44,
    scrollHeight: 44,
    clientWidth: 44,
    clientHeight: 44,
    outOfFlow: false,
    ancestorSelectors: [],
    styles,
    hitTestWith: [],
    ...overrides,
  };
}

function observations(elements: ObservedElement[] = []): ObservationArtifact {
  return {
    version: 1,
    viewport: { width: 320, height: 600 },
    document: {
      scrollWidth: 320,
      scrollHeight: 600,
      clientWidth: 320,
      clientHeight: 600,
    },
    elements,
    headings: [{ selector: "h1", level: 1, text: "Title" }],
    tokens: { status: "not-configured" },
  };
}

function tuple(overrides: Partial<CheckTuple> = {}): CheckTuple {
  return {
    flow: "booking",
    state: "ready",
    viewport: "phone",
    width: 320,
    height: 600,
    metadataPath: "ready/phone/metadata.json",
    artifactPaths: ["ready/phone/metadata.json"],
    commit: "abc123",
    createdAt: "2026-08-14T12:00:00.000Z",
    observations: observations(),
    axe: { violations: [] },
    console: [],
    mismatches: [],
    ...overrides,
  };
}
const rect = (x: number, y: number, width = 20, height = 20) => ({
  x,
  y,
  width,
  height,
});
const small = (
  selector: string,
  box = rect(100, 100),
  extra: Partial<ObservedElement> = {},
) => element({ selector, rect: box, ...extra });
function findings(elements: ObservedElement[], width = 1280, fine = 24) {
  return runDeterministicChecks(
    [tuple({ width, observations: observations(elements) })],
    undefined,
    checksConfigFrom(
      checksConfigSchema.parse({
        targetSize: { fine, coarse: 44, narrowBelow: 768 },
      }),
    ),
  )
    .candidates.filter(({ candidate }) => candidate.category === "target-size")
    .map(({ candidate }) => candidate);
}

test.each([
  [228, 22],
  [71, 22],
  [23, 23],
  [10, 8],
])(
  "isolated %dx%d desktop target passes; mobile retains 44px",
  (width, height) => {
    const elements = [small("#target", rect(100, 100, width, height))];
    expect(findings(elements)).toEqual([]);
    expect(findings(elements, 390)).toHaveLength(1);
  },
);

test.each([
  [23.999, 2],
  [24, 0],
  [24.001, 0],
])("20px row with center distance %d has %d findings", (distance, count) => {
  expect(
    findings([small("#a"), small("#b", rect(100 + distance, 100))]),
  ).toHaveLength(count);
});

test("diagonal circle separation, circle/rectangle collision, and elongated obstacles", () => {
  expect(findings([small("#a"), small("#b", rect(120, 120))])).toHaveLength(0);
  expect(
    findings([small("#a"), small("#big", rect(121, 100, 100, 100))]).map(
      (f) => f.selectorHint,
    ),
  ).toContain("#a");
  // The long bar's center is distant; its actual edge intersects the circle.
  expect(
    findings([small("#a"), small("#bar", rect(109, 121, 200, 2))]).map(
      (f) => f.selectorHint,
    ),
  ).toContain("#a");
  // The actual rectangles do not intersect either circle; the circles overlap.
  expect(
    findings([
      small("#a", rect(100, 100, 2, 2)),
      small("#b", rect(120, 100, 2, 2)),
    ]),
  ).toHaveLength(2);
});

test("all enabled clickable neighbors count, including inline and ancestor targets", () => {
  for (const extra of [
    { inlineTextTarget: true },
    { ancestorSelectors: ["#a"] },
  ]) {
    const found = findings([
      small("#a"),
      small("#neighbor", rect(121, 100, 100, 24), extra),
    ]);
    expect(found.map((f) => f.selectorHint)).toContain("#a");
  }
  for (const extra of [
    { visible: false },
    { enabled: false },
    { painted: { value: false as const, reason: "hidden" } },
  ]) {
    expect(
      findings([
        small("#a"),
        small("#neighbor", rect(121, 100, 100, 24), extra),
      ]),
    ).toEqual([]);
  }
  expect(
    findings([small("#a", rect(100, 2000)), small("#b", rect(121, 2000))]),
  ).toHaveLength(2);
  expect(
    findings([small("#a", rect(-10, 100)), small("#b", rect(10, 100))]),
  ).toHaveLength(2);
  expect(
    findings([small("#a", rect(1, 100)), small("#offscreen", rect(-20, 100))]),
  ).toHaveLength(0);
});

test("packed dots and mobile actions retain findings; custom fine minimum has no spacing relief", () => {
  expect(
    findings(
      Array.from({ length: 5 }, (_, i) =>
        small(`#dot${i}`, rect(100 + 12 * i, 100, 10, 8)),
      ),
    ),
  ).toHaveLength(5);
  for (const width of [36, 235])
    expect(
      findings([small("#action", rect(100, 100, width, 36))], 390),
    ).toHaveLength(1);
  expect(findings([small("#action")], 1280, 32)).toHaveLength(1);
});

test("label regions clear size failures without filling gaps or duplicating owners", () => {
  const input = small("#input", rect(100, 100, 12, 12), {
    tag: "input",
    targetSizeLabels: [{ selector: "#label", rects: [rect(130, 100, 60, 30)] }],
  });
  expect(
    findings([
      input,
      small("#label", rect(130, 100, 60, 30), { tag: "label" }),
    ]),
  ).toEqual([]);
  expect(findings([input], 390)).toHaveLength(1);
  input.targetSizeLabels = [
    { selector: "#label", rects: [rect(200, 100, 12, 12)] },
  ];
  // Mobile must not count the empty envelope as a 112x12 or 112x44 hit area.
  expect(findings([input], 390)).toHaveLength(1);
  // Center of the effective envelope is x156: this independent link blocks spacing.
  expect(
    findings([input, small("#link", rect(150, 100, 10, 8), { tag: "a" })]).map(
      (f) => f.selectorHint,
    ),
  ).toContain("#input");
  input.targetSizeLabels = [
    {
      selector: "#label",
      rects: [rect(130, 100, 60, 12), rect(130, 130, 60, 12)],
    },
  ];
  expect(findings([input], 390)).toHaveLength(1);
});

test("strict optional evidence round-trips v1/v2 and stored checks use it", () => {
  const legacy = observations([
    small("#input", rect(100, 100, 12, 12), { tag: "input" }),
  ]);
  const enriched = structuredClone(legacy);
  const owner = enriched.elements[0];
  if (!owner) throw new Error("missing input");
  owner.targetSizeLabels = [
    { selector: "#label", rects: [rect(130, 100, 60, 50)] },
  ];
  for (const version of [1, 2]) {
    const base = version === 1 ? {} : { maskMembership: [] };
    const withVersion = (value: ObservationArtifact) => ({
      ...value,
      ...base,
      version,
      elements: value.elements.map((element) =>
        version === 1
          ? element
          : {
              ...element,
              structuralPath: "body[0]/input[0]",
              directText: "",
              attributes: {},
              temporal: false,
              stableIslandPath: "body[0]",
              relativeRect: element.rect,
              styles: expandedStyles,
            },
      ),
    });
    expect(
      observationArtifactSchema.safeParse(withVersion(legacy)).success,
    ).toBe(true);
    const loaded = observationArtifactSchema.parse(
      JSON.parse(JSON.stringify(withVersion(enriched))),
    );
    expect(findings(loaded.elements, 390)).toEqual([]);
    expect(findings(legacy.elements, 390)).toHaveLength(1);
  }
  for (const evidence of [
    [{ selector: "", rects: [] }],
    [{ selector: "#label", rects: [], extra: true }],
    [{ selector: "#label", rects: [rect(0, 0, -1)] }],
    [{ selector: "#label", rects: [rect(Number.NaN, 0)] }],
    [{ selector: "#label", rects: [{ ...rect(0, 0), extra: true }] }],
  ]) {
    owner.targetSizeLabels = evidence;
    expect(observationArtifactSchema.safeParse(enriched).success).toBe(false);
  }
});
