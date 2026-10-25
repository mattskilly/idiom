import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { dialogShellCheck } from "../src/checks/dialog-shell.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import {
  type ReviewedFixture,
  reviewFixture,
  reviewStates,
} from "./benchmark-support.js";

/**
 * dogfooding requests #20 (an 18-swatch picker with no visible current
 * value) and #23 (dialog shells: title sizes, missing ×, primary action
 * scrolled out of view). Each defect is reported before and clears after.
 */
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

const fixture = (name: string) =>
  readFile(join(import.meta.dirname, "fixtures", name), "utf8");

const of = (findings: ReviewedFixture, category: string) =>
  findings
    .filter(({ candidate }) => candidate.category === category)
    .map(({ candidate, state }) => ({ ...candidate, state }));

const page = (body: string, style = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title><style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#1d2330}${style}</style></head><body><main><h1>Fixture</h1>${body}</main></body></html>`;

test("selected-state: the 18-swatch picker and an unselected tab list are reported, then clear (#20)", async () => {
  const before = of(
    await reviewFixture(browser, await fixture("selected-state/before.html")),
    "selected-state",
  );
  const invisible = before.find(
    (finding) => finding.rule === "idiom:selected-state-invisible",
  );
  expect(invisible?.explanation).toContain("18 options");
  expect(invisible?.explanation).toContain("#swatches");
  expect(
    before.some(
      (finding) =>
        finding.rule === "idiom:selected-state-none" &&
        finding.explanation.includes("none of the 3 options") &&
        finding.explanation.includes('"Fill"'),
    ),
  ).toBe(true);
  const after = of(
    await reviewFixture(browser, await fixture("selected-state/after.html")),
    "selected-state",
  );
  expect(after).toEqual([]);
}, 60_000);

test("selected-state: two checked options in a single-select group are reported", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(
        `<div role="radiogroup" aria-label="Size"><button role="radio" aria-checked="true">S</button><button role="radio" aria-checked="true">M</button><button role="radio" aria-checked="false">L</button></div>`,
      ),
    ),
    "selected-state",
  );
  expect(findings.map((finding) => finding.rule)).toEqual([
    "idiom:selected-state-multiple",
  ]);
}, 60_000);

test("selected-state: visible native radios, toolbars and label swatches are not noise", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(
        `<fieldset><legend>Plan</legend><label><input type="radio" name="plan" checked> Free</label><label><input type="radio" name="plan"> Pro</label><label><input type="radio" name="plan"> Team</label></fieldset>
        <div role="toolbar" aria-label="Format"><button aria-pressed="false">B</button><button aria-pressed="false">I</button><button aria-pressed="false">U</button></div>
        <div class="chips"><label><input type="radio" name="tone" checked><span>Calm</span></label><label><input type="radio" name="tone"><span>Bold</span></label></div>`,
        `.chips input{position:absolute;opacity:0}.chips label{display:inline-block;padding:4px 10px;border:1px solid #c4cad6;border-radius:999px}.chips label:has(:checked){border-color:#2d5bff;background:#eef2ff}`,
      ),
    ),
    "selected-state",
  );
  expect(findings).toEqual([]);
}, 60_000);

test("selected-state: a label-styled swatch whose checked state shows nothing is reported", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(
        `<div class="chips"><label><input type="radio" name="tone" checked><span>Calm</span></label><label><input type="radio" name="tone"><span>Bold</span></label></div>`,
        `.chips input{position:absolute;opacity:0}.chips label{display:inline-block;padding:4px 10px;border:1px solid #c4cad6;border-radius:999px}`,
      ),
    ),
    "selected-state",
  );
  expect(findings.map((finding) => finding.rule)).toEqual([
    "idiom:selected-state-invisible",
  ]);
}, 60_000);

