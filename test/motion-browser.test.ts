import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MotionCollector } from "../src/capture/motion.js";
import { probeControls } from "../src/capture/probe.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { motionCheck } from "../src/checks/motion.js";
import { observePage } from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { tupleFor } from "./motion-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function action(
  css: string,
  handler: string,
  options: {
    wait?: number;
    reduced?: boolean;
    extra?: string;
    selectors?: string[];
    body?: string;
  } = {},
) {
  const page = await browser.newPage({
    reducedMotion: options.reduced ? "reduce" : "no-preference",
  });
  try {
    await page.setContent(
      `<style>aside{height:180px;width:240px;overflow:hidden;} ${css}</style>${options.body ?? '<button id="toggle" aria-controls="layers">Toggle</button><aside id="layers" aria-label="Layers panel"><div id="child">Content</div></aside>'}${options.extra ?? ""}<script>toggle.onclick=()=>{${handler}}</script>`,
    );
    const observations = await observePage(page, { status: "not-configured" });
    const collector = new MotionCollector(page, options.selectors);
    const window = await collector.start({
      source: "web-step",
      selector: "#toggle",
      name: "Toggle Layers",
      stepIndex: 1,
    });
    await page.click("#toggle");
    await page.waitForTimeout(options.wait ?? 180);
    await window.finish();
    const motion = collector.evidence();
    if (observations.version !== 2) throw Error("v2 required");
    const captured = { ...observations, motion };
    expect(
      observationArtifactSchema.parse(JSON.parse(JSON.stringify(captured))),
    ).toEqual(captured);
    const result = motionCheck.run({
      tuple: tupleFor(captured),
      config: checksConfigFrom(),
      narrowViewport: false,
    });
    return { motion, result };
  } finally {
    await page.close();
  }
}
const owner = (result: Awaited<ReturnType<typeof action>>) =>
  result.motion.actions[0]?.changes.find((c) => c.selector === "#layers");

