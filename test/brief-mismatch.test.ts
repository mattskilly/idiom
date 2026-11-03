import { describe, expect, test } from "vitest";
import {
  type BriefCheck,
  briefCheckFrom,
  briefSelectorsFor,
} from "../src/brief/assertions.js";
import {
  briefMismatchCheck,
  evaluateBriefAssertions,
} from "../src/checks/brief-mismatch.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ActionTimelineArtifact,
  CheckTuple,
  ObservedElementV2,
  Rect,
  SelectorMark,
} from "../src/checks/types.js";
import {
  briefAssertionSchema,
  type CompleteStoredBrief,
  isCompleteBrief,
  type StoredBrief,
  storedBriefSchema,
} from "../src/schemas/brief.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

type ElementInput = {
  selector: string;
  rect: Partial<Rect>;
  tag?: string;
  ancestors?: string[];
  visible?: boolean;
  styles?: Partial<ObservedElementV2["styles"]>;
};

function element(input: ElementInput): ObservedElementV2 {
  return {
    selector: input.selector,
    tag: input.tag ?? "div",
    visible: input.visible ?? true,
    ancestorSelectors: input.ancestors ?? [],
    rect: { x: 0, y: 0, width: 100, height: 56, ...input.rect },
    styles: {
      opacity: "1",
      visibility: "visible",
      display: "block",
      color: "rgb(17, 17, 17)",
      backgroundColor: "rgba(0, 0, 0, 0)",
      fill: "rgb(0, 0, 0)",
      stroke: "none",
      ...input.styles,
    },
  } as ObservedElementV2;
}

function tuple(options: {
  elements: ElementInput[];
  marks?: Array<Partial<SelectorMark> & { selector: string }>;
  touch?: boolean;
  timelines?: ActionTimelineArtifact;
  state?: string;
  viewport?: string;
}): CheckTuple {
  const elements = options.elements.map(element);
  const marks = options.marks ?? [];
  return {
    ...invariantTuple({
      ...invariantObservations(),
      elements,
      ...(options.touch === undefined
        ? {}
        : {
            input: options.touch
              ? { pointer: "coarse", hover: "none", maxTouchPoints: 5 }
              : { pointer: "fine", hover: "hover", maxTouchPoints: 0 },
          }),
      selectorMarks: marks.map((mark) => ({
        purpose: "brief",
        matches: [],
        ...mark,
      })) as SelectorMark[],
    }),
    state: options.state ?? "editor",
    viewport: options.viewport ?? "desktop",
    ...(options.timelines === undefined
      ? {}
      : { timelines: options.timelines }),
  };
}

function check(
  assertions: Array<Record<string, unknown>>,
  statement = "tile height unchanged at 56px",
): BriefCheck {
  return {
    slug: "pinned-group",
    title: "Pinned group",
    decision: "Corner pin icon",
    eligible: true,
    criteria: [
      {
        index: 0,
        statement,
        assertions: assertions.map((assertion) =>
          briefAssertionSchema.parse({
            flow: "studio",
            state: "editor",
            ...assertion,
          }),
        ),
      },
    ],
  };
}

const outcomes = (subject: CheckTuple, brief: BriefCheck) =>
  evaluateBriefAssertions(subject, [brief]).map((result) => ({
    outcome: result.outcome,
    reason: result.reason,
    details: result.failures.map((failure) => failure.detail),
  }));

const run = (subject: CheckTuple, briefs: BriefCheck[]) =>
  briefMismatchCheck.run({
    tuple: subject,
    narrowViewport: false,
    config: { ...checksConfigFrom(), briefs },
  });

