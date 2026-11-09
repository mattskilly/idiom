import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { disclosureAffordanceCheck } from "../src/checks/disclosure-affordance.js";
import {
  type IconMember,
  iconMeaningCheck,
  iconMeanings,
  meaningWords,
} from "../src/checks/icon-meaning.js";
import { openerCannotCloseCheck } from "../src/checks/opener-cannot-close.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  IconControlObservation,
  IndicatorSnapshot,
  ObservationArtifactV2,
  ProbeResult,
} from "../src/checks/types.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const config = checksConfigFrom();

const snapshot = (
  expanded: string,
  overrides: Partial<IndicatorSnapshot> = {},
): IndicatorSnapshot => ({
  expanded,
  marker: false,
  text: "Settings",
  graphics: [{ where: "inside", signature: "gear|none", visible: true }],
  ...overrides,
});

const result = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  selector: "#settings",
  name: "Settings",
  effects: ["dom", "aria"],
  persistent: true,
  ...overrides,
});

const withProbe = (
  results: ProbeResult[],
  summaries: { indicators?: boolean; reclick?: boolean } = {},
): ObservationArtifactV2 => ({
  ...invariantObservations(),
  probe: {
    status: "ran",
    results,
    ...(summaries.indicators === false ? {} : { indicators: { recorded: 1 } }),
    ...(summaries.reclick === false
      ? {}
      : { reclick: { tested: 1, notReached: 0, limit: 12 } }),
  },
});

const context = (observations: ObservationArtifactV2) => ({
  tuple: invariantTuple(observations),
  narrowViewport: false,
  config,
});

const unchanged = result({
  indicator: { before: snapshot("false"), after: snapshot("true") },
});

test("disclosure-affordance reports a toggle whose indicator does not change", () => {
  const run = disclosureAffordanceCheck.run(context(withProbe([unchanged])));
  expect(run.coverage.status).toBe("ran");
  expect(run.candidates).toHaveLength(1);
  expect(run.candidates[0]).toMatchObject({
    severity: "minor",
    rule: "idiom:disclosure-affordance",
    selectorHint: "#settings",
  });
});

test.each([
  [
    "a rotated graphic",
    {
      graphics: [
        { where: "inside" as const, signature: "gear|rotate", visible: true },
      ],
    },
  ],
  [
    "an added graphic",
    {
      graphics: [
        ...snapshot("true").graphics,
        { where: "after" as const, signature: "x", visible: true },
      ],
    },
  ],
  [
    "a hidden graphic",
    {
      graphics: [
        { where: "inside" as const, signature: "gear|none", visible: false },
      ],
    },
  ],
  ["changed text", { text: "Hide settings" }],
  ["a native marker", { marker: true }],
])("disclosure-affordance passes %s", (_label, after) => {
  const run = disclosureAffordanceCheck.run(
    context(
      withProbe([
        result({
          indicator: {
            before: snapshot("false"),
            after: snapshot("true", after),
          },
        }),
      ]),
    ),
  );
  expect(run.candidates).toEqual([]);
});

test("disclosure-affordance exempts menu buttons, help glyphs and ignores non-toggles and reused results", () => {
  const textMenu = result({
    name: "More",
    indicator: {
      before: snapshot("false", { text: "More", graphics: [] }),
      after: snapshot("true", { text: "More", graphics: [] }),
    },
  });
  const kebab = result({
    selector: "#kebab",
    name: "More options",
    openedDisclosure: {
      root: "#menu",
      kind: "popup",
      trigger: { x: 0, y: 0, width: 32, height: 32 },
      panel: { x: 0, y: 40, width: 120, height: 80 },
    },
    indicator: { before: snapshot("false"), after: snapshot("true") },
  });
  const sort = result({
    selector: "#sort",
    name: "Sort",
    openedDisclosure: {
      root: "#sort-menu",
      kind: "popup",
      trigger: { x: 0, y: 0, width: 48, height: 32 },
      panel: { x: 0, y: 40, width: 120, height: 80 },
    },
    indicator: {
      before: snapshot("false", { text: "Sort", graphics: [] }),
      after: snapshot("true", { text: "Sort", graphics: [] }),
    },
  });
  const help = result({
    selector: "#help",
    name: "Layer keyboard shortcuts",
    indicator: {
      before: snapshot("closed", { text: "?", graphics: [] }),
      after: snapshot("open", { text: "?", graphics: [] }),
    },
  });
  const noToggle = result({
    indicator: { before: snapshot("true"), after: snapshot("true") },
  });
  const reused = { ...unchanged, reusedFrom: "home" };
  const run = disclosureAffordanceCheck.run(
    context(withProbe([textMenu, kebab, sort, help, noToggle, reused])),
  );
  expect(run.candidates).toEqual([]);
});