test("short completed transition is actual activity, with seconds normalized by browser timing", async () => {
  const result = await action(
    "aside{transition:height .04s} aside.closed{height:0}",
    "layers.classList.add('closed')",
  );
  expect(owner(result)?.animated).toBe(true);
  expect(owner(result)?.effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        durationMs: 40,
        property: "height",
        started: true,
      }),
    ]),
  );
  expect(result.result.candidates).toEqual([]);
});
test.each(["color 120ms", "all 120ms"])(
  "%s does not conceal display:none snap; closing styles survive",
  async (transition) => {
    const result = await action(
      `aside{transition:${transition}} aside.closed{display:none}`,
      "layers.classList.add('closed')",
    );
    expect(owner(result)).toMatchObject({
      animated: false,
      toggled: true,
      before: { motion: { transitionDuration: "0.12s" } },
      after: { rendered: false },
    });
    expect(result.result.candidates[0]?.rule).toBe(
      "idiom:motion-no-transition",
    );
  },
);
test("removed closing surface retains identity and before styles", async () => {
  const result = await action(
    "aside{transition:opacity 120ms}",
    "layers.remove()",
  );
  expect(owner(result)).toMatchObject({
    before: { transition: expect.stringContaining("opacity") },
    after: null,
    animated: false,
  });
  expect(result.result.candidates[0]?.explanation).toContain(
    "collapse: no transition",
  );
});
test("inserted dialog and same-endpoint keyframe retain running evidence", async () => {
  const result = await action(
    "@keyframes flash{0%,100%{opacity:1}50%{opacity:.2}} dialog{animation:flash 400ms}",
    "const d=document.createElement('dialog');d.id='new';d.setAttribute('aria-label','New dialog');document.body.append(d);d.showModal();",
    { wait: 450 },
  );
  const dialog = result.motion.actions[0]?.changes.find(
    (c) => c.selector === "#new",
  );
  expect(dialog).toMatchObject({
    before: null,
    animated: true,
    effects: [{ durationMs: 400, started: true }],
  });
  expect(
    result.result.candidates.some((c) => c.rule === "idiom:motion-duration"),
  ).toBe(true);
});
test("multi-duration lists retain each actual effect and exclude delays", async () => {
  const result = await action(
    "aside{transition:opacity .4s 10ms,height .12s} aside.closed{opacity:.2;height:20px}",
    "layers.classList.add('closed')",
  );
  expect(owner(result)?.effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        property: "height",
        durationMs: 120,
        delayMs: 0,
      }),
      expect.objectContaining({
        property: "opacity",
        durationMs: 400,
        delayMs: 10,
      }),
    ]),
  );
  expect(result.result.candidates).toHaveLength(1);
});
test("effect canceled entirely during delay is not running reduced motion", async () => {
  const result = await action(
    "aside{transition:opacity .4s 1s} aside.closed{opacity:.2}",
    "layers.classList.add('closed');setTimeout(()=>layers.style.transition='none',30)",
    { reduced: true },
  );
  expect(owner(result)?.effects.every((e) => !e.started)).toBe(true);
  expect(result.result.candidates).toEqual([]);
});
test("ambient spinner and neighboring reflow cannot prove panel animation or a neighbor toggle", async () => {
  const result = await action(
    "@keyframes spin{to{transform:rotate(360deg)}} #child{width:12px;height:12px;animation:spin 1s infinite} aside.closed{height:0}",
    "layers.classList.add('closed')",
    { extra: '<aside id="neighbor" aria-label="Neighbor">Neighbor</aside>' },
  );
  expect(owner(result)?.animated).toBe(false);
  expect(result.result.candidates).toHaveLength(1);
  expect(
    result.motion.actions[0]?.changes.find((c) => c.selector === "#neighbor")
      ?.toggled,
  ).toBe(false);
});
test("WAAPI and progressive JS motion avoid a false snap", async () => {
  const waapi = await action(
    "",
    "layers.animate([{height:'180px'},{height:'0px'}],{duration:120,fill:'forwards'})",
  );
  expect(owner(waapi)?.animated).toBe(true);
  expect(owner(waapi)?.effects[0]).toMatchObject({
    kind: "web-animation",
    durationMs: 120,
    started: true,
  });
  const js = await action(
    "",
    "let h=180;const tick=()=>{h-=10;layers.style.height=h+'px';if(h>0)requestAnimationFrame(tick)};requestAnimationFrame(tick)",
    { wait: 350 },
  );
  expect(owner(js)).toMatchObject({
    animated: true,
    reason: expect.stringContaining("duration unavailable"),
  });
  expect(js.result.candidates).toEqual([]);
});
test("120ms still running under reduce is major", async () => {
  const result = await action(
    "aside{transition:height 120ms} aside.closed{height:0}",
    "layers.classList.add('closed')",
    { reduced: true },
  );
  expect(result.motion.reducedMotion).toBe(true);
  expect(result.result.candidates).toEqual([
    expect.objectContaining({
      rule: "idiom:motion-reduced",
      severity: "major",
    }),
  ]);
});
test("invalid surface selectors expose partial collection", async () => {
  const result = await action("", "layers.remove()", { selectors: ["["] });
  expect(result.motion).toMatchObject({
    status: "partial",
    reason: expect.stringContaining("invalid motion surface selector"),
  });
  expect(result.result.candidates).toEqual([]);
});
test("probe guards do not measure destructive or skipped controls", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    const html =
      '<button id="delete">Delete</button><button id="skip">Skip</button><button id="safe">Safe</button>';
    await page.setContent(html);
    const probe = await probeControls({
      page,
      restore: async () => {
        await page.setContent(html);
      },
      skip: ["#skip"],
      maxControls: 1,
      waitMs: 0,
    });
    expect(probe.status).toBe("partial");
    expect(probe.motion?.actions).toEqual([]);
    expect(probe.motion?.reducedMotion).toBe(true);
  } finally {
    await page.close();
  }
});

test("configured divs and a containing visual wrapper retain surface/effect attribution", async () => {
  const page = await browser.newPage({ reducedMotion: "no-preference" });
  try {
    await page.setContent(
      `<style>#wrapper{width:240px;transition:opacity 120ms} #custom{height:180px} #wrapper.closed{opacity:0}</style><button id="toggle" aria-controls="custom">Toggle</button><div id="wrapper"><div id="custom" aria-label="Custom panel">Content</div></div>`,
    );
    const collector = new MotionCollector(page, ["#custom"]);
    const window = await collector.start({
      source: "web-step",
      selector: "#toggle",
      name: "Toggle",
    });
    await page.evaluate(() =>
      document.getElementById("wrapper")?.classList.add("closed"),
    );
    await page.waitForTimeout(180);
    await window.finish();
    const changes = collector.evidence().actions[0]?.changes;
    expect(changes?.find((c) => c.selector === "#wrapper")).toMatchObject({
      ownerSelector: "#custom",
      animated: true,
      effects: [{ durationMs: 120, started: true }],
    });
  } finally {
    await page.close();
  }
});

