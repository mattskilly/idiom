import { describe, expect, test } from "vitest";
import { frameCheck, judgeFrame } from "../src/checks/frame.js";
import {
  FLIP_CROSSING,
  flipDirection,
  luminanceParityCheck,
} from "../src/checks/luminance-parity.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ElementSignals,
  FrameEdgeSample,
  ObservedElementV2,
  PaintSignals,
  RGB,
  SelectorMark,
} from "../src/checks/types.js";
import { checkMarks, checksConfigSchema } from "../src/schemas/project.js";

const config = (checks: unknown = {}) =>
  checksConfigFrom(checksConfigSchema.parse(checks));

const grey = (value: number): RGB => ({ r: value, g: value, b: value });
const WHITE = grey(255);
const NEAR_WHITE = grey(245);
const DARK = grey(34);
const DARKER = grey(51);

type Spec = {
  id: string;
  path: string;
  light: RGB | "unavailable" | "transparent";
  dark: RGB | "unavailable" | "transparent";
  interactive?: boolean;
  tag?: string;
  rect?: { x: number; y: number; width: number; height: number };
  ancestors?: string[];
};

function element(
  spec: Spec,
  scheme: "light" | "dark",
  paint: Partial<PaintSignals> = {},
): ObservedElementV2 {
  const value = spec[scheme];
  const rect = spec.rect ?? { x: 0, y: 0, width: 100, height: 40 };
  const parentColor = scheme === "light" ? NEAR_WHITE : DARK;
  const background: PaintSignals["background"] =
    value === "unavailable"
      ? { status: "unavailable", reason: "background image on x" }
      : {
          status: "measured",
          color: value === "transparent" ? parentColor : value,
          sources: [spec.id],
        };
  const signals: ElementSignals = {
    role: spec.interactive ? "textbox" : "",
    name: "",
    described: false,
    appearance: "auto",
    cursor: "auto",
    hasGraphic: false,
    lineCount: 0,
    contentBox: rect,
    transition: "all 0s",
    animation: "none 0s",
    focused: false,
    repeatedItem: false,
    paint: {
      background,
      surface: value !== "transparent",
      primaryAction: false,
      ...paint,
    },
  };
  return {
    selector: spec.id,
    tag: spec.tag ?? (spec.interactive ? "input" : "div"),
    text: "",
    visible: true,
    interactive: spec.interactive ?? false,
    enabled: true,
    rect,
    scrollWidth: rect.width,
    scrollHeight: rect.height,
    clientWidth: rect.width,
    clientHeight: rect.height,
    outOfFlow: false,
    ancestorSelectors: spec.ancestors ?? [],
    hitTestWith: [],
    structuralPath: spec.path,
    directText: "",
    attributes: {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]",
    relativeRect: rect,
    styles: {} as ObservedElementV2["styles"],
    signals,
  };
}

function tuple(
  elements: ObservedElementV2[],
  options: {
    scheme?: "light" | "dark" | undefined;
    state?: string;
    width?: number;
    marks?: SelectorMark[];
    failed?: boolean;
  } = {},
): CheckTuple {
  const width = options.width ?? 1440;
  return {
    flow: "studio",
    state: options.state ?? "editor",
    viewport: width === 1440 ? "desktop" : "mobile",
    ...(options.scheme === undefined
      ? {}
      : { colorScheme: options.scheme, colorSchemeAxis: true }),
    width,
    height: 900,
    metadataPath: `${options.state ?? "editor"}/${options.scheme}/metadata.json`,
    artifactPaths: [`${options.state ?? "editor"}/${options.scheme}/o.json`],
    commit: "abc",
    createdAt: "2026-10-23T00:00:00.000Z",
    observations: {
      version: 2,
      viewport: { width, height: 900 },
      document: {
        scrollWidth: width,
        scrollHeight: 900,
        clientWidth: width,
        clientHeight: 900,
      },
      elements,
      headings: [],
      tokens: { status: "not-configured" },
      maskMembership: [],
      ...(options.marks === undefined ? {} : { selectorMarks: options.marks }),
    },
    console: [],
    mismatches: [],
    ...(options.failed ? { failure: { stage: "capture", message: "x" } } : {}),
  };
}

