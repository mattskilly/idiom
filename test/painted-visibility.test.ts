import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { settleAnimations } from "../src/capture/animation-settle.js";
import { collectPageEvidence } from "../src/capture/page.js";
import { adjacentGapCheck } from "../src/checks/adjacent-gap.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { clippedTextCheck } from "../src/checks/clipped-text.js";
import { controlAnatomyCheck } from "../src/checks/control-anatomy.js";
import { copyLintCheck } from "../src/checks/copy-lint.js";
import { deadAffordanceCheck } from "../src/checks/dead-affordance.js";
import { elementOverlapCheck } from "../src/checks/element-overlap.js";
import { imageDistortionCheck } from "../src/checks/image-distortion.js";
import { lineLengthCheck } from "../src/checks/line-length.js";
import { observePage } from "../src/checks/observe.js";
import { orphanWordCheck } from "../src/checks/orphan-word.js";
import { overflowClipCheck } from "../src/checks/overflow-clip.js";
import { paintedCoverageText, paintedGate } from "../src/checks/painted.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import {
  reportsInteractiveOverlap,
  responsiveBreakCheck,
} from "../src/checks/responsive-break.js";
import { scaleConformanceCheck } from "../src/checks/scale-conformance.js";
import { selectedStateCheck } from "../src/checks/selected-state.js";
import { textCenteringCheck } from "../src/checks/text-centering.js";
import type {
  CheckTuple,
  DeterministicCheck,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import { flowSchema } from "../src/schemas/flow.js";
import { checksConfigSchema, projectSchema } from "../src/schemas/project.js";

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("Missing fixture value");
  return value;
}

let browser: Browser;
let base: ObservedElementV2;
let observation: ObservationArtifactV2;
const config = checksConfigFrom(
  checksConfigSchema.parse({ copy: { locale: "en-US" } }),
);
const load = (name: string) =>
  readFile(
    join(import.meta.dirname, "fixtures/painted-visibility", name),
    "utf8",
  );
const observe = async (page: Page) => {
  const result = await observePage(
    page,
    { status: "not-configured" },
    undefined,
    [],
    { orphanWord: true, lineLength: true, imageRenders: true },
  );
  expect(result.version).toBe(2);
  return result as ObservationArtifactV2;
};
beforeAll(async () => {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(
    '<button id="a" style="border:1px solid black;border-radius:6px;background:white;height:32px;width:100px">Account Settings</button>',
  );
  observation = await observe(page);
  base = must(observation.elements.find((e) => e.selector === "#a"));
  await page.close();
});
afterAll(async () => {
  await browser.close();
});

function element(selector: string, index = 0): ObservedElementV2 {
  const e = structuredClone(base);
  e.selector = selector;
  e.structuralPath = `html[0]/body[0]/button[${index}]`;
  e.stableIslandPath = "html[0]/body[0]";
  e.ancestorSelectors = ["body", "html"];
  e.outOfFlow = false;
  e.rect = { x: index * 100, y: 0, width: 100, height: 32 };
  must(e.signals).labelInk = undefined;
  must(e.signals).lineCount = 1;
  e.painted = { value: true };
  return e;
}
function tuple(
  elements: ObservedElementV2[],
  patch: Partial<ObservationArtifactV2> = {},
): CheckTuple {
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
    observations: { ...structuredClone(observation), elements, ...patch },
  };
}
function run(check: DeterministicCheck, input: CheckTuple, tuples = [input]) {
  return check.run({ tuple: input, tuples, narrowViewport: true, config });
}

