import { type Browser, chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { judgeFrame } from "../src/checks/frame.js";
import { observePage } from "../src/checks/observe.js";
import type {
  FrameEdgeSample,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import { fixture, reviewFixture, reviewStates } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
const checks = { frame: { selector: "#page-frame" } };
const ours = new Set(["luminance-parity", "frame"]);

test("reports the unthemed title, washed-out primary action and invisible frame (#9, #32)", async () => {
  const found = await reviewFixture(
    browser,
    await fixture("luminance-before.html"),
    { colorSchemes: ["light", "dark"], checks },
  );
  const rules = found
    .filter(({ candidate }) => ours.has(candidate.category))
    .map(({ candidate }) => `${candidate.rule} ${candidate.selectorHint}`);
  expect(rules).toContain("idiom:background-scheme-parity #title");
  expect(rules).toContain("idiom:primary-action-contrast #publish");
  expect(
    rules.filter((rule) => rule.startsWith("idiom:frame-separation")),
  ).toEqual([
    "idiom:frame-separation #page-frame",
    "idiom:frame-separation #page-frame",
  ]);
  // Only the dark tuple owns the stuck input; light has nothing to report.
  expect(
    rules.filter((rule) => rule.startsWith("idiom:background-scheme-parity")),
  ).toHaveLength(1);
});

test.each([1440, 390])(
  "fixed fixture has measured frame coverage and no new findings at %i",
  async (width) => {
    const { findings, tuples } = await reviewStates(
      browser,
      [{ state: "editor", html: await fixture("luminance-after.html") }],
      {
        colorSchemes: ["light", "dark"],
        checks,
        viewport: { width, height: 900 },
      },
    );
    expect(
      findings.filter(({ candidate }) => ours.has(candidate.category)),
    ).toEqual([]);
    expect(tuples).toHaveLength(2);
    for (const tuple of tuples) {
      const edges = frameOf(tuple.observations as ObservationArtifactV2);
      expect(edges.every((edge) => edge.status === "measured")).toBe(true);
      expect(
        edges.map(
          (edge) => edge.status === "measured" && edge.surround.sources,
        ),
      ).toContainEqual(["#canvas"]);
    }
  },
);

function frameOf(
  observation: ObservationArtifactV2,
  selector = "#page-frame",
): FrameEdgeSample[] {
  const edges = observation.elements.find(
    (element) => element.selector === selector,
  )?.signals?.frameEdges;
  if (edges === undefined) throw new Error(`no frame edges on ${selector}`);
  return edges;
}

async function observe(
  html: string,
  options: {
    scheme?: "light" | "dark";
    frame?: string;
    primary?: string[];
    before?: (page: Page) => Promise<void>;
    after?: (page: Page, observation: ObservationArtifactV2) => Promise<void>;
  } = {},
): Promise<ObservationArtifactV2> {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    colorScheme: options.scheme ?? "light",
  });
  const page = await context.newPage();
  try {
    await page.setContent(html);
    await options.before?.(page);
    const observation = await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      {
        marks: [
          ...(options.frame === undefined
            ? []
            : [{ purpose: "frame" as const, selector: options.frame }]),
          ...(options.primary ?? []).map((selector) => ({
            purpose: "primary-action" as const,
            selector,
          })),
        ],
      },
    );
    if (observation.version !== 2) throw new Error("v2");
    await options.after?.(page, observation);
    return observation;
  } finally {
    await context.close();
  }
}

const byId = (observation: ObservationArtifactV2, selector: string) =>
  observation.elements.find(
    (element) => element.selector === selector,
  ) as ObservedElementV2;

test("background paint composites nested rgba and opacity groups over the real backdrop", async () => {
  const observation = await observe(`<body style="margin:0;background:#000">
    <div id="half" style="background:rgba(255,255,255,0.5);padding:10px">
      <div id="inner" style="background:rgba(255,0,0,0.5);height:20px"></div>
    </div>
    <div id="faded" style="opacity:0.5;background:#000;padding:10px"><div id="white" style="background:#fff;height:20px"></div></div>
    <div id="image" style="background:#fff linear-gradient(red, blue);height:20px"></div>
    <div id="covered" style="background:linear-gradient(red, blue)"><div id="solid" style="background:#123456;height:20px"></div></div>
  </body>`);
  const paint = (selector: string) =>
    byId(observation, selector).signals?.paint;
  expect(paint("#half")?.background).toMatchObject({
    status: "measured",
    color: { r: 127.5, g: 127.5, b: 127.5 },
  });
  expect(paint("#inner")?.background).toMatchObject({
    color: { r: 191.25, g: 63.75, b: 63.75 },
  });
  expect(paint("#white")?.background).toMatchObject({
    color: { r: 127.5, g: 127.5, b: 127.5 },
  });
  expect(paint("#image")?.background).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("background image"),
  });
  // An opaque layer makes the complex background beneath it irrelevant.
  expect(paint("#solid")?.background).toMatchObject({
    status: "measured",
    color: { r: 18, g: 52, b: 86 },
  });
  expect(paint("#half")?.surface).toBe(true);
});

test("primary actions: real submit semantics, child label colours, generated and input labels", async () => {
  const observation = await observe(
    `<style>button,input,a{background:#fff;color:#000;border:0} .two::after{content:" now";color:#ccc}</style>
    <form><button id="implicit">Save</button><input id="submit" type="submit" value="Send"><button id="plain" type="button">Cancel</button>
      <button id="spans"><span style="color:#000">Pub</span><span style="color:#bbb">lish</span></button>
      <button id="gen" class="two">Go</button>
      <button id="off" disabled>Off</button>
      <button id="icon" aria-label="Add"><svg width="10" height="10"></svg></button>
      <button id="srlabel"><span style="position:absolute;width:1px;height:1px;overflow:hidden;color:#eee">hidden</span>Ok</button>
    </form>
    <button id="orphan">No form</button><a id="cta" href="#" class="cta">Start</a><button id="variant" data-variant="primary">Go</button>`,
    { primary: [".cta"] },
  );
  const primary = (selector: string) =>
    byId(observation, selector).signals?.paint;
  expect(primary("#implicit")?.primaryAction).toBe(true);
  expect(primary("#submit")?.text).toMatchObject({
    status: "measured",
    samples: [{ foreground: { r: 0, g: 0, b: 0 } }],
  });
  expect(primary("#plain")?.primaryAction).toBe(false);
  expect(primary("#orphan")?.primaryAction).toBe(false);
  expect(primary("#cta")?.primaryAction).toBe(true);
  expect(primary("#variant")?.primaryAction).toBe(true);
  expect(primary("#off")?.primaryAction).toBe(false);
  expect(primary("#icon")?.text).toEqual({ status: "none" });
  const spans = primary("#spans")?.text;
  expect(
    spans?.status === "measured" && spans.samples.map((s) => s.foreground.r),
  ).toEqual([0, 187]);
  const generated = primary("#gen")?.text;
  expect(
    generated?.status === "measured" &&
      generated.samples.map((s) => s.foreground.r),
  ).toEqual([0, 204]);
  const clipped = primary("#srlabel")?.text;
  expect(
    clipped?.status === "measured" &&
      clipped.samples.map((s) => s.foreground.r),
  ).toEqual([0]);
});