const chrome: Spec = {
  id: "#chrome",
  path: "html[0]/body[0]/form[0]",
  light: NEAR_WHITE,
  dark: DARK,
  rect: { x: 0, y: 0, width: 600, height: 100 },
};
const title: Spec = {
  id: "#title",
  path: "html[0]/body[0]/form[0]/input[0]",
  light: WHITE,
  dark: WHITE,
  interactive: true,
  rect: { x: 10, y: 10, width: 100, height: 40 },
};
const peer = (index: number, dark: RGB = DARKER): Spec => ({
  id: `#peer${index}`,
  path: `html[0]/body[0]/form[0]/div[${index}]/input[0]`,
  light: WHITE,
  dark,
  interactive: true,
  rect: { x: 120 + index * 110, y: 10, width: 100, height: 40 },
});
const wrapper = (index: number): Spec => ({
  id: `#wrap${index}`,
  path: `html[0]/body[0]/form[0]/div[${index}]`,
  light: "transparent",
  dark: "transparent",
});

function pair(specs: Spec[], options: Parameters<typeof tuple>[1] = {}) {
  return [
    tuple(
      specs.map((spec) => element(spec, "light")),
      { ...options, scheme: "light" },
    ),
    tuple(
      specs.map((spec) => element(spec, "dark")),
      { ...options, scheme: "dark" },
    ),
  ] as const;
}

function run(tuples: readonly CheckTuple[], checks: unknown = {}) {
  return tuples.map((owner) =>
    luminanceParityCheck.run({
      tuple: owner,
      tuples,
      narrowViewport: false,
      config: config(checks),
    }),
  );
}

const parityRules = (results: ReturnType<typeof run>) =>
  results.flatMap((result) =>
    result.candidates.filter(
      (candidate) => candidate.rule === "idiom:background-scheme-parity",
    ),
  );

describe("scheme flip thresholds", () => {
  test("a flip crosses 0.5 and moves at least 0.25 in either direction", () => {
    expect(flipDirection(0.9, 0.02)).toBe(-1);
    expect(flipDirection(0.02, 0.9)).toBe(1);
    expect(flipDirection(0.55, 0.45)).toBe(0);
    expect(flipDirection(0.9, 0.6)).toBe(0);
    expect(flipDirection(0.74, 0.49)).toBe(-1);
    expect(FLIP_CROSSING).toBe(0.5);
  });
});