const cases: Array<{
  rule: string;
  check: DeterministicCheck;
  prepare: (elements: ObservedElementV2[]) => Partial<ObservationArtifactV2>;
}> = [
  {
    rule: "elements-overlap",
    check: elementOverlapCheck,
    prepare: ([a, b]) => ({
      overlaps: [
        {
          a: must(a).selector,
          b: must(b).selector,
          rect: { x: 0, y: 0, width: 20, height: 20 },
          kinds: ["interactive", "interactive"],
          samples: 5,
          hits: 5,
          partial: [],
        },
      ],
    }),
  },
  {
    rule: "interactive-overlap",
    check: responsiveBreakCheck,
    prepare: ([a, b]) => {
      must(a).hitTestWith = [must(b).selector];
      return {};
    },
  },
  {
    rule: "text-clipped",
    check: clippedTextCheck,
    prepare: ([a, b]) => ({
      clippedText: [
        {
          selector: must(a).selector,
          owner: must(b).selector,
          overflow: { x: 20, y: 0 },
          axis: "x",
          cut: "mid-word",
          lines: 1,
          visibleLines: 1,
          text: "Account Settings",
          visibleText: "Account Set",
        },
      ],
    }),
  },
  {
    rule: "element-content-clipped",
    check: overflowClipCheck,
    prepare: ([a]) => {
      must(a).scrollWidth = 200;
      must(a).clientWidth = 100;
      must(a).styles.overflowX = "hidden";
      return {};
    },
  },
  {
    rule: "label-off-centre",
    check: textCenteringCheck,
    prepare: ([a]) => {
      must(must(a).signals).labelInk = {
        text: "Account Settings",
        lineCount: 1,
        textRect: { x: 0, y: 16, width: 90, height: 16 },
        inkCenterY: 24,
      };
      return {};
    },
  },
  {
    rule: "adjacent-elements-touch",
    check: adjacentGapCheck,
    prepare: () => ({}),
  },
  {
    rule: "mixed-label-casing",
    check: copyLintCheck,
    prepare: ([_a, b, c]) => {
      must(b).text = must(b).directText = "Privacy settings";
      must(c).text = must(c).directText = "More settings";
      return {};
    },
  },
  {
    rule: "mixed-locale-spelling",
    check: copyLintCheck,
    prepare: ([a]) => {
      must(a).text = must(a).directText = "Colour centre";
      return {};
    },
  },
  {
    rule: "orphan-word",
    check: orphanWordCheck,
    prepare: ([a]) => ({
      orphanWords: {
        status: "partial",
        reason: "scan budget",
        records: [
          { selector: must(a).selector, word: "a", lines: 2, text: "Choose a" },
          { selector: must(a).selector, word: "a", lines: 2, text: "Choose a" },
        ],
      },
    }),
  },
  {
    rule: "line-too-long",
    check: lineLengthCheck,
    prepare: ([a]) => ({
      lineLengths: {
        status: "ran",
        records: [
          {
            selector: must(a).selector,
            chars: 120,
            width: 900,
            charWidth: 7.5,
            lines: 3,
            text: "A long paragraph",
          },
        ],
      },
    }),
  },
  {
    rule: "scale-outlier",
    check: scaleConformanceCheck,
    prepare: ([a]) => {
      must(a).rect.height = 64;
      return {};
    },
  },
  {
    rule: "sibling-select-inconsistent",
    check: controlAnatomyCheck,
    prepare: (elements) => {
      for (const e of elements) {
        e.tag = "select";
        must(e.signals).role = "combobox";
        must(e.signals).appearance = "auto";
        must(e.signals).adornment = {
          status: "measured",
          source: "background",
          rect: { x: 80, y: 10, width: 8, height: 8 },
        };
      }
      must(elements[0]).styles.paddingLeft = "20px";
      return {};
    },
  },
  {
    rule: "selected-state-invisible",
    check: selectedStateCheck,
    prepare: ([a, b]) => ({
      selectionGroups: [
        {
          container: "body",
          role: "radiogroup",
          single: true,
          members: [must(a), must(b)].map((e, i) => ({
            selector: e.selector,
            control: e.selector,
            selected: i === 0,
            source: "aria-checked",
            nativeIndicator: false,
            decoration: { bg: "rgb(255, 255, 255)" },
          })),
        },
      ],
    }),
  },
  {
    rule: "image-distorted",
    check: imageDistortionCheck,
    prepare: ([a]) => ({
      imageRenders: {
        status: "ran",
        records: [
          {
            selector: must(a).selector,
            src: "/image.png",
            naturalWidth: 400,
            naturalHeight: 200,
            rendered: { x: 0, y: 0, width: 200, height: 200 },
            objectFit: "fill",
            distortion: 1,
            broken: false,
          },
        ],
      },
    }),
  },
  {
    rule: "dead-link-text",
    check: deadAffordanceCheck,
    prepare: ([a]) => {
      must(a).tag = "span";
      must(a).interactive = false;
      must(a).text = must(a).directText = "Learn more";
      must(must(a).signals).role = "";
      return {};
    },
  },
];

