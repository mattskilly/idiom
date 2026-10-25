import { describe, expect, test } from "vitest";
import { disguisedControlCheck } from "../src/checks/disguised-control.js";
import { freshStateCheck } from "../src/checks/fresh-state.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ElementSignals,
  ExpandedObservedStyles,
  ObservationArtifact,
  ObservationArtifactV2,
  ObservedElementV2,
  SelectorMark,
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

const fieldStyles: ExpandedObservedStyles = {
  ...styles,
  display: "block",
  textAlign: "left",
  justifyContent: "normal",
  color: "rgb(138, 147, 163)",
  backgroundColor: "rgb(255, 255, 255)",
  ...Object.fromEntries(
    ["Top", "Right", "Bottom", "Left"].flatMap((side) => [
      [`border${side}Width`, "1px"],
      [`border${side}Color`, "rgb(201, 208, 219)"],
    ]),
  ),
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

const button = (text: string, extra: Parameters<typeof element>[0] = {}) =>
  element({ text, ...extra });

/** A 300×36 button drawn as a text field with left-aligned muted copy. */
const fieldButton = (text: string, extra: Parameters<typeof element>[0] = {}) =>
  element({
    text,
    rect: { x: 0, y: 0, width: 300, height: 36 },
    styles: fieldStyles,
    ...extra,
    signals: {
      textRect: { x: 11, y: 10, width: 110, height: 16 },
      ...extra.signals,
    },
  });

function textInput(extra: Parameters<typeof element>[0] = {}) {
  return element({
    tag: "input",
    rect: { x: 0, y: 0, width: 240, height: 36 },
    styles: { ...fieldStyles, color: "rgb(29, 35, 48)" },
    ...extra,
    signals: { role: "textbox", cursor: "text", ...extra.signals },
  });
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

const mark = (
  purpose: SelectorMark["purpose"],
  matches: string[],
): SelectorMark => ({ purpose, selector: `[data-${purpose}]`, matches });

describe("disguised-control", () => {
  const run = (tuple: CheckTuple, checks?: unknown) =>
    disguisedControlCheck.run({
      tuple,
      narrowViewport: false,
      config: config(checks),
    });
  const rules = (tuple: CheckTuple, checks?: unknown) =>
    run(tuple, checks).candidates.map(
      (candidate) => `${candidate.rule} ${candidate.selectorHint}`,
    );

  test("is unavailable on artifacts without signals", () => {
    const tuple = tupleOf([]);
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
    expect(run(tuple).coverage.status).toBe("unavailable");
  });

  test("placeholder copy is reported on its own; dialog and busy ellipses are not", () => {
    const describe = button("Describe a change");
    const search = button("Search…");
    const saveAs = button("Save as…");
    const loading = button("Loading…");
    const plain = button("Publish");
    expect(rules(tupleOf([describe, search, saveAs, loading, plain]))).toEqual([
      `idiom:disguised-control ${describe.selector}`,
      `idiom:disguised-control ${search.selector}`,
    ]);
  });

  test("weak copy needs a field shape; the full field look needs no copy", () => {
    const narrowWeak = button("Write a review");
    const shapedWeak = fieldButton("Write a review", {
      styles: { ...fieldStyles, color: "rgb(29, 35, 48)" },
    });
    const styledOnly = fieldButton("Pick up where you left");
    const darkText = fieldButton("Pick up where you left", {
      styles: { ...fieldStyles, color: "rgb(29, 35, 48)" },
    });
    expect(
      rules(tupleOf([narrowWeak, shapedWeak, styledOnly, darkText])),
    ).toEqual([
      `idiom:disguised-control ${shapedWeak.selector}`,
      `idiom:disguised-control ${styledOnly.selector}`,
    ]);
  });

  test("honest triggers, disabled buttons and ignored selectors are not reported", () => {
    const combobox = fieldButton("Search…", {
      attributes: { role: "combobox" },
    });
    const popup = fieldButton("Search…", { signals: { haspopup: "dialog" } });
    const shortcut = fieldButton("Search… ⌘K");
    const launcher = fieldButton("Search docs…");
    const key = element({
      tag: "kbd",
      text: "K",
      interactive: false,
      ancestorSelectors: [launcher.selector],
    });
    const disabled = button("Search…", { enabled: false });
    const ignoredOne = button("Describe a change");
    expect(
      rules(
        tupleOf(
          [combobox, popup, shortcut, launcher, key, disabled, ignoredOne],
          { selectorMarks: [mark("disguised-ignore", [ignoredOne.selector])] },
        ),
      ),
    ).toEqual([]);
  });

  test("configured placeholder patterns extend the built-ins", () => {
    const ask = button("Ask Builder to change this page");
    expect(rules(tupleOf([ask]))).toEqual([]);
    expect(
      rules(tupleOf([ask]), {
        disguisedControl: { placeholderPatterns: ["^Ask Builder\\b"] },
      }),
    ).toEqual([`idiom:disguised-control ${ask.selector}`]);
  });

  test("a readonly field drawn like the editable ones is reported unless it says why", () => {
    const editable = textInput();
    const slug = textInput({ attributes: { readonly: "" } });
    const titled = textInput({
      attributes: { readonly: "" },
      signals: { title: "Generated from the title" },
    });
    const parent = "div.share";
    const link = textInput({
      attributes: { readonly: "" },
      ancestorSelectors: [parent],
    });
    const copy = button("Copy", { ancestorSelectors: [parent] });
    const greyed = textInput({
      attributes: { readonly: "" },
      styles: {
        ...fieldStyles,
        color: "rgb(29, 35, 48)",
        backgroundColor: "rgb(240, 242, 245)",
      },
    });
    const disabled = textInput({ enabled: false });
    expect(
      rules(tupleOf([editable, slug, titled, link, copy, greyed, disabled])),
    ).toEqual([
      `idiom:input-rejects-text ${slug.selector}`,
      `idiom:input-rejects-text ${disabled.selector}`,
    ]);
    expect(run(tupleOf([editable, slug])).candidates[0]?.explanation).toContain(
      "read-only",
    );
  });
});

describe("fresh-state", () => {
  const run = (tuple: CheckTuple, checks?: unknown) =>
    freshStateCheck.run({
      tuple,
      narrowViewport: false,
      config: config(checks),
    });
  const rules = (tuple: CheckTuple, checks?: unknown) =>
    run(tuple, checks).candidates.map(
      (candidate) => `${candidate.rule} ${candidate.selectorHint}`,
    );

  test("coverage says why it did not run", () => {
    const undo = button("↶", { signals: { name: "Undo" } });
    const missing = tupleOf([undo]);
    missing.observations = undefined;
    expect(run(missing).coverage.status).toBe("unavailable");
    const notFresh = run(tupleOf([undo]));
    expect(notFresh.coverage).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining('"fresh": true'),
    });
    expect(notFresh.candidates).toEqual([]);
    expect(run(tupleOf([undo], { fresh: true })).coverage.status).toBe("ran");
  });

  test("enabled undo/redo is reported; disabled history is not", () => {
    const undo = button("↶", { signals: { name: "Undo" } });
    const redo = button("Redo", { enabled: false });
    const icon = element({
      tag: "svg",
      interactive: true,
      ancestorSelectors: [undo.selector],
      signals: { name: "Undo" },
    });
    expect(rules(tupleOf([undo, icon, redo], { fresh: true }))).toEqual([
      `idiom:fresh-history-enabled ${undo.selector}`,
    ]);
  });

  test("configured names and selector marks extend the defaults", () => {
    const revert = button("Revert");
    const marked = button("↺");
    const fresh = {
      fresh: true,
      selectorMarks: [mark("history", [marked.selector])],
    };
    expect(rules(tupleOf([revert, marked], fresh))).toEqual([
      `idiom:fresh-history-enabled ${marked.selector}`,
    ]);
    expect(
      rules(tupleOf([revert, marked], fresh), {
        freshState: { historyNames: ["^revert\\b"] },
      }),
    ).toEqual([
      `idiom:fresh-history-enabled ${revert.selector}`,
      `idiom:fresh-history-enabled ${marked.selector}`,
    ]);
  });

  test("an unsaved indicator is reported once, by text, pattern or mark", () => {
    const wrapper = element({
      tag: "div",
      interactive: false,
      text: "Page — Unsaved changes",
      directText: "",
    });
    const badge = element({
      tag: "span",
      interactive: false,
      text: "Unsaved changes",
      ancestorSelectors: [wrapper.selector],
    });
    const draft = element({
      tag: "span",
      interactive: false,
      text: "Draft not saved",
    });
    const dot = element({ tag: "span", interactive: false, text: "" });
    const dotChild = element({
      tag: "span",
      interactive: false,
      text: "unsaved",
      ancestorSelectors: [dot.selector],
    });
    const fresh = {
      fresh: true,
      selectorMarks: [mark("unsaved", [dot.selector])],
    };
    expect(
      rules(tupleOf([wrapper, badge, draft, dot, dotChild], fresh), {
        freshState: { unsavedPatterns: ["\\bdraft not saved\\b"] },
      }),
    ).toEqual([
      `idiom:fresh-unsaved-indicator ${badge.selector}`,
      `idiom:fresh-unsaved-indicator ${draft.selector}`,
      `idiom:fresh-unsaved-indicator ${dot.selector}`,
    ]);
  });

  test("negated unsaved copy is the correct fresh status and stays quiet", () => {
    const quiet = [
      "No unsaved changes",
      "There are no unsaved changes",
      "Nothing unsaved",
      "0 unsaved edits",
    ].map((text) => element({ tag: "p", interactive: false, text }));
    const loud = element({
      tag: "p",
      interactive: false,
      text: "You have unsaved changes",
    });
    expect(rules(tupleOf([...quiet, loud], { fresh: true }))).toEqual([
      `idiom:fresh-unsaved-indicator ${loud.selector}`,
    ]);
  });
});