describe("background scheme parity", () => {
  const editor = [chrome, title, wrapper(0), peer(0), wrapper(1), peer(1)];

  test("reports the white title input once, on the dark tuple, with both schemes as evidence", () => {
    const tuples = pair(editor);
    const results = run(tuples);
    const found = parityRules(results);
    expect(found).toHaveLength(1);
    expect(results[0]?.candidates).toEqual([]);
    const [candidate] = found;
    expect(candidate?.selectorHint).toBe("#title");
    expect(candidate?.fingerprintHint).toBe(
      "scheme-parity:html[0]/body[0]/form[0]/input[0]",
    );
    expect(candidate?.evidenceTuples).toEqual([tuples[0], tuples[1]]);
    expect(candidate?.verification.params).toMatchObject({
      schemes: ["light", "dark"],
      target: { light: 1, dark: 1 },
      container: { path: chrome.path },
      thresholds: { crossing: 0.5, movement: 0.25, peerWindow: 0.1 },
    });
    expect(results[1]?.coverage.status).toBe("ran");
  });

  test("tuple order does not change candidates or ownership", () => {
    const tuples = pair(editor);
    const forward = parityRules(run(tuples));
    const reversed = parityRules(run([tuples[1], tuples[0]]));
    expect(reversed).toEqual(forward);
  });

  test("matches by structural path when selectors change between schemes", () => {
    const [light, dark] = pair(editor);
    if (dark.observations?.version !== 2) throw new Error("v2");
    for (const item of dark.observations.elements)
      item.selector = `${item.selector}-dark`;
    expect(parityRules(run([light, dark])).map((c) => c.selectorHint)).toEqual([
      "#title-dark",
    ]);
  });

  test("a partially themed field that stays on the light side is still stuck", () => {
    const partial = { ...title, dark: grey(200) };
    expect(
      parityRules(run(pair([chrome, partial, wrapper(0), peer(0)]))),
    ).toHaveLength(1);
  });

  test("one flipping neighbour is enough when it is the only one", () => {
    expect(
      parityRules(run(pair([chrome, title, wrapper(0), peer(0)]))),
    ).toHaveLength(1);
  });

  test("no comparable neighbour: no finding, and a note says why", () => {
    const results = run(pair([chrome, title]));
    expect(parityRules(results)).toEqual([]);
    expect(results[1]?.coverage.reason).toContain("comparable neighbours");
  });

  test("a deliberate accent whose neighbours also stay put is not reported", () => {
    const stuckPeers = [peer(0, WHITE), peer(1, WHITE)];
    expect(
      parityRules(
        run(pair([chrome, title, wrapper(0), wrapper(1), ...stuckPeers])),
      ),
    ).toEqual([]);
  });

  test("neighbours split evenly are not a majority", () => {
    expect(
      parityRules(
        run(
          pair([
            chrome,
            title,
            wrapper(0),
            peer(0),
            wrapper(1),
            peer(1, WHITE),
          ]),
        ),
      ),
    ).toEqual([]);
  });

  test("an unchanged container (a light canvas region) is not a scheme change", () => {
    const canvas = { ...chrome, dark: NEAR_WHITE };
    expect(
      parityRules(run(pair([canvas, title, wrapper(0), peer(0)]))),
    ).toEqual([]);
  });

  test("noninteractive peers do not vote for a control", () => {
    const card = { ...peer(0), interactive: false, tag: "div" };
    expect(parityRules(run(pair([chrome, title, wrapper(0), card])))).toEqual(
      [],
    );
  });

  test("unmeasured target or container paint is never treated as black or white", () => {
    expect(
      parityRules(
        run(
          pair([
            chrome,
            { ...title, dark: "unavailable" },
            wrapper(0),
            peer(0),
          ]),
        ),
      ),
    ).toEqual([]);
    const results = run(
      pair([{ ...chrome, dark: "unavailable" }, title, wrapper(0), peer(0)]),
    );
    expect(parityRules(results)).toEqual([]);
    expect(results[1]?.coverage.reason).toContain(
      "unmeasured background paint",
    );
  });

  test("the symmetric dark-to-light change is handled with the same rules", () => {
    const flipped = (spec: Spec): Spec => ({
      ...spec,
      light: spec.dark,
      dark: spec.light,
    });
    const darkTitle = { ...title, light: DARK, dark: DARK };
    const results = run(
      pair([
        flipped(chrome),
        darkTitle,
        wrapper(0),
        { ...peer(0), light: DARKER, dark: WHITE },
      ]),
    );
    expect(parityRules(results)).toHaveLength(1);
    expect(results[1]?.candidates[0]?.selectorHint).toBe("#title");
  });

  test("ignore marks exempt intentional fixed-colour content and its descendants", () => {
    const marks: SelectorMark[] = [
      { purpose: "luminance-ignore", selector: ".fixed", matches: ["#title"] },
    ];
    expect(
      parityRules(
        run(pair(editor, { marks }), {
          luminanceParity: { ignore: [".fixed"] },
        }),
      ),
    ).toEqual([]);
    const results = run(pair(editor), {
      luminanceParity: { ignore: [".fixed"] },
    });
    expect(parityRules(results)).toHaveLength(1);
    expect(results[1]?.coverage.reason).toContain(
      "was not resolved at capture",
    );
  });

  test("pairs only the same flow, state and viewport, and refuses ambiguity or failure", () => {
    const [light] = pair(editor);
    const [, otherState] = pair(editor, { state: "other" });
    const [, otherWidth] = pair(editor, { width: 390 });
    expect(parityRules(run([light, otherState, otherWidth]))).toEqual([]);
    expect(run([light, otherState])[0]?.coverage).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("no dark capture"),
    });
    const [a, b] = pair(editor);
    const [, duplicate] = pair(editor);
    expect(run([a, b, duplicate])[0]?.coverage.reason).toContain(
      "2 dark captures",
    );
    const [failedLight, failedDark] = pair(editor, { failed: true });
    expect(parityRules(run([failedLight, failedDark]))).toEqual([]);
  });

  test("a single-scheme capture says parity was unavailable", () => {
    const only = tuple(editor.map((spec) => element(spec, "light")));
    const [result] = run([only]);
    expect(result?.coverage).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("scheme parity unavailable"),
    });
  });

  test("observations without paint signals report recapture", () => {
    const legacy = tuple([
      {
        ...element(title, "light"),
        signals: {
          ...(element(title, "light").signals as ElementSignals),
          paint: undefined,
        },
      },
    ]);
    expect(run([legacy])[0]?.coverage.reason).toContain(
      "predate paint signals",
    );
  });
});