test.each(cases)(
  "$rule gates the owner, counts all-hidden domains and preserves old artifacts",
  ({ rule, check, prepare }) => {
    const elements = ["#a", "#b", "#c", "#d"].map(element);
    const input = tuple(elements, prepare(elements));
    const before = run(check, input);
    expect(before.candidates.some((c) => c.rule === `idiom:${rule}`)).toBe(
      true,
    );
    expect(before.coverage.paintedSkipped?.[`idiom:${rule}`]).toBe(0);
    const hidden = structuredClone(input);
    must(must(hidden.observations).elements[0]).painted = {
      value: false,
      reason: "opacity-0",
    };
    const gated = run(check, hidden);
    expect(
      gated.candidates.some(
        (c) => c.rule === `idiom:${rule}` && c.selectorHint === "#a",
      ),
    ).toBe(false);
    expect(gated.coverage.paintedSkipped?.[`idiom:${rule}`]).toBe(1);
    const allHidden = structuredClone(input);
    for (const e of must(allHidden.observations).elements)
      e.painted = { value: false, reason: "closed-details" };
    const empty = run(check, allHidden);
    expect(empty.candidates.filter((c) => c.rule === `idiom:${rule}`)).toEqual(
      [],
    );
    expect(empty.coverage.paintedSkipped?.[`idiom:${rule}`]).toBeGreaterThan(0);
    const legacy = structuredClone(input);
    for (const e of must(legacy.observations).elements) delete e.painted;
    const old = run(check, legacy);
    const comparable = (items: typeof old.candidates) =>
      items.map(({ evidenceTuples, ...candidate }) => ({
        ...candidate,
        evidenceTuples: evidenceTuples?.map((t) => t.state),
      }));
    expect(comparable(old.candidates)).toEqual(comparable(before.candidates));
    const { paintedSkipped: _, ...coverage } = before.coverage;
    expect(old.coverage).toEqual(coverage);
    if (rule === "orphan-word")
      expect(empty.coverage.reason).toBe("scan budget");
  },
);

test("both overlap operands and clipping owners are gated before deduplication", () => {
  for (const rule of [
    "elements-overlap",
    "interactive-overlap",
    "text-clipped",
  ]) {
    const c = must(cases.find((c) => c.rule === rule));
    const elements = [element("#a"), element("#b", 1)];
    const input = tuple(elements, c.prepare(elements));
    must(elements[0]).painted = { value: false, reason: "opacity-0" };
    must(elements[1]).painted = { value: false, reason: "closed-details" };
    expect(run(c.check, input).coverage.paintedSkipped?.[`idiom:${rule}`]).toBe(
      2,
    );
    expect(
      reportsInteractiveOverlap(must(elements[0]), must(elements[1]), true),
    ).toBe(false);
  }
});

test("a hidden run-wide majority cannot establish an inferred scale; declared scales keep it", () => {
  const visible = element("#visible");
  visible.rect.height = 64;
  const first = tuple([visible]);
  const others = tuple(
    [1, 2, 3, 4].map((i) => {
      const e = element(`#hidden${i}`, i);
      e.painted = { value: false, reason: "opacity-0" };
      return e;
    }),
  );
  others.state = "hidden-majority";
  expect(run(scaleConformanceCheck, first, [first, others]).candidates).toEqual(
    [],
  );
  const legacy = structuredClone(others);
  for (const e of must(legacy.observations).elements) delete e.painted;
  expect(
    run(scaleConformanceCheck, first, [first, legacy]).candidates.some(
      (c) => c.rule === "idiom:scale-outlier",
    ),
  ).toBe(true);
  const declared = checksConfigFrom(
    checksConfigSchema.parse({ scales: { controlHeights: [40] } }),
  );
  const result = scaleConformanceCheck.run({
    tuple: others,
    tuples: [others],
    config: declared,
    narrowViewport: false,
  });
  expect(
    result.candidates.some((c) => c.rule === "idiom:off-scale-height"),
  ).toBe(true);
});