describe("size", () => {
  const brief = check([{ selector: ".item", height: 56 }]);
  const at = (height: number) =>
    tuple({
      elements: [{ selector: ".item:nth-of-type(1)", rect: { height } }],
      marks: [{ selector: ".item", matches: [".item:nth-of-type(1)"] }],
    });
  test("passes within the default 1px tolerance and fails beyond it", () => {
    expect(outcomes(at(57), brief)[0]?.outcome).toBe("pass");
    expect(outcomes(at(55), brief)[0]?.outcome).toBe("pass");
    expect(outcomes(at(57.01), brief)[0]).toEqual({
      outcome: "mismatch",
      reason: undefined,
      details: [".item height 57.01, expected 56 (tolerance 1)"],
    });
  });
  test("ranges", () => {
    const ranged = check([
      { selector: ".item", width: { min: 80, max: 120 }, tolerance: 0 },
    ]);
    expect(outcomes(at(56), ranged)[0]?.outcome).toBe("pass");
    const wide = tuple({
      elements: [{ selector: ".item:nth-of-type(1)", rect: { width: 121 } }],
      marks: [{ selector: ".item", matches: [".item:nth-of-type(1)"] }],
    });
    expect(outcomes(wide, ranged)[0]?.details).toEqual([
      ".item width 121, expected 80–120 (tolerance 0)",
    ]);
  });
  test("a subject that matched nothing is a mismatch", () => {
    const empty = tuple({ elements: [], marks: [{ selector: ".item" }] });
    expect(outcomes(empty, brief)[0]).toEqual({
      outcome: "mismatch",
      reason: undefined,
      details: [".item matched no elements"],
    });
  });
});

describe("sameSizeAs", () => {
  const brief = check([
    { selector: ".item", sameSizeAs: ".reference", axis: "height" },
  ]);
  test("compares every match to the reference's first match", () => {
    const subject = tuple({
      elements: [
        { selector: ".item:nth-of-type(1)", rect: { height: 56 } },
        { selector: ".item:nth-of-type(2)", rect: { height: 100 } },
        { selector: ".reference:nth-of-type(1)", rect: { height: 56.5 } },
        { selector: ".reference:nth-of-type(2)", rect: { height: 100 } },
      ],
      marks: [
        {
          selector: ".item",
          matches: [".item:nth-of-type(1)", ".item:nth-of-type(2)"],
        },
        {
          selector: ".reference",
          matches: [".reference:nth-of-type(1)", ".reference:nth-of-type(2)"],
        },
      ],
    });
    expect(outcomes(subject, brief)[0]?.details).toEqual([
      ".item height 100, expected 56.5 like .reference (tolerance 1)",
    ]);
  });
  test("a missing reference is a mismatch", () => {
    const subject = tuple({
      elements: [{ selector: ".item:nth-of-type(1)", rect: {} }],
      marks: [
        { selector: ".item", matches: [".item:nth-of-type(1)"] },
        { selector: ".reference" },
      ],
    });
    expect(outcomes(subject, brief)[0]?.details).toEqual([
      ".reference matched no elements",
    ]);
  });
});

describe("within", () => {
  const brief = check([{ selector: ".pin", within: ".tile" }]);
  const tiles = [
    {
      selector: "#a .tile",
      ancestors: ["#a"],
      rect: { x: 0, y: 0, width: 100, height: 56 },
    },
    {
      selector: "#b .tile",
      ancestors: ["#b"],
      rect: { x: 0, y: 80, width: 100, height: 56 },
    },
  ];
  const marks = (pins: string[]) => [
    { selector: ".pin", matches: pins },
    { selector: ".tile", matches: ["#a .tile", "#b .tile"] },
  ];
  test("an in-tile pin passes", () => {
    const subject = tuple({
      elements: [
        ...tiles,
        {
          selector: "#a .pin",
          ancestors: ["#a .tile", "#a"],
          rect: { x: 76, y: 4, width: 20, height: 20 },
        },
      ],
      marks: marks(["#a .pin"]),
    });
    expect(outcomes(subject, brief)[0]?.outcome).toBe("pass");
  });
  test("a pin judged against its own tile fails even inside another tile", () => {
    const subject = tuple({
      elements: [
        ...tiles,
        {
          selector: "#a .pin",
          ancestors: ["#a .tile", "#a"],
          // Hangs out of its own tile into the next one.
          rect: { x: 10, y: 50, width: 20, height: 40 },
        },
      ],
      marks: marks(["#a .pin"]),
    });
    expect(outcomes(subject, brief)[0]?.details).toEqual([
      ".pin extends 34px below .tile",
    ]);
  });
  test("a sibling pin outside every tile fails with the nearest overflow", () => {
    const subject = tuple({
      elements: [
        ...tiles,
        {
          selector: "#a > .pin",
          ancestors: ["#a"],
          rect: { x: 0, y: 56, width: 100, height: 44 },
        },
      ],
      marks: marks(["#a > .pin"]),
    });
    expect(outcomes(subject, brief)[0]?.details).toEqual([
      ".pin extends 44px below .tile",
    ]);
  });
});

