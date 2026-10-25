import { describe, expect, test } from "vitest";
import { mirroredControlCheck } from "../src/checks/mirrored-control.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ElementSignals,
  ExpandedObservedStyles,
  MirroredPair,
  ObservationArtifact,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import {
  buildDeterministicDrafts,
  dedupeFindingDrafts,
  suppressFindingDrafts,
} from "../src/review/findings.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { deterministicFingerprintSet } from "../src/verify/evaluate.js";

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

const pair: MirroredPair = {
  name: "collapse",
  a: "#a",
  b: "#b",
  axis: "vertical",
};
function scene() {
  const a = element({
    selector: "#a",
    rect: { x: 256, y: 20, width: 28, height: 28 },
    ancestorSelectors: ["#left", "#root"],
    signals: { hasGraphic: true },
  });
  const b = element({
    selector: "#b",
    rect: { x: 716, y: 20, width: 28, height: 28 },
    ancestorSelectors: ["#right", "#stage", "#root"],
    signals: { hasGraphic: true },
  });
  const left = element({
    selector: "#left",
    rect: { x: 0, y: 0, width: 300, height: 900 },
  });
  const right = element({
    selector: "#right",
    rect: { x: 700, y: 0, width: 300, height: 900 },
  });
  const stage = element({
    selector: "#stage",
    rect: { x: 300, y: 0, width: 700, height: 900 },
  });
  const root = element({
    selector: "#root",
    rect: { x: 0, y: 0, width: 1000, height: 900 },
  });
  return { a, b, elements: [a, b, left, right, stage, root] };
}
function marked(elements: ObservedElementV2[], pairs = [pair]) {
  return tupleOf(elements, {
    selectorMarks: [...new Set(pairs.flatMap(({ a, b }) => [a, b]))].map(
      (selector) => ({
        purpose: "mirrored",
        selector,
        matches: elements.some((el) => el.selector === selector)
          ? [selector]
          : [],
      }),
    ),
  });
}
const run = (tuple: CheckTuple, pairs: MirroredPair[] = [pair]) =>
  mirroredControlCheck.run({
    tuple,
    narrowViewport: false,
    config: config({ mirrored: pairs }),
  });

