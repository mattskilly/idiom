import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import {
  oddControls,
  offCentreItems,
  rowReference,
  toolbarLayoutCheck,
} from "../src/checks/toolbar-layout.js";
import type {
  ChecksConfig,
  ObservationArtifactV2,
  ToolbarControlObservation,
  ToolbarItemObservation,
  ToolbarLayoutObservation,
} from "../src/checks/types.js";
import { checkMarks, checksConfigSchema } from "../src/schemas/project.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const run = (
  fields: Partial<ObservationArtifactV2>,
  config: ChecksConfig = checksConfigFrom(),
) =>
  toolbarLayoutCheck.run({
    tuple: invariantTuple({ ...invariantObservations(), ...fields }),
    tuples: [],
    narrowViewport: false,
    config,
  });

const item = (
  selector: string,
  centre: number,
  fields: Partial<ToolbarItemObservation> = {},
): ToolbarItemObservation => ({
  selector,
  row: 0,
  centre,
  top: centre - 14,
  height: 28,
  text: "",
  ...fields,
});
const control = (
  selector: string,
  fields: Partial<ToolbarControlObservation> = {},
): ToolbarControlObservation => ({
  selector,
  border: "none",
  text: "",
  ...fields,
});
const toolbar = (
  fields: Partial<ToolbarLayoutObservation> = {},
): ToolbarLayoutObservation => ({
  toolbar: "div.bar",
  rect: { x: 0, y: 0, width: 300, height: 42 },
  vertical: false,
  height: 42,
  singleRowHeight: 42,
  rows: 1,
  items: [item("button.a", 20), item("button.b", 20), item("button.c", 20)],
  controls: [control("button.a"), control("button.b"), control("button.c")],
  ...fields,
});
const ran = (records: ToolbarLayoutObservation[]) => ({
  toolbarLayouts: { status: "ran" as const, records },
});
const config = (toolbarLayout: unknown) =>
  checksConfigFrom(checksConfigSchema.parse({ toolbarLayout }));

test("unavailable on captures that predate the scan, skipped when disabled", () => {
  expect(run({}).coverage).toMatchObject({
    status: "unavailable",
    reason: "observations predate the toolbar-layout scan (recapture)",
  });
  const disabled = run(ran([toolbar()]), config({ enabled: false }));
  expect(disabled.coverage).toMatchObject({
    status: "skipped",
    reason: "checks.toolbarLayout is not enabled",
  });
  expect(run(ran([toolbar()])).candidates).toEqual([]);
  expect(run(ran([toolbar()])).coverage.status).toBe("ran");
});

test("partial scans keep coverage honest", () => {
  const result = run({
    toolbarLayouts: {
      status: "partial",
      reason: "more than 30 records; kept the first 30",
      records: [
        toolbar({ rows: 2, items: [item("a", 20), item("b", 60, { row: 1 })] }),
      ],
    },
  });
  expect(result.candidates.map((c) => c.rule)).toEqual(["idiom:toolbar-wrap"]);
  expect(result.coverage).toMatchObject({ status: "unavailable" });
});

test("the row reference is the plurality centre, else the line box midpoint", () => {
  // Three share 20; one sits at 18.
  expect(
    rowReference(
      [item("a", 20), item("b", 20), item("c", 20), item("d", 18)],
      1,
    ),
  ).toBe(20);
  // Two disagree: a tie, so the midpoint of the line box (top 4 .. bottom 38).
  expect(
    rowReference(
      [
        item("a", 18, { top: 4, height: 28 }),
        item("b", 24, { top: 10, height: 28 }),
      ],
      1,
    ),
  ).toBe(21);
  // A chain within tolerance picks the leader closest to its cluster.
  expect(
    rowReference(
      [item("a", 10), item("b", 10.5), item("c", 11), item("d", 11.5)],
      1,
    ),
  ).toBe(10.5);
});

test("offsets are signed (positive sits low), per row, and only beyond the tolerance", () => {
  const items = [
    item("a", 20),
    item("b", 20),
    item("c", 18),
    item("d", 21),
    item("e", 60, { row: 1 }),
  ];
  expect(
    offCentreItems(items, 1).map(({ item, offset }) => [item.selector, offset]),
  ).toEqual([["c", -2]]);
  expect(
    offCentreItems(items, 0.5).map(({ item, offset }) => [
      item.selector,
      offset,
    ]),
  ).toEqual([
    ["c", -2],
    ["d", 1],
  ]);
  expect(offCentreItems(items, 2)).toEqual([]);
  // A lone item on its row has nothing to be centred with.
  expect(offCentreItems([item("e", 60, { row: 1 })], 1)).toEqual([]);
});

