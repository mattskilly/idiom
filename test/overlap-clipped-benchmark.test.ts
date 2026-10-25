import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import type { ObservationArtifactV2 } from "../src/checks/types.js";
import { fixture, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
const load = (name: string) =>
  readFile(join(import.meta.dirname, "fixtures/overlap-clipped", name), "utf8");
const ids = new Set(["element-overlap", "clipped-text", "field-group"]);
const viewport = (width: number) => ({
  width,
  height: width === 390 ? 844 : 768,
});

test("1024px Layers chrome reports zoom collisions, including the partly visible More button", async () => {
  const found = await reviewFixture(browser, await load("before.html"), {
    viewport: viewport(1024),
  });
  const overlaps = found
    .filter(({ candidate }) => candidate.category === "element-overlap")
    .map(({ candidate }) => candidate);
  expect(
    overlaps.some(
      (c) =>
        c.explanation.includes("#zoom-fit") &&
        c.explanation.includes("#theme-dark"),
    ),
  ).toBe(true);
  const more = overlaps.find(
    (c) =>
      c.explanation.includes("#zoom-fit") && c.explanation.includes("#more"),
  );
  expect(more?.explanation).toMatch(/\d+(?:\.\d+)?×\d+(?:\.\d+)?px at 1024px/);
  expect(more?.explanation).toContain(
    "#more and #zoom-fit are only partly visible",
  );
  expect(more?.verification.params).toMatchObject({
    selectors: ["#more", "#zoom-fit"],
    viewportWidth: 1024,
  });
});

test.each([1024, 390])(
  "%ipx: the centred three-line Undo request is sliced by its menu item",
  async (width) => {
    let observations: ObservationArtifactV2 | undefined;
    const found = await reviewFixture(browser, await load("before.html"), {
      viewport: viewport(width),
      onObservations: (value) => {
        expect(observationArtifactSchema.parse(value)).toEqual(value);
        if (value.version === 2) observations = value;
      },
    });
    const clip = observations?.clippedText?.find(
      (entry) => entry.selector === "#undo-label",
    );
    expect(clip).toMatchObject({
      owner: "#menu-undo",
      axis: "y",
      lines: 3,
      cut: "sliced-line",
    });
    expect(clip?.visibleLines).toBeLessThan(clip?.lines ?? 0);
    const finding = found.find(
      ({ candidate }) =>
        candidate.category === "clipped-text" &&
        candidate.selectorHint === "#undo-label",
    )?.candidate;
    expect(finding?.explanation).toContain("#menu-undo");
    expect(finding?.explanation).toContain("no ellipsis is shown");
  },
);

test("mobile override groups measure touching inputs/chips and touching groups; config can silence them", async () => {
  const html = await load("before.html");
  const options = { viewport: viewport(390) };
  const found = await reviewFixture(browser, html, options);
  const groups = found
    .filter(({ candidate }) => candidate.category === "field-group")
    .map(({ candidate }) => candidate);
  const chip = groups.find(
    (c) =>
      c.rule === "idiom:field-group-inner-gap" && c.selectorHint === "#lh-chip",
  );
  expect(chip?.explanation).toContain(
    '"Inherited" helper (#lh-chip) sits 0px below its input #lh',
  );
  expect(chip?.verification.params).toMatchObject({ gap: 0, minimum: 4 });
  expect(
    groups.filter((c) => c.rule === "idiom:field-group-between-gap"),
  ).toHaveLength(2);
  expect(
    groups.find((c) => c.rule === "idiom:field-group-between-gap")?.verification
      .params,
  ).toMatchObject({ gap: 0, minimum: 12 });
  const disabled = await reviewFixture(browser, html, {
    ...options,
    checks: { fieldGroups: { inner: 0, between: 0 } },
  });
  expect(
    disabled.filter(({ candidate }) => candidate.category === "field-group"),
  ).toEqual([]);
});

test.each([1440, 1024, 390])(
  "fixed fixture has no overlap, clipping or field-group findings at %ipx",
  async (width) => {
    const found = await reviewFixture(browser, await load("after.html"), {
      viewport: viewport(width),
    });
    expect(
      found.filter(
        ({ candidate }) =>
          ids.has(candidate.category) ||
          ["overflow-clip", "responsive-break"].includes(candidate.category),
      ),
    ).toEqual([]);
  },
);

const page = (body: string, css = "") =>
  `<!doctype html><style>body { margin: 20px; font: 16px/24px Arial; } * { box-sizing: border-box; } ${css}</style>${body}`;
test.each([
  [
    "floating label",
    page(
      '<div><input id="field"><label for="field">Name</label></div>',
      "div { position:relative; } input { width:200px; height:48px; } label { position:absolute; top:0; left:8px; background:white; }",
    ),
  ],
  [
    "menu over page text",
    page(
      '<p>Page text behind the menu</p><div role="menu"><button>Open</button></div>',
      "[role=menu] { position:absolute; top:20px; left:20px; }",
    ),
  ],
  [
    "peeking carousel card",
    page(
      '<div class="viewport"><div class="track"><article><h2>First card</h2><p>Description</p></article><article><h2>A peeking second card</h2><p>Description</p></article></div></div>',
      ".viewport { width:240px; overflow:hidden; } .track { display:flex; width:440px; } article { flex:none; width:220px; } h2 { white-space:nowrap; }",
    ),
  ],
  [
    "checkbox label",
    page('<label><input type="checkbox"> Remember me</label>'),
  ],
  [
    "ellipsis",
    page(
      '<div id="clip" title="A long label with all of its words">A long label with all of its words</div>',
      "#clip { width:100px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }",
    ),
  ],
  [
    "line clamp",
    page(
      '<div id="clip">A long label with many words that wraps over several lines inside this small box</div>',
      "#clip { width:100px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }",
    ),
  ],
  [
    "scrollable text",
    page(
      '<div id="scroll">A long label with all of its words</div>',
      "#scroll { width:100px; overflow:auto; white-space:nowrap; }",
    ),
  ],
  [
    "tight leading",
    page(
      '<div id="clip">Tight line<br>Next line</div>',
      "#clip { font:40px/36px Arial; overflow:hidden; }",
    ),
  ],
  [
    "decoration copies",
    page(
      '<div class="stack"><span>Headline</span><span>Headline</span></div>',
      ".stack { display:grid; } span { grid-area:1/1; }",
    ),
  ],
  [
    "absolute content escapes static clipping ancestor",
    page(
      '<div style="position:relative"><div style="width:100px;overflow:hidden"><span style="position:absolute;white-space:nowrap">An uncut absolutely positioned label</span></div></div>',
    ),
  ],
])("intentional %s stays quiet", async (_name, html) => {
  const found = await reviewFixture(browser, html);
  expect(found.filter(({ candidate }) => ids.has(candidate.category))).toEqual(
    [],
  );
});

test.each([
  [
    "horizontal mid-word",
    page(
      '<span id="clip">Supercalifragilistic label</span>',
      "#clip { display:block; width:72px; white-space:nowrap; overflow:hidden; }",
    ),
    "x",
    "mid-word",
  ],
  [
    "wrapped hidden lines",
    page(
      '<span id="clip">A longer label that wraps onto several lines without any ellipsis marker</span>',
      "#clip { display:block; width:110px; height:24px; overflow:hidden; }",
    ),
    "y",
    "hidden-lines",
  ],
])("reports %s", async (_name, html, axis, cut) => {
  const found = await reviewFixture(browser, html);
  expect(
    found.find(({ candidate }) => candidate.category === "clipped-text")
      ?.candidate.verification.params,
  ).toMatchObject({ selector: "#clip", owner: "#clip", axis, cut });
});

test("text leaves and controls collide; below-fold geometry still reports", async () => {
  const html = page(
    '<div class="row"><strong id="text">Zoom options</strong><button id="control">Fit</button></div><div class="row" style="margin-top:1000px"><button id="a">First</button><button id="b">Second</button></div>',
    ".row { position:relative; height:40px; } button { width:100px; height:32px; } #control { position:absolute; left:50px; top:0; } #b { position:absolute; left:30px; top:0; }",
  );
  const found = await reviewFixture(browser, html);
  const overlaps = found
    .filter(({ candidate }) => candidate.category === "element-overlap")
    .map(({ candidate }) => candidate);
  expect(
    overlaps.some(
      (c) =>
        c.explanation.includes("#text") && c.explanation.includes("#control"),
    ),
  ).toBe(true);
  expect(
    overlaps.find((c) => c.explanation.includes("#a overlaps #b"))?.explanation,
  ).toContain("below the fold, geometry only");
});

test("wrapping labels, arbitrary [for] labels and described helpers form groups", async () => {
  const html = page(
    '<section><label id="wrapped">Name<input id="name" aria-describedby="hint"><span id="hint">Required</span></label><div class="field"><span for="email" id="email-label">Email</span><input id="email"></div></section>',
    "section, label, .field { display:flex; flex-direction:column; align-items:flex-start; gap:0; } input { height:32px; width:200px; }",
  );
  let observations: ObservationArtifactV2 | undefined;
  await reviewFixture(browser, html, {
    onObservations: (value) => {
      if (value.version === 2) observations = value;
    },
  });
  expect(observations?.fieldGroups).toHaveLength(2);
  expect(
    observations?.fieldGroups?.[0]?.members.map((member) => member.selector),
  ).toEqual(["#wrapped", "#name", "#hint"]);
  expect(observations?.fieldGroups?.[0]?.members[0]?.rect.height).toBeLessThan(
    32,
  );
  expect(
    observations?.fieldGroups?.[1]?.members.map((member) => member.selector),
  ).toEqual(["#email-label", "#email"]);
});

test.each([
  "mirrored-after.html",
  "motion-after.html",
  "fresh-state-after.html",
  "layout-invariants-after.html",
  "copy-after.html",
])("existing %s remains clear of the new checks", async (name) => {
  const found = await reviewFixture(browser, await fixture(name));
  expect(found.filter(({ candidate }) => ids.has(candidate.category))).toEqual(
    [],
  );
});

test("large absolute interactive controls still collide", async () => {
  const found = await reviewFixture(
    browser,
    page(
      '<button id="large-a">First</button><button id="large-b">Second</button>',
      "button { position:absolute; top:20px; width:160px; height:160px; } #large-a { left:20px; } #large-b { left:80px; }",
    ),
  );
  expect(
    found.find(({ candidate }) => candidate.category === "element-overlap")
      ?.candidate.verification.params,
  ).toMatchObject({ selectors: ["#large-a", "#large-b"] });
});

test("separate absolute illustration panels do not collide with the layer beneath them", async () => {
  const found = await reviewFixture(
    browser,
    page(
      "<p>Content behind the illustrated panel</p><article><span>Illustration caption</span></article>",
      "article { position:absolute; left:20px; top:20px; width:200px; height:160px; }",
    ),
  );
  expect(found.filter(({ candidate }) => ids.has(candidate.category))).toEqual(
    [],
  );
});

test("viewport edges mark partly visible collision members", async () => {
  const found = await reviewFixture(
    browser,
    page(
      '<button id="off-left">First</button><button id="on-screen">Second</button>',
      "button { position:absolute; top:20px; width:100px; height:32px; } #off-left { left:-20px; } #on-screen { left:20px; }",
    ),
  );
  expect(
    found.find(({ candidate }) => candidate.category === "element-overlap")
      ?.candidate.explanation,
  ).toContain("#off-left is only partly visible");
});
