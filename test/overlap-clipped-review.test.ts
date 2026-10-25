import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ObservationArtifactV2 } from "../src/checks/types.js";
import { reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
const page = (body: string, css: string) => `<!doctype html><style>
body { margin:20px; font:16px/24px Arial; } * { box-sizing:border-box; }
button, input { font:inherit; } ${css}</style>${body}`;

// f_8cce42db: an icon alongside a wrapping menu caption is not a carousel.
test("clipped menu label inside an icon row reports until ellipsized", async () => {
  const markup =
    '<button id="menu"><span class="row"><span class="icon">↶</span><span id="text">Undo Make the hero section feel calmer and more spacious</span></span></button>';
  const css =
    "#menu { width:180px; height:28px; overflow:hidden; padding:0; text-align:center; } .row { display:flex; } .icon { flex:none; width:24px; } #text { flex:1; min-width:0; }";
  const before = await reviewFixture(browser, page(markup, css));
  expect(
    before.find(({ candidate }) => candidate.category === "clipped-text")
      ?.candidate.verification.params,
  ).toMatchObject({ selector: "#text", owner: "#menu", axis: "y" });
  const after = await reviewFixture(
    browser,
    page(
      markup,
      `${css} #text { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }`,
    ),
  );
  expect(
    after.filter(({ candidate }) => candidate.category === "clipped-text"),
  ).toEqual([]);
});

// f_9f4c5ffd: wrapping labels often put the caption in a span.
test("nested wrapping captions retain their groups, excluding control and helper text", async () => {
  const markup =
    '<section><label id="label"><span><strong>Name</strong></span><input id="name"><span id="hint">Inherited</span></label><label id="other"><span>Email</span><input id="email"><span id="other-hint">Inherited</span></label></section>';
  const css =
    "section, label { display:flex; flex-direction:column; align-items:flex-start; gap:0; } input { width:200px; height:32px; }";
  let observations: ObservationArtifactV2 | undefined;
  const before = await reviewFixture(browser, page(markup, css), {
    onObservations: (value) => {
      if (value.version === 2) observations = value;
    },
  });
  expect(observations?.fieldGroups).toHaveLength(2);
  expect(
    observations?.fieldGroups?.[0]?.members.map((member) => member.selector),
  ).toEqual(["#label", "#name", "#hint"]);
  expect(observations?.fieldGroups?.[0]?.members[0]?.rect.height).toBeLessThan(
    32,
  );
  const findings = before.filter(
    ({ candidate }) => candidate.category === "field-group",
  );
  expect(
    findings.filter(
      ({ candidate }) => candidate.rule === "idiom:field-group-inner-gap",
    ),
  ).toHaveLength(4);
  expect(
    findings.find(
      ({ candidate }) => candidate.rule === "idiom:field-group-between-gap",
    )?.candidate.verification.params,
  ).toMatchObject({ gap: 0, minimum: 12 });
  const after = await reviewFixture(
    browser,
    page(markup, `${css} section { gap:16px; } label { gap:4px; }`),
  );
  expect(
    after.filter(({ candidate }) => candidate.category === "field-group"),
  ).toEqual([]);
});

// f_265b31ef: helper discovery follows each nested control branch outward.
test("nested helper siblings are measured and stop at the next field", async () => {
  const markup =
    '<div class="field"><label for="name">Name</label><div class="controls"><div class="control"><input id="name"><span id="hint">Inherited</span></div><span id="outer-hint">Optional</span><label for="email">Email</label><input id="email"></div></div>';
  const css =
    ".field, .controls { display:flex; flex-direction:column; align-items:flex-start; gap:4px; } .control { display:flex; flex-direction:column; align-items:flex-start; gap:0; } input { width:200px; height:32px; }";
  let observations: ObservationArtifactV2 | undefined;
  const before = await reviewFixture(browser, page(markup, css), {
    onObservations: (value) => {
      if (value.version === 2) observations = value;
    },
  });
  expect(
    observations?.fieldGroups?.[0]?.members.map((member) => member.selector),
  ).toEqual([
    expect.stringContaining("label"),
    "#name",
    "#hint",
    "#outer-hint",
  ]);
  expect(
    before.find(
      ({ candidate }) =>
        candidate.category === "field-group" &&
        candidate.selectorHint === "#hint",
    )?.candidate.verification.params,
  ).toMatchObject({ selector: "#hint", neighbour: "#name", gap: 0 });
  const after = await reviewFixture(
    browser,
    page(
      markup,
      `${css} .control { gap:4px; } label[for=email] { margin-top:12px; }`,
    ),
  );
  expect(
    after.filter(({ candidate }) => candidate.category === "field-group"),
  ).toEqual([]);
});

// f_71b5f24f: a marker on a parent cannot ellipsize a block child's text.
test("ineffective ancestor ellipsis does not hide a clipped block label", async () => {
  const markup =
    '<div id="clip"><span id="text">Supercalifragilistic label</span></div>';
  const css =
    "#clip { width:72px; overflow:hidden; text-overflow:ellipsis; } #text { display:block; white-space:nowrap; }";
  const before = await reviewFixture(browser, page(markup, css));
  expect(
    before.find(({ candidate }) => candidate.category === "clipped-text")
      ?.candidate.verification.params,
  ).toMatchObject({
    selector: "#text",
    owner: "#clip",
    axis: "x",
    cut: "mid-word",
  });
  const after = await reviewFixture(
    browser,
    page(markup, `${css} #text { overflow:hidden; text-overflow:ellipsis; }`),
  );
  expect(
    after.filter(({ candidate }) => candidate.category === "clipped-text"),
  ).toEqual([]);
  const inline = await reviewFixture(
    browser,
    page(
      markup,
      `${css} #text { display:inline; } #clip { white-space:nowrap; }`,
    ),
  );
  expect(
    inline.filter(({ candidate }) => candidate.category === "clipped-text"),
  ).toEqual([]);
});

// f_8a859cda: actual containing blocks, including static paint containment.
test.each([
  ["absolute in paint containment", "contain:paint", "absolute"],
  [
    "fixed in a transformed block",
    "transform:translateZ(0); overflow:hidden",
    "fixed",
  ],
  ["absolute in layout/paint containment", "contain:content", "absolute"],
  ["fixed in paint containment", "contain:paint", "fixed"],
] as const)(
  "%s keeps its containing block's clip",
  async (_name, containment, position) => {
    const markup =
      '<div id="clip"><span id="text">Supercalifragilistic label</span></div>';
    const css = `#clip { width:72px; height:32px; ${containment}; } #text { position:${position}; white-space:nowrap; }`;
    const before = await reviewFixture(browser, page(markup, css));
    expect(
      before.find(({ candidate }) => candidate.category === "clipped-text")
        ?.candidate.verification.params,
    ).toMatchObject({
      selector: "#text",
      owner: "#clip",
      axis: "x",
      cut: "mid-word",
    });
    const after = await reviewFixture(
      browser,
      page(markup, `${css} #clip { width:240px; }`),
    );
    expect(
      after.filter(({ candidate }) => candidate.category === "clipped-text"),
    ).toEqual([]);
  },
);

test("fixed text escapes ordinary positioned overflow ancestors", async () => {
  const found = await reviewFixture(
    browser,
    page(
      '<div><span id="text">An uncut fixed label</span></div>',
      "div { position:relative; width:72px; height:32px; overflow:hidden; } #text { position:fixed; white-space:nowrap; }",
    ),
  );
  expect(
    found.filter(({ candidate }) => candidate.category === "clipped-text"),
  ).toEqual([]);
});

test("wrapped inline links below the fold use line fragments rather than a bounding union", async () => {
  let observations: ObservationArtifactV2 | undefined;
  const found = await reviewFixture(
    browser,
    page(
      '<div>Read <a id="first" href="/unsubscribe">unsubscribe</a> and our <a id="second" href="/privacy">Privacy Policy</a></div>',
      "div { margin-top:2000px; width:320px; font:16px/20px monospace; }",
    ),
    {
      onObservations: (value) => {
        if (value.version === 2) observations = value;
      },
    },
  );
  expect(
    observations?.elements.find((element) => element.selector === "#second")
      ?.rect.height,
  ).toBeGreaterThan(20);
  expect(
    found.filter(({ candidate }) => candidate.category === "element-overlap"),
  ).toEqual([]);
});

// f_88c9eeee: an outer clip can hide the inner element's marker entirely.
test.each([
  [240, 72, true],
  [120, 72, true],
  [72, 72, false],
  [72, 240, false],
] as const)(
  "nested clips: inner %ipx / outer %ipx reports=%s",
  async (inner, outer, reports) => {
    let observations: ObservationArtifactV2 | undefined;
    const found = await reviewFixture(
      browser,
      page(
        '<div id="outer"><div id="inner">Supercalifragilistic label</div></div>',
        `#outer { width:${outer}px; overflow:hidden; } #inner { width:${inner}px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }`,
      ),
      {
        onObservations: (value) => {
          if (value.version === 2) observations = value;
        },
      },
    );
    const clips = found.filter(
      ({ candidate }) => candidate.category === "clipped-text",
    );
    if (reports) {
      expect(clips).toHaveLength(1);
      expect(clips[0]?.candidate.verification.params).toMatchObject({
        selector: "#inner",
        owner: "#outer",
        axis: "x",
        cut: "mid-word",
      });
      expect(observations?.clippedText?.[0]?.overflow.x).toBeGreaterThan(90);
    } else expect(clips).toEqual([]);
  },
);

// f_a0a4005e: -webkit-line-clamp alone does not establish a working clamp.
test.each([
  ["block", "horizontal"],
  ["block", "vertical"],
  ["flow-root", "vertical"],
  ["inline-block", "vertical"],
  ["-webkit-box", "horizontal"],
] as const)(
  "inactive clamp with display %s / orientation %s still reports",
  async (display, orientation) => {
    let observations: ObservationArtifactV2 | undefined;
    const markup =
      '<div id="clip">Undo Make the hero section feel calmer and more spacious</div>';
    const css = `#clip { width:180px; height:28px; overflow:hidden; -webkit-line-clamp:2; display:${display}; -webkit-box-orient:${orientation}; }`;
    const before = await reviewFixture(browser, page(markup, css), {
      onObservations: (value) => {
        if (value.version === 2) observations = value;
      },
    });
    expect(
      before.find(({ candidate }) => candidate.category === "clipped-text")
        ?.candidate.verification.params,
    ).toMatchObject({
      selector: "#clip",
      owner: "#clip",
      axis: "y",
      cut: "hidden-lines",
    });
    expect(observations?.clippedText?.[0]).toMatchObject({
      lines: 3,
      visibleLines: 1,
    });
    const after = await reviewFixture(
      browser,
      page(
        markup,
        `${css} #clip { display:-webkit-box; -webkit-box-orient:vertical; height:auto; }`,
      ),
    );
    expect(
      after.filter(({ candidate }) => candidate.category === "clipped-text"),
    ).toEqual([]);
  },
);

test.each([
  ["-webkit-box", null],
  ["-webkit-inline-box", "color: red; -webkit-line-clamp: 2 !important;"],
] as const)(
  "active %s clamp detection preserves the exact inline style",
  async (display, inlineStyle) => {
    const { observePage } = await import("../src/checks/observe.js");
    const context = await browser.newContext();
    const clampPage = await context.newPage();
    try {
      await clampPage.setContent(
        page(
          '<div id="clip">Undo Make the hero section feel calmer and more spacious</div>',
          `#clip { width:180px; overflow:hidden; -webkit-line-clamp:2; display:${display}; -webkit-box-orient:vertical; }`,
        ),
      );
      if (inlineStyle !== null)
        await clampPage
          .locator("#clip")
          .evaluate(
            (element, value) => element.setAttribute("style", value),
            inlineStyle,
          );
      const observations = await observePage(clampPage, {
        status: "not-configured",
      });
      expect(observations.version === 2 && observations.clippedText).toEqual(
        [],
      );
      expect(await clampPage.locator("#clip").getAttribute("style")).toBe(
        inlineStyle,
      );
      expect(
        await clampPage
          .locator("#clip")
          .evaluate((element) => getComputedStyle(element).webkitLineClamp),
      ).toBe("2");
      expect(
        await clampPage
          .locator("#clip")
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBe(48);
    } finally {
      await context.close();
    }
  },
);

// f_7dfc2e44: an active clamp cannot signal truncation if its marker is hidden.
test.each([
  ["short clamp box", 28, null, false, true],
  ["short clipping parent", 48, 28, false, true],
  ["nested text in a short clipping parent", 48, 28, true, true],
  ["two-line clamp box", 48, null, false, false],
  ["two-line clipping parent", 48, 48, false, false],
  ["unconstrained clamp", null, null, false, false],
] as const)(
  "%s: clamp exemption requires a visible marker",
  async (_name, height, parentHeight, nestedText, reports) => {
    let observations: ObservationArtifactV2 | undefined;
    const text = "Undo Make the hero section feel calmer and more spacious";
    const markup = `<div id="outer"><div id="clip">${nestedText ? `<span id="text">${text}</span>` : text}</div></div>`;
    const found = await reviewFixture(
      browser,
      page(
        markup,
        `#outer { overflow:hidden; ${parentHeight === null ? "" : `height:${parentHeight}px;`} } #clip { width:180px; ${height === null ? "" : `height:${height}px;`} overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; }`,
      ),
      {
        onObservations: (value) => {
          if (value.version === 2) observations = value;
        },
      },
    );
    const clips = found.filter(
      ({ candidate }) => candidate.category === "clipped-text",
    );
    if (reports) {
      expect(clips).toHaveLength(1);
      expect(clips[0]?.candidate.verification.params).toMatchObject({
        selector: nestedText ? "#text" : "#clip",
        owner: parentHeight === null ? "#clip" : "#outer",
        axis: "y",
        cut: "hidden-lines",
      });
      expect(observations?.clippedText?.[0]).toMatchObject({
        lines: 3,
        visibleLines: 1,
      });
    } else expect(clips).toEqual([]);
  },
);

// f_c7f37958: clipping unused inline space must not hide a visible marker.
// f_82894d2a: a clamped line ending at a natural word break paints its marker
// right after that line's text, with no truncated prefix fragment.
const truncated = "Undo Make the hero section feel calmer and more spacious";
const naturalBreak =
  "Undo Make the hero section Supercalifragilisticexpialidocious more";
test.each([
  [truncated, 180, false, false],
  [truncated, 170, false, false],
  [truncated, 170, true, false],
  [truncated, 150, false, true],
  [naturalBreak, 170, false, false],
  [naturalBreak, 150, false, false],
  [naturalBreak, 150, true, false],
  [naturalBreak, 120, false, true],
] as const)(
  "clamp marker placement for %j in a %ipx parent, nested=%s, reports=%s",
  async (text, width, nested, reports) => {
    const found = await reviewFixture(
      browser,
      page(
        `<div id="outer"><div id="clamp">${nested ? `<span id="text">${text}</span>` : text}</div></div>`,
        `#outer { width:${width}px; overflow:hidden; } #clamp { width:180px; overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; }`,
      ),
    );
    const clips = found.filter(
      ({ candidate }) => candidate.category === "clipped-text",
    );
    if (reports) expect(clips).toHaveLength(1);
    else expect(clips).toEqual([]);
  },
);
