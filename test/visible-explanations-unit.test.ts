import { expect, test } from "vitest";
import { deadAffordanceCheck } from "../src/checks/dead-affordance.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ElementSignals,
  ExpandedObservedStyles,
  ExplanationRecord,
  ObservedElementV2,
} from "../src/checks/types.js";
import { unexplainedControlCheck } from "../src/checks/unexplained-control.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { emptyObservation, tupleFor } from "./motion-support.js";

const styles: ExpandedObservedStyles = {
  color: "rgb(29, 35, 48)",
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
  fill: "none",
  stroke: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
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

function signals(overrides: Partial<ElementSignals> = {}): ElementSignals {
  return {
    role: "button",
    name: "",
    described: false,
    appearance: "auto",
    cursor: "default",
    hasGraphic: false,
    lineCount: 1,
    contentBox: { x: 0, y: 0, width: 0, height: 0 },
    transition: "all 0s",
    animation: "none 0s",
    focused: false,
    repeatedItem: false,
    ...overrides,
  };
}

let counter = 0;
function element(
  overrides: Partial<Omit<ObservedElementV2, "signals">> & {
    signals?: Partial<ElementSignals>;
  } = {},
): ObservedElementV2 {
  counter += 1;
  const rect = overrides.rect ?? { x: 0, y: 0, width: 120, height: 32 };
  const { signals: signalOverrides, ...rest } = overrides;
  return {
    selector: `#e${counter}`,
    tag: "button",
    text: "",
    visible: true,
    interactive: true,
    enabled: true,
    scrollWidth: rect.width,
    scrollHeight: rect.height,
    clientWidth: rect.width,
    clientHeight: rect.height,
    outOfFlow: false,
    ancestorSelectors: [],
    hitTestWith: [],
    structuralPath: `html[0]/body[0]/x[${counter}]`,
    directText: overrides.text ?? "",
    attributes: {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]",
    relativeRect: rect,
    styles,
    ...rest,
    rect,
    signals: signals({ name: overrides.text ?? "", ...signalOverrides }),
  };
}

function check(
  overrides: Parameters<typeof element>[0] = {},
  records: ExplanationRecord[] = [],
  mode: "default" | "visible" = "visible",
) {
  const control = element({
    selector: "#control",
    text: "?",
    signals: {
      name: "Help topics",
      title: "Help topics",
      explanation: {
        controlId: "fixture-control",
        visibleText: "?",
        descriptions: [],
      },
    },
    ...overrides,
  });
  const tuple = tupleFor({
    ...emptyObservation,
    elements: [control],
    explanations: { version: 1, status: "ran", records },
  });
  const config = checksConfigFrom(
    checksConfigSchema.parse({ explanation: mode }),
  );
  const context = { tuple, config, narrowViewport: false };
  return {
    unexplained: unexplainedControlCheck.run(context),
    dead: deadAffordanceCheck.run(context),
    tuple,
  };
}
const record = (
  trigger: "hover" | "focus",
  extra: Partial<ExplanationRecord> = {},
): ExplanationRecord => ({
  selector: "#control",
  controlId: "fixture-control",
  source: "probe",
  trigger,
  status: "observed",
  tooltips: [{ selector: "#tip", text: "Help topics" }],
  ...extra,
});

test("visible policy requires painted labels, descriptions or both tooltip modalities", () => {
  expect(check().unexplained.candidates).toHaveLength(1);
  expect(check({}, [], "default").unexplained.candidates).toHaveLength(0);
  expect(
    check({
      signals: {
        name: "?",
        title: "Help topics",
        explanation: { visibleText: "?", descriptions: [] },
      },
    }).unexplained.candidates,
  ).toHaveLength(1);
  expect(
    check({
      signals: {
        name: "Help topics",
        explanation: { visibleText: "Help topics", descriptions: [] },
      },
    }).unexplained.candidates,
  ).toHaveLength(0);
  expect(
    check({
      signals: {
        explanation: {
          visibleText: "?",
          descriptions: [{ selector: "#help", text: "Help topics" }],
        },
      },
    }).unexplained.candidates,
  ).toHaveLength(0);
  expect(
    check({
      signals: {
        described: true,
        explanation: { visibleText: "?", descriptions: [] },
      },
    }).unexplained.candidates,
  ).toHaveLength(1);
  for (const records of [
    [record("hover")],
    [record("focus")],
    [record("hover"), record("focus", { selector: "#other" })],
    [record("hover"), record("focus", { controlId: "earlier-incarnation" })],
    [
      record("hover", { controlId: undefined }),
      record("focus", { controlId: undefined }),
    ],
    [
      record("hover"),
      record("focus", {
        status: "unavailable",
        reason: "failed",
        tooltips: [],
      }),
    ],
  ])
    expect(check({}, records).unexplained.candidates).toHaveLength(1);
  expect(
    check({}, [record("hover"), record("focus", { source: "capture" })])
      .unexplained.candidates,
  ).toHaveLength(0);
});

test("disabled and nameless glyphs retain severity and selector verification", () => {
  const enabled = check({
    signals: { name: "", explanation: { visibleText: "?", descriptions: [] } },
  }).unexplained.candidates;
  expect(enabled).toMatchObject([
    {
      severity: "major",
      rule: "idiom:unexplained-control",
      selectorHint: "#control",
    },
  ]);
  expect(check({ enabled: false }).unexplained.candidates).toMatchObject([
    { severity: "minor", rule: "idiom:unavailable-control-without-reason" },
  ]);
  expect(
    check({ signals: { name: "" } }, [], "default").unexplained.candidates,
  ).toEqual([]);
});

test("legacy captures require recapture only in visible mode", () => {
  expect(
    check({ signals: { name: "Help topics", title: "Help topics" } })
      .unexplained.coverage,
  ).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("recapture"),
  });
  expect(
    check(
      { signals: { name: "Help topics", title: "Help topics" } },
      [],
      "default",
    ).unexplained.coverage.status,
  ).toBe("ran");
});

