import { describe, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { clippedTextCheck } from "../src/checks/clipped-text.js";
import { elementOverlapCheck } from "../src/checks/element-overlap.js";
import { fieldGroupCheck } from "../src/checks/field-group.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ClippedTextObservation,
  DeterministicCheck,
  ElementSignals,
  ExpandedObservedStyles,
  FieldGroupObservation,
  ObservationArtifact,
  ObservationArtifactV2,
  ObservedElementV2,
  OverlapObservation,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

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
    signals: signals({
      name: overrides.text ?? "",
      renderedContent: {
        text: !!overrides.text?.trim(),
        directText: !!(overrides.directText ?? overrides.text)?.trim(),
        graphic: signalOverrides?.hasGraphic ?? false,
        textEvidence: {
          status: "available",
          font: overrides.text?.trim() ? (overrides.styles ?? styles) : null,
        },
      },
      ...signalOverrides,
    }),
  };
}

function tupleOf(
  elements: ObservedElementV2[],
  extra: Partial<ObservationArtifactV2> = {},
): CheckTuple {
  const observations: ObservationArtifact = {
    version: 2,
    viewport: { width: 1440, height: 900 },
    document: {
      scrollWidth: 1440,
      scrollHeight: 900,
      clientWidth: 1440,
      clientHeight: 900,
    },
    elements,
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
    ...extra,
  };
  return {
    flow: "studio",
    state: "first-load",
    viewport: "desktop",
    width: 1440,
    height: 900,
    metadataPath: "first-load/desktop/metadata.json",
    artifactPaths: [],
    commit: "abc123",
    createdAt: "2026-10-23T00:00:00.000Z",
    observations,
    console: [],
    mismatches: [],
  };
}

const config = (checks: unknown = {}) =>
  checksConfigFrom(checksConfigSchema.parse(checks));

const run = (
  check: DeterministicCheck,
  tuple: CheckTuple,
  options: { narrowViewport?: boolean; checks?: unknown } = {},
) =>
  check.run({
    tuple,
    narrowViewport: options.narrowViewport ?? false,
    config: config(options.checks),
  });
const overlap = (
  extra: Partial<OverlapObservation> = {},
): OverlapObservation => ({
  a: "#a",
  b: "#b",
  kinds: ["interactive", "interactive"],
  rect: { x: 10, y: 0, width: 20, height: 24 },
  partial: [],
  samples: 25,
  hits: 9,
  ...extra,
});
const scene = (extra: Partial<OverlapObservation> = {}) =>
  tupleOf(
    [
      element({ selector: "#a", text: "First" }),
      element({ selector: "#b", text: "Second" }),
    ],
    { overlaps: [overlap(extra)] },
  );

for (const check of [elementOverlapCheck, clippedTextCheck, fieldGroupCheck]) {
  test(`${check.id} requires captured evidence, including on legacy artifacts`, () => {
    const tuple = tupleOf([]);
    expect(run(check, tuple).coverage.status).toBe("unavailable");
    tuple.observations = {
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
    };
    expect(observationArtifactSchema.parse(tuple.observations)).toEqual(
      tuple.observations,
    );
    expect(run(check, tuple).coverage.status).toBe("unavailable");
    delete tuple.observations;
    expect(run(check, tuple).coverage.status).toBe("unavailable");
    expect(
      run(
        check,
        tupleOf([], { overlaps: [], clippedText: [], fieldGroups: [] }),
      ),
    ).toMatchObject({ candidates: [], coverage: { status: "ran" } });
  });
}