const workspace = (frameStyle: string, extra = "") => `<!doctype html><style>
  body{margin:0;background:#111}
  #workspace{position:relative;height:500px}
  #canvas{position:absolute;inset:0;background:white;pointer-events:none}
  #page-frame{position:absolute;left:40px;top:40px;width:240px;height:300px;background:white;${frameStyle}}
  ${extra}
</style><div id="workspace"><div id="canvas"></div><main id="page-frame"></main></div>`;

const frameVerdict = async (html: string) =>
  (
    await reviewFixture(browser, html, {
      checks,
      viewport: { width: 800, height: 600 },
    })
  ).filter(({ candidate }) => candidate.rule === "idiom:frame-separation");

test("a white frame over a pointer-inert white canvas is measured against the canvas, not BODY", async () => {
  const html = workspace("");
  const observation = await observe(html, {
    frame: "#page-frame",
    after: async (page) => {
      // Ordinary hit testing skips the canvas and lands on the dark parent.
      expect(
        await page.evaluate(
          () =>
            document.elementFromPoint(100, 39)?.id ||
            document.elementFromPoint(100, 39)?.tagName,
        ),
      ).toBe("workspace");
    },
  });
  const edges = frameOf(observation);
  expect(edges).toHaveLength(12);
  for (const edge of edges) {
    expect(edge).toMatchObject({
      status: "measured",
      inside: { color: { r: 255, g: 255, b: 255 } },
      surround: { color: { r: 255, g: 255, b: 255 }, sources: ["#canvas"] },
    });
  }
  expect(await frameVerdict(html)).toHaveLength(1);
});

test.each([
  ["a fill change", "background:#ddd"],
  ["a visible border", "border:1px solid #bbb"],
  ["a directional shadow", "box-shadow:0 4px 0 rgba(0,0,0,0.3)"],
  ["an inset shadow", "box-shadow:inset 0 0 0 2px rgba(0,0,0,0.3)"],
])("%s separates the frame", async (_name, style) => {
  expect(await frameVerdict(workspace(style))).toEqual([]);
});

test.each([
  ["a transparent border", "border:2px solid transparent"],
  ["a same-colour border", "border:2px solid #fff"],
  ["a transparent shadow", "box-shadow:0 4px 8px rgba(0,0,0,0)"],
  ["a zero-extent shadow", "box-shadow:0 0 0 0 #000"],
])("%s does not separate the frame", async (_name, style) => {
  expect(await frameVerdict(workspace(style))).toHaveLength(1);
});

test("an outer shadow clipped by its container does not separate the frame", async () => {
  const html = `<style>body{margin:0;background:#fff}#clip{position:absolute;left:40px;top:40px;width:240px;height:300px;overflow:hidden}
    #page-frame{width:240px;height:300px;background:#fff;box-shadow:0 0 0 4px #000}</style><div id="clip"><main id="page-frame"></main></div>`;
  expect(await frameVerdict(html)).toHaveLength(1);
});

test.each([
  ["stylesheet", "", ""],
  ["inherited", "", "#workspace{pointer-events:none}"],
  ["inline !important", "pointer-events: none !important;", ""],
])(
  "%s pointer-events:none on the canvas still yields the canvas surround",
  async (_name, inline, extra) => {
    const html = workspace("", extra).replace(
      '<div id="canvas">',
      `<div id="canvas" style="${inline}">`,
    );
    const edges = frameOf(await observe(html, { frame: "#page-frame" }));
    expect(
      edges.every(
        (edge) =>
          edge.status === "measured" && edge.surround.sources[0] === "#canvas",
      ),
    ).toBe(true);
  },
);

test("a pointer-inert overlay painted above the frame is occlusion, never a good boundary", async () => {
  const html = workspace(
    "",
    "#overlay{position:absolute;inset:0;background:#000;pointer-events:none;z-index:2}",
  ).replace("</main>", '</main><div id="overlay"></div>');
  const edges = frameOf(await observe(html, { frame: "#page-frame" }));
  expect(
    edges.every(
      (edge) => edge.status === "unavailable" && edge.occluder === "#overlay",
    ),
  ).toBe(true);
  expect(await frameVerdict(html)).toEqual([]);
  const coverage = await reviewStates(browser, [{ state: "s", html }], {
    checks,
  });
  expect(
    coverage.findings.filter(({ candidate }) => candidate.category === "frame"),
  ).toEqual([]);
});

test("a transparent pointer-inert overlay over the canvas keeps the white surround", async () => {
  const html = workspace(
    "",
    "#veil{position:absolute;inset:0;background:transparent;pointer-events:none;z-index:2}",
  ).replace("</main>", '</main><div id="veil"></div>');
  const edges = frameOf(await observe(html, { frame: "#page-frame" }));
  expect(
    edges.every(
      (edge) => edge.status === "measured" && edge.surround.color.r === 255,
    ),
  ).toBe(true);
  expect(await frameVerdict(html)).toHaveLength(1);
});

test("edges past the viewport are offscreen; each matched frame is sampled", async () => {
  const html = `<style>body{margin:0;background:#fff}.f{position:absolute;left:40px;width:200px;height:100px;background:#fff}</style>
    <main class="f" id="a" style="top:40px"></main><main class="f" id="b" style="top:560px"></main>`;
  const observation = await observe(html, { frame: ".f" });
  expect(
    frameOf(observation, "#a").every((edge) => edge.status === "measured"),
  ).toBe(true);
  const low = frameOf(observation, "#b");
  expect(
    low
      .filter((edge) => edge.side === "bottom")
      .every((edge) => edge.status === "offscreen"),
  ).toBe(true);
  expect(
    low
      .filter((edge) => edge.side === "top")
      .every((edge) => edge.status === "measured"),
  ).toBe(true);
});

