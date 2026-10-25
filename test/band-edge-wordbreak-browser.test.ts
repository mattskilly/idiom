import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import type { ObservationArtifactV2 } from "../src/checks/types.js";
import { reviewStates } from "./benchmark-support.js";

let browser: Browser;
let html: string;
beforeAll(async () => {
  browser = await chromium.launch();
  html = await readFile(
    new URL("./fixtures/band-edge-wordbreak/page.html", import.meta.url),
    "utf8",
  );
});
afterAll(async () => {
  await browser.close();
});

async function review(width: number, source = html) {
  return reviewStates(browser, [{ state: "page", html: source }], {
    viewport: { width, height: 900 },
    checks: { bandEdges: {}, wordBreak: {} },
  });
}

test("inset navigation and background content are reported against shared band gutters", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.setContent(html);
  expect(
    await page.locator("#nav").evaluate((el) => el.getBoundingClientRect().x),
  ).toBe(224);
  expect(
    await page
      .locator("#first-content")
      .evaluate((el) => el.getBoundingClientRect().x),
  ).toBe(135);
  await page.close();
  const { findings } = await review(1440);
  expect(
    findings
      .filter((f) => f.candidate.rule === "idiom:band-content-edge")
      .map((f) => f.candidate.selectorHint),
  ).toEqual(["#header", "#background"]);
});

test("heading and button words split at 768 without scroll overflow", async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
  await page.setContent(html);
  expect(
    await page
      .locator("#broken-heading")
      .evaluate((el) => el.scrollWidth === el.clientWidth),
  ).toBe(true);
  await page.close();
  const { findings } = await review(768);
  expect(
    findings
      .filter((f) => f.candidate.rule === "idiom:unhyphenated-word-break")
      .map((f) => f.candidate.selectorHint),
  ).toEqual(["#broken-heading", "#inline-heading", "#broken-button"]);
});

test("band frontier preserves gutters, nested cards, full-bleed media and below-fold content", async () => {
  const { tuples } = await review(1440);
  const observation = tuples[0]?.observations as ObservationArtifactV2;
  expect(observationArtifactSchema.parse(observation)).toEqual(observation);
  expect(observation.bandEdges?.records.map((b) => b.selector)).toEqual([
    "#header",
    "#one",
    "#two",
    "#three",
    "#media",
    "#background",
    "#footer",
  ]);
  expect(observation.bandEdges?.records[0]?.content).toEqual({
    left: 224,
    right: 1216,
    selectors: ["#nav"],
  });
  expect(
    observation.bandEdges?.records.find((b) => b.selector === "#one")?.content,
  ).toMatchObject({ left: 135, right: 1305 });
  expect(
    observation.bandEdges?.records.find((b) => b.selector === "#media")
      ?.fullBleedMedia,
  ).toBe(true);
  const narrow = await review(768);
  expect(
    narrow.findings
      .filter((f) => f.candidate.category === "band-edges")
      .map((f) => f.candidate.selectorHint),
  ).toEqual(["#background"]);
  const below = await review(
    1440,
    html.replace('id="one"', 'id="one" style="min-height:1200px"'),
  );
  const footer = (
    below.tuples[0]?.observations as ObservationArtifactV2 | undefined
  )?.bandEdges?.records.find((b) => b.selector === "#footer");
  expect(footer?.rect.y).toBeGreaterThan(900);
  expect(footer?.content?.left).toBe(135);
});

test("a start-aligned column narrower than its band keeps the band's end gutter", async () => {
  const result = await review(
    1440,
    html.replace(
      '<section id="three"><div class="content"><p>Third content band</p></div></section>',
      '<section id="three" style="width:min(1170px, calc(100% - 48px));margin:0 auto"><div style="max-width:600px"><h2>Measure-limited hero</h2></div><div style="width:760px;padding:0 20px"><p>Terminal block</p></div></section>',
    ),
  );
  expect(
    (
      result.tuples[0]?.observations as ObservationArtifactV2 | undefined
    )?.bandEdges?.records.find((b) => b.selector === "#three")?.content,
  ).toMatchObject({ left: 135, right: 1305 });
  expect(
    result.findings
      .filter((f) => f.candidate.category === "band-edges")
      .map((f) => f.candidate.selectorHint),
  ).toEqual(["#header", "#background"]);
});