test("the configured tolerance and the strictest scoped centring law apply at check time", () => {
  const record = toolbar({
    items: [item("button.a", 20), item("button.b", 20), item("button.c", 22.5)],
    scopes: ['[role="toolbar"]'],
  });
  const offCentre = (settings: unknown) =>
    run(ran([record]), config(settings)).candidates.map(
      (c) => c.verification.params,
    );
  expect(offCentre({})).toEqual([
    expect.objectContaining({ item: "button.c", offset: 2.5, tolerance: 1 }),
  ]);
  expect(offCentre({ centreTolerance: 3 })).toEqual([]);
  const law = (name: string, tolerance: number) => ({
    name,
    selector: '[role="toolbar"]',
    law: "centred",
    tolerance,
  });
  expect(
    offCentre({ centreTolerance: 0.5, scopes: [law("Loose.", 3)] }),
  ).toEqual([]);
  const scoped = run(
    ran([record]),
    config({
      centreTolerance: 3,
      scopes: [law("Loose.", 4), { ...law("Strict.", 2), selector: ".bar" }],
    }),
  );
  // The ".bar" law does not hold this toolbar (not in its scopes), so 4px applies.
  expect(scoped.candidates).toEqual([]);
  const [cited] = run(
    ran([{ ...record, scopes: ['[role="toolbar"]', ".bar"] }]),
    config({
      scopes: [law("Loose.", 4), { ...law("Strict.", 2), selector: ".bar" }],
    }),
  ).candidates;
  expect(cited?.verification.params).toMatchObject({
    tolerance: 2,
    scope: ".bar",
  });
  expect(cited?.explanation).toContain('(law: "Strict.", in .bar)');
  expect(cited?.explanation).toContain("sits 2.5px low");
});

test("the wrap finding names second-row items and both heights, and cites a one-row law", () => {
  const record = toolbar({
    rows: 2,
    height: 74,
    singleRowHeight: 42,
    items: [
      item("button.a", 20),
      item("button.b", 20),
      item("button.reset", 56, { row: 1, text: "Reset position" }),
    ],
    scopes: ['[role="toolbar"]'],
  });
  const [plain] = run(ran([record])).candidates;
  expect(plain?.severity).toBe("major");
  expect(plain?.fingerprintHint).toBe("toolbar-wrap:div.bar");
  expect(plain?.explanation).toBe(
    'div.bar wraps to 2 rows at 800px: button.reset ("Reset position") sits on row 2; the toolbar is 74px tall against 42px on one row.',
  );
  expect(plain?.verification.params).toEqual({
    selector: "div.bar",
    wrapped: ["button.reset"],
    height: 74,
    singleRowHeight: 42,
    rows: 2,
    viewportWidth: 800,
  });
  const [cited] = run(
    ran([record]),
    config({
      scopes: [
        { name: "One row.", selector: '[role="toolbar"]', law: "one-row" },
      ],
    }),
  ).candidates;
  expect(cited?.explanation).toContain(
    '(law: "One row.", in [role="toolbar"])',
  );
  expect(cited?.verification.params).toMatchObject({
    scope: '[role="toolbar"]',
  });
  expect(cited?.fingerprintHint).toBe(plain?.fingerprintHint);
});

test("a vertical toolbar is never a wrap or off-centre finding", () => {
  expect(
    run(
      ran([
        toolbar({
          vertical: true,
          rows: 0,
          items: [],
          controls: [control("a"), control("b"), control("c")],
        }),
      ]),
    ).candidates,
  ).toEqual([]);
});