const restorationFixture = workspace("")
  .replace(
    '<div id="canvas">',
    '<div id="canvas" style="color: red;  pointer-events: none !important ;">',
  )
  .replace(
    '<div id="workspace">',
    '<div id="workspace"><span id="empty" style="" class="x">a</span><b id="absent" style="pointer-events:none">b</b>',
  );

async function pageState(page: Page) {
  return page.evaluate(() =>
    ["canvas", "empty", "absent", "page-frame", "workspace"].map((id) => {
      const element = document.getElementById(id) as HTMLElement;
      return {
        id,
        has: element.hasAttribute("style"),
        style: element.getAttribute("style"),
        pointer: getComputedStyle(element).pointerEvents,
        background: getComputedStyle(element).backgroundColor,
        rect: JSON.stringify(element.getBoundingClientRect()),
        hit: document.elementFromPoint(100, 39)?.id,
        html: document.body.innerHTML.length,
      };
    }),
  );
}

test("frame sampling restores every inline style exactly and leaves other signals untouched", async () => {
  let before: unknown;
  let first: ObservationArtifactV2 | undefined;
  const second = await observe(restorationFixture, {
    frame: "#page-frame",
    before: async (page) => {
      before = await pageState(page);
      first = (await observePage(
        page,
        { status: "not-configured" },
        undefined,
        [],
        {
          marks: [{ purpose: "frame", selector: "#page-frame" }],
        },
      )) as ObservationArtifactV2;
      expect(await pageState(page)).toEqual(before);
    },
    after: async (page) => {
      expect(await pageState(page)).toEqual(before);
    },
  });
  const canvas = byId(second, "#canvas");
  expect(canvas.attributes.style).toBe(
    "color: red;  pointer-events: none !important ;",
  );
  expect(second).toEqual(first);
});

test("a hit-test failure restores styles first, then reports unavailable edges", async () => {
  let before: unknown;
  const observation = await observe(restorationFixture, {
    frame: "#page-frame",
    before: async (page) => {
      before = await pageState(page);
      await page.evaluate(() => {
        document.elementsFromPoint = () => {
          throw new Error("injected");
        };
      });
    },
    after: async (page) => {
      expect(await pageState(page)).toEqual(before);
    },
  });
  expect(
    frameOf(observation).every(
      (edge) =>
        edge.status === "unavailable" && edge.reason.includes("injected"),
    ),
  ).toBe(true);
});

test("captured paint and frame evidence round-trip the strict schema; legacy signals still load", async () => {
  const observation = await observe(await fixture("luminance-before.html"), {
    scheme: "dark",
    frame: "#page-frame",
  });
  const parsed = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(observation)),
  );
  expect(parsed).toEqual(observation);
  const legacy = {
    ...observation,
    selectorMarks: undefined,
    elements: observation.elements.map(({ signals, ...element }) =>
      signals === undefined
        ? element
        : {
            ...element,
            signals: { ...signals, paint: undefined, frameEdges: undefined },
          },
    ),
  };
  expect(() =>
    observationArtifactSchema.parse(JSON.parse(JSON.stringify(legacy))),
  ).not.toThrow();
  const broken = JSON.parse(JSON.stringify(observation));
  const element = broken.elements.find(
    (entry: { signals?: { paint?: unknown } }) => entry.signals?.paint,
  );
  element.signals.paint.background = {
    status: "measured",
    color: { r: 300, g: 0, b: 0 },
    sources: [],
  };
  expect(() => observationArtifactSchema.parse(broken)).toThrow();
});

test("primary labels sample a solid sibling backdrop, including pointer-inert paint", async () => {
  for (const pointer of ["auto", "none"]) {
    const html = `<style>body{margin:0;background:black}#canvas{position:absolute;inset:0;background:white;pointer-events:${pointer}}
      #publish{position:absolute;left:40px;top:40px;background:transparent;color:white;border:0}</style>
      <div id="canvas"></div><button id="publish" data-primary="true">Publish</button>`;
    const observation = await observe(html);
    const text = byId(observation, "#publish").signals?.paint?.text;
    expect(text).toMatchObject({
      status: "measured",
      samples: [
        {
          foreground: { r: 255, g: 255, b: 255 },
          background: { r: 255, g: 255, b: 255 },
          sources: expect.arrayContaining(["#canvas"]),
        },
      ],
    });
    const findings = await reviewFixture(browser, html);
    expect(
      findings.filter(
        ({ candidate }) => candidate.rule === "idiom:primary-action-contrast",
      ),
    ).toHaveLength(1);
  }
});

test.each([0.5, 0.25])(
  "frame fills preserve the shared opacity group at %s",
  async (opacity) => {
    const html = `<style>body{margin:0;background:black}#group{position:relative;width:500px;height:500px;background:white;opacity:${opacity}}
    #page-frame{position:absolute;inset:40px;background:white}</style><div id="group"><main id="page-frame"></main></div>`;
    const observation = await observe(html, { frame: "#page-frame" });
    const edges = frameOf(observation);
    for (const edge of edges) {
      expect(edge).toMatchObject({
        status: "measured",
        inside: {
          color: { r: 255 * opacity, g: 255 * opacity, b: 255 * opacity },
        },
        surround: {
          color: { r: 255 * opacity, g: 255 * opacity, b: 255 * opacity },
        },
      });
    }
    expect(judgeFrame(edges, 0.05).status).toBe("invisible");
    expect(await frameVerdict(html)).toHaveLength(1);
  },
);

test.each([
  "border:2px solid black",
  "box-shadow:0 4px 0 2px black",
  "box-shadow:inset 0 0 0 2px black",
])("faint decoration cannot separate a frame: %s", async (decoration) => {
  for (const onAncestor of [false, true]) {
    const html = `<style>body{margin:0;background:white}#group{position:relative;width:500px;height:500px;${onAncestor ? "opacity:.01" : ""}}
      #page-frame{position:absolute;inset:40px;background:white;${onAncestor ? "" : "opacity:.01;"}${decoration}}</style>
      <div id="group"><main id="page-frame"></main></div>`;
    const observation = await observe(html, { frame: "#page-frame" });
    expect(judgeFrame(frameOf(observation), 0.05).status).toBe("invisible");
    expect(
      observationArtifactSchema.parse(JSON.parse(JSON.stringify(observation))),
    ).toEqual(observation);
    expect(await frameVerdict(html)).toHaveLength(1);
  }
});