describe("visibleWithoutHover", () => {
  const brief = check([{ selector: ".pin", visibleWithoutHover: true }]);
  const pin = (styles: Partial<ObservedElementV2["styles"]>, touch: boolean) =>
    tuple({
      touch,
      viewport: touch ? "mobile" : "desktop",
      elements: [
        { selector: ".tile", rect: {} },
        {
          selector: ".tile .pin",
          ancestors: [".tile"],
          rect: { width: 20, height: 20 },
          styles,
        },
      ],
      marks: [{ selector: ".pin", matches: [".tile .pin"] }],
    });
  test("judged only on touch tuples", () => {
    expect(outcomes(pin({ opacity: "0" }, false), brief)[0]?.outcome).toBe(
      "not-applicable",
    );
    expect(outcomes(pin({}, true), brief)[0]?.outcome).toBe("pass");
    expect(outcomes(pin({ opacity: "0" }, true), brief)[0]?.details).toEqual([
      ".pin is hidden at rest on touch viewport mobile (opacity 0)",
    ]);
    expect(
      outcomes(pin({ visibility: "hidden" }, true), brief)[0]?.details,
    ).toEqual([
      ".pin is hidden at rest on touch viewport mobile (visibility hidden)",
    ]);
  });
});

describe("stableOnHover", () => {
  const brief = check([{ selector: ".tile", stableOnHover: true }]);
  const frame = (time: number, rows: Array<[string, number]>) => ({
    time,
    scroll: { x: 0, y: 0 },
    scrollers: [],
    elements: rows.map(([selector, y]) => ({
      selector,
      rect: { x: 0, y, width: 100, height: 56 },
      offset: { x: 0, y: 0 },
    })),
  });
  const timelines = (hovered: string, moved: number) =>
    ({
      version: 1,
      status: "ran",
      truncated: { actions: 0 },
      actions: [
        {
          source: "probe-hover",
          kind: "hover",
          selector: hovered,
          status: "ran",
          truncated: [],
          shifts: [],
          frames: [
            frame(0, [
              [".tile", 0],
              [".tile .pin", 4],
              [".row", 80],
            ]),
            frame(100, [
              [".tile .pin", 10],
              [".row", 80 + moved],
            ]),
          ],
        },
      ],
    }) as unknown as ActionTimelineArtifact;
  const subject = (hovered: string, moved: number) =>
    tuple({
      elements: [
        { selector: ".tile", rect: {} },
        { selector: ".tile .pin", ancestors: [".tile"], rect: {} },
        { selector: ".row", rect: { y: 80 } },
      ],
      marks: [{ selector: ".tile", matches: [".tile"] }],
      timelines: timelines(hovered, moved),
    });
  test("movement inside the subject is allowed; outside it is a mismatch", () => {
    expect(outcomes(subject(".tile .pin", 0), brief)[0]?.outcome).toBe("pass");
    expect(outcomes(subject(".tile", 12), brief)[0]?.details).toEqual([
      "hovering .tile moved .row 12px",
    ]);
  });
  test("no hover probe reaching the subject is unmeasured", () => {
    expect(outcomes(subject(".row", 12), brief)[0]).toMatchObject({
      outcome: "unmeasured",
      reason: "no hover probe reached .tile",
    });
  });
});