test("a fixed viewport-wide header stays a band while floating fixed layers do not", async () => {
  const source = html
    .replace(
      "footer { padding: 30px 0 }",
      "footer { padding: 30px 0 } header { position: fixed; top: 0; left: 0; right: 0; background: #fff }",
    )
    .replace(
      "</main>",
      `<div id="backdrop" style="position:fixed;inset:0;opacity:.5"><p>Backdrop</p></div>
      <div id="floating" style="position:fixed;right:16px;bottom:16px"><p>Chat</p></div></main>`,
    );
  const result = await review(1440, source);
  expect(
    (
      result.tuples[0]?.observations as ObservationArtifactV2 | undefined
    )?.bandEdges?.records.map((b) => b.selector),
  ).toEqual([
    "#header",
    "#one",
    "#two",
    "#three",
    "#media",
    "#background",
    "#footer",
  ]);
  expect(
    result.findings
      .filter((f) => f.candidate.category === "band-edges")
      .map((f) => f.candidate.selectorHint),
  ).toEqual(["#header", "#background"]);
});

test("direct and wrapped media are exempt, while right-only mismatches and mixed text are measured", async () => {
  const source = html
    .replace(
      '<section class="media" id="media">',
      '<section class="media" id="media"><div><div>',
    )
    .replace(
      '</section>\n<section id="background">',
      '</div></div></section>\n<section id="background">',
    )
    .replace(
      "#background .content {",
      "#background .content { margin-left:135px;",
    );
  const result = await review(1440, source);
  const mismatch = result.findings.find(
    (f) =>
      f.candidate.selectorHint === "#background" &&
      f.candidate.category === "band-edges",
  );
  expect(mismatch?.candidate.verification.params).toMatchObject({
    deviations: { left: 0, right: -40 },
  });
  expect(
    (
      result.tuples[0]?.observations as ObservationArtifactV2 | undefined
    )?.bandEdges?.records.find((b) => b.selector === "#media")?.fullBleedMedia,
  ).toBe(true);
  const direct = await review(
    1440,
    html
      .replace('<section class="media" id="media">', "")
      .replace(
        '<img alt="Landscape"',
        '<img id="direct-media" style="width:100%;height:120px;display:block" alt="Landscape"',
      )
      .replace(
        '</section>\n<section id="background">',
        '\n<section id="background">',
      ),
  );
  expect(
    (
      direct.tuples[0]?.observations as ObservationArtifactV2 | undefined
    )?.bandEdges?.records.find((b) => b.selector === "#direct-media")
      ?.fullBleedMedia,
  ).toBe(true);
  const mixed = await review(
    1440,
    html.replace(
      '<section class="media" id="media">',
      '<section class="media" id="media"><div class="content"><p>Inset foreground text</p></div>',
    ),
  );
  expect(
    (
      mixed.tuples[0]?.observations as ObservationArtifactV2 | undefined
    )?.bandEdges?.records.find((b) => b.selector === "#media"),
  ).toMatchObject({
    fullBleedMedia: false,
    content: { left: 135, right: 1305 },
  });
});

test("word splits are measured per viewport, preserving text-node offsets across inline markup", async () => {
  for (const width of [768, 850, 1440]) {
    const result = await review(width);
    const observation = result.tuples[0]?.observations as ObservationArtifactV2;
    expect(
      observationArtifactSchema.parse(JSON.parse(JSON.stringify(observation))),
    ).toEqual(observation);
    const found = result.findings.filter(
      (f) => f.candidate.category === "word-break",
    );
    expect(found).toHaveLength(width === 1440 ? 0 : 3);
    expect(observation.wordBreaks?.status).toBe("ran");
    if (width === 1440) continue;
    const inline = observation.wordBreaks?.records.find(
      (r) => r.selector === "#inline-heading",
    );
    expect(inline?.word).toBe("solutions");
    expect(inline?.before.selector).toContain("span");
    expect(inline?.after.start).toBeGreaterThan(inline?.before.start ?? -1);
  }
});