test("disclosure-affordance still reports a text-only in-flow expander", () => {
  const settings = result({
    indicator: {
      before: snapshot("false", { graphics: [] }),
      after: snapshot("true", { graphics: [] }),
    },
  });
  expect(
    disclosureAffordanceCheck.run(context(withProbe([settings]))).candidates,
  ).toHaveLength(1);
});

test("disclosure-affordance and opener-cannot-close are unavailable on older probes", () => {
  const old = context(
    withProbe([unchanged], { indicators: false, reclick: false }),
  );
  expect(disclosureAffordanceCheck.run(old).coverage.status).toBe(
    "unavailable",
  );
  expect(openerCannotCloseCheck.run(old).coverage.status).toBe("unavailable");
});

test("opener-cannot-close reports only a stayed-open re-click with no close control nearby", () => {
  const reclick = (
    outcome: NonNullable<ProbeResult["reclick"]>["outcome"],
  ) => ({
    trigger: "html > body > header > button",
    root: "html > body > aside",
    outcome,
  });
  const run = openerCannotCloseCheck.run(
    context(
      withProbe([
        result({
          selector: "#logo",
          name: "Logo",
          reclick: reclick("stayed-open"),
        }),
        result({ selector: "#a", reclick: reclick("closed") }),
        result({ selector: "#b", reclick: reclick("not-tested") }),
        result({
          selector: "#c",
          reclick: {
            ...reclick("stayed-open"),
            closeNearby: {
              selector: "html > body > aside > button",
              name: "Close",
            },
          },
        }),
        result({
          selector: "#d",
          reclick: reclick("stayed-open"),
          reusedFrom: "home",
        }),
      ]),
    ),
  );
  expect(run.candidates).toHaveLength(1);
  expect(run.candidates[0]).toMatchObject({
    severity: "minor",
    rule: "idiom:opener-cannot-close",
    selectorHint: "#logo",
  });
});

test("meaningWords folds case, stopwords, numbers, plurals and synonyms", () => {
  expect([...meaningWords("Close the dialog")]).toEqual(["close", "dialog"]);
  expect(meaningWords("Dismiss")).toEqual(meaningWords("Close"));
  expect([...meaningWords("3-column layout")]).toEqual(["column", "layout"]);
  expect([...meaningWords("Delete items")]).toEqual(["delete"]);
  expect([...meaningWords("Collapse panel")]).toEqual(["toggle", "panel"]);
  expect([...meaningWords("Notifications")]).toEqual(["notification"]);
  expect(meaningWords("Button icon")).toEqual(new Set());
});

const member = (
  name: string,
  effects?: string[],
  overrides: Partial<IconMember> = {},
): IconMember => ({
  state: "home",
  label: "home",
  selector: `#${name.replace(/\W+/g, "-")}`,
  name,
  words: meaningWords(name),
  ...(effects === undefined ? {} : { effects: new Set(effects) }),
  ...overrides,
});