describe("primary-action contrast", () => {
  const button: Spec = {
    id: "#publish",
    path: "html[0]/body[0]/form[0]/button[0]",
    light: DARK,
    dark: grey(119),
    interactive: true,
    tag: "button",
  };
  const withText = (foreground: RGB, background: RGB) =>
    element(button, "dark", {
      primaryAction: true,
      text: {
        status: "measured",
        samples: [
          { foreground: WHITE, background: DARK, sources: ["#publish"] },
          { foreground, background, sources: ["#publish span"] },
        ],
      },
    });

  test("a low-contrast span is not hidden by a passing one", () => {
    const [result] = run([
      tuple([withText(grey(170), grey(119))], { scheme: "dark" }),
    ]);
    const [candidate] = result?.candidates ?? [];
    expect(candidate?.rule).toBe("idiom:primary-action-contrast");
    expect(candidate?.explanation).toContain("dark scheme");
    expect(candidate?.explanation).toContain("#aaaaaa on #777777");
    expect(candidate?.verification.params).toMatchObject({
      required: 4.5,
      scheme: "dark",
    });
    // Single-scheme: findings retained while parity is disclosed as unavailable.
    expect(result?.coverage.status).toBe("ran");
    expect(result?.coverage.reason).toContain("scheme parity unavailable");
  });

  test("exactly 4.5:1 passes; just below does not, even if it rounds to 4.5", () => {
    // #767676 on white is 4.54:1; #777777 on white is 4.48:1.
    const pass = run([tuple([withText(grey(118), WHITE)])])[0];
    const fail = run([tuple([withText(grey(119), WHITE)])])[0];
    expect(pass?.candidates).toEqual([]);
    expect(fail?.candidates).toHaveLength(1);
    expect(fail?.candidates[0]?.explanation).toContain("4.47:1");
  });

  test("unmeasured label paint is disclosed, not passed", () => {
    const unmeasured = element(button, "dark", {
      primaryAction: true,
      text: { status: "unavailable", reason: "background image on #publish" },
    });
    const [result] = run([tuple([unmeasured])]);
    expect(result?.candidates).toEqual([]);
    expect(result?.coverage.reason).toContain("label paint unmeasured");
  });

  test("configured primary selectors missing from the capture are named", () => {
    const [result] = run([tuple([withText(WHITE, DARK)])], {
      luminanceParity: { primarySelectors: [".cta"] },
    });
    expect(result?.coverage.reason).toContain(
      "primary selector .cta was not resolved",
    );
  });
});

const point = { x: 0, y: 0 };
function edge(
  side: FrameEdgeSample["side"],
  inside: RGB,
  surround: RGB,
  extra: Partial<Extract<FrameEdgeSample, { status: "measured" }>> = {},
): FrameEdgeSample {
  return {
    side,
    insidePoint: point,
    outsidePoint: point,
    status: "measured",
    inside: { color: inside, sources: ["#page-frame"] },
    surround: { color: surround, sources: ["#canvas"] },
    border: { width: 0, style: "none", color: grey(0), alpha: 1 },
    shadows: { status: "measured", layers: [] },
    ...extra,
  };
}
const shadow = (
  overrides: Partial<{
    alpha: number;
    extent: number;
    inset: boolean;
    clipped: boolean;
    color: RGB;
  }> = {},
) => ({
  color: grey(0),
  alpha: 0.3,
  extent: 4,
  inset: false,
  clipped: false,
  ...overrides,
});
const sides = ["top", "right", "bottom", "left"] as const;
const all = (make: (side: FrameEdgeSample["side"]) => FrameEdgeSample) =>
  sides.map(make);

