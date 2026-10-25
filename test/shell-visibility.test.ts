import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observePage } from "../src/checks/observe.js";
import { webStepSchema } from "../src/schemas/flow.js";
import { reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});
const html = (name: string) =>
  readFile(
    new URL(`./fixtures/shell-visibility/${name}.html`, import.meta.url),
    "utf8",
  );

test("real hidden context span causes 900 to 1695 shell overflow and peer overlays collide", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  try {
    await page.setContent(await html("before"));
    expect(
      await page
        .locator(".ed-shell")
        .evaluate((el) => [el.clientHeight, el.scrollHeight]),
    ).toEqual([900, 1695]);
    // Ordinary locator visibility and rendered observations do not assert viewport visibility.
    await page
      .locator("#selected-footer")
      .waitFor({ state: "visible", timeout: 1000 });
    const observations = await observePage(page, { status: "not-configured" });
    expect(
      observations.elements.find((el) => el.selector === "#selected-footer")
        ?.visible,
    ).toBe(true);
    expect(
      observations.elements.some((el) =>
        el.selector.includes("sg-readability"),
      ),
    ).toBe(false);
    const findings = await reviewFixture(browser, await html("before"), {
      shell: ".ed-shell",
      checks: {
        shellVisibility: {
          floatingOverlays: ["#selection-toolbar", "#selection-breadcrumb"],
        },
      },
    });
    expect(
      findings
        .filter((f) => f.candidate.category === "shell-visibility")
        .map((f) => f.candidate.explanation)
        .join(" "),
    ).toContain("sg-readability__context");
    expect(
      findings.filter((f) => f.candidate.category === "shell-visibility"),
    ).toHaveLength(2);
  } finally {
    await page.close();
  }
});

test("fixed shell bounds nested scrolling content and separates overlays", async () => {
  const findings = await reviewFixture(browser, await html("after"), {
    shell: ".ed-shell",
    checks: {
      shellVisibility: {
        floatingOverlays: ["#selection-toolbar", "#selection-breadcrumb"],
      },
    },
  });
  expect(
    findings.filter((f) => f.candidate.category === "shell-visibility"),
  ).toEqual([]);
});

test("visibility assertion accepts the keyed declaration", () => {
  expect(
    webStepSchema.parse({
      expectVisible: { selector: "#selected-footer", within: ".canvas" },
    }),
  ).toEqual({
    action: "expectVisible",
    selector: "#selected-footer",
    within: ".canvas",
  });
});

test("geometry distinguishes offscreen targets, clipping, fixed escape and transformed containment", async () => {
  const { ensureVisibilityDom, targetVisibility } = await import(
    "../src/checks/visibility-dom.js"
  );
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent(
      `<style>body{margin:0} #scroll{height:100px;width:300px;overflow:auto;border:10px solid;position:relative} #spacer{height:300px} #target{height:40px} #fixed{position:fixed;top:150px;width:40px;height:40px} #absolute{position:absolute;top:180px;width:40px;height:40px}</style><div id="scroll"><div id="spacer"></div><div id="target">Target</div><div id="fixed">Fixed</div><div id="absolute">Absolute</div></div>`,
    );
    await ensureVisibilityDom(page);
    expect(await targetVisibility(page, "#target")).toMatchObject({
      visible: false,
      boundary: "#scroll",
    });
    expect(await targetVisibility(page, "#fixed")).toMatchObject({
      visible: true,
    });
    expect(await targetVisibility(page, "#fixed", "#scroll")).toMatchObject({
      visible: false,
    });
    expect(await targetVisibility(page, "#absolute")).toMatchObject({
      visible: false,
    });
    await page.locator("#scroll").evaluate((el) => {
      (el as HTMLElement).style.transform = "translateZ(0)";
    });
    expect(await targetVisibility(page, "#fixed")).toMatchObject({
      visible: false,
      boundary: "#scroll",
    });
    await page.locator("#scroll").evaluate((el) => {
      el.scrollTop = 270;
    });
    expect(await targetVisibility(page, "#target", "#scroll")).toMatchObject({
      visible: true,
    });
    expect(await targetVisibility(page, "#target", "body > p")).toMatchObject({
      visible: false,
      reason: "boundary matches 0 elements",
    });
    expect(await targetVisibility(page, "[")).toMatchObject({
      visible: false,
      reason: expect.stringContaining("invalid selector"),
    });
    expect(await targetVisibility(page, "div")).toMatchObject({
      visible: false,
      reason: expect.stringContaining("matches"),
    });
    expect(await targetVisibility(page, "#absent")).toMatchObject({
      visible: false,
    });
  } finally {
    await page.close();
  }
});