test("dialog-shell: a modal with no close control and an off-screen primary action is reported, then clears (#23)", async () => {
  const before = of(
    await reviewFixture(browser, await fixture("dialog-shell/before.html")),
    "dialog-shell",
  );
  expect(before.map((finding) => finding.rule).sort()).toEqual([
    "idiom:dialog-close-missing",
    "idiom:dialog-primary-offscreen",
  ]);
  const offscreen = before.find(
    (finding) => finding.rule === "idiom:dialog-primary-offscreen",
  );
  expect(offscreen?.explanation).toContain("Save changes");
  const after = of(
    await reviewFixture(browser, await fixture("dialog-shell/after.html")),
    "dialog-shell",
  );
  expect(after).toEqual([]);
}, 60_000);

const titled = (title: string, size: number, extra = "") =>
  page(
    `<div role="dialog" aria-modal="true" aria-labelledby="t" class="dlg"><h2 id="t" style="font-size:${size}px">${title}</h2><p>Body copy.</p><button aria-label="Close">×</button>${extra}</div>`,
    ".dlg{position:fixed;top:80px;left:80px;width:480px;padding:20px;background:#fff;border:1px solid #d8dce6}",
  );

test("dialog-shell: a dialog title off the run's title size is reported across states", async () => {
  const before = await reviewStates(browser, [
    { state: "rename", html: titled("Rename file", 18) },
    { state: "share", html: titled("Share file", 18) },
    { state: "move", html: titled("Move file", 14) },
  ]);
  expect(
    of(before.findings, "dialog-shell").map(({ rule, state }) => ({
      rule,
      state,
    })),
  ).toEqual([{ rule: "idiom:dialog-title-size", state: "move" }]);
  const after = await reviewStates(browser, [
    { state: "rename", html: titled("Rename file", 18) },
    { state: "share", html: titled("Share file", 18) },
    { state: "move", html: titled("Move file", 18) },
  ]);
  expect(of(after.findings, "dialog-shell")).toEqual([]);
}, 60_000);

/** Id-less portalled dialogs, as Radix, shadcn and Headless UI render them. */
const portal = (title: string, size: number) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title><style>body{font:14px/1.4 system-ui,sans-serif;margin:24px}</style></head><body><main><h1>App</h1></main><div role="dialog" aria-modal="true" style="position:fixed;top:80px;left:80px;width:480px;padding:20px;background:#fff;border:1px solid #d8dce6"><h2 style="font-size:${size}px">${title}</h2><p>Body copy.</p><button>Close</button></div></body></html>`;

test("dialog-shell: portalled dialogs sharing a selector keep separate identities", async () => {
  const before = await reviewStates(browser, [
    { state: "settings", html: portal("Settings", 14) },
    { state: "invite", html: portal("Invite people", 18) },
    { state: "delete", html: portal("Delete project", 18) },
  ]);
  const selectors = before.tuples.map((tuple) =>
    tuple.observations?.version === 2
      ? tuple.observations.dialogs?.[0]?.selector
      : undefined,
  );
  expect(new Set(selectors).size).toBe(1);
  expect(selectors[0]).toBeDefined();
  const findings = of(before.findings, "dialog-shell");
  expect(findings.map(({ rule, state }) => ({ rule, state }))).toEqual([
    { rule: "idiom:dialog-title-size", state: "settings" },
  ]);
  expect(findings[0]?.explanation).toContain("14px");
  expect(findings[0]?.explanation).toContain("18px");
  expect(findings[0]?.explanation).toContain("3 dialogs");
  const after = await reviewStates(browser, [
    { state: "settings", html: portal("Settings", 18) },
    { state: "invite", html: portal("Invite people", 18) },
    { state: "delete", html: portal("Delete project", 18) },
  ]);
  expect(of(after.findings, "dialog-shell")).toEqual([]);
}, 60_000);

test("dialog-shell: the same dialog open in two states counts once", async () => {
  const { findings } = await reviewStates(browser, [
    { state: "open", html: titled("Rename file", 18) },
    { state: "open-again", html: titled("Rename file", 18) },
    { state: "move", html: titled("Move file", 14) },
  ]);
  const titleSize = of(findings, "dialog-shell");
  expect(titleSize.map(({ rule, state }) => ({ rule, state }))).toEqual([
    { rule: "idiom:dialog-title-size", state: "move" },
  ]);
  expect(titleSize[0]?.explanation).toContain("2 dialogs");
}, 60_000);

test("dialog-shell: a small heading-less popover is not judged as a dialog", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(
        `<div role="dialog" style="position:absolute;top:60px;left:60px;width:200px;height:120px;background:#fff;border:1px solid #ccc"><p>Pick a date</p><button>12</button></div>`,
      ),
    ),
    "dialog-shell",
  );
  expect(findings).toEqual([]);
}, 60_000);

test("dialog-shell: a doubled title is reported", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(
        `<div role="dialog" aria-modal="true" class="dlg"><h2>Command menu</h2><h2>Search commands</h2><input aria-label="Search"><button aria-label="Close">×</button></div>`,
        ".dlg{position:fixed;top:80px;left:80px;width:480px;padding:20px;background:#fff}.dlg h2{margin:0 0 8px;font-size:16px}",
      ),
    ),
    "dialog-shell",
  );
  expect(findings.map((finding) => finding.rule)).toEqual([
    "idiom:dialog-heading-duplicated",
  ]);
}, 60_000);

test("selected-state: hidden mirror radios are ignored", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(
        `<div role="radiogroup" aria-label="Density"><div class="row"><span role="radio" aria-checked="true" aria-labelledby="l1" class="dot on"></span><input type="radio" id="r1" aria-hidden="true" tabindex="-1" checked style="clip-path:inset(50%);width:1px;height:1px;margin:-1px;position:fixed;top:0;left:0;border:0;padding:0;overflow:hidden"><label id="l1" for="r1">Default</label></div><div class="row"><span role="radio" aria-checked="false" aria-labelledby="l2" class="dot"></span><input type="radio" id="r2" aria-hidden="true" tabindex="-1" style="clip-path:inset(50%);width:1px;height:1px;margin:-1px;position:fixed;top:0;left:0;border:0;padding:0;overflow:hidden"><label id="l2" for="r2">Compact</label></div></div>`,
        `.dot{display:inline-block;width:16px;height:16px;border:1px solid #c4cad6;border-radius:50%}.dot.on{background:#1d2330;border-color:#1d2330}`,
      ),
    ),
    "selected-state",
  );
  expect(findings).toEqual([]);
}, 60_000);