describe("mirrored-control", () => {
  test("equal icons in their own panels pass, including a canvas-spanning wrapper", () => {
    const { elements } = scene();
    const result = run(marked(elements));
    expect(result.coverage.status).toBe("ran");
    expect(result.candidates).toEqual([]);
  });

  test("captured text-owner fonts are compared, including named weights", () => {
    const { a, b, elements } = scene();
    Object.assign(a, {
      text: "«",
      directText: "«",
      styles: { ...styles, fontSize: "14px", fontWeight: "normal" },
      signals: {
        ...a.signals,
        hasGraphic: false,
        renderedContent: {
          text: true,
          directText: true,
          graphic: false,
          textEvidence: {
            status: "available",
            font: { fontSize: "14px", fontWeight: "normal" },
          },
        },
      },
    });
    Object.assign(b, {
      text: "»",
      directText: "",
      signals: {
        ...b.signals,
        hasGraphic: false,
        renderedContent: {
          text: true,
          directText: false,
          graphic: false,
          textEvidence: {
            status: "available",
            font: { fontSize: "12px", fontWeight: "600" },
          },
        },
      },
    });
    const result = run(marked(elements));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.verification?.params?.differences).toEqual([
      "font",
    ]);
    expect(result.candidates[0]?.explanation).toContain("14px/400 vs 12px/600");
    const evidence = a.signals?.renderedContent?.textEvidence;
    if (evidence?.status !== "available" || evidence.font === null)
      throw new Error("missing captured font");
    evidence.font.fontWeight = "bold";
    expect(run(marked(elements)).candidates[0]?.explanation).toContain(
      "14px/700",
    );
  });

  test("shared toolbar uses its centre as the mirror axis", () => {
    const { a, b } = scene();
    a.ancestorSelectors = b.ancestorSelectors = ["#toolbar"];
    a.rect.x = 310;
    b.rect.x = 662;
    const toolbar = element({
      selector: "#toolbar",
      rect: { x: 300, y: 0, width: 400, height: 60 },
    });
    const elements = [a, b, toolbar];
    expect(run(marked(elements)).candidates).toEqual([]);
    b.rect.x += 6;
    const result = run(marked(elements));
    expect(result.candidates[0]?.explanation).toContain(
      "162px from the mirror axis vs 168px",
    );
  });

  test("without observed ancestors the viewport centre supplies the mirror axis", () => {
    const { a, b } = scene();
    a.ancestorSelectors = b.ancestorSelectors = [];
    a.rect.x = 200;
    b.rect.x = 1212;
    expect(run(marked([a, b])).candidates).toEqual([]);
    b.rect.x += 6;
    expect(run(marked([a, b])).candidates[0]?.explanation).toContain(
      "492px from the mirror axis vs 498px",
    );
  });

  test("horizontal pairs compare bottom/top canvas-facing edges", () => {
    const { b, elements } = scene();
    for (const el of elements) {
      const { x, y, width, height } = el.rect;
      el.rect = { x: y, y: x, width: height, height: width };
    }
    b.rect.y += 8;
    const horizontal = { ...pair, axis: "horizontal" as const };
    const result = run(marked(elements, [horizontal]), [horizontal]);
    expect(result.candidates[0]?.explanation).toContain(
      "16px from its panel's canvas-facing edge vs 24px",
    );
    expect(result.candidates[0]?.verification?.params?.differences).toEqual([
      "placement",
    ]);
  });

  test("tolerances allow 1px size, 2px placement and 0.5px type differences", () => {
    const { a, b, elements } = scene();
    a.rect.width += 1;
    b.rect.x += 1;
    for (const el of [a, b]) {
      el.text = el.directText = "»";
      if (el.signals) {
        el.signals.hasGraphic = false;
        el.signals.renderedContent = {
          text: true,
          directText: true,
          graphic: false,
          textEvidence: { status: "available", font: el.styles },
        };
      }
    }
    b.styles = { ...styles, fontSize: "14.5px" };
    const evidence = b.signals?.renderedContent?.textEvidence;
    if (evidence?.status !== "available")
      throw new Error("missing captured font");
    evidence.font = b.styles;
    expect(run(marked(elements)).candidates).toEqual([]);
    b.styles.fontSize = "14.6px";
    expect(
      run(marked(elements)).candidates[0]?.verification?.params?.differences,
    ).toEqual(["font"]);
    a.rect.width += 0.1;
    b.rect.x += 0.1;
    expect(
      run(marked(elements)).candidates[0]?.verification?.params?.differences,
    ).toEqual(["size", "font", "placement"]);
  });

  test("swapping declarations keeps the measured asymmetry", () => {
    const { b, elements } = scene();
    b.rect.x += 10;
    const original = run(marked(elements)).candidates[0];
    const swapped = run(marked(elements), [{ ...pair, a: pair.b, b: pair.a }])
      .candidates[0];
    expect(original?.verification?.params?.distances).toEqual([16, 26]);
    expect(swapped?.verification?.params?.distances).toEqual([26, 16]);
    expect(swapped?.verification?.params?.differences).toEqual(
      original?.verification?.params?.differences,
    );
  });

  test("missing selector matches and unresolved capture marks skip with coverage", () => {
    const { a, elements } = scene();
    const empty = run(marked([a]));
    expect(empty).toMatchObject({
      candidates: [],
      coverage: {
        status: "skipped",
        reason: expect.stringContaining("#b matches nothing"),
      },
    });
    expect(run(tupleOf(elements))).toMatchObject({
      candidates: [],
      coverage: {
        status: "skipped",
        reason: expect.stringContaining("not resolved at capture"),
      },
    });
    const extra = { ...pair, name: "missing", b: "#missing" };
    expect(run(marked(elements, [pair, extra]), [pair, extra])).toMatchObject({
      candidates: [],
      coverage: { status: "ran", reason: expect.stringContaining("skipped:") },
    });
  });

  test("coincident centres skip with coverage", () => {
    const { a, b, elements } = scene();
    b.rect.x = a.rect.x + 1;
    expect(run(marked(elements))).toMatchObject({
      candidates: [],
      coverage: {
        status: "skipped",
        reason: expect.stringContaining("overlap on the mirror axis"),
      },
    });
  });

  test("unconfigured checks skip; missing and legacy signals are unavailable", () => {
    const { elements } = scene();
    const tuple = marked(elements);
    delete tuple.observations;
    expect(run(tuple, []).coverage.status).toBe("skipped");
    expect(run(tuple).coverage.status).toBe("unavailable");
    tuple.observations = {
      ...tupleOf(elements).observations,
      version: 1,
    } as ObservationArtifact;
    expect(run(tuple).coverage.status).toBe("unavailable");
    delete elements[0]?.signals;
    expect(run(marked(elements)).coverage.status).toBe("unavailable");
    for (const el of elements) delete el.signals;
    expect(run(marked(elements)).coverage.status).toBe("unavailable");
  });
});