test("facts validate in V1 and V2, reject malformed reasons and leave complete legacy results unchanged", () => {
  for (const version of [1, 2] as const) {
    const input = tuple([element("#a")]);
    const old =
      version === 1
        ? {
            version: 1 as const,
            viewport: observation.viewport,
            document: observation.document,
            elements: must(input.observations).elements,
            headings: [],
            tokens: observation.tokens,
          }
        : must(input.observations);
    if (version === 1) {
      const keys =
        "selector tag text visible interactive enabled rect scrollWidth scrollHeight clientWidth clientHeight outOfFlow ancestorSelectors hitTestWith".split(
          " ",
        );
      const styles =
        "color backgroundColor borderTopColor borderRightColor borderBottomColor borderLeftColor borderTopWidth borderRightWidth borderBottomWidth borderLeftWidth outlineColor outlineWidth outlineStyle fill stroke borderTopLeftRadius borderTopRightRadius borderBottomRightRadius borderBottomLeftRadius overflowX overflowY position".split(
          " ",
        );
      old.elements = old.elements.map((e) => ({
        ...Object.fromEntries(keys.map((k) => [k, e[k as keyof typeof e]])),
        styles: Object.fromEntries(
          styles.map((k) => [k, e.styles[k as keyof typeof e.styles]]),
        ),
      })) as typeof old.elements;
    }
    for (const e of old.elements) delete e.painted;
    expect(observationArtifactSchema.parse(old)).toEqual(old);
    const withFacts = structuredClone(old);
    must(withFacts.elements[0]).painted = { value: true };
    expect(observationArtifactSchema.parse(withFacts)).toEqual(withFacts);
    must(withFacts.elements[0]).painted = {
      value: false,
      reason: "",
      boundary: "",
    };
    expect(observationArtifactSchema.safeParse(withFacts).success).toBe(false);
    const left = runDeterministicChecks(
      [{ ...input, observations: old }],
      undefined,
      config,
    );
    const right = runDeterministicChecks(
      [{ ...input, observations: structuredClone(old) }],
      undefined,
      config,
    );
    expect(right).toEqual(left);
  }
});

test("painted reasons cover ancestor hiding, details, fragments and local clips without a fold cutoff", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent(`<style>.box{display:block;width:40px;height:20px}.clip{position:relative;overflow:hidden;width:20px;height:20px}.gone{position:absolute;left:40px;top:0}.partial{position:absolute;left:10px;top:0}</style>
      <div id="display" style="display:none"><span id="display-child" class="box">x</span></div>
      <div id="visibility" style="visibility:hidden"><span id="visibility-child" class="box">x</span></div>
      <div id="collapse" style="visibility:collapse" class="box">x</div>
      <div id="content" style="content-visibility:hidden"><span id="content-child" class="box">x</span></div>
      <div id="opacity" style="opacity:0"><span id="opacity-child" class="box">x</span></div>
      <div style="opacity:.0000001"><div style="opacity:.0000001"><span id="nonzero" class="box">x</span></div></div>
      <div id="zero" style="width:0;height:0"></div>
      <details id="closed"><summary><span id="summary">Summary</span></summary><span id="closed-child" class="box">x</span><details open><summary id="nested-summary">Nested</summary></details></details>
      <div class="clip" id="clip"><span id="clipped" class="box gone">x</span><span id="partial" class="box partial">x</span></div>
      <div style="overflow:hidden;width:5px;height:5px"><span id="escaped" class="box" style="position:fixed;left:200px;top:200px">x</span></div>
      <div style="display:contents;overflow:hidden"><span id="contents" class="box">x</span></div>
      <span id="below" class="box" style="position:absolute;top:2000px">x</span>`);
    const result = await observe(page);
    expect(observationArtifactSchema.parse(result)).toEqual(result);
    const facts = Object.fromEntries(
      result.elements.map((e) => [e.selector, e.painted]),
    );
    for (const [id, reason] of Object.entries({
      "display-child": "display-none",
      "visibility-child": "visibility-hidden",
      collapse: "visibility-collapse",
      "content-child": "content-visibility-hidden",
      "opacity-child": "opacity-0",
      zero: "zero-area",
      "closed-child": "closed-details",
      "nested-summary": "closed-details",
      clipped: "clipped-by #clip",
    }))
      expect(facts[`#${id}`]).toMatchObject({ value: false, reason });
    for (const id of [
      "closed",
      "summary",
      "partial",
      "escaped",
      "contents",
      "below",
      "nonzero",
    ])
      expect(facts[`#${id}`]).toEqual({ value: true });
    expect(facts["#clipped"]).toMatchObject({ boundary: "#clip" });
    await page.locator("#closed > summary").click();
    expect(
      (await observe(page)).elements.find((e) => e.selector === "#closed-child")
        ?.painted,
    ).toEqual({ value: true });
  } finally {
    await page.close();
  }
});