test("dialog-shell: a qualifying non-modal dialog needs a close control", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(
        `<div role="dialog" style="position:absolute;top:60px;left:60px;width:320px;height:220px;padding:16px;background:#fff;border:1px solid #ccc"><h4>Dimensions</h4><label>Width <input value="100%"></label></div>`,
      ),
    ),
    "dialog-shell",
  );
  expect(findings.map((finding) => finding.rule)).toEqual([
    "idiom:dialog-close-missing",
  ]);
}, 60_000);

test("selected-state: grouped listbox options share the listbox's selection", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(
        `<div role="listbox" aria-label="Commands"><div role="group" aria-label="Suggestions"><div role="option" aria-selected="true" class="on">Calendar</div><div role="option" aria-selected="false">Search</div></div><div role="group" aria-label="Settings"><div role="option" aria-selected="false">Profile</div><div role="option" aria-selected="false">Billing</div></div></div>`,
        `.on{background:#eef2ff}`,
      ),
    ),
    "selected-state",
  );
  expect(findings).toEqual([]);
}, 60_000);

test("selected-state: inferred and explicit segmented groups require a current value", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(`
      <div id="view" role="group"><button aria-pressed="false">List</button><button aria-pressed="false">Grid</button></div>
      <div id="scheme"><button aria-pressed="false">Light</button><button aria-pressed="false">Dark</button></div>
    `),
    ),
    "selected-state",
  );
  expect(
    findings.map(({ rule, selectorHint }) => ({ rule, selectorHint })),
  ).toEqual([
    { rule: "idiom:selected-state-none", selectorHint: "#view" },
    { rule: "idiom:selected-state-none", selectorHint: "#scheme" },
  ]);
}, 60_000);

