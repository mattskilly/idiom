import { describe, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import {
  linkedCounterparts,
  stateJumpCheck,
  stateJumps,
} from "../src/checks/state-jump.js";
import type {
  CheckTuple,
  ObservedElementV2,
  Rect,
  SelectorMark,
} from "../src/checks/types.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";
import { signalElement } from "./signal-element-support.js";

function control(
  selector: string,
  name: string,
  rect: Partial<Rect> = {},
  extra: Partial<Omit<ObservedElementV2, "signals" | "styles">> = {},
  role = "button",
): ObservedElementV2 {
  return signalElement(selector, {
    tag: role === "link" ? "a" : "button",
    interactive: true,
    rect: { x: 0, y: 0, width: 28, height: 28, ...rect },
    ancestorSelectors: ["header", "body"],
    signals: { role, name },
    ...extra,
  });
}

function state(
  id: string,
  elements: ObservedElementV2[],
  extra: Partial<CheckTuple> = {},
  marks?: SelectorMark[],
): CheckTuple {
  return {
    ...invariantTuple({
      ...invariantObservations(),
      elements,
      ...(marks === undefined ? {} : { selectorMarks: marks }),
    }),
    state: id,
    ...extra,
  };
}

const run = (tuple: CheckTuple, tuples: CheckTuple[]) =>
  stateJumpCheck.run({
    tuple,
    tuples,
    narrowViewport: false,
    config: checksConfigFrom(),
  });

const nav = [
  control("#projects", "Projects", { x: 100, y: 12, width: 80, height: 28 }),
  control("#reports", "Reports", { x: 190, y: 12, width: 80, height: 28 }),
];

describe("pairing", () => {
  const editor = state("editor", nav);
  const drawer = state("drawer", nav, { from: "editor" });
  test("a from state pairs with its source", () => {
    expect(linkedCounterparts(drawer, [editor, drawer])).toEqual({
      linked: true,
      before: [editor],
      missing: [],
    });
  });

  test("an unlinked state is not applicable", () => {
    expect(run(editor, [editor, drawer]).coverage).toMatchObject({
      status: "not-applicable",
      reason: "state is not linked to another captured state (from or toggles)",
    });
  });

  test("an unhealthy or absent counterpart is skipped with its name", () => {
    const failed = { ...editor, failure: { stage: "load", message: "x" } };
    expect(run(drawer, [failed, drawer]).coverage).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining('"editor"'),
    });
    expect(run(drawer, [drawer]).coverage.status).toBe("skipped");
    const mismatched = {
      ...editor,
      mismatches: [{ kind: "status", expected: "200", actual: "500" }],
    } as unknown as CheckTuple;
    expect(run(drawer, [mismatched, drawer]).coverage.status).toBe("skipped");
  });

  test("other viewports and schemes are not paired", () => {
    const phone = state("editor", nav, { viewport: "phone" });
    const light = state("editor", nav, { colorScheme: "light" });
    expect(linkedCounterparts(drawer, [phone, light, drawer])).toEqual({
      linked: true,
      before: [],
      missing: ["editor"],
    });
  });

  const combo = (
    label: string,
    options: Record<string, string>,
    extra: Partial<CheckTuple> = {},
  ) =>
    state(`editor.${label}`, nav, {
      combination: label,
      combinationBase: "editor",
      combinationOptions: options,
      ...extra,
    });

  test("a combination pairs with its base, ignoring its inherited from", () => {
    const source = state("home", nav);
    const narrow = combo(
      "panel=narrow,theme=a",
      { panel: "narrow", theme: "a" },
      {
        from: "home",
      },
    );
    expect(linkedCounterparts(narrow, [source, editor, narrow])).toEqual({
      linked: true,
      before: [editor],
      missing: [],
    });
  });

  test("combinations differing in exactly one toggle pair once", () => {
    const a = combo("panel=narrow,theme=a", { panel: "narrow", theme: "a" });
    const b = combo("panel=wide,theme=a", { panel: "wide", theme: "a" });
    const c = combo("panel=wide,theme=b", { panel: "wide", theme: "b" });
    const all = [editor, a, b, c];
    const sources = (tuple: CheckTuple) => {
      const linked = linkedCounterparts(tuple, all);
      return linked.linked ? linked.before.map((other) => other.state) : [];
    };
    expect(sources(a)).toEqual(["editor"]);
    // b is later than a and differs in one toggle.
    expect(sources(b)).toEqual(["editor", a.state]);
    // c differs from a in two toggles: not paired.
    expect(sources(c)).toEqual(["editor", b.state]);
  });
});