test("the odd one out needs three valued controls whose siblings agree", () => {
  const odd = (controls: ToolbarControlObservation[]) =>
    oddControls(controls).map((o) => [
      o.control.selector,
      o.property,
      o.value,
      o.siblings,
    ]);
  expect(
    odd([control("a"), control("b"), control("x", { border: "1px solid" })]),
  ).toEqual([["x", "border", "1px solid", "none"]]);
  // Two controls are not enough to call one odd.
  expect(odd([control("a"), control("x", { border: "1px solid" })])).toEqual(
    [],
  );
  // Siblings that disagree among themselves make no odd one out.
  expect(
    odd([
      control("a"),
      control("b", { border: "2px solid" }),
      control("x", { border: "1px solid" }),
    ]),
  ).toEqual([]);
  // Radius compares only controls that paint a box.
  expect(
    odd([
      control("a", { radius: 8 }),
      control("b", { radius: 8 }),
      control("c"),
      control("x", { radius: 4 }),
    ]),
  ).toEqual([["x", "radius", 4, 8]]);
  expect(
    odd([
      control("a", { radius: 8 }),
      control("x", { radius: 4 }),
      control("c"),
    ]),
  ).toEqual([]);
  // Heights within 1px are equal; beyond it, the odd one out is named.
  expect(
    odd([
      control("a", { height: 28 }),
      control("b", { height: 28.5 }),
      control("c", { height: 29 }),
    ]),
  ).toEqual([]);
  expect(
    odd([
      control("a", { height: 28 }),
      control("b", { height: 28 }),
      control("x", { height: 32 }),
    ]),
  ).toEqual([["x", "height", 32, 28]]);
});

test("odd-control findings name the property, the control and both values", () => {
  const [finding] = run(
    ran([
      toolbar({
        controls: [
          control("button.a"),
          control("button.b"),
          control("button.reset", { border: "1px solid", text: "×" }),
        ],
      }),
    ]),
  ).candidates;
  expect(finding).toMatchObject({
    rule: "idiom:toolbar-odd-control",
    severity: "minor",
    category: "toolbar-layout",
    selectorHint: "div.bar",
    fingerprintHint: "toolbar-odd-control:div.bar:border:button.reset",
  });
  expect(finding?.explanation).toBe(
    'In div.bar, button.reset ("×") has a 1px solid border where every sibling control has no border at 800px.',
  );
  expect(finding?.verification.params).toEqual({
    selector: "div.bar",
    control: "button.reset",
    property: "border",
    value: "1px solid",
    siblings: "none",
    viewportWidth: 800,
  });
});

test("config: scopes stay optional, laws are unique per selector, tolerance is for centring", () => {
  const parsed = checksConfigSchema.parse({});
  expect(parsed.toolbarLayout).toEqual({
    enabled: true,
    selectors: [],
    centreTolerance: 1,
  });
  const both = [
    { name: "One row.", selector: '[role="toolbar"]', law: "one-row" },
    {
      name: "Centred.",
      selector: '[role="toolbar"]',
      law: "centred",
      tolerance: 1,
    },
  ];
  expect(
    checksConfigSchema.safeParse({ toolbarLayout: { scopes: both } }).success,
  ).toBe(true);
  expect(
    checksConfigSchema.safeParse({
      toolbarLayout: { scopes: [both[0], both[0]] },
    }).success,
  ).toBe(false);
  expect(
    checksConfigSchema.safeParse({
      toolbarLayout: { scopes: [{ ...both[0], tolerance: 2 }] },
    }).success,
  ).toBe(false);
  expect(
    checksConfigSchema.safeParse({ toolbarLayout: { centreTolerance: 9 } })
      .success,
  ).toBe(false);
  const marks = checkMarks(
    checksConfigSchema.parse({
      toolbarLayout: {
        selectors: [".my-bar", '[role="toolbar"]'],
        scopes: both,
      },
    }),
  ).filter((mark) => mark.purpose === "toolbar-scope");
  expect(marks.map((mark) => mark.selector)).toEqual([
    ".my-bar",
    '[role="toolbar"]',
  ]);
});

test("the artifact schema accepts a toolbar record and caps its items", () => {
  const record = toolbar({ scopes: ['[role="toolbar"]'] });
  const observations = {
    ...invariantObservations(),
    toolbarLayouts: { status: "ran", records: [record] },
  };
  expect(observationArtifactSchema.safeParse(observations).success).toBe(true);
  const over = {
    ...observations,
    toolbarLayouts: {
      status: "ran",
      records: [
        toolbar({
          items: Array.from({ length: 41 }, (_, i) => item(`b${i}`, 20)),
        }),
      ],
    },
  };
  expect(observationArtifactSchema.safeParse(over).success).toBe(false);
});
