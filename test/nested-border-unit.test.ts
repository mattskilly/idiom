import { expect, test } from "vitest";
import { nestedBorderCheck } from "../src/checks/nested-border.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ExpandedObservedStyles,
  ObservedElementV2,
  Rect,
} from "../src/checks/types.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const none = "rgba(0, 0, 0, 0)";
const grey = "rgb(153, 153, 153)";
const base: ExpandedObservedStyles = {
  color: "rgb(17, 24, 39)",
  backgroundColor: none,
  borderTopColor: none,
  borderRightColor: none,
  borderBottomColor: none,
  borderLeftColor: none,
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopStyle: "none",
  borderRightStyle: "none",
  borderBottomStyle: "none",
  borderLeftStyle: "none",
  outlineColor: "rgb(0, 0, 0)",
  outlineWidth: "0px",
  fill: "none",
  stroke: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
  display: "block",
  visibility: "visible",
  opacity: "1",
  fontFamily: "sans-serif",
  fontSize: "14px",
  fontWeight: "400",
  lineHeight: "normal",
  letterSpacing: "normal",
  textAlign: "left",
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

const border = (radius: string, style = "solid") => ({
  borderTopColor: grey,
  borderRightColor: grey,
  borderBottomColor: grey,
  borderLeftColor: grey,
  borderTopWidth: "1px",
  borderRightWidth: "1px",
  borderBottomWidth: "1px",
  borderLeftWidth: "1px",
  borderTopStyle: style,
  borderRightStyle: style,
  borderBottomStyle: style,
  borderLeftStyle: style,
  borderTopLeftRadius: radius,
  borderTopRightRadius: radius,
  borderBottomRightRadius: radius,
  borderBottomLeftRadius: radius,
});

function element(
  selector: string,
  rect: Rect,
  ancestorSelectors: string[],
  overrides: Partial<Omit<ObservedElementV2, "styles">> & {
    styles?: Partial<ExpandedObservedStyles>;
  } = {},
): ObservedElementV2 {
  const { styles, ...rest } = overrides;
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
    ancestorSelectors,
    hitTestWith: [],
    structuralPath: selector,
    directText: "",
    attributes: {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]",
    relativeRect: rect,
    rect,
    ...rest,
    styles: { ...base, ...styles },
  };
}

const tuple = (elements: ObservedElementV2[]): CheckTuple =>
  invariantTuple({ ...invariantObservations(), elements });

/** A square 1px frame with a pill `inset` px inside its border on every side. */
function picker(
  inset = 2,
  inner: Partial<ExpandedObservedStyles> = border("9999px"),
  extra: ObservedElementV2[] = [],
  outer: Partial<ExpandedObservedStyles> = border("0px"),
) {
  const size = { width: 60, height: 32 };
  return [
    element("#swatch", { x: 10, y: 10, ...size }, ["#palette"], {
      styles: outer,
    }),
    element(
      "#pill",
      {
        x: 10 + 1 + inset,
        y: 10 + 1 + inset,
        width: size.width - 2 - inset * 2,
        height: size.height - 2 - inset * 2,
      },
      ["#swatch", "#palette"],
      { tag: "button", interactive: true, styles: inner },
    ),
    ...extra,
  ];
}

const run = (elements: ObservedElementV2[], config = checksConfigFrom()) =>
  nestedBorderCheck.run({
    tuple: tuple(elements),
    tuples: [],
    narrowViewport: false,
    config,
  });

test("a pill inside a square frame within 4px is one minor finding on the outer box", () => {
  const result = run(picker());
  expect(result.coverage.status).toBe("ran");
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    category: "nested-border",
    severity: "minor",
    rule: "idiom:nested-border",
    selectorHint: "#swatch",
    fingerprintHint: "nested-border:#swatch|#pill",
    explanation:
      "#pill draws its own pill border 2px inside #swatch's square border, so the edge reads doubled and mismatched.",
  });
  expect(result.candidates[0]?.verification.params).toMatchObject({
    selectors: ["#swatch", "#pill"],
    insets: { top: 2, right: 2, bottom: 2, left: 2 },
    outerStyle: "solid",
    innerStyle: "solid",
  });
});

test("the inset boundary is 4px", () => {
  expect(run(picker(4)).candidates).toHaveLength(1);
  expect(run(picker(4.5)).candidates).toEqual([]);
});