describe("matching and thresholds", () => {
  test("a resized trigger fires once, with both boxes and both tuples", () => {
    const before = state("editor", [
      control("#logo", "Home", { x: 16, y: 12, width: 28, height: 28 }),
      control(
        "#logo-img",
        "Home logo",
        { x: 16, y: 12, width: 28, height: 28 },
        {
          tag: "img",
          interactive: false,
          ancestorSelectors: ["#logo", "header", "body"],
        },
        "img",
      ),
      ...nav,
    ]);
    const after = state(
      "editor.drawer",
      [
        control("button.logo.compact", "Home", {
          x: 24,
          y: 14,
          width: 24,
          height: 24,
        }),
        control(
          "#logo-img",
          "Home logo",
          { x: 24, y: 14, width: 24, height: 24 },
          {
            tag: "img",
            interactive: false,
            ancestorSelectors: ["button.logo.compact", "header", "body"],
          },
          "img",
        ),
        ...nav,
      ],
      { from: "editor" },
    );
    const result = run(after, [before, after]);
    expect(result.coverage.status).toBe("ran");
    expect(result.candidates).toHaveLength(1);
    const [finding] = result.candidates;
    expect(finding).toMatchObject({
      rule: "idiom:state-jump",
      severity: "minor",
      selectorHint: "button.logo.compact",
      evidenceTuples: [before, after],
    });
    expect(finding?.explanation).toContain(
      'The button "Home" moves 8px right and 2px down and shrinks from 28×28 to 24×24 between "editor" and "editor.drawer"',
    );
    expect(finding?.explanation).toContain("before x 16, y 12, 28×28");
    expect(finding?.explanation).toContain("after x 24, y 14, 24×24");
    expect(finding?.verification).toMatchObject({
      check: "state-jump",
      params: {
        before: { state: "editor", rect: { x: 16, width: 28 } },
        after: { state: "editor.drawer", rect: { x: 24, width: 24 } },
        delta: { dx: 8, dy: 2, dw: -4, dh: -4 },
        toleranceCssPx: 1,
      },
    });
  });

  test("1px is tolerated and 1.5px is reported", () => {
    const at = (x: number) => state("s", [control("#a", "A", { x }), ...nav]);
    const before = at(10);
    expect(stateJumps(before, at(11))).toEqual([]);
    expect(stateJumps(before, at(11.5))).toHaveLength(1);
  });

  test("an ambiguous name falls back to a stable selector, never an nth- path", () => {
    const before = state("a", [
      control("#first", "Edit", { x: 0 }),
      control("#second", "Edit", { x: 50 }),
      control("div > button:nth-of-type(3)", "", { x: 100 }),
    ]);
    const after = state("b", [
      control("#first", "Edit", { x: 0 }),
      control("#second", "Edit", { x: 70 }),
      control("div > button:nth-of-type(3)", "", { x: 140 }),
    ]);
    const jumps = stateJumps(before, after);
    if ("reason" in jumps) throw new Error(jumps.reason);
    expect(jumps.map((jump) => jump.after.element.selector)).toEqual([
      "#second",
    ]);
  });

  test("a renamed trigger matches by its stable selector", () => {
    const before = state("a", [control("#menu", "Open menu", { x: 10 })]);
    const after = state("b", [control("#menu", "Close menu", { x: 10.5 })]);
    expect(stateJumps(before, after)).toEqual([]);
    const moved = state("b", [control("#menu", "Close menu", { x: 20 })]);
    expect(stateJumps(before, moved)).toHaveLength(1);
  });

  test("a role change leaves the element unmatched", () => {
    const before = state("a", [control("#go", "Go", { x: 0 })]);
    const after = state("b", [
      control("#go-link", "Go", { x: 40 }, {}, "link"),
    ]);
    expect(stateJumps(before, after)).toEqual([]);
  });
});