describe("frame separation verdicts", () => {
  test("white on white with no border or shadow is invisible", () => {
    expect(
      judgeFrame(
        all((side) => edge(side, WHITE, WHITE)),
        0.05,
      ).status,
    ).toBe("invisible");
  });

  test("a fill step at the configured delta passes; just under fails", () => {
    expect(
      judgeFrame(
        all((side) => edge(side, grey(221), WHITE)),
        0.05,
      ).status,
    ).toBe("visible");
    expect(
      judgeFrame(
        all((side) => edge(side, grey(250), WHITE)),
        0.05,
      ).status,
    ).toBe("invisible");
  });

  test("a visible border on one edge is enough; transparent or same-colour borders are not", () => {
    const border = (color: RGB, alpha: number) => ({
      width: 1,
      style: "solid",
      color,
      alpha,
    });
    const one = sides.map((side) =>
      edge(
        side,
        WHITE,
        WHITE,
        side === "left" ? { border: border(grey(200), 1) } : {},
      ),
    );
    expect(judgeFrame(one, 0.05)).toMatchObject({
      status: "visible",
      cue: "border",
    });
    expect(
      judgeFrame(
        all((side) => edge(side, WHITE, WHITE, { border: border(grey(0), 0) })),
        0.05,
      ).status,
    ).toBe("invisible");
    expect(
      judgeFrame(
        all((side) => edge(side, WHITE, WHITE, { border: border(WHITE, 1) })),
        0.05,
      ).status,
    ).toBe("invisible");
    expect(
      judgeFrame(
        all((side) =>
          edge(side, WHITE, WHITE, {
            border: { ...border(grey(0), 1), style: "hidden" },
          }),
        ),
        0.05,
      ).status,
    ).toBe("invisible");
  });

  test("a directional shadow is enough; zero-extent, transparent, same-colour or clipped shadows are not", () => {
    const withShadow = (layer: ReturnType<typeof shadow>, onlyBottom = false) =>
      sides.map((side) =>
        edge(side, WHITE, WHITE, {
          shadows: {
            status: "measured",
            layers: onlyBottom && side !== "bottom" ? [] : [layer],
          },
        }),
      );
    expect(judgeFrame(withShadow(shadow(), true), 0.05)).toMatchObject({
      status: "visible",
      cue: "shadow",
    });
    expect(judgeFrame(withShadow(shadow({ inset: true })), 0.05).status).toBe(
      "visible",
    );
    for (const layer of [
      shadow({ extent: 0 }),
      shadow({ alpha: 0 }),
      shadow({ color: WHITE }),
      shadow({ clipped: true }),
    ])
      expect(judgeFrame(withShadow(layer), 0.05).status).toBe("invisible");
  });

  test("legacy multi-shadow evidence requires recapture instead of accepting a hidden declaration", () => {
    const legacy = edge("top", WHITE, WHITE, {
      shadows: {
        status: "measured",
        layers: [
          shadow({ color: WHITE, alpha: 1, extent: 8 }),
          shadow({ color: grey(0), alpha: 1, extent: 4 }),
        ],
      },
    });
    expect(judgeFrame([legacy], 0.05)).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("recapture"),
    });
  });

  test("unknown or occluded edges block an invisibility claim; offscreen edges do not", () => {
    const occluded: FrameEdgeSample = {
      side: "top",
      insidePoint: point,
      outsidePoint: point,
      status: "unavailable",
      reason: "another layer paints over the frame edge",
      occluder: "#overlay",
    };
    const verdict = judgeFrame([occluded, edge("left", WHITE, WHITE)], 0.05);
    expect(verdict).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("#overlay"),
    });
    const offscreen: FrameEdgeSample = {
      side: "bottom",
      insidePoint: point,
      outsidePoint: point,
      status: "offscreen",
    };
    expect(
      judgeFrame([offscreen, edge("left", WHITE, WHITE)], 0.05).status,
    ).toBe("invisible");
    expect(judgeFrame([offscreen], 0.05).status).toBe("unknown");
    const unparsed = edge("top", WHITE, WHITE, {
      shadows: { status: "unavailable", reason: "unparsed box-shadow" },
    });
    expect(judgeFrame([unparsed], 0.05).status).toBe("unknown");
  });
});