test("selected-state: native radio names sharing a parent remain separate groups", async () => {
  const { findings, tuples } = await reviewStates(browser, [
    {
      state: "settings",
      html: page(`
    <form><label><input type="radio" name="size" checked>Small</label><label><input type="radio" name="size">Large</label>
    <label><input type="radio" name="colour" checked>Blue</label><label><input type="radio" name="colour">Red</label></form>
  `),
    },
  ]);
  const observations = tuples[0]?.observations;
  expect(
    observations?.version === 2 && observations.selectionGroups?.length,
  ).toBe(2);
  expect(of(findings, "selected-state")).toEqual([]);
}, 60_000);

test("dialog-shell: a visually hidden close button does not satisfy the visible close rule", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(
        `<div role="dialog" aria-modal="true" style="width:480px;height:240px"><h2>Settings</h2><button class="sr-only">Close</button></div>`,
        `.sr-only{position:absolute;width:1px;height:1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%)}`,
      ),
    ),
    "dialog-shell",
  );
  expect(findings.map((finding) => finding.rule)).toEqual([
    "idiom:dialog-close-missing",
  ]);
}, 60_000);

test("selected-state: native radio forms and unnamed independent radios do not merge", async () => {
  const { findings, tuples } = await reviewStates(browser, [
    {
      state: "settings",
      html: page(`
    <form><label><input type="radio" name="plan" checked>Free</label><label><input type="radio" name="plan">Pro</label></form>
    <form><label><input type="radio" name="plan" checked>Free</label><label><input type="radio" name="plan">Pro</label></form>
    <div><input type="radio" checked><input type="radio" checked></div>
  `),
    },
  ]);
  const observations = tuples[0]?.observations;
  expect(
    observations?.version === 2 && observations.selectionGroups?.length,
  ).toBe(2);
  expect(of(findings, "selected-state")).toEqual([]);
}, 60_000);

const tabs = `<div role="tablist"><button role="tab" aria-selected="true">One<span>Label</span></button><button role="tab" aria-selected="false">Two<span>Label</span></button><button role="tab" aria-selected="false">Three<span>Label</span></button></div>`;

test.each([
  ["self bottom", "button", 'button[aria-selected="true"]', "bottom", 2],
  ["self right", "button", 'button[aria-selected="true"]', "right", 2],
  ["thinner bottom", "button", 'button[aria-selected="true"]', "bottom", 1],
  [
    "pseudo bottom",
    "button::after",
    'button[aria-selected="true"]::after',
    "bottom",
    2,
  ],
  [
    "descendant right",
    "button span",
    'button[aria-selected="true"] span',
    "right",
    2,
  ],
])(
  "selected-state: preserves the %s border selection cue",
  async (_name, target, selected, side, width) => {
    const findings = of(
      await reviewFixture(
        browser,
        page(
          tabs,
          `${target}{content:"";display:inline-block;width:80px;height:24px;border:2px solid #aaa;border-${side}-width:${width}px}${selected}{border-${side}-color:blue}`,
        ),
      ),
      "selected-state",
    );
    expect(findings).toEqual([]);
  },
  60_000,
);

test.each(["display:none", "visibility:hidden", "opacity:0"])(
  "selected-state: an unrendered pseudo indicator (%s) is ignored, then clears when painted",
  async (hidden) => {
    const style = `button::after{content:"";display:block;width:24px;height:4px}button[aria-selected="true"]::after{background:blue}`;
    const before = of(
      await reviewFixture(
        browser,
        page(tabs, `${style}button::after{${hidden}}`),
      ),
      "selected-state",
    );
    expect(before.map(({ rule }) => rule)).toEqual([
      "idiom:selected-state-invisible",
    ]);
    const after = of(
      await reviewFixture(browser, page(tabs, style)),
      "selected-state",
    );
    expect(after).toEqual([]);
  },
  60_000,
);

