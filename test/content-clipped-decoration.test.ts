import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observePage } from "../src/checks/observe.js";
import { overflowClipCheck } from "../src/checks/overflow-clip.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

let browser: Browser;
const config = checksConfigFrom(checksConfigSchema.parse({}));

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

function tuple(observations: ObservationArtifactV2): CheckTuple {
  return {
    flow: "f",
    state: "s",
    viewport: "desktop",
    width: 1440,
    height: 900,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "fixture",
    createdAt: "2026-10-26T00:00:00Z",
    console: [],
    mismatches: [],
    axe: { violations: [] },
    observations,
  };
}

/** Observe a fixture and return each box's clip classification and findings. */
async function clipping(html: string) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  try {
    await page.setContent(`<body style="margin:0">${html}</body>`);
    const observed = (await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
    )) as ObservationArtifactV2;
    expect(observed.version).toBe(2);
    const input = tuple(observed);
    const findings = overflowClipCheck
      .run({ tuple: input, tuples: [input], narrowViewport: false, config })
      .candidates.filter((c) => c.rule === "idiom:element-content-clipped");
    const at = (selector: string): ObservedElementV2 => {
      const found = observed.elements.find((e) => e.selector === selector);
      if (found === undefined) throw new Error(`No element ${selector}`);
      return found;
    };
    return {
      clipped: (selector: string) => at(selector).paintedContent?.clipped,
      finding: (selector: string) =>
        findings.find((c) => c.selectorHint === selector),
    };
  } finally {
    await page.close();
  }
}

const empty = { text: [], interactive: [], marquee: [] };
const marqueeKeyframes =
  "<style>@keyframes slide{from{transform:translateX(0)}to{transform:translateX(-50%)}}@keyframes fade{from{opacity:1}to{opacity:.9}}</style>";
const ticker =
  '<span style="white-space:nowrap;padding-right:24px">Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda</span>';
const twoLines =
  "Some paragraph text long enough to wrap onto a second line inside this box";

test("a decorative glow past the edge is not reported (AC1)", async () => {
  const r = await clipping(
    `<section id="glow" style="position:relative;overflow:hidden;width:400px;height:200px">
      <p style="margin:0">Hello there</p>
      <div style="position:absolute;right:-40px;top:0;width:120px;height:120px;background:radial-gradient(red,transparent);filter:blur(20px)"></div>
    </section>`,
  );
  expect(r.clipped("#glow")).toEqual(empty);
  expect(r.finding("#glow")).toBeUndefined();
});

test("a grid bleed under overflow-x:clip with every tile's text inside is not reported (AC1)", async () => {
  const tile =
    '<div style="flex:1;background:#eee;padding:8px 32px;height:40px">Tile</div>';
  const r = await clipping(
    `<div id="bleed" style="overflow-x:clip;width:400px">
      <div style="display:flex;gap:8px;margin:0 -24px">${tile}${tile}${tile}</div>
    </div>`,
  );
  const clipped = r.clipped("#bleed");
  if (clipped !== undefined) expect(clipped).toEqual(empty);
  expect(r.finding("#bleed")).toBeUndefined();
});

test("an image wider than its box is not reported (AC1)", async () => {
  const svg = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="teal"/></svg>',
  );
  const r = await clipping(
    `<div id="media" style="overflow:hidden;width:200px;height:100px"><img alt="" src="data:image/svg+xml,${svg}" width="400" height="100" style="display:block"></div>`,
  );
  expect(r.finding("#media")).toBeUndefined();
});

test("a CSS marquee track is recorded as a marquee, not cut-off content (AC2)", async () => {
  const r = await clipping(
    `${marqueeKeyframes}<div id="strip" style="overflow:hidden;width:400px">
      <div id="track" style="display:flex;width:max-content;animation:slide 20s linear infinite">${ticker}${ticker}</div>
    </div>`,
  );
  expect(r.clipped("#strip")).toEqual({
    text: [],
    interactive: [],
    marquee: ["#track"],
  });
  expect(r.finding("#strip")).toBeUndefined();
});

test("a JS-driven ticker (translated, repeated text) is not reported (AC2)", async () => {
  const r = await clipping(
    `<div id="strip" style="overflow:hidden;width:400px">
      <div id="track" style="display:flex;width:max-content;transform:translateX(-100px)">${ticker}${ticker}</div>
    </div>`,
  );
  expect(r.clipped("#strip")?.marquee).toEqual(["#track"]);
  expect(r.finding("#strip")).toBeUndefined();
});

test("a paragraph whose second line is cut off is still reported (AC3)", async () => {
  const r = await clipping(
    `<div id="box" style="height:30px;overflow:hidden;width:200px;line-height:20px"><p id="para" style="margin:0">${twoLines}</p></div>`,
  );
  expect(r.clipped("#box")?.text).toContain("#para");
  expect(r.finding("#box")?.explanation).toContain("cutting off text in #para");
});

test("a button partly outside its box is still reported (AC3)", async () => {
  const r = await clipping(
    `<div id="ctl" style="position:relative;overflow:hidden;width:200px;height:40px">
      <button id="go" style="position:absolute;left:150px;top:0;width:100px;height:30px">Go</button>
    </div>`,
  );
  expect(r.clipped("#ctl")?.interactive).toContain("#go");
  expect(r.finding("#ctl")?.explanation).toContain("cutting off #go");
});

test("cut-off text inside an infinite opacity animation is still reported (AC3 guard)", async () => {
  const r = await clipping(
    `${marqueeKeyframes}<div id="box" style="height:30px;overflow:hidden;width:200px;line-height:20px">
      <div style="animation:fade 2s linear infinite"><p id="para" style="margin:0">${twoLines}</p></div>
    </div>`,
  );
  expect(r.clipped("#box")?.text).toContain("#para");
  expect(r.clipped("#box")?.marquee).toEqual([]);
  expect(r.finding("#box")).toBeDefined();
});