test("normal wraps, explicit/soft hyphens, CJK, hidden labels and block boundaries stay quiet", async () => {
  const controls = `
    <h2 id="explicit">purpose-<span>ful</span></h2>
    <h2 id="soft">purpose&shy;ful</h2>
    <h2 id="cjk">日本語の文章日本語の文章</h2>
    <h2 id="br">purpose<br>ful</h2>
    <h2 id="blocks"><span style="display:block">purpose</span><span style="display:block">ful</span></h2>
    <h2 id="hidden"><span style="position:absolute;width:1px;height:1px;overflow:hidden">solutionssolutions</span>normal wrap</h2>
    <h2 id="nowrap">purposeful</h2>
    <h2 id="hyphens-on" style="hyphens:auto">normal wrap</h2>`;
  const source = html.replace("</main>", `${controls}</main>`).replace(
    "</style>",
    `
    #explicit,#soft { width:8ch } #cjk { width:4ch }
    #br,#blocks { width:20ch } #nowrap { white-space:nowrap;width:8ch }
    #hidden,#hyphens-on { width:9ch }
  </style>`,
  );
  const result = await review(768, source);
  expect(
    result.findings
      .filter((f) => f.candidate.category === "word-break")
      .map((f) => f.candidate.selectorHint),
  ).toEqual(["#broken-heading", "#inline-heading", "#broken-button"]);
  expect(
    (result.tuples[0]?.observations as ObservationArtifactV2 | undefined)
      ?.wordBreaks?.status,
  ).toBe("ran");
});

test("Unicode offsets, mixed fonts, RTL and nearest heading/button ownership retain real splits", async () => {
  const source = html.replace(
    "</main>",
    `
    <h2 id="unicode" style="width:8ch;word-break:break-all">😀 cafééééééééé</h2>
    <h2 id="mixed" style="width:8ch;word-break:break-all">pur<span style="font-size:20px">posefulpurposeful</span></h2>
    <h2 id="outer"><button id="inner" style="width:6ch;word-break:break-all">solutions</button></h2>
    <div role="heading" aria-level="2" id="aria-heading" style="font:32px/1.2 monospace;width:8ch;word-break:break-all">purposeful</div>
    <div role="button" id="aria-button" style="font:32px/1.2 monospace;width:8ch;word-break:break-all">purposeful</div>
    <h2 id="rtl" dir="rtl" style="width:4ch;word-break:break-all">אבגדהוזחטיכלמנסע</h2>
    <h2 id="auto-break" style="width:8ch;word-break:break-all;hyphens:auto">purposeful</h2>
  </main>`,
  );
  const result = await review(768, source);
  const found = result.findings
    .filter((f) => f.candidate.category === "word-break")
    .map((f) => f.candidate.selectorHint);
  for (const id of [
    "#unicode",
    "#mixed",
    "#inner",
    "#aria-heading",
    "#aria-button",
    "#rtl",
    "#auto-break",
  ])
    expect(found).toContain(id);
  expect(found).not.toContain("#outer");
  const unicode = (
    result.tuples[0]?.observations as ObservationArtifactV2 | undefined
  )?.wordBreaks?.records.find((r) => r.selector === "#unicode");
  expect(unicode?.start).toBe(3);
  expect(unicode?.before.text).toBe("é");
});

test("unsupported or limited word scans retain reasons and independently confirmed defects", async () => {
  const source = html.replace(
    "</main>",
    `<h2 style="writing-mode:vertical-rl">purposeful</h2><h2 style="hyphens:auto;width:5ch;overflow-wrap:anywhere">purposefulpurposeful</h2></main>`,
  );
  const result = await review(768, source);
  expect(
    (result.tuples[0]?.observations as ObservationArtifactV2 | undefined)
      ?.wordBreaks,
  ).toMatchObject({
    status: "partial",
    reason: expect.stringContaining("Vertical writing"),
  });
  expect(
    result.findings
      .filter((f) => f.candidate.category === "word-break")
      .map((f) => f.candidate.selectorHint),
  ).toContain("#broken-heading");
});