test("a painted wrapper between the frames blocks the finding", () => {
  const elements = picker();
  const pill = elements[1] as ObservedElementV2;
  pill.ancestorSelectors = ["#wrap", "#swatch", "#palette"];
  const wrap = element("#wrap", { ...pill.rect }, ["#swatch", "#palette"], {
    styles: { backgroundColor: "rgb(250, 250, 250)" },
  });
  expect(run([...elements, wrap]).candidates).toEqual([]);
  wrap.styles.backgroundColor = none;
  expect(run([...elements, wrap]).candidates).toHaveLength(1);
});

test("text beside the inner frame, or on the outer box, blocks the finding", () => {
  const label = element(
    "#label",
    { x: 12, y: 12, width: 10, height: 10 },
    ["#swatch", "#palette"],
    { directText: "Primary" },
  );
  expect(run(picker(2, border("9999px"), [label])).candidates).toEqual([]);
  const elements = picker();
  (elements[0] as ObservedElementV2).directText = "Primary";
  expect(run(elements).candidates).toEqual([]);
});

test("two bordered children inside one frame are not a nested pair", () => {
  const second = element(
    "#pill-2",
    { x: 13, y: 13, width: 20, height: 20 },
    ["#swatch", "#palette"],
    { styles: border("9999px") },
  );
  expect(run(picker(2, border("9999px"), [second])).candidates).toEqual([]);
});

test("matching radius and style is fine; a different style alone is flagged", () => {
  expect(run(picker(2, border("0px"))).candidates).toEqual([]);
  expect(run(picker(2, border("0px", "dashed"))).candidates).toHaveLength(1);
});

test("captures without border styles still compare radius", () => {
  const strip = (styles: Partial<ExpandedObservedStyles>) => {
    const copy = { ...styles };
    delete copy.borderTopStyle;
    delete copy.borderRightStyle;
    delete copy.borderBottomStyle;
    delete copy.borderLeftStyle;
    return copy;
  };
  const elements = picker(2, strip(border("9999px")));
  for (const element of elements) {
    delete element.styles.borderTopStyle;
    delete element.styles.borderRightStyle;
    delete element.styles.borderBottomStyle;
    delete element.styles.borderLeftStyle;
  }
  const result = run(elements);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.verification.params).not.toHaveProperty(
    "outerStyle",
  );
  // Without styles, a dashed-only difference cannot be seen.
  const sameRadius = picker(2, strip(border("0px")), [], strip(border("0px")));
  for (const element of sameRadius) delete element.styles.borderTopStyle;
  expect(run(sameRadius).candidates).toEqual([]);
});

test("50% and 9999px pills compare equal", () => {
  expect(
    run(picker(2, border("50%"), [], border("9999px"))).candidates,
  ).toEqual([]);
});

test("focus-sourced border colours are not nested borders", () => {
  const elements = picker();
  (elements[0] as ObservedElementV2).styleSources = {
    borderTopColor: { sheet: "<style>[0]", selector: ".field:focus-within" },
  };
  expect(run(elements).candidates).toEqual([]);
});

test("outlines and box shadows are not borders", () => {
  const ring = {
    ...border("9999px"),
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    outlineWidth: "2px",
    outlineColor: grey,
    outlineStyle: "solid",
  };
  expect(run(picker(2, ring)).candidates).toEqual([]);
});

test("disabled in config, the check is skipped", () => {
  const result = run(
    picker(),
    checksConfigFrom({ nestedBorder: { enabled: false } }),
  );
  expect(result.coverage).toMatchObject({
    status: "skipped",
    reason: "checks.nestedBorder is not enabled",
  });
  expect(result.candidates).toEqual([]);
});

test("an unpainted inner frame is skipped by the painted gate", () => {
  const elements = picker();
  (elements[1] as ObservedElementV2).painted = {
    value: false,
    reason: "clipped",
  };
  const result = run(elements);
  expect(result.candidates).toEqual([]);
  expect(result.coverage.paintedSkipped).toEqual({ "idiom:nested-border": 1 });
});

test("v1 observations are unavailable", () => {
  const result = nestedBorderCheck.run({
    tuple: { ...tuple([]), observations: undefined },
    tuples: [],
    narrowViewport: false,
    config: checksConfigFrom(),
  });
  expect(result.coverage.status).toBe("unavailable");
});

test("a concentric inner corner (outer radius less the gap) matches", () => {
  // 1px border + 2px gap: an 8px outer corner is concentric with a 5px inner one.
  expect(run(picker(2, border("5px"), [], border("8px"))).candidates).toEqual(
    [],
  );
  expect(
    run(picker(2, border("12px"), [], border("8px"))).candidates,
  ).toHaveLength(1);
});