test("generated frame decoration makes unsupported boundaries unavailable", async () => {
  const html = workspace(
    "",
    '#page-frame::before{content:"";position:absolute;inset:0;border:2px solid black;pointer-events:none}',
  );
  const observation = await observe(html, { frame: "#page-frame" });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("pseudo-element"),
  });
  expect(await frameVerdict(html)).toEqual([]);
});

test("primary-label sampling restores pointer-inert layers after success and failure without a frame", async () => {
  for (const fail of [false, true]) {
    let original = "";
    const observation = await observe(
      `<style>body{background:black}#canvas{position:absolute;inset:0;background:white;pointer-events:none}</style>
      <div id="canvas" style="color:red;  pointer-events: none !important"></div>
      <button id="publish" data-primary="true" style="position:absolute;left:40px;top:40px;background:transparent;color:white;border:0">Publish</button>`,
      {
        before: async (page) => {
          original = await page.locator("body").innerHTML();
          if (fail)
            await page.evaluate(() => {
              document.elementsFromPoint = () => {
                throw new Error("label failure");
              };
            });
        },
        after: async (page) => {
          expect(await page.locator("body").innerHTML()).toBe(original);
        },
      },
    );
    const text = byId(observation, "#publish").signals?.paint?.text;
    expect(text?.status).toBe(fail ? "unavailable" : "measured");
    if (fail)
      expect(text).toMatchObject({
        reason: expect.stringContaining("label failure"),
      });
  }
});

test("primary text and frame fills preserve nested opacity over a sibling canvas", async () => {
  const html = `<style>body{margin:0;background:black}#canvas{position:absolute;inset:0;background:white;pointer-events:none}
    #outer{position:relative;opacity:.5;width:500px;height:500px;background:black}
    #inner{position:absolute;inset:20px;opacity:.5;background:white}
    #page-frame{position:absolute;inset:40px;background:white}
    #publish{color:black;background:transparent;border:0}</style>
    <div id="canvas"></div><div id="outer"><div id="inner"><main id="page-frame"><button id="publish" data-primary="true">Publish</button></main></div></div>`;
  const observation = await observe(html, { frame: "#page-frame" });
  for (const edge of frameOf(observation))
    expect(edge).toMatchObject({
      status: "measured",
      inside: { color: { r: 191.25, g: 191.25, b: 191.25 } },
      surround: { color: { r: 191.25, g: 191.25, b: 191.25 } },
    });
  expect(byId(observation, "#publish").signals?.paint?.text).toMatchObject({
    status: "measured",
    samples: [
      {
        foreground: { r: 127.5, g: 127.5, b: 127.5 },
        background: { r: 191.25, g: 191.25, b: 191.25 },
      },
    ],
  });
  expect(await frameVerdict(html)).toHaveLength(1);
});

test("a bitmap canvas surround is unavailable instead of an invisible-frame finding", async () => {
  const html = `<style>body{margin:0;background:white}canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
    #page-frame{position:absolute;left:80px;top:80px;width:240px;height:240px;background:white}</style>
    <canvas id="bitmap"></canvas><main id="page-frame"></main>
    <script>const canvas=document.querySelector('canvas');canvas.getContext('2d').fillRect(0,0,canvas.width,canvas.height)</script>`;
  const observation = await observe(html, { frame: "#page-frame" });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("replaced-content paint on #bitmap"),
  });
  expect(await frameVerdict(html)).toEqual([]);
});

test.each([
  '<canvas id="bitmap"></canvas><script>const c=document.querySelector("canvas");c.getContext("2d").fillRect(0,0,c.width,c.height)</script>',
  "<img id=\"bitmap\" src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Cpath fill='black' d='M0 0h1v1H0z'/%3E%3C/svg%3E\">",
  '<svg id="bitmap"><rect width="100%" height="100%" fill="black"/></svg>',
])("replaced-content overlays occlude frames: %s", async (overlay) => {
  const html = workspace(
    "",
    "#bitmap{position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none}",
  ).replace("</main>", `</main>${overlay}`);
  const observation = await observe(html, { frame: "#page-frame" });
  expect(
    frameOf(observation).every((edge) => edge.status === "unavailable"),
  ).toBe(true);
  expect(judgeFrame(frameOf(observation), 0.05).status).toBe("unknown");
  expect(await frameVerdict(html)).toEqual([]);
});

test("primary text discloses bitmap backdrops and opaque covers hide unsupported paint", async () => {
  for (const covered of [false, true]) {
    const html = `<style>body{margin:0;background:white}canvas,#cover{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
      #cover{background:white}#publish{position:absolute;left:80px;top:80px;background:transparent;color:white;border:0}</style>
      <canvas id="bitmap"></canvas>${covered ? '<div id="cover"></div>' : ""}<button data-primary="true" id="publish">Publish</button>
      <script>const c=document.querySelector('canvas');c.getContext('2d').fillRect(0,0,c.width,c.height)</script>`;
    const observation = await observe(html);
    const text = byId(observation, "#publish").signals?.paint?.text;
    expect(text).toMatchObject(
      covered
        ? {
            status: "measured",
            samples: [{ background: { r: 255, g: 255, b: 255 } }],
          }
        : {
            status: "unavailable",
            reason: expect.stringContaining(
              "replaced-content paint on #bitmap",
            ),
          },
    );
  }
});

test.each([
  ["0 0 0 8px white, 0 0 0 4px black", "invisible"],
  ["0 0 0 4px white, 0 0 0 8px black", "visible"],
  ["0 0 0 8px rgba(255,255,255,.5), 0 0 0 4px black", "visible"],
  ["inset 0 0 0 8px white, inset 0 0 0 4px black", "invisible"],
  ["inset 0 0 0 4px white, inset 0 0 0 8px black", "visible"],
])(
  "shadow order measures exposed contributions: %s",
  async (shadows, verdict) => {
    const html = workspace(`box-shadow:${shadows}`);
    const observation = await observe(html, { frame: "#page-frame" });
    expect(judgeFrame(frameOf(observation), 0.05).status).toBe(verdict);
    expect(await frameVerdict(html)).toHaveLength(
      verdict === "invisible" ? 1 : 0,
    );
    expect(
      observationArtifactSchema.parse(JSON.parse(JSON.stringify(observation))),
    ).toEqual(observation);
  },
);