test("absolute descendants escape ordinary overflow until their containing block", async () => {
  const { ensureVisibilityDom, targetVisibility } = await import(
    "../src/checks/visibility-dom.js"
  );
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent(
      `<div style="position:relative"><div style="overflow:hidden;height:40px"><div id="target" style="position:absolute;top:100px;height:20px;width:20px">Target</div></div></div>`,
    );
    await ensureVisibilityDom(page);
    expect(await targetVisibility(page, "#target")).toMatchObject({
      visible: true,
    });
  } finally {
    await page.close();
  }
});

test("CSS-hidden and sr-only paint never satisfy visibility", async () => {
  const { ensureVisibilityDom, targetVisibility } = await import(
    "../src/checks/visibility-dom.js"
  );
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<div id="opacity" style="opacity:0"><span id="child">Hidden</span></div><div id="display" style="display:none">Hidden</div><div id="visibility" style="visibility:hidden">Hidden</div><span id="clip" style="position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)">Hidden</span><span id="inset" style="position:absolute;width:1px;height:1px;clip-path:inset(50%)">Hidden</span><div id="zero" style="width:0;height:0"></div><div id="external">External</div>`,
    );
    await ensureVisibilityDom(page);
    for (const selector of [
      "#child",
      "#display",
      "#visibility",
      "#clip",
      "#inset",
      "#zero",
    ])
      expect(await targetVisibility(page, selector)).toMatchObject({
        visible: false,
      });
    expect(await targetVisibility(page, "#external", "#opacity")).toMatchObject(
      {
        visible: false,
        reason: expect.stringContaining("outside declared boundary"),
      },
    );
  } finally {
    await page.close();
  }
});

test("auto-growing shell is flagged with equal heights and normal nested scrollers are bounded", async () => {
  const before = await reviewFixture(
    browser,
    `<style>body{margin:0} .shell{position:relative} .content{height:1500px}</style><div class="shell"><div class="content">Content</div></div>`,
    { shell: ".shell" },
  );
  expect(
    before.filter((f) => f.candidate.category === "shell-visibility")[0]
      ?.candidate.explanation,
  ).toContain("extends past viewport");
  const after = await reviewFixture(
    browser,
    (await html("before")).replace(
      /<span class="sg-readability__context">.*?<\/span>/,
      "",
    ),
    { shell: ".ed-shell" },
  );
  expect(
    after.filter((f) => f.candidate.category === "shell-visibility"),
  ).toEqual([]);
});

test("overlay measurement clips peers and excludes hidden, identical and nested roots", async () => {
  const findings = await reviewFixture(
    browser,
    `<style>body{margin:0}.clip{height:40px;overflow:hidden;position:relative}.overlay{position:absolute;width:100px;height:40px;top:50px}#a{position:fixed;top:10px;left:10px;width:80px;height:40px;pointer-events:none}#b{position:fixed;top:10px;left:30px;width:80px;height:40px;pointer-events:none}</style><div class="clip"><div class="overlay">Clipped</div></div><div id="a"><div id="child">Child</div></div><div id="b">Peer</div><div id="hidden" style="display:none">Hidden</div>`,
    {
      checks: {
        shellVisibility: {
          floatingOverlays: [
            "#a",
            "div#a",
            "#child",
            "#b",
            "#hidden",
            ".overlay",
          ],
        },
      },
    },
  );
  const collisions = findings.filter(
    (f) => f.candidate.category === "shell-visibility",
  );
  expect(
    collisions.filter((f) => f.candidate.explanation.includes("#a and #b")),
  ).toHaveLength(1);
  expect(
    collisions.every(
      (f) =>
        !f.candidate.explanation.includes("#hidden") &&
        !f.candidate.explanation.includes(".overlay"),
    ),
  ).toBe(true);
});

