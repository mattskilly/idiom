import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
const fixture = (name: string) =>
  readFile(
    join(import.meta.dirname, "fixtures/visible-explanations", name),
    "utf8",
  );
const relevant = (findings: Awaited<ReturnType<typeof reviewFixture>>) =>
  findings
    .map(({ candidate }) => candidate)
    .filter((c) =>
      ["unexplained-control", "dead-affordance"].includes(c.category),
    );

test("default mode delegates nameless SVG controls to axe and judges a glyph-only name", async () => {
  const svg =
    '<svg aria-hidden="true" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>';
  const findings = (
    await reviewFixture(
      browser,
      `<!doctype html><html lang="en"><title>Controls</title>
    <style>button,a{display:inline-block;width:48px;height:48px;margin:20px}</style><main><h1>Controls</h1>
    <button id="nameless-button">${svg}</button><a id="nameless-link" href="/help">${svg}</a>
    <button id="glyph" aria-label="i">${svg}</button></main>`,
      { axe: true },
    )
  ).map(({ candidate }) => candidate);
  for (const [selector, rule] of [
    ["#nameless-button", "axe:button-name"],
    ["#nameless-link", "axe:link-name"],
  ]) {
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule, selectorHint: selector }),
      ]),
    );
    expect(
      findings.some(
        (c) =>
          c.selectorHint === selector && c.rule === "idiom:unexplained-control",
      ),
    ).toBe(false);
  }
  expect(findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        rule: "idiom:unexplained-control",
        selectorHint: "#glyph",
      }),
    ]),
  );
});

test("default mode reports disabled navigation, and the named glyph only with probe evidence (dogfooding request #55)", async () => {
  const html = await fixture("before.html");
  const shapes = (found: ReturnType<typeof relevant>) =>
    found.map((c) => `${c.rule} ${c.selectorHint} ${c.severity}`).sort();
  const navigation = ["#help", "#native", "#role", "#terms"].map(
    (selector) => `idiom:disabled-link-button ${selector} minor`,
  );
  expect(shapes(relevant(await reviewFixture(browser, html)))).toEqual(
    navigation,
  );
  expect(
    shapes(relevant(await reviewFixture(browser, html, { probe: true }))),
  ).toEqual([...navigation, "idiom:unexplained-control #layers-help minor"]);
});

test("visible mode finds the real shapes and clears their repairs", async () => {
  const before = relevant(
    await reviewFixture(browser, await fixture("before.html"), {
      checks: { explanation: "visible" },
    }),
  );
  expect(
    before
      .filter((c) => c.category === "unexplained-control")
      .map((c) => c.selectorHint),
  ).toEqual(["#layers-help"]);
  expect(
    before
      .filter((c) => c.rule === "idiom:disabled-link-button")
      .map((c) => c.selectorHint)
      .sort(),
  ).toEqual(["#help", "#native", "#role", "#terms"]);
  expect(
    before
      .filter((c) => c.rule === "idiom:disabled-link-button")
      .every((c) => c.severity === "minor"),
  ).toBe(true);
  const after = relevant(
    await reviewFixture(browser, await fixture("after.html"), {
      checks: { explanation: "visible" },
    }),
  );
  expect(after.every((c) => c.rule === "idiom:placeholder-link")).toBe(true);
  expect(after).toHaveLength(4);
});

import {
  ExplanationCollector,
  mergeExplanations,
  probeExplanations,
} from "../src/capture/explanations.js";
import { probeControls } from "../src/capture/probe.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { observePage } from "../src/checks/observe.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { reviewStates } from "./benchmark-support.js";

const visible = { explanation: "visible" };
const unexplained = (findings: Awaited<ReturnType<typeof reviewFixture>>) =>
  relevant(findings)
    .filter((c) => c.category === "unexplained-control")
    .map((c) => c.selectorHint);