describe("minContrast", () => {
  const brief = check([{ selector: ".pin", minContrast: 3 }]);
  const pin = (styles: Partial<ObservedElementV2["styles"]>, tag = "svg") =>
    tuple({
      elements: [
        {
          selector: ".tile",
          rect: {},
          styles: { backgroundColor: "rgb(255, 255, 255)" },
        },
        { selector: ".tile .pin", tag, ancestors: [".tile"], rect: {}, styles },
      ],
      marks: [{ selector: ".pin", matches: [".tile .pin"] }],
    });
  test("an icon's painted stroke, else fill, against its background", () => {
    expect(outcomes(pin({ fill: "rgb(0, 0, 0)" }), brief)[0]?.outcome).toBe(
      "pass",
    );
    expect(
      outcomes(pin({ fill: "rgb(204, 204, 204)" }), brief)[0]?.details,
    ).toEqual([".pin contrast 1.61:1, expected at least 3:1"]);
    expect(
      outcomes(
        pin({ stroke: "rgb(204, 204, 204)", fill: "rgb(0, 0, 0)" }),
        brief,
      )[0]?.outcome,
    ).toBe("mismatch");
  });
  test("an unpainted foreground is unmeasured", () => {
    expect(
      outcomes(
        pin({
          fill: "rgba(0, 0, 0, 0)",
          stroke: "none",
          color: "rgba(0, 0, 0, 0)",
        }),
        brief,
      )[0]?.outcome,
    ).toBe("unmeasured");
  });
});

describe("unmeasured and eligibility", () => {
  const brief = check([{ selector: ".item", height: 56 }]);
  test("a capture without the brief's mark asks for a recapture", () => {
    expect(outcomes(tuple({ elements: [] }), brief)[0]?.reason).toBe(
      "the capture predates the brief and did not measure .item; recapture",
    );
  });
  test("an invalid selector is unmeasured", () => {
    const subject = tuple({
      elements: [],
      marks: [{ selector: ".item", invalid: true }],
    });
    expect(outcomes(subject, brief)[0]?.reason).toBe("invalid selector .item");
  });
  test("a mark whose match has no element entry is unmeasured, never a pass", () => {
    const subject = tuple({
      elements: [],
      marks: [{ selector: ".item", matches: ["#shadow .item"] }],
    });
    expect(outcomes(subject, brief)[0]?.outcome).toBe("unmeasured");
  });
  test("combination states match their declared state", () => {
    const subject = tuple({
      state: "editor.dense",
      elements: [{ selector: ".item:nth-of-type(1)", rect: { height: 90 } }],
      marks: [{ selector: ".item", matches: [".item:nth-of-type(1)"] }],
    });
    expect(outcomes(subject, brief)[0]?.outcome).toBe("mismatch");
    expect(outcomes({ ...subject, state: "editorial" }, brief)).toEqual([]);
  });
  test("ineligible briefs produce nothing", () => {
    expect(
      outcomes(tuple({ elements: [] }), {
        ...brief,
        eligible: { reason: "decided not to build" },
      }),
    ).toEqual([]);
  });
});

describe("the check", () => {
  const brief = check(
    [
      { selector: ".item", height: 56 },
      { selector: ".item .pin", within: ".tile" },
    ],
    "tile height unchanged at 56px; pin inside the tile",
  );
  const subject = tuple({
    elements: [
      { selector: ".item:nth-of-type(1)", rect: { height: 100 } },
      {
        selector: ".item:nth-of-type(1) .tile",
        ancestors: [".item:nth-of-type(1)"],
        rect: { height: 56 },
      },
      {
        selector: ".item:nth-of-type(1) .pin",
        ancestors: [".item:nth-of-type(1)"],
        rect: { y: 56, height: 44 },
      },
    ],
    marks: [
      { selector: ".item", matches: [".item:nth-of-type(1)"] },
      { selector: ".item .pin", matches: [".item:nth-of-type(1) .pin"] },
      { selector: ".tile", matches: [".item:nth-of-type(1) .tile"] },
    ],
  });
  test("names the brief, the criterion and the measured values", () => {
    const result = run(subject, [brief]);
    expect(result.coverage.status).toBe("ran");
    expect(
      result.candidates.map(
        ({ rule, selectorHint, explanation, severity }) => ({
          rule,
          selectorHint,
          explanation,
          severity,
        }),
      ),
    ).toEqual([
      {
        rule: "idiom:brief-mismatch:pinned-group:c0:a0:size",
        selectorHint: ".item:nth-of-type(1)",
        explanation:
          'Brief "Pinned group" (pinned-group), criterion "tile height unchanged at 56px; pin inside the tile": .item height 100, expected 56 (tolerance 1)',
        severity: "major",
      },
      {
        rule: "idiom:brief-mismatch:pinned-group:c0:a1:within",
        selectorHint: ".item:nth-of-type(1) .pin",
        explanation:
          'Brief "Pinned group" (pinned-group), criterion "tile height unchanged at 56px; pin inside the tile": .item .pin extends 44px below .tile',
        severity: "major",
      },
    ]);
    expect(result.candidates[0]?.acceptance).toEqual([
      "tile height unchanged at 56px; pin inside the tile (brief pinned-group)",
    ]);
    expect(result.candidates[0]?.verification).toMatchObject({
      check: "brief-mismatch",
      params: { brief: "pinned-group", criterion: 0, assertion: 0 },
    });
  });
  test("not applicable without a targeting brief; unavailable without v2 observations", () => {
    expect(run(subject, []).coverage.status).toBe("not-applicable");
    expect(
      run({ ...subject, observations: undefined }, [brief]).coverage.status,
    ).toBe("unavailable");
  });
});