test("closed blog TOC links cannot overlap; opening the disclosure restores eligibility", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(await load("blog.html"));
    const closed = await observe(page);
    const closedTuple = tuple(closed.elements, closed);
    expect(
      run(elementOverlapCheck, closedTuple).candidates.some((c) =>
        c.explanation.includes("#toc-link"),
      ),
    ).toBe(false);
    await page.locator("#toc > summary").click();
    const open = await observe(page);
    expect(
      open.elements.find((e) => e.selector === "#toc-link")?.painted,
    ).toEqual({ value: true });
    expect(
      run(elementOverlapCheck, tuple(open.elements, open)).candidates.some(
        (c) => c.explanation.includes("#toc-link"),
      ),
    ).toBe(true);
  } finally {
    await page.close();
  }
});

test("navbox and pending entrance copy are excluded while visible copy defects survive", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(await load("navbox.html"));
    await settleAnimations(page, 10);
    const observed = await observe(page);
    const input = tuple(observed.elements, observed);
    const copy = run(copyLintCheck, input);
    expect(
      copy.candidates.some((c) => c.rule === "idiom:mixed-label-casing"),
    ).toBe(true);
    expect(
      copy.candidates.some((c) => c.rule === "idiom:mixed-locale-spelling"),
    ).toBe(true);
    for (const c of [
      ...copy.candidates,
      ...run(orphanWordCheck, input).candidates,
    ])
      expect(
        observed.elements.find((e) => e.selector === c.selectorHint)?.painted,
      ).toEqual({ value: true });
    expect(
      run(overflowClipCheck, input).candidates.some(
        (c) => c.selectorHint === "#blank",
      ),
    ).toBe(false);
  } finally {
    await page.close();
  }
});

test("skip counts preserve reason text and distinguish rules, without changing legacy coverage text", () => {
  const input = tuple([element("#a"), element("#b", 1)]);
  must(must(input.observations).elements[0]).painted = {
    value: false,
    reason: "opacity-0",
  };
  const gate = paintedGate(input, ["idiom:a", "idiom:b"]);
  gate.allows("idiom:a", "#a", "#a", "#b");
  gate.allows("idiom:a", "#a");
  expect(gate.coverage()).toEqual({
    paintedSkipped: { "idiom:a": 1, "idiom:b": 0 },
  });
  expect(
    paintedCoverageText({ reason: "partial <scan>", ...gate.coverage() }),
  ).toBe(
    "partial <scan>; idiom:a: 1 skipped as not painted; idiom:b: 0 skipped as not painted",
  );
  expect(paintedCoverageText({ reason: "legacy" })).toBe("legacy");
});

const state = must(
  flowSchema.parse({
    id: "f",
    title: "f",
    intent: [],
    setup: [],
    states: [{ id: "s", description: "s", url: "/", expect: {} }],
  }).states[0],
);
async function collect(
  page: Page,
  html: string,
  bound: number,
  reuseScreenshot?: Buffer,
) {
  return collectPageEvidence({
    page,
    state,
    settleMs: 0,
    animationSettleMs: bound,
    reachStage: "state",
    reach: async () => {
      await page.setContent(html);
      return 200;
    },
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    collectConsole: async () => [],
    tokens: { status: "not-configured" },
    screenshotOptions: { animations: "disabled" },
    reuseScreenshot,
    now: () => new Date(),
  });
}

test("animation bounds configure zero, custom values and finite nonnegative defaults", () => {
  const project = {
    version: 1,
    app: { name: "test", framework: "other" },
    server: {
      build: "x",
      start: "x",
      readyUrl: "http://localhost:3000",
      port: 3000,
      env: {},
    },
    capture: {},
    design: {},
    model: { provider: "claude-code", model: "test" },
  };
  expect(projectSchema.parse(project).capture.animationSettleMs).toBe(1500);
  for (const value of [0, 20])
    expect(
      projectSchema.parse({ ...project, capture: { animationSettleMs: value } })
        .capture.animationSettleMs,
    ).toBe(value);
  for (const value of [-1, Infinity, NaN])
    expect(
      projectSchema.safeParse({
        ...project,
        capture: { animationSettleMs: value },
      }).success,
    ).toBe(false);
});