test.each(["group", "toolbar", "grid"])(
  "selected-state: native form/name identities survive a generic role=%s wrapper",
  async (role) => {
    const html = (empty: boolean) =>
      page(`<div role="${role}">
    <form><label><input type="radio" name="size" checked>Small</label><label><input type="radio" name="size">Large</label>
    <label><input type="radio" name="colour" ${empty ? "" : "checked"}>Blue</label><label><input type="radio" name="colour">Red</label></form>
    <form><label><input type="radio" name="size" checked>Small</label><label><input type="radio" name="size">Large</label></form>
    <input type="radio" checked><input type="radio" checked>
  </div>`);
    const { findings, tuples } = await reviewStates(browser, [
      { state: "settings", html: html(false) },
    ]);
    const observation = tuples[0]?.observations;
    expect(
      observation?.version === 2 &&
        observation.selectionGroups?.map(({ members }) => members.length),
    ).toEqual([2, 2, 2]);
    expect(of(findings, "selected-state")).toEqual([]);
    const missing = of(
      await reviewFixture(browser, html(true)),
      "selected-state",
    );
    expect(missing.map(({ rule }) => rule)).toEqual([
      "idiom:selected-state-none",
    ]);
    expect(missing[0]?.explanation).toContain('"Blue"');
  },
  60_000,
);

test.each(["dialog", "ancestor", "viewport"])(
  "dialog-shell: a close button clipped by the %s is reported, then clears",
  async (clipping) => {
    const html = (fixed: boolean) =>
      page(
        `<div role="dialog" aria-modal="true" class="dlg"><h2>Settings</h2>${fixed ? "<button>Close</button>" : ""}<div class="scroller"><div style="height:${clipping === "viewport" ? 800 : 300}px"></div>${fixed ? "" : "<button>Close</button>"}</div></div>`,
        `.dlg{position:absolute;top:80px;left:80px;width:480px;height:${clipping === "viewport" ? 1200 : clipping === "ancestor" ? 500 : 240}px;overflow:${clipping === "dialog" ? "auto" : "visible"}}.scroller{${clipping === "ancestor" ? "height:120px;overflow:auto" : ""}}`,
      );
    const before = of(
      await reviewFixture(browser, html(false), {
        viewport: { width: 1000, height: 600 },
      }),
      "dialog-shell",
    );
    expect(before.map(({ rule }) => rule)).toEqual([
      "idiom:dialog-close-missing",
    ]);
    const after = of(
      await reviewFixture(browser, html(true), {
        viewport: { width: 1000, height: 600 },
      }),
      "dialog-shell",
    );
    expect(after).toEqual([]);
  },
  60_000,
);

test.each([
  ["empty inline", 'content:"";background:blue'],
  [
    "zero height",
    'content:"";display:block;width:24px;height:0;background:blue',
  ],
  ["zero width", 'content:"";display:block;width:0;height:4px;background:blue'],
  ["unpainted box", 'content:"";display:block;width:24px;height:4px'],
])(
  "selected-state: an %s pseudo-element is not selection evidence",
  async (_name, indicator) => {
    const html = (style: string) =>
      page(tabs, `button[aria-selected="true"]::after{${style}}`);
    const before = of(
      await reviewFixture(browser, html(indicator)),
      "selected-state",
    );
    expect(before.map(({ rule }) => rule)).toEqual([
      "idiom:selected-state-invisible",
    ]);
    const after = of(
      await reviewFixture(
        browser,
        html('content:"";display:block;width:24px;height:4px;background:blue'),
      ),
      "selected-state",
    );
    expect(after).toEqual([]);
  },
  60_000,
);

test.each([
  ["text", 'content:"✓";color:blue'],
  ["border", 'content:"";display:block;width:0;height:0;border:4px solid blue'],
  [
    "outline",
    'content:"";display:block;width:24px;height:4px;outline:2px solid blue',
  ],
  [
    "shadow",
    'content:"";display:block;width:24px;height:4px;box-shadow:0 0 0 2px blue',
  ],
])(
  "selected-state: a painted pseudo %s still indicates selection",
  async (_name, indicator) => {
    const findings = of(
      await reviewFixture(
        browser,
        page(tabs, `button[aria-selected="true"]::after{${indicator}}`),
      ),
      "selected-state",
    );
    expect(findings).toEqual([]);
  },
  60_000,
);

