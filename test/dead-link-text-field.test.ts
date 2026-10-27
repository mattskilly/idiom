import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { deadAffordanceCheck } from "../src/checks/dead-affordance.js";
import { observePage } from "../src/checks/observe.js";
import type {
  ElementSignals,
  ExpandedObservedStyles,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
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

function signals(name: string): ElementSignals {
  return {
    role: "",
    name,
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
  };
}

type Spec = {
  selector: string;
  tag?: string;
  /** Nearest first, stopping below body, as the capture records them. */
  ancestors?: string[];
  text?: string;
  userSelect?: string;
  width?: number;
  height?: number;
  interactive?: boolean;
  attributes?: Record<string, string>;
};

function element(spec: Spec): ObservedElementV2 {
  const rect = {
    x: 0,
    y: 0,
    width: spec.width ?? 120,
    height: spec.height ?? 20,
  };
  const text = spec.text ?? "";
  return {
    selector: spec.selector,
    tag: spec.tag ?? "span",
    text,
    visible: true,
    interactive: spec.interactive ?? false,
    enabled: true,
    scrollWidth: rect.width,
    scrollHeight: rect.height,
    clientWidth: rect.width,
    clientHeight: rect.height,
    outOfFlow: false,
    ancestorSelectors: spec.ancestors ?? [],
    hitTestWith: [],
    structuralPath: `html[0]/body[0]/${spec.selector}`,
    directText: text,
    attributes: spec.attributes ?? {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]",
    relativeRect: rect,
    rect,
    styles:
      spec.userSelect === undefined
        ? styles
        : { ...styles, userSelect: spec.userSelect },
    signals: signals(text),
  };
}

/** Five filler text leaves plus the action text: six text pieces. */
function leaves(
  ancestors: string[],
  action: string,
  userSelect: string | undefined,
  prefix = "leaf",
): Spec[] {
  return [
    ...["Clipboard History", "Search Files", "Window", "Calendar", "Notes"].map(
      (text, index) => ({
        selector: `#${prefix}${index}`,
        ancestors,
        text,
        ...(userSelect === undefined ? {} : { userSelect }),
      }),
    ),
    {
      selector: `#${prefix}-action`,
      ancestors,
      text: action,
      ...(userSelect === undefined ? {} : { userSelect }),
    },
  ];
}

function dead(specs: Spec[]) {
  const observation: ObservationArtifactV2 = {
    ...emptyObservation,
    elements: specs.map(element),
  };
  return deadAffordanceCheck
    .run({
      tuple: tupleFor(observation),
      config: checksConfigSchema.parse({}),
      narrowViewport: false,
    })
    .candidates.filter((candidate) => candidate.rule === "idiom:dead-link-text")
    .map((candidate) => candidate.selectorHint);
}

const body = (userSelect?: string): Spec => ({
  selector: "body",
  tag: "body",
  width: 1440,
  height: 2000,
  ...(userSelect === undefined ? {} : { userSelect }),
});

/** The showcase shape: container (auto) > frame (none, run root) > leaves. */
function raycast(
  frame: Partial<Spec> = {},
  extra: Spec[] = [],
  leafSelect: string | undefined = "none",
): Spec[] {
  return [
    body("auto"),
    {
      selector: "#container",
      tag: "div",
      width: 1440,
      height: 900,
      userSelect: "auto",
    },
    {
      selector: "#frame",
      tag: "div",
      ancestors: ["#container"],
      width: 1204,
      height: 740,
      userSelect: "none",
      ...frame,
    },
    ...leaves(["#frame", "#container"], "Open Command", leafSelect),
    ...extra,
  ];
}

describe("illustration frames (unit)", () => {
  test("text inside a non-selectable product window is not dead link text", () => {
    expect(dead(raycast())).toEqual([]);
  });

  test("author-declared decorative ancestors exempt even small frames", () => {
    for (const attributes of [
      { "aria-hidden": "true" },
      { inert: "" },
      { role: "img" },
      { role: "presentation" },
    ])
      expect(
        dead([
          body("auto"),
          { selector: "#pic", tag: "div", width: 100, height: 30, attributes },
          { selector: "#open", ancestors: ["#pic"], text: "Open Command" },
        ]),
      ).toEqual([]);
  });

  test("a frame with a real interactive descendant still reports", () => {
    expect(
      dead(
        raycast({}, [
          {
            selector: "#real",
            tag: "a",
            ancestors: ["#frame", "#container"],
            text: "Download",
            interactive: true,
          },
        ]),
      ),
    ).toEqual(["#leaf-action"]);
  });

  test("a too-small or text-poor run root still reports", () => {
    expect(dead(raycast({ width: 150, height: 40 }))).toEqual(["#leaf-action"]);
    expect(
      dead([
        body("auto"),
        { selector: "#container", tag: "div", userSelect: "auto" },
        {
          selector: "#frame",
          tag: "div",
          ancestors: ["#container"],
          width: 1204,
          height: 740,
          userSelect: "none",
        },
        {
          selector: "#a",
          ancestors: ["#frame", "#container"],
          text: "Window",
          userSelect: "none",
        },
        {
          selector: "#open",
          ancestors: ["#frame", "#container"],
          text: "Open Command",
          userSelect: "none",
        },
      ]),
    ).toEqual(["#open"]);
  });

  test("a section without a positive signal still reports", () => {
    expect(dead(raycast({ userSelect: "auto" }, [], "auto"))).toEqual([
      "#leaf-action",
    ]);
    // Older captures record no user-select at all: behaviour unchanged.
    const older = raycast().map(({ userSelect: _, ...rest }) => rest);
    expect(dead(older)).toEqual(["#leaf-action"]);
  });

  // Direct children of body have no ancestorSelectors; their parent is body.
  const topLevel = (bodySpec: Spec | undefined): Spec[] => [
    ...(bodySpec === undefined ? [] : [bodySpec]),
    {
      selector: "#features",
      tag: "section",
      width: 1200,
      height: 600,
      userSelect: "none",
    },
    ...leaves(["#features"], "Learn more", "none"),
    {
      selector: "#nav",
      tag: "section",
      width: 1200,
      height: 80,
      userSelect: "none",
    },
    {
      selector: "#home",
      tag: "a",
      ancestors: ["#nav"],
      text: "Home",
      interactive: true,
      userSelect: "none",
    },
  ];

  test("body{user-select:none} does not make top-level sections frames", () => {
    expect(dead(topLevel(body("none")))).toEqual(["#leaf-action"]);
  });

  test("an unresolved or unrecorded parent is not a run root", () => {
    expect(dead(topLevel(undefined))).toEqual(["#leaf-action"]);
    expect(dead(topLevel(body()))).toEqual(["#leaf-action"]);
  });

  test("an inherited none region nested under body{none} still reports", () => {
    expect(
      dead([
        body("none"),
        {
          selector: "#main",
          tag: "main",
          width: 1440,
          height: 1600,
          userSelect: "none",
        },
        {
          selector: "#features",
          tag: "section",
          ancestors: ["#main"],
          width: 1200,
          height: 600,
          userSelect: "none",
        },
        ...leaves(["#features", "#main"], "Learn more", "none"),
      ]),
    ).toEqual(["#leaf-action"]);
  });

  test("the schema accepts styles with and without userSelect", () => {
    const parse = (specs: Spec[]) =>
      observationArtifactSchema.parse({
        ...emptyObservation,
        elements: specs.map(element),
      });
    expect(() => parse([{ selector: "#a", userSelect: "none" }])).not.toThrow();
    expect(() => parse([{ selector: "#a" }])).not.toThrow();
  });
});

describe("illustration frames (browser)", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  async function observe(html: string) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    try {
      await page.setContent(html);
      const observation = observationArtifactSchema.parse(
        await observePage(page, { status: "not-configured" }),
      );
      if (observation.version !== 2)
        throw new Error("expected current observation");
      const result = deadAffordanceCheck.run({
        tuple: { ...tupleFor(observation), width: 1440, height: 900 },
        config: checksConfigSchema.parse({}),
        narrowViewport: false,
      });
      const reported = result.candidates
        .filter((candidate) => candidate.rule === "idiom:dead-link-text")
        .map((candidate) => candidate.explanation);
      return { observation, reported };
    } finally {
      await page.close();
    }
  }

  const launcher = `
    <div class="window">
      <div class="search">Search for apps and commands…</div>
      <ul>
        <li>Clipboard History</li><li>Search Files</li>
        <li>Window Management</li><li>Calendar</li>
      </ul>
      <div class="bar"><span id="open">Open Command</span><span>↵</span></div>
    </div>`;
  const ownUi = `
    <h2>Features</h2>
    <p>Extensions for everything.</p>
    <span id="learn" style="cursor:pointer">Learn more</span>`;

  test("a launcher mock-up is quiet while the page's own dead text reports", async () => {
    const { observation, reported } = await observe(`<!doctype html><style>
      body { margin:0; font:16px/24px Arial; }
      .showcase { user-select:none; width:1204px; height:740px; padding:20px; box-sizing:border-box; }
      .window { border:1px solid #ccc; border-radius:12px; padding:12px; }
      .bar { display:flex; justify-content:flex-end; gap:8px; }
    </style>
    <main>
      <div class="container"><div class="showcase">${launcher}</div></div>
      <section><a href="/download">Download</a>${ownUi}</section>
    </main>`);
    expect(reported.some((text) => text.includes('"Open Command"'))).toBe(
      false,
    );
    expect(reported.some((text) => text.includes('"Learn more"'))).toBe(true);
    expect(
      observation.elements.find((e) => e.selector === "#open")?.styles
        .userSelect,
    ).toBe("none");
  });

  test("body{user-select:none} keeps a top-level section's dead text reported", async () => {
    const { observation, reported } = await observe(`<!doctype html><style>
      body { margin:0; font:16px/24px Arial; user-select:none; }
      #features { width:1200px; min-height:300px; }
    </style>
    <section id="nav"><a href="/">Home</a></section>
    <section id="features">
      <h2>Features</h2>
      <p>Clipboard history</p><p>Window management</p>
      <p>Calendar</p><p>Notes</p>
      ${ownUi}
    </section>`);
    expect(reported.some((text) => text.includes('"Learn more"'))).toBe(true);
    expect(
      observation.elements.find((e) => e.selector === "body")?.styles
        .userSelect,
    ).toBe("none");
  });
});