test("painted labels and descriptions exclude hidden ancestors, clipping and tooltip descendants", async () => {
  const html = `<!doctype html><body><style>
    .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
    .contents{display:contents} .tip{display:none} .gone{opacity:0}
    </style>
    <button id="named" aria-label="Layer shortcuts" title="Layer shortcuts">?</button>
    <button id="hidden-label">?<span class="sr">Layer shortcuts</span></button>
    <button id="nested"><span class="contents"><span>Layer shortcuts</span></span></button>
    <button id="good" aria-describedby="missing hidden painted">?</button><span id="painted" class="contents">Layer shortcuts</span>
    <button id="bad" aria-describedby="hidden zero">?</button><span id="hidden" class="sr">Layer shortcuts</span><span class="gone"><span id="zero">Layer shortcuts</span></span>
    <button id="tip-label">?<span role="tooltip" class="tip">Layer shortcuts</span></button>`;
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "labels", html }],
    { checks: visible },
  );
  expect(unexplained(findings)).toEqual([
    "#named",
    "#hidden-label",
    "#bad",
    "#tip-label",
  ]);
  const observations = tuples[0]?.observations;
  if (observations?.version !== 2) throw new Error("v2 expected");
  expect(
    observations?.elements.find((e) => e.selector === "#hidden-label")?.signals
      ?.explanation?.visibleText,
  ).toBe("?");
  expect(
    observations?.elements.find((e) => e.selector === "#good")?.signals
      ?.explanation?.descriptions,
  ).toEqual([{ selector: "#painted", text: "Layer shortcuts" }]);
});

test("CSS hover/focus and delayed portal tooltips persist independently and judge offline", async () => {
  const html = `<!doctype html><body><style>
    .wrap{display:inline-block;margin:20px}.tip{display:none;position:absolute} #portal{position:absolute;top:0;left:0}
    button:hover + .tip, button:focus + .tip {display:block}
    </style><div class="wrap"><button id="css" aria-label="Settings">?</button><span class="tip" role="tooltip">Page settings</span></div>
    <button id="portal" aria-label="Settings">?</button>
    <script>(()=>{const b=document.querySelector('#portal');let timer;
    function show(){clearTimeout(timer);timer=setTimeout(()=>{if(!document.querySelector('#portal-tip')){const tip=document.createElement('div');tip.id='portal-tip';tip.role='tooltip';tip.textContent='Page settings';document.body.append(tip)}},80)}
    function hide(){clearTimeout(timer);document.querySelector('#portal-tip')?.remove()}
    b.addEventListener('mouseenter',show);b.addEventListener('focus',show);b.addEventListener('mouseleave',hide);b.addEventListener('blur',hide);})();</script>`;
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "tooltips", html }],
    { checks: visible, probe: true },
  );
  expect(unexplained(findings)).toEqual([]);
  const artifact = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(tuples[0]?.observations)),
  );
  expect(artifact.version).toBe(2);
  if (artifact.version !== 2) throw new Error("v2 expected");
  for (const selector of ["#css", "#portal"]) {
    expect(
      artifact.explanations?.records
        .filter((r) => r.selector === selector && r.status === "observed")
        .map((r) => r.trigger)
        .sort(),
    ).toEqual(["focus", "hover"]);
  }
  const tuple = tuples[0];
  if (!tuple) throw new Error("tuple expected");
  expect(
    runDeterministicChecks(
      [{ ...tuple, observations: artifact }],
      undefined,
      checksConfigFrom(visible as { explanation: "visible" }),
    ).candidates.filter((c) => c.candidate.category === "unexplained-control"),
  ).toEqual([]);
}, 60_000);

test("hover-only, focus-only, unrelated and ambiguous tooltips cannot supply both modalities", async () => {
  const html = `<!doctype html><body><style>
    .wrap{display:inline-block;margin:20px}.tip{display:none}
    #hover:hover + .tip, #focus:focus + .tip, #ambiguous:is(:hover,:focus) ~ .tip{display:block}
    </style><div role="tooltip">Unrelated existing help</div>
    <div class="wrap"><button id="hover" aria-label="Help">?</button><span role="tooltip" class="tip">Hover help</span></div>
    <div class="wrap"><button id="focus" aria-label="Help">?</button><span role="tooltip" class="tip">Focus help</span></div>
    <button id="unrelated" aria-label="Help">?</button>
    <div class="wrap"><button id="ambiguous" aria-label="Help">?</button><span class="tip" role="tooltip">First help</span><span class="tip" role="tooltip">Second help</span></div>`;
  expect(
    unexplained(
      await reviewFixture(browser, html, { checks: visible, probe: true }),
    ),
  ).toEqual(["#hover", "#focus", "#unrelated", "#ambiguous"]);
}, 60_000);