test("fieldset disability skips primary actions but preserves the first-legend exception", async () => {
  const html = `<style>button,input{background:white;color:#ccc;border:0}</style><form><fieldset disabled>
    <legend><button id="legend">Legend action</button></legend>
    <button id="publish" data-primary="true">Publish</button><input id="submit" type="submit" value="Send">
    <legend><button id="second-legend">Disabled second legend</button></legend>
    </fieldset></form>`;
  const observation = await observe(html, { primary: ["#publish", "#submit"] });
  for (const selector of ["#publish", "#submit", "#second-legend"]) {
    expect(byId(observation, selector).signals?.paint?.primaryAction).toBe(
      false,
    );
  }
  expect(byId(observation, "#legend").signals?.paint?.primaryAction).toBe(true);
  const findings = await reviewFixture(browser, html, {
    checks: { luminanceParity: { primarySelectors: ["#publish", "#submit"] } },
  });
  expect(
    findings
      .filter(
        ({ candidate }) => candidate.rule === "idiom:primary-action-contrast",
      )
      .map(({ candidate }) => candidate.selectorHint),
  ).toEqual(["#legend"]);
});

test("opaque solid covers keep bitmap paint irrelevant to frame assessment", async () => {
  const html = `<style>body{margin:0;background:white}canvas,#cover{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
    #cover{background:white}#page-frame{position:absolute;left:80px;top:80px;width:240px;height:240px;background:white}</style>
    <canvas id="bitmap"></canvas><div id="cover"></div><main id="page-frame"></main>
    <script>const c=document.querySelector('canvas');c.getContext('2d').fillRect(0,0,c.width,c.height)</script>`;
  const observation = await observe(html, { frame: "#page-frame" });
  expect(judgeFrame(frameOf(observation), 0.05).status).toBe("invisible");
  expect(await frameVerdict(html)).toHaveLength(1);
});

test("overlapping blurred shadows disclose their unsupported overlap", async () => {
  const observation = await observe(
    workspace("box-shadow:0 0 8px 8px white,0 0 8px 4px black"),
    { frame: "#page-frame" },
  );
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("overlapping blurred shadows"),
  });
});

test("Chromium pixels confirm a fully covered shadow has no visible cue", async () => {
  await observe(workspace("box-shadow:0 0 0 8px white,0 0 0 4px black"), {
    after: async (page) => {
      const image = PNG.sync.read(await page.screenshot());
      for (const x of [34, 38, 42, 50]) {
        const offset = (100 * image.width + x) * 4;
        expect([...image.data.subarray(offset, offset + 3)]).toEqual([
          255, 255, 255,
        ]);
      }
    },
  });
});

test("unsupported contributing border colours remain unavailable instead of transparent", async () => {
  const html = workspace("border:2px solid oklch(.2 0 0)");
  const observation = await observe(html, {
    frame: "#page-frame",
    after: async (page) => {
      expect(
        await page
          .locator("#page-frame")
          .evaluate((element) => getComputedStyle(element).borderTopColor),
      ).toMatch(/^oklch\(/);
      const image = PNG.sync.read(await page.screenshot());
      const offset = (100 * image.width + 40) * 4;
      expect([...image.data.subarray(offset, offset + 3)]).toEqual([
        22, 22, 22,
      ]);
    },
  });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("unsupported border colour"),
  });
  expect(await frameVerdict(html)).toEqual([]);
  expect(
    observationArtifactSchema.parse(JSON.parse(JSON.stringify(observation))),
  ).toEqual(observation);
  const rgb = await observe(workspace("border:2px solid rgb(22,22,22)"), {
    frame: "#page-frame",
  });
  expect(judgeFrame(frameOf(rgb), 0.05)).toMatchObject({
    status: "visible",
    cue: "border",
  });
});

test("a border image makes the replaced fallback border unavailable", async () => {
  const html = workspace(
    "border:2px solid black;border-image:linear-gradient(white,white) 1",
  );
  const observation = await observe(html, {
    frame: "#page-frame",
    after: async (page) => {
      const image = PNG.sync.read(await page.screenshot());
      const offset = (100 * image.width + 40) * 4;
      expect([...image.data.subarray(offset, offset + 3)]).toEqual([
        255, 255, 255,
      ]);
    },
  });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("border image"),
  });
  expect(
    observationArtifactSchema.parse(JSON.parse(JSON.stringify(observation))),
  ).toEqual(observation);
});

test.each([
  ["border:2px solid oklch(.2 0 0);background:#ddd", "fill"],
  ["border:2px solid oklch(.2 0 0);box-shadow:0 0 0 8px black", "shadow"],
  [
    "border:2px solid black;border-image:linear-gradient(white,white) 1;background:#ddd",
    "fill",
  ],
  [
    "border:2px solid black;border-image:linear-gradient(white,white) 1;box-shadow:0 0 0 8px black",
    "shadow",
  ],
])(
  "independent sound cues survive unavailable borders: %s",
  async (style, cue) => {
    const html = workspace(style);
    const observation = await observe(html, { frame: "#page-frame" });
    expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
      status: "visible",
      cue,
    });
    expect(await frameVerdict(html)).toEqual([]);
  },
);

test("submit inputs measure default labels but skip an explicitly empty value", async () => {
  const html = `<style>input{appearance:none;background:white;color:#ccc;border:0;font:32px sans-serif;padding:8px}</style>
    <form><input id="default" type="submit"><input id="explicit" type="submit" value="Submit"><input id="empty" type="submit" value=""></form>`;
  const observation = await observe(html);
  const paint = (selector: string) =>
    byId(observation, selector).signals?.paint;
  expect(paint("#default")?.primaryAction).toBe(true);
  expect(paint("#default")?.text).toMatchObject({
    status: "measured",
    samples: [
      {
        foreground: { r: 204, g: 204, b: 204 },
        background: { r: 255, g: 255, b: 255 },
      },
    ],
  });
  expect(paint("#empty")?.text).toEqual({ status: "none" });
  const findings = await reviewFixture(browser, html);
  expect(
    findings
      .filter(
        ({ candidate }) => candidate.rule === "idiom:primary-action-contrast",
      )
      .map(({ candidate }) => candidate.selectorHint)
      .sort(),
  ).toEqual(["#default", "#explicit"]);
});

test.each(["1 fill", "1 / 1 / 8px"])(
  "border-image fill or outset cannot certify adjacent paint: %s",
  async (slice) => {
    const observation = await observe(
      workspace(
        `background:black;border:2px solid black;border-image:linear-gradient(white,white) ${slice}`,
      ),
      { frame: "#page-frame" },
    );
    expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("border image fill or outset"),
    });
  },
);