test("dialog-shell: an external close button is visible when panel overflow is visible", async () => {
  const html = (overflow: string) =>
    page(
      `<div role="dialog" aria-modal="true" class="dlg"><h2>Settings</h2><button>Close</button></div>`,
      `.dlg{position:relative;width:400px;height:200px;margin:80px;overflow:${overflow}}.dlg button{position:absolute;right:-24px;top:-24px}`,
    );
  const visible = of(
    await reviewFixture(browser, html("visible")),
    "dialog-shell",
  );
  expect(visible).toEqual([]);
  const clipped = of(
    await reviewFixture(browser, html("hidden")),
    "dialog-shell",
  );
  expect(clipped.map(({ rule }) => rule)).toEqual([
    "idiom:dialog-close-missing",
  ]);
}, 60_000);

test("dialog-shell: a clipping ancestor outside the panel still hides an external close button", async () => {
  const findings = of(
    await reviewFixture(
      browser,
      page(
        `<div class="frame"><div role="dialog" aria-modal="true" class="dlg"><h2>Settings</h2><button>Close</button></div></div>`,
        `.frame{margin:80px;width:400px;height:240px;overflow:hidden}.dlg{position:relative;display:flow-root;width:400px;height:200px;overflow:visible}.dlg button{position:absolute;right:0;top:-24px}`,
      ),
    ),
    "dialog-shell",
  );
  expect(findings.map(({ rule }) => rule)).toEqual([
    "idiom:dialog-close-missing",
  ]);
}, 60_000);

test.each(["before", "after"])(
  "selected-state: painted descendant ::%s indicators clear the finding while unpainted variants do not",
  async (pseudo) => {
    const html = (indicator: string) =>
      page(
        tabs,
        `button[aria-selected="true"] span::${pseudo}{content:"";display:block;width:24px;height:4px;${indicator}}`,
      );
    for (const indicator of [
      "background:transparent",
      "background:blue;height:0",
      "background:blue;display:none",
    ]) {
      const findings = of(
        await reviewFixture(browser, html(indicator)),
        "selected-state",
      );
      expect(findings.map(({ rule }) => rule)).toEqual([
        "idiom:selected-state-invisible",
      ]);
    }
    expect(
      of(
        await reviewFixture(browser, html("background:blue")),
        "selected-state",
      ),
    ).toEqual([]);
  },
  60_000,
);

test.each(["button", "wrapper"])(
  "dialog-shell: a viewport-fixed %s escapes overflow ancestors",
  async (fixed) => {
    const html = page(
      `<div role="dialog" aria-modal="true" class="dlg"><h2>Settings</h2><div class="clip"><div class="fixed"><button>Close</button></div></div></div>`,
      `.dlg{position:absolute;left:80px;top:80px;width:400px;height:240px;overflow:auto}.clip{height:100px;overflow:hidden}${fixed === "button" ? "button" : ".fixed"}{position:fixed;left:450px;top:16px}`,
    );
    const findings = of(
      await reviewFixture(browser, html, {
        viewport: { width: 600, height: 240 },
      }),
      "dialog-shell",
    );
    expect(findings).toEqual([]);
  },
  60_000,
);

test.each([
  "transform:translateZ(0)",
  "translate:0px",
  "filter:opacity(1)",
  "perspective:1000px",
  "contain:layout",
  "will-change:transform",
])(
  "dialog-shell: fixed close controls still clip inside a containing block (%s)",
  async (containingBlock) => {
    const html = page(
      `<div role="dialog" aria-modal="true" class="dlg"><h2>Settings</h2><div class="clip"><button>Close</button></div></div>`,
      `.dlg{position:absolute;left:80px;top:80px;width:400px;height:240px;overflow:auto}.clip{height:100px;overflow:hidden;${containingBlock}}button{position:fixed;left:450px;top:16px}`,
    );
    const findings = of(
      await reviewFixture(browser, html, {
        viewport: { width: 600, height: 240 },
      }),
      "dialog-shell",
    );
    expect(findings.map(({ rule }) => rule)).toEqual([
      "idiom:dialog-close-missing",
    ]);
  },
  60_000,
);