test("scrolled shell still attributes excess to the hidden layout span", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  try {
    await page.setContent(await html("before"));
    await page.locator(".ed-shell").evaluate((el) => {
      el.scrollTop = 795;
    });
    const observations = await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      { shell: ".ed-shell" },
    );
    if (
      observations.version !== 2 ||
      observations.shellVisibility?.shell.status !== "measured"
    )
      throw Error("fixture");
    expect(
      observations.shellVisibility.shell.extending
        .map((el) => el.description)
        .join(" "),
    ).toContain("sg-readability__context");
    expect(
      observations.shellVisibility.shell.extending.every(
        (el) =>
          !el.selector.includes("brand-content") &&
          el.selector !== "#selected-footer",
      ),
    ).toBe(true);
  } finally {
    await page.close();
  }
});

test("raw shell evidence handles missing, ambiguous and invalid CSS declarations", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<div></div><div></div>");
    for (const [shell, status] of [
      ["#absent", "missing"],
      ["div", "ambiguous"],
      ["[", "invalid"],
    ]) {
      const evidence = await observePage(
        page,
        { status: "not-configured" },
        undefined,
        [],
        { shell },
      );
      expect(
        evidence.version === 2 && evidence.shellVisibility?.shell.status,
      ).toBe(status);
    }
  } finally {
    await page.close();
  }
});

test("paint containment and overflow bound descendant scroll attribution while transparent absolute boxes remain evidence", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent(
      `<style>body{margin:0}.shell{height:600px;overflow:auto;position:relative}.panel{height:100px;contain:paint}.deep{height:2000px}#transparent{position:absolute;top:699px;width:1px;height:1px;opacity:0;overflow:hidden}</style><div class="shell"><div class="panel"><div class="deep">Deep</div></div><span id="transparent">Hidden</span></div>`,
    );
    const observations = await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      { shell: ".shell" },
    );
    if (
      observations.version !== 2 ||
      observations.shellVisibility?.shell.status !== "measured"
    )
      throw Error("fixture");
    expect(observations.shellVisibility.shell.scrollHeight).toBe(700);
    expect(
      observations.shellVisibility.shell.extending.map((el) => el.selector),
    ).toEqual(["#transparent"]);
  } finally {
    await page.close();
  }
});

test("visibility measurement reinstalls its helper after document navigation", async () => {
  const { ensureVisibilityDom, targetVisibility } = await import(
    "../src/checks/visibility-dom.js"
  );
  const page = await browser.newPage();
  try {
    await page.setContent("<p>Outgoing document</p>");
    await ensureVisibilityDom(page);
    await page.goto(
      "data:text/html,<main id='boundary'><div id='target'>Visible target</div></main>",
    );
    expect(await targetVisibility(page, "#target", "#boundary")).toMatchObject({
      visible: true,
    });
  } finally {
    await page.close();
  }
});

test("visibility geometry errors are not labelled invalid selectors", async () => {
  const { ensureVisibilityDom, targetVisibility } = await import(
    "../src/checks/visibility-dom.js"
  );
  const page = await browser.newPage();
  try {
    await page.setContent("<div id='target'>Visible target</div>");
    await ensureVisibilityDom(page);
    await page.evaluate(() => {
      Element.prototype.getBoundingClientRect = () => {
        throw new TypeError("geometry measurement failed");
      };
    });
    await expect(targetVisibility(page, "#target")).rejects.toThrow(
      "geometry measurement failed",
    );
  } finally {
    await page.close();
  }
});