test("a nonpainting border does not require parsing its colour", async () => {
  const html = workspace("border:none;border-color:oklch(.2 0 0)");
  const observation = await observe(html, { frame: "#page-frame" });
  expect(judgeFrame(frameOf(observation), 0.05).status).toBe("invisible");
  expect(await frameVerdict(html)).toHaveLength(1);
});

test("background clipping cannot invent a primary-label backdrop", async () => {
  const html = `<style>body{margin:0;background:white}#clipped{position:absolute;inset:0;width:400px;height:400px;box-sizing:border-box;padding:100px;background:black;background-clip:content-box;pointer-events:none}
    #publish{position:absolute;left:30px;top:30px;background:transparent;color:white;border:0}</style>
    <div id="clipped"></div><button id="publish" data-primary="true">Publish</button>`;
  const observation = await observe(html);
  expect(byId(observation, "#publish").signals?.paint?.text).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("background-clip"),
  });
});

test("a content-clipped frame fill cannot establish its outer boundary", async () => {
  const html = workspace(
    "background:black;padding:20px;background-clip:content-box",
  );
  const observation = await observe(html, {
    frame: "#page-frame",
    after: async (page) => {
      const image = PNG.sync.read(await page.screenshot());
      const offset = (100 * image.width + 41) * 4;
      expect([...image.data.subarray(offset, offset + 3)]).toEqual([
        255, 255, 255,
      ]);
    },
  });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("background-clip"),
  });
});

const siblingParityFixture = `<style>
  body{margin:0;background:white}form{position:relative;width:500px;height:300px;background:white}
  #canvas{position:absolute;inset:30px;background:white;pointer-events:none}
  input{position:absolute;left:50px;top:50px;width:200px;height:40px;border:0}
  #title{background:rgba(255,255,255,.7)}#peer{top:120px;background:white}
  @media(prefers-color-scheme:dark){form,#peer{background:#555}#canvas{background:black}}
  </style><form><div id="canvas"></div><input id="title" value="Title"><input id="peer" value="Peer"></form>`;

test("parity backgrounds composite a translucent field over its sibling canvas", async () => {
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "s", html: siblingParityFixture }],
    { colorSchemes: ["light", "dark"] },
  );
  expect(
    findings.filter(
      ({ candidate }) => candidate.rule === "idiom:background-scheme-parity",
    ),
  ).toEqual([]);
  const dark = tuples.find((tuple) => tuple.colorScheme === "dark");
  const title = byId(dark?.observations as ObservationArtifactV2, "#title");
  expect(title.signals?.paint?.background).toMatchObject({
    status: "measured",
    color: { r: 178.5, g: 178.5, b: 178.5 },
    sources: expect.arrayContaining(["#canvas"]),
  });
});

test.each(["inset", "outset", "groove", "ridge"])(
  "shaded %s borders remain unavailable rather than flat-colour paint",
  async (style) => {
    const html = workspace(`border:4px ${style} white`);
    const observation = await observe(html, {
      frame: "#page-frame",
      after: async (page) => {
        if (style !== "inset") return;
        const image = PNG.sync.read(await page.screenshot());
        const offset = (40 * image.width + 100) * 4;
        expect([...image.data.subarray(offset, offset + 3)]).toEqual([
          171, 171, 171,
        ]);
      },
    });
    expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("shaded border style"),
    });
    expect(await frameVerdict(html)).toEqual([]);
    expect(
      observationArtifactSchema.parse(JSON.parse(JSON.stringify(observation))),
    ).toEqual(observation);
  },
);

test("the sibling-backed parity context still reports a genuinely stuck field", async () => {
  const html = siblingParityFixture.replace(
    "#title{background:rgba(255,255,255,.7)}",
    "#title{background:white}",
  );
  const findings = await reviewFixture(browser, html, {
    colorSchemes: ["light", "dark"],
  });
  expect(
    findings
      .filter(
        ({ candidate }) => candidate.rule === "idiom:background-scheme-parity",
      )
      .map(({ candidate }) => candidate.selectorHint),
  ).toEqual(["#title"]);
});

test.each([
  ["background:#ddd", "fill"],
  ["box-shadow:0 0 0 8px black", "shadow"],
])("shaded borders retain independent %s cues", async (decoration, cue) => {
  const observation = await observe(
    workspace(`border:4px inset white;${decoration}`),
    { frame: "#page-frame" },
  );
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "visible",
    cue,
  });
});

test("background-only sampling restores styles and discards failed samples", async () => {
  for (const fail of [false, true]) {
    let original: unknown;
    const observation = await observe(restorationFixture, {
      before: async (page) => {
        original = await pageState(page);
        if (fail)
          await page.evaluate(() => {
            document.elementsFromPoint = () => {
              throw new Error("background failure");
            };
          });
      },
      after: async (page) => {
        expect(await pageState(page)).toEqual(original);
      },
    });
    const background = byId(observation, "#page-frame").signals?.paint
      ?.background;
    expect(background?.status).toBe(fail ? "unavailable" : "measured");
    if (fail)
      expect(background).toMatchObject({
        reason: expect.stringContaining("background failure"),
      });
  }
});

test("an opaque layer hides an unsupported clipped backdrop", async () => {
  const html = `<style>body{margin:0;background:white}#clipped,#cover{position:absolute;inset:0;width:400px;height:400px;pointer-events:none}
    #clipped{box-sizing:border-box;padding:100px;background:black;background-clip:content-box}#cover{background:white}
    #publish{position:absolute;left:30px;top:30px;background:transparent;color:white;border:0}</style>
    <div id="clipped"></div><div id="cover"></div><button id="publish" data-primary="true">Publish</button>`;
  const observation = await observe(html);
  expect(byId(observation, "#publish").signals?.paint?.text).toMatchObject({
    status: "measured",
    samples: [{ background: { r: 255, g: 255, b: 255 } }],
  });
});

test("an inset shadow contributes to a primary label's actual backdrop", async () => {
  const html = `<style>body{margin:0;background:black}#publish{position:absolute;left:40px;top:40px;width:200px;height:60px;background:transparent;color:white;border:0;border-radius:0;box-shadow:inset 0 0 0 100px white}</style>
    <button id="publish" data-primary="true">Publish</button>`;
  const observation = await observe(html, {
    after: async (page) => {
      const image = PNG.sync.read(await page.screenshot());
      const offset = (50 * image.width + 50) * 4;
      expect([...image.data.subarray(offset, offset + 3)]).toEqual([
        255, 255, 255,
      ]);
    },
  });
  expect(byId(observation, "#publish").signals?.paint?.text).toMatchObject({
    status: "measured",
    samples: [
      {
        foreground: { r: 255, g: 255, b: 255 },
        background: { r: 255, g: 255, b: 255 },
      },
    ],
  });
  expect(
    (await reviewFixture(browser, html)).filter(
      ({ candidate }) => candidate.rule === "idiom:primary-action-contrast",
    ),
  ).toHaveLength(1);
});