test("absent and disabled settings omit geometry entirely", async () => {
  for (const checks of [
    {},
    { bandEdges: { enabled: false }, wordBreak: { enabled: false } },
  ]) {
    const { tuples, findings } = await reviewStates(
      browser,
      [{ state: "page", html }],
      { checks },
    );
    expect(tuples[0]?.observations).not.toHaveProperty("bandEdges");
    expect(tuples[0]?.observations).not.toHaveProperty("wordBreaks");
    expect(
      findings.filter((f) =>
        ["band-edges", "word-break"].includes(f.candidate.category),
      ),
    ).toEqual([]);
  }
});

test("transparent stacks keep parallel columns and overlays out of the band frontier", async () => {
  const source = html
    .replace(
      '<section id="three">',
      '<section id="three"><section id="nested"><p>Nested section</p></section>',
    )
    .replace(
      "</main>",
      `<div id="columns" style="display:flex"><aside style="width:50%">Side column</aside><div style="width:50%">Other column</div></div>
      <div role="dialog" style="position:fixed;inset:0"><section><p>Overlay content</p></section></div>
      <section id="empty" style="height:50px"></section></main>`,
    );
  const { tuples } = await review(1440, source);
  const records = (tuples[0]?.observations as ObservationArtifactV2 | undefined)
    ?.bandEdges?.records;
  expect(records?.map((b) => b.selector)).toEqual([
    "#header",
    "#one",
    "#two",
    "#three",
    "#media",
    "#background",
    "#columns",
    "#empty",
    "#footer",
  ]);
  expect(records?.find((b) => b.selector === "#empty")?.content).toBeNull();
});

test("full-bleed media uses a fixed geometry epsilon independent of alignment tolerance", async () => {
  const source = html.replace(
    'class="media" id="media"',
    'class="media" id="media" style="padding-left:4px"',
  );
  const { tuples } = await reviewStates(
    browser,
    [{ state: "page", html: source }],
    { checks: { bandEdges: { tolerance: 100 } } },
  );
  expect(
    (
      tuples[0]?.observations as ObservationArtifactV2 | undefined
    )?.bandEdges?.records.find((b) => b.selector === "#media")?.fullBleedMedia,
  ).toBe(false);
});

test("inline node boundaries and implicit native heading levels retain their offsets", async () => {
  const source = html.replace(
    "</main>",
    `<h2 id="node-boundary" role="heading" style="width:8ch;word-break:break-all">purposef<span>ul</span></h2></main>`,
  );
  const result = await review(768, source);
  expect(
    (
      result.tuples[0]?.observations as ObservationArtifactV2 | undefined
    )?.wordBreaks?.records.find((r) => r.selector === "#node-boundary"),
  ).toMatchObject({
    word: "purposeful",
    before: { selector: "#node-boundary", start: 7, end: 8 },
    after: { start: 0, end: 1 },
  });
});

test("limits and line clamps disclose incomplete measurement instead of passing silently", async () => {
  const source = html.replace(
    "</main>",
    `<h2 id="clamped" style="width:6ch;word-break:break-all;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden">purposefulpurposeful</h2><h2>${"normal ".repeat(3500)}</h2></main>`,
  );
  const result = await review(768, source);
  const scan = (
    result.tuples[0]?.observations as ObservationArtifactV2 | undefined
  )?.wordBreaks;
  expect(scan).toMatchObject({
    status: "partial",
    reason: expect.stringContaining("size limit"),
  });
  expect(scan?.records.some((r) => r.selector === "#clamped")).toBe(false);
  expect(scan?.records.some((r) => r.selector === "#broken-heading")).toBe(
    true,
  );
});