describe("decided briefs as checks", () => {
  const stored = (
    overrides: Partial<StoredBrief> = {},
  ): CompleteStoredBrief => {
    const brief = storedBriefSchema.parse({
      version: 1,
      slug: "pinned-group",
      title: "Pinned group",
      request: "Add a pinned group",
      decision: "Where does the pin go?",
      requestNamedIdea: false,
      research: [{ question: "q", findings: "nothing found" }],
      options: [
        {
          id: "corner-icon",
          title: "Corner pin icon",
          summary: "A small icon",
          kind: "alternative",
          cost: { space: "none", steps: "1", concepts: "0", code: "small" },
        },
        {
          id: "dont-build",
          title: "Leave it",
          summary: "No pins",
          kind: "dont-build",
          cost: { space: "none", steps: "0", concepts: "0", code: "none" },
          rejectedBecause: "users asked",
        },
      ],
      recommendation: { option: "corner-icon", reason: "research" },
      acceptanceCriteria: [
        {
          kind: "geometry",
          statement: "tile height stays 56px",
          assertions: [
            { flow: "studio", state: "editor", selector: ".tile", height: 56 },
            {
              flow: "studio",
              state: "editor",
              selector: ".pin",
              within: ".tile",
            },
          ],
        },
        { kind: "behaviour", statement: "pinning keeps order" },
      ],
      status: "decided",
      decidedBy: "requester",
      rubricVersion: 1,
      createdAt: "2026-10-31T00:00:00.000Z",
      updatedAt: "2026-10-31T00:00:00.000Z",
      ...overrides,
    });
    if (!isCompleteBrief(brief)) throw new Error("fixture brief is incomplete");
    return brief;
  };
  test("selectors capture marks for a state", () => {
    const checks = [briefCheckFrom(stored())];
    expect(briefSelectorsFor(checks, "studio", "editor")).toEqual([
      ".pin",
      ".tile",
    ]);
    expect(briefSelectorsFor(checks, "studio", "editor.dense")).toEqual([
      ".pin",
      ".tile",
    ]);
    expect(briefSelectorsFor(checks, "studio", "other")).toEqual([]);
    expect(briefSelectorsFor(checks, "elsewhere", "editor")).toEqual([]);
  });
  test("dont-build and a non-recommended choice are ineligible", () => {
    expect(briefCheckFrom(stored()).eligible).toBe(true);
    expect(
      briefCheckFrom(stored({ chosenOption: "dont-build" })).eligible,
    ).toEqual({ reason: "decided not to build; nothing to check" });
    const other = briefCheckFrom(
      stored({
        options: [
          ...stored().options,
          {
            id: "sibling",
            title: "Sibling button",
            summary: "A full button",
            kind: "alternative",
            cost: { space: "a row", steps: "1", concepts: "0", code: "small" },
            rejectedBecause: "doubles the height",
          },
        ],
        chosenOption: "sibling",
      }),
    );
    expect(other.eligible).toMatchObject({
      reason: expect.stringContaining("re-record"),
    });
    expect(briefSelectorsFor([other], "studio", "editor")).toEqual([]);
  });
});