describe("frame check coverage", () => {
  const frame = (
    edges: FrameEdgeSample[] | undefined,
    id = "#page-frame",
  ): ObservedElementV2 => {
    const base = element(
      { id, path: "html[0]/body[0]/main[0]", light: WHITE, dark: WHITE },
      "light",
    );
    return {
      ...base,
      signals: { ...(base.signals as ElementSignals), frameEdges: edges },
    };
  };
  const mark = (
    matches: string[],
    extra: Partial<SelectorMark> = {},
  ): SelectorMark[] => [
    { purpose: "frame", selector: "#page-frame", matches, ...extra },
  ];
  const runFrame = (
    owner: CheckTuple,
    checks: unknown = { frame: { selector: "#page-frame" } },
  ) =>
    frameCheck.run({
      tuple: owner,
      narrowViewport: false,
      config: config(checks),
    });

  test("no selector is skipped, not a frame for every page", () => {
    expect(runFrame(tuple([frame(undefined)]), {}).coverage.status).toBe(
      "skipped",
    );
  });

  test("missing marks, invalid selectors, no match and missing edges are unavailable", () => {
    expect(runFrame(tuple([frame(undefined)])).coverage.reason).toContain(
      "recapture",
    );
    expect(
      runFrame(
        tuple([frame(undefined)], { marks: mark([], { invalid: true }) }),
      ).coverage.reason,
    ).toContain("not a valid CSS selector");
    expect(
      runFrame(tuple([frame(undefined)], { marks: mark([]) })).coverage.reason,
    ).toContain("matches no rendered element");
    expect(
      runFrame(tuple([frame(undefined)], { marks: mark(["#page-frame"]) }))
        .coverage,
    ).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("not sampled"),
    });
  });

  test("an invisible frame is one major finding with measured evidence; each match is judged", () => {
    const invisible = all((side) => edge(side, WHITE, WHITE));
    const result = runFrame(
      tuple(
        [
          frame(invisible),
          frame(
            all((side) => edge(side, grey(200), WHITE)),
            "#other",
          ),
        ],
        {
          marks: mark(["#page-frame", "#other"]),
        },
      ),
    );
    expect(result.coverage.status).toBe("ran");
    expect(result.candidates).toHaveLength(1);
    const [candidate] = result.candidates;
    expect(candidate).toMatchObject({
      rule: "idiom:frame-separation",
      severity: "major",
      selectorHint: "#page-frame",
    });
    expect(candidate?.explanation).toContain("surround painted by #canvas");
    expect(candidate?.verification.params).toMatchObject({
      minLuminanceDelta: 0.05,
    });
  });

  test("the configured delta is honoured", () => {
    const edges = all((side) => edge(side, grey(221), WHITE));
    const owner = tuple([frame(edges)], { marks: mark(["#page-frame"]) });
    expect(runFrame(owner).candidates).toEqual([]);
    expect(
      runFrame(owner, {
        frame: { selector: "#page-frame", minLuminanceDelta: 0.5 },
      }).candidates,
    ).toHaveLength(1);
  });
});

describe("configuration and artifact contracts", () => {
  test("defaults, bounds and selector marks", () => {
    const defaults = checksConfigSchema.parse({});
    expect(defaults.luminanceParity).toEqual({
      primarySelectors: [],
      ignore: [],
    });
    expect(defaults.frame).toEqual({ minLuminanceDelta: 0.05 });
    expect(() =>
      checksConfigSchema.parse({ frame: { minLuminanceDelta: 1.5 } }),
    ).toThrow();
    expect(() =>
      checksConfigSchema.parse({ frame: { selector: "  " } }),
    ).toThrow();
    expect(() =>
      checksConfigSchema.parse({ luminanceParity: { extra: true } }),
    ).toThrow();
    expect(
      checkMarks(
        checksConfigSchema.parse({
          luminanceParity: { primarySelectors: [".cta"], ignore: [".art"] },
          frame: { selector: "#page-frame" },
        }),
      ).slice(0, 3),
    ).toEqual([
      { purpose: "primary-action", selector: ".cta" },
      { purpose: "luminance-ignore", selector: ".art" },
      { purpose: "frame", selector: "#page-frame" },
    ]);
    expect(checkMarks(defaults).some((mark) => mark.purpose === "frame")).toBe(
      false,
    );
  });
});