const nested =
  '<aside id="layers" aria-label="Sidebar"><button id="toggle" aria-controls="menu">More</button><div role="menu" id="menu" aria-label="Actions" hidden><div role="menuitem" id="item">Rename</div></div></aside>';
const menu = (result: Awaited<ReturnType<typeof action>>) =>
  result.motion.actions[0]?.changes.find((c) => c.selector === "#menu");
test("a snapping menu nested inside a panel is its own surface", async () => {
  const result = await action(
    "#menu{width:160px;height:80px}",
    "menu.hidden=!menu.hidden",
    { body: nested },
  );
  expect(menu(result)).toMatchObject({
    ownerSelector: "#menu",
    surface: true,
    toggled: true,
    animated: false,
  });
  expect(
    result.result.candidates.some(
      (c) =>
        c.rule === "idiom:motion-no-transition" &&
        c.explanation.includes("Actions"),
    ),
  ).toBe(true);
});
test("a slow fade on a menu nested inside a panel is attributed to the menu", async () => {
  const result = await action(
    "#menu{width:160px;height:80px;opacity:0;transition:opacity 400ms} #menu.open{opacity:1}",
    "menu.classList.toggle('open')",
    {
      body: nested.replace(" hidden>", ">"),
      wait: 450,
    },
  );
  expect(menu(result)).toMatchObject({
    ownerSelector: "#menu",
    surface: true,
    animated: true,
    effects: [{ durationMs: 400, property: "opacity", started: true }],
  });
  expect(
    result.result.candidates.some(
      (c) =>
        c.rule === "idiom:motion-duration" && c.explanation.includes("400ms"),
    ),
  ).toBe(true);
});

test("navigation loses document identity and cannot establish a snap", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<button id="navigate">Next</button><aside id="panel">Panel</aside>',
    );
    const collector = new MotionCollector(page);
    const window = await collector.start({
      source: "web-step",
      selector: "#navigate",
      name: "Next",
    });
    await page.goto("about:blank");
    await window.finish();
    expect(collector.evidence()).toMatchObject({
      status: "unavailable",
      actions: [
        {
          status: "unavailable",
          changes: [],
          reason: expect.stringContaining("navigation"),
        },
      ],
    });
    expect(await page.evaluate(() => "__idiomMotion" in window)).toBe(false);
  } finally {
    await page.close();
  }
});

test("a failed action window preserves positives but suppresses snap evidence", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<button id="toggle">Toggle</button><aside id="panel">Panel</aside>',
    );
    const collector = new MotionCollector(page);
    const window = await collector.start({
      source: "web-step",
      selector: "#toggle",
      name: "Toggle",
    });
    await page.evaluate(() => document.getElementById("panel")?.remove());
    await window.finish("action failed");
    expect(collector.evidence()).toMatchObject({
      status: "partial",
      actions: [
        {
          status: "partial",
          changes: [{ animated: null, reason: "action failed" }],
        },
      ],
    });
    expect(await page.evaluate(() => "__idiomMotion" in window)).toBe(false);
  } finally {
    await page.close();
  }
});

test("backwards-filled WAAPI canceled during delay is not active motion", async () => {
  const result = await action(
    "",
    "const a=layers.animate([{opacity:1},{opacity:0}],{duration:400,delay:1000,fill:'backwards'});setTimeout(()=>a.cancel(),30)",
    { reduced: true },
  );
  expect(result.result.candidates).toEqual([]);
  expect(owner(result)?.effects.every((effect) => !effect.started)).toBe(true);
});

test("progressive JS motion under reduce is reported without inventing a duration", async () => {
  const result = await action(
    "",
    "let h=180;const tick=()=>{h-=10;layers.style.height=h+'px';if(h>0)requestAnimationFrame(tick)};requestAnimationFrame(tick)",
    { wait: 350, reduced: true },
  );
  expect(result.result.candidates).toEqual([
    expect.objectContaining({
      rule: "idiom:motion-reduced",
      severity: "major",
      explanation: expect.stringContaining("duration unavailable"),
    }),
  ]);
});