test("an inset shadow covering the frame fill cannot invent separation", async () => {
  const html = workspace(
    "background:black;height:240px;box-shadow:inset 0 0 0 150px white",
  );
  const observation = await observe(html, { frame: "#page-frame" });
  expect(
    frameOf(observation).every(
      (edge) =>
        edge.status === "measured" &&
        edge.inside.color.r === 255 &&
        edge.surround.color.r === 255,
    ),
  ).toBe(true);
  expect(judgeFrame(frameOf(observation), 0.05).status).toBe("invisible");
  expect(await frameVerdict(html)).toHaveLength(1);
  expect(
    observationArtifactSchema.parse(JSON.parse(JSON.stringify(observation))),
  ).toEqual(observation);
});

const coveredShadowFixture = (
  cover: string,
) => `<style>body{margin:0;background:white}
  #page-frame{position:absolute;left:80px;top:80px;width:240px;height:240px;background:white;box-shadow:0 4px 0 black}
  #cover{position:absolute;left:80px;top:320px;width:240px;height:10px;background:white;${cover}}</style>
  <main id="page-frame"></main><div id="cover"></div>`;

test.each(["z-index:2", "z-index:auto"])(
  "an upper sibling covering an outer shadow is unavailable: %s",
  async (cover) => {
    const observation = await observe(coveredShadowFixture(cover), {
      frame: "#page-frame",
      after: async (page) => {
        const image = PNG.sync.read(await page.screenshot());
        for (const y of [319, 320, 322, 324]) {
          const offset = (y * image.width + 120) * 4;
          expect([...image.data.subarray(offset, offset + 3)]).toEqual([
            255, 255, 255,
          ]);
        }
      },
    });
    expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("shadow"),
    });
  },
);

test("an uncovered outer shadow remains a measured cue", async () => {
  const html = coveredShadowFixture("display:none");
  const observation = await observe(html, { frame: "#page-frame" });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "visible",
    side: "bottom",
    cue: "shadow",
  });
  expect(await frameVerdict(html)).toEqual([]);
});

test("an inset shadow away from the label does not change its backdrop", async () => {
  const html = `<style>body{margin:0;background:black}#publish{position:absolute;left:40px;top:40px;width:200px;height:80px;background:transparent;color:white;border:0;border-radius:0;box-shadow:inset 0 0 0 10px white}</style><button id="publish" data-primary="true">Publish</button>`;
  const observation = await observe(html);
  expect(byId(observation, "#publish").signals?.paint?.text).toMatchObject({
    status: "measured",
    samples: [{ background: { r: 0, g: 0, b: 0 } }],
  });
  expect(
    (await reviewFixture(browser, html)).filter(
      ({ candidate }) => candidate.rule === "idiom:primary-action-contrast",
    ),
  ).toEqual([]);
});

test("ancestor inset shadows composite inside their opacity group", async () => {
  const html = `<style>body{margin:0;background:black}#group{position:relative;width:300px;height:100px;background:black;opacity:.5;box-shadow:inset 0 0 0 100px white}
    #publish{position:absolute;left:40px;top:30px;background:transparent;color:white;border:0}</style><div id="group"><button id="publish" data-primary="true">Publish</button></div>`;
  const observation = await observe(html);
  expect(byId(observation, "#publish").signals?.paint?.text).toMatchObject({
    status: "measured",
    samples: [
      {
        foreground: { r: 127.5, g: 127.5, b: 127.5 },
        background: { r: 127.5, g: 127.5, b: 127.5 },
      },
    ],
  });
});

test("an inset shadow that covers only the edge retains its interior contrast", async () => {
  const observation = await observe(
    workspace("background:black;box-shadow:inset 0 0 0 2px white"),
    { frame: "#page-frame" },
  );
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "visible",
    cue: "shadow",
  });
});

test("inset-shadow cues compare actual interior paint including children", async () => {
  const html = workspace(
    "background:black;box-shadow:inset 0 0 0 2px white",
  ).replace(
    "</main>",
    '<div style="position:absolute;inset:2px;background:white"></div></main>',
  );
  const observation = await observe(html, { frame: "#page-frame" });
  expect(judgeFrame(frameOf(observation), 0.05).status).toBe("invisible");
  expect(await frameVerdict(html)).toHaveLength(1);
});

test("blurred inset paint is unavailable in label backdrops", async () => {
  const html = `<style>body{background:black}button{width:200px;height:80px;background:transparent;color:white;border:0;border-radius:0;box-shadow:inset 0 0 10px 100px white}</style><button id="publish" data-primary="true">Publish</button>`;
  const observation = await observe(html);
  expect(byId(observation, "#publish").signals?.paint?.text).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("inset shadow"),
  });
});

test("a higher-z sibling before the frame still occludes its outer shadow", async () => {
  const html = coveredShadowFixture("z-index:2").replace(
    '<main id="page-frame"></main><div id="cover"></div>',
    '<div id="cover"></div><main id="page-frame"></main>',
  );
  const observation = await observe(html, { frame: "#page-frame" });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("above the outer shadow"),
  });
});

test("a lower-z sibling after the frame does not conceal its outer shadow", async () => {
  const html = coveredShadowFixture("z-index:-1");
  const observation = await observe(html, {
    frame: "#page-frame",
    after: async (page) => {
      const image = PNG.sync.read(await page.screenshot());
      const offset = (322 * image.width + 120) * 4;
      expect([...image.data.subarray(offset, offset + 3)]).toEqual([0, 0, 0]);
    },
  });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "visible",
    cue: "shadow",
  });
});

const clippedBorderFixture = (
  overflow: string,
) => `<style>body{margin:0;background:white}
  #clip{position:absolute;left:82px;top:82px;width:236px;height:236px;overflow:${overflow}}
  #page-frame{position:absolute;left:-2px;top:-2px;width:240px;height:240px;box-sizing:border-box;background:white;border:2px solid black}</style>
  <div id="clip"><main id="page-frame"></main></div>`;