describe("element-overlap", () => {
  test("names both selectors, dimensions, hit tests and clipped members", () => {
    const result = run(elementOverlapCheck, scene({ partial: ["#b"] }));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      rule: "idiom:elements-overlap",
      severity: "major",
      fingerprintHint: "#a | #b",
    });
    expect(result.candidates[0]?.explanation).toContain(
      "#a overlaps #b by 20×24px at 1440px (9/25 hit-test points); #b is only partly visible",
    );
  });
  test.each([
    [1.9, 20, ["interactive", "interactive"], 0],
    [20, 1.9, ["interactive", "interactive"], 0],
    [2, 2, ["interactive", "interactive"], 1],
    [2.9, 20, ["text", "interactive"], 0],
    [3, 3, ["text", "interactive"], 1],
  ] as const)("threshold at %i × %i for %j", (width, height, kinds, count) => {
    expect(
      run(
        elementOverlapCheck,
        scene({ rect: { x: 0, y: 0, width, height }, kinds: [...kinds] }),
      ).candidates,
    ).toHaveLength(count);
  });
  test("badge skip, missing members and geometry-only evidence", () => {
    const tuple = scene({ samples: 0, hits: 0 });
    expect(
      run(elementOverlapCheck, tuple).candidates[0]?.explanation,
    ).toContain("below the fold, geometry only");
    const a = tuple.observations?.elements[0];
    if (a === undefined) throw new Error("missing element");
    a.interactive = false;
    a.styles.position = "absolute";
    a.rect = { x: 0, y: 0, width: 24, height: 24 };
    expect(run(elementOverlapCheck, tuple).candidates).toEqual([]);
    tuple.observations?.elements.splice(0, 1);
    expect(run(elementOverlapCheck, tuple).candidates).toEqual([]);
  });
  test("responsive-break dedupe applies only when that check reports the pair", () => {
    const tuple = scene();
    const [a, b] = tuple.observations?.elements ?? [];
    if (a === undefined || b === undefined) throw new Error("missing pair");
    a.hitTestWith = [b.selector];
    expect(
      run(elementOverlapCheck, tuple, { narrowViewport: true }).candidates,
    ).toEqual([]);
    expect(run(elementOverlapCheck, tuple).candidates).toHaveLength(1);
    b.outOfFlow = true;
    expect(
      run(elementOverlapCheck, tuple, { narrowViewport: true }).candidates,
    ).toHaveLength(1);
  });
  test("text-only severity follows the area of the smaller element", () => {
    expect(
      run(
        elementOverlapCheck,
        scene({
          kinds: ["text", "text"],
          rect: { x: 0, y: 0, width: 4, height: 4 },
        }),
      ).candidates[0]?.severity,
    ).toBe("minor");
    expect(
      run(
        elementOverlapCheck,
        scene({
          kinds: ["text", "text"],
          rect: { x: 0, y: 0, width: 120, height: 20 },
        }),
      ).candidates[0]?.severity,
    ).toBe("major");
  });
  test("geometry-only overlaps are minor whatever their kinds or area", () => {
    const severity = (extra: Partial<OverlapObservation>) =>
      run(elementOverlapCheck, scene(extra)).candidates[0]?.severity;
    expect(severity({ samples: 0, hits: 0 })).toBe("minor");
    expect(severity({ samples: 25, hits: 9 })).toBe("major");
    const large = {
      kinds: ["text", "text"] as OverlapObservation["kinds"],
      rect: { x: 0, y: 0, width: 120, height: 20 },
    };
    expect(severity({ ...large, samples: 0, hits: 0 })).toBe("minor");
    expect(severity(large)).toBe("major");
  });
});