test("collector naturally settles CSS and chained Web Animations before observation", async () => {
  const page = await browser.newPage({ reducedMotion: "no-preference" });
  try {
    const result = await collect(
      page,
      `<div id="fade" style="opacity:0;width:100px;height:30px">copy</div><script>const el=document.querySelector('#fade');el.animate([{opacity:0},{opacity:.5}],{duration:60,fill:'forwards'}).finished.then(()=>el.animate([{opacity:.5},{opacity:1}],{duration:60,fill:'forwards'}));</script>`,
      1000,
    );
    expect(result.ok).toBe(true);
    expect(
      result.observations?.elements.find((e) => e.selector === "#fade")
        ?.painted,
    ).toEqual({ value: true });
    expect(
      await page.locator("#fade").evaluate((e) => getComputedStyle(e).opacity),
    ).toBe("1");
  } finally {
    await page.close();
  }
});

test.each([0, 40])(
  "timed-out entrance stays unpainted in observation and screenshot (bound %i), including reuse",
  async (bound) => {
    const page = await browser.newPage({
      viewport: { width: 200, height: 100 },
      reducedMotion: "no-preference",
    });
    try {
      const html = `<style>body{margin:0;background:white}#fade{width:200px;height:100px;background:red;opacity:0;animation:enter 1s 60s forwards}@keyframes enter{to{opacity:1}}</style><div id="fade">copy</div>`;
      const reused = Buffer.from("wrong screenshot");
      const result = await collect(page, html, bound, reused);
      expect(result.ok).toBe(true);
      expect(result.screenshot).not.toEqual(reused);
      expect(
        result.observations?.elements.find((e) => e.selector === "#fade")
          ?.painted,
      ).toMatchObject({ value: false, reason: "opacity-0" });
      expect(
        await page
          .locator("#fade")
          .evaluate((e) => getComputedStyle(e).opacity),
      ).toBe("0");
      const { PNG } = await import("pngjs");
      const png = PNG.sync.read(must(result.screenshot));
      expect([...png.data.slice(0, 3)]).toEqual([255, 255, 255]);
    } finally {
      await page.close();
    }
  },
);

test("an infinite animation alone keeps the deterministic screenshot", async () => {
  const html = `<style>body{margin:0;background:white}#spin{width:200px;height:100px;background:red;animation:pulse 700ms linear infinite}@keyframes pulse{from{opacity:1}to{opacity:0}}</style><div id="spin">copy</div>`;
  const shots: Buffer[] = [];
  for (const wait of [0, 230]) {
    const page = await browser.newPage({
      viewport: { width: 200, height: 100 },
      reducedMotion: "no-preference",
    });
    try {
      let options: Record<string, unknown> | undefined;
      const screenshot = page.screenshot.bind(page);
      page.screenshot = (async (o?: Record<string, unknown>) => {
        options = o;
        return screenshot(o);
      }) as typeof page.screenshot;
      await page.setContent(html);
      await page.waitForTimeout(wait);
      const result = await collect(page, html, 300);
      expect(result.ok).toBe(true);
      expect(options).toMatchObject({ animations: "disabled" });
      shots.push(must(result.screenshot));
    } finally {
      await page.close();
    }
  }
  expect(shots[1]).toEqual(shots[0]);
});

test("static, unsupported, canceled, paused and infinite animations cannot consume the settle bound", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="x">copy</div>');
    expect(await settleAnimations(page, 1000)).toEqual({
      hadAnimations: false,
      unresolved: false,
    });
    await page.evaluate(() => {
      const el = document.getElementById("x") as HTMLElement;
      const canceled = el.animate([{ opacity: 0 }, { opacity: 1 }], 10000);
      setTimeout(() => canceled.cancel(), 10);
    });
    expect((await settleAnimations(page, 500)).unresolved).toBe(false);
    await page.evaluate(() => {
      const el = document.getElementById("x") as HTMLElement;
      el.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 10000,
        iterations: Infinity,
      });
      el.animate([{ opacity: 0 }, { opacity: 1 }], 10000).pause();
    });
    expect((await settleAnimations(page, 1000)).unresolved).toBe(false);
    await page.evaluate(() => {
      const el = document.getElementById("x") as HTMLElement;
      el.animate([{ opacity: 0 }, { opacity: 1 }], 10000);
    });
    expect((await settleAnimations(page, 100)).unresolved).toBe(true);
    await page.evaluate(() => {
      document.getAnimations = undefined as never;
    });
    expect((await settleAnimations(page, 1000)).unresolved).toBe(false);
  } finally {
    await page.close();
  }
});