describe("frame offset", () => {
  const page = (dy: number, fixed = false) =>
    state("s", [
      control("#menu", "Menu", { x: 8, y: fixed ? 8 : 8 + dy }),
      control("#a", "A", { y: 100 + dy }),
      control("#b", "B", { y: 140 + dy }),
      control("#c", "C", { y: 180 + dy }),
      control("#d", "D", { y: 220 + dy }),
    ]);

  test("a uniformly scrolled page reports nothing", () => {
    expect(stateJumps(page(0), page(-300))).toEqual([]);
  });

  test("fixed chrome over scrolled content reports nothing", () => {
    expect(stateJumps(page(0, true), page(-300, true))).toEqual([]);
  });

  const scrolled = (tuple: CheckTuple, scrollY: number): CheckTuple => {
    const observations = tuple.observations;
    if (observations?.version !== 2) throw new Error("v2");
    return {
      ...tuple,
      observations: {
        ...observations,
        document: { ...observations.document, scrollX: 0, scrollY },
      },
    };
  };

  test("a recorded scroll separates scrolled content from a real jump", () => {
    // Fixed menu, content scrolled 300px; #b also moved 20px in the page.
    const before = scrolled(page(0, true), 0);
    const elements =
      page(-300, true).observations?.version === 2
        ? (page(-300, true).observations as { elements: ObservedElementV2[] })
            .elements
        : [];
    const after = scrolled(
      state(
        "s",
        elements.map((element) =>
          element.selector === "#b"
            ? { ...element, rect: { ...element.rect, y: element.rect.y + 20 } }
            : element,
        ),
      ),
      300,
    );
    const jumps = stateJumps(before, after);
    if ("reason" in jumps) throw new Error(jumps.reason);
    expect(jumps.map((jump) => [jump.after.element.selector, jump.dy])).toEqual(
      [["#b", 20]],
    );
  });

  test("a recorded zero scroll keeps a push that the estimate would absorb", () => {
    const before = scrolled(page(0, true), 0);
    const after = scrolled(page(120, true), 0);
    const jumps = stateJumps(before, after);
    if ("reason" in jumps) throw new Error(jumps.reason);
    expect(jumps).toHaveLength(4);
  });
});

describe("grouping and intended changes", () => {
  test("elements pushed together are one finding", () => {
    const list = (dy: number) => [
      control("#a", "A", { y: 100 + dy }),
      control("#b", "B", { y: 140 + dy }),
      control("#c", "C", { y: 180 + dy }),
      control("#d", "D", { y: 220 + dy }),
    ];
    const header = [
      control("#h1", "H1", { y: 0 }),
      control("#h2", "H2", { y: 0, x: 40 }),
      control("#h3", "H3", { y: 0, x: 80 }),
      control("#h4", "H4", { y: 0, x: 120 }),
      control("#h5", "H5", { y: 0, x: 160 }),
    ];
    const before = state("closed", [...header, ...list(0)]);
    const after = state("open", [...header, ...list(120)], { from: "closed" });
    const result = run(after, [before, after]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.explanation).toMatch(
      /^4 elements \("A", "B", "C", …\) move together 120px down between "closed" and "open"/,
    );
  });

  test("jump-ok marks on either side, or on an ancestor, suppress", () => {
    const before = state("a", [control("#side", "Side", { width: 200 })]);
    const after = state("b", [
      control(
        "#side",
        "Side",
        { width: 64 },
        {
          ancestorSelectors: ["#rail", "body"],
        },
      ),
    ]);
    expect(stateJumps(before, after)).toHaveLength(1);
    const mark = (selector: string, matches: string[]): SelectorMark[] => [
      { purpose: "jump-ok", selector, matches },
    ];
    const ownMarked = state(
      "b",
      after.observations?.version === 2 ? after.observations.elements : [],
      {},
      mark("#side", ["#side"]),
    );
    expect(stateJumps(before, ownMarked)).toEqual([]);
    const ancestorMarked = state(
      "b",
      after.observations?.version === 2 ? after.observations.elements : [],
      {},
      mark("#rail", ["#rail"]),
    );
    expect(stateJumps(before, ancestorMarked)).toEqual([]);
    const beforeMarked = state(
      "a",
      before.observations?.version === 2 ? before.observations.elements : [],
      {},
      mark("#side", ["#side"]),
    );
    expect(stateJumps(beforeMarked, after)).toEqual([]);
  });

  test("jump-ok selector marks parse in the observation schema", () => {
    expect(
      observationArtifactSchema.safeParse({
        ...invariantObservations(),
        selectorMarks: [
          { purpose: "jump-ok", selector: "#side", matches: ["#side"] },
        ],
      }).success,
    ).toBe(true);
  });
});