test("capture action windows record actual Tab focus without inventing hover or clicking links", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(
      `<!doctype html><style>.tip{display:none}a:is(:hover,:focus)+.tip{display:block}</style><button id="start">Start</button><a id="link" href="https://example.invalid/" aria-label="Help">?</a><span role="tooltip" class="tip">Help topics</span>`,
    );
    const collector = new ExplanationCollector(page);
    let window = await collector.start();
    await page.locator("#link").hover();
    await window.finish();
    await window.dispose();
    await page.mouse.move(0, 0);
    await page.locator("#start").focus();
    window = await collector.start();
    await page.locator("#start").press("Tab");
    await window.finish();
    await window.dispose();
    expect(
      collector
        .evidence()
        .records.filter((r) => r.status === "observed")
        .map((r) => [r.selector, r.trigger]),
    ).toEqual([
      ["#link", "hover"],
      ["#link", "focus"],
    ]);
    const probe = await probeControls({
      page,
      explanation: "visible",
      skip: [],
      maxControls: 10,
      waitMs: 100,
      restore: async () => {
        await page.setContent(
          `<!doctype html><style>.tip{display:none}a:is(:hover,:focus)+.tip{display:block}</style><a id="link" href="https://example.invalid/" aria-label="Help">?</a><span role="tooltip" class="tip">Help topics</span>`,
        );
      },
    });
    expect(page.url()).toBe("about:blank");
    expect(probe.results.some((r) => r.selector === "#link")).toBe(false);
    const observations = await observePage(page, { status: "not-configured" });
    expect(
      mergeExplanations(collector.evidence(), probe.explanations)?.records
        .length,
    ).toBeGreaterThan(1);
    expect(observations.version).toBe(2);
  } finally {
    await context.close();
  }
}, 60_000);

test("skip, cap and failed focus remain unavailable and dispose all action listeners", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = `<!doctype html><button id="skip" aria-label="Help">?</button><div id="failure" role="button" aria-label="Help">?</div><button id="cap" aria-label="Help">?</button>`;
  try {
    await page.setContent(html);
    const artifact = await probeExplanations({
      page,
      skip: ["#skip"],
      maxControls: 1,
      waitMs: 0,
      restore: () => page.setContent(html),
    });
    expect(artifact.status).toBe("partial");
    expect(
      artifact.records.some(
        (r) => r.selector === "#skip" && r.reason === "checks.probe.skip",
      ),
    ).toBe(true);
    expect(
      artifact.records.some(
        (r) => r.selector === "#cap" && r.reason === "checks.probe.maxControls",
      ),
    ).toBe(true);
    expect(
      artifact.records.some(
        (r) =>
          r.selector === "#failure" &&
          r.reason === "control did not receive focus",
      ),
    ).toBe(true);
    expect(await page.evaluate(() => "__idiomExplanations" in window)).toBe(
      false,
    );
  } finally {
    await context.close();
  }
}, 60_000);

test("a tooltip-only control stays dead after explanation sampling", async () => {
  const html = `<!doctype html><style>[role=tooltip]{display:none}button:is(:hover,:focus)+[role=tooltip]{display:block}</style><button id="dead" aria-label="Help">?</button><span role="tooltip">Help topics</span>`;
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "dead", html }],
    { checks: visible, probe: true },
  );
  expect(unexplained(findings)).toEqual([]);
  expect(
    findings.some(
      ({ candidate }) =>
        candidate.category === "dead-control" &&
        candidate.selectorHint === "#dead",
    ),
  ).toBe(true);
  const artifact = tuples[0]?.observations;
  expect(
    artifact?.version === 2 &&
      artifact.probe?.results.find((r) => r.selector === "#dead")?.effects,
  ).toEqual([]);
}, 60_000);

test("replay failure preserves completed tooltip samples, stops clicks and cleans listeners", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let clicks = 0;
  await context.exposeFunction("recordProbeClick", () => {
    clicks += 1;
  });
  const html = `<!doctype html><style>[role=tooltip]{display:none}button:is(:hover,:focus)+[role=tooltip]{display:block}</style><button id="first" aria-label="Help" onclick="recordProbeClick()" onfocus="document.body.dataset.seen='yes'">?</button><span role="tooltip">First help</span><button id="second" aria-label="Help" onclick="recordProbeClick()">?</button><span role="tooltip">Second help</span>`;
  try {
    await page.setContent(html);
    // Focusing #first persists a change, so the first full replay is the
    // one that fails; the restore ladder covers the samples before it.
    let restores = 0;
    const probe = await probeControls({
      page,
      explanation: "visible",
      skip: [],
      maxControls: 10,
      waitMs: 0,
      restore: async () => {
        restores += 1;
        if (restores >= 1) throw new Error("replay unavailable");
        await page.setContent(html);
      },
    });
    expect(probe.status).toBe("partial");
    expect(clicks).toBe(0);
    expect(probe.results).toHaveLength(2);
    expect(probe.results[0]).toMatchObject({
      selector: "#first",
      status: "completed",
      skipped: expect.stringContaining("replay unavailable"),
    });
    expect(probe.results[1]).toMatchObject({
      selector: "#second",
      status: "not-reached",
      skipped: expect.stringContaining("replay unavailable"),
    });
    expect(
      probe.explanations?.records
        .filter((r) => r.selector === "#first" && r.status === "observed")
        .map((r) => r.trigger)
        .sort(),
    ).toEqual(["focus", "hover"]);
    expect(
      probe.explanations?.records.some(
        (r) => r.selector === "#second" && r.status === "unavailable",
      ),
    ).toBe(true);
    expect(await page.evaluate(() => "__idiomExplanations" in window)).toBe(
      false,
    );
  } finally {
    await context.close();
  }
}, 60_000);