test("settling responds to abort and page closure", async () => {
  const page = await browser.newPage();
  await page.setContent('<div id="x">copy</div>');
  await page.evaluate(() =>
    document
      .querySelector("#x")
      ?.animate([{ opacity: 0 }, { opacity: 1 }], 10000),
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stop capture")), 20);
  await expect(settleAnimations(page, 1500, controller.signal)).rejects.toThrow(
    "stop capture",
  );
  const pending = settleAnimations(page, 1500);
  setTimeout(() => void page.close(), 20);
  await expect(pending).rejects.toThrow(/closed/);
});

test("rendered facts and the non-targeted branches retain their findings and coverage", () => {
  const a = element("#a");
  a.scrollWidth = 200;
  a.clientWidth = 100;
  a.styles.overflowX = "hidden";
  a.tag = "input";
  const input = tuple([a], {
    document: {
      scrollWidth: 1600,
      clientWidth: 1440,
      scrollHeight: 900,
      clientHeight: 900,
    },
    fonts: {
      status: "ran",
      faces: [
        {
          family: "Missing",
          status: "error",
          weight: "400",
          style: "normal",
          urls: [],
        },
      ],
      used: [{ family: "Missing", selectors: ["#a"], fallback: true }],
      failedRequests: [],
    },
    links: {
      status: "ran",
      records: [
        {
          selector: "#a",
          text: "Broken",
          href: "https://example.test/broken",
          sameOrigin: true,
          result: { status: "broken", code: 404, reason: "HTTP 404" },
        },
      ],
    },
  });
  input.console = [{ type: "error", text: "failed resource" }];
  input.mismatches = [{ kind: "status", expected: 200, actual: 500 }];
  input.axe = {
    violations: [
      {
        id: "color-contrast",
        impact: "serious",
        nodes: [{ target: ["#a"], html: "<input>" }],
      },
      { id: "button-name", impact: "serious", nodes: [{ target: ["#a"] }] },
    ],
  };
  const withFalse = structuredClone(input);
  must(must(withFalse.observations).elements[0]).painted = {
    value: false,
    reason: "opacity-0",
  };
  const legacy = structuredClone(input);
  for (const e of must(legacy.observations).elements) delete e.painted;
  const rules = new Set(cases.map(({ rule }) => `idiom:${rule}`));
  const compare = (t: CheckTuple) =>
    runDeterministicChecks([t], undefined, config)
      .candidates.map(({ candidate }) => candidate)
      .filter((candidate) => !rules.has(candidate.rule));
  expect(compare(withFalse)).toEqual(compare(legacy));
  expect(compare(withFalse).map((c) => c.rule)).toEqual(
    expect.arrayContaining([
      "idiom:document-horizontal-overflow",
      "idiom:input-value-truncated",
      "idiom:font-not-loaded",
      "idiom:broken-link",
      "axe:color-contrast",
      "axe:button-name",
    ]),
  );
});

test.each(["hidden", "clip", "auto", "scroll"])(
  "%s clips intersect independently across axes and multiple ancestors",
  async (overflow) => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<style>.clip{position:relative;width:50px;height:50px;overflow:${overflow}}.part{position:absolute;width:30px;height:30px}</style>
    <div class="clip" id="outer"><div style="position:relative;width:40px;height:40px;overflow:${overflow};left:20px"><span class="part" id="gone-x" style="left:60px">x</span><span class="part" id="gone-y" style="top:60px">x</span><span class="part" id="part" style="left:20px;top:20px">x</span></div></div>
    <div style="overflow:${overflow};width:1px;height:1px"><span id="absolute" style="position:absolute;top:500px;left:500px;width:30px;height:30px">escaped</span></div>`);
      const observed = await observe(page);
      for (const selector of ["#gone-x", "#gone-y"])
        expect(
          observed.elements.find((e) => e.selector === selector)?.painted
            ?.value,
        ).toBe(false);
      for (const selector of ["#part", "#absolute"])
        expect(
          observed.elements.find((e) => e.selector === selector)?.painted,
        ).toEqual({ value: true });
    } finally {
      await page.close();
    }
  },
);

test("collector waits for a real CSS transition and finite CSS animation", async () => {
  const page = await browser.newPage({ reducedMotion: "no-preference" });
  try {
    const result = await collect(
      page,
      `<style>#transition{opacity:0;transition:opacity 80ms}#css{opacity:0;animation:fade 80ms forwards}@keyframes fade{to{opacity:1}}</style><div id="transition">transition</div><div id="css">animation</div><script>getComputedStyle(document.querySelector('#transition')).opacity;document.querySelector('#transition').style.opacity=1;</script>`,
      1000,
    );
    expect(result.ok).toBe(true);
    for (const selector of ["#transition", "#css"])
      expect(
        await page
          .locator(selector)
          .evaluate((e) => getComputedStyle(e).opacity),
      ).toBe("1");
  } finally {
    await page.close();
  }
});