test("dialog-shell: viewport intersections use the strict optional signal schema and missing evidence requires recapture", async () => {
  const { tuples } = await reviewStates(browser, [
    { state: "settings", html: titled("Settings", 18) },
  ]);
  const tuple = tuples[0];
  if (tuple === undefined || tuple.observations?.version !== 2)
    throw new Error("Missing observed tuple");
  const observation = tuple.observations;
  const control = observation.elements.find(
    ({ signals }) =>
      signals?.name === "Close" && signals.viewportIntersection !== undefined,
  );
  expect(control?.signals?.viewportIntersection?.width).toBeGreaterThan(0);
  expect(observationArtifactSchema.safeParse(observation).success).toBe(true);
  const invalid = structuredClone(observation);
  const invalidControl = invalid.elements.find(
    ({ signals }) => signals?.viewportIntersection !== undefined,
  );
  Object.assign(invalidControl?.signals?.viewportIntersection ?? {}, {
    unknown: true,
  });
  expect(observationArtifactSchema.safeParse(invalid).success).toBe(false);
  for (const element of observation.elements) {
    if (element.signals !== undefined)
      delete element.signals.viewportIntersection;
  }
  expect(observationArtifactSchema.safeParse(observation).success).toBe(true);
  expect(
    dialogShellCheck.run({
      tuple,
      narrowViewport: false,
      config: checksConfigFrom(),
    }),
  ).toEqual({
    coverage: {
      check: "dialog-shell",
      status: "unavailable",
      reason:
        "dialog-control viewport intersections are unavailable (recapture)",
    },
    candidates: [],
  });
}, 60_000);

const childIndicator = (child: string, style = "") =>
  page(
    `<div role="tablist"><button role="tab" aria-selected="true">One${child}</button><button role="tab" aria-selected="false">Two</button><button role="tab" aria-selected="false">Three</button></div>`,
    `button{position:relative;width:100px;height:40px}.indicator{position:absolute;bottom:0;left:0;width:24px;height:4px}${style}`,
  );

test("selected-state: an empty transparent child is reported, then clears when painted", async () => {
  const before = of(
    await reviewFixture(
      browser,
      childIndicator('<span class="indicator"></span>'),
    ),
    "selected-state",
  );
  expect(before.map(({ rule }) => rule)).toEqual([
    "idiom:selected-state-invisible",
  ]);
  const after = of(
    await reviewFixture(
      browser,
      childIndicator(
        '<span class="indicator"></span>',
        ".indicator{background:blue}",
      ),
    ),
    "selected-state",
  );
  expect(after).toEqual([]);
}, 60_000);

test("selected-state: extra unpainted descendants neither consume evidence slots nor indicate selection", async () => {
  const empty = '<span class="indicator"></span>'.repeat(8);
  const invisible = of(
    await reviewFixture(browser, childIndicator(empty)),
    "selected-state",
  );
  expect(invisible.map(({ rule }) => rule)).toEqual([
    "idiom:selected-state-invisible",
  ]);
  const painted = of(
    await reviewFixture(
      browser,
      childIndicator(
        `${empty}<span class="indicator" style="background:blue"></span>`,
      ),
    ),
    "selected-state",
  );
  expect(painted).toEqual([]);
}, 60_000);

test.each([
  ["text", '<span style="position:absolute;right:0;top:0">✓</span>'],
  [
    "SVG",
    '<svg class="indicator" viewBox="0 0 24 4"><path d="M0 0H24V4H0Z" fill="blue"/></svg>',
  ],
  ["pseudo", '<span class="indicator"></span>'],
  [
    "image",
    `<img class="indicator" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="4"><rect width="24" height="4" fill="blue"/></svg>')}">`,
  ],
])(
  "selected-state: a real child %s cue still indicates selection",
  async (kind, child) => {
    const findings = of(
      await reviewFixture(
        browser,
        childIndicator(
          child,
          kind === "pseudo"
            ? '.indicator::after{content:"";display:block;width:24px;height:4px;background:blue}'
            : "",
        ),
      ),
      "selected-state",
    );
    expect(findings).toEqual([]);
  },
  60_000,
);