test("off-screen, fully clipped and transparent words cannot explain a visible glyph", async () => {
  const html = `<!doctype html><style>
    .off{position:absolute;left:-10000px} .clip{position:relative;width:100px;height:20px;overflow:hidden}
    .outside{position:absolute;left:200px;top:0;white-space:nowrap} .clear{color:transparent}
    .fill{-webkit-text-fill-color:transparent} .inset{clip-path:inset(50%)}
    .rect{position:absolute;clip:rect(0px,0px,0px,0px);width:100px;height:20px}
    </style>
    <button id="off-description" aria-describedby="off">?</button><span id="off" class="off">Layer shortcuts</span>
    <button id="clip-description" aria-describedby="clip">?</button><div class="clip"><span id="clip" class="outside">Layer shortcuts</span></div>
    <button id="off-label" aria-label="Help">?<span class="off">Layer shortcuts</span></button>
    <button id="clear-label" aria-label="Help">?<span class="clear">Layer shortcuts</span></button>
    <button id="fill-label" aria-label="Help">?<span class="fill">Layer shortcuts</span></button>
    <button id="inset-label" aria-label="Help">?<span class="inset">Layer shortcuts</span></button>
    <button id="rect-label" aria-label="Help">?<span class="rect">Layer shortcuts</span></button>
    <button id="partial" aria-label="Help" style="width:12px;overflow:hidden;white-space:nowrap;padding:0">? Layer shortcuts</button>
    <button id="below-fold" style="position:absolute;top:2000px">Readable action</button>
    <button id="good" aria-describedby="good-description">?</button><span id="good-description" style="clip:rect(0px,0px,0px,0px)">Layer shortcuts</span>`;
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "hidden", html }],
    { checks: visible },
  );
  expect(unexplained(findings)).toEqual([
    "#off-description",
    "#clip-description",
    "#off-label",
    "#clear-label",
    "#fill-label",
    "#inset-label",
    "#rect-label",
    "#partial",
  ]);
  const artifact = tuples[0]?.observations;
  if (artifact?.version !== 2) throw new Error("v2 missing");
  for (const selector of ["#off-description", "#clip-description"])
    expect(
      artifact.elements.find((e) => e.selector === selector)?.signals
        ?.explanation?.descriptions,
    ).toEqual([]);
  for (const selector of [
    "#off-label",
    "#clear-label",
    "#fill-label",
    "#inset-label",
    "#rect-label",
  ])
    expect(
      artifact.elements.find((e) => e.selector === selector)?.signals
        ?.explanation?.visibleText,
    ).toBe("?");
});

test("invisible tooltip paint supplies no hover or focus evidence", async () => {
  const html = `<!doctype html><style>
    .wrap{display:inline-block;margin:15px}.tip{display:none;position:absolute}
    button:is(:hover,:focus)+.tip{display:block}
    #off + .tip{left:-10000px} #clear + .tip{color:transparent}
    .clip{position:relative;width:100px;height:25px;overflow:hidden} #clip + .tip{left:200px;top:0}
    </style>
    <div class="wrap"><button id="off" aria-label="Help">?</button><span class="tip" role="tooltip">Help topics</span></div>
    <div class="wrap"><button id="clear" aria-label="Help">?</button><span class="tip" role="tooltip">Help topics</span></div>
    <div class="wrap clip"><button id="clip" aria-label="Help">?</button><span class="tip" role="tooltip">Help topics</span></div>`;
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "tooltips", html }],
    { checks: visible, probe: true },
  );
  expect(unexplained(findings)).toEqual(["#off", "#clear", "#clip"]);
  const artifact = tuples[0]?.observations;
  expect(
    artifact?.version === 2 &&
      artifact.explanations?.records.filter((r) => r.status === "observed"),
  ).toEqual([]);
}, 60000);