test("cut-off text in a single translated child without repetition is still reported (AC3 guard)", async () => {
  const r = await clipping(
    `<div id="box" style="height:30px;overflow:hidden;width:200px;line-height:20px">
      <div style="transform:translateX(-20px)"><p id="para" style="margin:0">${twoLines}</p></div>
    </div>`,
  );
  expect(r.clipped("#box")?.text).toContain("#para");
  expect(r.finding("#box")).toBeDefined();
});

test.each([['aria-hidden="true"'], ["inert"]])(
  "a cut-off illustration under %s is not reported",
  async (attribute) => {
    const r = await clipping(
      `<div id="visual" style="position:relative;overflow:hidden;width:200px;height:40px">
      <div ${attribute}>
        <button style="position:absolute;left:150px;top:0;width:100px;height:30px">Send</button>
        <p style="margin:0;white-space:nowrap">A long mock-up line that runs past the edge</p>
      </div>
    </div>`,
    );
    expect(r.clipped("#visual")).toEqual(empty);
    expect(r.finding("#visual")).toBeUndefined();
  },
);

test("text a nearer scroller owns is not reported on the outer box", async () => {
  const r = await clipping(
    `<div id="outer" style="overflow:hidden;width:200px;height:100px">
      <div style="overflow:auto;width:300px;height:80px"><p style="margin:0;white-space:nowrap">A very long line of text that keeps going well past both boxes</p></div>
    </div>`,
  );
  expect(r.clipped("#outer")).toEqual(empty);
  expect(r.finding("#outer")).toBeUndefined();
});

test("a box cutting off its own text node is reported (AC3)", async () => {
  const r = await clipping(
    `<div id="own" style="height:40px;overflow:hidden;width:200px;line-height:20px">One line, then another line, then a third line of direct text in the box</div>`,
  );
  expect(r.clipped("#own")?.text).toContain("#own");
  expect(r.finding("#own")).toBeDefined();
});

test("a rounded card cut by its parent is reported on the parent (AC3)", async () => {
  const r = await clipping(
    `<section id="row" style="position:relative;overflow:hidden;width:400px;height:120px">
      <div id="card" style="position:absolute;left:320px;top:0;width:200px;height:100px;overflow:hidden;border-radius:12px;background:#eee">
        <h3 id="title" style="margin:0;white-space:nowrap">A card title here</h3>
        <button id="open" style="margin-left:60px;width:80px">Open</button>
      </div>
    </section>`,
  );
  const clipped = r.clipped("#row");
  expect(clipped?.text).toContain("#title");
  expect(clipped?.interactive).toContain("#open");
  expect(r.finding("#row")).toBeDefined();
  expect(r.finding("#card")).toBeUndefined();
});

test("text a nearer card cuts off is judged on the card, not the section", async () => {
  const r = await clipping(
    `<section id="row" style="position:relative;overflow:hidden;width:400px;height:120px">
      <div id="card" style="position:absolute;left:100px;top:0;width:200px;height:100px;overflow:hidden;border-radius:12px;background:#eee">
        <p id="line" style="margin:0;white-space:nowrap">A card line long enough to run past the card and the section edge</p>
      </div>
      <div style="position:absolute;right:-40px;top:0;width:120px;height:120px;background:radial-gradient(red,transparent)"></div>
    </section>`,
  );
  expect(r.clipped("#row")).toEqual(empty);
  expect(r.finding("#row")).toBeUndefined();
  expect(r.clipped("#card")?.text).toContain("#line");
  expect(r.finding("#card")).toBeDefined();
});

test.each([
  [
    "a bordered button",
    '<button id="owner" style="overflow:hidden;position:relative;border:3px solid">Go<span style="position:absolute;left:-20px;width:200px;height:10px;background:red"></span></button>',
  ],
  [
    "a bordered block link",
    '<a id="owner" href="#" style="display:block;overflow:hidden;position:relative;width:200px;height:60px;border:2px solid">Read more<span style="position:absolute;left:-20px;top:0;width:300px;height:10px;background:red"></span></a>',
  ],
])(
  "%s owner clipping only decoration is not reported (AC1)",
  async (_, html) => {
    const r = await clipping(html);
    expect(r.clipped("#owner")).toEqual(empty);
    expect(r.finding("#owner")).toBeUndefined();
  },
);

test("a scaled-up box with its text inside is not reported (AC1)", async () => {
  const r = await clipping(
    `<div style="padding:200px">
      <div id="scaled" style="position:relative;overflow:hidden;width:200px;height:100px;transform:scale(1.5)">
        <p id="short" style="margin:0 0 0 100px">Short text</p>
        <div style="position:absolute;right:-40px;top:0;width:120px;height:120px;background:red"></div>
      </div>
    </div>`,
  );
  expect(r.clipped("#scaled")).toEqual(empty);
  expect(r.finding("#scaled")).toBeUndefined();
});

test("a scaled-down box cutting off its text is still reported (AC3)", async () => {
  const r = await clipping(
    `<div style="padding:200px">
      <div id="scaled" style="overflow:hidden;width:200px;height:40px;transform:scale(0.5)">
        <p id="wide" style="margin:0;white-space:nowrap">A line of text that runs well past the right edge of this box</p>
      </div>
    </div>`,
  );
  expect(r.clipped("#scaled")?.text).toContain("#wide");
  expect(r.finding("#scaled")).toBeDefined();
});