test("iconMeanings groups shared words and splits disjoint effects", () => {
  expect(iconMeanings([member("Close"), member("Close panel")])).toHaveLength(
    1,
  );
  expect(
    iconMeanings([member("Collapse panel"), member("3-column layout")]),
  ).toHaveLength(2);
  expect(
    iconMeanings([
      member("Delete Alice"),
      member("Delete Bob"),
      member("Delete Carol"),
    ]),
  ).toHaveLength(1);
  // Same name, unrelated effects: two meanings.
  expect(
    iconMeanings([
      member("Open", ["navigate"]),
      member("Open", ["download"], { selector: "#other" }),
    ]),
  ).toHaveLength(2);
  // Overlapping effects, or one side without evidence: one meaning.
  expect(
    iconMeanings([
      member("Open", ["navigate", "change"]),
      member("Open", ["change"], { selector: "#other" }),
    ]),
  ).toHaveLength(1);
  expect(
    iconMeanings([
      member("Open", ["navigate"]),
      member("Open", undefined, { selector: "#other" }),
    ]),
  ).toHaveLength(1);
  // The same control in another viewport is never split by its effects.
  expect(
    iconMeanings([member("Open", ["navigate"]), member("Open", ["download"])]),
  ).toHaveLength(1);
});

const icon = (
  name: string,
  overrides: Partial<IconControlObservation> = {},
): IconControlObservation => ({
  selector: `button[aria-label="${name}"]`,
  path: `html > body > button.${name.replace(/\W+/g, "-")}`,
  name,
  role: "button",
  fingerprint: "svg:0badcafe",
  placement: "only",
  disclosure: false,
  ...overrides,
});

const stateTuple = (
  state: string,
  iconControls: IconControlObservation[] | undefined,
  viewport = "desktop",
): CheckTuple => ({
  ...invariantTuple({
    ...invariantObservations(),
    ...(iconControls === undefined ? {} : { iconControls }),
  }),
  state,
  viewport,
});

test("icon-meaning emits once, on the first state carrying the icon", () => {
  const tuples = [
    stateTuple("board", [icon("Collapse panel")]),
    stateTuple("board", [icon("Collapse panel")], "phone"),
    stateTuple("layout", [icon("3-column layout")]),
  ];
  const runs = tuples.map((tuple) =>
    iconMeaningCheck.run({ tuple, tuples, narrowViewport: false, config }),
  );
  expect(runs.map((run) => run.candidates.length)).toEqual([1, 1, 0]);
  expect(runs[0]?.candidates[0]?.fingerprintHint).toBe(
    runs[1]?.candidates[0]?.fingerprintHint,
  );
  expect(runs[0]?.candidates[0]?.explanation).toContain(
    '"Collapse panel" (board), "3-column layout" (layout)',
  );
});

test("icon-meaning ignores trailing icons and icons on disclosures with text", () => {
  const tuples = [
    stateTuple("home", [
      icon("Billing", { placement: "trailing" }),
      icon("Team", { placement: "trailing" }),
      icon("Projects", { placement: "leading", disclosure: true }),
      icon("Search", { placement: "leading", disclosure: true }),
    ]),
  ];
  const run = iconMeaningCheck.run({
    tuple: tuples[0] as CheckTuple,
    tuples,
    narrowViewport: false,
    config,
  });
  expect(run.coverage.status).toBe("ran");
  expect(run.candidates).toEqual([]);
});

test("icon-meaning is unavailable for a capture without icon fingerprints", () => {
  const tuple = stateTuple("home", undefined);
  expect(
    iconMeaningCheck.run({
      tuple,
      tuples: [tuple],
      narrowViewport: false,
      config,
    }).coverage.status,
  ).toBe("unavailable");
});

test("the observation schema accepts the new capture fields", () => {
  const observations = {
    ...withProbe([
      result({
        indicator: { before: snapshot("false"), after: snapshot("true") },
        reclick: {
          trigger: "html > body > button",
          root: "html > body > aside",
          outcome: "stayed-open",
          closeNearby: {
            selector: "html > body > aside > button",
            name: "Close",
          },
        },
      }),
    ]),
    iconControls: [icon("Close", { id: "#close" })],
  };
  expect(() => observationArtifactSchema.parse(observations)).not.toThrow();
  expect(() =>
    observationArtifactSchema.parse({
      ...observations,
      iconControls: [{ ...icon("Close"), placement: "middle" }],
    }),
  ).toThrow();
});