test("aria-disabled glyphs can explain themselves through safe hover and actual focus", async () => {
  const html = `<!doctype html><style>[role=tooltip]{display:none}button:is(:hover,:focus)+[role=tooltip]{display:block}</style>
    <button id="help" aria-disabled="true" aria-label="Help">?</button><span role="tooltip">Help is temporarily unavailable</span>
    <button id="native" disabled aria-label="Help">?</button><span role="tooltip">Help is temporarily unavailable</span>
    <script>window.clicks=0;document.addEventListener('click',()=>window.clicks++);</script>`;
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "disabled", html }],
    { checks: visible, probe: true },
  );
  expect(unexplained(findings)).toEqual(["#native"]);
  const artifact = tuples[0]?.observations;
  if (artifact?.version !== 2) throw new Error("v2 missing");
  expect(
    artifact.explanations?.records
      .filter((r) => r.selector === "#help" && r.status === "observed")
      .map((r) => r.trigger)
      .sort(),
  ).toEqual(["focus", "hover"]);
  expect(
    artifact.probe?.results.some(
      (r) => r.selector === "#help" || r.selector === "#native",
    ),
  ).toBe(false);
}, 60000);

test("fieldset disability includes nested buttons and preserves the first-legend exception", async () => {
  const html = `<!doctype html><fieldset disabled>
    <legend><button id="legend">Help</button></legend>
    <button id="help" title="Coming soon">Help</button><div><button id="terms">View terms</button></div>
    <legend><button id="second-legend">Docs</button></legend>
    <button id="glyph" aria-label="Help">?</button>
    </fieldset><button id="enabled">Help</button>`;
  const found = relevant(
    await reviewFixture(browser, html, { checks: visible }),
  );
  expect(
    found
      .filter((c) => c.rule === "idiom:disabled-link-button")
      .map((c) => c.selectorHint),
  ).toEqual(["#help", "#terms", "#second-legend"]);
  expect(found.find((c) => c.selectorHint === "#glyph")?.severity).toBe(
    "minor",
  );
  // Default mode reports the same disabled navigation buttons.
  expect(
    relevant(await reviewFixture(browser, html)).map((c) => c.selectorHint),
  ).toEqual(["#help", "#terms", "#second-legend"]);
});

test("controls below the first viewport keep both visible-mode rules", async () => {
  const controls = `<button id="terms" aria-disabled="true" title="Coming soon">View terms</button>
    <button id="q" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">?</button>`;
  const shapes = (findings: Awaited<ReturnType<typeof reviewFixture>>) =>
    relevant(findings)
      .map((c) => `${c.rule ?? c.category} ${c.selectorHint}`)
      .sort();
  const top = shapes(
    await reviewFixture(browser, `<!doctype html><main>${controls}</main>`, {
      checks: visible,
    }),
  );
  expect(top).toEqual([
    "idiom:disabled-link-button #terms",
    "idiom:unexplained-control #q",
  ]);
  for (const html of [
    `<!doctype html><main style="height:3000px"></main><footer>${controls}</footer>`,
    `<!doctype html><style>body{overflow:hidden}</style><main style="height:3000px"></main><footer>${controls}</footer>`,
  ])
    expect(
      shapes(await reviewFixture(browser, html, { checks: visible })),
    ).toEqual(top);
}, 60_000);

test("the default probe samples text glyphs only, not icon buttons", async () => {
  const html = `<!doctype html><main>
    <button id="q" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">?</button>
    <button id="icon" aria-label="Close panel"><svg width="16" height="16"><path d="M0 0L16 16"/></svg></button>
    </main>`;
  let selectors: string[] = [];
  const found = relevant(
    await reviewFixture(browser, html, {
      probe: true,
      onObservations: (observations) => {
        if (observations.version === 2)
          selectors = [
            ...new Set(
              (observations.explanations?.records ?? []).map(
                (record) => record.selector,
              ),
            ),
          ];
      },
    }),
  );
  expect(selectors).toEqual(["#q"]);
  expect(found.map((c) => `${c.rule} ${c.selectorHint} ${c.severity}`)).toEqual(
    ["idiom:unexplained-control #q minor"],
  );
}, 60000);