test("disabled navigation text is gated, minor and belongs to its owning button", () => {
  for (const text of ["Help", "View terms", "Learn more", "Docs"]) {
    const overrides = {
      enabled: false,
      text,
      signals: {
        role: "button",
        title: "Coming soon",
        explanation: { visibleText: text, descriptions: [] },
      },
    };
    expect(check(overrides).dead.candidates).toMatchObject([
      {
        severity: "minor",
        rule: "idiom:disabled-link-button",
        selectorHint: "#control",
      },
    ]);
    // On by default since 0.9; only captures without painted-text signals skip it.
    expect(check(overrides, [], "default").dead.candidates).toMatchObject([
      { severity: "minor", rule: "idiom:disabled-link-button" },
    ]);
    expect(
      check(
        { ...overrides, signals: { role: "button", title: "Coming soon" } },
        [],
        "default",
      ).dead.candidates,
    ).toEqual([]);
  }
  for (const text of ["Save", "Delete", "?"])
    expect(
      check({
        enabled: false,
        text,
        signals: { explanation: { visibleText: text, descriptions: [] } },
      }).dead.candidates,
    ).toEqual([]);
  expect(
    check({
      text: "Help",
      signals: { explanation: { visibleText: "Help", descriptions: [] } },
    }).dead.candidates,
  ).toEqual([]);
});

const absent = (
  trigger: "hover" | "focus",
  extra: Partial<ExplanationRecord> = {},
): ExplanationRecord =>
  record(trigger, { status: "absent", tooltips: [], ...extra });

test("default mode reports a named text glyph only when hover and focus showed no tooltip", () => {
  const sampled = [absent("hover"), absent("focus")];
  expect(check({}, sampled, "default").unexplained.candidates).toMatchObject([
    {
      severity: "minor",
      rule: "idiom:unexplained-control",
      selectorHint: "#control",
      explanation: expect.stringContaining(
        '#control shows "?" with no painted label and no tooltip observed on hover or focus',
      ),
    },
  ]);
  // A tooltip on either trigger, a painted description, or missing evidence
  // keeps the old default suppression.
  for (const records of [
    [record("hover"), absent("focus")],
    [absent("hover"), record("focus")],
    [absent("hover")],
    [absent("focus")],
    [],
    [absent("hover"), absent("focus", { controlId: "other" })],
    [
      absent("hover"),
      absent("focus", { status: "unavailable", reason: "x", tooltips: [] }),
    ],
  ])
    expect(check({}, records, "default").unexplained.candidates).toEqual([]);
  expect(
    check(
      {
        signals: {
          name: "Help topics",
          explanation: {
            controlId: "fixture-control",
            visibleText: "?",
            descriptions: [{ selector: "#help", text: "Help topics" }],
          },
        },
      },
      sampled,
      "default",
    ).unexplained.candidates,
  ).toEqual([]);
  // A bare icon (no painted text) is not a text glyph.
  expect(
    check(
      {
        text: "",
        signals: {
          name: "Help topics",
          hasGraphic: true,
          explanation: {
            controlId: "fixture-control",
            visibleText: "",
            descriptions: [],
          },
        },
      },
      sampled,
      "default",
    ).unexplained.candidates,
  ).toEqual([]);
  // A glyph with no meaningful name keeps its major default finding.
  expect(
    check(
      {
        signals: {
          name: "?",
          explanation: {
            controlId: "fixture-control",
            visibleText: "?",
            descriptions: [],
          },
        },
      },
      sampled,
      "default",
    ).unexplained.candidates,
  ).toMatchObject([{ severity: "major", rule: "idiom:unexplained-control" }]);
});

test("static explanation evidence is additive and strictly validated", async () => {
  const { observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  const artifact = check().tuple.observations;
  expect(
    observationArtifactSchema.parse(JSON.parse(JSON.stringify(artifact))),
  ).toEqual(artifact);
  for (const explanation of [
    { visibleText: 1, descriptions: [] },
    { visibleText: "?", descriptions: [], controlId: 12 },
    { visibleText: "?", descriptions: [], inViewport: "yes" },
    { visibleText: "?", descriptions: [], nativeDisabled: "false" },
    { visibleText: "?", descriptions: [{ selector: "#tip", text: " " }] },
    { visibleText: "?", descriptions: [], guessed: true },
  ]) {
    const control = element({
      signals: { explanation: explanation as ElementSignals["explanation"] },
    });
    expect(
      observationArtifactSchema.safeParse({
        ...emptyObservation,
        elements: [control],
      }).success,
    ).toBe(false);
  }
});