test("painted body clips stay separate from legacy visibility and nonzero opacity never underflows", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><style>html{overflow:auto}body{position:relative;height:20px;overflow:hidden}#child{position:absolute;top:100px;width:30px;height:30px}</style><span id="child">clipped</span>`,
    );
    const observed = await observe(page);
    expect(
      observed.elements.find((e) => e.selector === "#child")?.painted,
    ).toMatchObject({ value: false, reason: "clipped-by body" });
    const legacy = await page.evaluate(() =>
      window.__idiomVisibility.measure(
        document.querySelector("#child") as Element,
      ),
    );
    expect(legacy.rendered).toBe(true);
    expect(legacy.visible.height).toBeGreaterThan(0);
    await page.setContent('<div id="opacity-chain"></div>');
    await page.evaluate(() => {
      let parent = document.getElementById("opacity-chain") as HTMLElement;
      for (let i = 0; i < 60; i++) {
        const child = document.createElement("div");
        child.style.opacity = ".0000001";
        parent.append(child);
        parent = child;
      }
      parent.innerHTML = '<span id="tiny">Still nonzero</span>';
    });
    expect(
      (await observe(page)).elements.find((e) => e.selector === "#tiny")
        ?.painted,
    ).toEqual({ value: true });
  } finally {
    await page.close();
  }
});

test.each([false, true])(
  "public quick JSON carries tuple check coverage only when painted facts exist (%s)",
  async (hasFact) => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { runQuick } = await import("../src/quick/run.js");
    const directory = await mkdtemp(join(tmpdir(), "idiom-painted-json-"));
    try {
      const item = element("#a");
      if (hasFact) item.painted = { value: false, reason: "opacity-0" };
      else delete item.painted;
      const result = await runQuick({
        urls: ["https://example.test/"],
        cwd: directory,
        out: join(directory, "out"),
        dependencies: {
          environment: {},
          browserLauncher: async () => ({
            version: "test",
            close: async () => {},
            capture: async (input) => ({
              ok: true,
              status: 200,
              dom: "<button>Account Settings</button>",
              screenshot: Buffer.from("png"),
              console: [],
              axe: { violations: [] },
              mismatches: [],
              observations: {
                ...structuredClone(observation),
                elements: [item],
                viewport: {
                  width: input.viewport.width,
                  height: input.viewport.height,
                },
              },
              startedAt: "2026-10-26T00:00:00.000Z",
              endedAt: "2026-10-26T00:00:00.000Z",
            }),
          }),
        },
      });
      const json = JSON.parse(JSON.stringify(result));
      if (hasFact) {
        expect(json.checkCoverage).toContainEqual(
          expect.objectContaining({
            state: "page-1",
            viewport: "desktop",
            colorScheme: "light",
            check: "text-centering",
            status: "ran",
            paintedSkipped: { "idiom:label-off-centre": 1 },
          }),
        );
        expect(
          json.checkCoverage.every(
            (entry: Record<string, unknown>) =>
              !("observations" in entry) && !("tuple" in entry),
          ),
        ).toBe(true);
      } else expect(json).not.toHaveProperty("checkCoverage");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