const clip: ClippedTextObservation = {
  selector: "#label",
  owner: "#menu",
  axis: "x",
  overflow: { x: 20, y: 0 },
  lines: 1,
  visibleLines: 1,
  cut: "mid-word",
  visibleText: "Make it cal",
  text: "Make it calmer",
};
test.each([
  ["mid-word", "cut mid-word"],
  ["word-boundary", "cut between words"],
  ["sliced-line", "a line is sliced through"],
  ["hidden-lines", "whole lines are hidden"],
] as const)(
  "clipped-text describes %s and names the clip owner",
  (cut, wording) => {
    const result = run(
      clippedTextCheck,
      tupleOf([], {
        clippedText: [{ ...clip, cut, lines: 3, visibleLines: 1 }],
      }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.explanation).toContain(wording);
    expect(result.candidates[0]?.explanation).toContain(
      "20px horizontally past #menu",
    );
    expect(result.candidates[0]?.explanation).toContain(
      "1 of 3 lines are readable",
    );
    expect(result.candidates[0]?.explanation).toContain("no ellipsis");
    expect(result.candidates[0]?.verification.params).toEqual({
      selector: "#label",
      owner: "#menu",
      axis: "x",
      cut,
    });
  },
);

function group(
  prefix: string,
  y: number,
  inner = 0,
  region = "#dialog",
): FieldGroupObservation {
  return {
    container: `#${prefix}`,
    region,
    members: [
      {
        selector: `#${prefix}-label`,
        role: "label",
        rect: { x: 0, y, width: 120, height: 20 },
      },
      {
        selector: `#${prefix}-input`,
        role: "control",
        rect: { x: 0, y: y + 20 + inner, width: 120, height: 32 },
      },
      {
        selector: `#${prefix}-chip`,
        role: "helper",
        rect: { x: 0, y: y + 52 + inner * 2, width: 80, height: 20 },
      },
    ],
  };
}
const groupTuple = (groups: FieldGroupObservation[]) =>
  tupleOf(
    groups.flatMap((group) =>
      group.members.map((member) =>
        element({
          selector: member.selector,
          rect: member.rect,
          tag: member.role === "control" ? "input" : "span",
          text: member.role === "helper" ? "Inherited" : group.container,
        }),
      ),
    ),
    { fieldGroups: groups },
  );

describe("field-group", () => {
  test("touching members and consecutive groups report actual gaps", () => {
    const result = run(
      fieldGroupCheck,
      groupTuple([group("a", 0), group("b", 72)]),
    );
    expect(
      result.candidates.filter((c) => c.rule === "idiom:field-group-inner-gap"),
    ).toHaveLength(4);
    expect(
      result.candidates.find((c) => c.rule === "idiom:field-group-between-gap")
        ?.verification.params,
    ).toMatchObject({ gap: 0, minimum: 12 });
    expect(result.candidates.every((c) => c.severity === "major")).toBe(true);
  });
  test("custom settings pass through checksConfigFrom; zero disables touching findings", () => {
    const tuple = groupTuple([group("a", 0), group("b", 72)]);
    expect(
      run(fieldGroupCheck, tuple, {
        checks: { fieldGroups: { inner: 0, between: 0 } },
      }).candidates,
    ).toEqual([]);
    const custom = run(
      fieldGroupCheck,
      groupTuple([group("a", 0, 5), group("b", 92, 5)]),
      { checks: { fieldGroups: { inner: 6, between: 16 } } },
    );
    expect(
      custom.candidates.filter((c) => c.rule === "idiom:field-group-inner-gap"),
    ).toHaveLength(4);
    expect(custom.candidates.every((c) => c.severity === "minor")).toBe(true);
    expect(
      custom.candidates.find((c) => c.rule === "idiom:field-group-between-gap")
        ?.verification.params,
    ).toMatchObject({ gap: 10, minimum: 16 });
  });
  test("compare consecutive groups within the same region, even with another region between them", () => {
    const result = run(
      fieldGroupCheck,
      groupTuple([
        group("a", 0, 4),
        group("other", 200, 4, "#other-dialog"),
        group("b", 85, 4),
      ]),
    );
    const between = result.candidates.filter(
      (c) => c.rule === "idiom:field-group-between-gap",
    );
    expect(between).toHaveLength(1);
    expect(between[0]?.verification.params).toMatchObject({
      gap: 5,
      minimum: 12,
    });
  });
  test("4px inside and 16px between pass; deep overlaps are left to overlap checks", () => {
    expect(
      run(fieldGroupCheck, groupTuple([group("a", 0, 4), group("b", 96, 4)]))
        .candidates,
    ).toEqual([]);
    const overlapped = group("a", 0, -4);
    expect(run(fieldGroupCheck, groupTuple([overlapped])).candidates).toEqual(
      [],
    );
  });
});

test("strict artifacts accept optional new evidence and legacy v2; config defaults are 4/12", () => {
  const old = tupleOf([]).observations;
  expect(observationArtifactSchema.parse(old)).toEqual(old);
  const observations = tupleOf([], {
    overlaps: [overlap()],
    clippedText: [clip],
    fieldGroups: [group("a", 0)],
  }).observations;
  expect(observationArtifactSchema.parse(observations)).toEqual(observations);
  expect(
    observationArtifactSchema.safeParse({
      ...observations,
      overlaps: [{ ...overlap(), surprise: true }],
    }).success,
  ).toBe(false);
  expect(
    observationArtifactSchema.safeParse({
      ...observations,
      clippedText: [{ ...clip, overflow: { x: -1, y: 0 } }],
    }).success,
  ).toBe(false);
  expect(checksConfigSchema.parse({}).fieldGroups).toEqual({
    inner: 4,
    between: 12,
  });
  expect(
    checksConfigSchema.safeParse({ fieldGroups: { inner: 10, between: 9 } })
      .success,
  ).toBe(false);
  expect(
    checksConfigSchema.safeParse({ fieldGroups: { inner: -1 } }).success,
  ).toBe(false);
  expect(
    checksConfigSchema.safeParse({ fieldGroups: { typo: 1 } }).success,
  ).toBe(false);
});