test.each(["fill", "stroke"])(
  "selected-state: existing SVG %s indicators compare actual paint with the configured threshold",
  async (paint) => {
    const html = (selected: string) =>
      page(
        `<div role="tablist">${["One", "Two", "Three"].map((label, index) => `<button role="tab" aria-selected="${index === 0}">${label}<svg width="24" height="24"><circle cx="12" cy="12" r="8"/></svg></button>`).join("")}</div>`,
        `circle{fill:${paint === "fill" ? "rgb(128,128,128)" : "none"};stroke:${paint === "stroke" ? "rgb(128,128,128)" : "none"};stroke-width:2px}button[aria-selected=true] circle{${paint}:${selected}}`,
      );
    const before = of(
      await reviewFixture(browser, html("rgb(128,128,128)")),
      "selected-state",
    );
    expect(before.map(({ rule }) => rule)).toEqual([
      "idiom:selected-state-invisible",
    ]);
    const after = of(
      await reviewFixture(browser, html("blue")),
      "selected-state",
    );
    expect(after).toEqual([]);
    const subtle = of(
      await reviewFixture(browser, html("rgb(140,140,140)")),
      "selected-state",
    );
    expect(subtle.map(({ rule }) => rule)).toEqual([
      "idiom:selected-state-invisible",
    ]);
    const configured = of(
      await reviewFixture(browser, html("rgb(140,140,140)"), {
        checks: { selectedState: { minColorDelta: 8 } },
      }),
      "selected-state",
    );
    expect(configured).toEqual([]);
  },
  60_000,
);

test.each(["grid", "listbox", "tablist"])(
  "selected-state: %s selection mode follows aria-multiselectable",
  async (role) => {
    const html = (mode: string | undefined) => {
      const memberRole =
        role === "grid" ? "gridcell" : role === "listbox" ? "option" : "tab";
      const members = ["One", "Two", "Three"]
        .map(
          (label, index) =>
            `<button id="mode-${index}" role="${memberRole}" aria-selected="${index < 2}"${role === "tablist" ? ` aria-controls="panel-${index}"` : ""}>${label}</button>`,
        )
        .join("");
      const panels =
        role === "tablist"
          ? [0, 1, 2]
              .map(
                (index) =>
                  `<div id="panel-${index}" role="tabpanel" aria-labelledby="mode-${index}"${index === 2 ? " hidden" : ""}>Panel ${index}</div>`,
              )
              .join("")
          : "";
      return page(
        `<div role="${role}"${mode === undefined ? "" : ` aria-multiselectable="${mode}"`}>${role === "grid" ? `<div role="row">${members}</div>` : members}</div>${panels}`,
        "[aria-selected=true]{background:#1d2330;color:white}",
      );
    };
    for (const mode of [undefined, "false", "true"]) {
      const { findings, tuples } = await reviewStates(browser, [
        { state: "selection-mode", html: html(mode) },
      ]);
      const observation = tuples[0]?.observations;
      expect(
        observation?.version === 2 && observation.selectionGroups?.[0]?.single,
      ).toBe(mode !== "true");
      expect(of(findings, "selected-state").map(({ rule }) => rule)).toEqual(
        mode === "true" ? [] : ["idiom:selected-state-multiple"],
      );
    }
  },
  60_000,
);

test("selected-state: radio exclusivity survives unsupported aria-multiselectable declarations", async () => {
  const { findings, tuples } = await reviewStates(browser, [
    {
      state: "radio-mode",
      html: page(
        `<div role="radiogroup" aria-multiselectable="true"><button role="radio" aria-checked="true">One</button><button role="radio" aria-checked="true">Two</button><button role="radio" aria-checked="false">Three</button></div><div role="grid" aria-multiselectable="true"><form><label><input type="radio" name="native" checked>One</label><label><input type="radio" name="native">Two</label></form></div>`,
        "[aria-checked=true]{background:#1d2330;color:white}",
      ),
    },
  ]);
  const observation = tuples[0]?.observations;
  expect(
    observation?.version === 2 &&
      observation.selectionGroups?.map(({ single }) => single),
  ).toEqual([true, true]);
  expect(of(findings, "selected-state").map(({ rule }) => rule)).toEqual([
    "idiom:selected-state-multiple",
  ]);
}, 60_000);