test("pairs sharing b remain separate through review, decision suppression and verification", () => {
  const { a, b, elements } = scene();
  a.rect.width = 40;
  const c = element({
    selector: "#c",
    rect: { ...a.rect, width: 50 },
    ancestorSelectors: a.ancestorSelectors,
    signals: { hasGraphic: true },
  });
  elements.push(c);
  const pairs = [pair, { ...pair, name: "second", a: "#c" }];
  const tuple = marked(elements, pairs);
  const candidates = run(tuple, pairs).candidates;
  expect(candidates).toHaveLength(2);
  const drafts = dedupeFindingDrafts(
    buildDeterministicDrafts({
      runId: "mirrored",
      entries: candidates.map((candidate) => ({
        tuple,
        candidate,
        checkOrder: 0,
      })),
    }),
  );
  expect(drafts).toHaveLength(2);
  expect(drafts.map(({ selectorHint }) => selectorHint)).toEqual([
    b.selector,
    b.selector,
  ]);
  expect(new Set(drafts.map(({ finding }) => finding.fingerprint)).size).toBe(
    2,
  );
  const first = drafts[0];
  if (first === undefined) throw new Error("missing first pair draft");
  const result = suppressFindingDrafts(drafts, [
    {
      findingId: first.finding.id,
      fingerprint: first.finding.fingerprint,
      decision: "reject",
      scope: "rule",
      reason: "intentional",
      at: tuple.createdAt,
      commit: tuple.commit,
      actor: "human",
    },
  ]);
  expect(result.kept).toHaveLength(1);
  expect(result.suppressed).toHaveLength(1);
  const fingerprints = deterministicFingerprintSet(
    [tuple],
    "light",
    config({ mirrored: pairs }),
  );
  for (const draft of drafts)
    expect(fingerprints.has(draft.finding.fingerprint)).toBe(true);
});

test("legacy rendered-content evidence loads but cannot silently pass mirrored checks", async () => {
  const { observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  const { a, elements } = scene();
  const tuple = marked(elements);
  expect(observationArtifactSchema.parse(tuple.observations)).toEqual(
    tuple.observations,
  );
  if (a.signals === undefined) throw new Error("missing signals");
  delete a.signals.renderedContent;
  expect(observationArtifactSchema.parse(tuple.observations)).toEqual(
    tuple.observations,
  );
  expect(run(tuple)).toMatchObject({
    candidates: [],
    coverage: {
      status: "unavailable",
      reason: expect.stringContaining("rendered-content signals (recapture)"),
    },
  });
});

test("captures without complete text evidence load with unavailable coverage", async () => {
  const { observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  const { a, elements } = scene();
  if (a.signals?.renderedContent === undefined)
    throw new Error("missing content");
  delete a.signals.renderedContent.textEvidence;
  const tuple = marked(elements);
  expect(observationArtifactSchema.parse(tuple.observations)).toEqual(
    tuple.observations,
  );
  expect(run(tuple)).toMatchObject({
    candidates: [],
    coverage: {
      status: "unavailable",
      reason: expect.stringContaining(
        "DOM/generated text font evidence (recapture)",
      ),
    },
  });
});

test.each([
  "signals",
  "renderedContent",
  "textEvidence",
  "unsupported",
] as const)(
  "%s unavailability stays local when other pairs run or skip",
  (missing) => {
    const { a, b, elements } = scene();
    a.rect.width += 8;
    const c = element({
      selector: "#c",
      rect: { ...a.rect },
      signals: { hasGraphic: true },
    });
    const d = element({
      selector: "#d",
      rect: { ...b.rect },
      signals: { hasGraphic: true },
    });
    if (c.signals?.renderedContent === undefined)
      throw new Error("missing captured evidence");
    switch (missing) {
      case "signals":
        delete c.signals;
        break;
      case "renderedContent":
        delete c.signals.renderedContent;
        break;
      case "textEvidence":
        delete c.signals.renderedContent.textEvidence;
        break;
      case "unsupported":
        c.signals.renderedContent.textEvidence = {
          status: "unavailable",
          reason: "unsupported generated content",
        };
        break;
    }
    elements.push(c, d);
    const badPair = {
      ...pair,
      name: "unavailable pair",
      a: c.selector,
      b: d.selector,
    };
    const skippedPair = { ...pair, name: "missing pair", a: "#absent" };
    const alone = run(marked(elements)).candidates;
    expect(alone).toHaveLength(1);
    for (const pairs of [
      [pair, badPair, skippedPair],
      [skippedPair, badPair, pair],
    ]) {
      const result = run(marked(elements, pairs), pairs);
      expect(result.candidates).toEqual(alone);
      expect(result.coverage.status).toBe("ran");
      expect(result.coverage.reason).toContain(
        'unavailable: "unavailable pair":',
      );
      expect(result.coverage.reason).toContain('skipped: "missing pair":');
    }
    const result = run(marked(elements, [badPair, skippedPair]), [
      badPair,
      skippedPair,
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.coverage.status).toBe("unavailable");
    expect(result.coverage.reason).toContain(
      'unavailable: "unavailable pair":',
    );
    expect(result.coverage.reason).toContain('skipped: "missing pair":');
  },
);