test("a parent clipping away the border cannot leave a measured border cue", async () => {
  const observation = await observe(clippedBorderFixture("hidden"), {
    frame: "#page-frame",
    after: async (page) => {
      const image = PNG.sync.read(await page.screenshot());
      for (const x of [80, 81, 82, 83]) {
        const offset = (120 * image.width + x) * 4;
        expect([...image.data.subarray(offset, offset + 3)]).toEqual([
          255, 255, 255,
        ]);
      }
    },
  });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("border"),
  });
});

test("an exposed border remains a measured cue", async () => {
  const observation = await observe(clippedBorderFixture("visible"), {
    frame: "#page-frame",
  });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "visible",
    cue: "border",
  });
});

test("clip-path removal of the border is unavailable", async () => {
  const observation = await observe(
    workspace("border:2px solid black;clip-path:inset(2px)"),
    { frame: "#page-frame" },
  );
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("border"),
  });
});

test("pointer-inert overlays covering only border strips suppress the border cue", async () => {
  const html = `<style>body{margin:0;background:white}#page-frame{position:absolute;left:80px;top:80px;width:240px;height:240px;box-sizing:border-box;background:white;border:2px solid black}
    .cover{position:absolute;background:white;z-index:2;pointer-events:none}
    #top{left:80px;top:80px;width:240px;height:2px}#bottom{left:80px;top:318px;width:240px;height:2px}
    #left{left:80px;top:80px;width:2px;height:240px}#right{left:318px;top:80px;width:2px;height:240px}</style>
    <main id="page-frame"></main><div class="cover" id="top"></div><div class="cover" id="bottom"></div><div class="cover" id="left"></div><div class="cover" id="right"></div>`;
  const observation = await observe(html, { frame: "#page-frame" });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("border"),
  });
});

test("off-box shadow paint makes frame surrounds unavailable", async () => {
  const html = `<style>body{margin:0;background:white}#backdrop{position:absolute;left:90px;top:90px;width:220px;height:220px;background:white;box-shadow:0 0 0 20px black;pointer-events:none}
    #page-frame{position:absolute;left:80px;top:80px;width:240px;height:240px;background:white}</style><div id="backdrop"></div><main id="page-frame"></main>`;
  const observation = await observe(html, {
    frame: "#page-frame",
    after: async (page) => {
      const image = PNG.sync.read(await page.screenshot());
      const outside = (120 * image.width + 79) * 4,
        inside = (120 * image.width + 81) * 4;
      expect([...image.data.subarray(outside, outside + 3)]).toEqual([0, 0, 0]);
      expect([...image.data.subarray(inside, inside + 3)]).toEqual([
        255, 255, 255,
      ]);
    },
  });
  expect(judgeFrame(frameOf(observation), 0.05)).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("off-box shadow"),
  });
  expect(await frameVerdict(html)).toEqual([]);
});

test("distant transformed shadowed elements keep before-fixture findings", async () => {
  const knob = `<span id="knob" style="position:fixed;right:10px;bottom:10px;width:16px;height:16px;border-radius:50%;background:white;box-shadow:0 1px 2px rgba(0,0,0,.2);transform:translateX(0)"></span>`;
  const html = (await fixture("luminance-before.html")).replace(
    "</body>",
    `${knob}</body>`,
  );
  const rules = (
    await reviewFixture(browser, html, {
      colorSchemes: ["light", "dark"],
      checks,
    })
  )
    .filter(({ candidate }) => ours.has(candidate.category))
    .map(({ candidate }) => `${candidate.rule} ${candidate.selectorHint}`)
    .sort();
  expect(rules).toEqual([
    "idiom:background-scheme-parity #title",
    "idiom:frame-separation #page-frame",
    "idiom:frame-separation #page-frame",
    "idiom:primary-action-contrast #publish",
  ]);
});

test("wide translated shadowed headers keep before-fixture findings", async () => {
  // An identity-linear transform must not inflate reach by aspect ratio.
  const header = `<style>body{padding-top:56px}</style><header style="position:fixed;left:0;top:0;width:100%;height:56px;background:#ccc;box-shadow:0 1px 3px rgba(0,0,0,.1);transform:translateY(0)"></header>`;
  const html = (await fixture("luminance-before.html")).replace(
    "</body>",
    `${header}</body>`,
  );
  const rules = (
    await reviewFixture(browser, html, {
      colorSchemes: ["light", "dark"],
      checks,
    })
  )
    .filter(({ candidate }) => ours.has(candidate.category))
    .map(({ candidate }) => `${candidate.rule} ${candidate.selectorHint}`)
    .sort();
  expect(rules).toEqual([
    "idiom:background-scheme-parity #title",
    "idiom:frame-separation #page-frame",
    "idiom:frame-separation #page-frame",
    "idiom:primary-action-contrast #publish",
  ]);
});

test("transformed off-box shadows reach as far as they are scaled", async () => {
  // scale(2) doubles the 50px offset: black paints x 200..300, and the
  // button sits beyond the unscaled 250px reach but inside the scaled one.
  const html = `<style>body{margin:0;background:white}#backdrop{position:absolute;left:0;top:0;width:100px;height:100px;background:white;box-shadow:50px 0 0 black;transform-origin:0 0;transform:scale(2);pointer-events:none}
    #publish{position:absolute;left:256px;top:60px;width:36px;height:30px;padding:0;background:transparent;color:white;border:0}</style><div id="backdrop"></div><button data-primary="true" id="publish">Go</button>`;
  const observation = await observe(html, {
    after: async (page) => {
      const image = PNG.sync.read(await page.screenshot());
      const at = (90 * image.width + 290) * 4;
      expect([...image.data.subarray(at, at + 3)]).toEqual([0, 0, 0]);
    },
  });
  expect(byId(observation, "#publish").signals?.paint?.text).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("off-box shadow"),
  });
});

test("off-box shadow paint makes primary backdrops unavailable", async () => {
  const html = `<style>body{margin:0;background:white}#backdrop{position:absolute;left:0;top:0;width:200px;height:200px;background:white;box-shadow:200px 0 0 black;pointer-events:none}
    #publish{position:absolute;left:220px;top:30px;background:transparent;color:white;border:0}</style><div id="backdrop"></div><button data-primary="true" id="publish">Publish</button>`;
  const observation = await observe(html);
  expect(byId(observation, "#publish").signals?.paint?.text).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("off-box shadow"),
  });
  expect(
    (await reviewFixture(browser, html)).filter(
      ({ candidate }) => candidate.rule === "idiom:primary-action-contrast",
    ),
  ).toEqual([]);
});
